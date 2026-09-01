// Loop-suppression breakdown on GET /api/improvement/learning-log.
//
// The superseded payload reported ONE of five suppression mechanisms. Measured over
// core.autoagent_loop_events per cycle day (2026-08-24..08-31): ~25 non-promptable
// intake skips, ~10 staleness skips and 5 roster mismatches for every 1 repeat-apply
// cap — and only the cap reached an operator, under a banner reading "Loop parked".
// Four mechanisms leave the row at status='identified', so the suppressed patterns
// also presented as pending backlog (measured: 28 of 47 identified rows carried a
// label the daemon skips at intake).
//
// What each test discriminates against:
//   - a single conflated total: every fixture seeds MULTIPLE causes with distinct
//     counts, so an implementation summing them returns a number matching no
//     assertion here;
//   - a parked/per-cycle merge: the two populations are seeded with deliberately
//     different shapes (a terminal row is not a recurrence), and summing them is
//     neither number;
//   - a pending count that ignores the label: the unpromptable fixtures sit beside
//     ordinary identified rows;
//   - the registry gate silently eating a parked row (F5): one fixture agent is
//     absent from the registry fixture on purpose.
//
// Hermetic registry — AGENT_REGISTRY_PATH points at a fixture holding only the two
// registered agents, so the third is off-registry by construction. That isolates the
// REGISTRY-GATED counts to this suite's rows exactly. The two deliberately UNGATED
// numbers (per-cycle events, off_registry_parked) cannot be isolated that way — the
// gate is what would have hidden their subject — so those are asserted as DELTAS
// against a pre-seed snapshot. A delta is the honest assertion for them: the counts
// are over a live shared table, and pinning an absolute would pin production state.
//
// DB: real Postgres. Skips gracefully when unreachable.
//
// Runner: npx tsx --test test/improvement.loop-suppression.route.test.ts

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

const SUITE_MARKER = `impr-suppress-${randomUUID().slice(0, 8)}`;
const AGENT_A = `${SUITE_MARKER}-a`;
const AGENT_B = `${SUITE_MARKER}-b`;
// Deliberately NOT in the registry fixture — the F5 subject.
const AGENT_OFF = `${SUITE_MARKER}-off`;

// Verbatim opening literals of the daemon's last_transition_reason stamps
// (daemon_cycle.py). Hardcoded so a daemon rewording goes red here rather than
// silently tracking the route's own copy.
const CAP_REASON = "repeat-apply cap: 3 applied proposals (cap 3) did NOT abate the signal";
const STREAK_REASON = "reject-streak snooze: 3 consecutive rejected proposals (threshold 3)";
const NON_AUTO_REASON = "non-auto-fixable: proposal modifies a line OUTSIDE every editable region";
// A terminal 'rejected' row whose reason matches no marker — the control proving the
// buckets classify rather than count status.
const OTHER_REASON = "superseded by a later pattern";

// daemon_cycle.py NON_PROMPTABLE_LABELS member, in "<label>|<agent>" signature form.
const UNPROMPTABLE_LABEL = "budget-overage concentration";
// The legacy Korean member of the same set. Seeded because the route stores it as a
// \u escape and a wrong escape decodes to a plausible-looking string that silently
// matches nothing.
const UNPROMPTABLE_LABEL_LEGACY = "동일 에이전트 반복 실패";
const PROMPTABLE_LABEL = "agent instruction-improvement candidate (failure rate)";

const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    [AGENT_A]: { domains: ["test"], phase: "implementation", dual_phase: false },
    [AGENT_B]: { domains: ["test"], phase: "implementation", dual_phase: false },
  },
};

interface SuppressionBucket {
  cause: string;
  label: string;
  count: number;
  agents: number;
  hint: string;
}

interface LoopSuppressionState {
  parked: SuppressionBucket[];
  per_cycle: SuppressionBucket[];
  per_cycle_window_days: number;
  pending_unpromptable: number;
  pending_total: number;
  off_registry_parked: number;
}

interface LearningLogBody {
  apply_cap_state: { capped_patterns: number };
  loop_suppression_state: LoopSuppressionState;
}

let app: FastifyInstance;
let tmpRoot: string;
let dbReady = false;
let body: LearningLogBody;
let baseline: LearningLogBody;

async function fetchState(): Promise<LearningLogBody> {
  const res = await app.inject({
    method: "GET",
    url: "/api/improvement/learning-log?limit=200",
  });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  return res.json() as LearningLogBody;
}

function bucket(list: SuppressionBucket[], cause: string): SuppressionBucket | undefined {
  return list.find((b) => b.cause === cause);
}

function count(list: SuppressionBucket[], cause: string): number {
  return bucket(list, cause)?.count ?? 0;
}

