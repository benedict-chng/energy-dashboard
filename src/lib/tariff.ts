/**
 * Ben's time-of-use electricity tariff + cost maths for the Live view.
 *
 * Plan (confirmed 2026-10-18, c/kWh incl. GST), evaluated on MELBOURNE
 * wall-clock hours via ICU — independent of whatever timezone the viewing
 * device or test process happens to be in:
 *
 *   00:00–06:00 →  8 c/kWh  (off-peak)
 *   06:00–24:00 → 27 c/kWh  (peak)
 *
 * Hourly buckets from the server are UTC-hour aligned; Melbourne's UTC offset
 * is always a whole number of hours, so each 1h bucket falls entirely inside
 * one tariff window — rating a bucket by its start's Melbourne hour is exact.
 *
 * All money values here are CENTS (number). Use formatDollars() for display.
 */

export interface TariffWindow {
  /** Inclusive start hour (Melbourne local), 0–23. */
  startHour: number;
  /** Exclusive end hour, 1–24. */
  endHour: number;
  /** c/kWh incl. GST. */
  centsPerKwh: number;
  label: string;
}

export const TARIFF_WINDOWS: readonly TariffWindow[] = [
  { startHour: 0, endHour: 6, centsPerKwh: 8, label: "Off-peak" },
  { startHour: 6, endHour: 24, centsPerKwh: 27, label: "Peak" },
];

const melbourneHourFmt = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne",
  hour: "numeric",
  hourCycle: "h23",
});

/** 0–23: the hour of `date` on the Melbourne wall clock. */
export function melbourneHour(date: Date): number {
  return Number(melbourneHourFmt.format(date));
}

/** Applicable tariff window for an instant. */
export function windowAt(date: Date): TariffWindow {
  const h = melbourneHour(date);
  for (const w of TARIFF_WINDOWS) {
    if (h >= w.startHour && h < w.endHour) return w;
  }
  return TARIFF_WINDOWS[TARIFF_WINDOWS.length - 1];
}

/** c/kWh in force at an instant (Melbourne wall clock). */
export function rateAt(date: Date): number {
  return windowAt(date).centsPerKwh;
}

/** Cost of one bucket in CENTS, rated by the bucket start's Melbourne hour. */
export function bucketCents(kwh: number, bucketStartIso: string): number {
  return kwh * rateAt(new Date(bucketStartIso));
}

export interface CostTotal {
  kwh: number;
  cents: number;
}

export interface CostPoint {
  /** ISO 8601 bucket start (UTC). */
  bucket: string;
  /** Energy consumed in the bucket, kWh. */
  kwh: number;
}

/** Total kWh + ToU-weighted cents across a set of buckets. */
export function summariseCost(points: readonly CostPoint[]): CostTotal {
  let kwh = 0;
  let cents = 0;
  for (const p of points) {
    kwh += p.kwh;
    cents += bucketCents(p.kwh, p.bucket);
  }
  return { kwh, cents };
}

export interface MonthCost extends CostTotal {
  /** "YYYY-MM" (Melbourne calendar month of the buckets). */
  key: string;
  /** Short label, e.g. "Oct 2026". */
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Group hourly points into Melbourne calendar months, oldest first. */
export function costByMonth(points: readonly CostPoint[]): MonthCost[] {
  const groups = new Map<string, MonthCost>();
  for (const p of points) {
    const d = new Date(p.bucket);
    const y = d.getFullYear();
    const m = d.getMonth();
    const key = `${y}-${String(m + 1).padStart(2, "0")}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, label: `${MONTHS[m]} ${y}`, kwh: 0, cents: 0 };
      groups.set(key, g);
    }
    g.kwh += p.kwh;
    g.cents += bucketCents(p.kwh, p.bucket);
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}
