/**
 * Powerpal-style live view: a 24-hour radial usage dial + time-of-use cost
 * strips for today and day-by-day history for the month to date.
 *
 * The dial's circumference is TIME — 6am at 12 o'clock, clockwise a full day
 * back to 6am, populated with TODAY's 15-minute buckets (midnight -> now; the
 * arc between "now" and midnight stays blank until tonight actually happens;
 * the needle marks "now").
 * Each 15-minute bar radiates from 0.4r to 0.85r with squared ends, its
 * length being the grid power used in that slot; hovering a bar shows its
 * time range, watts, kWh, ToU cost and solar. Grid bars are blue; solar
 * generation overlays the same annulus as green rays (length ∝ solar watts,
 * drawn underneath the bars). The centre shows the current watts only.
 * Amber ring arc = peak tariff (6am–midnight), blue arc = off-peak
 * (midnight–6am).
 *
 * Polling (while this tab is mounted): latest readings every 10 s, dial
 * history + cost strips every 60 s. The Charts view keeps its own pipeline.
 *
 * The Pi ingests once per minute, so "live" means "last completed minute";
 * the reading age is shown so the dial never overstates its freshness.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import type { EnergyOverviewPoint, ReadingOut, SolarReadingOut } from "../types";
import { ErrorBanner } from "./ErrorBanner";
import { melbourneHour, rateAt, summariseCost } from "../lib/tariff";
import type { CostTotal } from "../lib/tariff";
import { formatDollars, formatKwh, formatWattsShort } from "../lib/format";

const FAST_MS = 10_000;
const SLOW_MS = 60_000;
const DAY_MS = 24 * 3600_000;
/** Ingest silence longer than this turns the reading-age chip red. */
const STALE_MS = 10 * 60_000;

const ZONE_COLORS = { low: "#7fbb63", mid: "#e8a33d", high: "#d9534a" } as const;
type Zone = keyof typeof ZONE_COLORS;

/** Live-dial palette: grid bars blue, solar rays green (Ben's pick). */
const GRID_BLUE = "#4f8cff";
const SOLAR_GREEN = "#4ade80";

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
/** Bars radiate from 0.4r out to 0.85r with squared ends (no rounding). */
const BAR_R0 = 0.4 * RING_R;
const BAR_SPAN = 0.85 * RING_R - BAR_R0;

/** Linear scale to the day's peak: the longest bar reaches the full ring radius. */
function barRadius(w: number, dayMax: number): number {
  return BAR_R0 + (Math.max(0, Math.min(w, dayMax)) / dayMax) * BAR_SPAN;
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
  solar: number | null;
  kwh: number;
}