// Post-seed minus pre-seed for one per-cycle cause. The table is shared with the
// live loop, so only the delta belongs to this suite.
function cycleDelta(cause: string): number {
  return (
    count(body.loop_suppression_state.per_cycle, cause) -
    count(baseline.loop_suppression_state.per_cycle, cause)
  );
}

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "impr-suppress-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerImprovementRoutes(app);
  await app.ready();

  try {
    baseline = await fetchState();
    await seed();
    dbReady = true;
    body = await fetchState();
  } catch (error) {
    dbReady = false;
    console.error("[impr-suppress] DB seed failed — tests will skip:", error);
  }
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  if (dbReady) {
    const prisma = getPrisma();
    try {
      await prisma.$executeRaw`
        DELETE FROM core.learning_log WHERE pattern_signature LIKE ${`%${SUITE_MARKER}%`}
      `;
      await prisma.$executeRaw`
        DELETE FROM core.autoagent_loop_events WHERE agent LIKE ${`%${SUITE_MARKER}%`}
      `;
    } catch (error) {
      console.error("[impr-suppress cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

// Parked population: 2 caps (A, B) · 1 streak (A) · 1 non-auto-fixable (A) ·
// 1 unmarked control (A) · 1 cap on the OFF-registry agent.
// Pending population: 4 unpromptable-label rows (one legacy Korean) + 2 ordinary
// rows, all registered.
async function seed(): Promise<void> {
  const prisma = getPrisma();
  const rows: Array<{
    agent: string;
    status: string;
    reason: string | null;
    label: string;
  }> = [
    { agent: AGENT_A, status: "rejected", reason: CAP_REASON, label: PROMPTABLE_LABEL },
    { agent: AGENT_B, status: "rejected", reason: CAP_REASON, label: PROMPTABLE_LABEL },
    { agent: AGENT_A, status: "rejected", reason: STREAK_REASON, label: PROMPTABLE_LABEL },
    { agent: AGENT_A, status: "rejected", reason: NON_AUTO_REASON, label: PROMPTABLE_LABEL },
    { agent: AGENT_A, status: "rejected", reason: OTHER_REASON, label: PROMPTABLE_LABEL },
    { agent: AGENT_OFF, status: "rejected", reason: CAP_REASON, label: PROMPTABLE_LABEL },
    { agent: AGENT_A, status: "identified", reason: null, label: UNPROMPTABLE_LABEL },
    { agent: AGENT_A, status: "identified", reason: null, label: UNPROMPTABLE_LABEL },
    { agent: AGENT_B, status: "identified", reason: null, label: UNPROMPTABLE_LABEL },
    { agent: AGENT_B, status: "identified", reason: null, label: UNPROMPTABLE_LABEL_LEGACY },
    { agent: AGENT_A, status: "identified", reason: null, label: PROMPTABLE_LABEL },
    { agent: AGENT_B, status: "identified", reason: null, label: PROMPTABLE_LABEL },
  ];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    await prisma.$executeRaw`
      INSERT INTO core.learning_log
        (discovered_date, pattern_signature, frequency, agent, status, approval_tier,
         last_updated, last_transition_reason)
      VALUES
        (CURRENT_DATE,
         ${`${row.label}|${SUITE_MARKER}-${i}`},
         ${i + 1}::int,
         ${row.agent},
         ${row.status}::core."LearningStatus",
         'auto'::core."ApprovalTier",
         NOW(),
         ${row.reason})
    `;
  }

  // Per-cycle population. The dedup key is (event_ts, agent, eval_result), so a
  // recurrence is modelled as distinct days — which is exactly what it is.
  const events: Array<[string, string, number]> = [
    ["non-promptable", AGENT_A, 0],
    ["non-promptable", AGENT_A, 1],
    ["non-promptable", AGENT_B, 0],
    ["stale-pattern-skip", AGENT_A, 0],
    ["stale-unobserved-skip", AGENT_A, 0],
    ["stale-gate-unknown-family", AGENT_B, 0],
    ["roster-mismatch", AGENT_OFF, 0],
    // Not a suppression — the control that stops a "count every loop event"
    // implementation from passing.
    ["verified", AGENT_A, 0],
    ["reject", AGENT_A, 0],
  ];
  for (const [evalResult, agent, dayOffset] of events) {
    await prisma.$executeRaw`
      INSERT INTO core.autoagent_loop_events
        (event_ts, agent, eval_result, changes_added, changes_removed)
      VALUES (NOW() - make_interval(days => ${dayOffset}), ${agent}, ${evalResult}, 0, 0)
      ON CONFLICT DO NOTHING
    `;
  }
}

test("each parked cause is counted on its own, never as one total", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const parked = body.loop_suppression_state.parked;
  assert.strictEqual(bucket(parked, "repeat-apply-cap")?.count, 2, "2 capped rows");
  assert.strictEqual(bucket(parked, "reject-streak-snooze")?.count, 1, "1 streak row");
  assert.strictEqual(bucket(parked, "non-auto-fixable")?.count, 1, "1 non-auto-fixable row");
  // 2+1+1 = 4 — no bucket may carry the sum, which is what a conflated count returns.
  for (const b of parked) {
    if (b.cause === "other") continue;
    assert.notStrictEqual(b.count, 4, `bucket ${b.cause} carries the conflated total`);
  }
});

test("a terminal row whose reason matches no marker lands in its own bucket", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  // Status alone must not classify: the control row is 'rejected' like the rest.
  assert.strictEqual(bucket(body.loop_suppression_state.parked, "other")?.count, 1);
});

