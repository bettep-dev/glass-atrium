// T7 — reject-lifecycle bucket split on GET /api/improvement.
//
// A split keyed on the model-call status alone satisfies the infra/quality counts and is
// still wrong: every mechanically superseded row carries haiku_status 'ok', so it books as
// a substantive quality reject. Two control rows discriminate that implementation —
//   1. a supersede-marked row must land in the lifecycle bucket and leave quality flat;
//   2. an updater-written merge-resolution row must move no bucket and no total, which
//      mechanises the cross-plan provenance guard.
// A third control covers the population gate: a pending row is not a rejection, so a split
// taken over all proposals moves here.
//
// Assertions are deltas against the buckets observed BEFORE each insert, so live rows in
// the same window cannot make the suite pass or fail by accident.
//
// DB: real Postgres. Skips gracefully when unreachable.
//
// Runner: npx tsx --test test/improvement.reject-buckets.route.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { resetAgentRegistryCache } from "../src/server/agents/registry.js";
import { registerImprovementRoutes } from "../src/server/routes/improvement.js";

const SUITE_MARKER = `impr-rb-${randomUUID().slice(0, 8)}`;
const AGENT = `${SUITE_MARKER}-agent`;

// The updater's own pattern label — a merge-resolution row, not a daemon proposal.
const UPDATER_LABEL = "editable-region-resolved-release";

// Head of daemon_cycle.py's _SUPERSEDE_REASON, written verbatim here rather than imported:
// the route's own constant is the thing under test, so sharing it would let a drifted
// marker pass on both sides.
const SUPERSEDE_RATIONALE =
  "superseded by fresher per-agent proposal (current-file-anchored, previous calendar day data)";

const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    [AGENT]: { domains: ["test"], phase: "implementation", dual_phase: false },
  },
};

interface RejectBucketSummary {
  window_days: number;
  infra_count: number;
  quality_count: number;
  lifecycle_count: number;
  total: number;
}

