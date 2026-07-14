// Unit tests for live-overlay.ts resolveDaemonStatuses (F#38) — the pure row→status
// seam that aligns 'No data'/overdue semantics with health-detail. Proves: a never-
// reported daemon → 'missing' (info 'No data') on a fresh install; the SAME never-fired
// daemon escalates to 'stale' (crit 'Overdue') once the install anchor proves the system
// has run longer than one cadence window (installed-but-never-fired = genuinely dead);
// an overdue daemon (last run present, staleness > cadence × 1.5) → synthesized 'stale';
// a within-cadence daemon → its real last_status pass-through, unaffected by the anchor.
// Runner: npx tsx --test test/live-overlay.daemon-status.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveDaemonStatuses,
  type DaemonAggRow,
} from "../src/server/architecture/live-overlay.js";

const DAEMON_NAMES = [
  "autoagent",
  "wiki",
  "daily-restart-autoagent",
  "daily-restart-wiki",
] as const;

const CADENCE_MIN = 1440; // all four daemons are daily jobs
const STALE_MULTIPLIER = 1.5;
const NOW = Date.parse("2026-07-12T12:00:00Z");

function minutesAgo(min: number): Date {
  return new Date(NOW - min * 60_000);
}

function row(
  name: string,
  overrides: Partial<DaemonAggRow> = {},
): DaemonAggRow {
  return {
    daemon_name: name,
    last_run_at: minutesAgo(60),
    last_status: "ok",
    ...overrides,
  };
}

function statusOf(daemons: ReturnType<typeof resolveDaemonStatuses>, name: string) {
  const found = daemons.find((d) => d.daemon_name === name);
  assert.ok(found, `daemon '${name}' must be present in the resolved set`);
  return found;
}

test("never-reported daemon (zero rows) + null anchor → 'missing' with null timestamps (fresh-install-safe)", () => {
  const daemons = resolveDaemonStatuses([], NOW, null);
  assert.strictEqual(daemons.length, DAEMON_NAMES.length);
  for (const name of DAEMON_NAMES) {
    const d = statusOf(daemons, name);
    assert.strictEqual(d.status, "missing", `${name} should be 'missing'`);
    assert.strictEqual(d.last_run_at, null);
    assert.strictEqual(d.staleness_minutes, null);
  }
});

test("never-fired daemon + system older than one cadence (install anchor) → 'stale' (crit, genuinely dead)", () => {
  const anchor = minutesAgo(CADENCE_MIN + 1); // system first ran 1441 min ago > 1440 cadence
  const daemons = resolveDaemonStatuses([], NOW, anchor);
  for (const name of DAEMON_NAMES) {
    const d = statusOf(daemons, name);
    assert.strictEqual(
      d.status,
      "stale",
      `${name} never fired past its first full cadence → dead, must escalate to 'stale'`,
    );
    assert.strictEqual(d.last_run_at, null, "never ran → null last_run_at (no fabrication)");
    assert.strictEqual(d.staleness_minutes, null);
  }
});

test("never-fired daemon + fresh install (system younger than a cadence) → 'missing' (info 'No data')", () => {
  const anchor = minutesAgo(CADENCE_MIN - 1); // system only 1439 min old < cadence
  const daemons = resolveDaemonStatuses([], NOW, anchor);
  for (const name of DAEMON_NAMES) {
    assert.strictEqual(
      statusOf(daemons, name).status,
      "missing",
      `${name} on a fresh install must stay 'No data', not escalate to crit`,
    );
  }
});

test("install-anchor boundary: system age exactly one cadence is NOT dead (strict >)", () => {
  const anchor = minutesAgo(CADENCE_MIN); // exactly 1440, not > 1440
  const daemons = resolveDaemonStatuses([], NOW, anchor);
  assert.strictEqual(statusOf(daemons, "autoagent").status, "missing");
});

