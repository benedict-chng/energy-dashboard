import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api/client";
import type { Bucket, EnergyOverviewPage, RangeKey, ReadingOut, SolarReadingOut } from "./types";
import { ErrorBanner } from "./components/ErrorBanner";
import { NowPanel } from "./components/NowPanel";
import { OverviewChart } from "./components/OverviewChart";
import { LiveView } from "./components/LiveView";
import { formatClock } from "./lib/format";

const REFRESH_MS = 60_000;

/** Chart window configs. 24h uses 5m buckets (~288 pts), 7d uses 1h (168 pts). */
const RANGES: Record<RangeKey, { label: string; ms: number; bucket: Bucket }> = {
  "24h": { label: "24 hours", ms: 24 * 60 * 60_000, bucket: "5m" },
  "7d": { label: "7 days", ms: 7 * 24 * 60 * 60_000, bucket: "1h" },
};

interface NowData {
  grid: ReadingOut | null;
  solar: SolarReadingOut | null;
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

export default function App() {
  const [view, setView] = useState<"charts" | "live">("live");
  const [range, setRange] = useState<RangeKey>("24h");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [overview, setOverview] = useState<EnergyOverviewPage | null>(null);
  const [now, setNow] = useState<NowData>({ grid: null, solar: null });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [everLoaded, setEverLoaded] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const inflightRef = useRef(0);

  const load = useCallback(async (key: RangeKey) => {
    const cfg = RANGES[key];
    inflightRef.current += 1;
    setBusy(true);
    try {
      const [overviewRes, gridRes, solarRes] = await Promise.allSettled([
        api.energyOverview({
          from: new Date(Date.now() - cfg.ms).toISOString(),
          to: new Date().toISOString(),
          bucket: cfg.bucket,
        }),
        allow404(api.latestGridReading()),
        allow404(api.latestSolarReading()),
      ]);

      if (overviewRes.status === "fulfilled") {
        setOverview(overviewRes.value);
        setEverLoaded(true);
      }

      setNow({
        grid: gridRes.status === "fulfilled" ? gridRes.value : null,
        solar: solarRes.status === "fulfilled" ? solarRes.value : null,
      });

      // Show the first real failure (overview takes priority) in the banner.
      const firstError =
        overviewRes.status === "rejected"
          ? toApiError(overviewRes.reason)
          : gridRes.status === "rejected"
            ? toApiError(gridRes.reason)
            : solarRes.status === "rejected"
              ? toApiError(solarRes.reason)
              : null;
      setError(firstError);
    } finally {
      inflightRef.current -= 1;
      if (inflightRef.current === 0) {
        setBusy(false);
        setUpdatedAt(new Date());
      }
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [range, load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => void load(range), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, range, load]);

  const rangeTotalKwh = useMemo(
    () => (overview ? overview.points.reduce((sum, point) => sum + point.consumed_kwh, 0) : null),
    [overview],
  );

  const rangeConfig = RANGES[range];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            ⚡
          </span>
          <div>
            <h1>Home Energy</h1>
            <p className="subtitle">energy.ahbeng.xyz · grid + solar</p>
          </div>
        </div>
        <div className="controls">
          <div className="segmented" role="tablist" aria-label="View">
            <button
              type="button"
              role="tab"
              aria-selected={view === "charts"}
              className={view === "charts" ? "active" : ""}
              onClick={() => setView("charts")}
            >
              Charts
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "live"}
              className={view === "live" ? "active" : ""}
              onClick={() => setView("live")}
            >
              Live
            </button>
          </div>
          {view === "charts" ? (
            <div className="segmented" role="tablist" aria-label="Time range">
              {(Object.keys(RANGES) as RangeKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={range === key}
                  className={range === key ? "active" : ""}
                  onClick={() => setRange(key)}
                >
                  {key === "24h" ? "24 h" : "7 d"}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className={"ghost" + (autoRefresh ? " on" : "")}
            onClick={() => setAutoRefresh((value) => !value)}
            title="Auto-refresh every 60 seconds"
          >
            {autoRefresh ? "⏸ Pause" : "▶ Resume"}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => void load(range)}
            disabled={busy}
          >
            ↻ Refresh
          </button>
        </div>
      </header>

      {view === "live" ? (
        <LiveView />
      ) : (
        <>
          {error ? <ErrorBanner error={error} onRetry={() => void load(range)} /> : null}

          <section className="now-grid">
            <NowPanel
              grid={now.grid}
              solar={now.solar}
              rangeTotalKwh={rangeTotalKwh}
              rangeLabel={rangeConfig.label}
              placeholder={!everLoaded}
            />
          </section>

          <section className={"card chart-card" + (busy && everLoaded ? " refreshing" : "")}>
            <div className="card-head">
              <h2>Grid vs solar — last {rangeConfig.label}</h2>
              <span className="muted">bucket: {rangeConfig.bucket} (UTC)</span>
            </div>
            {overview || everLoaded ? (
              <OverviewChart data={overview} range={range} />
            ) : (
              <div className="chart-skeleton">{busy ? "Loading…" : "No data loaded"}</div>
            )}
          </section>
        </>
      )}

      <footer className="footer">
        <span>
          {busy
            ? "Updating…"
            : updatedAt
              ? `Updated ${formatClock(updatedAt)}`
              : "Not loaded yet"}
          {autoRefresh ? " · auto-refresh 60 s" : " · auto-refresh paused"}
        </span>
        <span className="muted">same-origin /api proxy → energy.ahbeng.xyz (FastAPI)</span>
      </footer>
    </div>
  );
}
