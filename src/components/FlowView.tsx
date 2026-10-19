/**
 * Flow view — a live, animated one-line diagram: solar panels, the grid
 * powerline and the house. Moving particles show the direction of current;
 * their speed, count and the wire thickness track real power (W).
 *
 * Colour language (matches the Live dial): blue = grid import, green = solar.
 * When the meter reads net export, green particles run house → grid instead.
 *
 * Polling: latest readings every 10 s (same freshness contract as Live);
 * today's kWh / ToU cost / solar kWh every 60 s.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../api/client";
import type { EnergyOverviewPoint, ReadingOut, SolarReadingOut } from "../types";
import { ErrorBanner } from "./ErrorBanner";
import { melbourneHour, summariseCost } from "../lib/tariff";
import type { CostTotal } from "../lib/tariff";
import { formatDollars, formatKwh, formatWattsShort } from "../lib/format";

const FAST_MS = 10_000;
const SLOW_MS = 60_000;
/** Ingest silence longer than this turns the reading-age chip red. */
const STALE_MS = 10 * 60_000;

const GRID_BLUE = "#4f8cff";
const SOLAR_GREEN = "#4ade80";
const INK = "#e8edf2";
const DIM = "rgba(255,255,255,0.10)";

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

/** Seconds for one end-to-end particle trip — more watts, faster trip. */
function flowDur(watts: number): number {
  if (watts <= 0) return 4;
  return Math.min(4, Math.max(1.2, 3000 / (watts + 300)));
}

/** Particle count per path — more watts, denser stream. */
function flowCount(watts: number): number {
  if (watts <= 0) return 0;
  return Math.min(7, Math.max(1, Math.round(Math.sqrt(watts / 150))));
}

/** Wire stroke width — more watts, fatter wire. */
function flowWidth(watts: number): number {
  if (watts <= 0) return 2.5;
  return Math.min(8, 2.5 + 5.5 * (1 - 1 / (1 + watts / 1200)));
}

/** A stream of particles riding one path, phase-staggered for a continuous flow. */
function ParticleStream(props: { pathId: string; watts: number; colour: string }) {
  const { pathId, watts, colour } = props;
  const n = flowCount(watts);
  const dur = flowDur(watts);
  if (n === 0) return null;
  return (
    <g className="flow-particles" filter="url(#flowGlow)">
      {Array.from({ length: n }, (_, i) => (
        <circle key={i} r={3.6} fill={colour} opacity={0.95}>
          <animateMotion
            dur={`${dur.toFixed(2)}s`}
            begin={`-${((i * dur) / n).toFixed(2)}s`}
            repeatCount="indefinite"
          >
            <mpath href={`#${pathId}`} />
          </animateMotion>
        </circle>
      ))}
    </g>
  );
}