test("a firing daemon is unaffected by the install anchor (only never-fired daemons escalate)", () => {
  const oldAnchor = minutesAgo(CADENCE_MIN * 10); // long-running system
  const overdueMin = CADENCE_MIN * STALE_MULTIPLIER + 1;
  const daemons = resolveDaemonStatuses(
    [
      row("autoagent", { last_run_at: minutesAgo(60), last_status: "ok" }),
      row("wiki", { last_run_at: minutesAgo(overdueMin), last_status: "ok" }),
    ],
    NOW,
    oldAnchor,
  );
  // within-cadence firing daemon → real status, NOT escalated by the old anchor
  assert.strictEqual(statusOf(daemons, "autoagent").status, "ok");
  // overdue firing daemon → 'stale' via the staleness path (not the never-fired anchor path)
  assert.strictEqual(statusOf(daemons, "wiki").status, "stale");
  // a daemon absent from rows (never fired) still escalates under the old anchor
  assert.strictEqual(statusOf(daemons, "daily-restart-autoagent").status, "stale");
});

test("daemon with a NULL last_run_at row + null anchor → 'missing' (no fabricated staleness)", () => {
  const daemons = resolveDaemonStatuses(
    [row("autoagent", { last_run_at: null, last_status: "ok" })],
    NOW,
    null,
  );
  const d = statusOf(daemons, "autoagent");
  assert.strictEqual(d.status, "missing");
  assert.strictEqual(d.staleness_minutes, null);
});

test("overdue daemon (staleness > cadence × 1.5) → synthesized 'stale' (crit 'Overdue')", () => {
  const overdueMin = CADENCE_MIN * STALE_MULTIPLIER + 1; // 2161 min
  const daemons = resolveDaemonStatuses(
    [row("wiki", { last_run_at: minutesAgo(overdueMin), last_status: "ok" })],
    NOW,
    null,
  );
  const d = statusOf(daemons, "wiki");
  assert.strictEqual(
    d.status,
    "stale",
    "an overdue daemon must surface 'stale' regardless of its real last_status",
  );
  assert.strictEqual(d.staleness_minutes, Math.floor(overdueMin));
});

test("within-cadence daemon → real last_status passes through (no 'stale' synthesis)", () => {
  const freshMin = CADENCE_MIN; // 1440 < 2160 threshold → within cadence
  const daemons = resolveDaemonStatuses(
    [row("autoagent", { last_run_at: minutesAgo(freshMin), last_status: "partial" })],
    NOW,
    null,
  );
  const d = statusOf(daemons, "autoagent");
  assert.strictEqual(d.status, "partial");
});

test("threshold boundary: exactly cadence × 1.5 is NOT overdue (strict >)", () => {
  const boundaryMin = CADENCE_MIN * STALE_MULTIPLIER; // 2160, not > 2160
  const daemons = resolveDaemonStatuses(
    [row("wiki", { last_run_at: minutesAgo(boundaryMin), last_status: "ok" })],
    NOW,
    null,
  );
  assert.strictEqual(statusOf(daemons, "wiki").status, "ok");
});

test("error/quota_exceeded within cadence pass through unchanged", () => {
  const daemons = resolveDaemonStatuses(
    [
      row("autoagent", { last_status: "error" }),
      row("wiki", { last_status: "quota_exceeded" }),
    ],
    NOW,
    null,
  );
  assert.strictEqual(statusOf(daemons, "autoagent").status, "error");
  assert.strictEqual(statusOf(daemons, "wiki").status, "quota_exceeded");
});

test("soft-deprecated daemon rows (health-check) are dropped — defense in depth", () => {
  const daemons = resolveDaemonStatuses(
    [row("health-check", { last_status: "ok" }), row("autoagent")],
    NOW,
    null,
  );
  assert.ok(
    !daemons.some((d) => d.daemon_name === "health-check"),
    "deprecated 'health-check' must never surface",
  );
  assert.strictEqual(daemons.length, DAEMON_NAMES.length);
});

test("every resolved daemon carries the server-declared cadence (no FE hardcode)", () => {
  const daemons = resolveDaemonStatuses([], NOW, null);
  for (const d of daemons) {
    assert.strictEqual(d.expected_cadence_minutes, CADENCE_MIN);
  }
});
