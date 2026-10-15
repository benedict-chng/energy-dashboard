/**
 * Response models mirroring home-energy-server's FastAPI schemas exactly
 * (app/schemas/{energy,reading,solar}.py). Field names are deliberately
 * identical to the wire format — do not rename.
 */

/** time_bucket sizes accepted by the server (`1m|5m|15m|1h|1d`). */
export type Bucket = "1m" | "5m" | "15m" | "1h" | "1d";

/** Which window the dashboard charts. */
export type RangeKey = "24h" | "7d";

/* ---------------------------------- energy --------------------------------- */

/** GET /api/v1/energy/overview → EnergyOverviewPage */
export interface EnergyOverviewPoint {
  /** ISO 8601 datetime, UTC (bucket start). */
  bucket: string;
  /** Grid energy consumed within the bucket (sum of per-reading kWh deltas). */
  consumed_kwh: number;
  /** Average grid power (W) within the bucket; null when no grid data. */
  avg_grid_watts: number | null;
  /** Average solar power (W) within the bucket; null when no solar data. */
  avg_solar_watts: number | null;
}

export interface EnergyOverviewPage {
  bucket: Bucket;
  points: EnergyOverviewPoint[];
}

/* ------------------------------- grid readings ----------------------------- */

/** GET /api/v1/readings/latest → ReadingOut; items of GET /api/v1/readings */
export interface ReadingOut {
  /** ISO 8601 datetime, UTC. */
  time: string;
  /** Pulse-count delta since the previous reading. */
  pulses: number;
  /** Energy delta (kWh) since the previous reading. */
  kwh: number;
  /** Average grid power (W) over the reading interval. */
  average_watts: number;
}

/** GET /api/v1/readings → ReadingsPage */
export interface ReadingsPage {
  count: number;
  readings: ReadingOut[];
}

/** GET /api/v1/readings/summary → SummaryPage */
export interface SummaryPoint {
  bucket: string;
  pulses: number;
  kwh: number;
  avg_watts: number;
}

export interface SummaryPage {
  bucket: Bucket;
  points: SummaryPoint[];
}

/* ------------------------------ solar readings ----------------------------- */

/** GET /api/v1/solar/readings/latest → SolarReadingOut; items of GET /api/v1/solar/readings */
export interface SolarReadingOut {
  /** ISO 8601 datetime, UTC. */
  time: string;
  /** Average solar power (W) over the reading interval. */
  average_watts: number;
}

/** GET /api/v1/solar/readings → SolarPage */
export interface SolarPage {
  count: number;
  readings: SolarReadingOut[];
}

/** GET /api/v1/solar/readings/summary → SolarSummaryPage */
export interface SolarSummaryPoint {
  bucket: string;
  avg_watts: number;
}

export interface SolarSummaryPage {
  bucket: Bucket;
  points: SolarSummaryPoint[];
}
