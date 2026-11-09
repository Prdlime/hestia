"""
Sensor Harmonization Analytics, Weekly Climatology Baselines, Anomaly Detection (Z > 2),
and 75th-Percentile Critical Fire Season Identification.
"""

from __future__ import annotations

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


def query_calendar_series(
    aoi_dict: Dict,
    date_start: str,
    date_end: str,
    sensor_mode: str,
) -> CalendarSeriesResponse:
    """
    Endpoint 2: Compute multi-decade ISO weekly time-series, climatological baseline
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

    # Query all historical weekly sums inside the AOI so baseline climatology
    # reflects the complete multi-decade record for this AOI.
    baseline_min_year = 2012 if sensor_mode == "viirs" else 2005
    baseline_max_year = 2025

    sql = f"""
        SELECT
            iso_year,
            iso_week,
            MIN(week_start_date) AS week_start_date,
            CAST(SUM({count_col}) AS INTEGER) AS weekly_count
        FROM harmonized_fires
        WHERE h3_index IN (SELECT UNNEST(?::VARCHAR[]))
          AND {count_col} > 0
        GROUP BY iso_year, iso_week
        ORDER BY iso_year, iso_week
    """
    rows = cur.execute(sql, [matching_cells]).fetchall()

    # Map (iso_year, iso_week) -> (week_start_date, weekly_count)
    observed_map: Dict[Tuple[int, int], Tuple[str, int]] = {}
    for r in rows:
        yr, wk, w_date, cnt = int(r[0]), int(r[1]), str(r[2]), int(r[3])
        observed_map[(yr, wk)] = (w_date, cnt)

    # Compute climatological mean (mu_w) and std dev (sigma_w) for each ISO week 1..52
    baseline_years = list(range(baseline_min_year, baseline_max_year + 1))
    weekly_means: Dict[int, float] = {}
    weekly_stds: Dict[int, float] = {}

    for wk in range(1, 53):
        wk_counts = np.array(
            [observed_map.get((yr, wk), ("", 0))[1] for yr in baseline_years],
            dtype=np.float64,
        )
        # Use trimmed statistics (excluding the top 2 extreme El Nino outlier years)
        # so the historical normal baseline represents typical seasonal climatology
        if wk_counts.size >= 8:
            sorted_counts = np.sort(wk_counts)
            normal_counts = sorted_counts[:-2]
            mu = float(np.mean(normal_counts))
            sigma = float(np.std(normal_counts))
        else:
            mu = float(np.mean(wk_counts)) if wk_counts.size > 0 else 0.0
            sigma = float(np.std(wk_counts)) if wk_counts.size > 0 else 1.0

        weekly_means[wk] = round(mu, 1)
        weekly_stds[wk] = max(sigma, max(1.5, 0.18 * mu))

    crit_start, crit_end = _detect_critical_fire_season(weekly_means)

    # Generate complete weekly time-series across requested [date_start, date_end]
    try:
        dt_start = datetime.strptime(date_start, "%Y-%m-%d").date()
        dt_end = datetime.strptime(date_end, "%Y-%m-%d").date()
    except ValueError:
        dt_start = date(2005, 1, 1)
        dt_end = date(2025, 12, 31)

    if dt_start > dt_end:
        dt_start, dt_end = dt_end, dt_start

    # Align dt_start to Monday of its ISO week
    curr_monday = dt_start - timedelta(days=dt_start.weekday())
    seen_year_weeks = set()
    time_series: List[CalendarTimeSeriesPoint] = []

    while curr_monday <= dt_end:
        iso_cal = curr_monday.isocalendar()
        iso_yr = int(iso_cal.year)
        iso_wk = min(52, int(iso_cal.week))

        if (iso_yr, iso_wk) not in seen_year_weeks and 2005 <= iso_yr <= 2025:
            seen_year_weeks.add((iso_yr, iso_wk))
            obs_date_str, count_val = observed_map.get(
                (iso_yr, iso_wk), (curr_monday.strftime("%Y-%m-%d"), 0)
            )
            hist_mean = weekly_means.get(iso_wk, 0.0)
            hist_std = weekly_stds.get(iso_wk, 1.5)

            if sensor_mode == "viirs" and iso_yr < 2012:
                # Prior to VIIRS launch in Jan 2012, raw VIIRS has 0 observations
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
