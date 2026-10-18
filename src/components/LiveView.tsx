/**
 * Powerpal-style live view: a 24-hour radial usage dial + time-of-use cost
 * strips for today and the months on record.
 *
 * The dial's circumference is TIME — 6am at 12 o'clock, clockwise a full day
 * back to 6am. Each 15-minute bar radiates from the CENTRE out to the time
 * ring, its length being the grid power used in that slot; hovering a bar
 * shows its time range, watts, kWh and ToU cost. The needle marks the current
 * time. Amber ring arc = peak tariff (6am–midnight), blue arc = off-peak
 * (midnight–6am).
 *
 * Polling (while this tab is mounted): latest readings every 10 s, dial
 * history + cost strips every 60 s. The Charts view keeps its own pipeline.
 *
 * The Pi ingests once per minute, so "live" means "last completed minute";
 * the reading age is shown so the dial never overstates its freshness.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../api/client";
import type { EnergyOverviewPoint, ReadingOut, SolarReadingOut } from "../types";
import { ErrorBanner } from "./ErrorBanner";
import { costByMonth, rateAt, summariseCost } from "../lib/tariff";
import type { CostTotal, MonthCost } from "../lib/tariff";
import { formatDollars, formatKwh, formatWattsShort } from "../lib/format";

const FAST_MS = 10_000;
const SLOW_MS = 60_000;
const DAY_MS = 24 * 3600_000;
/** Ingest silence longer than this turns the reading-age chip red. */
const STALE_MS = 10 * 60_000;

const ZONE_COLORS = { low: "#7fbb63", mid: "#e8a33d", high: "#d9534a" } as const;
type Zone = keyof typeof ZONE_COLORS;

function zoneForWatts(w: number | null): Zone {
  if (w === null || w < 500) return "low";
  if (w < 3000) return "mid";
  return "high";
}

function toApiError(reason: unknown): ApiError {
  if (reason instanceof ApiError) return reason;
  if (reason instanceof Error) return new ApiError(reason.message, 0);
  return new ApiError(String(reason), 0);
}

/** 404 on a *latest* endpoint just means "no data yet" — not an error. */
async function allow404<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

function humanAge(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/** The most recent 6am (Melbourne browser clock) at or before `now`. */
export function recentSixAm(now: Date): Date {
  const d = new Date(now);
  d.setHours(6, 0, 0, 0);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
  return d;
}

/* ----------------------------- dial geometry ----------------------------- */

const SIZE = 340;
const C = SIZE / 2;
const RING_R = 150;
/** Bars radiate from (nearly) the centre out to the time ring. */
const BAR_R0 = 2;
const BAR_SPAN = RING_R - BAR_R0 - 8;

/** Linear scale to the day's peak: the longest bar reaches the full ring radius. */
function barRadius(w: number, dayMax: number): number {
  return BAR_R0 + (Math.max(0, Math.min(w, dayMax)) / dayMax) * BAR_SPAN;
}

/** Bar colour by intensity — pops off the dark ring and encodes load level. */
function barColor(w: number): string {
  if (w < 100) return "#4f8cff";
  if (w < 400) return "#7fbb63";
  if (w < 1200) return "#e8c33d";
  if (w < 3000) return "#e8792f";
  return "#d9534a";
}

function polar(r: number, angleDeg: number): [number, number] {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(rad), C + r * Math.sin(rad)];
}