export function FlowView() {
  const [grid, setGrid] = useState<ReadingOut | null>(null);
  const [solar, setSolar] = useState<SolarReadingOut | null>(null);
  const [todayPts, setTodayPts] = useState<EnergyOverviewPoint[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
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
    const now = new Date();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const res = await Promise.allSettled([
      api.energyOverview({ from: midnight.toISOString(), to: now.toISOString(), bucket: "1h" }),
    ]);
    if (res[0].status === "fulfilled") {
      setTodayPts(res[0].value.points);
      setLoadedOnce(true);
    }
    setError(res[0].status === "rejected" ? toApiError(res[0].reason) : null);
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

  // Net metering: grid watts are positive on import, negative on export; the
  // house draws whatever solar doesn't cover. No battery in this setup.
  const gridW = grid ? grid.average_watts : null;
  const solarW = solar ? solar.average_watts : null;
  const houseW = gridW === null && solarW === null ? null : Math.max(0, (solarW ?? 0) + (gridW ?? 0));
  const importFlow = Math.max(0, gridW ?? 0);
  const exportW = Math.max(0, -(gridW ?? 0));
  const solarWatts = solarW ?? 0;
  const solarToHouse = Math.min(solarWatts, houseW ?? 0);
  const solarDominant = solarToHouse >= importFlow;

  const today = useMemo<CostTotal>(
    () => summariseCost(todayPts.map((p) => ({ bucket: p.bucket, kwh: p.consumed_kwh }))),
    [todayPts],
  );
  const solarTodayKwh = useMemo(() => {
    let wh: number | null = null;
    for (const p of todayPts) {
      if (p.avg_solar_watts !== null) wh = (wh ?? 0) + p.avg_solar_watts; // avg W × 1 h
    }
    return wh === null ? null : wh / 1000;
  }, [todayPts]);

  const gridAgeMs = grid ? Date.now() - new Date(grid.time).getTime() : null;
  const stale = gridAgeMs !== null && gridAgeMs > STALE_MS;

  const status = (() => {
    if (gridW === null && solarW === null) return "Waiting for fresh meter data…";
    if (exportW > 0) return `☀ Exporting ${formatWattsShort(exportW)} back to the grid — nice.`;
    if (solarWatts > 0 && importFlow <= 0)
      return "☀ Solar is running the whole house right now — grid draw zero.";
    if (solarWatts > 0)
      return `☀ Solar covering ${formatWattsShort(solarToHouse)}, grid topping up ${formatWattsShort(importFlow)}.`;
    if (importFlow > 0) {
      const h = melbourneHour(new Date());
      return h < 6
        ? "🌙 Off-peak hours — the grid is carrying the house at 8 c/kWh."
        : "🔌 The grid is carrying the house right now.";
    }
    return "All quiet — no measurable flow.";
  })();

  const gridAccent = exportW > 0 ? SOLAR_GREEN : importFlow > 0 ? GRID_BLUE : "rgba(255,255,255,0.25)";
  const solarAccent = solarWatts > 0 ? SOLAR_GREEN : "rgba(255,255,255,0.25)";

  return (
    <div className="flow-wrap">
      {error ? <ErrorBanner error={error} onRetry={refetchAll} /> : null}

      <section className="card flow-card">
        <div className="card-head">
          <h2>Energy flow</h2>
          <div className="dial-actions">
            <span className="muted">live · particle speed &amp; count = watts</span>
            <button type="button" className="ghost" onClick={refetchAll}>
              ↻ Refresh
            </button>
          </div>
        </div>

        <div className="flow-stats">
          <div className="flow-stat t-house">
            <span className="k">House</span>
            <span className="v">{houseW === null ? "—" : formatWattsShort(houseW)}</span>
            <span className="s">drawing now</span>
          </div>
          <div className="flow-stat t-solar">
            <span className="k">Solar</span>
            <span className="v">{solarW === null ? "—" : formatWattsShort(solarW)}</span>
            <span className="s">generating</span>
          </div>
          <div className="flow-stat t-grid">
            <span className="k">Grid</span>
            <span className="v">{gridW === null ? "—" : formatWattsShort(Math.abs(gridW))}</span>
            <span className="s">{exportW > 0 ? "exporting" : "importing"}</span>
          </div>
        </div>

        <div className="flow-stage">
          <svg
            viewBox="0 0 760 470"
            role="img"
            aria-label={`Animated diagram: house drawing ${houseW === null ? "unknown" : formatWattsShort(houseW)}, solar generating ${solarW === null ? "unknown" : formatWattsShort(solarW)}, grid ${gridW === null ? "unknown" : exportW > 0 ? `exporting ${formatWattsShort(exportW)}` : `importing ${formatWattsShort(importFlow)}`}`}
          >
            <defs>
              <filter id="flowGlow" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="3.2" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* wires (paths double as particle tracks) */}
            <path
              id="path-solar-house"
              d="M 188 170 C 232 248, 296 285, 338 303"
              fill="none"
              stroke={solarToHouse > 0 ? SOLAR_GREEN : DIM}
              strokeWidth={flowWidth(solarToHouse)}
              opacity={solarToHouse > 0 ? 0.5 : 1}
              strokeLinecap="round"
            />
            <path
              id="path-grid-house"
              d="M 572 172 C 530 248, 468 285, 424 302"
              fill="none"
              stroke={importFlow > 0 ? GRID_BLUE : DIM}
              strokeWidth={flowWidth(importFlow)}
              opacity={importFlow > 0 ? 0.5 : 1}
              strokeLinecap="round"
            />
            {/* export track: same wire, drawn house → grid, ridden only when exporting */}
            <path id="path-house-grid" d="M 424 302 C 468 285, 530 248, 572 172" fill="none" stroke="none" />

            {/* static direction arrows (glance-able even between particles) */}
            {solarToHouse > 0 ? (
              <polygon points="0,-5 11,0 0,5" transform="translate(264,259) rotate(38)" fill={SOLAR_GREEN} opacity={0.9} />
            ) : null}
            {importFlow > 0 ? (
              <polygon points="0,-5 11,0 0,5" transform="translate(499,259) rotate(141)" fill={GRID_BLUE} opacity={0.9} />
            ) : null}
            {exportW > 0 ? (
              <polygon points="0,-5 11,0 0,5" transform="translate(499,259) rotate(-39)" fill={SOLAR_GREEN} opacity={0.9} />
            ) : null}

            {/* moving current */}
            <ParticleStream pathId="path-solar-house" watts={solarToHouse} colour={SOLAR_GREEN} />
            <ParticleStream pathId="path-grid-house" watts={importFlow} colour={GRID_BLUE} />
            <ParticleStream pathId="path-house-grid" watts={exportW} colour={SOLAR_GREEN} />

            {/* ——— solar panels node ——— */}
            <g transform="translate(150 130)">
              <circle r={58} className="flow-pad" />
              {solarWatts > 0 ? (
                <g className="flow-sun">
                  <circle cx={46} cy={-44} r={8} fill="#fbbf24">
                    <animate attributeName="opacity" values="0.55;1;0.55" dur="3s" repeatCount="indefinite" />
                  </circle>
                  {Array.from({ length: 8 }, (_, i) => {
                    const a = (i * Math.PI) / 4;
                    return (
                      <line
                        key={i}
                        x1={46 + Math.cos(a) * 11}
                        y1={-44 + Math.sin(a) * 11}
                        x2={46 + Math.cos(a) * 15}
                        y2={-44 + Math.sin(a) * 15}
                        stroke="#fbbf24"
                        strokeWidth={1.6}
                        strokeLinecap="round"
                      />
                    );
                  })}
                </g>
              ) : null}
              <g transform="skewX(-6)">
                <rect
                  x={-33}
                  y={-26}
                  width={66}
                  height={30}
                  rx={3}
                  fill="rgba(74,222,128,0.10)"
                  stroke={solarAccent}
                  strokeWidth={2}
                />
                <line x1={-33} y1={-16} x2={33} y2={-16} stroke={solarAccent} strokeWidth={1} opacity={0.6} />
                <line x1={-11} y1={-26} x2={-11} y2={4} stroke={solarAccent} strokeWidth={1} opacity={0.6} />
                <line x1={11} y1={-26} x2={11} y2={4} stroke={solarAccent} strokeWidth={1} opacity={0.6} />
              </g>
              <line x1={0} y1={8} x2={0} y2={20} stroke="rgba(255,255,255,0.3)" strokeWidth={3} />
              <line x1={-14} y1={21} x2={14} y2={21} stroke="rgba(255,255,255,0.3)" strokeWidth={3} strokeLinecap="round" />
              <text y={82} textAnchor="middle" fontSize={15} letterSpacing={2} fill="#93a1b0">
                SOLAR
              </text>
            </g>

            {/* ——— grid powerline node ——— */}
            <g transform="translate(610 130)">
              <circle r={58} className="flow-pad" />
              <g stroke={gridAccent} strokeWidth={2.4} strokeLinecap="round" fill="none">
                <path d="M -11 32 L -3 -32 L 3 -32 L 11 32" />
                <line x1={-24} y1={-14} x2={24} y2={-14} />
                <line x1={-17} y1={2} x2={17} y2={2} />
                <path d="M -11 32 L 17 2 M 11 32 L -17 2 M -3 -32 L -24 -14 M 3 -32 L 24 -14" strokeWidth={1.4} opacity={0.7} />
                <line x1={-24} y1={-14} x2={-24} y2={-8} strokeWidth={1.4} />
                <line x1={24} y1={-14} x2={24} y2={-8} strokeWidth={1.4} />
              </g>
              <text y={82} textAnchor="middle" fontSize={15} letterSpacing={2} fill="#93a1b0" stroke="none">
                GRID
              </text>
            </g>

            {/* ——— house node ——— */}
            <g transform="translate(380 330)">
              <circle r={62} className="flow-pad" />
              <path d="M -42 -6 L 0 -40 L 42 -6" fill="none" stroke={INK} strokeWidth={2.6} strokeLinejoin="round" />
              <rect x={-34} y={-6} width={68} height={34} rx={2} fill="rgba(255,255,255,0.05)" stroke={INK} strokeWidth={2.4} />
              <rect x={-27} y={0} width={15} height={12} rx={1.5} fill={solarDominant ? SOLAR_GREEN : GRID_BLUE} opacity={0.9} />
              <rect x={12} y={0} width={15} height={12} rx={1.5} fill={solarDominant ? SOLAR_GREEN : GRID_BLUE} opacity={0.9} />
              <rect x={-8} y={8} width={16} height={20} fill="rgba(13,18,26,0.9)" stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
              <text y={82} textAnchor="middle" fontSize={15} letterSpacing={2} fill="#93a1b0">
                HOUSE
              </text>
            </g>
          </svg>
        </div>

        <p className="flow-status" aria-live="polite">
          {status}
        </p>

        <div className="flow-foot">
          <span>today {formatKwh(today.kwh)}</span>
          <span>{formatDollars(today.cents)} est.</span>
          <span className="dial-solar">☀ {solarTodayKwh === null ? "—" : formatKwh(solarTodayKwh)} solar today</span>
          <span className={"dial-age" + (stale ? " stale" : "")}>grid reading {humanAge(gridAgeMs)}</span>
          {!loadedOnce ? <span className="muted">loading today…</span> : null}
        </div>
      </section>
    </div>
  );
}