const slotTimeFmt = new Intl.DateTimeFormat("en-AU", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** Melbourne day key ("DD/MM/YYYY") — groups hourly buckets into local days. */
const melbDayKeyFmt = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** "Sat, 18 Oct"-style label on the Melbourne wall clock. */
const melbDayLabelFmt = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne",
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** One bar in the "This month" daily history card. */
interface DayBar {
  key: string;
  dayNum: number;
  label: string;
  kwh: number;
  cents: number;
  solarKwh: number | null;
  points: EnergyOverviewPoint[];
}

function UsageDial(props: {
  watts: number | null;
  petals: EnergyOverviewPoint[];
  sixAmMs: number;
  nowMs: number;
  dayMax: number;
  /** "today" (default): live dial with now-marker; "day": a completed past day. */
  mode?: "today" | "day";
  /** Day total kWh shown in the centre when mode === "day". */
  dayTotalKwh?: number | null;
}) {
  const { watts, petals, sixAmMs, nowMs, dayMax, mode = "today", dayTotalKwh = null } = props;
  const zone = zoneForWatts(watts);
  const colour = ZONE_COLORS[zone];
  const [hover, setHover] = useState<HoverSlot | null>(null);

  // Tooltip geometry: anchor at the hovered bar's tip, flip to keep it inside.
  let tip: React.ReactNode = null;
  if (hover) {
    const angle = dayAngle(new Date(hover.bucket).getTime(), sixAmMs);
    const [ax, ay] = polar(120, angle);
    const boxW = 170;
    const boxH = 84;
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
        <text x={bx + 10} y={by + 73} fontSize={12} fill={SOLAR_GREEN}>
          ☀ {hover.solar === null ? "—" : formatWattsShort(hover.solar)} solar
        </text>
      </g>
    );
  }

  return (
    <svg
      className="dial-svg"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={
        mode === "day"
          ? `Viewing a past day: ${dayTotalKwh === null ? "—" : formatKwh(dayTotalKwh)} of grid use; ring shows that day's 15-minute slots`
          : `Now using ${watts === null ? "unknown" : formatWattsShort(watts)}; ring shows today's usage so far`
      }
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

      {/* solar generation: green rays in the bars' annulus, length ∝ solar
          watts; rendered underneath the blue grid bars and never intercepting
          hover (the bars' wide invisible hit-lines own pointer events). Where
          a slot's green tip pokes past the blue bar, solar out-generated the
          grid draw in that slot. */}
      {(() => {
        const solarMax = Math.max(1000, ...petals.map((p) => p.avg_solar_watts ?? 0));
        return petals
          .map((p) => ({ p, s: p.avg_solar_watts }))
          .filter(({ s }) => s !== null && s > 0)
          .map(({ p, s }) => {
            const a = dayAngle(new Date(p.bucket).getTime(), sixAmMs);
            const len = BAR_R0 + (Math.min(s ?? 0, solarMax) / solarMax) * BAR_SPAN;
            const [x0, y0] = polar(BAR_R0, a);
            const [x1, y1] = polar(len, a);
            return (
              <line
                key={p.bucket}
                x1={x0}
                y1={y0}
                x2={x1}
                y2={y1}
                stroke={SOLAR_GREEN}
                strokeWidth={4}
                strokeLinecap="butt"
                opacity={0.95}
                pointerEvents="none"
              />
            );
          });
      })()}

      {/* backdrop fade BEHIND the bars — bars render at full opacity on top of it */}
      <circle cx={C} cy={C} r={50} fill="url(#centreFade)" pointerEvents="none" />

      {/* usage bars: circumference = time since 6am; each bar starts at 0.4r and its
          length is proportional to the watts in that 15-min slot (linear, day-peak
          normalized). Blue = grid draw; wide invisible hit-lines make hovering
          easy; zero-draw slots collapse to a nub at the bar base. */}
      {petals.map((p) => {
        if (p.avg_grid_watts === null || p.avg_grid_watts < 0) return null;
        const ms = new Date(p.bucket).getTime();
        const angle = dayAngle(ms, sixAmMs);
        const w = p.avg_grid_watts;
        const len = barRadius(w, dayMax);
        const [x0, y0] = polar(BAR_R0, angle);
        const [x1, y1] = polar(len, angle);
        const [hx0, hy0] = polar(0, angle);
        const [hx1, hy1] = polar(RING_R - 4, angle);
        const hovered = hover?.bucket === p.bucket;
        return (
          <g
            key={p.bucket}
            onMouseEnter={() =>
              setHover({ bucket: p.bucket, watts: w, solar: p.avg_solar_watts, kwh: p.consumed_kwh })
            }
            onMouseLeave={() => setHover((cur) => (cur?.bucket === p.bucket ? null : cur))}
          >
            <line
              x1={x0}
              y1={y0}
              x2={x1}
              y2={y1}
              stroke={hovered ? "#ffffff" : GRID_BLUE}
              strokeWidth={hovered ? 7 : 6}
              strokeLinecap="butt"
            />
            <line x1={hx0} y1={hy0} x2={hx1} y2={hy1} stroke="rgba(0,0,0,0)" strokeWidth={12} pointerEvents="stroke" />
          </g>
        );
      })}

      {/* now-marker on the time ring (live view only — a past day has no "now") */}
      {mode === "today"
        ? (() => {
            const a = dayAngle(nowMs, sixAmMs);
            const [x0, y0] = polar(112, a);
            const [x1, y1] = polar(132, a);
            return (
              <g pointerEvents="none">
                <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={colour} strokeWidth={3.5} strokeLinecap="round" />
                <circle cx={x1} cy={y1} r={3} fill={colour} />
              </g>
            );
          })()
        : null}

      {/* centre readout — live watts (today) or the viewed day's total kWh */}
      <g pointerEvents="none">
        <text
          x={C}
          y={C + 10}
          textAnchor="middle"
          fontSize={mode === "day" ? 27 : 38}
          fontWeight={700}
          fill={mode === "day" ? "#e8edf2" : watts === null ? "#93a1b0" : colour}
          stroke="rgba(13,18,26,0.9)"
          strokeWidth={5}
          paintOrder="stroke"
        >
          {mode === "day"
            ? dayTotalKwh === null
              ? "—"
              : formatKwh(dayTotalKwh)
            : watts === null
              ? "—"
              : formatWattsShort(watts)}
        </text>
        {mode === "day" ? (
          <text x={C} y={C + 30} textAnchor="middle" fontSize={10.5} fill="#93a1b0">
            used that day
          </text>
        ) : null}
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
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  /** 15-min buckets for the selected past day; null while loading / viewing live. */
  const [dayPetals, setDayPetals] = useState<EnergyOverviewPoint[] | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  /** Retry nonce for the selected-day fetch (bumped by Refresh). */
  const [dayRetry, setDayRetry] = useState(0);
  /** Past days never change — cache their 15-min fetches by day key. */
  const dayCache = useRef<Map<string, EnergyOverviewPoint[]>>(new Map());
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
        api.energyOverview({ from: midnight.toISOString(), to: now.toISOString(), bucket: "15m" }),
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
    if (selectedDay) {
      dayCache.current.delete(selectedDay);
      setDayRetry((n) => n + 1);
    }
  }, [fetchFast, fetchSlow, selectedDay]);

  const gridW = grid ? grid.average_watts : null;
  const solarW = solar ? solar.average_watts : null;
  const gridAgeMs = grid ? Date.now() - new Date(grid.time).getTime() : null;
  const rateNow = rateAt(new Date());
  const stale = gridAgeMs !== null && gridAgeMs > STALE_MS;
  const zone = zoneForWatts(gridW);

  const today = useMemo<CostTotal>(
    () => summariseCost(todayPts.map((p) => ({ bucket: p.bucket, kwh: p.consumed_kwh }))),
    [todayPts],
  );
  /** One bar per complete Melbourne day, 1st of month → yesterday (today is
      excluded until it completes). Cost is ToU-weighted per hour via
      summariseCost; solar kWh integrates the hourly avg watts (avg W × 1 h). */
  const days = useMemo<DayBar[]>(() => {
    const todayKey = melbDayKeyFmt.format(new Date());
    const byDay = new Map<string, EnergyOverviewPoint[]>();
    for (const p of monthPts) {
      const key = melbDayKeyFmt.format(new Date(p.bucket));
      if (key >= todayKey) continue; // today's partial day not shown yet
      const arr = byDay.get(key);
      if (arr) arr.push(p);
      else byDay.set(key, [p]);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, pts]) => {
        pts.sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
        const first = pts[0];
        const { kwh, cents } = summariseCost(
          pts.map((p) => ({ bucket: p.bucket, kwh: p.consumed_kwh })),
        );
        let solarWh: number | null = null;
        for (const p of pts) {
          if (p.avg_solar_watts !== null) solarWh = (solarWh ?? 0) + p.avg_solar_watts;
        }
        return {
          key,
          dayNum: Number(key.slice(0, 2)),
          label: first ? melbDayLabelFmt.format(new Date(first.bucket)) : key,
          kwh,
          cents,
          solarKwh: solarWh === null ? null : solarWh / 1000,
          points: pts,
        };
      });
  }, [monthPts]);
  const maxDayCents = Math.max(1, ...days.map((d) => d.cents));
  const selDay = selectedDay ? (days.find((d) => d.key === selectedDay) ?? null) : null;
  /** 24 hourly kWh slots for the selected day, keyed by Melbourne hour. */
  const selHours = useMemo<Array<number> | null>(() => {
    if (!selDay) return null;
    const hours = new Array<number>(24).fill(0);
    for (const p of selDay.points) hours[melbourneHour(new Date(p.bucket))] += p.consumed_kwh;
    return hours;
  }, [selDay]);
  const selHourMax = selHours ? Math.max(0.0001, ...selHours) : 1;

  /** Fetch (or take from cache) the selected day's 15-min buckets. */
  useEffect(() => {
    if (!selectedDay) {
      setDayPetals(null);
      return;
    }
    const cached = dayCache.current.get(selectedDay);
    if (cached) {
      setDayPetals(cached);
      return;
    }
    const [dd, mm, yyyy] = selectedDay.split("/").map(Number);
    if (!dd || !mm || !yyyy) return;
    const start = new Date(yyyy, mm - 1, dd); // Melbourne midnight (browser clock)
    const end = new Date(start.getTime() + DAY_MS);
    let cancelled = false;
    setDayLoading(true);
    api
      .energyOverview({ from: start.toISOString(), to: end.toISOString(), bucket: "15m" })
      .then((page) => {
        if (cancelled) return;
        dayCache.current.set(selectedDay, page.points);
        setDayPetals(page.points);
      })
      .catch(() => {
        /* keep whatever was shown; Refresh retries */
      })
      .finally(() => {
        if (!cancelled) setDayLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDay, dayRetry]);
  /** Day's peak draw — the dial scale pins to this so the longest bar reaches the ring. */
  const dayMax = useMemo(
    () => Math.max(1000, ...petals.map((p) => p.avg_grid_watts ?? 0)),
    [petals],
  );
  /** Scale for the dial when viewing a past day: that day's own peak. */
  const viewDayMax = useMemo(
    () =>
      selectedDay && dayPetals ? Math.max(1000, ...dayPetals.map((p) => p.avg_grid_watts ?? 0)) : dayMax,
    [selectedDay, dayPetals, dayMax],
  );

  return (
    <div className="live-wrap">
      {error ? <ErrorBanner error={error} onRetry={refetchAll} /> : null}

      <section className={"card dial-card" + (busy && loadedOnce ? " refreshing" : "")}>
        <div className="card-head">
          <h2>{selDay ? selDay.label : "Live — today so far"}</h2>
          <div className="dial-actions">
            <span className="muted">
              {selDay
                ? dayLoading
                  ? "loading 15-min slots…"
                  : "that day · tap the bar again or ↩ Live for today"
                : "blue = grid · green = solar · hover for numbers"}
            </span>
            {selDay ? (
              <button type="button" className="ghost" onClick={() => setSelectedDay(null)}>
                ↩ Live
              </button>
            ) : null}
            <button type="button" className="ghost" onClick={refetchAll}>
              ↻ Refresh
            </button>
          </div>
        </div>
        <div className="dial-wrap" data-zone={zone}>
          <UsageDial
            watts={gridW}
            petals={selDay ? (dayPetals ?? []) : petals}
            sixAmMs={sixAmMs}
            nowMs={Date.now()}
            dayMax={selDay ? viewDayMax : dayMax}
            mode={selDay ? "day" : "today"}
            dayTotalKwh={selDay ? selDay.kwh : null}
          />
        </div>
        <div className="dial-meta">
          {selDay ? (
            <>
              <span className="dial-solar">
                ☀ {selDay.solarKwh === null ? "—" : formatKwh(selDay.solarKwh)} solar that day
              </span>
              <span className="muted">peak {formatWattsShort(viewDayMax)}</span>
              <span className="dial-rate">{formatDollars(selDay.cents)} est. that day</span>
            </>
          ) : (
            <>
              <span className="dial-solar">☀ {solarW === null ? "—" : formatWattsShort(solarW)} solar now</span>
              <span className={"dial-age" + (stale ? " stale" : "")}>grid reading {humanAge(gridAgeMs)}</span>
              <span className="dial-rate">{rateNow} c/kWh right now</span>
            </>
          )}
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
            <h2>This month</h2>
            <span className="muted">daily ToU cost · tap a bar</span>
          </div>
          {days.length === 0 ? (
            <div className="day-empty">no complete days yet this month</div>
          ) : (
            <div className="day-bars">
              {days.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  className={"day-col" + (d.key === selectedDay ? " sel" : "")}
                  aria-pressed={d.key === selectedDay}
                  title={`${d.label} · ${formatKwh(d.kwh)} · ${formatDollars(d.cents)}`}
                  onClick={() => setSelectedDay((cur) => (cur === d.key ? null : d.key))}
                >
                  <span className="day-bar">
                    <span
                      className="day-bar-fill"
                      style={{ height: `${Math.max(3, (d.cents / maxDayCents) * 100)}%` }}
                    />
                  </span>
                  <span className="day-num">{d.dayNum}</span>
                </button>
              ))}
            </div>
          )}
          {selDay && selHours ? (
            <div className="day-detail">
              <div className="day-detail-head">
                <strong>{selDay.label}</strong>
                <span>{formatKwh(selDay.kwh)} used</span>
                <span>{formatDollars(selDay.cents)} est.</span>
                <span className="day-solar">
                  ☀ {selDay.solarKwh === null ? "—" : formatKwh(selDay.solarKwh)} solar
                </span>
              </div>
              <div className="day-hours">
                {selHours.map((kwh, h) => (
                  <span
                    key={h}
                    className={"day-hour" + (h < 6 ? " offpeak" : "")}
                    style={{ height: `${Math.max(4, (kwh / selHourMax) * 100)}%` }}
                    title={`${String(h).padStart(2, "0")}:00 · ${kwh.toFixed(2)} kWh`}
                  />
                ))}
              </div>
              <div className="day-detail-cap">
                hourly grid use · dim = off-peak 8c · bright = peak 27c · today joins when it
                completes
              </div>
            </div>
          ) : (
            <div className="day-detail">
              <div className="day-detail-cap">
                {days.length === 0 ? "data begins 12 Oct 2026" : "tap a bar to see the day's numbers"}
              </div>
            </div>
          )}
        </section>
      </div>

      <div className="tariff-note">
        Bars: blue, length ∝ grid power (normalised to today's peak); green rays
        underneath = solar; hover a bar for time, watts, kWh, cost and solar. ToU tariff
        estimates: 8 c/kWh 00:00–06:00 · 27 c/kWh 06:00–24:00 (Melbourne time) ·
        covers grid import only — solar self-consumption is free · supply charge &amp; network
        fees not included · the first recorded month is partial.
      </div>
    </div>
  );
}
