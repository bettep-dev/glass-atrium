// Integration + derivation tests for /api/health/daemon-payload run summaries: the
// per-run verdict and distinct failure reasons a collapsed row states without the
// client re-reading the raw payload.
// Runner: npx tsx --test test/health-detail.daemon-payload.route.test.ts
// DB: real Postgres (read-only) — route assertions cross-check against DB ground truth;
// derivation fixtures are verbatim shapes of stored autoagent/wiki rows.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { deriveRunSummary, registerHealthDetailRoutes } from "../src/server/routes/health-detail.js";
import type { DaemonRunSummary } from "../src/server/types/health-detail.js";

const WINDOW = 30;

interface PayloadBody {
  daemon: string;
  entries: Array<{
    run_date: string;
    daemon_name: string;
    payload: unknown;
    payload_size_bytes: number;
    summary: DaemonRunSummary;
  }>;
  timezone: string;
}

let app: FastifyInstance;

before(async () => {
  app = Fastify({ logger: false });
  await registerHealthDetailRoutes(app);
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

async function getPayloads(daemon: string): Promise<PayloadBody> {
  const res = await app.inject({
    method: "GET",
    url: `/api/health/daemon-payload?daemon=${daemon}&limit=${WINDOW}`,
  });
  assert.strictEqual(res.statusCode, 200);
  return res.json() as PayloadBody;
}

// The autoagent quota outage shape: one reason repeated across every rejected patch,
// alongside a failing doctor block on the same cycle.
const QUOTA_REASON = "haiku quota limit detected (returncode=1)";
const quotaPayload = {
  cycle_date: "2026-08-21",
  patches: Array.from({ length: 5 }, () => ({
    status: "rejected",
    error: QUOTA_REASON,
    haiku_status: "quota_exceeded",
  })),
  doctor: { rc: 1, verdict: "fail", checked_at: "2026-08-21T19:35:37Z" },
  patterns_processed: 5,
};

// Same outage, next cycle: doctor still fails while no patch carries an error at all.
const doctorOnlyPayload = {
  cycle_date: "2026-08-22",
  patches: [
    { status: "pending", error: "" },
    { status: "pending", error: "" },
  ],
  doctor: { rc: 1, verdict: "fail", checked_at: "2026-08-22T19:51:11Z" },
};

// Wiki shape: per-compilation reasons, plus the routine cost-guard drain notice that
// sits under dedup_proposals on nearly every run and is not a run failure.
const WIKI_REASON = "proposal failed: haiku-exit-1";
const wikiPayload = {
  cycle_date: "2026-08-22",
  compilations: Array.from({ length: 7 }, () => ({ error: WIKI_REASON, raw_path: "raw/x.md" })),
  deadlink_errors: [],
  true_backlog: 9,
  dedup_proposals: {
    errors: ["cost-guard: LLM call limit 5 reached; 22 pairs not LLM-verified (drain next cycle)"],
    proposals: [],
  },
};

const cleanPayload = {
  cycle_date: "2026-08-25",
  compilations: [],
  deadlink_errors: [],
  true_backlog: 0,
};

function findSignature(summary: DaemonRunSummary, message: string): { message: string; count: number } | undefined {
  return summary.error_signatures.find((signature) => signature.message === message);
}

test("deriveRunSummary: a repeated patch reason collapses to one counted signature", () => {
  const summary = deriveRunSummary(quotaPayload);
  assert.strictEqual(summary.verdict, "fail");
  const quota = findSignature(summary, QUOTA_REASON);
  // The verbatim reason must survive — a rolled-up phrase alone does not satisfy the drilldown.
  assert.ok(quota, `expected the stored reason verbatim, got ${JSON.stringify(summary.error_signatures)}`);
  assert.strictEqual(quota.count, 5, "five rejected patches share one reason");
  assert.ok(
    summary.error_signatures.some((signature) => signature.message.includes("doctor")),
    "the failing doctor block is its own signature",
  );
});

test("deriveRunSummary: a failing doctor block alone still yields a fail verdict and a reason", () => {
  const summary = deriveRunSummary(doctorOnlyPayload);
  assert.strictEqual(summary.verdict, "fail", "a cycle whose only failure carrier is doctor is still a failure");
  assert.ok(summary.error_signatures.length >= 1, "the verdict must arrive with a reason, never bare");
  const [signature] = summary.error_signatures;
  assert.match(signature.message, /doctor/);
  assert.match(signature.message, /rc=1/, "the exit code is part of the reason");
});

test("deriveRunSummary: wiki compilation reasons count, the cost-guard drain notice does not", () => {
  const summary = deriveRunSummary(wikiPayload);
  assert.strictEqual(summary.verdict, "fail");
  assert.deepStrictEqual(
    summary.error_signatures,
    [{ message: WIKI_REASON, count: 7 }],
    "a routine drain notice would read every wiki run as failing",
  );
});

test("deriveRunSummary: a clean payload is ok, a non-object payload is unknown", () => {
  assert.deepStrictEqual(deriveRunSummary(cleanPayload), { verdict: "ok", error_signatures: [] });
  assert.deepStrictEqual(deriveRunSummary(null), { verdict: "unknown", error_signatures: [] });
  assert.deepStrictEqual(deriveRunSummary("boom"), { verdict: "unknown", error_signatures: [] });
});

test("GET /api/health/daemon-payload: every entry carries a summary consistent with its verdict", async () => {
  for (const daemon of ["autoagent", "wiki"]) {
    const body = await getPayloads(daemon);
    for (const entry of body.entries) {
      assert.ok(entry.summary, `${daemon} ${entry.run_date} must carry a summary`);
      assert.ok(
        ["ok", "fail", "unknown"].includes(entry.summary.verdict),
        `unexpected verdict ${entry.summary.verdict}`,
      );
      assert.ok(Array.isArray(entry.summary.error_signatures));
      assert.strictEqual(
        entry.summary.verdict === "fail",
        entry.summary.error_signatures.length > 0,
        `${daemon} ${entry.run_date}: a fail verdict and its reasons are the same fact`,
      );
      for (const signature of entry.summary.error_signatures) {
        assert.ok(signature.message.length > 0, "an empty reason is not a reason");
        assert.ok(Number.isInteger(signature.count) && signature.count >= 1);
        // A failure the map can date: the reason travels with the run it belongs to.
        assert.match(entry.run_date, /^\d{4}-\d{2}-\d{2}$/);
      }
    }
  }
});

test("GET /api/health/daemon-payload: signatures match the stored payloads row for row", async () => {
  const prisma = getPrisma();
  for (const daemon of ["autoagent", "wiki"]) {
    const truth = await prisma.$queryRaw<Array<{ run_date: string; message: string; n: number }>>`
      WITH win AS (
        SELECT run_date, payload
        FROM core.daemon_run_payload
        WHERE daemon_name = ${daemon}::core."DaemonType"
        ORDER BY run_date DESC
        LIMIT ${WINDOW}
      )
      SELECT
        to_char(run_date, 'YYYY-MM-DD') AS run_date,
        btrim(e->>'error') AS message,
        COUNT(*)::int AS n
      FROM win,
        LATERAL jsonb_each(payload) AS kv(k, v),
        LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE '[]'::jsonb END) AS e
      WHERE jsonb_typeof(e) = 'object' AND NULLIF(btrim(e->>'error'), '') IS NOT NULL
      GROUP BY 1, 2
    `;

    const body = await getPayloads(daemon);
    const byDate = new Map(body.entries.map((entry) => [entry.run_date, entry.summary]));
    for (const row of truth) {
      const summary = byDate.get(row.run_date);
      assert.ok(summary, `${daemon} ${row.run_date} is inside the requested window`);
      const signature = findSignature(summary, row.message);
      assert.ok(signature, `${daemon} ${row.run_date} must surface ${JSON.stringify(row.message)}`);
      assert.strictEqual(signature.count, row.n, `${daemon} ${row.run_date}: occurrence count matches the payload`);
      assert.strictEqual(summary.verdict, "fail");
    }
  }
});

test("GET /api/health/daemon-payload: a failing doctor block reaches the summary", async () => {
  const prisma = getPrisma();
  const truth = await prisma.$queryRaw<Array<{ run_date: string; rc: number }>>`
    WITH win AS (
      SELECT run_date, payload
      FROM core.daemon_run_payload
      WHERE daemon_name = 'autoagent'::core."DaemonType"
      ORDER BY run_date DESC
      LIMIT ${WINDOW}
    )
    SELECT to_char(run_date, 'YYYY-MM-DD') AS run_date, (payload->'doctor'->>'rc')::int AS rc
    FROM win
    WHERE payload ? 'doctor'
      AND (payload->'doctor'->>'verdict' <> 'ok' OR (payload->'doctor'->>'rc')::int <> 0)
  `;

  const body = await getPayloads("autoagent");
  const byDate = new Map(body.entries.map((entry) => [entry.run_date, entry.summary]));
  for (const row of truth) {
    const summary = byDate.get(row.run_date);
    assert.ok(summary, `${row.run_date} is inside the requested window`);
    assert.strictEqual(summary.verdict, "fail", `${row.run_date}: a failing doctor block is a failing run`);
    assert.ok(
      summary.error_signatures.some((signature) => signature.message.includes(`rc=${row.rc}`)),
      `${row.run_date}: the doctor exit code must be readable without expanding the payload`,
    );
  }
});
