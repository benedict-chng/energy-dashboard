/**
 * Same-origin API proxy for the dashboard — Cloudflare Pages Function.
 *
 *   Browser  →  GET /api/<path>  →  this Function  →  GET https://energy.ahbeng.xyz/<path>
 *                                                 +  header X-API-Key: $QUERY_API_KEY
 *
 * - Only GET is proxied; anything else is rejected with 405.
 * - Upstream status codes and JSON error bodies are passed through unchanged.
 * - The API key never reaches the browser. It exists only as the Pages
 *   environment variable QUERY_API_KEY (dashboard) or `.dev.vars` (local
 *   wrangler dev). It is never imported into frontend code or the bundle.
 */
import { buildUpstreamUrl, jsonResponse, UPSTREAM_ORIGIN } from "./_upstream.ts";

interface FunctionContext {
  request: Request;
  env: { QUERY_API_KEY?: string };
  params: { path?: string | string[] };
}

export const onRequest = async (context: FunctionContext): Promise<Response> => {
  const { request, env, params } = context;

  if (request.method !== "GET") {
    return jsonResponse(
      { detail: "Method not allowed: the dashboard proxy only forwards GET requests." },
      405,
      { Allow: "GET" },
    );
  }

  const apiKey = env.QUERY_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      { detail: "Server misconfiguration: QUERY_API_KEY is not set for this Pages project." },
      500,
    );
  }

  const url = new URL(request.url);
  const upstreamUrl = buildUpstreamUrl(params.path, url.search);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
    });
  } catch {
    return jsonResponse(
      { detail: `Upstream unreachable: ${UPSTREAM_ORIGIN} did not respond.` },
      502,
    );
  }

  // Pass status + body through verbatim; only normalise the hop headers.
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
};
