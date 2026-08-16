// T3a read half — per-target-agent prose-only-add rolling count on GET /api/improvement.
//
// The +1 on a true-verdict row closes nothing on its own: a count of all proposal rows
// satisfies it equally. The two negative controls are what discriminate them —
//   1. a FALSE verdict row must not move the count (verdict is read, not row presence);
//   2. an updater-written merge-resolution row must not move it (row provenance is
//      filtered), which mechanises the cross-plan provenance guard.
// A third control covers absence: a row whose axes carry only the compliance keys has
// no verdict at all, and absent is not false.
//
// Assertions are deltas against the count observed BEFORE each insert, so live rows in
// the same window cannot make the suite pass or fail by accident.
//
// DB: real Postgres. Skips gracefully when unreachable.
//
// Runner: npx tsx --test test/improvement.prose-only-add.route.test.ts

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

const SUITE_MARKER = `impr-poa-${randomUUID().slice(0, 8)}`;
const AGENT = `${SUITE_MARKER}-agent`;

// The updater's own pattern label — a merge-resolution row, not a daemon proposal.
const UPDATER_LABEL = "editable-region-resolved-release";

const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    [AGENT]: { domains: ["test"], phase: "implementation", dual_phase: false },
  },
};

interface ProseOnlyAddSummary {
  window_days: number;
  agents: Array<{ agent: string; count: number }>;
  total: number;
  truncation_caveat: string;
}

let app: FastifyInstance;
let tmpRoot: string;
let dbReady = false;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "impr-poa-registry-"));
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
    console.error("[impr-poa] DB unavailable — tests will skip:", error);
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
      console.error("[impr-poa cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

// axes: null → column NULL · object → jsonb. Unique target_file per row avoids the
// (cycle_date, pattern_label, target_file) dedup collision.
async function insertProposal(
  tag: string,
  patternLabel: string,
  axes: Record<string, boolean> | null,
): Promise<void> {
  const axesJson = axes === null ? null : JSON.stringify(axes);
  await getPrisma().$executeRaw`
    INSERT INTO core.autoagent_proposals
      (cycle_date, pattern_label, target_file, target_agent, classification,
       approval_tier, status, source_file, source_file_mtime, pre_verify_axes)
    VALUES
      (CURRENT_DATE,
       ${patternLabel},
       ${`/__test__/${SUITE_MARKER}-${tag}.md`},
       ${AGENT},
       'apply'::core."ProposalClassification",
       'user'::core."ApprovalTier",
       'pending'::core."ProposalStatus",
       '/__test__/source.md', 0,
       CAST(${axesJson} AS jsonb))
  `;
}

async function fetchSummary(): Promise<ProseOnlyAddSummary> {
  const res = await app.inject({ method: "GET", url: "/api/improvement?limit=200" });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  return (res.json() as { prose_only_add_summary: ProseOnlyAddSummary })
    .prose_only_add_summary;
}

function countFor(summary: ProseOnlyAddSummary): number {
  const row = summary.agents.find((a) => a.agent === AGENT);
  return row === undefined ? 0 : row.count;
}

test("a true-verdict row increments the agent's count by exactly one", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const before = countFor(await fetchSummary());
  await insertProposal("true", `${SUITE_MARKER} true`, {
    C1: true,
    C2: true,
    C3: true,
    C4: true,
    prose_only_add: true,
  });
  assert.strictEqual(
    countFor(await fetchSummary()),
    before + 1,
    "+1 on the true-verdict row",
  );
});

test("a false-verdict row does not move the count", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const before = countFor(await fetchSummary());
  await insertProposal("false", `${SUITE_MARKER} false`, {
    C1: true,
    C2: true,
    C3: true,
    C4: true,
    prose_only_add: false,
  });
  assert.strictEqual(
    countFor(await fetchSummary()),
    before,
    "a count of all proposal rows would move here — the verdict must be read",
  );
});

test("an updater-written merge-resolution row does not move the count", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const before = countFor(await fetchSummary());
  // Shaped as the updater emits it: constant pattern label, no pre-verify axes.
  await insertProposal("updater-noaxes", UPDATER_LABEL, null);
  assert.strictEqual(
    countFor(await fetchSummary()),
    before,
    "release-day rows must not move a daemon-activity count",
  );
});

test("the provenance filter holds even when an updater row carries a true verdict", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const before = countFor(await fetchSummary());
  // Guards the filter itself rather than the incidental NULL axes of today's rows: a
  // future updater that writes axes must still be excluded by pattern label alone.
  await insertProposal("updater-axes", UPDATER_LABEL, { prose_only_add: true });
  assert.strictEqual(
    countFor(await fetchSummary()),
    before,
    "exclusion must key on row provenance, not on the axes happening to be NULL",
  );
});

test("a row whose axes omit the verdict is not counted (absent is not false)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const before = countFor(await fetchSummary());
  await insertProposal("nokey", `${SUITE_MARKER} nokey`, {
    C1: true,
    C2: false,
    C3: true,
    C4: true,
  });
  assert.strictEqual(countFor(await fetchSummary()), before, "no key → no count");
});

test("the summary states the truncation caveat and echoes its window", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const summary = await fetchSummary();
  assert.ok(
    summary.truncation_caveat.length > 0,
    "the count is a floor and the payload must say so",
  );
  assert.strictEqual(typeof summary.window_days, "number", "window echoed");
  assert.strictEqual(
    summary.total,
    summary.agents.reduce((acc, r) => acc + r.count, 0),
    "total agrees with the per-agent rows",
  );
});
