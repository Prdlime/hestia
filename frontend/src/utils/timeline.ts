import type { Timescale } from "../types/api";

export interface TimescaleOption {
  id: Timescale;
  label: string;
}

export const TIMESCALE_OPTIONS: TimescaleOption[] = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
  { id: "yearly", label: "Yearly" },
  { id: "5y", label: "5-Year Interval" },
  { id: "10y", label: "10-Year Interval" },
];

export interface ActiveInterval {
  /** Exact unclipped bucket start matching backend TrendPoint.slice_start */
  key: string;
  /** Unclipped bucket bounds */
  rawStart: string;
  rawEnd: string;
  /** Clipped bounds inside [boundsStart, boundsEnd] for map spatial queries */
  start: string;
  end: string;
  /** Human-readable full interval label */
  label: string;
  /** Compact fixed-width-friendly label for header transport pill */
  shortLabel: string;
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function parseUTCDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y || 2025, (m || 1) - 1, d || 1));
}

export function formatUTCDate(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

export function addDays(dateStr: string, deltaDays: number): string {
  const dt = parseUTCDate(dateStr);
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return formatUTCDate(dt);
}

export function daysBetween(startStr: string, endStr: string): number {
  const s = parseUTCDate(startStr).getTime();
  const e = parseUTCDate(endStr).getTime();
  return Math.round((e - s) / 86400000);
}

export function clampDate(
  dateStr: string,
  minStr: string,
  maxStr: string
): string {
  if (!dateStr) return minStr;
  if (dateStr < minStr) return minStr;
  if (dateStr > maxStr) return maxStr;
  return dateStr;
}

function getRawBucket(
  anchorDate: string,
  timescale: Timescale
): { rawStart: string; rawEnd: string; bucketLabel: string } {
  const dt = parseUTCDate(anchorDate);
  const year = dt.getUTCFullYear();
  const monthIdx = dt.getUTCMonth(); // 0..11

  switch (timescale) {
    case "daily":
      return {
        rawStart: anchorDate,
        rawEnd: anchorDate,
        bucketLabel: anchorDate,
      };

    case "weekly": {
      const dow = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay(); // 1=Mon..7=Sun
      const mon = new Date(dt);
      mon.setUTCDate(dt.getUTCDate() - (dow - 1));
      const sun = new Date(mon);
      sun.setUTCDate(mon.getUTCDate() + 6);
      const rawStart = formatUTCDate(mon);
      const rawEnd = formatUTCDate(sun);
      return {
        rawStart,
        rawEnd,
        bucketLabel: `${rawStart} → ${rawEnd}`,
      };
    }

    case "monthly": {
      const startDt = new Date(Date.UTC(year, monthIdx, 1));
      const endDt = new Date(Date.UTC(year, monthIdx + 1, 0));
      return {
        rawStart: formatUTCDate(startDt),
        rawEnd: formatUTCDate(endDt),
        bucketLabel: `${MONTH_NAMES[monthIdx]} ${year}`,
      };
    }

    case "yearly":
      return {
        rawStart: `${year}-01-01`,
        rawEnd: `${year}-12-31`,
        bucketLabel: String(year),
      };

    case "5y": {
      const ep = Math.floor(year / 5) * 5;
      return {
        rawStart: `${ep}-01-01`,
        rawEnd: `${ep + 4}-12-31`,
        bucketLabel: `${ep}–${ep + 4}`,
      };
    }

    case "10y": {
      const ep = Math.floor(year / 10) * 10;
      return {
        rawStart: `${ep}-01-01`,
        rawEnd: `${ep + 9}-12-31`,
        bucketLabel: `${ep}–${ep + 9}`,
      };
    }
  }
}

function formatCompactWeek(startStr: string, endStr: string): string {
  const s = parseUTCDate(startStr);
  const e = parseUTCDate(endStr);
  const sMo = MONTH_NAMES[s.getUTCMonth()];
  const eMo = MONTH_NAMES[e.getUTCMonth()];
  const sDay = String(s.getUTCDate()).padStart(2, "0");
  const eDay = String(e.getUTCDate()).padStart(2, "0");
  const yrShort = String(s.getUTCFullYear()).slice(2);

  if (startStr === endStr) {
    return `${sMo} ${sDay} '${yrShort}`;
  }
  if (sMo === eMo && s.getUTCFullYear() === e.getUTCFullYear()) {
    return `${sMo} ${sDay}–${eDay} '${yrShort}`;
  }
  return `${sMo} ${sDay}–${eMo} ${eDay}`;
}

export function getIntervalForDate(
  anchorDate: string,
  timescale: Timescale,
  boundsStart: string,
  boundsEnd: string
): ActiveInterval {
  const safeAnchor = clampDate(anchorDate, boundsStart, boundsEnd);
  const { rawStart, rawEnd, bucketLabel } = getRawBucket(safeAnchor, timescale);
  const start = rawStart < boundsStart ? boundsStart : rawStart;
  const end = rawEnd > boundsEnd ? boundsEnd : rawEnd;

  let label = bucketLabel;
  let shortLabel = bucketLabel;
  if (timescale === "weekly") {
    label = start === end ? start : `${start} → ${end}`;
    shortLabel = formatCompactWeek(start, end);
  }

  return {
    key: rawStart,
    rawStart,
    rawEnd,
    start,
    end,
    label,
    shortLabel,
  };
}

export function stepAnchor(
  anchorDate: string,
  timescale: Timescale,
  delta: -1 | 1,
  boundsStart: string,
  boundsEnd: string
): string {
  const safeAnchor = clampDate(anchorDate, boundsStart, boundsEnd);
  const { rawStart } = getRawBucket(safeAnchor, timescale);
  const baseDt = parseUTCDate(rawStart);
  const y = baseDt.getUTCFullYear();
  const m = baseDt.getUTCMonth();

  let nextSeed: string;
  switch (timescale) {
    case "daily":
      nextSeed = addDays(rawStart, delta);
      break;
    case "weekly":
      nextSeed = addDays(rawStart, delta * 7);
      break;
    case "monthly": {
      const target = new Date(Date.UTC(y, m + delta, 1));
      nextSeed = formatUTCDate(target);
      break;
    }
    case "yearly":
      nextSeed = `${y + delta}-01-01`;
      break;
    case "5y":
      nextSeed = `${y + delta * 5}-01-01`;
      break;
    case "10y":
      nextSeed = `${y + delta * 10}-01-01`;
      break;
  }

  const nextBucket = getRawBucket(nextSeed, timescale);
  // Wrap cleanly within custom loop bounds
  if (nextBucket.rawStart > boundsEnd) {
    return boundsStart;
  }
  if (nextBucket.rawEnd < boundsStart) {
    return boundsEnd;
  }
  return clampDate(nextBucket.rawStart, boundsStart, boundsEnd);
}

export function countStepsInBounds(
  timescale: Timescale,
  boundsStart: string,
  boundsEnd: string
): number {
  const first = getRawBucket(boundsStart, timescale);
  const last = getRawBucket(boundsEnd, timescale);
  if (first.rawStart === last.rawStart) return 1;

  const sDt = parseUTCDate(first.rawStart);
  const eDt = parseUTCDate(last.rawStart);

  switch (timescale) {
    case "daily":
      return Math.max(1, daysBetween(first.rawStart, last.rawStart) + 1);
    case "weekly":
      return Math.max(
        1,
        Math.round(daysBetween(first.rawStart, last.rawStart) / 7) + 1
      );
    case "monthly":
      return Math.max(
        1,
        (eDt.getUTCFullYear() - sDt.getUTCFullYear()) * 12 +
          (eDt.getUTCMonth() - sDt.getUTCMonth()) +
          1
      );
    case "yearly":
      return Math.max(1, eDt.getUTCFullYear() - sDt.getUTCFullYear() + 1);
    case "5y":
      return Math.max(
        1,
        Math.floor((eDt.getUTCFullYear() - sDt.getUTCFullYear()) / 5) + 1
      );
    case "10y":
      return Math.max(
        1,
        Math.floor((eDt.getUTCFullYear() - sDt.getUTCFullYear()) / 10) + 1
      );
  }
}

export function getCenteredWindowIndices(
  totalPoints: number,
  activeIndex: number,
  timescale: Timescale
): { startIdx: number; endIdx: number } {
  if (totalPoints <= 0) return { startIdx: 0, endIdx: -1 };

  const targetSizeMap: Record<Timescale, number> = {
    daily: 51, // ~50 days centered on active day
    weekly: 51, // ~50 weeks (~1 year) centered on active week
    monthly: 49, // ~4 years centered on active month
    yearly: 25,
    "5y": totalPoints,
    "10y": totalPoints,
  };

  const windowSize = Math.min(targetSizeMap[timescale], totalPoints);
  const safeActive = Math.max(0, Math.min(totalPoints - 1, activeIndex));
  let startIdx = safeActive - Math.floor(windowSize / 2);
  if (startIdx < 0) startIdx = 0;
  if (startIdx + windowSize > totalPoints) {
    startIdx = Math.max(0, totalPoints - windowSize);
  }
  return { startIdx, endIdx: startIdx + windowSize - 1 };
}

export function getTrendFetchRange(
  anchorDate: string,
  timescale: Timescale,
  boundsStart: string,
  boundsEnd: string,
  dataMin: string,
  dataMax: string
): { start: string; end: string } {
  const overallMin = boundsStart < dataMin ? boundsStart : dataMin;
  const overallMax = boundsEnd > dataMax ? boundsEnd : dataMax;

  // Non-daily series or datasets <= 450 days fit trivially in a single cached query
  if (timescale !== "daily" || daysBetween(overallMin, overallMax) <= 450) {
    return { start: overallMin, end: overallMax };
  }

  // Multi-year daily view: fetch a +-180-day sliding cache buffer centered on cursor
  const chunkStart = addDays(anchorDate, -180);
  const chunkEnd = addDays(anchorDate, 180);
  return {
    start: chunkStart < overallMin ? overallMin : chunkStart,
    end: chunkEnd > overallMax ? overallMax : chunkEnd,
  };
}
