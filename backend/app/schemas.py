"""
Pydantic API Schemas strictly adhering to Section 3 of project_manifest.md.
"""

from __future__ import annotations

from typing import List, Literal
from pydantic import BaseModel, Field, field_validator


class GeoJSONPolygon(BaseModel):
    type: Literal["Polygon"] = "Polygon"
    coordinates: List[List[List[float]]] = Field(
        ...,
        description="GeoJSON Polygon coordinates array [[[lon, lat], ...]]",
    )


class AOIQueryRequest(BaseModel):
    aoi: GeoJSONPolygon
    date_start: str = Field(..., examples=["2015-01-01"])
    date_end: str = Field(..., examples=["2025-12-31"])
    sensor_mode: str = Field(default="harmonized", examples=["harmonized"])

    @field_validator("sensor_mode")
    @classmethod
    def normalize_sensor_mode(cls, v: str) -> str:
        clean = v.strip().lower()
        if "modis" in clean:
            return "modis"
        if "viirs" in clean:
            return "viirs"
        return "harmonized"


class SpatialHexRecord(BaseModel):
    h3_index: str
    total_fires: int
    mean_frp: float


class SpatialSummaryResponse(BaseModel):
    status: str = "success"
    data: List[SpatialHexRecord]


class CalendarSeasonSummary(BaseModel):
    critical_season_start: str
    critical_season_end: str


class CalendarTimeSeriesPoint(BaseModel):
    date: str
    harmonized_count: int
    historical_mean: float
    z_score: float
    is_anomaly: bool


class CalendarSeriesResponse(BaseModel):
    status: str = "success"
    summary: CalendarSeasonSummary
    time_series: List[CalendarTimeSeriesPoint]
