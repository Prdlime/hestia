import React from "react";

const MONTH_LABELS = [
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

interface DatePartsSelectProps {
  /** Selected date as YYYY-MM-DD. */
  value: string;
  /** Earliest selectable date, YYYY-MM-DD. */
  min: string;
  /** Latest selectable date, YYYY-MM-DD. */
  max: string;
  onChange: (next: string) => void;
  /** Used for the accessible names, e.g. "Playback start". */
  label: string;
}

function parseParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map((part) => Number(part));
  return [y || 2000, m || 1, d || 1];
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function toIso(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

const selectClass =
  "appearance-none bg-transparent text-slate-200 font-sans tabular-nums text-[11px] " +
  "px-1 py-0.5 rounded cursor-pointer hover:bg-slate-800/70 focus:outline-none " +
  "focus:ring-1 focus:ring-sky-500/50";

/**
 * Date entry as three dropdowns (day, month, year) instead of a pop-up calendar.
 * Any choice is kept inside [min, max]; a day that does not exist in the chosen
 * month (31 → February) falls back to that month's last day.
 */
export const DatePartsSelect: React.FC<DatePartsSelectProps> = ({
  value,
  min,
  max,
  onChange,
  label,
}) => {
  const [year, month, day] = parseParts(value);
  const [minYear] = parseParts(min);
  const [maxYear] = parseParts(max);

  const years: number[] = [];
  for (let y = Math.min(minYear, year); y <= Math.max(maxYear, year); y++) {
    years.push(y);
  }
  const dayCount = daysInMonth(year, month);

  const commit = (nextYear: number, nextMonth: number, nextDay: number) => {
    const safeDay = Math.min(nextDay, daysInMonth(nextYear, nextMonth));
    let next = toIso(nextYear, nextMonth, safeDay);
    // ISO dates compare correctly as plain strings.
    if (next < min) next = min;
    if (next > max) next = max;
    if (next !== value) onChange(next);
  };

  return (
    <div className="flex items-center">
      <select
        aria-label={`${label} day`}
        value={day}
        onChange={(e) => commit(year, month, Number(e.target.value))}
        className={selectClass}
      >
        {Array.from({ length: dayCount }, (_, i) => i + 1).map((d) => (
          <option key={d} value={d} className="bg-slate-900 text-slate-200">
            {String(d).padStart(2, "0")}
          </option>
        ))}
      </select>
      <select
        aria-label={`${label} month`}
        value={month}
        onChange={(e) => commit(year, Number(e.target.value), day)}
        className={selectClass}
      >
        {MONTH_LABELS.map((name, i) => (
          <option key={name} value={i + 1} className="bg-slate-900 text-slate-200">
            {name}
          </option>
        ))}
      </select>
      <select
        aria-label={`${label} year`}
        value={year}
        onChange={(e) => commit(Number(e.target.value), month, day)}
        className={selectClass}
      >
        {years.map((y) => (
          <option key={y} value={y} className="bg-slate-900 text-slate-200">
            {y}
          </option>
        ))}
      </select>
    </div>
  );
};