test("every parked bucket carries a distinct operator label and a remedy", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const named = body.loop_suppression_state.parked.filter((b) => b.cause !== "other");
  const labels = new Set(named.map((b) => b.label));
  assert.strictEqual(labels.size, named.length, "two causes sharing one label re-conflates them");
  for (const b of named) {
    assert.notStrictEqual(b.label, b.cause, `${b.cause} has no operator-facing label`);
    assert.ok(b.hint.length > 0, `${b.cause} has no remedy text`);
  }
});

test("per-cycle suppressions are reported apart from parked rows", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  assert.strictEqual(cycleDelta("non-promptable"), 3, "3 seeded recurrences");
  assert.strictEqual(cycleDelta("stale-pattern-skip"), 1);
  assert.strictEqual(cycleDelta("stale-unobserved-skip"), 1);
  // The cap parked 2 rows here and emitted NO event: an implementation merging the
  // two populations would move this delta off zero.
  assert.strictEqual(
    cycleDelta("repeat-apply-cap"),
    0,
    "a parked row is not a per-cycle recurrence",
  );
});

test("the per-cycle counts are not registry-gated, or roster-mismatch self-erases", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  // roster-mismatch is emitted precisely BECAUSE the agent is not a roster stem, so
  // applying the registry gate to this query would zero out the one bucket that
  // reports them — the count would silently exclude its own subject. The seeded
  // event is on AGENT_OFF, which the registry fixture deliberately omits.
  assert.strictEqual(
    cycleDelta("roster-mismatch"),
    1,
    "a registry-gated per-cycle query returns 0 here and reports the loop as clean",
  );
});

test("a per-cycle recurrence count is not an agent count", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  // 3 non-promptable events across 2 agents. Equal totals would mean the route is
  // reporting one number twice.
  const seen = bucket(body.loop_suppression_state.per_cycle, "non-promptable");
  assert.ok(seen, "the bucket must exist after seeding");
  assert.notStrictEqual(
    seen.count,
    seen.agents,
    "recurrences and agents are separate columns on the card",
  );
});

test("the loud unknown-family fail-open is surfaced, and named as not a drop", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  assert.strictEqual(cycleDelta("stale-gate-unknown-family"), 1, "the gate's own fail-open must be visible");
  const unknown = bucket(body.loop_suppression_state.per_cycle, "stale-gate-unknown-family");
  assert.match(
    unknown?.hint ?? "",
    /NOT a suppression/,
    "a kept-but-unjudged pattern read as suppressed would be a different lie",
  );
});

test("non-suppression loop events are never counted", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  // Seeded 'verified' and 'reject' events for the same agents in the same window.
  const causes = body.loop_suppression_state.per_cycle.map((b) => b.cause);
  assert.ok(!causes.includes("verified"), "'verified' is the loop working, not suppressed");
  assert.ok(!causes.includes("reject"), "a review reject is an adjudication, not a suppression");
});

test("pending rows that can never propose are separated from the backlog", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const s = body.loop_suppression_state;
  assert.strictEqual(s.pending_total, 6, "6 registered identified rows");
  assert.strictEqual(
    s.pending_unpromptable,
    4,
    "4 carry an intake-skipped label (one of them the legacy Korean member) — an " +
      "implementation counting all pending returns 6, one with a broken escape returns 3",
  );
  assert.notStrictEqual(
    s.pending_unpromptable,
    s.pending_total,
    "reporting the whole backlog as unpromptable is the opposite error",
  );
});

test("a parked pattern the registry gate hides is reported, not dropped (F5)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  assert.strictEqual(
    body.loop_suppression_state.off_registry_parked -
      baseline.loop_suppression_state.off_registry_parked,
    1,
    "the off-registry capped row is absent from every gated count and must be named",
  );
  assert.strictEqual(
    bucket(body.loop_suppression_state.parked, "repeat-apply-cap")?.count,
    2,
    "and it stays out of the gated bucket — the two numbers answer different questions",
  );
});

test("the window is reported alongside the per-cycle counts", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  assert.ok(
    body.loop_suppression_state.per_cycle_window_days > 0,
    "a recurrence count without its window is unreadable",
  );
});
