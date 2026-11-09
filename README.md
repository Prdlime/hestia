# NASA Space Apps 2026: Harmonization of MODIS & VIIRS Hot Spots

A 3-Tier Pre-Computed H3 Spatial Grid web application that harmonizes active fire hotspot records from **MODIS (1km, 2000–present)** and **VIIRS (375m, 2012–present)** into a unified **Burning Activity Calendar** for early warning and historical fire pattern analysis across **Malaysia** and surrounding regions.

---

## Quick Start (Docker Compose)

1. **Run the ETL & Harmonization Pipeline** *(optional — the backend also auto-bootstraps `/data` on first startup if missing)*:
   ```bash
   docker compose --profile etl run --rm pipeline
   ```
2. **Start the Backend API & Frontend Web App**:
   ```bash
   docker compose up --build
   ```
   - **Frontend Dashboard:** http://localhost:5173
   - **Backend FastAPI Docs:** http://localhost:8000/docs

### Using Real NASA FIRMS CSV Archives
Drop any NASA FIRMS MODIS or VIIRS CSV files into `./data/raw/` and run:
```bash
docker compose --profile etl run --rm pipeline
```
If `./data/raw/` contains no CSV files, the pipeline automatically synthesizes a 21-year (`2005–2025`) Malaysian MODIS + VIIRS dataset modeling Southwest/Northeast monsoon seasonality, peatland fire clusters (Pahang, Selangor, Sarawak, Sabah, Johor), and historical El Niño haze episodes (2006, 2009, 2013, 2014, 2015, 2019, 2023).

---

## Local Development (Without Docker)

### 1. Backend (`./backend`)
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Run ETL pipeline (writes to ../data/)
python -m scripts.harmonize_data

# Start FastAPI server on port 8000
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 2. Frontend (`./frontend`)
```bash
cd frontend
npm install
npm run dev
```
