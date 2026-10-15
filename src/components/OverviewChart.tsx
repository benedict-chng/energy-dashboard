import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EnergyOverviewPage, RangeKey } from "../types";
import { axisKwh, axisWatts, formatBucketLabel, formatBucketTooltip } from "../lib/format";

const COLORS = { kwh: "#38bdf8", grid: "#fb7185", solar: "#fbbf24" } as const;

interface ChartPoint {
  time: number;
  consumed_kwh: number;
  grid_watts: number | null;
  solar_watts: number | null;
}

interface Props {
  data: EnergyOverviewPage | null;
  range: RangeKey;
}

/** Composed chart from GET /api/v1/energy/overview: kWh bars + W lines. */
export function OverviewChart({ data, range }: Props) {
  const points = useMemo<ChartPoint[]>(
    () =>
      (data?.points ?? []).map((point) => ({
        time: new Date(point.bucket).getTime(),
        consumed_kwh: point.consumed_kwh,
        grid_watts: point.avg_grid_watts,
        solar_watts: point.avg_solar_watts,
      })),
    [data],
  );

  if (points.length === 0) {
    return <div className="chart-empty">No overview data in this range yet.</div>;
  }

  return (
    <div
      className="chart-wrap"
      role="img"
      aria-label={`Grid energy, grid power and solar power over the last ${range === "24h" ? "24 hours" : "7 days"}`}
    >
      <div className="chart-box">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 10, right: 6, bottom: 0, left: 6 }}>
            <CartesianGrid stroke="#1a2534" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="time"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(value: number) => formatBucketLabel(value, range)}
              stroke="#334155"
              tick={{ fill: "#8fa0b3", fontSize: 11.5 }}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              yAxisId="kwh"
              width={58}
              tickFormatter={axisKwh}
              stroke="#334155"
              tick={{ fill: "#8fa0b3", fontSize: 11.5 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              yAxisId="watts"
              orientation="right"
              width={58}
              tickFormatter={axisWatts}
              stroke="#334155"
              tick={{ fill: "#8fa0b3", fontSize: 11.5 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#0d141d",
                border: "1px solid #1d2a3a",
                borderRadius: 10,
              }}
              itemStyle={{ color: "#e6edf3" }}
              labelStyle={{ color: "#8fa0b3", marginBottom: 4 }}
              labelFormatter={(label) => formatBucketTooltip(Number(label))}
              formatter={(value: unknown, name: unknown) => {
                const numeric = typeof value === "number" ? value : Number(value);
                const label = typeof name === "string" ? name : String(name);
                if (label.includes("kWh")) {
                  return [`${numeric.toFixed(2)} kWh`, label];
                }
                return [`${Math.round(numeric).toLocaleString("en-AU")} W`, label];
              }}
              cursor={{ fill: "rgba(148, 163, 184, 0.08)" }}
            />
            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 6 }} iconType="plainline" />
            <Bar
              yAxisId="kwh"
              dataKey="consumed_kwh"
              name="Grid energy (kWh)"
              fill={COLORS.kwh}
              fillOpacity={0.3}
              maxBarSize={26}
            />
            <Line
              yAxisId="watts"
              dataKey="grid_watts"
              name="Grid import (W)"
              stroke={COLORS.grid}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              yAxisId="watts"
              dataKey="solar_watts"
              name="Solar (W)"
              stroke={COLORS.solar}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="chart-note">
        Bars: grid energy per {data?.bucket ?? "…"} bucket (left axis). Lines: average power (right
        axis). Buckets are UTC, shown in local time.
      </p>
    </div>
  );
}
