"""
Sensor Harmonization & H3 Spatial-Temporal Alignment Pipeline.

Usage:
    python -m scripts.harmonize_data

3-Stage Data Ingestion:
1. Scans $DATA_DIR/raw/*.csv for raw NASA FIRMS MODIS & VIIRS archives.
2. If present, snaps (latitude, longitude) -> H3 Resolution 8 and buckets by (h3_index, acq_date).
3. If no raw CSVs are present, synthesizes a realistic 2005-2025 Malaysian MODIS + VIIRS dataset.

Harmonization Model (Overlap Regression Calibration + Daily H3 Fusion):
- Uses 2012-present co-located (h3_index, acq_date) pairs where both MODIS and VIIRS
  observed fire activity to calibrate 1km MODIS into 375m VIIRS-equivalent density (factor alpha).
- Preserves raw `modis_count`/`modis_frp`, raw `viirs_count`/`viirs_frp`, and unified
  `harmonized_count`/`harmonized_frp` side-by-side in `/data/harmonized_fires.parquet`.
"""

from __future__ import annotations

import glob
import json
import os
import re
import tempfile
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import h3
import numpy as np
import polars as pl

from scripts.sample_malaysia import generate_malaysia_raw_observations


def get_data_dir() -> Path:
    """Resolve data directory, falling back to /tmp on read-only serverless runtimes."""
    env_dir = os.environ.get("DATA_DIR")
    if env_dir:
        return Path(env_dir)

    repo_data_dir = Path(__file__).resolve().parent.parent.parent / "data"
    if (
        (repo_data_dir / "harmonized_fires.parquet").exists()
        and (repo_data_dir / "active_cells.parquet").exists()
        and (repo_data_dir / "metadata.json").exists()
    ):
        return repo_data_dir

    if os.environ.get("VERCEL"):
        return Path(tempfile.gettempdir()) / "hestia_data"

    try:
        repo_data_dir.mkdir(parents=True, exist_ok=True)
        return repo_data_dir
    except OSError:
        return Path(tempfile.gettempdir()) / "hestia_data"


# --- Global grid configuration -------------------------------------------------
# Fires are stored on H3 hexagons. Inside the Southeast Asian study area we keep
# the fine ~1 km grid (resolution 8); everywhere else a ~7 km grid (resolution 6)
# keeps a worldwide, multi-decade dataset small enough to ship with the backend.
FINE_RESOLUTION = 8
COARSE_RESOLUTION = 6

# (lon_min, lat_min, lon_max, lat_max)
STUDY_AREA_BBOX = (92.0, -12.0, 142.0, 23.0)
MALAYSIA_BBOX = (99.0, 0.5, 119.6, 7.6)


def _in_bbox(lat: float, lon: float, bbox: Tuple[float, float, float, float]) -> bool:
    lon_min, lat_min, lon_max, lat_max = bbox
    return lon_min <= lon <= lon_max and lat_min <= lat <= lat_max


def grid_resolution_for(lat: float, lon: float) -> int:
    """Fine grid within the study area, coarse grid for the rest of the world."""
    return FINE_RESOLUTION if _in_bbox(lat, lon, STUDY_AREA_BBOX) else COARSE_RESOLUTION


