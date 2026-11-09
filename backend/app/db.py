"""
DuckDB Spatial Engine & 2-Step Active H3 Cell Filtering.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import duckdb

from scripts.harmonize_data import get_data_dir, run_harmonization_pipeline


class SpatialDuckDBEngine:
    def __init__(self) -> None:
        self._con: Optional[duckdb.DuckDBPyConnection] = None
        self._spatial_loaded: bool = False
        self._metadata: Dict = {}

    def initialize(self) -> None:
        """Ensure Parquet files exist, initialize DuckDB, and load tables into memory."""
        self._metadata = run_harmonization_pipeline(force=False)
        data_dir: Path = get_data_dir()
        fires_path = str(data_dir / "harmonized_fires.parquet")
        cells_path = str(data_dir / "active_cells.parquet")

        con = duckdb.connect(database=":memory:")
        try:
            con.execute("LOAD spatial;")
            self._spatial_loaded = True
        except Exception:
            try:
                con.execute("INSTALL spatial; LOAD spatial;")
                self._spatial_loaded = True
            except Exception:
                self._spatial_loaded = False

        # Materialize both compressed Parquet tables into DuckDB in-memory tables for <5ms latency
        con.execute(
            f"CREATE TABLE active_cells AS SELECT * FROM read_parquet('{cells_path}');"
        )
        con.execute(
            f"CREATE TABLE harmonized_fires AS SELECT * FROM read_parquet('{fires_path}');"
        )
        self._con = con

    @property
    def metadata(self) -> Dict:
        return self._metadata

    def cursor(self) -> duckdb.DuckDBPyConnection:
        if self._con is None:
            self.initialize()
        assert self._con is not None
        return self._con.cursor()

    @staticmethod
    def _extract_bbox_and_check_rectangle(
        coordinates: List[List[List[float]]],
    ) -> Tuple[float, float, float, float, bool, List[Tuple[float, float]]]:
        """
        Compute outer bounding box (min_lon, min_lat, max_lon, max_lat) and check
        whether the exterior ring is an axis-aligned rectangle.
        """
        if not coordinates or not coordinates[0]:
            return (-180.0, -90.0, 180.0, 90.0, True, [])

        ring = [(float(pt[0]), float(pt[1])) for pt in coordinates[0] if len(pt) >= 2]
        if not ring:
            return (-180.0, -90.0, 180.0, 90.0, True, [])

        lons = [pt[0] for pt in ring]
        lats = [pt[1] for pt in ring]
        min_lon, max_lon = min(lons), max(lons)
        min_lat, max_lat = min(lats), max(lats)

        # Remove closing vertex if duplicate of first
        unique_pts = ring[:-1] if (len(ring) > 1 and ring[0] == ring[-1]) else ring
        is_axis_rect = False
        if len(unique_pts) == 4:
            eps = 1e-6
            corners_match = all(
                (abs(lon - min_lon) < eps or abs(lon - max_lon) < eps)
                and (abs(lat - min_lat) < eps or abs(lat - max_lat) < eps)
                for lon, lat in unique_pts
            )
            is_axis_rect = corners_match

        return (min_lon, min_lat, max_lon, max_lat, is_axis_rect, ring)

    @staticmethod
    def _point_in_ring(lon: float, lat: float, ring: List[Tuple[float, float]]) -> bool:
        """Ray-casting point-in-polygon check (fallback if spatial extension is unavailable)."""
        inside = False
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i]
            xj, yj = ring[j]
            intersect = ((yi > lat) != (yj > lat)) and (
                lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
            )
            if intersect:
                inside = not inside
            j = i
        return inside

    def get_matching_h3_cells(self, aoi_dict: Dict) -> List[str]:
        """
        Execute the 2-step spatial filter against `active_cells`:
        Step 1: Fast bounding-box pre-filter (`cell_lon` & `cell_lat` BETWEEN min/max).
        Step 2: If the user drew a non-rectangular polygon, trim corners with `ST_Contains`.
        """
        coords = aoi_dict.get("coordinates", [])
        min_lon, min_lat, max_lon, max_lat, is_rect, ring = (
            self._extract_bbox_and_check_rectangle(coords)
        )

        cur = self.cursor()

        # Case 1: Axis-aligned rectangular bounding box (Step 1 is 100% exact)
        if is_rect:
            rows = cur.execute(
                """
                SELECT h3_index
                FROM active_cells
                WHERE cell_lon BETWEEN ? AND ?
                  AND cell_lat BETWEEN ? AND ?
                """,
                [min_lon, max_lon, min_lat, max_lat],
            ).fetchall()
            return [r[0] for r in rows]

        # Case 2: Arbitrary multi-vertex polygon -> Step 1 BBox + Step 2 ST_Contains
        if self._spatial_loaded:
            geojson_str = json.dumps(
                {"type": "Polygon", "coordinates": coords}
            )
            rows = cur.execute(
                """
                SELECT h3_index
                FROM active_cells
                WHERE cell_lon BETWEEN ? AND ?
                  AND cell_lat BETWEEN ? AND ?
                  AND ST_Contains(
                        ST_GeomFromGeoJSON(?),
                        ST_Point(cell_lon, cell_lat)
                      )
                """,
                [min_lon, max_lon, min_lat, max_lat, geojson_str],
            ).fetchall()
            return [r[0] for r in rows]

        # Fallback if DuckDB spatial extension is not loaded: BBox in SQL + exact ray-casting
        candidates = cur.execute(
            """
            SELECT h3_index, cell_lon, cell_lat
            FROM active_cells
            WHERE cell_lon BETWEEN ? AND ?
              AND cell_lat BETWEEN ? AND ?
            """,
            [min_lon, max_lon, min_lat, max_lat],
        ).fetchall()
        return [
            r[0]
            for r in candidates
            if self._point_in_ring(float(r[1]), float(r[2]), ring)
        ]


db_engine = SpatialDuckDBEngine()
