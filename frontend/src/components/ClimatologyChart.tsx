import React, { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import { Activity, AlertTriangle } from "lucide-react";
import { Timescale, TrendPoint } from "../types/api";
import { getCenteredWindowIndices } from "../utils/timeline";
import { InfoTooltip } from "./Tooltip";

interface ClimatologyChartProps {
  trendPoints: TrendPoint[];
  timescale: Timescale;
  activeSliceKey: string;
  onJumpToDate: (dateStr: string) => void;
  loading?: boolean;
}

const SUBTITLE_BY_TIMESCALE: Record<Timescale, string> = {
  daily: "Daily fire activity (~50 days centered on active day) — click chart to jump",
  weekly: "Weekly fire activity (~50 weeks centered on active week) — click chart to jump",
  monthly: "Monthly fire activity centered on active month — click chart to jump",
  yearly: "Annual fire activity across dataset timeline — click chart to jump",
  "5y": "5-year interval fire activity — click chart to jump",
  "10y": "10-year interval fire activity — click chart to jump",
};

export const ClimatologyChart: React.FC<ClimatologyChartProps> = ({
  trendPoints,
  timescale,
  activeSliceKey,
  onJumpToDate,
  loading,
}) => {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  const { visiblePoints, activeVisibleIdx, anomalies, windowSpanLabel } =
    useMemo(() => {
      if (!trendPoints.length) {
        return {
          visiblePoints: [] as TrendPoint[],
          activeVisibleIdx: -1,
          anomalies: [] as { idx: number; pt: TrendPoint }[],
          windowSpanLabel: "",
        };
      }

      let rawActiveIdx = trendPoints.findIndex(
        (p) => p.slice_start === activeSliceKey
      );
      if (rawActiveIdx === -1) {
        rawActiveIdx = trendPoints.findIndex(
          (p) =>
            p.slice_start <= activeSliceKey && activeSliceKey <= p.slice_end
        );
      }
      if (rawActiveIdx === -1) {
        rawActiveIdx = trendPoints.length - 1;
      }

      const { startIdx, endIdx } = getCenteredWindowIndices(
        trendPoints.length,
        rawActiveIdx,
        timescale
      );
      const sliced = trendPoints.slice(startIdx, endIdx + 1);
      const localActiveIdx = rawActiveIdx - startIdx;

      const anomList: { idx: number; pt: TrendPoint }[] = [];
      sliced.forEach((pt, idx) => {
        if (pt.is_anomaly) {
          anomList.push({ idx, pt });
        }
      });

      const first = sliced[0];
      const last = sliced[sliced.length - 1];
      const span =
        first && last
          ? first.slice_start === last.slice_end
            ? first.slice_start
            : `${first.label} – ${last.label}`
          : "";

      return {
        visiblePoints: sliced,
        activeVisibleIdx: localActiveIdx,
        anomalies: anomList,
        windowSpanLabel: span,
      };
    }, [trendPoints, activeSliceKey, timescale]);

  const visiblePointsRef = useRef<TrendPoint[]>(visiblePoints);
  visiblePointsRef.current = visiblePoints;
  const onJumpRef = useRef(onJumpToDate);
  onJumpRef.current = onJumpToDate;

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = echarts.init(chartRef.current, undefined, {
      renderer: "canvas",
    });
    instanceRef.current = chart;

    const zr = chart.getZr();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleCanvasClick = (params: any) => {
      const pointInPixel = [params.offsetX, params.offsetY];
      if (!chart.containPixel({ seriesIndex: 0 }, pointInPixel)) return;
      const pointInGrid = chart.convertFromPixel({ seriesIndex: 0 }, pointInPixel);
      if (!pointInGrid) return;
      const idx = Math.round(pointInGrid[0]);
      const pts = visiblePointsRef.current;
      if (idx >= 0 && idx < pts.length) {
        onJumpRef.current(pts[idx].slice_start);
      }
    };
    zr.on("click", handleCanvasClick);

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      zr.off("click", handleCanvasClick);
      window.removeEventListener("resize", onResize);
      chart.dispose();
      instanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = instanceRef.current;
    if (!chart) return;

    const categories = visiblePoints.map((p) => p.label);
    const counts = visiblePoints.map((p) => p.count);
    const baselines = visiblePoints.map((p) => p.historical_mean);
    const activePt =
      activeVisibleIdx >= 0 && activeVisibleIdx < visiblePoints.length
        ? visiblePoints[activeVisibleIdx]
        : null;

    const manyPoints = visiblePoints.length > 15;
    const xInterval =
      visiblePoints.length > 35
        ? 6
        : visiblePoints.length > 14
        ? 2
        : 0;

    const option: echarts.EChartsOption = {
      backgroundColor: "transparent",
      animationDurationUpdate: 180,
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(2, 6, 23, 0.95)",
        borderColor: "#334155",
        textStyle: { color: "#f8fafc", fontSize: 12 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formatter: (params: any) => {
          const firstParam = Array.isArray(params) ? params[0] : params;
          const idx = firstParam?.dataIndex;
          const pt =
            typeof idx === "number" ? visiblePointsRef.current[idx] : null;
          if (!pt) return "";

          const dateHeader =
            pt.slice_start === pt.slice_end
              ? pt.slice_start
              : `${pt.slice_start} → ${pt.slice_end}`;
          const anomBadge = pt.is_anomaly
            ? `<div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e293b;color:#fb7185;font-weight:700;">⚠ Unusual Activity (Z: +${pt.z_score.toFixed(
                2
              )})</div>`
            : "";

          return `
            <div style="min-width:190px">
              <div style="font-weight:700;color:#38bdf8;margin-bottom:4px;">
                ${pt.label} <span style="color:#94a3b8;font-weight:400;font-size:11px;">(${dateHeader})</span>
              </div>
              <div style="display:flex;justify-content:space-between;gap:12px;">
                <span style="color:#cbd5e1;">Active Hotspots:</span>
                <strong style="color:#f97316;">${pt.count.toLocaleString()}</strong>
              </div>
              <div style="display:flex;justify-content:space-between;gap:12px;">
                <span style="color:#cbd5e1;">Historical Average:</span>
                <strong style="color:#38bdf8;">${pt.historical_mean.toLocaleString(
                  undefined,
                  { maximumFractionDigits: 1 }
                )}</strong>
              </div>
              ${anomBadge}
              <div style="margin-top:4px;font-size:10px;color:#64748b;">
                Click chart to jump timeline here
              </div>
            </div>
          `;
        },
      },
      legend: {
        top: 0,
        right: 4,
        textStyle: { color: "#cbd5e1", fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
      },
      grid: {
        top: 38,
        left: 52,
        right: 16,
        bottom: 24,
      },
      xAxis: {
        type: "category",
        data: categories,
        boundaryGap: visiblePoints.length <= 2,
        axisLine: { lineStyle: { color: "#334155" } },
        axisLabel: {
          color: "#94a3b8",
          fontSize: 10,
          interval: xInterval,
        },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#1e293b", type: "dashed" } },
        axisLabel: { color: "#94a3b8", fontSize: 10 },
      },
      series: [
        {
          name: "Historical Average",
          type: "line",
          smooth: true,
          symbol: "none",
          data: baselines,
          lineStyle: {
            color: "#38bdf8",
            width: 2,
            type: "dashed",
          },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(56, 189, 248, 0.18)" },
              { offset: 1, color: "rgba(56, 189, 248, 0.02)" },
            ]),
          },
        },
        {
          name: "Observed Activity",
          type: "line",
          smooth: manyPoints ? 0.2 : false,
          symbol: "circle",
          symbolSize: visiblePoints.length <= 12 ? 7 : 4,
          data: counts,
          lineStyle: {
            color: "#f97316",
            width: 2.2,
          },
          itemStyle: {
            color: "#f97316",
          },
          markLine: activePt
            ? {
                symbol: ["none", "none"],
                silent: true,
                animation: false,
                lineStyle: {
                  color: "#fbbf24",
                  width: 1.5,
                  type: "solid",
                },
                label: {
                  show: true,
                  position: "end",
                  distance: 4,
                  align:
                    activeVisibleIdx <= 3
                      ? "left"
                      : activeVisibleIdx >= visiblePoints.length - 4
                      ? "right"
                      : "center",
                  formatter: activePt.label,
                  color: "#fde68a",
                  backgroundColor: "rgba(15, 23, 42, 0.9)",
                  padding: [2, 5],
                  borderRadius: 3,
                  fontSize: 10,
                  fontWeight: "bold",
                },
                data: [{ xAxis: activeVisibleIdx }],
              }
            : undefined,
        },
        {
          name: "Active Slice",
          type: "scatter",
          symbol: "circle",
          symbolSize: 10,
          z: 6,
          data: activePt ? [[activeVisibleIdx, activePt.count]] : [],
          itemStyle: {
            color: "#fbbf24",
            borderColor: "#ffffff",
            borderWidth: 2,
          },
        },
        {
          name: "Anomaly Spike",
          type: "scatter",
          symbol: "diamond",
          symbolSize: 9,
          z: 5,
          data: anomalies.map((a) => [a.idx, a.pt.count]),
          itemStyle: {
            color: "#f43f5e",
            borderColor: "#ffffff",
            borderWidth: 1.5,
          },
        },
      ],
    };

    chart.setOption(option, true);
  }, [visiblePoints, activeVisibleIdx, anomalies]);

  return (
    <div className="flex flex-col h-full bg-slate-900/90 border border-slate-800 rounded-xl p-3.5 shadow-xl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-sky-400" />
          <div>
            <div className="flex items-center gap-1.5">
              <h2 className="text-sm font-semibold text-slate-100 leading-tight">
                Burning Activity Trend
              </h2>
              <InfoTooltip
                position="top"
                align="left"
                content="Shows fire detections centered around the currently selected timeline slice on the chosen timescale (e.g., ~50 days centered on the active day), compared against the seasonal historical average. Click anywhere on the chart to jump the timeline."
              />
            </div>
            <p className="text-[11px] text-slate-400">
              {SUBTITLE_BY_TIMESCALE[timescale]}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {loading && (
            <span className="text-[11px] text-amber-400 animate-pulse">
              Loading...
            </span>
          )}
          {anomalies.length > 0 && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 text-[11px] font-medium">
              <AlertTriangle className="w-3 h-3" />
              {anomalies.length} Anomaly {anomalies.length === 1 ? "Pt" : "Pts"}
            </span>
          )}
          {windowSpanLabel && (
            <span className="bg-slate-950 border border-slate-800 text-sky-300 rounded-md px-2 py-1 text-[11px] font-mono">
              {windowSpanLabel}
            </span>
          )}
        </div>
      </div>

      {/* ECharts Canvas */}
      <div className="relative flex-1 min-h-[165px] w-full cursor-pointer">
        <div ref={chartRef} className="w-full h-full" />
      </div>
    </div>
  );
};
