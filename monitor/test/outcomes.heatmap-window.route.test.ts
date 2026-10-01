// /heatmap window naming: the SQL window starts at UTC midnight (CURRENT_DATE - days) while the
// grid buckets by the day-bucket timezone → meta.bucket_dates names the local dates the window
// touches, so the client never derives them from its own clock.
// DB: real Postgres — the route test reads meta only, seeds nothing.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma } from "../src/server/db.js";
import { getHeatmapBucketDates, registerOutcomesRoutes } from "../src/server/routes/outcomes.js";
import type { OutcomeHeatmapResponse } from "../src/server/types/outcomes.js";

const WINDOW_DAYS = 7;

describe("bucket dates cover every local date between the UTC-midnight anchor and now", () => {
  const rows = [
    { name: "Seoul before 09:00 touches days + 2 dates", now: "2026-09-29T20:30:00Z", days: 7, timeZone: "Asia/Seoul", first: "2026-09-22", last: "2026-09-30", count: 9 },
    { name: "Seoul after 09:00 touches days + 1 dates", now: "2026-09-30T03:00:00Z", days: 7, timeZone: "Asia/Seoul", first: "2026-09-23", last: "2026-09-30", count: 8 },
    { name: "UTC touches days + 1 dates", now: "2026-09-29T20:30:00Z", days: 7, timeZone: "UTC", first: "2026-09-22", last: "2026-09-29", count: 8 },
    { name: "Los Angeles puts the anchor on the previous local date", now: "2026-09-30T10:00:00Z", days: 7, timeZone: "America/Los_Angeles", first: "2026-09-22", last: "2026-09-30", count: 9 },
    { name: "Los Angeles evening, UTC already a day ahead", now: "2026-09-30T03:00:00Z", days: 7, timeZone: "America/Los_Angeles", first: "2026-09-22", last: "2026-09-29", count: 8 },
    { name: "a one-day Seoul window before 09:00 touches three dates", now: "2026-09-29T20:30:00Z", days: 1, timeZone: "Asia/Seoul", first: "2026-09-28", last: "2026-09-30", count: 3 },
    { name: "a window crossing a month boundary counts across it", now: "2026-10-01T20:00:00Z", days: 7, timeZone: "Asia/Seoul", first: "2026-09-24", last: "2026-10-02", count: 9 },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const dates = getHeatmapBucketDates(new Date(row.now), row.days, row.timeZone);
      assert.deepEqual(dates, { first: row.first, last: row.last, count: row.count });
    });
  }
});

describe("/heatmap meta names its window in the bucket timezone", () => {
  let app: FastifyInstance;

  before(async () => {
    app = Fastify({ logger: false });
    await registerOutcomesRoutes(app);
    await app.ready();
  });

  after(async () => {
    try {
      await app.close();
    } catch {
      // best-effort
    }
    await disconnectPrisma();
  });

  test("bucket_dates spans the anchor date through the bucket-tz today, period_start stays the UTC date", async (t) => {
    const frozenNow = Date.parse("2026-09-29T20:30:00Z");
    t.mock.timers.enable({ apis: ["Date"], now: frozenNow });
    const res = await app.inject({ method: "GET", url: `/api/outcomes/heatmap?days=${WINDOW_DAYS}` });
    t.mock.timers.reset();

    assert.equal(res.statusCode, 200, res.body);
    const { meta } = res.json() as OutcomeHeatmapResponse;
    assert.equal(meta.period_start, "2026-09-22");
    assert.equal(meta.period_end, "2026-09-29");
    assert.deepEqual(
      meta.bucket_dates,
      getHeatmapBucketDates(new Date(frozenNow), WINDOW_DAYS, meta.timezone),
    );
  });
});
