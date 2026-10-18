/**
 * No-network checks for the Live view's tariff maths (src/lib/tariff.ts).
 * Run: npm test (or node scripts/verify-costs.ts; Node ≥ 23.6).
 */
import {
  bucketCents,
  costByMonth,
  melbourneHour,
  rateAt,
  summariseCost,
  TARIFF_WINDOWS,
} from "../src/lib/tariff.ts";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok =
    typeof actual === "number" && typeof expected === "number"
      ? Math.abs(actual - expected) < 1e-9
      : Object.is(actual, expected);
  if (ok) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${name}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

console.log("melbourne hour (ICU, process-TZ independent)");
check("2026-10-17T13:30:00Z -> 00 (AEDT midnight)", melbourneHour(new Date("2026-10-17T13:30:00Z")), 0);
check("2026-10-17T18:59:00Z -> 05", melbourneHour(new Date("2026-10-17T18:59:00Z")), 5);
check("2026-10-17T19:00:00Z -> 06", melbourneHour(new Date("2026-10-17T19:00:00Z")), 6);
check("2026-10-18T12:59:00Z -> 23", melbourneHour(new Date("2026-10-18T12:59:00Z")), 23);

console.log("rate windows");
check("00:30 -> 8c", rateAt(new Date("2026-10-17T13:30:00Z")), 8);
check("05:59 -> 8c", rateAt(new Date("2026-10-17T18:59:00Z")), 8);
check("06:00 -> 27c", rateAt(new Date("2026-10-17T19:00:00Z")), 27);
check("12:00 -> 27c", rateAt(new Date("2026-10-18T01:00:00Z")), 27);
check("23:59 -> 27c", rateAt(new Date("2026-10-18T12:59:00Z")), 27);
check(
  "windows cover 00-24 contiguously",
  TARIFF_WINDOWS[0].endHour === TARIFF_WINDOWS[1].startHour &&
    TARIFF_WINDOWS[TARIFF_WINDOWS.length - 1].endHour === 24,
  true,
);

console.log("bucket + summary costs");
check("1 kWh off-peak = 8c", bucketCents(1, "2026-10-17T13:30:00Z"), 8);
check("2 kWh peak = 54c", bucketCents(2, "2026-10-17T19:00:00Z"), 54);
const sum = summariseCost([
  { bucket: "2026-10-17T13:30:00Z", kwh: 1 },
  { bucket: "2026-10-17T19:00:00Z", kwh: 2 },
]);
check("summary kwh", sum.kwh, 3);
check("summary cents (8 + 54)", sum.cents, 62);

console.log("month grouping");
const months = costByMonth([
  { bucket: "2026-09-20T02:00:00Z", kwh: 5 },
  { bucket: "2026-09-30T14:30:00Z", kwh: 1 }, // 00:30 AEST Oct 1 (DST starts Oct 4) -> off-peak
  { bucket: "2026-10-17T19:00:00Z", kwh: 2 },
]);
check("two groups", months.length, 2);
check("oldest first", months[0]?.label, "Sep 2026");
check("newest label", months[1]?.label, "Oct 2026");
check("oct cents (8 + 54)", months[1]?.cents, 62);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) throw new Error(`${fail} tariff check(s) failed`);