# Named fire regions, checked in order; the first box that contains the point wins.
# Ordered most-specific first so Indonesian sub-regions beat the continental boxes.
GLOBAL_REGIONS: List[Tuple[Tuple[float, float, float, float], str]] = [
    ((95.0, -6.0, 107.5, 6.5), "Sumatra & Riau Peatlands"),
    ((108.5, -4.5, 119.0, 2.5), "Kalimantan (Indonesian Borneo)"),
    ((105.0, -11.0, 116.0, -5.0), "Java & Bali"),
    ((116.0, -11.0, 128.0, -5.0), "Nusa Tenggara"),
    ((118.0, -6.0, 127.0, 2.0), "Sulawesi"),
    ((127.0, -8.5, 135.0, 3.0), "Maluku Islands"),
    ((130.0, -11.0, 151.5, 0.5), "New Guinea"),
    ((116.0, 4.5, 127.0, 21.5), "Philippines"),
    ((92.0, 5.5, 110.0, 29.0), "Mainland Southeast Asia"),
    ((60.0, 5.0, 92.0, 37.5), "South Asia"),
    ((100.0, 20.0, 146.0, 54.0), "East Asia"),
    ((60.0, 48.0, 180.0, 75.0), "Siberia & Russian Far East"),
    ((25.0, 12.0, 75.0, 48.0), "Central Asia & Middle East"),
    ((-18.0, 4.0, 25.0, 16.5), "West African Savanna"),
    ((8.0, -6.5, 32.0, 6.5), "Congo Basin"),
    ((28.0, -12.0, 52.0, 18.0), "East Africa"),
    ((10.0, -35.5, 42.0, -6.0), "Southern Africa"),
    ((-18.0, 16.5, 36.0, 35.0), "North Africa & Sahara"),
    ((-12.0, 35.0, 45.0, 72.0), "Europe & Mediterranean"),
    ((-80.0, -15.0, -45.0, 6.0), "Amazon Basin"),
    ((-60.0, -25.0, -34.0, -10.0), "Brazilian Cerrado"),
    ((-76.0, -56.0, -52.0, -25.0), "Southern South America"),
    ((-82.0, 0.0, -58.0, 13.0), "Northern Andes & Orinoco"),
    ((-95.0, 7.0, -58.0, 23.5), "Central America & Caribbean"),
    ((-118.0, 14.0, -86.0, 33.0), "Mexico"),
    ((-170.0, 30.0, -100.0, 72.0), "Western North America"),
    ((-100.0, 24.0, -50.0, 60.0), "Eastern North America"),
    ((113.0, -20.0, 154.0, -9.0), "Northern Australia"),
    ((138.0, -39.5, 154.0, -20.0), "Eastern Australia"),
    ((112.0, -39.5, 138.0, -20.0), "Western & Central Australia"),
    ((165.0, -48.0, 179.5, -33.0), "New Zealand"),
]


# FIRMS archive files are named like "modis_2015_Malaysia.csv" /
# "viirs-snpp_2020_Indonesia.csv". The country in the filename is far more
# reliable than guessing from coordinates, which cannot separate Peninsular
# Malaysia from Sumatra across the Strait of Malacca.
_SENSOR_FILENAME_PREFIX = re.compile(
    r"^(modis|viirs[-_a-z0-9]*|fire)[-_](archive[-_])?(\d{4})[-_]", re.IGNORECASE
)


def country_from_filename(path: str) -> Optional[str]:
    """Pull the country name out of a FIRMS archive filename, if it carries one."""
    stem = os.path.splitext(os.path.basename(path))[0]
    stripped = _SENSOR_FILENAME_PREFIX.sub("", stem)
    if stripped == stem:
        return None
    name = stripped.replace("_", " ").replace("-", " ").strip()
    if not name or not all(part.isalpha() for part in name.split()):
        return None
    return " ".join(part.capitalize() for part in name.split())


# ISO-3166 alpha-3 codes seen in FIRMS exports, for the countries whose fires
# matter most here. Anything else keeps whatever the file said.
ISO3_COUNTRY_NAMES = {
    "MYS": "Malaysia",
    "IDN": "Indonesia",
    "SGP": "Singapore",
    "BRN": "Brunei",
    "THA": "Thailand",
    "VNM": "Vietnam",
    "KHM": "Cambodia",
    "LAO": "Laos",
    "MMR": "Myanmar",
    "PHL": "Philippines",
    "IND": "India",
    "CHN": "China",
    "AUS": "Australia",
    "BRA": "Brazil",
    "USA": "United States",
    "CAN": "Canada",
    "RUS": "Russia",
    "COD": "Democratic Republic of the Congo",
    "AGO": "Angola",
    "ZMB": "Zambia",
    "MOZ": "Mozambique",
    "TZA": "Tanzania",
    "SDN": "Sudan",
    "NGA": "Nigeria",
    "PNG": "Papua New Guinea",
    "MEX": "Mexico",
    "ARG": "Argentina",
    "BOL": "Bolivia",
    "PRY": "Paraguay",
    "COL": "Colombia",
    "VEN": "Venezuela",
    "PER": "Peru",
}


