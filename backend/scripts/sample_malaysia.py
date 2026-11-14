"""
Realistic Multi-Decade (2005-2026) Malaysian & Global Fire Hotspot Dataset Generator.

Models physical sensor differences between:
- MODIS (1km resolution, Terra/Aqua, active 2005-2026)
- VIIRS (375m resolution, Suomi-NPP/NOAA-20, active 2012-2026)

Captures Malaysian & Southeast Asian regional fire climatology alongside major global fire basins:
- Primary Peak: Southwest Monsoon dry season (June - September)
- Secondary Peak: Late Northeast Monsoon dry spell (February - March)
- Guaranteed recent & "Today" (2026-11-10) active burning so 'Today', 'This Week', 'This Month',
  and 'This Year' Date Views always display rich live data.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Dict, List, Tuple
import numpy as np
import polars as pl
import h3


# High-resolution Malaysian & regional fire zones + representative global fire basins
FIRE_ZONES: List[Dict] = [
    # --- Malaysia & Southeast Asia (Primary Focus) ---
    {
        "name": "Pahang Peatlands (Pekan & Rompin)",
        "center_lat": 3.22,
        "center_lon": 103.32,
        "spread_lat": 0.22,
        "spread_lon": 0.10,
        "num_clusters": 9,
        "weight": 1.35,
        "base_frp": 38.0,
    },
    {
        "name": "Selangor Peatlands (Kuala Langat & Raja Musa)",
        "center_lat": 2.98,
        "center_lon": 101.52,
        "spread_lat": 0.25,
        "spread_lon": 0.08,
        "num_clusters": 7,
        "weight": 1.15,
        "base_frp": 34.0,
    },
    {
        "name": "Sarawak Miri & Kuala Baram Peat Basin",
        "center_lat": 4.28,
        "center_lon": 114.08,
        "spread_lat": 0.16,
        "spread_lon": 0.12,
        "num_clusters": 8,
        "weight": 1.30,
        "base_frp": 42.0,
    },
    {
        "name": "Sarawak Mukah & Sibu Coastal Peatlands",
        "center_lat": 2.58,
        "center_lon": 112.05,
        "spread_lat": 0.18,
        "spread_lon": 0.25,
        "num_clusters": 8,
        "weight": 1.20,
        "base_frp": 36.0,
    },
    {
        "name": "Sarawak Sri Aman & Samarahan Basin",
        "center_lat": 1.35,
        "center_lon": 111.15,
        "spread_lat": 0.12,
        "spread_lon": 0.28,
        "num_clusters": 6,
        "weight": 1.00,
        "base_frp": 31.0,
    },
    {
        "name": "Sabah Klias Peninsula & Beaufort",
        "center_lat": 5.38,
        "center_lon": 115.66,
        "spread_lat": 0.10,
        "spread_lon": 0.09,
        "num_clusters": 6,
        "weight": 0.95,
        "base_frp": 33.0,
    },
    {
        "name": "Sabah Kinabatangan & Lahad Datu Corridor",
        "center_lat": 5.48,
        "center_lon": 117.92,
        "spread_lat": 0.16,
        "spread_lon": 0.22,
        "num_clusters": 6,
        "weight": 0.90,
        "base_frp": 35.0,
    },
    {
        "name": "Johor Southern Corridor (Kluang & Kota Tinggi)",
        "center_lat": 1.96,
        "center_lon": 103.52,
        "spread_lat": 0.16,
        "spread_lon": 0.24,
        "num_clusters": 6,
        "weight": 0.85,
        "base_frp": 29.0,
    },
    {
        "name": "Perak & Kedah Agricultural Belt",
        "center_lat": 4.88,
        "center_lon": 100.92,
        "spread_lat": 0.30,
        "spread_lon": 0.12,
        "num_clusters": 6,
        "weight": 0.80,
        "base_frp": 27.0,
    },
    # --- Representative Global Fire Hotspots for World Map Exploration ---
    {
        "name": "Riau & Sumatra Peatlands (Indonesia)",
        "center_lat": 0.65,
        "center_lon": 101.85,
        "spread_lat": 0.35,
        "spread_lon": 0.35,
        "num_clusters": 5,
        "weight": 1.15,
        "base_frp": 40.0,
    },
    {
        "name": "Central Kalimantan (Borneo)",
        "center_lat": -2.15,
        "center_lon": 113.95,
        "spread_lat": 0.35,
        "spread_lon": 0.35,
        "num_clusters": 5,
        "weight": 1.10,
        "base_frp": 41.0,
    },
    {
        "name": "Northern Territory Savanna (Australia)",
        "center_lat": -14.55,
        "center_lon": 132.45,
        "spread_lat": 0.40,
        "spread_lon": 0.45,
        "num_clusters": 4,
        "weight": 0.95,
        "base_frp": 44.0,
    },
    {
        "name": "Sierra Nevada & Northern California (USA)",
        "center_lat": 39.15,
        "center_lon": -120.15,
        "spread_lat": 0.35,
        "spread_lon": 0.35,
        "num_clusters": 4,
        "weight": 0.95,
        "base_frp": 48.0,
    },
    {
        "name": "Mato Grosso & Southern Amazon (Brazil)",
        "center_lat": -10.85,
        "center_lon": -55.45,
        "spread_lat": 0.45,
        "spread_lon": 0.45,
        "num_clusters": 4,
        "weight": 1.05,
        "base_frp": 43.0,
    },
    {
        "name": "Central African Savanna Belt (Angola / DRC)",
        "center_lat": -8.45,
        "center_lon": 20.65,
        "spread_lat": 0.45,
        "spread_lon": 0.45,
        "num_clusters": 4,
        "weight": 1.00,
        "base_frp": 37.0,
    },
]

# Known historical anomaly episodes:
# (year, start_week, end_week, multiplier)
HISTORICAL_ANOMALY_WINDOWS: List[Tuple[int, int, int, float]] = [
    (2006, 31, 40, 2.85),  # 2006 El Nino Southeast Asian Haze (Aug - Oct)
    (2009, 24, 34, 2.35),  # 2009 Mid-year dry season peat fires (Jun - Aug)
    (2013, 24, 27, 2.70),  # June 2013 severe Straits haze spike
    (2014, 7, 12, 2.65),   # Feb-Mar 2014 Selangor/Pahang extreme dry spell
    (2014, 26, 31, 2.15),  # Jul 2014 dry spell
    (2015, 29, 42, 3.30),  # 2015 Super El Nino crisis (Jul - Oct)
    (2016, 10, 16, 2.10),  # Post-El Nino spring heatwave (Mar - Apr 2016)
    (2019, 30, 38, 2.95),  # 2019 ASEAN peatland fire crisis (late Jul - Sep)
    (2023, 31, 39, 2.40),  # 2023 El Nino dry season spike (Aug - Sep)
    (2024, 8, 12, 2.05),   # Early 2024 hot/dry spell (Feb - Mar)
    (2026, 30, 37, 2.50),  # 2026 late-summer dry season anomaly spike (Jul - Sep)
    (2026, 44, 46, 1.85),  # Active early-Nov 2026 localized burning so Today/This Week is rich
]


def _build_active_hex_pool(rng: np.random.Generator) -> List[Dict]:
    """Build a pool of H3 Resolution 8 cells across Malaysian & global fire zones."""
    hex_records: Dict[str, Dict] = {}

    for zone in FIRE_ZONES:
        for _ in range(zone["num_clusters"]):
            c_lat = zone["center_lat"] + rng.normal(0, zone["spread_lat"] * 0.55)
            c_lon = zone["center_lon"] + rng.normal(0, zone["spread_lon"] * 0.55)
            center_h3 = h3.latlng_to_cell(c_lat, c_lon, 8)
            ring_cells = h3.grid_disk(center_h3, 2)
            for cell_id in ring_cells:
                if cell_id not in hex_records:
                    cell_lat, cell_lon = h3.cell_to_latlng(cell_id)
                    dist = h3.grid_distance(center_h3, cell_id)
                    spatial_intensity = float(np.exp(-0.35 * dist)) * zone["weight"]
                    hex_records[cell_id] = {
                        "h3_index": cell_id,
                        "cell_lat": round(cell_lat, 6),
                        "cell_lon": round(cell_lon, 6),
                        "region_name": zone["name"],
                        "spatial_weight": spatial_intensity,
                        "base_frp": zone["base_frp"],
                    }

    return list(hex_records.values())


def _seasonal_curve(day_of_year: int) -> float:
    """
    Bimodal seasonal fire curve:
    - Primary peak during Southwest Monsoon dry season: DOY 165-275 (mid-June to early Oct), peak ~DOY 225 (mid-Aug)
    - Secondary peak during late Northeast Monsoon dry spell: DOY 40-85 (mid-Feb to late Mar), peak ~DOY 60
    """
    sw_monsoon_peak = 1.65 * np.exp(-0.5 * ((day_of_year - 224.0) / 34.0) ** 2)
    ne_dry_spell = 0.65 * np.exp(-0.5 * ((day_of_year - 60.0) / 18.0) ** 2)
    baseline = 0.22
    return float(baseline + sw_monsoon_peak + ne_dry_spell)


def generate_malaysia_raw_observations(
    start_year: int = 2005,
    end_year: int = 2026,
    seed: int = 2026,
) -> Tuple[pl.DataFrame, List[Dict]]:
    """
    Synthesize daily cell-level MODIS (2005-2026) and VIIRS (2012-2026) observations,
    returning a Polars DataFrame and the active cell metadata list.
    """
    rng = np.random.default_rng(seed)
    hex_pool = _build_active_hex_pool(rng)
    num_cells = len(hex_pool)

    h3_indices = np.array([h["h3_index"] for h in hex_pool])
    spatial_weights = np.array([h["spatial_weight"] for h in hex_pool], dtype=np.float64)
    base_frps = np.array([h["base_frp"] for h in hex_pool], dtype=np.float64)

    anomaly_lookup: Dict[Tuple[int, int], float] = {}
    for yr, w_start, w_end, mult in HISTORICAL_ANOMALY_WINDOWS:
        for w in range(w_start, w_end + 1):
            center_w = 0.5 * (w_start + w_end)
            half_span = max(1.0, 0.5 * (w_end - w_start))
            shape = 0.75 + 0.35 * np.cos(0.8 * (w - center_w) / half_span)
            anomaly_lookup[(yr, w)] = float(mult * shape)

    viirs_launch_date = date(2012, 1, 20)
    true_viirs_to_modis_ratio = 3.25

    rows_h3: List[str] = []
    rows_date: List[date] = []
    rows_modis_count: List[int] = []
    rows_modis_frp: List[float] = []
    rows_viirs_count: List[int] = []
    rows_viirs_frp: List[float] = []

    start_dt = date(start_year, 1, 1)
    # Generate through Nov 10, 2026 (current date) so "Today" / "This Week" / "This Month" match live
    end_dt = date(end_year, 11, 10) if end_year == 2026 else date(end_year, 12, 31)
    total_days = (end_dt - start_dt).days + 1

    yearly_jitter = {
        yr: float(rng.uniform(0.82, 1.18)) for yr in range(start_year, end_year + 1)
    }

    for day_offset in range(total_days):
        curr_dt = start_dt + timedelta(days=day_offset)
        iso_cal = curr_dt.isocalendar()
        iso_wk = min(52, int(iso_cal.week))

        doy = curr_dt.timetuple().tm_yday
        seasonal = _seasonal_curve(doy)
        anom_mult = anomaly_lookup.get((curr_dt.year, iso_wk), yearly_jitter[curr_dt.year])

        # Ensure the latest 7 days up to 2026-11-10 have active daily burning for "Today" & "This Week"
        if curr_dt >= date(2026, 11, 1):
            daily_synoptic = 1.65 if curr_dt == date(2026, 11, 10) else 1.25
        else:
            daily_synoptic = float(rng.gamma(shape=3.5, scale=1.0 / 3.5))

        day_driver = seasonal * anom_mult * daily_synoptic

        fire_prob = np.clip(0.010 * day_driver * spatial_weights, 0.0, 0.65)
        active_mask = rng.random(num_cells) < fire_prob
        active_idx = np.nonzero(active_mask)[0]

        if active_idx.size == 0:
            continue

        for idx in active_idx:
            w_s = spatial_weights[idx]
            b_frp = base_frps[idx]

            lambda_modis = max(0.45, 0.95 * w_s * np.sqrt(day_driver))
            m_count = int(rng.poisson(lambda_modis))
            if m_count == 0 and rng.random() < 0.55:
                m_count = 1

            m_frp = 0.0
            if m_count > 0:
                m_frp = round(
                    float(b_frp * (0.8 + 0.25 * np.sqrt(day_driver)) * rng.uniform(0.75, 1.30)),
                    2,
                )

            v_count = 0
            v_frp = 0.0
            if curr_dt >= viirs_launch_date:
                if m_count > 0:
                    if rng.random() < 0.08:
                        v_count = 0
                    else:
                        v_count = max(
                            1,
                            int(rng.poisson(m_count * true_viirs_to_modis_ratio)),
                        )
                else:
                    v_count = int(rng.integers(1, 3))

                if v_count > 0:
                    v_frp = round(
                        float(b_frp * 0.82 * (0.8 + 0.25 * np.sqrt(day_driver)) * rng.uniform(0.78, 1.25)),
                        2,
                    )

            if m_count == 0 and v_count == 0:
                continue

            rows_h3.append(str(h3_indices[idx]))
            rows_date.append(curr_dt)
            rows_modis_count.append(m_count)
            rows_modis_frp.append(m_frp)
            rows_viirs_count.append(v_count)
            rows_viirs_frp.append(v_frp)

    df = pl.DataFrame(
        {
            "h3_index": rows_h3,
            "acq_date": rows_date,
            "modis_count": rows_modis_count,
            "modis_frp": rows_modis_frp,
            "viirs_count": rows_viirs_count,
            "viirs_frp": rows_viirs_frp,
        }
    )

    return df, hex_pool
