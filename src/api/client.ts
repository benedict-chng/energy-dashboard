/**
 * Typed API client. The browser only ever calls SAME-ORIGIN `/api/...` paths;
 * the Pages Function (functions/api/[[path]].ts) adds the X-API-Key server
 * side. No key, no absolute origin, no CORS in this file.
 */
import type {
  Bucket,
  EnergyOverviewPage,
  ReadingsPage,
  ReadingOut,
  SolarPage,
  SolarReadingOut,
  SolarSummaryPage,
  SummaryPage,
} from "../types";

const BASE = "/api";

/** Error carrying the HTTP status and the server's `detail` text. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type QueryParams = Record<string, string | number | undefined>;

function buildSearch(params?: QueryParams): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

async function getJson<T>(path: string, params?: QueryParams): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}${buildSearch(params)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (cause) {
    throw new ApiError(`Network error: could not reach ${BASE}${path} (${String(cause)})`, 0);
  }

  if (!response.ok) {
    // FastAPI errors look like {"detail": "..."}; the Function uses the same
    // shape for its own errors (405/500/502).
    let detail = `${response.status} ${response.statusText}`.trim();
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object") {
        const d = (body as { detail?: unknown }).detail;
        const e = (body as { error?: unknown }).error;
        if (typeof d === "string") detail = d;
        else if (typeof e === "string") detail = e;
      }
    } catch {
      // non-JSON error body — keep the status-line fallback
    }
    throw new ApiError(detail, response.status);
  }

  return (await response.json()) as T;
}

export type OverviewQuery = {
  /** ISO 8601 WITH UTC offset (e.g. 2026-10-15T00:00:00Z). Inclusive. */
  from?: string;
  /** ISO 8601 WITH UTC offset. Exclusive. */
  to?: string;
  bucket?: Bucket;
};

export type ReadingsQuery = {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
};

export type SummaryQuery = {
  bucket?: Bucket;
  from?: string;
  to?: string;
};

export const api = {
  /** Combined grid+solar overview — powers the dashboard charts. */
  energyOverview: (query: OverviewQuery = {}) =>
    getJson<EnergyOverviewPage>("/v1/energy/overview", query),

  latestGridReading: () => getJson<ReadingOut>("/v1/readings/latest"),
  listGridReadings: (query: ReadingsQuery = {}) => getJson<ReadingsPage>("/v1/readings", query),
  gridSummary: (query: SummaryQuery = {}) => getJson<SummaryPage>("/v1/readings/summary", query),

  latestSolarReading: () => getJson<SolarReadingOut>("/v1/solar/readings/latest"),
  listSolarReadings: (query: ReadingsQuery = {}) => getJson<SolarPage>("/v1/solar/readings", query),
  solarSummary: (query: SummaryQuery = {}) =>
    getJson<SolarSummaryPage>("/v1/solar/readings/summary", query),
};
