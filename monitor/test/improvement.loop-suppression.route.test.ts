// Loop-suppression breakdown on GET /api/improvement/learning-log.
//
// The superseded payload reported ONE of five suppression mechanisms. Measured over
// core.autoagent_loop_events per cycle day (2026-08-24..08-31): ~25 non-promptable
// intake skips, ~10 staleness skips and 5 roster mismatches for every 1 repeat-apply
// cap — and only the cap reached an operator, under a banner reading "Loop parked".
// Skipped rows stay at status='identified', so they also presented as pending backlog.
//
// What each test discriminates against:
//   - a single conflated total: every fixture seeds MULTIPLE causes with distinct
//     counts, so an implementation summing them returns a number matching no
//     assertion here;
//   - a parked/per-cycle merge: the two populations are seeded with deliberately
//     different shapes (a terminal row is not a recurrence), and summing them is
//     neither number;
//   - a pending count keyed on the retired label set: a keyed row carries a label
//     the set named, and a keyless row carries one it did not;
//   - a registry-gated pending count: one keyless fixture sits on the
//     off-registry agent, so a gated implementation is one short;
//   - the registry gate silently eating a parked row (F5): one fixture agent is
//     absent from the registry fixture on purpose;
//   - a dormant row leaving the board: dormant rows sit beside terminal and pending
//     rows, one per reason, one with no reason, one off-registry, one aged.
//
// Hermetic registry — AGENT_REGISTRY_PATH points at a fixture holding only the two
// registered agents, so the third is off-registry by construction. That isolates the
// REGISTRY-GATED counts to this suite's rows exactly. The deliberately UNGATED
// numbers (per-cycle events, off_registry_parked, the pending split, the dormant
// buckets) cannot be isolated that way — the gate is what would have hidden their
// subject — so those are asserted as DELTAS against a pre-seed snapshot. A delta is
// the honest assertion for them: the counts are over a live shared table, and pinning
// an absolute would pin production state.
//
// DB: real Postgres. The skip gate covers ONLY an unreachable/unprovisioned
// database — a route that answers non-200 reds this suite, because it is the
// sole guard on the route SQL and a self-skipping guard guards nothing. The
// schema-absent case reads a second database on the same server from
// MONITOR_TEST_LABEL_ABSENT_DATABASE_URL and skips when it is unset. That database is
// shared with the reject-buckets suite: every migration except 20261003000000
// ('unadjudicated') and 20261005000000 (metric_key, 'dormant').
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
import { LIVE_URL_ENV, TEST_URL_ENV, isSameDatabase, isSameServer } from "./lib/select-test-db.js";

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

// Dormant reasons as their writers compose them: learning-aggregator.py
// _put_pair_statuses (PAIR_REASON_PREFIX) and the daemon's roster-mismatch drop.
const PAIR_FAIL_REASON = "aggregator-pair fail: family emit rule, pair from 2026-09-21";
const PAIR_BASELINE_REASON =
  "aggregator-pair insufficient-baseline: budget_overage floor, pair from 2026-09-21";
const ROSTER_REASON = "roster-mismatch";

// Labels the retired NON_PROMPTABLE_LABELS set named. Seeded on KEYED rows, which the
// key rule admits — a label-keyed implementation marks them unpromptable.
const BUDGET_LABEL = "budget-overage concentration";
const EMIT_FAILURE_LABEL = "emit-failure concentration";
// Pattern-1's legacy Korean label, keyless.
const LEGACY_FAILURE_LABEL = "동일 에이전트 반복 실패";
// A discovery label the retired set never named, keyless.
const DISCOVERY_LABEL = "agent instruction-improvement candidate (failure rate)";

const LABEL_ABSENT_URL_ENV = "MONITOR_TEST_LABEL_ABSENT_DATABASE_URL";
const labelAbsentUrl = process.env[LABEL_ABSENT_URL_ENV];

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

interface ParkedPatternRow {
  id: number;
  pattern_signature: string;
  agent: string | null;
  status: string;
  discovered_date: string;
  intake_skipped: boolean;
  cause: string;
}

interface PatternRow {
  pattern_signature: string;
  intake_skipped: boolean;
}

interface LoopSuppressionState {
  parked: SuppressionBucket[];
  parked_patterns: ParkedPatternRow[];
  dormant: { buckets: SuppressionBucket[]; patterns: ParkedPatternRow[] };
  per_cycle: (SuppressionBucket & { cycles: number })[];
  per_cycle_window_days: number;
  per_cycle_window_cycles: number;
  pending_unpromptable: number;
  pending_total: number;
  off_registry_parked: number;
}