def normalize_country(value: str) -> Optional[str]:
    """Turn a country cell value into a display name, expanding ISO-3 codes."""
    cleaned = (value or "").strip()
    if not cleaned or cleaned.lower() in {"nan", "none", "null"}:
        return None
    if len(cleaned) == 3 and cleaned.isalpha():
        return ISO3_COUNTRY_NAMES.get(cleaned.upper(), cleaned.upper())
    return cleaned


def _malaysian_region(lat: float, lon: float) -> str:
    """State / peatland level detail for Malaysian coordinates."""
    if lon < 105.0:
        if lat < 2.4:
            return "Johor Southern Corridor"
        if lon > 102.6 and lat < 4.2:
            return "Pahang Peatlands (Pekan & Rompin)"
        if lon < 102.0 and 2.5 <= lat <= 3.8:
            return "Selangor Peatlands (Kuala Langat)"
        return "Peninsular Malaysia Northern Belt"
    if lat > 4.6 and lon > 115.0:
        return "Sabah (Klias & Kinabatangan)"
    if lat > 3.5:
        return "Sarawak Miri & Baram Basin"
    return "Sarawak Central & Coastal Peatlands"


def region_name_for(lat: float, lon: float, country: Optional[str] = None) -> str:
    """Region label for a fire, preferring the country the source file declared."""
    if country:
        normalized = country.strip().lower()
        if normalized == "malaysia":
            return _malaysian_region(lat, lon)
        if normalized == "indonesia":
            # Indonesia spans the archipelago; keep island-level detail because
            # Sumatran and Kalimantan peat fires drive the regional haze.
            for bbox, name in GLOBAL_REGIONS:
                if _in_bbox(lat, lon, bbox):
                    return name
            return "Indonesia"
        return country

    return _infer_region_name(lat, lon)


def _infer_region_name(lat: float, lon: float) -> str:
    """Fall back to geography when the source file does not name a country."""
    # Malaysian detail is kept at state / peatland level for the study area.
    if _in_bbox(lat, lon, MALAYSIA_BBOX):
        return _malaysian_region(lat, lon)

    for bbox, name in GLOBAL_REGIONS:
        if _in_bbox(lat, lon, bbox):
            return name

    # Anything left over: label by hemisphere band rather than inventing a place.
    if lat >= 60.0:
        return "Arctic & Boreal"
    if lat <= -60.0:
        return "Antarctic"
    return "Open Ocean & Remote Islands"


