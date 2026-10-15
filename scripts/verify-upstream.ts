/**
 * No-network verification of the Pages Function's logic:
 *   1. path mapping: /api/<segments><query> -> upstream URL
 *   2. non-GET requests are rejected with 405 (returns before any fetch)
 *   3. missing QUERY_API_KEY is a clean 500 (returns before any fetch)
 *
 * Run with: npm test
 * (Requires Node >= 23.6 for native TypeScript stripping; on older Node use:
 *  node --experimental-strip-types scripts/verify-upstream.ts)
 */
import { buildUpstreamUrl, UPSTREAM_ORIGIN } from "../functions/api/_upstream.ts";
import { onRequest } from "../functions/api/[[path]].ts";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function testPathMapping(): void {
  console.log("path mapping (functions/api/_upstream.ts)");
  check(
    "overview path + query forwarded",
    buildUpstreamUrl(["v1", "energy", "overview"], "?bucket=1h&from=2026-10-15T00:00:00Z") ===
      `${UPSTREAM_ORIGIN}/v1/energy/overview?bucket=1h&from=2026-10-15T00:00:00Z`,
  );
  check(
    "nested solar path",
    buildUpstreamUrl(["v1", "solar", "readings", "latest"], "") ===
      `${UPSTREAM_ORIGIN}/v1/solar/readings/latest`,
  );
  check(
    "root call (no segments) -> origin root",
    buildUpstreamUrl(undefined, "") === `${UPSTREAM_ORIGIN}/`,
  );
  check(
    "segments are re-encoded safely",
    buildUpstreamUrl(["v1", "a b"], "") === `${UPSTREAM_ORIGIN}/v1/a%20b`,
  );
  check(
    "single string segment form",
    buildUpstreamUrl("v1", "?x=1") === `${UPSTREAM_ORIGIN}/v1?x=1`,
  );
}

async function testMethodGuard(): Promise<void> {
  console.log("method guard (functions/api/[[path]].ts)");
  const response = await onRequest({
    request: new Request("https://dashboard.example.com/api/v1/readings", { method: "POST" }),
    env: { QUERY_API_KEY: "test-key-not-a-real-key" },
    params: { path: ["v1", "readings"] },
  });
  check("POST is rejected with 405", response.status === 405, `got ${response.status}`);
  check("405 advertises Allow: GET", response.headers.get("allow") === "GET");
}

async function testMissingKey(): Promise<void> {
  console.log("missing key guard (functions/api/[[path]].ts)");
  const response = await onRequest({
    request: new Request("https://dashboard.example.com/api/v1/readings/latest"),
    env: {},
    params: { path: ["v1", "readings", "latest"] },
  });
  check("missing QUERY_API_KEY -> 500", response.status === 500, `got ${response.status}`);
  const body = (await response.json()) as { detail?: unknown };
  check(
    "500 body names the missing variable",
    typeof body.detail === "string" && body.detail.includes("QUERY_API_KEY"),
  );
}

console.log(`Upstream origin: ${UPSTREAM_ORIGIN}`);
testPathMapping();
await testMethodGuard();
await testMissingKey();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  throw new Error("function verification failed");
}
console.log("\nAll Function logic checks passed (no network used).");
