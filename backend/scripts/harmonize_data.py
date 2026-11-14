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
import tempfile
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, List, Tuple

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


def _infer_region_name(lat: float, lon: float) -> str:
    """Assign a human-readable Malaysian region label based on coordinates."""
    if lon < 105.0:
        if lat < 2.4:
            return "Johor Southern Corridor"
        if lon > 102.6 and lat < 4.2:
            return "Pahang Peatlands (Pekan & Rompin)"
        if lon < 102.0 and 2.5 <= lat <= 3.8:
            return "Selangor Peatlands (Kuala Langat)"
        return "Peninsular Malaysia Northern Belt"
    else:
        if lat > 4.6 and lon > 115.0:
            return "Sabah (Klias & Kinabatangan)"
        if lat > 3.5:
            return "Sarawak Miri & Baram Basin"
        return "Sarawak Central & Coastal Peatlands"


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
            h3.latlng_to_cell(float(la), float(lo), 8)
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

        standardized = pl.DataFrame(
            {
                "h3_index": h3_cells,
                "acq_date": raw_df[date_col].cast(pl.Utf8).str.to_date("%Y-%m-%d", strict=False),
                "sensor": sensors,
                "frp": frps,
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

    unique_cells = daily["h3_index"].unique().to_list()
    hex_pool = []
    for cell_id in unique_cells:
        c_lat, c_lon = h3.cell_to_latlng(cell_id)
        hex_pool.append(
            {
                "h3_index": cell_id,
                "cell_lat": round(c_lat, 6),
                "cell_lon": round(c_lon, 6),
                "region_name": _infer_region_name(c_lat, c_lon),
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
        "h3_resolution": 8,
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
