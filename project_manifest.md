# Project Manifest: Harmonization of MODIS and VIIRS Hot Spots
**Challenge:** 2026 NASA Space Apps - Harmonization of MODIS and VIIRS Hot Spots  
**Objective:** Build a web application that harmonizes active fire hotspot records from two satellite sensors into a unified "burning activity calendar" to enable early warning and historical fire pattern analysis within selected Areas of Interest (AOIs).

---

## 1. Project Architecture
The application utilizes a **3-Tier Pre-Computed Grid Architecture** to ensure high-performance spatial querying and rendering across multi-decade, large-volume datasets.

### A. Pre-Computation Layer (Data Pipeline)
*   **Role:** Offline batch processing.
*   **Tech:** Python, Polars/Pandas, H3 (Uber's Spatial Index).
*   **Process:** Downloads raw NASA FIRMS CSVs, groups coordinates into H3 hexagonal grid cells (Resolution 7/8), aligns timestamps, calibrates VIIRS & MODIS values using the overlap period, and outputs compressed **GeoParquet** files.

### B. Service Layer (Backend API)
*   **Role:** High-speed analytical serving.
*   **Tech:** Python, FastAPI, DuckDB (Spatial Extension).
*   **Process:** Loads GeoParquet directly into DuckDB. When a user requests data for an AOI polygon, DuckDB rapidly filters the pre-computed H3 grid and aggregates statistics in sub-seconds.

### C. Presentation Layer (Frontend Client)
*   **Role:** State management, interactive mapping, and data visualization.
*   **Tech:** React (Vite), TypeScript, Tailwind CSS.
*   **Libraries:** 
    *   **Map:** MapLibre GL JS + Deck.gl (for high-density WebGL rendering).
    *   **Charts:** Apache ECharts (for the calendar and time-series plots).

---

## 2. Feature Set & Components

### Component 1: Data Engineering & Spatial Backend
*   Automated scripts to pull historical archives from NASA FIRMS.
*   DuckDB engine setup for blazing-fast Parquet querying.
*   FastAPI endpoints serving aggregated data for map and charts.

### Component 2: Sensor Harmonization & Analytics Engine
*   Spatial-temporal alignment logic converting `(lat, lon)` to `H3 Index`.
*   Calibration models reconciling VIIRS (375m) and MODIS (1km) discrepancies.
*   Statistical algorithms for baselines and anomaly detection ($Z$-score > 2).

### Component 3: Interactive Map UI
*   Area of Interest (AOI) drawing tools (Bounding Box/Polygon).
*   Deck.gl `H3HexagonLayer` implementation for smooth data rendering.
*   Layer toggles for "Raw MODIS", "Raw VIIRS", and "Harmonized".

### Component 4: Burning Activity Calendar UI
*   Multi-decade heatmap calendar matrix.
*   Seasonal climatology curves highlighting the "Critical Fire Season".
*   Bidirectional state sync (clicking a calendar week filters the map).

---

## 3. JSON API Contract

All 4 members must adhere to this contract. The frontend sends GeoJSON, and the backend returns aggregated JSON payloads.

### Endpoint 1: Spatial Map Summary
**`POST /api/aoi/spatial-summary`**
Fetches H3 hexagonal grid data for the map layer within the requested date range.

**Request:**
```json
{
  "aoi": {
    "type": "Polygon",
    "coordinates": [[[-120.5, 38.5], [-119.0, 38.5], [-119.0, 39.5], [-120.5, 39.5], [-120.5, 38.5]]]
  },
  "date_start": "2015-01-01",
  "date_end": "2025-12-31",
  "sensor_mode": "harmonized" 
}
```

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "h3_index": "88283082b9fffff",
      "total_fires": 450,
      "mean_frp": 35.2
    },
    {
      "h3_index": "88283082b9fcfff",
      "total_fires": 120,
      "mean_frp": 12.8
    }
  ]
}
```

### Endpoint 2: Temporal Calendar Series
**`POST /api/aoi/calendar`**
Fetches the time-series aggregations for the charts and calendar heatmap.

**Request:** *(Same payload as Endpoint 1)*

**Response:**
```json
{
  "status": "success",
  "summary": {
    "critical_season_start": "08-15",
    "critical_season_end": "10-30"
  },
  "time_series": [
    {
      "date": "2020-09-08",
      "harmonized_count": 1205,
      "historical_mean": 450.5,
      "z_score": 3.2,
      "is_anomaly": true
    }
  ]
}
```

---

## 4. Docker Environment
To guarantee cross-platform compatibility and avoid C-library compilation issues (GDAL, GEOS), the project is orchestrated via `docker-compose.yml`.

### Architecture Structure
1.  **`backend`**: Runs the Python FastAPI server and DuckDB querying on port `8000`. Built on `python:3.11-slim-bookworm` to ensure pre-compiled geospatial wheels.
2.  **`frontend`**: Runs the React/Vite development server on port `5173`.
3.  **`pipeline`**: An on-demand ETL profile container that runs the data ingestion and harmonization scripts, outputting to a shared volume.

### Usage Instructions
*   **Shared Data**: Do NOT bake large datasets into the Docker image. Place NASA CSVs in the root `./data` folder, which is mounted as a volume into the backend container at `/data`.
*   **Run Web & API**: `docker compose up`
*   **Run Data ETL**: `docker compose --profile etl run --rm pipeline`

### docker-compose.yml
```yaml
services:
  backend:
    build: ./backend
    ports:
      - "8000:8000"
    volumes:
      - ./backend:/app
      - ./data:/data
    environment:
      - DATA_DIR=/data
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

  frontend:
    build: ./frontend
    ports:
      - "5173:5173"
    volumes:
      - ./frontend:/app
      - /app/node_modules
    environment:
      - VITE_API_URL=http://localhost:8000
    command: npm run dev -- --host

  pipeline:
    build: ./backend
    profiles: ["etl"]
    volumes:
      - ./backend:/app
      - ./data:/data
    command: python -m scripts.harmonize_data
```