def _ingest_raw_firms_csvs(csv_paths: List[str]) -> Tuple[pl.DataFrame, List[Dict]]:
    """Load raw NASA FIRMS CSV files, convert to H3 Resolution 8, and aggregate by cell-day."""
    frames: List[pl.DataFrame] = []
    for path in csv_paths:
        raw_df = pl.read_csv(path, ignore_errors=True)
        cols_lower = {c.lower(): c for c in raw_df.columns}

        lat_col = cols_lower.get("latitude") or cols_lower.get("lat")
        lon_col = cols_lower.get("longitude") or cols_lower.get("lon")
        date_col = cols_lower.get("acq_date") or cols_lower.get("date")
        frp_col = cols_lower.get("frp")
        inst_col = cols_lower.get("instrument") or cols_lower.get("satellite")

        if not (lat_col and lon_col and date_col):
            continue

        lats = raw_df[lat_col].cast(pl.Float64).to_list()
        lons = raw_df[lon_col].cast(pl.Float64).to_list()
        h3_cells = [
            h3.latlng_to_cell(
                float(la), float(lo), grid_resolution_for(float(la), float(lo))
            )
            for la, lo in zip(lats, lons)
        ]

        if inst_col:
            inst_vals = [str(v).upper() for v in raw_df[inst_col].to_list()]
            sensors = [
                "viirs" if ("VIIRS" in v or v in ("N", "N20", "N21", "SNPP")) else "modis"
                for v in inst_vals
            ]
        else:
            fname = os.path.basename(path).lower()
            default_sensor = "viirs" if "viirs" in fname else "modis"
            sensors = [default_sensor] * len(h3_cells)

        frps = (
            raw_df[frp_col].cast(pl.Float64).fill_null(15.0).to_list()
            if frp_col
            else [20.0] * len(h3_cells)
        )

        # The filename is the most reliable source; the country_id column holds
        # ISO codes ("MYS") that need translating before they reach a map label.
        file_country = country_from_filename(path)
        country_col = cols_lower.get("country_id") or cols_lower.get("country")
        if file_country:
            countries = [file_country] * len(h3_cells)
        elif country_col:
            countries = [
                normalize_country(str(v)) for v in raw_df[country_col].to_list()
            ]
        else:
            countries = [None] * len(h3_cells)

        standardized = pl.DataFrame(
            {
                "h3_index": h3_cells,
                "acq_date": raw_df[date_col].cast(pl.Utf8).str.to_date("%Y-%m-%d", strict=False),
                "sensor": sensors,
                "frp": frps,
                "country": pl.Series(countries, dtype=pl.Utf8),
            }
        ).drop_nulls(["h3_index", "acq_date"])

        frames.append(standardized)

    if not frames:
        raise ValueError("No valid NASA FIRMS CSV files could be parsed from raw directory.")

    combined = pl.concat(frames)

    modis_daily = (
        combined.filter(pl.col("sensor") == "modis")
        .group_by(["h3_index", "acq_date"])
        .agg(
            pl.len().cast(pl.Int32).alias("modis_count"),
            pl.col("frp").mean().round(2).alias("modis_frp"),
        )
    )

    viirs_daily = (
        combined.filter(pl.col("sensor") == "viirs")
        .group_by(["h3_index", "acq_date"])
        .agg(
            pl.len().cast(pl.Int32).alias("viirs_count"),
            pl.col("frp").mean().round(2).alias("viirs_frp"),
        )
    )

    daily = modis_daily.join(
        viirs_daily, on=["h3_index", "acq_date"], how="full", coalesce=True
    ).with_columns(
        pl.col("modis_count").fill_null(0).cast(pl.Int32),
        pl.col("modis_frp").fill_null(0.0).cast(pl.Float64),
        pl.col("viirs_count").fill_null(0).cast(pl.Int32),
        pl.col("viirs_frp").fill_null(0.0).cast(pl.Float64),
    )

    # Most frequent country per cell; a hexagon is small enough that this is
    # unambiguous except right on a border.
    cell_country = {
        row["h3_index"]: row["country"]
        for row in combined.drop_nulls("country")
        .group_by(["h3_index", "country"])
        .agg(pl.len().alias("n"))
        .sort(["h3_index", "n"], descending=[False, True])
        .unique(subset=["h3_index"], keep="first")
        .to_dicts()
    }

    unique_cells = daily["h3_index"].unique().to_list()
    hex_pool = []
    for cell_id in unique_cells:
        c_lat, c_lon = h3.cell_to_latlng(cell_id)
        hex_pool.append(
            {
                "h3_index": cell_id,
                "cell_lat": round(c_lat, 6),
                "cell_lon": round(c_lon, 6),
                "region_name": region_name_for(c_lat, c_lon, cell_country.get(cell_id)),
            }
        )

    return daily, hex_pool


