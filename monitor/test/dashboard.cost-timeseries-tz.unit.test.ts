// DF-7 regression: GET /api/dashboard/cost-timeseries bounded its generate_series on
// session-tz CURRENT_DATE while the KPI band pins on the day-bucket timezone — so during
// 00:00–08:59 KST the last series point rendered yesterday-as-today. computeBucketTzToday
// pins the series bound (last point) to the bucket-tz calendar day. DB-independent,
// frozen-clock unit — the pure day-resolver IS the last series point value.
// Runner: npx tsx --test test/dashboard.cost-timeseries-tz.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { computeBucketTzToday } from "../src/server/routes/dashboard.js";

const KST = "Asia/Seoul"; // UTC+9

// AC: frozen clock 23:30 UTC → the last series point (bucket-tz today) = KST tomorrow-in-UTC.
test("23:30 UTC → bucket-tz (KST) today is the next UTC calendar day (last series point)", () => {
  const frozen = new Date("2026-07-17T23:30:00Z");
  assert.strictEqual(computeBucketTzToday(frozen, KST), "2026-07-18");
});

// The drift the fix removes: the naive UTC calendar day of the SAME instant is yesterday.
test("regression: UTC CURRENT_DATE would show yesterday-as-today at 23:30 UTC", () => {
  const frozen = new Date("2026-07-17T23:30:00Z");
  const naiveUtcDay = frozen.toISOString().slice(0, 10);
  assert.strictEqual(naiveUtcDay, "2026-07-17");
  assert.notStrictEqual(computeBucketTzToday(frozen, KST), naiveUtcDay);
});

// Just after KST midnight (00:30 KST) but before UTC midnight — the highest-risk window.
test("15:30 UTC (00:30 KST next day) → bucket-tz today already rolled to the KST day", () => {
  const frozen = new Date("2026-07-17T15:30:00Z");
  assert.strictEqual(computeBucketTzToday(frozen, KST), "2026-07-18");
});

// Mid-KST-day instant — same UTC and KST calendar day (no boundary effect).
test("05:00 UTC (14:00 KST) → bucket-tz today matches the shared calendar day", () => {
  const frozen = new Date("2026-07-17T05:00:00Z");
  assert.strictEqual(computeBucketTzToday(frozen, KST), "2026-07-17");
});

// Default tz arg resolves to the module's DAY_BUCKET_TIMEZONE and yields an ISO day.
test("default timeZone arg returns a valid YYYY-MM-DD string", () => {
  const iso = computeBucketTzToday(new Date("2026-07-17T05:00:00Z"));
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
});