let app: FastifyInstance;
let tmpRoot: string;
let dbReady = false;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "impr-rb-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerImprovementRoutes(app);
  await app.ready();

  try {
    // Connectivity probe — the seeding is per-test, so the gate cannot rely on it.
    await getPrisma().$queryRaw`SELECT 1`;
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[impr-rb] DB unavailable — tests will skip:", error);
  }
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  if (dbReady) {
    try {
      await getPrisma().$executeRaw`
        DELETE FROM core.autoagent_proposals WHERE target_agent = ${AGENT}
      `;
    } catch (error) {
      console.error("[impr-rb cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

interface ProposalFixture {
  tag: string;
  patternLabel?: string;
  status?: "rejected" | "pending";
  haikuStatus?: string | null;
  rationale?: string | null;
}

// Unique target_file per row avoids the (cycle_date, pattern_label, target_file) dedup
// collision. Defaults describe the common case: a daemon-authored rejected row.
async function insertProposal(fixture: ProposalFixture): Promise<void> {
  const {
    tag,
    patternLabel = `${SUITE_MARKER} ${tag}`,
    status = "rejected",
    haikuStatus = "ok",
    rationale = null,
  } = fixture;
  await getPrisma().$executeRaw`
    INSERT INTO core.autoagent_proposals
      (cycle_date, pattern_label, target_file, target_agent, classification,
       approval_tier, status, source_file, source_file_mtime, haiku_status, rationale)
    VALUES
      (CURRENT_DATE,
       ${patternLabel},
       ${`/__test__/${SUITE_MARKER}-${tag}.md`},
       ${AGENT},
       'apply'::core."ProposalClassification",
       'user'::core."ApprovalTier",
       CAST(${status} AS core."ProposalStatus"),
       '/__test__/source.md', 0,
       ${haikuStatus},
       ${rationale})
  `;
}

async function fetchBuckets(): Promise<RejectBucketSummary> {
  const res = await app.inject({ method: "GET", url: "/api/improvement?limit=200" });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  return (res.json() as { reject_bucket_summary: RejectBucketSummary })
    .reject_bucket_summary;
}

function delta(after: RejectBucketSummary, before: RejectBucketSummary): RejectBucketSummary {
  return {
    window_days: after.window_days,
    infra_count: after.infra_count - before.infra_count,
    quality_count: after.quality_count - before.quality_count,
    lifecycle_count: after.lifecycle_count - before.lifecycle_count,
    total: after.total - before.total,
  };
}

test("infra statuses land in the infra bucket, one row each", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const start = await fetchBuckets();
  await insertProposal({ tag: "quota-a", haikuStatus: "skipped:quota-limit" });
  await insertProposal({ tag: "quota-b", haikuStatus: "skipped:quota-limit" });
  await insertProposal({ tag: "transient", haikuStatus: "skipped:transient" });
  await insertProposal({ tag: "auth", haikuStatus: "skipped:auth" });
  const moved = delta(await fetchBuckets(), start);
  assert.strictEqual(moved.infra_count, 4, "quota 2 + transient 1 + auth 1");
  assert.strictEqual(moved.quality_count, 0, "an infra outcome is not a quality reject");
  assert.strictEqual(moved.lifecycle_count, 0, "nothing superseded here");
  assert.strictEqual(moved.total, 4, "the four rows are counted exactly once");
});

test("an ok model status lands in the quality bucket", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const start = await fetchBuckets();
  await insertProposal({ tag: "quality-a", rationale: "rule already covered by an existing bullet" });
  await insertProposal({ tag: "quality-b", haikuStatus: "ok:retried" });
  await insertProposal({ tag: "quality-c", haikuStatus: "ok:fuzzy-parsed" });
  const moved = delta(await fetchBuckets(), start);
  assert.strictEqual(moved.quality_count, 3, "every ok-prefixed status is a substantive reject");
  assert.strictEqual(moved.infra_count, 0, "no infra movement");
  assert.strictEqual(moved.lifecycle_count, 0, "no lifecycle movement");
});

test("a supersede-marked row lands in lifecycle, never in quality", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const start = await fetchBuckets();
  // Shaped as supersede_prior_pending_for_agent writes it: status 'rejected', an ok model
  // status, and the reason in the rationale. A pure haiku_status split books this as a
  // quality reject — the implementation this control exists to fail.
  await insertProposal({ tag: "supersede", rationale: SUPERSEDE_RATIONALE });
  const moved = delta(await fetchBuckets(), start);
  assert.strictEqual(moved.lifecycle_count, 1, "the mechanical row is booked as lifecycle");
  assert.strictEqual(moved.quality_count, 0, "the quality bucket must not absorb it");
  assert.strictEqual(moved.infra_count, 0, "nor the infra bucket");
  assert.strictEqual(moved.total, 1, "still one rejected row in the population");
});

test("an updater-written merge-resolution row moves no bucket", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const start = await fetchBuckets();
  await insertProposal({ tag: "updater", patternLabel: UPDATER_LABEL, haikuStatus: null });
  const moved = delta(await fetchBuckets(), start);
  assert.deepStrictEqual(
    [moved.infra_count, moved.quality_count, moved.lifecycle_count, moved.total],
    [0, 0, 0, 0],
    "release-day rows are not rejections and must leave every bucket flat",
  );
});

test("the provenance filter holds even when an updater row carries an ok status", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const start = await fetchBuckets();
  // Guards the filter itself rather than the incidental NULL status of today's rows.
  await insertProposal({ tag: "updater-ok", patternLabel: UPDATER_LABEL, haikuStatus: "ok" });
  const moved = delta(await fetchBuckets(), start);
  assert.deepStrictEqual(
    [moved.infra_count, moved.quality_count, moved.lifecycle_count, moved.total],
    [0, 0, 0, 0],
    "exclusion must key on row provenance, not on the status happening to be NULL",
  );
});

test("a pending proposal is outside the rejected population", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const start = await fetchBuckets();
  await insertProposal({ tag: "pending", status: "pending" });
  const moved = delta(await fetchBuckets(), start);
  assert.strictEqual(moved.total, 0, "a split taken over all proposals moves here");
});

test("the three buckets partition the total and the window is echoed", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const buckets = await fetchBuckets();
  assert.strictEqual(
    buckets.total,
    buckets.infra_count + buckets.quality_count + buckets.lifecycle_count,
    "total is the buckets summed — a row in none of them would break this",
  );
  assert.strictEqual(typeof buckets.window_days, "number", "window echoed");
});
