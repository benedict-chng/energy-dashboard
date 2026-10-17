/**
 * Shared helpers for the /api proxy Pages Function.
 *
 * The leading `_` keeps this file out of the Pages file-based router — it is
 * import-only. Keeping the mapping logic here (instead of inside [[path]].ts)
 * makes it unit-testable without a network call (`npm test`).
 */

/** Origin of the home-energy-server (FastAPI behind a Cloudflare Tunnel). */
export const UPSTREAM_ORIGIN = "https://energy.ahbeng.xyz";

/**
 * Map this Function's catch-all path segments + query string to the
 * equivalent upstream URL. `functions/api/[[path]].ts` routes
 * `/api/<anything>` here, so `/api/v1/energy/overview?bucket=1h` maps to
 * `https://energy.ahbeng.xyz/api/v1/energy/overview?bucket=1h` — the
 * dashboard-facing `/api` prefix is re-added because the FastAPI server
 * mounts all routes under `/api/v1/...`; the query string is forwarded
 * untouched.
 */
export function buildUpstreamUrl(
  segments: string | readonly string[] | undefined,
  search: string,
): string {
  const path = (Array.isArray(segments) ? segments : segments ? [segments] : [])
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${UPSTREAM_ORIGIN}/api/${path}${search}`;
}

/** Small JSON response helper matching FastAPI's `{"detail": ...}` style. */
export function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