interface LearningLogBody {
  apply_cap_state: { capped_patterns: number };
  loop_suppression_state: LoopSuppressionState;
  patterns: PatternRow[];
}

interface SeedRow {
  agent: string;
  status: string;
  reason: string | null;
  label: string;
  metricKey: string | null;
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

// Same reasoning as cycleDelta: the dormant buckets are ungated.
function dormantDelta(cause: string): number {
  return (
    count(body.loop_suppression_state.dormant.buckets, cause) -
    count(baseline.loop_suppression_state.dormant.buckets, cause)
  );
}

// Same reasoning as cycleDelta: the pending split is ungated, so it counts the
// live table and only the delta belongs to this suite.
function pendingDelta(field: "pending_total" | "pending_unpromptable"): number {
  return body.loop_suppression_state[field] - baseline.loop_suppression_state[field];
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

  // The skip gate covers exactly ONE condition: no database available. Everything
  // past this probe — the seed and both route calls — propagates as a FAILURE.
  // This suite is the only guard on the new route SQL, so a gate wide enough to
  // catch a 500 would let a broken route report green by skipping itself.
  try {
    const prisma = getPrisma();
    await prisma.$queryRaw`SELECT 1 FROM core.learning_log LIMIT 1`;
    await prisma.$queryRaw`SELECT 1 FROM core.autoagent_loop_events LIMIT 1`;
    dbReady = true;
  } catch (error) {
    console.error(
      "[impr-suppress] Postgres unreachable or unprovisioned — tests will skip:",
      error,
    );
    return;
  }

  // Deliberately UNGUARDED. fetchState asserts 200, so a route regression reds
  // here rather than flipping the suite to skipped.
  baseline = await fetchState();
  await seed();
  body = await fetchState();
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
// Pending population: 4 keyless rows (one legacy Korean, one on the OFF-registry
// agent) + 2 keyed rows carrying labels the retired set named.
// Dormant population: 3 pair rows (one aged) · 1 roster-mismatch row on the
// OFF-registry agent · 1 unmarked reason · 1 with no reason.
const SEED_ROWS: SeedRow[] = [
  { agent: AGENT_A, status: "rejected", reason: CAP_REASON, label: DISCOVERY_LABEL, metricKey: null },
  { agent: AGENT_B, status: "rejected", reason: CAP_REASON, label: DISCOVERY_LABEL, metricKey: null },
  { agent: AGENT_A, status: "rejected", reason: STREAK_REASON, label: DISCOVERY_LABEL, metricKey: null },
  { agent: AGENT_A, status: "rejected", reason: NON_AUTO_REASON, label: DISCOVERY_LABEL, metricKey: null },
  { agent: AGENT_A, status: "rejected", reason: OTHER_REASON, label: DISCOVERY_LABEL, metricKey: null },
  { agent: AGENT_OFF, status: "rejected", reason: CAP_REASON, label: DISCOVERY_LABEL, metricKey: null },
  { agent: AGENT_A, status: "identified", reason: null, label: DISCOVERY_LABEL, metricKey: null },
  { agent: AGENT_B, status: "identified", reason: null, label: DISCOVERY_LABEL, metricKey: null },
  { agent: AGENT_B, status: "identified", reason: null, label: LEGACY_FAILURE_LABEL, metricKey: null },
  // Off-registry, and keyless all the same: the daemon's intake skip reads the key
  // and never consults the registry. A gated count drops this row.
  { agent: AGENT_OFF, status: "identified", reason: null, label: DISCOVERY_LABEL, metricKey: null },
  { agent: AGENT_A, status: "identified", reason: null, label: BUDGET_LABEL, metricKey: "budget_overage" },
  { agent: AGENT_B, status: "identified", reason: null, label: EMIT_FAILURE_LABEL, metricKey: "emit_failure" },
  { agent: AGENT_A, status: "dormant", reason: PAIR_FAIL_REASON, label: DISCOVERY_LABEL, metricKey: null },
  { agent: AGENT_B, status: "dormant", reason: PAIR_BASELINE_REASON, label: BUDGET_LABEL, metricKey: "budget_overage" },
  { agent: AGENT_A, status: "dormant", reason: PAIR_FAIL_REASON, label: LEGACY_FAILURE_LABEL, metricKey: null },
  { agent: AGENT_OFF, status: "dormant", reason: ROSTER_REASON, label: DISCOVERY_LABEL, metricKey: null },
  { agent: AGENT_A, status: "dormant", reason: "held by an operator", label: DISCOVERY_LABEL, metricKey: null },
  { agent: AGENT_B, status: "dormant", reason: null, label: DISCOVERY_LABEL, metricKey: null },
];

function seedSignature(index: number): string {
  return `${SEED_ROWS[index]!.label}|${SUITE_MARKER}-${index}`;
}

// The streak row and one pair row are aged out of the pattern list's 7-day
// discovery window on purpose — each is the discriminator for a window-free list.
const AGED_STREAK_INDEX = 2;
const AGED_DORMANT_INDEX = 14;

async function seed(): Promise<void> {
  const prisma = getPrisma();
  for (let i = 0; i < SEED_ROWS.length; i++) {
    const row = SEED_ROWS[i]!;
    await prisma.$executeRaw`
      INSERT INTO core.learning_log
        (discovered_date, pattern_signature, frequency, agent, status, approval_tier,
         last_updated, last_transition_reason, metric_key)
      VALUES
        (CURRENT_DATE,
         ${seedSignature(i)},
         ${i + 1}::int,
         ${row.agent},
         ${row.status}::core."LearningStatus",
         'auto'::core."ApprovalTier",
         NOW(),
         ${row.reason},
         ${row.metricKey}::core."MetricKey")
    `;
  }
  for (const index of [AGED_STREAK_INDEX, AGED_DORMANT_INDEX]) {
    await prisma.$executeRaw`
      UPDATE core.learning_log
      SET discovered_date = CURRENT_DATE - 60
      WHERE pattern_signature = ${seedSignature(index)}
    `;
  }

  // Per-cycle population. subject is left NULL, so these are census rows and the key
  // in play is the census arm (event_ts, agent, eval_result) WHERE subject IS NULL —
  // a recurrence is therefore modelled as distinct days, which is exactly what it is.
  const events: Array<[string, string, number]> = [
    ["no-metric-key", AGENT_A, 0],
    ["no-metric-key", AGENT_A, 1],
    ["no-metric-key", AGENT_B, 0],
    // The retired label skip's token — still in the window on an install that ran
    // the old daemon inside the last week.
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

test("per-cycle suppressions are reported apart from parked rows, with the window they cover", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  assert.strictEqual(cycleDelta("no-metric-key"), 3, "3 seeded recurrences of the key skip");
  assert.strictEqual(cycleDelta("non-promptable"), 1, "the retired token still in the window");
  assert.strictEqual(cycleDelta("stale-pattern-skip"), 1);
  assert.strictEqual(cycleDelta("stale-unobserved-skip"), 1);
  // The cap parked 2 rows here and emitted NO event: an implementation merging the
  // two populations would move this delta off zero.
  assert.strictEqual(
    cycleDelta("repeat-apply-cap"),
    0,
    "a parked row is not a per-cycle recurrence",
  );
  assert.ok(
    body.loop_suppression_state.per_cycle_window_days > 0,
    "a recurrence count without its window is unreadable",
  );
});

test("every per-cycle bucket a daemon token fills carries a distinct operator label and a remedy", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const buckets = body.loop_suppression_state.per_cycle;
  assert.ok(bucket(buckets, "no-metric-key"), "the key skip has a bucket");
  const labels = new Set(buckets.map((b) => b.label));
  assert.strictEqual(labels.size, buckets.length, "two tokens sharing one label re-conflates them");
  for (const b of buckets) {
    assert.notStrictEqual(b.label, b.cause, `${b.cause} has no operator-facing label`);
    assert.ok(b.hint.length > 0, `${b.cause} has no remedy text`);
  }
});

test("each per-cycle bucket reports its cycle coverage within the window's cycle days", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const state = body.loop_suppression_state;
  assert.ok(state.per_cycle_window_cycles >= 1, "seeded events put at least one cycle day in the window");
  for (const b of state.per_cycle) {
    assert.ok(b.cycles >= 1, `${b.cause} recurred on no cycle day`);
    assert.ok(b.cycles <= state.per_cycle_window_cycles, `${b.cause} covers more days than the window holds`);
    assert.ok(b.cycles <= b.count, `${b.cause} counts more cycle days than events`);
  }
});

test("the per-cycle counts are not registry-gated, or roster-mismatch self-erases", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  // roster-mismatch is emitted precisely BECAUSE the agent is not a real roster stem, so
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
  // 3 key-skip events across 2 agents. Equal totals would mean the route is
  // reporting one number twice.
  const seen = bucket(body.loop_suppression_state.per_cycle, "no-metric-key");
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

test("pending rows with no metric key are separated from the backlog", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  assert.strictEqual(pendingDelta("pending_total"), 6, "6 seeded identified rows — no dormant row");
  assert.strictEqual(
    pendingDelta("pending_unpromptable"),
    4,
    "4 carry no metric key (one on the off-registry agent) — an implementation counting " +
      "all pending returns 6, one keyed on the retired label set returns 2, one still " +
      "registry-gated returns 3",
  );
  assert.notStrictEqual(
    body.loop_suppression_state.pending_unpromptable,
    body.loop_suppression_state.pending_total,
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

// The rows this suite seeded, out of a payload counted over a shared live table.
function seededParked(): ParkedPatternRow[] {
  return body.loop_suppression_state.parked_patterns.filter((row) =>
    row.pattern_signature.includes(SUITE_MARKER),
  );
}

function seededDormant(): ParkedPatternRow[] {
  return body.loop_suppression_state.dormant.patterns.filter((row) =>
    row.pattern_signature.includes(SUITE_MARKER),
  );
}

function seededListed(): PatternRow[] {
  return body.patterns.filter((row) => row.pattern_signature.includes(SUITE_MARKER));
}

test("the parked rows themselves are returned, and no recency window hides them", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const mine = seededParked();
  assert.strictEqual(mine.length, 5, "the five registry-scoped parked rows");
  const aged = mine.find((row) => row.cause === "reject-streak-snooze");
  assert.ok(aged, "the row discovered 60 days ago is still parked, so it is still listed");
  // The discriminator: the same row is absent from the windowed pattern list, so a
  // parked list reusing that window returns four rows here and silently drops the
  // oldest parks — the ones most likely to be waiting on a human.
  assert.ok(
    !seededListed().some((row) => row.pattern_signature === aged.pattern_signature),
    "the windowed pattern list does not carry it — the parked list is the only path it has",
  );
  assert.ok(
    !mine.some((row) => row.agent === AGENT_OFF),
    "the parked list carries the registry gate its buckets carry",
  );
});

test("every parked row carries the bucket cause that counted it", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const mine = seededParked();
  const bucketCauses = new Set(body.loop_suppression_state.parked.map((b) => b.cause));
  for (const row of mine) {
    assert.ok(bucketCauses.has(row.cause), `row cause ${row.cause} matches no parked bucket`);
  }
  // Per-cause row counts equal the seeded shape, so an unclassified list (every row
  // tagged 'other', or the cause dropped entirely) fails rather than passing on length.
  const perCause = (cause: string): number => mine.filter((row) => row.cause === cause).length;
  assert.strictEqual(perCause("repeat-apply-cap"), 2, "2 capped rows");
  assert.strictEqual(perCause("non-auto-fixable"), 1, "1 non-auto-fixable row");
  assert.strictEqual(perCause("other"), 1, "the unmarked terminal row keeps its own bucket");
});

test("each dormant row is counted under the reason that moved it", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  assert.deepStrictEqual(
    [dormantDelta("aggregator-pair"), dormantDelta("roster-mismatch"), dormantDelta("other")],
    [3, 1, 2],
    "3 pair rows (keyed and keyless) · 1 roster mismatch · an unmarked reason and a missing " +
      "reason both in 'other'",
  );
  assert.strictEqual(
    count(body.loop_suppression_state.parked, "other"),
    1,
    "a dormant row is not terminal, so no parked bucket counts it",
  );
});

test("every dormant row stays on the board, whatever its age or agent", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const mine = seededDormant();
  assert.strictEqual(mine.length, 6, "all six dormant rows, the off-registry and the aged one included");
  assert.ok(
    mine.some((row) => row.agent === AGENT_OFF && row.cause === "roster-mismatch"),
    "a roster-mismatch row names an off-roster agent; a registry gate would drop it",
  );
  const aged = mine.find((row) => row.pattern_signature === seedSignature(AGED_DORMANT_INDEX));
  assert.ok(aged, "the row discovered 60 days ago is still dormant, so it is still listed");
  assert.ok(
    !seededListed().some((row) => row.pattern_signature === aged.pattern_signature),
    "the windowed pattern list does not carry it — the dormant list is the only path it has",
  );
  const bucketCauses = new Set(body.loop_suppression_state.dormant.buckets.map((b) => b.cause));
  for (const row of mine) {
    assert.strictEqual(row.status, "dormant");
    assert.ok(bucketCauses.has(row.cause), `row cause ${row.cause} matches no dormant bucket`);
  }
});

