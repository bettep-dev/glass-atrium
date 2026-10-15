// Opt-in prior window on /cross-analysis and /search: the N days before the current N-day window,
// counted under each route's own exclusions (cross-analysis drops poisoned rows, search keeps them).
// DB: real Postgres — seed rows carry SUITE_MARKER in summary (?q scope) and cid (cleanup).

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerOutcomesRoutes } from "../src/server/routes/outcomes.js";
import type {
  OutcomeCrossAnalysisByResult,
  OutcomeCrossAnalysisResponse,
  OutcomeSearchResponse,
} from "../src/server/types/outcomes.js";

const SUITE_MARKER = `prior-window-test-${randomUUID()}`;
const WINDOW_DAYS = 7;
let app: FastifyInstance;

type ExpectedWindow = "current" | "prior" | "none";

// The attention population's broken results (search needs_attention=true).
const ATTENTION_RESULTS: ReadonlySet<string> = new Set(["fail", "blocked"]);

interface SeedRow {
  name: string;
  result: "done" | "fail" | "blocked";
  // record_ts = CURRENT_DATE - daysAgo days + secondsOffset seconds (DB session tz)
  daysAgo: number;
  secondsOffset: number;
  isPoisoned: boolean;
  isReconstructed: boolean;
  // The window record_ts falls in, poisoned or not.
  window: ExpectedWindow;
}

const SEED_ROWS: readonly SeedRow[] = [
  { name: "today", result: "fail", daysAgo: 0, secondsOffset: 0, isPoisoned: false, isReconstructed: false, window: "current" },
  { name: "current lower bound", result: "done", daysAgo: 7, secondsOffset: 0, isPoisoned: false, isReconstructed: false, window: "current" },
  { name: "one second before the current lower bound", result: "fail", daysAgo: 7, secondsOffset: -1, isPoisoned: false, isReconstructed: false, window: "prior" },
  { name: "prior lower bound", result: "blocked", daysAgo: 14, secondsOffset: 0, isPoisoned: false, isReconstructed: false, window: "prior" },
  { name: "one second before the prior lower bound", result: "done", daysAgo: 14, secondsOffset: -1, isPoisoned: false, isReconstructed: false, window: "none" },
  { name: "poisoned inside the prior window", result: "fail", daysAgo: 10, secondsOffset: 0, isPoisoned: true, isReconstructed: false, window: "prior" },
  { name: "poisoned inside the current window", result: "done", daysAgo: 3, secondsOffset: 0, isPoisoned: true, isReconstructed: false, window: "current" },
  { name: "reconstructed inside the prior window", result: "done", daysAgo: 10, secondsOffset: 0, isPoisoned: false, isReconstructed: true, window: "prior" },
  { name: "reconstructed inside the current window", result: "blocked", daysAgo: 2, secondsOffset: 0, isPoisoned: false, isReconstructed: true, window: "current" },
];

before(async () => {
  app = Fastify({ logger: false });
  await registerOutcomesRoutes(app);
  await app.ready();
  await seedRows();
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM core.outcomes WHERE cid LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    console.error("[prior-window-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
});

async function seedRows(): Promise<void> {
  const prisma = getPrisma();
  for (const [i, row] of SEED_ROWS.entries()) {
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary,
         attribution_source, downgrade_origin, poisoned_window, cid)
      VALUES
        (CURRENT_DATE - (${row.daysAgo}::int * INTERVAL '1 day')
                      + (${row.secondsOffset}::int * INTERVAL '1 second'),
         ${`prior-window-agent-${i}`},
         'feature'::core."TaskType",
         ${row.result}::core."OutcomeResult",
         ${`prior-window seed ${row.name} ${SUITE_MARKER}`},
         'hook-input',
         ${row.isReconstructed ? "synthesized" : null}::core."DowngradeOrigin",
         ${row.isPoisoned},
         ${`${SUITE_MARKER}-${i}`})
    `;
  }
}

async function fetchCrossAnalysis(params: string): Promise<{ statusCode: number; body: OutcomeCrossAnalysisResponse }> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/cross-analysis?include_all=1&q=${encodeURIComponent(SUITE_MARKER)}&${params}`,
  });
  return { statusCode: res.statusCode, body: res.json() as OutcomeCrossAnalysisResponse };
}