function arcPath(r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Clockwise angle from 12 o'clock for an instant, given the 6am day start. */
function dayAngle(ms: number, sixAmMs: number): number {
  return ((((ms - sixAmMs) % DAY_MS) + DAY_MS) % DAY_MS) * (360 / DAY_MS);
}

/** Ring labels every 3 hours, starting from 6am at the top. */
const HOUR_LABELS: ReadonlyArray<[number, string]> = [
  [6, "6am"],
  [9, "9am"],
  [12, "12pm"],
  [15, "3pm"],
  [18, "6pm"],
  [21, "9pm"],
  [0, "12am"],
  [3, "3am"],
];

interface HoverSlot {
  bucket: string;
  watts: number;
  kwh: number;
}

const slotTimeFmt = new Intl.DateTimeFormat("en-AU", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function UsageDial(props: {
  watts: number | null;
  centsPerHour: number | null;
  petals: EnergyOverviewPoint[];
  sixAmMs: number;
  nowMs: number;
  dayMax: number;
}) {
  const { watts, centsPerHour, petals, sixAmMs, nowMs, dayMax } = props;
  const zone = zoneForWatts(watts);
  const colour = ZONE_COLORS[zone];
  const [hover, setHover] = useState<HoverSlot | null>(null);

  // Tooltip geometry: anchor at the hovered bar's tip, flip to keep it inside.
  let tip: React.ReactNode = null;
  if (hover) {
    const angle = dayAngle(new Date(hover.bucket).getTime(), sixAmMs);
    const [ax, ay] = polar(120, angle);
    const boxW = 168;
    const boxH = 66;
    const bx = Math.max(2, Math.min(ax >= C ? ax + 10 : ax - boxW - 10, SIZE - boxW - 2));
    const by = Math.max(2, Math.min(ay - boxH / 2, SIZE - boxH - 2));
    const start = new Date(hover.bucket);
    const end = new Date(start.getTime() + 15 * 60_000);
    tip = (
      <g pointerEvents="none">
        <rect x={bx} y={by} width={boxW} height={boxH} rx={8} fill="rgba(13,18,26,0.96)" stroke="rgba(255,255,255,0.18)" />
        <text x={bx + 10} y={by + 18} fontSize={11} fill="#93a1b0">
          {slotTimeFmt.format(start)} – {slotTimeFmt.format(end)}
        </text>
        <text x={bx + 10} y={by + 37} fontSize={15} fontWeight={700} fill="#e8edf2">
          {formatWattsShort(hover.watts)}
        </text>
        <text x={bx + 10} y={by + 55} fontSize={12} fill="#c8d2dc">
          {hover.kwh.toFixed(2)} kWh · {(hover.kwh * rateAt(start)).toFixed(1)}c
        </text>
      </g>
    );
  }

  return (
    <svg
      className="dial-svg"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={`Now using ${watts === null ? "unknown" : formatWattsShort(watts)}; ring shows today's usage since 6am`}
    >
      <defs>
        {/* soft fade behind the centre readout so bars still radiate from the middle */}
        <radialGradient id="centreFade">
          <stop offset="0%" stopColor="rgba(13,18,26,0.92)" />
          <stop offset="60%" stopColor="rgba(13,18,26,0.55)" />
          <stop offset="100%" stopColor="rgba(13,18,26,0)" />
        </radialGradient>
      </defs>

      {/* base ring */}
      <circle cx={C} cy={C} r={RING_R} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
      {/* tariff arcs: peak 6am -> midnight (amber), off-peak midnight -> 6am (blue) */}
      <path d={arcPath(RING_R, 0.5, 269.5)} fill="none" stroke="#e8a33d" strokeWidth={5} opacity={0.30} strokeLinecap="butt" />
      <path d={arcPath(RING_R, 270.5, 359.5)} fill="none" stroke="#4f8cff" strokeWidth={5} opacity={0.30} strokeLinecap="butt" />
      {/* hour labels every 3 hours from 6am */}
      {HOUR_LABELS.map(([h, label]) => {
        const a = (((h - 6 + 24) % 24) / 24) * 360;
        const [x, y] = polar(134, a);
        return (
          <text key={label} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize={10.5} fill="#93a1b0">
            {label}
          </text>
        );
      })}
      {/* half-peak reference circle, labelled with its actual watt value */}
      <circle
        cx={C}
        cy={C}
        r={BAR_R0 + BAR_SPAN / 2}
        fill="none"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth={1}
        strokeDasharray="3 5"
      />
      <text x={C} y={C - (BAR_R0 + BAR_SPAN / 2) + 12} textAnchor="middle" fontSize={9} fill="#93a1b0">
        {formatWattsShort(dayMax / 2)}
      </text>

      {/* backdrop fade BEHIND the bars — bars render at full opacity on top of it */}
      <circle cx={C} cy={C} r={92} fill="url(#centreFade)" pointerEvents="none" />

      {/* usage bars: circumference = time since 6am, length = watts in that 15-min slot.
          Coloured by intensity so they pop off the dark ring; each bar owns a wide
          invisible hit-line so hovering is easy. Zero-draw slots show as short grey
          nubs so the day's arc is always visible. */}
      {petals.map((p) => {
        if (p.avg_grid_watts === null || p.avg_grid_watts < 0) return null;
        const ms = new Date(p.bucket).getTime();
        const angle = dayAngle(ms, sixAmMs);
        const w = p.avg_grid_watts;
        const zero = w === 0;
        const len = barRadius(w, dayMax);
        const [x0, y0] = polar(BAR_R0, angle);
        const [x1, y1] = polar(zero ? BAR_R0 + 5 : Math.max(len, BAR_R0 + 6), angle);
        const [hx0, hy0] = polar(0, angle);
        const [hx1, hy1] = polar(RING_R - 4, angle);
        const hovered = hover?.bucket === p.bucket;
        return (
          <g
            key={p.bucket}
            onMouseEnter={() =>
              setHover({ bucket: p.bucket, watts: w, kwh: p.consumed_kwh })
            }
            onMouseLeave={() => setHover((cur) => (cur?.bucket === p.bucket ? null : cur))}
          >
            <line
              x1={x0}
              y1={y0}
              x2={x1}
              y2={y1}
              stroke={hovered ? "#ffffff" : zero ? "rgba(255,255,255,0.22)" : barColor(w)}
              strokeWidth={hovered ? 7 : zero ? 3 : 6}
              strokeLinecap="round"
            />
            <line x1={hx0} y1={hy0} x2={hx1} y2={hy1} stroke="rgba(0,0,0,0)" strokeWidth={12} pointerEvents="stroke" />
          </g>
        );
      })}

      {/* now-marker on the time ring */}
      {(() => {
        const a = dayAngle(nowMs, sixAmMs);
        const [x0, y0] = polar(112, a);
        const [x1, y1] = polar(132, a);
        return (
          <g pointerEvents="none">
            <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={colour} strokeWidth={3.5} strokeLinecap="round" />
            <circle cx={x1} cy={y1} r={3} fill={colour} />
          </g>
        );
      })()}

      {/* centre readout */}
      <g pointerEvents="none">
        <text x={C} y={C - 40} textAnchor="middle" fontSize={12} fill="#93a1b0" letterSpacing={1}>
          now using
        </text>
        <text x={C} y={C + 6} textAnchor="middle" fontSize={38} fontWeight={700} fill={watts === null ? "#93a1b0" : colour} stroke="rgba(13,18,26,0.9)" strokeWidth={5} paintOrder="stroke">
          {watts === null ? "—" : formatWattsShort(watts)}
        </text>
        <text x={C} y={C + 36} textAnchor="middle" fontSize={19} fontWeight={600} fill="#e8edf2" stroke="rgba(13,18,26,0.9)" strokeWidth={4} paintOrder="stroke">
          {centsPerHour === null ? "—" : formatDollars(centsPerHour)}
        </text>
        <text x={C} y={C + 54} textAnchor="middle" fontSize={11} fill="#93a1b0">
          per hour
        </text>
      </g>

      {tip}
    </svg>
  );
}

export function LiveView() {
  const [grid, setGrid] = useState<ReadingOut | null>(null);
  const [solar, setSolar] = useState<SolarReadingOut | null>(null);
  const [petals, setPetals] = useState<EnergyOverviewPoint[]>([]);
  const [todayPts, setTodayPts] = useState<EnergyOverviewPoint[]>([]);
  const [monthPts, setMonthPts] = useState<EnergyOverviewPoint[]>([]);
  const [sixAmMs, setSixAmMs] = useState<number>(() => recentSixAm(new Date()).getTime());
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const fetchFast = useCallback(async () => {
    const [g, s] = await Promise.allSettled([
      allow404(api.latestGridReading()),
      allow404(api.latestSolarReading()),
    ]);
    if (g.status === "fulfilled") setGrid(g.value);
    if (s.status === "fulfilled") setSolar(s.value);
    const firstError =
      g.status === "rejected" ? toApiError(g.reason) : s.status === "rejected" ? toApiError(s.reason) : null;
    setError(firstError);
  }, []);

  const fetchSlow = useCallback(async () => {
    setBusy(true);
    try {
      const now = new Date();
      const sixAm = recentSixAm(now);
      // Cost day/month boundaries use the browser clock (Ben's devices are
      // all Melbourne); the tariff itself is Melbourne-correct via ICU.
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const [p, t, m] = await Promise.allSettled([
        api.energyOverview({ from: sixAm.toISOString(), to: now.toISOString(), bucket: "15m" }),
        api.energyOverview({ from: midnight.toISOString(), to: now.toISOString(), bucket: "1h" }),
        api.energyOverview({ from: monthStart.toISOString(), to: now.toISOString(), bucket: "1h" }),
      ]);
      if (p.status === "fulfilled") setPetals(p.value.points);
      if (t.status === "fulfilled") setTodayPts(t.value.points);
      if (m.status === "fulfilled") setMonthPts(m.value.points);
      setSixAmMs(sixAm.getTime());
      const firstError =
        p.status === "rejected"
          ? toApiError(p.reason)
          : t.status === "rejected"
            ? toApiError(t.reason)
            : m.status === "rejected"
              ? toApiError(m.reason)
              : null;
      setError(firstError);
      setLoadedOnce(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void fetchFast();
    void fetchSlow();
    const fast = window.setInterval(() => void fetchFast(), FAST_MS);
    const slow = window.setInterval(() => void fetchSlow(), SLOW_MS);
    return () => {
      window.clearInterval(fast);
      window.clearInterval(slow);
    };
  }, [fetchFast, fetchSlow]);

  const refetchAll = useCallback(() => {
    void fetchFast();
    void fetchSlow();
  }, [fetchFast, fetchSlow]);

  const gridW = grid ? grid.average_watts : null;
  const solarW = solar ? solar.average_watts : null;
  const gridAgeMs = grid ? Date.now() - new Date(grid.time).getTime() : null;
  const centsPerHour = gridW === null ? null : (gridW / 1000) * rateAt(new Date());
  const rateNow = rateAt(new Date());
  const stale = gridAgeMs !== null && gridAgeMs > STALE_MS;
  const zone = zoneForWatts(gridW);

  const today = useMemo<CostTotal>(
    () => summariseCost(todayPts.map((p) => ({ bucket: p.bucket, kwh: p.consumed_kwh }))),
    [todayPts],
  );
  const months = useMemo<MonthCost[]>(
    () => costByMonth(monthPts.map((p) => ({ bucket: p.bucket, kwh: p.consumed_kwh }))),
    [monthPts],
  );
  const maxMonthCents = Math.max(1, ...months.map((m) => m.cents));
  /** Day's peak draw — the dial scale pins to this so the longest bar reaches the ring. */
  const dayMax = useMemo(
    () => Math.max(1000, ...petals.map((p) => p.avg_grid_watts ?? 0)),
    [petals],
  );

  return (
    <div className="live-wrap">
      {error ? <ErrorBanner error={error} onRetry={refetchAll} /> : null}

      <section className={"card dial-card" + (busy && loadedOnce ? " refreshing" : "")}>
        <div className="card-head">
          <h2>Live — today since 6am</h2>
          <div className="dial-actions">
            <span className="muted">15-min bars · hover for numbers</span>
            <button type="button" className="ghost" onClick={refetchAll}>
              ↻ Refresh
            </button>
          </div>
        </div>
        <div className="dial-wrap" data-zone={zone}>
          <UsageDial
            watts={gridW}
            centsPerHour={centsPerHour}
            petals={petals}
            sixAmMs={sixAmMs}
            nowMs={Date.now()}
            dayMax={dayMax}
          />
        </div>
        <div className="dial-meta">
          <span className="dial-solar">☀ {solarW === null ? "—" : formatWattsShort(solarW)} solar now</span>
          <span className={"dial-age" + (stale ? " stale" : "")}>grid reading {humanAge(gridAgeMs)}</span>
          <span className="dial-rate">{rateNow} c/kWh right now</span>
        </div>
      </section>

      <div className="live-strips">
        <section className="card live-card">
          <div className="card-head">
            <h2>Today</h2>
            <span className="muted">ToU-weighted</span>
          </div>
          <div className="strip-row">
            <div className="strip-item">
              <span className="strip-big">{formatKwh(today.kwh)}</span>
              <span className="strip-sub">used</span>
            </div>
            <div className="strip-item">
              <span className="strip-big">{formatDollars(today.cents)}</span>
              <span className="strip-sub">est. cost</span>
            </div>
          </div>
        </section>
        <section className="card live-card">
          <div className="card-head">
            <h2>Monthly est.</h2>
            <span className="muted">{months.length === 1 ? "partial month" : "calendar months"}</span>
          </div>
          <div className="month-bars">
            {months.map((m) => (
              <div className="month-col" key={m.key}>
                <span className="month-val">{formatDollars(m.cents)}</span>
                <div className="month-bar">
                  <div
                    className="month-bar-fill"
                    style={{ height: `${Math.max(4, (m.cents / maxMonthCents) * 100)}%` }}
                  />
                </div>
                <span className="month-label">{m.label}</span>
              </div>
            ))}
            {months.length === 0 ? <span className="muted">no data yet</span> : null}
          </div>
        </section>
      </div>

      <div className="tariff-note">
        Bar colours: blue trickle · green low · yellow medium · orange high · red spike ·
        grey nub = zero draw. ToU tariff estimates: 8 c/kWh 00:00–06:00 · 27 c/kWh
        06:00–24:00 (Melbourne time) ·
        covers grid import only — solar self-consumption is free · supply charge &amp; network
        fees not included · the first recorded month is partial.
      </div>
    </div>
  );
}
