// Integration tests for /api/health/unpriced-models: the model ids cost-tracker priced
// without a pricing SoT row, derived from core.cost_events instead of an advisory write.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/health-detail.unpriced-models.route.test.ts
// DB: real Postgres test database — each test owns its rows (run-unique session + model ids).

import test, { after, before, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerHealthDetailRoutes } from "../src/server/routes/health-detail.js";
import { DAY_BUCKET_TIMEZONE } from "../src/server/timezone.js";
import type {
  HealthUnpricedModelsResponse,
  UnpricedModelEntry,
} from "../src/server/types/health-detail.js";

// The model-id facts every pricing copy derives on its own (skip list, loader fold) — the same
// table the hook, loader and roster-check suites read.
interface PricingParityTable {
  zero_cost_ids: Array<string | null>;
  rate_lookup_ids: string[];
  normalized_keys: Array<{ name: string; raw: string; key: string }>;
}
const PARITY = JSON.parse(
  readFileSync(new URL("../../hooks/test/fixtures/model-id-pricing-parity.json", import.meta.url), "utf8"),
) as PricingParityTable;

const DAY_MS = 86_400_000;
const RUN = randomUUID().slice(0, 8);
const PRICED_MODEL = `claude-s4priced-${RUN}`;

let app: FastifyInstance;
let pricingDir: string;
let pricingPath: string;
const previousPricingPath = process.env.PRICING_SOT_PATH;

before(async () => {
  pricingDir = await mkdtemp(path.join(tmpdir(), "unpriced-models-"));
  pricingPath = path.join(pricingDir, "pricing.json");
  const row = { input: 3.0, output: 15.0, cache_read: 0.3, cache_creation: 3.75 };
  await writeFile(pricingPath, JSON.stringify({ models: { [PRICED_MODEL]: row } }), "utf8");
  process.env.PRICING_SOT_PATH = pricingPath;
  app = Fastify({ logger: false });
  await registerHealthDetailRoutes(app);
  await app.ready();
});

after(async () => {
  if (previousPricingPath === undefined) delete process.env.PRICING_SOT_PATH;
  else process.env.PRICING_SOT_PATH = previousPricingPath;
  await app.close();
  await rm(pricingDir, { recursive: true, force: true });
  await disconnectPrisma();
});

interface FixtureRow {
  model: string | null;
  seenAt: Date;
  kind?: "turn" | "subagent";
}

// Rows are written as the hook writes them: event_date/event_time are the day-bucket
// wall clock of the instant, not UTC.
async function insertRows(t: TestContext, rows: FixtureRow[]): Promise<void> {
  const session = `s4-unpriced-${randomUUID()}`;
  t.after(async () => {
    await getPrisma().$executeRaw`DELETE FROM core.cost_events WHERE session_id = ${session}`;
  });
  for (const [i, row] of rows.entries()) {
    await getPrisma().$executeRaw`
      INSERT INTO core.cost_events
        (event_date, event_time, session_id, kind, dedup_key, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, num_turns,
         stop_reason, model, parse_error)
      VALUES ((${row.seenAt}::timestamptz AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date,
              (${row.seenAt}::timestamptz AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::time,
              ${session}, ${row.kind ?? "turn"}, ${`${session}-${i}`},
              1840, 312, 52000, 4100, 0.081234, 5400, 1, 'end_turn', ${row.model}, false)
    `;
  }
}

async function getUnpriced(query = ""): Promise<HealthUnpricedModelsResponse> {
  const res = await app.inject({ method: "GET", url: `/api/health/unpriced-models${query}` });
  assert.strictEqual(res.statusCode, 200, res.body);
  return res.json() as HealthUnpricedModelsResponse;
}

function findEntry(body: HealthUnpricedModelsResponse, model: string): UnpricedModelEntry | undefined {
  return body.models.find((entry) => entry.model === model);
}

function secondsAgo(seconds: number): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000 - seconds * 1000);
}

test("lists a model with no pricing row with its event count and newest event instant", async (t) => {
  const model = `claude-s4unpriced-${RUN}`;
  const newest = secondsAgo(3 * 3600);
  await insertRows(t, [
    { model, seenAt: secondsAgo(2 * 86400) },
    { model, seenAt: newest, kind: "subagent" },
    { model, seenAt: secondsAgo(5 * 3600) },
  ]);

  const body = await getUnpriced();

  assert.deepStrictEqual(findEntry(body, model), {
    model,
    event_count: 3,
    last_seen_at: newest.toISOString(),
  });
  assert.strictEqual(body.roster_available, true);
});

