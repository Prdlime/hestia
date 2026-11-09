import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertOctagon,
  CalendarRange,
  Flame,
  Hexagon,
  MapPin,
  Radio,
  Satellite,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  fetchCalendarSeries,
  fetchHealthMetadata,
  fetchSpatialSummary,
} from "./api/client";
import { CalendarHeatmap } from "./components/CalendarHeatmap";
import { ClimatologyChart } from "./components/ClimatologyChart";
import { MapView } from "./components/MapView";
import { MALAYSIA_PRESET_AOIS } from "./constants/presets";
import {
  CalendarSummary,
  CalendarTimeSeriesPoint,
  GeoJSONPolygon,
  HealthMetadata,
  SensorMode,
  SpatialHexDatum,
} from "./types/api";

export const App: React.FC = () => {
  const defaultPreset = MALAYSIA_PRESET_AOIS[0];

  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    defaultPreset.id
  );
  const [customAoiLabel, setCustomAoiLabel] = useState<string | null>(null);
  const [aoi, setAoi] = useState<GeoJSONPolygon>(defaultPreset.polygon);
  const [flyToTarget, setFlyToTarget] = useState<{
    center: [number, number];
    zoom: number;
    seq: number;
  } | null>({
    center: defaultPreset.center,
    zoom: defaultPreset.zoom,
    seq: 1,
  });

  const [dateStart, setDateStart] = useState<string>("2005-01-01");
  const [dateEnd, setDateEnd] = useState<string>("2025-12-31");
  const [sensorMode, setSensorMode] = useState<SensorMode>("harmonized");

  // Bidirectional calendar -> map week filter state
  const [activeWeekRange, setActiveWeekRange] = useState<{
    start: string;
    end: string;
  } | null>(null);
  const [focusYear, setFocusYear] = useState<number>(2019);

  // API response state
  const [hexData, setHexData] = useState<SpatialHexDatum[]>([]);
  const [calendarSeries, setCalendarSeries] = useState<
    CalendarTimeSeriesPoint[]
  >([]);
  const [calendarSummary, setCalendarSummary] = useState<CalendarSummary>({
    critical_season_start: "06-16",
    critical_season_end: "09-28",
  });
  const [metadata, setMetadata] = useState<HealthMetadata>({});

  const [loadingMap, setLoadingMap] = useState<boolean>(false);
  const [loadingCalendar, setLoadingCalendar] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch backend health & calibration metadata once on mount
  useEffect(() => {
    fetchHealthMetadata()
      .then(setMetadata)
      .catch(() => {
        /* ignore health banner error if offline */
      });
  }, []);

  // Fetch Calendar time-series whenever AOI, global date range, or sensorMode changes
  useEffect(() => {
    const controller = new AbortController();
    setLoadingCalendar(true);
    setErrorMsg(null);

    fetchCalendarSeries(
      {
        aoi,
        date_start: dateStart,
        date_end: dateEnd,
        sensor_mode: sensorMode,
      },
      controller.signal
    )
      .then((res) => {
        setCalendarSeries(res.time_series);
        setCalendarSummary(res.summary);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setErrorMsg(err.message || "Failed to load calendar series");
        }
      })
      .finally(() => {
        setLoadingCalendar(false);
      });

    return () => controller.abort();
  }, [aoi, dateStart, dateEnd, sensorMode]);

  // Fetch Spatial H3 summary whenever AOI, sensorMode, global date range, or activeWeekRange changes
  useEffect(() => {
    const controller = new AbortController();
    setLoadingMap(true);

    const effectiveStart = activeWeekRange ? activeWeekRange.start : dateStart;
    const effectiveEnd = activeWeekRange ? activeWeekRange.end : dateEnd;

    fetchSpatialSummary(
      {
        aoi,
        date_start: effectiveStart,
        date_end: effectiveEnd,
        sensor_mode: sensorMode,
      },
      controller.signal
    )
      .then((res) => {
        setHexData(res.data);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setErrorMsg(err.message || "Failed to load spatial summary");
        }
      })
      .finally(() => {
        setLoadingMap(false);
      });

    return () => controller.abort();
  }, [aoi, dateStart, dateEnd, sensorMode, activeWeekRange]);

  // Handle preset change
  const handleSelectPreset = (presetId: string) => {
    const found = MALAYSIA_PRESET_AOIS.find((p) => p.id === presetId);
    if (!found) return;
    setSelectedPresetId(found.id);
    setCustomAoiLabel(null);
    setAoi(found.polygon);
    setFlyToTarget((prev) => ({
      center: found.center,
      zoom: found.zoom,
      seq: (prev?.seq || 0) + 1,
    }));
  };

  // Handle custom drawn AOI from MapView
  const handleCustomAoi = useCallback(
    (newAoi: GeoJSONPolygon, label?: string) => {
      setSelectedPresetId("custom");
      setCustomAoiLabel(label || "Custom Drawn AOI");
      setAoi(newAoi);
    },
    []
  );

  // Handle clicking a week cell in CalendarHeatmap
  const handleSelectCalendarWeek = useCallback(
    (
      weekStart: string | null,
      weekEnd: string | null,
      clickedYear?: number
    ) => {
      if (clickedYear) {
        setFocusYear(clickedYear);
      }
      if (weekStart && weekEnd) {
        setActiveWeekRange({ start: weekStart, end: weekEnd });
      } else {
        setActiveWeekRange(null);
      }
    },
    []
  );

  // Compute top-level KPI metrics
  const kpiStats = useMemo(() => {
    const totalFires = hexData.reduce((acc, h) => acc + h.total_fires, 0);
    const weightedFrp = hexData.reduce(
      (acc, h) => acc + h.mean_frp * h.total_fires,
      0
    );
    const avgFrp = totalFires > 0 ? weightedFrp / totalFires : 0;

    let anomalyWeeks = 0;
    let peakAnomaly: CalendarTimeSeriesPoint | null = null;
    for (const pt of calendarSeries) {
      if (pt.is_anomaly) {
        anomalyWeeks += 1;
        if (!peakAnomaly || pt.z_score > peakAnomaly.z_score) {
          peakAnomaly = pt;
        }
      }
    }

    return {
      totalFires,
      activeHexCount: hexData.length,
      avgFrp,
      anomalyWeeks,
      peakAnomaly,
    };
  }, [hexData, calendarSeries]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Top Mission Control Navigation & Filter Bar */}
      <header className="border-b border-slate-800/90 bg-slate-900/80 backdrop-blur-md px-4 py-2.5 sticky top-0 z-30">
        <div className="max-w-[1800px] mx-auto flex flex-wrap items-center justify-between gap-3">
          {/* Brand Title */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-500 via-orange-600 to-rose-600 flex items-center justify-center shadow-lg shadow-orange-500/20">
              <Flame className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-white">
                  FIRMS Harmonizer
                </h1>
                <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                  NASA Space Apps 2026
                </span>
                {metadata.calibration_alpha_count && (
                  <span className="hidden xl:inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-sky-300 border border-slate-700">
                    α = {metadata.calibration_alpha_count.toFixed(2)}x
                    VIIRS/MODIS
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">
                Multi-Decade MODIS (1km) &amp; VIIRS (375m) Active Fire
                Harmonization &amp; Burning Activity Calendar
              </p>
            </div>
          </div>

          {/* Right Controls: AOI Preset, Date Range, and Sensor Mode Toggle */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Malaysian Region Preset Selector */}
            <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5">
              <MapPin className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <select
                value={selectedPresetId}
                onChange={(e) => handleSelectPreset(e.target.value)}
                className="bg-transparent text-xs font-medium text-slate-100 focus:outline-none cursor-pointer"
              >
                {MALAYSIA_PRESET_AOIS.map((preset) => (
                  <option
                    key={preset.id}
                    value={preset.id}
                    className="bg-slate-900 text-slate-100"
                  >
                    {preset.name}
                  </option>
                ))}
                {customAoiLabel && (
                  <option
                    value="custom"
                    className="bg-slate-900 text-amber-300"
                  >
                    ★ {customAoiLabel}
                  </option>
                )}
              </select>
            </div>

            {/* Date Range Inputs */}
            <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1 text-xs">
              <CalendarRange className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <input
                type="date"
                value={dateStart}
                min="2005-01-01"
                max={dateEnd}
                onChange={(e) => {
                  setActiveWeekRange(null);
                  setDateStart(e.target.value);
                }}
                className="bg-transparent text-slate-200 font-mono text-xs focus:outline-none"
              />
              <span className="text-slate-500">→</span>
              <input
                type="date"
                value={dateEnd}
                min={dateStart}
                max="2025-12-31"
                onChange={(e) => {
                  setActiveWeekRange(null);
                  setDateEnd(e.target.value);
                }}
                className="bg-transparent text-slate-200 font-mono text-xs focus:outline-none"
              />
            </div>

            {/* Sensor Mode Segmented Control */}
            <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-1 text-xs">
              <button
                type="button"
                onClick={() => setSensorMode("harmonized")}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md font-semibold transition-all ${
                  sensorMode === "harmonized"
                    ? "bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Harmonized</span>
              </button>
              <button
                type="button"
                onClick={() => setSensorMode("modis")}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium transition-all ${
                  sensorMode === "modis"
                    ? "bg-sky-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Satellite className="w-3.5 h-3.5" />
                <span>Raw MODIS (1km)</span>
              </button>
              <button
                type="button"
                onClick={() => setSensorMode("viirs")}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium transition-all ${
                  sensorMode === "viirs"
                    ? "bg-emerald-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Radio className="w-3.5 h-3.5" />
                <span>Raw VIIRS (375m)</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Error Banner if API unreachable */}
      {errorMsg && (
        <div className="bg-rose-950/90 border-b border-rose-700 px-4 py-2 text-xs text-rose-200 flex items-center justify-between">
          <span>API Warning: {errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="underline hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Content Container */}
      <main className="flex-1 max-w-[1800px] w-full mx-auto px-4 py-3 flex flex-col gap-3">
        {/* KPI Summary Ribbon */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between">
            <div>
              <div className="text-[11px] text-slate-400 font-medium">
                {activeWeekRange
                  ? `Hotspots (${activeWeekRange.start})`
                  : "Total Active Hotspots"}
              </div>
              <div className="text-lg font-bold text-amber-400 font-mono">
                {kpiStats.totalFires.toLocaleString()}
              </div>
            </div>
            <Flame className="w-5 h-5 text-amber-500/70" />
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between">
            <div>
              <div className="text-[11px] text-slate-400 font-medium">
                Active H3 Hexagons (Res 8)
              </div>
              <div className="text-lg font-bold text-sky-400 font-mono">
                {kpiStats.activeHexCount.toLocaleString()}
              </div>
            </div>
            <Hexagon className="w-5 h-5 text-sky-500/70" />
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between">
            <div>
              <div className="text-[11px] text-slate-400 font-medium">
                Mean Radiative Power
              </div>
              <div className="text-lg font-bold text-orange-400 font-mono">
                {kpiStats.avgFrp.toFixed(1)}{" "}
                <span className="text-xs font-normal text-slate-400">MW</span>
              </div>
            </div>
            <Zap className="w-5 h-5 text-orange-500/70" />
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between">
            <div>
              <div className="text-[11px] text-slate-400 font-medium">
                Critical Fire Season (MM-DD)
              </div>
              <div className="text-base font-bold text-emerald-400 font-mono">
                {calendarSummary.critical_season_start} →{" "}
                {calendarSummary.critical_season_end}
              </div>
            </div>
            <CalendarRange className="w-5 h-5 text-emerald-500/70" />
          </div>

          <div className="col-span-2 md:col-span-1 bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between">
            <div>
              <div className="text-[11px] text-slate-400 font-medium">
                Anomaly Weeks (Z &gt; 2.0)
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-bold text-rose-400 font-mono">
                  {kpiStats.anomalyWeeks}
                </span>
                {kpiStats.peakAnomaly && (
                  <span className="text-[11px] text-slate-400 font-mono">
                    Peak: {kpiStats.peakAnomaly.date} (+
                    {kpiStats.peakAnomaly.z_score.toFixed(1)}σ)
                  </span>
                )}
              </div>
            </div>
            <AlertOctagon className="w-5 h-5 text-rose-500/70" />
          </div>
        </div>

        {/* Main Split Workspace: Left Interactive Map (50%) | Right Calendar & Climatology (50%) */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 min-h-[640px]">
          {/* Left Column: Component 3 Interactive Map UI */}
          <div className="lg:col-span-6 h-[460px] lg:h-auto flex flex-col">
            <MapView
              hexData={hexData}
              aoi={aoi}
              onChangeAoi={handleCustomAoi}
              sensorMode={sensorMode}
              flyToTarget={flyToTarget}
              activeWeekRange={activeWeekRange}
              onClearWeekFilter={() => setActiveWeekRange(null)}
              loading={loadingMap || loadingCalendar}
            />
          </div>

          {/* Right Column: Component 4 Burning Activity Calendar & Seasonal Climatology */}
          <div className="lg:col-span-6 flex flex-col gap-3">
            <div className="flex-[1.25] min-h-[280px]">
              <CalendarHeatmap
                timeSeries={calendarSeries}
                summary={calendarSummary}
                sensorMode={sensorMode}
                selectedWeekStart={activeWeekRange?.start || null}
                onSelectWeek={handleSelectCalendarWeek}
              />
            </div>

            <div className="flex-1 min-h-[235px]">
              <ClimatologyChart
                timeSeries={calendarSeries}
                summary={calendarSummary}
                focusYear={focusYear}
                onChangeFocusYear={setFocusYear}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