test("every dormant bucket carries a distinct operator label and a remedy", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const named = body.loop_suppression_state.dormant.buckets.filter((b) => b.cause !== "other");
  assert.ok(named.length >= 2, "the pair and roster-mismatch buckets are named");
  const labels = new Set(named.map((b) => b.label));
  assert.strictEqual(labels.size, named.length, "two causes sharing one label re-conflates them");
  for (const b of named) {
    assert.notStrictEqual(b.label, b.cause, `${b.cause} has no operator-facing label`);
    assert.ok(b.hint.length > 0, `${b.cause} has no remedy text`);
  }
});

test("list rows with no metric key are marked skipped at intake, and keyed ones are not", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const listed = seededListed();
  const keyless = listed.filter((row) =>
    SEED_ROWS.some((seedRow, i) => seedRow.metricKey === null && seedSignature(i) === row.pattern_signature),
  );
  const keyed = listed.filter((row) =>
    SEED_ROWS.some((seedRow, i) => seedRow.metricKey !== null && seedSignature(i) === row.pattern_signature),
  );
  assert.ok(keyless.length > 0 && keyed.length > 0, "both classes must be listed");
  for (const row of keyless) {
    assert.strictEqual(row.intake_skipped, true, `${row.pattern_signature} carries no metric key`);
  }
  for (const row of keyed) {
    assert.strictEqual(
      row.intake_skipped,
      false,
      `${row.pattern_signature} carries a key — the retired label set would have marked it`,
    );
  }
});

