export type SensorMode = "harmonized" | "modis" | "viirs";

export interface GeoJSONPolygon {
  type: "Polygon";
  coordinates: number[][][];
}

export interface AOIQueryPayload {
  aoi: GeoJSONPolygon;
  date_start: string;
  date_end: string;
  sensor_mode: SensorMode;
}

export interface SpatialHexDatum {
  h3_index: string;
  total_fires: number;
  mean_frp: number;
}

export interface SpatialSummaryResponse {
  status: string;
  data: SpatialHexDatum[];
}

export interface CalendarSummary {
  critical_season_start: string;
  critical_season_end: string;
}

export interface CalendarTimeSeriesPoint {
  date: string;
  harmonized_count: number;
  historical_mean: number;
  z_score: number;
  is_anomaly: boolean;
}

export interface CalendarSeriesResponse {
  status: string;
  summary: CalendarSummary;
  time_series: CalendarTimeSeriesPoint[];
}

export interface HealthMetadata {
  source_mode?: string;
  h3_resolution?: number;
  calibration_alpha_count?: number;
  calibration_gamma_frp?: number;
  overlap_sample_size?: number;
  total_hex_days?: number;
  unique_active_h3_cells?: number;
  date_min?: string;
  date_max?: string;
}

export interface PresetAOI {
  id: string;
  name: string;
  subtitle: string;
  center: [number, number]; // [lon, lat]
  zoom: number;
  polygon: GeoJSONPolygon;
}