test("folds model ids the way the pricing loader does before matching the roster", async (t) => {
  const unpricedBase = `claude-s4fold-${RUN}`;
  const now = secondsAgo(60);
  await insertRows(t, [
    { model: `${PRICED_MODEL}[1m]`, seenAt: now },
    { model: `${PRICED_MODEL}-20261101`, seenAt: now },
    { model: `${unpricedBase}[1m]`, seenAt: now },
    { model: `${unpricedBase}-20261101`, seenAt: now },
    { model: unpricedBase, seenAt: now },
  ]);

  const body = await getUnpriced();

  const listed = body.models.map((entry) => entry.model);
  assert.ok(
    !listed.some((id) => id.startsWith(PRICED_MODEL)),
    `variants of a priced id resolve to its row and are not unpriced: ${listed.join(", ")}`,
  );
  assert.strictEqual(
    findEntry(body, unpricedBase)?.event_count,
    3,
    "bracket and snapshot-date variants count toward their base id",
  );
});

describe("folds each parity-table id to the pricing loader's key", () => {
  for (const row of PARITY.normalized_keys) {
    test(row.name, async (t) => {
      await insertRows(t, [{ model: row.raw, seenAt: secondsAgo(60) }]);

      const body = await getUnpriced("?limit=200");

      assert.ok(findEntry(body, row.key) !== undefined, `${row.raw} not listed as ${row.key}`);
      if (row.raw !== row.key) {
        assert.strictEqual(findEntry(body, row.raw), undefined, `${row.raw} listed unfolded`);
      }
    });
  }
});

test("never lists the ids cost-tracker prices at zero without a rate lookup, but lists their near misses", async (t) => {
  const now = secondsAgo(60);
  await insertRows(t, [
    ...PARITY.zero_cost_ids.map((model) => ({ model, seenAt: now })),
    ...PARITY.rate_lookup_ids.map((model) => ({ model, seenAt: now })),
  ]);

  const body = await getUnpriced("?limit=200");

  for (const nearMiss of PARITY.rate_lookup_ids) {
    assert.ok(findEntry(body, nearMiss) !== undefined, `near miss ${JSON.stringify(nearMiss)} not listed`);
  }
  for (const excluded of [...PARITY.zero_cost_ids.filter((id) => id !== null), "unknown"]) {
    assert.strictEqual(findEntry(body, excluded), undefined, `zero-cost id ${JSON.stringify(excluded)} listed`);
  }
  assert.ok(body.models.every((entry) => typeof entry.model === "string"), "no null model entry");
});

test("counts only events inside the requested days window", async (t) => {
  const model = `claude-s4window-${RUN}`;
  await insertRows(t, [{ model, seenAt: secondsAgo(10 * 86400) }]);

  const narrow = await getUnpriced("?days=7");
  const wide = await getUnpriced("?days=14");

  assert.strictEqual(narrow.days, 7);
  assert.strictEqual(findEntry(narrow, model), undefined, "a 10-day-old event is outside a 7-day window");
  assert.strictEqual(findEntry(wide, model)?.event_count, 1, "and inside a 14-day window");
});

test("caps the list at limit while model_count stays the uncapped total, newest first", async (t) => {
  const ids = [0, 1, 2].map((i) => `claude-s4cap${i}-${RUN}`);
  await insertRows(
    t,
    ids.map((model, i) => ({ model, seenAt: new Date(secondsAgo(60).getTime() - i * DAY_MS) })),
  );

  const full = await getUnpriced("?limit=200");
  const capped = await getUnpriced("?limit=1");

  assert.strictEqual(capped.limit, 1);
  assert.strictEqual(capped.models.length, 1);
  // Lower bound, not equality with `full`: sibling suites may add rows between the two reads.
  assert.ok(capped.model_count >= ids.length, `model_count ${capped.model_count} is the uncapped total`);
  const sorted = [...full.models].sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
  assert.deepStrictEqual(full.models, sorted, "entries are ordered newest event first");
  const fixtureOrder = full.models.map((entry) => entry.model).filter((id) => ids.includes(id));
  assert.deepStrictEqual(fixtureOrder, ids);
});

test("reports the roster unavailable instead of listing every model when the pricing file cannot be read", async (t) => {
  const model = `claude-s4noroster-${RUN}`;
  await insertRows(t, [{ model, seenAt: secondsAgo(60) }]);
  process.env.PRICING_SOT_PATH = path.join(pricingDir, "absent.json");
  t.after(() => {
    process.env.PRICING_SOT_PATH = pricingPath;
  });

  const body = await getUnpriced();

  assert.strictEqual(body.roster_available, false);
  assert.deepStrictEqual(body.models, []);
  assert.strictEqual(body.model_count, 0);
});

describe("rejects a days or limit value outside its bound with invalid_param", () => {
  const rows = [
    { name: "days off the allowlist", query: "?days=5", param: "days" },
    { name: "non-numeric days", query: "?days=abc", param: "days" },
    { name: "limit below 1", query: "?limit=0", param: "limit" },
    { name: "limit above the maximum", query: "?limit=201", param: "limit" },
    { name: "non-numeric limit", query: "?limit=x", param: "limit" },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const res = await app.inject({ method: "GET", url: `/api/health/unpriced-models${row.query}` });
      assert.strictEqual(res.statusCode, 400);
      assert.deepStrictEqual(res.json(), { error: "invalid_param", param: row.param });
    });
  }
});