def run_harmonization_pipeline(force: bool = False) -> Dict:
    """Execute the full H3 spatial-temporal harmonization pipeline and output Parquet files."""
    data_dir = get_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = data_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    fires_parquet_path = data_dir / "harmonized_fires.parquet"
    cells_parquet_path = data_dir / "active_cells.parquet"
    metadata_path = data_dir / "metadata.json"

    if (
        not force
        and fires_parquet_path.exists()
        and cells_parquet_path.exists()
        and metadata_path.exists()
    ):
        with open(metadata_path, "r", encoding="utf-8") as f:
            return json.load(f)

    csv_files = sorted(glob.glob(str(raw_dir / "*.csv")))
    if csv_files:
        print(f"[ETL] Found {len(csv_files)} raw NASA FIRMS CSV file(s). Ingesting...")
        daily_df, hex_pool = _ingest_raw_firms_csvs(csv_files)
        source_mode = "nasa_firms_csv"
    else:
        print("[ETL] No raw CSVs in /data/raw. Generating multi-decade dataset (2005-2026)...")
        daily_df, hex_pool = generate_malaysia_raw_observations(2005, 2026)
        source_mode = "malaysia_multi_decade_model"

    # Step 2: Fit Overlap Calibration Factor (2012-present co-located observations)
    viirs_launch = date(2012, 1, 20)
    overlap_df = daily_df.filter(
        (pl.col("acq_date") >= viirs_launch)
        & (pl.col("modis_count") > 0)
        & (pl.col("viirs_count") > 0)
    )

    if overlap_df.height > 10:
        sum_viirs = float(overlap_df["viirs_count"].sum())
        sum_modis = float(overlap_df["modis_count"].sum())
        alpha_count = round(sum_viirs / max(sum_modis, 1.0), 4)

        mean_v_frp = float(overlap_df["viirs_frp"].mean())
        mean_m_frp = float(overlap_df["modis_frp"].mean())
        gamma_frp = round(mean_v_frp / max(mean_m_frp, 1.0), 4)
    else:
        alpha_count = 3.25
        gamma_frp = 0.82

    print(
        f"[ETL] Calibrated Overlap Model (n={overlap_df.height:,} co-located hex-days): "
        f"alpha_count={alpha_count:.3f}, gamma_frp={gamma_frp:.3f}"
    )

    # Step 3: Compute Unified `harmonized_count` and `harmonized_frp` + ISO Week Calendar Fields
    # Note: ISO week 53 is folded into week 52 for consistent 52-week seasonal matrix alignment
    harmonized_df = (
        daily_df.with_columns(
            [
                pl.when((pl.col("modis_count") > 0) & (pl.col("viirs_count") > 0))
                .then(
                    (
                        0.70 * pl.col("viirs_count")
                        + 0.30 * (pl.col("modis_count") * alpha_count)
                    )
                    .round(0)
                    .cast(pl.Int32)
                )
                .when(pl.col("viirs_count") > 0)
                .then(pl.col("viirs_count"))
                .otherwise(
                    (pl.col("modis_count") * alpha_count)
                    .round(0)
                    .cast(pl.Int32)
                    .clip(lower_bound=1)
                )
                .alias("harmonized_count"),
                pl.when((pl.col("modis_count") > 0) & (pl.col("viirs_count") > 0))
                .then(
                    (
                        0.70 * pl.col("viirs_frp")
                        + 0.30 * (pl.col("modis_frp") * gamma_frp)
                    ).round(2)
                )
                .when(pl.col("viirs_count") > 0)
                .then(pl.col("viirs_frp"))
                .otherwise((pl.col("modis_frp") * gamma_frp).round(2))
                .alias("harmonized_frp"),
                pl.col("acq_date").dt.iso_year().cast(pl.Int32).alias("iso_year"),
                pl.col("acq_date")
                .dt.week()
                .cast(pl.Int32)
                .clip(upper_bound=52)
                .alias("iso_week"),
            ]
        )
        .with_columns(
            # Compute Monday start date of the (iso_year, iso_week) bucket
            pl.col("acq_date")
            .dt.truncate("1w")
            .dt.to_string("%Y-%m-%d")
            .alias("week_start_date")
        )
        .sort(["acq_date", "h3_index"])
    )

    cells_df = pl.DataFrame(
        [
            {
                "h3_index": h["h3_index"],
                "cell_lat": float(h["cell_lat"]),
                "cell_lon": float(h["cell_lon"]),
                "region_name": str(h["region_name"]),
            }
            for h in hex_pool
        ]
    ).sort("h3_index")

    # Write compressed Parquet tables
    harmonized_df.write_parquet(fires_parquet_path, compression="zstd")
    cells_df.write_parquet(cells_parquet_path, compression="zstd")

    metadata = {
        "source_mode": source_mode,
        "h3_resolution": FINE_RESOLUTION,
        "h3_resolution_fine": FINE_RESOLUTION,
        "h3_resolution_coarse": COARSE_RESOLUTION,
        "study_area_bbox": list(STUDY_AREA_BBOX),
        "calibration_alpha_count": alpha_count,
        "calibration_gamma_frp": gamma_frp,
        "overlap_sample_size": int(overlap_df.height),
        "total_hex_days": int(harmonized_df.height),
        "unique_active_h3_cells": int(cells_df.height),
        "date_min": str(harmonized_df["acq_date"].min()),
        "date_max": str(harmonized_df["acq_date"].max()),
    }

    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    print(
        f"[ETL] Wrote {harmonized_df.height:,} hex-day records across "
        f"{cells_df.height:,} active H3 Resolution 8 cells to {data_dir}"
    )
    return metadata


if __name__ == "__main__":
    run_harmonization_pipeline(force=True)