/**
 * Points the route's one DATABASE_URL at `url` for `read`, then restores it.
 * Same-server is not safety: the live database can share the test server, so the caller
 * refuses a `url` naming the live handle before swapping.
 */
async function withDatabase<T>(url: string, read: () => Promise<T>): Promise<T> {
  const prior = process.env.DATABASE_URL;
  await disconnectPrisma();
  process.env.DATABASE_URL = url;
  try {
    return await read();
  } finally {
    await disconnectPrisma();
    process.env.DATABASE_URL = prior;
  }
}

test(
  "the board answers on a database migrated without metric_key and 'dormant'",
  { skip: labelAbsentUrl ? false : `${LABEL_ABSENT_URL_ENV} unset — no schema-absent database to read` },
  async (t) => {
    if (!dbReady) return t.skip("DB unavailable");
    const testUrl = process.env[TEST_URL_ENV];
    const url = { absent: labelAbsentUrl, live: process.env[LIVE_URL_ENV] };
    assert.ok(testUrl && url.absent, "both database URLs are set");
    assert.ok(
      isSameServer(url.absent, testUrl),
      `${LABEL_ABSENT_URL_ENV} must name the server of ${TEST_URL_ENV}`,
    );
    assert.ok(
      !isSameDatabase(url.absent, testUrl),
      `${LABEL_ABSENT_URL_ENV} must name a database other than ${TEST_URL_ENV}`,
    );
    assert.ok(
      url.live === undefined || url.live.length === 0 || !isSameDatabase(url.absent, url.live),
      `${LABEL_ABSENT_URL_ENV} names the live database (${LIVE_URL_ENV}) — refusing to write there`,
    );
    await withDatabase(url.absent, async () => {
      const prisma = getPrisma();
      const schema = await prisma.$queryRaw<Array<{ has_label: boolean; has_column: boolean }>>`
        SELECT 'dormant' = ANY (enum_range(NULL::core."LearningStatus")::text[]) AS has_label,
               EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'core' AND table_name = 'learning_log'
                         AND column_name = 'metric_key') AS has_column
      `;
      assert.deepStrictEqual(
        [schema[0]?.has_label, schema[0]?.has_column],
        [false, false],
        "the database under test lacks the label and the column",
      );
      const start = await fetchState();
      try {
        await prisma.$executeRaw`
          INSERT INTO core.learning_log
            (discovered_date, pattern_signature, frequency, agent, status, approval_tier,
             last_updated)
          VALUES (CURRENT_DATE, ${`${DISCOVERY_LABEL}|${SUITE_MARKER}-absent`}, 1, ${AGENT_A},
                  'identified'::core."LearningStatus", 'auto'::core."ApprovalTier", NOW())
        `;
        const end = await fetchState();
        const moved = (field: "pending_total" | "pending_unpromptable"): number =>
          end.loop_suppression_state[field] - start.loop_suppression_state[field];
        assert.deepStrictEqual(
          [moved("pending_total"), moved("pending_unpromptable")],
          [1, 1],
          "with no key column every row is keyless, as the daemon's intake reads it",
        );
        assert.deepStrictEqual(end.loop_suppression_state.dormant.buckets, [], "no row can be dormant");
      } finally {
        await prisma.$executeRaw`
          DELETE FROM core.learning_log WHERE pattern_signature LIKE ${`%${SUITE_MARKER}%`}
        `;
      }
    });
  },
);
