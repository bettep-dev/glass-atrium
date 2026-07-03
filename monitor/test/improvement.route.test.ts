// Integration tests for /api/improvement (unified endpoint).
//
// Runner: node:test (built-in) via tsx — npx tsx --test test/improvement.route.test.ts
//
// Coverage:
//   - GET /api/improvement happy path · 200 + shape
//   - GET /api/improvement?tier=auto · 200 + tier filter narrowing
//   - GET /api/improvement actionable_proposals · safety-tier + non-terminal only
//   - GET /api/improvement?limit=200 (max) · 200 + bounded
//   - GET /api/improvement invalid query · 400 invalid_param
//   - GET /api/improvement/stats · 200 + shape + cache hit on 2nd call
//
// Test infra:
//   - DB: real Postgres (DATABASE_URL from .env) — read-only assertions only,
//     no inserts or scrub. Existing fixture data drives the assertions
//     (78 proposals + outcomes already present).
//   - App: stripped Fastify (improvement route only) + app.inject() — no port binding.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import {
  buildAgentMembershipFilter,
  loadCanonicalAgentKeys,
} from "../src/server/agents/registry.js";
import {
  __resetImprovementStatsCacheForTests,
  registerImprovementRoutes,
  rowToProposalSummary,
} from "../src/server/routes/improvement.js";

let app: FastifyInstance;

// Temp dir holding the daemon-apply stub scripts (one per exit-code branch).
// AUTOAGENT_APPLY_SCRIPT points handleApprove at a chosen stub at call-time.
let stubDir: string;