async function fetchSearch(params: string): Promise<{ statusCode: number; body: OutcomeSearchResponse }> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?include_all=1&q=${encodeURIComponent(SUITE_MARKER)}&${params}`,
  });
  return { statusCode: res.statusCode, body: res.json() as OutcomeSearchResponse };
}

type WindowCounts = Record<string, { count: number; reconstructed_count: number }>;

function getExpectedCounts(window: ExpectedWindow): WindowCounts {
  const counts: WindowCounts = {};
  for (const row of SEED_ROWS.filter((r) => r.window === window && !r.isPoisoned)) {
    const bucket = counts[row.result] ?? { count: 0, reconstructed_count: 0 };
    bucket.count += 1;
    bucket.reconstructed_count += row.isReconstructed ? 1 : 0;
    counts[row.result] = bucket;
  }
  return counts;
}

function getObservedCounts(byResult: readonly OutcomeCrossAnalysisByResult[]): WindowCounts {
  return Object.fromEntries(
    byResult.map((r) => [r.result, { count: r.count, reconstructed_count: r.reconstructed_count }]),
  );
}

test("every seeded row lands in exactly the window its record_ts falls in; poisoned rows land in neither", async () => {
  const { statusCode, body } = await fetchCrossAnalysis(`days=${WINDOW_DAYS}&prior_window=1`);
  assert.strictEqual(statusCode, 200);
  assert.ok(body.prior_window, "prior_window present when requested");

  assert.deepStrictEqual(getObservedCounts(body.by_result), getExpectedCounts("current"), "current window");
  assert.deepStrictEqual(
    getObservedCounts(body.prior_window.by_result),
    getExpectedCounts("prior"),
    "prior window — its upper bound is exclusive, its lower bound inclusive",
  );
});

test("prior window totals keep reconstructed rows out of the writer-emitted count, as the current window does", async () => {
  const { body } = await fetchCrossAnalysis(`days=${WINDOW_DAYS}&prior_window=1`);
  assert.ok(body.prior_window);
  const priorRows = SEED_ROWS.filter((r) => r.window === "prior" && !r.isPoisoned);
  assert.strictEqual(body.prior_window.total, priorRows.length);
  assert.strictEqual(
    body.prior_window.total - body.prior_window.reconstructed_total,
    priorRows.filter((r) => !r.isReconstructed).length,
    "writer-emitted prior rows = total - reconstructed_total",
  );
});

test("prior window bounds come from the server's CURRENT_DATE and end where the current window starts", async () => {
  const { body } = await fetchCrossAnalysis(`days=${WINDOW_DAYS}&prior_window=1`);
  assert.ok(body.prior_window);
  const [anchor] = await getPrisma().$queryRaw<Array<{ start: string; end: string }>>`
    SELECT to_char(CURRENT_DATE - ${WINDOW_DAYS * 2}::int, 'YYYY-MM-DD') AS start,
           to_char(CURRENT_DATE - ${WINDOW_DAYS}::int, 'YYYY-MM-DD') AS end
  `;
  assert.ok(anchor);
  assert.strictEqual(body.prior_window.period_start, anchor.start);
  assert.strictEqual(body.prior_window.period_end, anchor.end);
});

test("a request without prior_window returns the unchanged response shape", async () => {
  const { statusCode, body } = await fetchCrossAnalysis(`days=${WINDOW_DAYS}`);
  assert.strictEqual(statusCode, 200);
  assert.deepStrictEqual(Object.keys(body).sort(), [
    "by_agent_result",
    "by_agent_top_10",
    "by_result",
    "cells",
    "downgrade_breakdown",
    "excluded_poisoned_count",
    "fetched_at",
    "filter",
    "grader_breakdown",
    "reconstructed_total",
    "task_type_grader_breakdown",
    "total",
  ]);
});

test("prior_window on the unbounded days=all window is rejected with 400", async () => {
  const { statusCode } = await fetchCrossAnalysis("days=all&prior_window=1");
  assert.strictEqual(statusCode, 400);
});

test("prior window counts the poisoned rows it excluded, as the current window does", async () => {
  const { body } = await fetchCrossAnalysis(`days=${WINDOW_DAYS}&prior_window=1`);
  assert.ok(body.prior_window);
  const countPoisoned = (window: ExpectedWindow): number =>
    SEED_ROWS.filter((r) => r.window === window && r.isPoisoned).length;
  assert.strictEqual(body.excluded_poisoned_count, countPoisoned("current"), "current window");
  assert.strictEqual(body.prior_window.excluded_poisoned_count, countPoisoned("prior"), "prior window");
});

test("search adds the prior window only on opt-in, counting its rows under the same filters, poisoned rows included", async () => {
  const countAttention = (window: ExpectedWindow): number =>
    SEED_ROWS.filter((r) => r.window === window && ATTENTION_RESULTS.has(r.result)).length;
  const { statusCode, body } = await fetchSearch(`days=${WINDOW_DAYS}&needs_attention=true&prior_window=1`);
  assert.strictEqual(statusCode, 200);
  assert.ok(body.prior_window, "prior_window present when requested");
  assert.strictEqual(body.total, countAttention("current"), "current attention count");
  assert.strictEqual(body.prior_window.total, countAttention("prior"), "prior attention count");

  const [anchor] = await getPrisma().$queryRaw<Array<{ start: string; end: string }>>`
    SELECT to_char(CURRENT_DATE - ${WINDOW_DAYS * 2}::int, 'YYYY-MM-DD') AS start,
           to_char(CURRENT_DATE - ${WINDOW_DAYS}::int, 'YYYY-MM-DD') AS end
  `;
  assert.ok(anchor);
  assert.deepStrictEqual(
    [body.prior_window.period_start, body.prior_window.period_end],
    [anchor.start, anchor.end],
    "same period bounds as the cross-analysis prior window",
  );

  const { body: plainBody } = await fetchSearch(`days=${WINDOW_DAYS}&needs_attention=true`);
  assert.deepStrictEqual(Object.keys(plainBody).sort(), ["fetched_at", "filter", "rows", "total"], "shape without opt-in");
});

test("search rejects prior_window on the unbounded days=all window with 400", async () => {
  const { statusCode } = await fetchSearch("days=all&prior_window=1");
  assert.strictEqual(statusCode, 400);
});
