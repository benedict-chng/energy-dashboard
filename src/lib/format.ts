/** Display formatting helpers (en-AU, Melbourne wall-clock via the browser). */

const integerFormatter = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 });
const fixed2 = new Intl.NumberFormat("en-AU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fixed3 = new Intl.NumberFormat("en-AU", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

export function formatWatts(watts: number | null | undefined): string {
  if (watts === null || watts === undefined || Number.isNaN(watts)) return "—";
  return `${integerFormatter.format(Math.round(watts))} W`;
}

export function formatKwh(kwh: number | null | undefined, digits: 2 | 3 = 2): string {
  if (kwh === null || kwh === undefined || Number.isNaN(kwh)) return "—";
  return `${(digits === 3 ? fixed3 : fixed2).format(kwh)} kWh`;
}

/** Axis ticks: kW above 1000 W, plain W below. */
export function axisWatts(watts: number): string {
  if (Math.abs(watts) >= 1000) return `${fixed2.format(watts / 1000)} kW`;
  return `${Math.round(watts)} W`;
}

/** Axis ticks for kWh values (unit shown in the legend, not every tick). */
export function axisKwh(kwh: number): string {
  if (Math.abs(kwh) >= 10) return `${Math.round(kwh)}`;
  return fixed2.format(kwh);
}

const clockFormatter = new Intl.DateTimeFormat("en-AU", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
export function formatClock(date: Date): string {
  return clockFormatter.format(date);
}

const tick24h = new Intl.DateTimeFormat("en-AU", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const tick7d = new Intl.DateTimeFormat("en-AU", {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** X-axis tick labels. Server buckets are UTC; rendered in local time. */
export function formatBucketLabel(ms: number, range: "24h" | "7d"): string {
  const date = new Date(ms);
  return range === "24h" ? tick24h.format(date) : tick7d.format(date);
}

export function formatBucketTooltip(ms: number): string {
  return new Date(ms).toLocaleString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