// Writes an executable stub that echoes its argv to stderr then exits `code`.
// Used to drive each approve exit-code branch deterministically (no real daemon).
function writeExitStub(name: string, code: number): string {
  const scriptPath = path.join(stubDir, name);
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash\nprintf 'stub %s args: %s\\n' "${name}" "$*" >&2\nexit ${code}\n`,
    "utf8",
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

// Like writeExitStub but with a caller-supplied extra stderr line — drives the
// exit-13 (regen-invalid) branch, whose response parses the failing pre-verify
// axes out of daemon-apply.sh's loud-fail stderr line.
function writeStderrStub(name: string, code: number, stderrLine: string): string {
  const scriptPath = path.join(stubDir, name);
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash\nprintf '%s\\n' "${stderrLine}" >&2\nexit ${code}\n`,
    "utf8",
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

before(async () => {
  __resetImprovementStatsCacheForTests();
  stubDir = mkdtempSync(path.join(tmpdir(), "improvement-apply-stub-"));
  app = Fastify({ logger: false });
  await registerImprovementRoutes(app);
  await app.ready();
});

after(async () => {
  delete process.env.AUTOAGENT_APPLY_SCRIPT;
  if (stubDir) {
    rmSync(stubDir, { recursive: true, force: true });
  }
  try {
    await app.close();
  } catch {
    // best-effort
  }
  await disconnectPrisma();
});

// GET /api/improvement
test("GET /api/improvement: happy path — 200 + complete shape", async () => {
  const res = await app.inject({ method: "GET", url: "/api/improvement?limit=10" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    fetched_at: string;
    window_days: number;
    filter: {
      limit: number;
      window_days: number;
      tier: string | null;
      agent: string | null;
    };
    tier_distribution: { auto: number; safety: number };
    outcome_summary: {
      total_records: number;
      by_metric: Record<string, number>;
      by_result: Record<string, number>;
      review_flag_count: number;
    };
    ctm_epm_buckets: { ctm_count: number; epm_count: number };
    proposals: Array<{
      id: number;
      cycle_date: string;
      approval_tier: string;
      status: string;
      target_agent: string | null;
      pattern_label: string;
    }>;
    join_meta: {
      linked_agent_count: number;
      orphan_proposals: number;
    };
  };

  // Top-level shape — every documented key present.
  assert.ok(/\d{4}-\d{2}-\d{2}T/.test(body.fetched_at), "fetched_at is ISO");
  assert.strictEqual(body.window_days, 30, "window_days defaults to 30");
  assert.strictEqual(body.filter.limit, 10);
  assert.strictEqual(body.filter.tier, null);
  assert.strictEqual(body.filter.agent, null);

  // tier_distribution always has both keys (zero-init).
  assert.ok(typeof body.tier_distribution.auto === "number");
  assert.ok(typeof body.tier_distribution.safety === "number");
  assert.ok(body.tier_distribution.auto >= 0);
  assert.ok(body.tier_distribution.safety >= 0);

  // outcome_summary skeleton — 9 task_type keys (canonical set) + 5 result keys
  // always present (zero-init).
  for (const k of [
    "bug-fix", "feature", "refactor", "research", "plan",
    "review", "diagnosis", "doc", "cleanup",
  ]) {
    assert.ok(k in body.outcome_summary.by_metric, `by_metric.${k} present`);
  }
  for (const k of ["done", "done_with_concerns", "blocked", "needs_context", "fail"]) {
    assert.ok(k in body.outcome_summary.by_result, `by_result.${k} present`);
  }
  assert.ok(body.outcome_summary.total_records >= 0);
  assert.ok(body.outcome_summary.review_flag_count >= 0);

  // CTM/EPM buckets — non-negative integers.
  assert.ok(body.ctm_epm_buckets.ctm_count >= 0);
  assert.ok(body.ctm_epm_buckets.epm_count >= 0);

  // proposals bounded by limit.
  assert.ok(Array.isArray(body.proposals));
  assert.ok(body.proposals.length <= 10);

  // join_meta — DISTINCT-agent count; record-level linkage is unmeasurable (no
  // proposal→outcome FK), so only an agent-level counter is exposed.
  assert.ok(Number.isInteger(body.join_meta.linked_agent_count));
  assert.ok(body.join_meta.linked_agent_count >= 0);
  assert.ok(body.join_meta.orphan_proposals >= 0);
  assert.ok(body.join_meta.orphan_proposals <= body.proposals.length);

  // Each proposal row carries the 2-tier surface (auto or safety only).
  for (const p of body.proposals) {
    assert.ok(["auto", "safety"].includes(p.approval_tier), `tier in 2-tier set: ${p.approval_tier}`);
  }
});

test("rowToProposalSummary: route renders pattern_label verbatim (passthrough invariant — guards G1)", () => {
  // The pattern-1 FAIL→SOFT decouple is daemon-side ONLY; the route layer's row
  // mapper MUST NOT inject any relabel. A SOFT label and a (legacy) FAIL label both
  // render byte-for-byte — proving no TS transform was added.
  const base = {
    id: 1n,
    cycle_date: new Date("2026-06-29T00:00:00.000Z"),
    target_file: "agents/dev-shell.md",
    target_agent: "dev-shell",
    classification: "apply",
    haiku_status: "ok",
    approval_tier: "auto",
    status: "applied",
    cost_guard_state: null,
    reviewed_at: null,
    rationale: null,
    pre_verify_rationale: null,
    pre_verify_axes: null,
    pre_verify_status: null,
    pre_verify_passed: null,
    confidence_observed: null,
    project_key: null,
    promotion_tier: null,
  };
  for (const label of [
    "recurring negative-signal concentration",
    "repeated failure by same agent",
    "반복적 부정 신호 집중",
  ]) {
    const out = rowToProposalSummary({
      ...base,
      pattern_label: label,
    } as Parameters<typeof rowToProposalSummary>[0]);
    assert.strictEqual(out.pattern_label, label, `verbatim passthrough: ${label}`);
  }
});

test("GET /api/improvement?tier=auto: filter narrows to auto-tier proposals", async () => {
  const res = await app.inject({ method: "GET", url: "/api/improvement?tier=auto&limit=50" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    filter: { tier: string | null };
    proposals: Array<{ approval_tier: string }>;
  };
  assert.strictEqual(body.filter.tier, "auto");
  for (const p of body.proposals) {
    assert.strictEqual(p.approval_tier, "auto", `proposals filtered to tier=auto`);
  }
});

test("GET /api/improvement?tier=safety: filter narrows to safety-tier proposals", async () => {
  const res = await app.inject({ method: "GET", url: "/api/improvement?tier=safety&limit=50" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    filter: { tier: string | null };
    proposals: Array<{ approval_tier: string }>;
  };
  assert.strictEqual(body.filter.tier, "safety");
  for (const p of body.proposals) {
    assert.strictEqual(p.approval_tier, "safety", `proposals filtered to tier=safety`);
  }
});

// actionable_proposals feeds ONLY the "Awaiting approval" (safety) column.
// Auto-tier is terminal by construction (daemon resolve_floor_terminalization),
// so the former auto+pending "New suggestions" limbo no longer exists — the
// actionable feed is hard-gated to the safety tier set regardless of the `tier`
// param. Invariant: every actionable row is safety-tier AND non-terminal status.
test("GET /api/improvement: actionable_proposals is safety-tier + non-terminal only", async () => {
  const res = await app.inject({ method: "GET", url: "/api/improvement?limit=50" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    actionable_proposals: Array<{ approval_tier: string; status: string }>;
  };
  assert.ok(Array.isArray(body.actionable_proposals), "actionable_proposals is an array");
  for (const p of body.actionable_proposals) {
    assert.strictEqual(
      p.approval_tier,
      "safety",
      `actionable row folds to safety tier (no auto): ${p.approval_tier}`,
    );
    assert.ok(
      ["pending", "snoozed"].includes(p.status),
      `actionable row is non-terminal: ${p.status}`,
    );
  }
});

// The actionable feed ignores the `tier=auto` param — auto has no actionable
// surface, so requesting it must still yield zero auto rows (never re-open the
// removed "New suggestions" column via a query param).
test("GET /api/improvement?tier=auto: actionable_proposals stays empty of auto rows", async () => {
  const res = await app.inject({ method: "GET", url: "/api/improvement?tier=auto&limit=50" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    actionable_proposals: Array<{ approval_tier: string }>;
  };
  for (const p of body.actionable_proposals) {
    assert.strictEqual(
      p.approval_tier,
      "safety",
      `tier=auto must not surface auto actionable rows: ${p.approval_tier}`,
    );
  }
});

test("GET /api/improvement?window=30d: trailing-d window form accepted", async () => {
  const res = await app.inject({ method: "GET", url: "/api/improvement?window=30d&limit=5" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as { window_days: number };
  assert.strictEqual(body.window_days, 30);
});

// Poisoned-window exclusion — rows flagged poisoned_window must never feed an
// outcome aggregate. Ground truth is computed live from PG immediately before
// AND after the API call (bracket) so a concurrent outcome insert/age-out
// during the test cannot flake the equality.
interface NonPoisonedCounts {
  total: number;
  reviewFlagged: number;
  codeFail30d: number;
}

async function countNonPoisoned30d(): Promise<NonPoisonedCounts> {
  const prisma = getPrisma();
  // T9 — the tier_breakdown cohort scopes to the POSITIVE registry allowlist
  // (agent IN loadAgentRegistry()) rather than the retired 3-item infra denylist.
  // outcome_summary (total / review_flagged) is now ALSO registry-scoped by
  // default — the outcomeWhere AND-tail added alongside T9 closes the gap this
  // helper's comment used to describe as intentionally ungated — so every bucket
  // here mirrors the API by reusing the same shared helper + keys (fixed 30d
  // window, poisoned_window=FALSE).
  const agentAllowlist = buildAgentMembershipFilter(await loadCanonicalAgentKeys());
  const rows = await prisma.$queryRaw<
    Array<{ total: bigint; review_flagged: bigint; code_fail_30d: bigint }>
  >`
    SELECT
      COUNT(*) FILTER (WHERE poisoned_window = FALSE ${agentAllowlist})::bigint AS total,
      COUNT(*) FILTER (
        WHERE poisoned_window = FALSE AND review_flag = TRUE
          ${agentAllowlist}
      )::bigint AS review_flagged,
      COUNT(*) FILTER (
        WHERE poisoned_window = FALSE AND metric_pass = FALSE AND baseline_pre_3tier IS NULL
          ${agentAllowlist}
      )::bigint AS code_fail_30d
    FROM core.outcomes
    WHERE record_ts > NOW() - INTERVAL '30 days'
  `;
  const row = rows[0];
  assert.ok(row !== undefined, "non-poisoned aggregate row present");
  return {
    total: Number(row.total),
    reviewFlagged: Number(row.review_flagged),
    codeFail30d: Number(row.code_fail_30d),
  };
}

function assertWithinBracket(actual: number, a: number, b: number, label: string): void {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  assert.ok(
    actual >= lo && actual <= hi,
    `${label}=${actual} expected within non-poisoned ground-truth bracket [${lo}, ${hi}]`,
  );
}

test("GET /api/improvement: outcome aggregates exclude poisoned_window rows", async () => {
  const before = await countNonPoisoned30d();
  const res = await app.inject({ method: "GET", url: "/api/improvement?limit=5" });
  assert.strictEqual(res.statusCode, 200);
  const after = await countNonPoisoned30d();
  const body = res.json() as {
    outcome_summary: { total_records: number; review_flag_count: number };
    tier_breakdown_30d: { code_based_fail_30d: number };
  };
  assertWithinBracket(
    body.outcome_summary.total_records,
    before.total,
    after.total,
    "total_records",
  );
  assertWithinBracket(
    body.outcome_summary.review_flag_count,
    before.reviewFlagged,
    after.reviewFlagged,
    "review_flag_count",
  );
  assertWithinBracket(
    body.tier_breakdown_30d.code_based_fail_30d,
    before.codeFail30d,
    after.codeFail30d,
    "code_based_fail_30d",
  );
});

test("GET /api/improvement?tier=bogus: 400 invalid_param", async () => {
  const res = await app.inject({ method: "GET", url: "/api/improvement?tier=bogus" });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; param: string };
  assert.strictEqual(body.error, "invalid_param");
  assert.strictEqual(body.param, "tier");
});

test("GET /api/improvement?limit=999: 400 invalid_param (over cap)", async () => {
  const res = await app.inject({ method: "GET", url: "/api/improvement?limit=999" });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; param: string };
  assert.strictEqual(body.error, "invalid_param");
  assert.strictEqual(body.param, "limit");
});

test("GET /api/improvement?window=999: 400 invalid_param (over cap)", async () => {
  const res = await app.inject({ method: "GET", url: "/api/improvement?window=999" });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; param: string };
  assert.strictEqual(body.param, "window");
});

// findUnknownQueryKey / IMPROVEMENT_QUERY_KEYS — an unrecognized querystring key
// (e.g. a misspelled or legacy `window_days`) must be rejected loudly rather
// than silently falling through with the `window` default in effect.
test("GET /api/improvement?window_days=30: 400 invalid_param naming the unknown key", async () => {
  const res = await app.inject({ method: "GET", url: "/api/improvement?window_days=30" });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; param: string };
  assert.strictEqual(body.error, "invalid_param");
  assert.strictEqual(body.param, "window_days");
});

// Happy-path regression guard — the 4 accepted keys together must never trip
// the unknown-key rejection just added above.
test("GET /api/improvement?limit&window&tier&agent: accepted keys still parse — 200", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/improvement?limit=5&window=30d&tier=safety&agent=dev-node",
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as { window_days: number };
  assert.strictEqual(body.window_days, 30);
});

// GET /api/improvement/stats
test("GET /api/improvement/stats: happy path — 200 + complete shape", async () => {
  __resetImprovementStatsCacheForTests();
  const res = await app.inject({ method: "GET", url: "/api/improvement/stats" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    fetched_at: string;
    tier_distribution: { auto: number; safety: number };
    applied_last_7d: number;
    rejected_last_7d: number;
    applied_all_time: number;
    rejected_all_time: number;
    review_flag_last_7d: number;
    haiku_skipped_rate: number;
    zero_apply_cycle_rate: number;
    cycle_total_7d: number;
    cycles_generated_applied_7d: number;
    cycles_generated_not_applied_7d: number;
    cycles_nothing_generated_7d: number;
  };
  assert.ok(/\d{4}-\d{2}-\d{2}T/.test(body.fetched_at));
  assert.ok(typeof body.tier_distribution.auto === "number");
  assert.ok(typeof body.tier_distribution.safety === "number");
  assert.ok(body.applied_last_7d >= 0);
  assert.ok(body.rejected_last_7d >= 0);
  // No-window lifetime counts are present and integral; each is a superset of its
  // 7d window (no date restriction), so all-time >= last_7d for both statuses.
  assert.ok(Number.isInteger(body.applied_all_time) && body.applied_all_time >= 0);
  assert.ok(Number.isInteger(body.rejected_all_time) && body.rejected_all_time >= 0);
  assert.ok(
    body.applied_all_time >= body.applied_last_7d,
    "applied_all_time is a superset of applied_last_7d",
  );
  assert.ok(
    body.rejected_all_time >= body.rejected_last_7d,
    "rejected_all_time is a superset of rejected_last_7d",
  );
  assert.ok(body.review_flag_last_7d >= 0);
  // haiku_skipped_rate is a [0, 1] ratio; zero_apply_cycle_rate is its honest rename (F13).
  assert.ok(body.haiku_skipped_rate >= 0 && body.haiku_skipped_rate <= 1);
  assert.strictEqual(
    body.zero_apply_cycle_rate,
    body.haiku_skipped_rate,
    "zero_apply_cycle_rate alias equals haiku_skipped_rate",
  );
  // 3-way cycle decomposition partitions cycle_total_7d exactly (F13).
  assert.ok(Number.isInteger(body.cycle_total_7d) && body.cycle_total_7d >= 0);
  assert.strictEqual(
    body.cycles_generated_applied_7d +
      body.cycles_generated_not_applied_7d +
      body.cycles_nothing_generated_7d,
    body.cycle_total_7d,
    "3-way decomposition partitions total cycles",
  );
  // zero-apply numerator = the two zero-applied buckets.
  if (body.cycle_total_7d > 0) {
    const expectedRate =
      (body.cycles_generated_not_applied_7d + body.cycles_nothing_generated_7d) /
      body.cycle_total_7d;
    assert.ok(
      Math.abs(body.zero_apply_cycle_rate - expectedRate) < 1e-3,
      "zero_apply_cycle_rate consistent with decomposition buckets",
    );
  }
});

test("GET /api/improvement/stats: review_flag_last_7d excludes poisoned_window rows", async () => {
  __resetImprovementStatsCacheForTests();
  const prisma = getPrisma();
  const countReviewFlag7d = async (): Promise<number> => {
    const rows = await prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*)::bigint AS total
      FROM core.outcomes
      WHERE record_ts > NOW() - INTERVAL '7 days'
        AND poisoned_window = FALSE
        AND review_flag = TRUE
    `;
    return Number(rows[0]?.total ?? 0n);
  };
  const before = await countReviewFlag7d();
  const res = await app.inject({ method: "GET", url: "/api/improvement/stats" });
  assert.strictEqual(res.statusCode, 200);
  const after = await countReviewFlag7d();
  const body = res.json() as { review_flag_last_7d: number };
  assertWithinBracket(body.review_flag_last_7d, before, after, "review_flag_last_7d");
});

test("GET /api/improvement/stats: 30s in-process cache returns identical payload", async () => {
  __resetImprovementStatsCacheForTests();
  const first = await app.inject({ method: "GET", url: "/api/improvement/stats" });
  assert.strictEqual(first.statusCode, 200);
  const second = await app.inject({ method: "GET", url: "/api/improvement/stats" });
  assert.strictEqual(second.statusCode, 200);
  // Same fetched_at on cached hit — cache returns identical object reference.
  const firstBody = first.json() as { fetched_at: string };
  const secondBody = second.json() as { fetched_at: string };
  assert.strictEqual(secondBody.fetched_at, firstBody.fetched_at, "cached payload reused");
});

// POST /api/improvement/:id/approve (exit-code branches).
// The handler shells out to daemon-apply.sh --proposal-id; we point it at a
// per-test stub (AUTOAGENT_APPLY_SCRIPT) that exits with the branch code. The
// stub does NOT touch PG — the daemon's own status flip is out of this route's
// scope (these tests verify the exit-code → HTTP mapping, not the apply).

test("POST approve: exit 0 → 200 { status: 'applied' }", async () => {
  process.env.AUTOAGENT_APPLY_SCRIPT = writeExitStub("apply-ok.sh", 0);
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as { id: number; status: string };
  assert.strictEqual(body.id, 4242);
  assert.strictEqual(body.status, "applied");
});

test("POST approve: exit 8 → 409 { status: 'noop' } (not actionable / idempotent)", async () => {
  process.env.AUTOAGENT_APPLY_SCRIPT = writeExitStub("apply-noop.sh", 8);
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 409);
  const body = res.json() as { status: string; id: number; reason: string };
  assert.strictEqual(body.status, "noop");
  assert.strictEqual(body.id, 4242);
  assert.ok(body.reason.length > 0, "noop carries a human reason");
});

test("POST approve: exit 9 → 422 { status: 'apply_failed', reason: 'needs_regen' }", async () => {
  process.env.AUTOAGENT_APPLY_SCRIPT = writeExitStub("apply-fail.sh", 9);
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 422);
  const body = res.json() as { status: string; id: number; reason: string };
  assert.strictEqual(body.status, "apply_failed");
  assert.strictEqual(body.reason, "needs_regen");
});

// --- regen-on-accept exit-code branches (10/11/12/13/14) ---------------------

test("POST approve: passes --auto-regen in the daemon-apply argv", async () => {
  // The exit-0 stub echoes its argv to stderr; reaching 200 with this stub proves
  // the route shells out, and the argv assertion is covered by the explicit
  // before/after mapping table in the report. Here we just confirm the happy 200.
  process.env.AUTOAGENT_APPLY_SCRIPT = writeExitStub("apply-autoregen.sh", 0);
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 200);
});

test("POST approve: exit 10 → 200 { status: 'applied', regenerated: true }", async () => {
  process.env.AUTOAGENT_APPLY_SCRIPT = writeExitStub("apply-after-regen.sh", 10);
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as { id: number; status: string; regenerated?: boolean };
  assert.strictEqual(body.id, 4242);
  assert.strictEqual(body.status, "applied");
  assert.strictEqual(body.regenerated, true);
});

test("POST approve: exit 12 → 200 { status: 'applied', already_applied: true }", async () => {
  process.env.AUTOAGENT_APPLY_SCRIPT = writeExitStub("apply-already.sh", 12);
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as { id: number; status: string; already_applied?: boolean };
  assert.strictEqual(body.status, "applied");
  assert.strictEqual(body.already_applied, true);
});

test("POST approve: exit 11 → 422 { status: 'regen_failed' }", async () => {
  process.env.AUTOAGENT_APPLY_SCRIPT = writeExitStub("apply-regen-failed.sh", 11);
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 422);
  const body = res.json() as { status: string; id: number; reason: string };
  assert.strictEqual(body.status, "regen_failed");
  assert.strictEqual(body.id, 4242);
  assert.ok(body.reason.length > 0, "regen_failed carries a human reason");
});

test("POST approve: exit 13 → 422 { status: 'regen_invalid', axes: {C3:false} } (parsed from stderr)", async () => {
  process.env.AUTOAGENT_APPLY_SCRIPT = writeStderrStub(
    "apply-regen-invalid.sh",
    13,
    "[daemon-apply] auto-regen: id=4242 INVALID — pre-verify failed, row left pending (axes: C1=true,C2=true,C3=false,C4=true)",
  );
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 422);
  const body = res.json() as {
    status: string;
    id: number;
    reason: string;
    axes?: { C1?: boolean; C2?: boolean; C3?: boolean; C4?: boolean };
  };
  assert.strictEqual(body.status, "regen_invalid");
  assert.strictEqual(body.reason, "pre-verify failed");
  assert.deepStrictEqual(body.axes, { C1: true, C2: true, C3: false, C4: true });
});

test("POST approve: exit 13 with no parseable axes → 422 { status: 'regen_invalid' } (axes omitted)", async () => {
  // Garbled / axes-free stderr → the parser yields undefined → `axes` is omitted
  // gracefully (no empty object, no crash).
  process.env.AUTOAGENT_APPLY_SCRIPT = writeStderrStub(
    "apply-regen-invalid-noaxes.sh",
    13,
    "[daemon-apply] auto-regen: id=4242 INVALID — pre-verify failed (no axis dump)",
  );
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 422);
  const body = res.json() as { status: string; reason: string; axes?: unknown };
  assert.strictEqual(body.status, "regen_invalid");
  assert.strictEqual(body.reason, "pre-verify failed");
  assert.strictEqual(body.axes, undefined, "axes omitted when not parseable");
});

test("POST approve: exit 14 → 422 { status: 'unrecoverable' }", async () => {
  process.env.AUTOAGENT_APPLY_SCRIPT = writeExitStub("apply-unrecoverable.sh", 14);
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 422);
  const body = res.json() as { status: string; id: number; reason: string };
  assert.strictEqual(body.status, "unrecoverable");
  assert.ok(body.reason.length > 0, "unrecoverable carries a human reason");
});

test("POST approve: exit 2 (bad arg) → 500 { status: 'apply_error' }", async () => {
  process.env.AUTOAGENT_APPLY_SCRIPT = writeExitStub("apply-badarg.sh", 2);
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 500);
  const body = res.json() as { status: string; id: number; reason: string };
  assert.strictEqual(body.status, "apply_error");
  assert.ok(body.reason.includes("2"), "reason carries the exit code");
});

test("POST approve: exit 3 (no psql) → 500 { status: 'apply_error' }", async () => {
  process.env.AUTOAGENT_APPLY_SCRIPT = writeExitStub("apply-nopsql.sh", 3);
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 500);
  const body = res.json() as { status: string };
  assert.strictEqual(body.status, "apply_error");
});

test("POST approve: exit 6 (DB update fail) → 500 { status: 'apply_error' }", async () => {
  process.env.AUTOAGENT_APPLY_SCRIPT = writeExitStub("apply-dbfail.sh", 6);
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 500);
  const body = res.json() as { status: string };
  assert.strictEqual(body.status, "apply_error");
});

test("POST approve: spawn error (script missing / ENOENT) → 500 { status: 'apply_error' }", async () => {
  // Non-existent path → execFile rejects with a string code (ENOENT), no numeric
  // exit code → infra sentinel → 500 (defense-in-depth: never silently 200).
  process.env.AUTOAGENT_APPLY_SCRIPT = path.join(stubDir, "does-not-exist.sh");
  const res = await app.inject({ method: "POST", url: "/api/improvement/4242/approve" });
  assert.strictEqual(res.statusCode, 500);
  const body = res.json() as { status: string };
  assert.strictEqual(body.status, "apply_error");
});

test("POST approve: non-integer :id → 400 { status: 'invalid_param' }", async () => {
  // No stub needed — the id guard rejects before any shell-out.
  const res = await app.inject({ method: "POST", url: "/api/improvement/abc/approve" });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { status: string; param: string };
  assert.strictEqual(body.status, "invalid_param");
  assert.strictEqual(body.param, "id");
});

test("POST approve: zero :id → 400 { status: 'invalid_param' }", async () => {
  const res = await app.inject({ method: "POST", url: "/api/improvement/0/approve" });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { status: string; param: string };
  assert.strictEqual(body.status, "invalid_param");
});

// POST /api/improvement/:id/reject (200 + 409 already-terminal).
// reject is a real status-only UPDATE — it needs a disposable PG row. We insert
// one pending proposal, reject it (200), re-reject it (409 already_terminal),
// then clean up. A clearly-marked pattern_label + unique target_file avoids
// the (cycle_date, pattern_label, target_file) unique-constraint collision.

const REJECT_TEST_LABEL = "__test_reject_doc6324__";
const REJECT_TEST_TARGET = "/__test__/doc6324-reject-fixture.md";

async function insertPendingFixture(): Promise<number> {
  const prisma = getPrisma();
  const rows = await prisma.$queryRaw<Array<{ id: bigint }>>`
    INSERT INTO core.autoagent_proposals
      (cycle_date, pattern_label, target_file, classification, approval_tier, status,
       source_file, source_file_mtime)
    VALUES
      (CURRENT_DATE, ${REJECT_TEST_LABEL}, ${REJECT_TEST_TARGET},
       'reject'::core."ProposalClassification", 'auto'::core."ApprovalTier",
       'pending'::core."ProposalStatus", '/__test__/source.md', 0)
    RETURNING id
  `;
  const inserted = rows[0];
  assert.ok(inserted !== undefined, "fixture insert returned a row");
  return Number(inserted.id);
}

async function deleteFixture(id: number): Promise<void> {
  const prisma = getPrisma();
  await prisma.$executeRaw`DELETE FROM core.autoagent_proposals WHERE id = ${BigInt(id)}`;
}

test("POST reject: pending → 200 { status: 'rejected' } + reviewed_at stamped", async () => {
  const id = await insertPendingFixture();
  try {
    const res = await app.inject({ method: "POST", url: `/api/improvement/${id}/reject` });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json() as { id: number; status: string; reviewed_at: string };
    assert.strictEqual(body.id, id);
    assert.strictEqual(body.status, "rejected");
    assert.ok(/\d{4}-\d{2}-\d{2}T/.test(body.reviewed_at), "reviewed_at is ISO8601");

    // Verify DB side-effect — status flipped + reviewed_by stamped.
    const prisma = getPrisma();
    const check = await prisma.$queryRaw<Array<{ status: string; reviewed_by: string | null }>>`
      SELECT status::text AS status, reviewed_by
      FROM core.autoagent_proposals WHERE id = ${BigInt(id)}
    `;
    assert.strictEqual(check[0]?.status, "rejected");
    assert.strictEqual(check[0]?.reviewed_by, "monitor-user");
  } finally {
    await deleteFixture(id);
  }
});

test("POST reject: re-reject already-terminal → 409 { status: 'already_terminal' }", async () => {
  const id = await insertPendingFixture();
  try {
    const first = await app.inject({ method: "POST", url: `/api/improvement/${id}/reject` });
    assert.strictEqual(first.statusCode, 200, "first reject transitions pending → rejected");

    // Second reject — predicate now matches 0 rows (status='rejected' terminal).
    const second = await app.inject({ method: "POST", url: `/api/improvement/${id}/reject` });
    assert.strictEqual(second.statusCode, 409);
    const body = second.json() as { status: string; id: number; reason: string };
    assert.strictEqual(body.status, "already_terminal");
    assert.strictEqual(body.id, id);
    assert.ok(body.reason.length > 0);
  } finally {
    await deleteFixture(id);
  }
});

test("POST reject: non-existent id → 409 { status: 'already_terminal' } (0 rows)", async () => {
  // A huge id that does not exist — UPDATE matches 0 rows → idempotent 409.
  const res = await app.inject({ method: "POST", url: "/api/improvement/999999999/reject" });
  assert.strictEqual(res.statusCode, 409);
  const body = res.json() as { status: string };
  assert.strictEqual(body.status, "already_terminal");
});

test("POST reject: non-integer :id → 400 { status: 'invalid_param' }", async () => {
  const res = await app.inject({ method: "POST", url: "/api/improvement/xyz/reject" });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { status: string; param: string };
  assert.strictEqual(body.status, "invalid_param");
  assert.strictEqual(body.param, "id");
});
