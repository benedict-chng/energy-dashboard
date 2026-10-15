import type { ReadingOut, SolarReadingOut } from "../types";
import { formatClock, formatKwh, formatWatts } from "../lib/format";

type Tone = "grid" | "solar" | "accent" | "kwh";

interface TileProps {
  title: string;
  value: string;
  sub: string;
  tone: Tone;
  time: Date | null;
}

function Tile({ title, value, sub, tone, time }: TileProps) {
  return (
    <div className={`card tile tone-${tone}`}>
      <div className="tile-title">{title}</div>
      <div className="tile-big">{value}</div>
      <div className="tile-sub">{sub}</div>
      {time ? <div className="tile-time">at {formatClock(time)}</div> : null}
    </div>
  );
}

interface NowPanelProps {
  grid: ReadingOut | null;
  solar: SolarReadingOut | null;
  rangeTotalKwh: number | null;
  rangeLabel: string;
  /** True until the very first successful load — controls placeholder copy. */
  placeholder: boolean;
}

/**
 * "Now" tiles from the latest readings. Field names follow the API exactly:
 * grid readings are PowerPal pulses with per-minute kWh deltas and average
 * watts; solar is watts-only. There is no export register, so consumption is
 * estimated as grid import + solar generation.
 */
export function NowPanel({ grid, solar, rangeTotalKwh, rangeLabel, placeholder }: NowPanelProps) {
  const consumption =
    grid !== null && solar !== null ? grid.average_watts + solar.average_watts : null;

  return (
    <>
      <Tile
        title="Grid import"
        tone="grid"
        value={formatWatts(grid?.average_watts)}
        sub={
          grid
            ? `${formatKwh(grid.kwh, 3)} · ${grid.pulses} pulses in the latest minute`
            : placeholder
              ? "waiting for first refresh…"
              : "no readings stored"
        }
        time={grid ? new Date(grid.time) : null}
      />
      <Tile
        title="Solar generation"
        tone="solar"
        value={formatWatts(solar?.average_watts)}
        sub={
          solar ? "inverter average watts" : placeholder ? "waiting for first refresh…" : "no readings stored"
        }
        time={solar ? new Date(solar.time) : null}
      />
      <Tile
        title="Est. consumption"
        tone="accent"
        value={formatWatts(consumption)}
        sub="grid import + solar · export is not metered"
        time={null}
      />
      <Tile
        title={`Grid energy — ${rangeLabel}`}
        tone="kwh"
        value={formatKwh(rangeTotalKwh)}
        sub="sum of consumed_kwh over the selected range"
        time={null}
      />
    </>
  );
}
