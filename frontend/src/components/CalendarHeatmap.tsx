import React, { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { Calendar, Flame, RotateCcw, Sparkles } from "lucide-react";
import { CalendarSummary, CalendarTimeSeriesPoint, SensorMode } from "../types/api";

interface CalendarHeatmapProps {
  timeSeries: CalendarTimeSeriesPoint[];
  summary: CalendarSummary;
  sensorMode: SensorMode;
  selectedWeekStart: string | null;
  onSelectWeek: (
    weekStart: string | null,
    weekEnd: string | null,
    focusYear?: number
  ) => void;
}

const MONTH_APPROX_LABELS: Record<number, string> = {
  1: "Jan",
  5: "Feb",
  9: "Mar",
  14: "Apr",
  18: "May",
  22: "Jun",
  27: "Jul",
  31: "Aug",
  36: "Sep",
  40: "Oct",
  44: "Nov",
  49: "Dec",
};

function getIsoYearAndWeek(dateStr: string): { year: number; week: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.min(
    52,
    Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  );
  return { year: dt.getUTCFullYear(), week: weekNo };
}

function addSixDays(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 6));
  return dt.toISOString().slice(0, 10);
}

export const CalendarHeatmap: React.FC<CalendarHeatmapProps> = ({
  timeSeries,
  summary,
  sensorMode,
  selectedWeekStart,
  onSelectWeek,
}) => {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<echarts.ECharts | null>(null);
  const [colorMetric, setColorMetric] = useState<"count" | "zscore">("count");

  const { years, weeks, cellMap, maxCount, anomalyPoints } = useMemo(() => {
    const yearSet = new Set<number>();
    const map = new Map<string, CalendarTimeSeriesPoint>();
    let highestCount = 50;
    const anomalies: [number, number, number][] = [];

    for (const pt of timeSeries) {
      const { year, week } = getIsoYearAndWeek(pt.date);
      yearSet.add(year);
      map.set(`${year}-${week}`, pt);
      if (pt.harmonized_count > highestCount) {
        highestCount = pt.harmonized_count;
      }
    }

    const sortedYears = Array.from(yearSet).sort((a, b) => a - b);
    const weekLabels = Array.from({ length: 52 }, (_, i) => i + 1);

    sortedYears.forEach((yr, yIdx) => {
      weekLabels.forEach((wk, xIdx) => {
        const pt = map.get(`${yr}-${wk}`);
        if (pt && pt.is_anomaly) {
          anomalies.push([xIdx, yIdx, pt.z_score]);
        }
      });
    });

    return {
      years: sortedYears,
      weeks: weekLabels,
      cellMap: map,
      maxCount: highestCount,
      anomalyPoints: anomalies,
    };
  }, [timeSeries]);

  useEffect(() => {
    if (!chartContainerRef.current) return;
    const chart = echarts.init(chartContainerRef.current, undefined, {
      renderer: "canvas",
    });
    chartInstanceRef.current = chart;

    const handleResize = () => chart.resize();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.dispose();
      chartInstanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartInstanceRef.current;
    if (!chart) return;

    const heatmapData: [number, number, number][] = [];

    years.forEach((yr, yIdx) => {
      weeks.forEach((wk, xIdx) => {
        const pt = cellMap.get(`${yr}-${wk}`) || null;
        const val = pt
          ? colorMetric === "count"
            ? pt.harmonized_count
            : pt.z_score
          : 0;
        heatmapData.push([xIdx, yIdx, val]);
      });
    });

    const option: echarts.EChartsOption = {
      backgroundColor: "transparent",
      tooltip: {
        position: "top",
        backgroundColor: "rgba(2, 6, 23, 0.95)",
        borderColor: "#334155",
        textStyle: { color: "#f8fafc", fontSize: 12 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formatter: (params: any) => {
          const valArr = params.value;
          if (!valArr) return "";
          const wkNum = weeks[valArr[0]];
          const yrNum = years[valArr[1]];
          const pt = cellMap.get(`${yrNum}-${wkNum}`) || null;
          if (!pt) {
            return `<div class="font-semibold text-slate-300">${yrNum} · Week ${wkNum}</div><div class="text-slate-400">No fire activity recorded</div>`;
          }
          const endDt = addSixDays(pt.date);
          const anomBadge = pt.is_anomaly
            ? `<span style="color:#fb7185;font-weight:700;">⚠ ANOMALY (Z = +${pt.z_score.toFixed(
                2
              )})</span>`
            : `<span style="color:#94a3b8;">Normal (Z = ${pt.z_score.toFixed(
                2
              )})</span>`;
          return `
            <div style="min-width:190px">
              <div style="font-weight:700;color:#38bdf8;margin-bottom:4px;">
                ${pt.date} → ${endDt} (W${String(wkNum).padStart(2, "0")})
              </div>
              <div style="display:flex;justify-content:space-between;gap:12px;">
                <span style="color:#cbd5e1;">Active Hotspots:</span>
                <strong style="color:#fbbf24;">${pt.harmonized_count.toLocaleString()}</strong>
              </div>
              <div style="display:flex;justify-content:space-between;gap:12px;">
                <span style="color:#cbd5e1;">Historical Mean:</span>
                <strong style="color:#e2e8f0;">${pt.historical_mean.toFixed(
                  1
                )}</strong>
              </div>
              <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e293b;">
                ${anomBadge}
              </div>
              <div style="margin-top:3px;font-size:10px;color:#64748b;">
                Click cell to filter map to this week
              </div>
            </div>
          `;
        },
      },
      grid: {
        top: 12,
        left: 44,
        right: 16,
        bottom: 26,
      },
      xAxis: {
        type: "category",
        data: weeks.map((w) => `W${String(w).padStart(2, "0")}`),
        splitArea: { show: false },
        axisLine: { lineStyle: { color: "#334155" } },
        axisTick: { show: false },
        axisLabel: {
          color: "#94a3b8",
          fontSize: 10,
          interval: 0,
          formatter: (_val: string, idx: number) => {
            const wk = idx + 1;
            return MONTH_APPROX_LABELS[wk] || "";
          },
        },
      },
      yAxis: {
        type: "category",
        data: years.map(String),
        splitArea: { show: false },
        axisLine: { lineStyle: { color: "#334155" } },
        axisTick: { show: false },
        axisLabel: {
          color: "#cbd5e1",
          fontSize: 10,
          fontFamily: "monospace",
        },
      },
      visualMap:
        colorMetric === "count"
          ? {
              min: 0,
              max: Math.max(15, Math.round(maxCount * 0.75)),
              calculable: false,
              show: false,
              inRange: {
                color: [
                  "#0f172a",
                  "#1e293b",
                  "#78350f",
                  "#d97706",
                  "#ea580c",
                  "#dc2626",
                  "#f43f5e",
                ],
              },
            }
          : {
              min: -1.0,
              max: 3.5,
              calculable: false,
              show: false,
              inRange: {
                color: [
                  "#0f172a",
                  "#1e293b",
                  "#334155",
                  "#f59e0b",
                  "#ef4444",
                  "#e11d48",
                ],
              },
            },
      series: [
        {
          name: "Burning Activity",
          type: "heatmap",
          data: heatmapData,
          itemStyle: {
            borderColor: "#020617",
            borderWidth: 1,
            borderRadius: 2,
          },
          emphasis: {
            itemStyle: {
              borderColor: "#38bdf8",
              borderWidth: 2,
            },
          },
        },
        {
          name: "Z > 2 Anomaly",
          type: "scatter",
          coordinateSystem: "cartesian2d",
          symbolSize: 5,
          data: anomalyPoints,
          itemStyle: {
            color: "#ffffff",
            borderColor: "#e11d48",
            borderWidth: 1.5,
          },
          silent: true,
        },
      ],
    };

    chart.setOption(option, true);

    chart.off("click");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chart.on("click", (params: any) => {
      const valArr = params.value;
      if (!valArr) return;
      const wkNum = weeks[valArr[0]];
      const yrNum = years[valArr[1]];
      const pt = cellMap.get(`${yrNum}-${wkNum}`) || null;
      if (!pt) return;

      if (selectedWeekStart === pt.date) {
        onSelectWeek(null, null, yrNum);
      } else {
        onSelectWeek(pt.date, addSixDays(pt.date), yrNum);
      }
    });
  }, [
    years,
    weeks,
    cellMap,
    maxCount,
    anomalyPoints,
    colorMetric,
    selectedWeekStart,
    onSelectWeek,
    sensorMode,
  ]);

  return (
    <div className="flex flex-col h-full bg-slate-900/90 border border-slate-800 rounded-xl p-3.5 shadow-xl">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-amber-400" />
          <div>
            <h2 className="text-sm font-semibold text-slate-100 leading-tight">
              Multi-Decade Burning Activity Calendar Matrix
            </h2>
            <p className="text-[11px] text-slate-400">
              Click any week cell to filter the spatial H3 grid · White dots mark{" "}
              <span className="text-rose-400 font-medium">
                Z-Score &gt; 2.0 anomalies ({anomalyPoints.length} weeks)
              </span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selectedWeekStart && (
            <button
              type="button"
              onClick={() => onSelectWeek(null, null)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Week: {selectedWeekStart}</span>
            </button>
          )}

          {/* Color Metric Switch */}
          <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setColorMetric("count")}
              className={`flex items-center gap-1 px-2 py-1 rounded-md font-medium transition-colors ${
                colorMetric === "count"
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Flame className="w-3 h-3" />
              <span>Fire Count</span>
            </button>
            <button
              type="button"
              onClick={() => setColorMetric("zscore")}
              className={`flex items-center gap-1 px-2 py-1 rounded-md font-medium transition-colors ${
                colorMetric === "zscore"
                  ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Sparkles className="w-3 h-3" />
              <span>Z-Score Anomaly</span>
            </button>
          </div>
        </div>
      </div>

      {/* ECharts Matrix Canvas */}
      <div className="relative flex-1 min-h-[195px] w-full">
        <div ref={chartContainerRef} className="w-full h-full" />
      </div>

      {/* Footer Legend */}
      <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800/80">
        <div>
          Critical Fire Season Window:{" "}
          <span className="text-amber-300 font-semibold font-mono">
            {summary.critical_season_start} to {summary.critical_season_end}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-white border border-rose-500" />
            Anomaly (Z &gt; 2.0)
          </span>
          <div className="flex items-center gap-1">
            <span>Low</span>
            <span className="w-3 h-2 rounded-sm bg-slate-800 inline-block" />
            <span className="w-3 h-2 rounded-sm bg-amber-700 inline-block" />
            <span className="w-3 h-2 rounded-sm bg-orange-500 inline-block" />
            <span className="w-3 h-2 rounded-sm bg-rose-500 inline-block" />
            <span>Peak</span>
          </div>
        </div>
      </div>
    </div>
  );
};
