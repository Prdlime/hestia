"""
Sensor Harmonization Analytics, Weekly Climatology Baselines, Anomaly Detection (Z > 2),
and 75th-Percentile Critical Fire Season Identification.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from typing import Dict, List, Tuple
import numpy as np

from app.db import db_engine
from app.schemas import (
    CalendarSeasonSummary,
    CalendarSeriesResponse,
    CalendarTimeSeriesPoint,
    SpatialHexRecord,
    SpatialSummaryResponse,
    TimescaleType,
    TrendPoint,
    TrendSeriesResponse,
)

SENSOR_COLUMN_MAP: Dict[str, Tuple[str, str]] = {
    "harmonized": ("harmonized_count", "harmonized_frp"),
    "modis": ("modis_count", "modis_frp"),
    "viirs": ("viirs_count", "viirs_frp"),
}


def _iso_week_to_mmdd(week_num: int, is_end: bool = False) -> str:
    """Convert an ISO week number (1..52) into an 'MM-DD' date string using reference year 2025."""
    clamped = max(1, min(52, int(week_num)))
    # 2025-01-04 is in ISO week 1 of 2025; Monday of week 1 is 2024-12-30
    jan4 = date(2025, 1, 4)
    week1_monday = jan4 - timedelta(days=jan4.isoweekday() - 1)
    target_dt = week1_monday + timedelta(weeks=clamped - 1, days=(6 if is_end else 0))
    # Clamp within calendar year 2025 for clean MM-DD display
    if target_dt.year < 2025:
        target_dt = date(2025, 1, 1)
    elif target_dt.year > 2025:
        target_dt = date(2025, 12, 31)
    return target_dt.strftime("%m-%d")


def _detect_critical_fire_season(weekly_means: Dict[int, float]) -> Tuple[str, str]:
    """
    Identify the Critical Fire Season window (MM-DD to MM-DD) as the primary contiguous
    block of ISO weeks where the historical climatological mean exceeds the 75th percentile.
    """
    values = np.array([weekly_means.get(w, 0.0) for w in range(1, 53)], dtype=np.float64)
    if float(values.max()) <= 0.0:
        return ("06-15", "09-30")

    # Smooth with a 3-week moving average to avoid single-week noise gaps
    padded = np.pad(values, pad_width=1, mode="wrap")
    smoothed = (padded[:-2] + padded[1:-1] + padded[2:]) / 3.0

    threshold = float(np.percentile(smoothed, 75))
    above = smoothed >= threshold

    # Bridge single-week gaps inside an active season
    for i in range(1, 51):
        if not above[i] and above[i - 1] and above[i + 1]:
            above[i] = True

    # Find contiguous segments of True and select the one with the highest cumulative fire activity
    best_segment: Tuple[int, int] = (24, 38)
    best_score = -1.0
    i = 0
    while i < 52:
        if above[i]:
            j = i
            while j + 1 < 52 and above[j + 1]:
                j += 1
            seg_score = float(smoothed[i : j + 1].sum())
            if seg_score > best_score:
                best_score = seg_score
                best_segment = (i + 1, j + 1)  # 1-indexed ISO weeks
            i = j + 1
        else:
            i += 1

    start_mmdd = _iso_week_to_mmdd(best_segment[0], is_end=False)
    end_mmdd = _iso_week_to_mmdd(best_segment[1], is_end=True)
    return (start_mmdd, end_mmdd)


def query_spatial_summary(
    aoi_dict: Dict,
    date_start: str,
    date_end: str,
    sensor_mode: str,
) -> SpatialSummaryResponse:
    """
    Endpoint 1: Aggregate H3 hexagonal grid fire counts and mean FRP within the AOI
    and requested [date_start, date_end] window.
    """
    matching_cells = db_engine.get_matching_h3_cells(aoi_dict)
    if not matching_cells:
        return SpatialSummaryResponse(status="success", data=[])

    count_col, frp_col = SENSOR_COLUMN_MAP.get(
        sensor_mode, SENSOR_COLUMN_MAP["harmonized"]
    )

    cur = db_engine.cursor()
    sql = f"""
        SELECT
            h3_index,
            CAST(SUM({count_col}) AS INTEGER) AS total_fires,
            ROUND(
                SUM({frp_col} * {count_col}) / NULLIF(SUM({count_col}), 0),
                2
            ) AS mean_frp
        FROM harmonized_fires
        WHERE h3_index IN (SELECT UNNEST(?::VARCHAR[]))
          AND acq_date BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)
          AND {count_col} > 0
        GROUP BY h3_index
        ORDER BY total_fires DESC
    """
    rows = cur.execute(sql, [matching_cells, date_start, date_end]).fetchall()

    records = [
        SpatialHexRecord(
            h3_index=str(r[0]),
            total_fires=int(r[1]),
            mean_frp=round(float(r[2] or 0.0), 2),
        )
        for r in rows
    ]
    return SpatialSummaryResponse(status="success", data=records)


def _get_dataset_date_bounds() -> Tuple[date, date]:
    """Return actual min/max observation dates from metadata with safe fallbacks."""
    meta = db_engine.metadata or {}
    try:
        dt_min = datetime.strptime(str(meta.get("date_min", "2005-01-01")), "%Y-%m-%d").date()
    except ValueError:
        dt_min = date(2005, 1, 1)
    try:
        dt_max = datetime.strptime(str(meta.get("date_max", "2026-11-10")), "%Y-%m-%d").date()
    except ValueError:
        dt_max = date(2026, 11, 10)
    if dt_min > dt_max:
        dt_min, dt_max = dt_max, dt_min
    return (dt_min, dt_max)


def _get_dataset_year_bounds(sensor_mode: str) -> Tuple[int, int]:
    """Determine effective baseline start/end years based on dataset range and sensor launch."""
    dt_min, dt_max = _get_dataset_date_bounds()
    min_yr = dt_min.year
    max_yr = dt_max.year
    if sensor_mode == "viirs":
        min_yr = max(min_yr, 2012)
    max_yr = max(min_yr, max_yr)
    return (min_yr, max_yr)


def _parse_date_range(date_start: str, date_end: str) -> Tuple[date, date]:
    """Parse YYYY-MM-DD bounds, falling back to dataset bounds and ensuring start <= end."""
    fallback_min, fallback_max = _get_dataset_date_bounds()
    try:
        dt_start = datetime.strptime(date_start, "%Y-%m-%d").date()
        dt_end = datetime.strptime(date_end, "%Y-%m-%d").date()
    except ValueError:
        return (fallback_min, fallback_max)
    if dt_start > dt_end:
        dt_start, dt_end = dt_end, dt_start
    return (dt_start, dt_end)


def _trimmed_mean_and_std(values: np.ndarray, floor_ratio: float = 0.18) -> Tuple[float, float]:
    """Compute outlier-trimmed mean and clamped standard deviation for Z-score baselines."""
    if values.size == 0:
        return (0.0, 1.5)
    if values.size >= 8:
        normal_vals = np.sort(values)[:-2]
    else:
        normal_vals = values
    mu = float(np.mean(normal_vals))
    sigma = float(np.std(normal_vals))
    return (round(mu, 1), max(sigma, max(1.5, floor_ratio * mu)))


def _compute_weekly_context(
    cur,
    matching_cells: List[str],
    count_col: str,
    sensor_mode: str,
) -> Tuple[Dict[date, int], Dict[int, float], Dict[int, float]]:
    """
    Fetch ISO-Monday-bucketed fire counts and compute ISO-week climatology
    baselines across actual dataset years (with circular seasonal smoothing
    when fewer than 3 years exist in the dataset).
    """
    sql = f"""
        SELECT
            DATE_TRUNC('week', acq_date)::DATE AS wk_monday,
            CAST(SUM({count_col}) AS INTEGER) AS weekly_count
        FROM harmonized_fires
        WHERE h3_index IN (SELECT UNNEST(?::VARCHAR[]))
          AND {count_col} > 0
        GROUP BY wk_monday
        ORDER BY wk_monday
    """
    rows = cur.execute(sql, [matching_cells]).fetchall()

    week_date_map: Dict[date, int] = {}
    by_year_week: Dict[Tuple[int, int], int] = {}
    for r in rows:
        wk_monday = r[0]
        if isinstance(wk_monday, datetime):
            wk_monday = wk_monday.date()
        cnt = int(r[1])
        week_date_map[wk_monday] = cnt
        iso_cal = wk_monday.isocalendar()
        iso_wk = min(52, int(iso_cal.week))
        by_year_week[(int(iso_cal.year), iso_wk)] = (
            by_year_week.get((int(iso_cal.year), iso_wk), 0) + cnt
        )

    min_yr, max_yr = _get_dataset_year_bounds(sensor_mode)
    baseline_years = list(range(min_yr, max_yr + 1))

    weekly_means: Dict[int, float] = {}
    weekly_stds: Dict[int, float] = {}

    if len(baseline_years) >= 3:
        for wk in range(1, 53):
            wk_counts = np.array(
                [by_year_week.get((yr, wk), 0) for yr in baseline_years],
                dtype=np.float64,
            )
            weekly_means[wk], weekly_stds[wk] = _trimmed_mean_and_std(wk_counts, 0.18)
    else:
        # Single/two-year dataset: build an average 52-week profile and smooth +-4 weeks seasonally
        raw_profile = np.array(
            [
                float(np.mean([by_year_week.get((yr, wk), 0) for yr in baseline_years]))
                for wk in range(1, 53)
            ],
            dtype=np.float64,
        )
        padded = np.pad(raw_profile, pad_width=4, mode="wrap")
        for wk in range(1, 53):
            window = padded[(wk - 1) : (wk - 1) + 9]
            mu = float(np.mean(window))
            sigma = float(np.std(window))
            weekly_means[wk] = round(mu, 1)
            weekly_stds[wk] = max(sigma, max(1.5, 0.22 * mu))

    return (week_date_map, weekly_means, weekly_stds)


def query_calendar_series(
    aoi_dict: Dict,
    date_start: str,
    date_end: str,
    sensor_mode: str,
) -> CalendarSeriesResponse:
    """
    Endpoint 2: Compute ISO weekly time-series, climatological baseline
    (historical_mean), Z-score anomaly flags (Z > 2.0), and Critical Fire Season bounds.
    """
    matching_cells = db_engine.get_matching_h3_cells(aoi_dict)
    if not matching_cells:
        return CalendarSeriesResponse(
            status="success",
            summary=CalendarSeasonSummary(
                critical_season_start="06-15",
                critical_season_end="09-30",
            ),
            time_series=[],
        )

    count_col, _ = SENSOR_COLUMN_MAP.get(
        sensor_mode, SENSOR_COLUMN_MAP["harmonized"]
    )
    cur = db_engine.cursor()
    week_date_map, weekly_means, weekly_stds = _compute_weekly_context(
        cur, matching_cells, count_col, sensor_mode
    )
    crit_start, crit_end = _detect_critical_fire_season(weekly_means)

    dt_start, dt_end = _parse_date_range(date_start, date_end)
    curr_monday = dt_start - timedelta(days=dt_start.weekday())
    time_series: List[CalendarTimeSeriesPoint] = []

    while curr_monday <= dt_end:
        iso_cal = curr_monday.isocalendar()
        iso_yr = int(iso_cal.year)
        iso_wk = min(52, int(iso_cal.week))

        if 2000 <= iso_yr <= 2030:
            count_val = week_date_map.get(curr_monday, 0)
            hist_mean = weekly_means.get(iso_wk, 0.0)
            hist_std = weekly_stds.get(iso_wk, 1.5)

            if sensor_mode == "viirs" and iso_yr < 2012:
                z_val = 0.0
                is_anom = False
            else:
                z_val = round((float(count_val) - hist_mean) / hist_std, 2)
                is_anom = bool(z_val > 2.0 and count_val > 0)

            time_series.append(
                CalendarTimeSeriesPoint(
                    date=curr_monday.strftime("%Y-%m-%d"),
                    harmonized_count=int(count_val),
                    historical_mean=hist_mean,
                    z_score=z_val,
                    is_anomaly=is_anom,
                )
            )

        curr_monday += timedelta(days=7)

    return CalendarSeriesResponse(
        status="success",
        summary=CalendarSeasonSummary(
            critical_season_start=crit_start,
            critical_season_end=crit_end,
        ),
        time_series=time_series,
    )


def _query_daily_trend(
    cur,
    matching_cells: List[str],
    count_col: str,
    sensor_mode: str,
    dt_start: date,
    dt_end: date,
) -> List[TrendPoint]:
    sql = f"""
        SELECT
            acq_date::DATE AS obs_day,
            CAST(SUM({count_col}) AS INTEGER) AS daily_count
        FROM harmonized_fires
        WHERE h3_index IN (SELECT UNNEST(?::VARCHAR[]))
          AND {count_col} > 0
        GROUP BY obs_day
        ORDER BY obs_day
    """
    rows = cur.execute(sql, [matching_cells]).fetchall()
    daily_map: Dict[date, int] = {}
    for r in rows:
        d = r[0].date() if isinstance(r[0], datetime) else r[0]
        daily_map[d] = int(r[1])

    min_yr, max_yr = _get_dataset_year_bounds(sensor_mode)
    baseline_years = list(range(min_yr, max_yr + 1))

    # Build seasonal daily baseline keyed by (month, day)
    mmdd_baseline: Dict[Tuple[int, int], Tuple[float, float]] = {}
    if len(baseline_years) >= 3:
        # Multi-year +-3-day window across historical years for smooth day-of-year climatology
        ref_day = date(2024, 1, 1)  # Leap year covers all 366 days cleanly
        while ref_day.year == 2024:
            samples: List[int] = []
            for yr in baseline_years:
                try:
                    center = date(yr, ref_day.month, ref_day.day)
                except ValueError:
                    center = date(yr, 2, 28)
                for offset in range(-3, 4):
                    samples.append(daily_map.get(center + timedelta(days=offset), 0))
            mmdd_baseline[(ref_day.month, ref_day.day)] = _trimmed_mean_and_std(
                np.array(samples, dtype=np.float64), floor_ratio=0.20
            )
            ref_day += timedelta(days=1)

    points: List[TrendPoint] = []
    curr = dt_start
    while curr <= dt_end:
        cnt = daily_map.get(curr, 0)
        if len(baseline_years) >= 3:
            mu, sigma = mmdd_baseline.get((curr.month, curr.day), (0.0, 1.5))
        else:
            # Single/two-year dataset: 15-day (+-7d) centered seasonal rolling mean
            window_vals = np.array(
                [daily_map.get(curr + timedelta(days=off), 0) for off in range(-7, 8)],
                dtype=np.float64,
            )
            mu = round(float(np.mean(window_vals)), 1)
            sigma = max(float(np.std(window_vals)), max(1.5, 0.25 * mu))

        if sensor_mode == "viirs" and curr.year < 2012:
            z_val, is_anom = 0.0, False
        else:
            z_val = round((float(cnt) - mu) / sigma, 2)
            is_anom = bool(z_val > 2.0 and cnt > 0)

        iso_str = curr.strftime("%Y-%m-%d")
        points.append(
            TrendPoint(
                slice_start=iso_str,
                slice_end=iso_str,
                label=curr.strftime("%b %d"),
                count=cnt,
                historical_mean=mu,
                z_score=z_val,
                is_anomaly=is_anom,
            )
        )
        curr += timedelta(days=1)

    return points


def _query_monthly_trend(
    cur,
    matching_cells: List[str],
    count_col: str,
    sensor_mode: str,
    dt_start: date,
    dt_end: date,
) -> List[TrendPoint]:
    sql = f"""
        SELECT
            CAST(EXTRACT(YEAR FROM acq_date) AS INTEGER) AS yr,
            CAST(EXTRACT(MONTH FROM acq_date) AS INTEGER) AS mo,
            CAST(SUM({count_col}) AS INTEGER) AS monthly_count
        FROM harmonized_fires
        WHERE h3_index IN (SELECT UNNEST(?::VARCHAR[]))
          AND {count_col} > 0
        GROUP BY yr, mo
        ORDER BY yr, mo
    """
    rows = cur.execute(sql, [matching_cells]).fetchall()
    monthly_map: Dict[Tuple[int, int], int] = {
        (int(r[0]), int(r[1])): int(r[2]) for r in rows
    }

    min_yr, max_yr = _get_dataset_year_bounds(sensor_mode)
    baseline_years = list(range(min_yr, max_yr + 1))

    mo_baseline: Dict[int, Tuple[float, float]] = {}
    for mo in range(1, 13):
        if len(baseline_years) >= 3:
            vals = np.array(
                [monthly_map.get((yr, mo), 0) for yr in baseline_years],
                dtype=np.float64,
            )
            mo_baseline[mo] = _trimmed_mean_and_std(vals, floor_ratio=0.18)
        else:
            # Circular 3-month seasonal smoothing on 1-2 year datasets
            adj_mos = [((mo - 2) % 12) + 1, mo, (mo % 12) + 1]
            vals = np.array(
                [
                    monthly_map.get((yr, m), 0)
                    for yr in baseline_years
                    for m in adj_mos
                ],
                dtype=np.float64,
            )
            mu = round(float(np.mean(vals)), 1) if vals.size else 0.0
            sigma = max(float(np.std(vals)) if vals.size else 1.5, max(2.0, 0.2 * mu))
            mo_baseline[mo] = (mu, sigma)

    points: List[TrendPoint] = []
    yr, mo = dt_start.year, dt_start.month
    while (yr, mo) <= (dt_end.year, dt_end.month):
        cnt = monthly_map.get((yr, mo), 0)
        mu, sigma = mo_baseline.get(mo, (0.0, 1.5))
        if sensor_mode == "viirs" and yr < 2012:
            z_val, is_anom = 0.0, False
        else:
            z_val = round((float(cnt) - mu) / sigma, 2)
            is_anom = bool(z_val > 2.0 and cnt > 0)

        last_day = calendar.monthrange(yr, mo)[1]
        s_dt = date(yr, mo, 1)
        e_dt = date(yr, mo, last_day)
        points.append(
            TrendPoint(
                slice_start=s_dt.strftime("%Y-%m-%d"),
                slice_end=e_dt.strftime("%Y-%m-%d"),
                label=s_dt.strftime("%b %Y"),
                count=cnt,
                historical_mean=mu,
                z_score=z_val,
                is_anomaly=is_anom,
            )
        )
        mo += 1
        if mo > 12:
            mo = 1
            yr += 1

    return points


def _query_multiyear_trend(
    cur,
    matching_cells: List[str],
    count_col: str,
    sensor_mode: str,
    dt_start: date,
    dt_end: date,
    span_years: int,
) -> List[TrendPoint]:
    sql = f"""
        SELECT
            CAST(EXTRACT(YEAR FROM acq_date) AS INTEGER) AS yr,
            CAST(SUM({count_col}) AS INTEGER) AS yr_count
        FROM harmonized_fires
        WHERE h3_index IN (SELECT UNNEST(?::VARCHAR[]))
          AND {count_col} > 0
        GROUP BY yr
        ORDER BY yr
    """
    rows = cur.execute(sql, [matching_cells]).fetchall()
    yearly_map: Dict[int, int] = {int(r[0]): int(r[1]) for r in rows}

    min_yr, max_yr = _get_dataset_year_bounds(sensor_mode)
    all_ep_start = (min_yr // span_years) * span_years
    all_ep_end = (max_yr // span_years) * span_years

    def _epoch_sum(ep_start: int) -> int:
        return sum(yearly_map.get(y, 0) for y in range(ep_start, ep_start + span_years))

    baseline_bins = [
        _epoch_sum(ep) for ep in range(all_ep_start, all_ep_end + 1, span_years)
    ]
    mu, sigma = _trimmed_mean_and_std(
        np.array(baseline_bins, dtype=np.float64), floor_ratio=0.18
    )

    points: List[TrendPoint] = []
    start_ep = (dt_start.year // span_years) * span_years
    end_ep = (dt_end.year // span_years) * span_years

    for ep in range(start_ep, end_ep + 1, span_years):
        ep_end = ep + span_years - 1
        cnt = _epoch_sum(ep)
        if sensor_mode == "viirs" and ep_end < 2012:
            z_val, is_anom = 0.0, False
        else:
            z_val = round((float(cnt) - mu) / sigma, 2)
            is_anom = bool(z_val > 2.0 and cnt > 0)

        label = str(ep) if span_years == 1 else f"{ep}–{ep_end}"
        points.append(
            TrendPoint(
                slice_start=f"{ep}-01-01",
                slice_end=f"{ep_end}-12-31",
                label=label,
                count=cnt,
                historical_mean=mu,
                z_score=z_val,
                is_anomaly=is_anom,
            )
        )

    return points


def query_trend_series(
    aoi_dict: Dict,
    date_start: str,
    date_end: str,
    sensor_mode: str,
    granularity: TimescaleType,
) -> TrendSeriesResponse:
    """
    Endpoint 3: Compute gap-filled chronological fire activity trend series and
    seasonal baselines at daily, weekly, monthly, yearly, 5-year, or 10-year intervals.
    """
    matching_cells = db_engine.get_matching_h3_cells(aoi_dict)
    if not matching_cells:
        return TrendSeriesResponse(
            status="success", granularity=granularity, time_series=[]
        )

    count_col, _ = SENSOR_COLUMN_MAP.get(
        sensor_mode, SENSOR_COLUMN_MAP["harmonized"]
    )
    cur = db_engine.cursor()
    dt_start, dt_end = _parse_date_range(date_start, date_end)

    if granularity == "daily":
        series = _query_daily_trend(
            cur, matching_cells, count_col, sensor_mode, dt_start, dt_end
        )
    elif granularity == "weekly":
        week_date_map, weekly_means, weekly_stds = _compute_weekly_context(
            cur, matching_cells, count_col, sensor_mode
        )
        curr_monday = dt_start - timedelta(days=dt_start.weekday())
        series = []
        while curr_monday <= dt_end:
            iso_cal = curr_monday.isocalendar()
            iso_yr = int(iso_cal.year)
            iso_wk = min(52, int(iso_cal.week))
            cnt = week_date_map.get(curr_monday, 0)
            mu = weekly_means.get(iso_wk, 0.0)
            sigma = weekly_stds.get(iso_wk, 1.5)
            if sensor_mode == "viirs" and iso_yr < 2012:
                z_val, is_anom = 0.0, False
            else:
                z_val = round((float(cnt) - mu) / sigma, 2)
                is_anom = bool(z_val > 2.0 and cnt > 0)
            sunday = curr_monday + timedelta(days=6)
            series.append(
                TrendPoint(
                    slice_start=curr_monday.strftime("%Y-%m-%d"),
                    slice_end=sunday.strftime("%Y-%m-%d"),
                    label=curr_monday.strftime("%b %d '%y"),
                    count=cnt,
                    historical_mean=mu,
                    z_score=z_val,
                    is_anomaly=is_anom,
                )
            )
            curr_monday += timedelta(days=7)
    elif granularity == "monthly":
        series = _query_monthly_trend(
            cur, matching_cells, count_col, sensor_mode, dt_start, dt_end
        )
    else:
        span_map = {"yearly": 1, "5y": 5, "10y": 10}
        series = _query_multiyear_trend(
            cur,
            matching_cells,
            count_col,
            sensor_mode,
            dt_start,
            dt_end,
            span_map.get(granularity, 1),
        )

    return TrendSeriesResponse(
        status="success", granularity=granularity, time_series=series
    )
