import React, { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import { Activity, AlertTriangle } from "lucide-react";
import { CalendarSummary, CalendarTimeSeriesPoint } from "../types/api";

interface ClimatologyChartProps {
  timeSeries: CalendarTimeSeriesPoint[];
  summary: CalendarSummary;
  focusYear: number;
  onChangeFocusYear: (yr: number) => void;
}

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

function mmddToApproxWeekIndex(mmdd: string): number {
  const parts = mmdd.split("-").map(Number);
  if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return 24;
  const dt = new Date(Date.UTC(2025, parts[0] - 1, parts[1]));
  const start = new Date(Date.UTC(2025, 0, 1));
  const doy = Math.floor((dt.getTime() - start.getTime()) / 86400000) + 1;
  return Math.max(0, Math.min(51, Math.floor((doy - 1) / 7)));
}

export const ClimatologyChart: React.FC<ClimatologyChartProps> = ({
  timeSeries,
  summary,
  focusYear,
  onChangeFocusYear,
}) => {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  const {
    availableYears,
    baselineByWeek,
    focusYearCounts,
    focusYearAnomalies,
  } = useMemo(() => {
    const yrs = new Set<number>();
    const base = new Array<number>(52).fill(0);
    const yrCounts = new Array<number>(52).fill(0);
    const yrAnoms: { weekIdx: number; value: number; z: number; date: string }[] =
      [];

    for (const pt of timeSeries) {
      const { year, week } = getIsoYearAndWeek(pt.date);
      yrs.add(year);
      const wIdx = Math.max(0, Math.min(51, week - 1));
      base[wIdx] = pt.historical_mean;
      if (year === focusYear) {
        yrCounts[wIdx] = pt.harmonized_count;
        if (pt.is_anomaly) {
          yrAnoms.push({
            weekIdx: wIdx,
            value: pt.harmonized_count,
            z: pt.z_score,
            date: pt.date,
          });
        }
      }
    }

    const sortedYears = Array.from(yrs).sort((a, b) => b - a);
    return {
      availableYears: sortedYears,
      baselineByWeek: base,
      focusYearCounts: yrCounts,
      focusYearAnomalies: yrAnoms,
    };
  }, [timeSeries, focusYear]);

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = echarts.init(chartRef.current, undefined, {
      renderer: "canvas",
    });
    instanceRef.current = chart;

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
      instanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = instanceRef.current;
    if (!chart) return;

    const weekCategories = Array.from(
      { length: 52 },
      (_, i) => `W${String(i + 1).padStart(2, "0")}`
    );
    const critStartIdx = mmddToApproxWeekIndex(summary.critical_season_start);
    const critEndIdx = mmddToApproxWeekIndex(summary.critical_season_end);

    const option: echarts.EChartsOption = {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(2, 6, 23, 0.95)",
        borderColor: "#334155",
        textStyle: { color: "#f8fafc", fontSize: 12 },
      },
      legend: {
        top: 0,
        right: 4,
        textStyle: { color: "#cbd5e1", fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
      },
      grid: {
        top: 28,
        left: 44,
        right: 14,
        bottom: 24,
      },
      xAxis: {
        type: "category",
        data: weekCategories,
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#334155" } },
        axisLabel: {
          color: "#94a3b8",
          fontSize: 10,
          interval: 7,
        },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#1e293b", type: "dashed" } },
        axisLabel: { color: "#94a3b8", fontSize: 10 },
      },
      series: [
        {
          name: "Historical Mean Baseline",
          type: "line",
          smooth: true,
          symbol: "none",
          data: baselineByWeek,
          lineStyle: {
            color: "#38bdf8",
            width: 2,
            type: "dashed",
          },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(56, 189, 248, 0.22)" },
              { offset: 1, color: "rgba(56, 189, 248, 0.02)" },
            ]),
          },
          markArea: {
            silent: true,
            itemStyle: {
              color: "rgba(245, 158, 11, 0.13)",
              borderColor: "rgba(245, 158, 11, 0.45)",
              borderWidth: 1,
              borderType: "dashed",
            },
            label: {
              show: true,
              position: "insideTop",
              color: "#fbbf24",
              fontSize: 10,
              fontWeight: "bold",
              formatter: `Critical Fire Season (${summary.critical_season_start} – ${summary.critical_season_end})`,
            },
            data: [
              [
                { xAxis: weekCategories[critStartIdx] },
                { xAxis: weekCategories[critEndIdx] },
              ],
            ],
          },
        },
        {
          name: `${focusYear} Weekly Activity`,
          type: "line",
          smooth: 0.25,
          symbol: "circle",
          symbolSize: 4,
          data: focusYearCounts,
          lineStyle: {
            color: "#f97316",
            width: 2.2,
          },
          itemStyle: {
            color: "#f97316",
          },
        },
        {
          name: "Z > 2 Anomaly Spike",
          type: "scatter",
          symbol: "diamond",
          symbolSize: 10,
          data: focusYearAnomalies.map((a) => [
            weekCategories[a.weekIdx],
            a.value,
          ]),
          itemStyle: {
            color: "#f43f5e",
            borderColor: "#ffffff",
            borderWidth: 1.5,
          },
        },
      ],
    };

    chart.setOption(option, true);
  }, [
    baselineByWeek,
    focusYearCounts,
    focusYearAnomalies,
    focusYear,
    summary,
  ]);

  return (
    <div className="flex flex-col h-full bg-slate-900/90 border border-slate-800 rounded-xl p-3.5 shadow-xl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-sky-400" />
          <div>
            <h2 className="text-sm font-semibold text-slate-100 leading-tight">
              Seasonal Climatology & Critical Fire Season
            </h2>
            <p className="text-[11px] text-slate-400">
              52-Week multi-decade normal baseline vs. selected year trajectory
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {focusYearAnomalies.length > 0 && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 text-[11px] font-medium">
              <AlertTriangle className="w-3 h-3" />
              {focusYearAnomalies.length} Anomaly Wks in {focusYear}
            </span>
          )}
          <label className="text-xs text-slate-400 flex items-center gap-1.5">
            <span>Inspect Year:</span>
            <select
              value={focusYear}
              onChange={(e) => onChangeFocusYear(Number(e.target.value))}
              className="bg-slate-950 border border-slate-700 text-slate-100 rounded-md px-2 py-1 text-xs font-mono focus:outline-none focus:border-sky-500"
            >
              {availableYears.map((yr) => (
                <option key={yr} value={yr}>
                  {yr}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* ECharts Line/Climatology Canvas */}
      <div className="relative flex-1 min-h-[165px] w-full">
        <div ref={chartRef} className="w-full h-full" />
      </div>
    </div>
  );
};
