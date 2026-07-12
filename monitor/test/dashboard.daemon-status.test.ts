// Unit tests for dashboard.ts buildDaemonStatusItems — the DB-free seam proving the
// /api/dashboard/daemon-status board now routes through the shared resolveDaemonStatuses
// (live-overlay F#38) and therefore synthesizes the SAME 'missing'/'stale' semantics as
// the architecture overlay + health board, instead of leaking raw last_status. Pre-fix
// this dormant sibling returned the raw last_status with no missing/stale synthesis (the
// same bug class F#38 fixed in live-overlay).
// Runner: npx tsx --test test/dashboard.daemon-status.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildDaemonStatusItems } from "../src/server/routes/dashboard.js";
import type { DaemonAggRow } from "../src/server/architecture/live-overlay.js";

const DAEMON_BOARD = [
  "autoagent",
  "wiki",
  "daily-restart-autoagent",
  "daily-restart-wiki",
] as const;

const CADENCE_MIN = 1440; // all four daemons are daily jobs
const STALE_MULTIPLIER = 1.5;
const NOW = new Date("2026-07-12T12:00:00Z");

function minutesAgo(min: number): Date {
  return new Date(NOW.getTime() - min * 60_000);
}

function row(name: string, overrides: Partial<DaemonAggRow> = {}): DaemonAggRow {
  return {
    daemon_name: name,
    last_run_at: minutesAgo(60),
    last_status: "ok",
    ...overrides,
  };
}

function itemOf(items: ReturnType<typeof buildDaemonStatusItems>, name: string) {
  const found = items.find((i) => i.daemon_name === name);
  assert.ok(found, `daemon '${name}' must be present on the board`);
  return found;
}

test("board carries all four daemons in fixed order (route shape preserved)", () => {
  const items = buildDaemonStatusItems([], NOW);
  assert.deepStrictEqual(
    items.map((i) => i.daemon_name),
    [...DAEMON_BOARD],
  );
});

test("never-reported daemon (zero rows) → synthesized 'missing' (was raw null pre-fix)", () => {
  const items = buildDaemonStatusItems([], NOW);
  for (const name of DAEMON_BOARD) {
    const item = itemOf(items, name);
    assert.strictEqual(item.last_status, "missing", `${name} → 'missing'`);
    assert.strictEqual(item.last_run_at, null);
  }
});

test("NULL last_run_at row → 'missing' (no fabricated staleness)", () => {
  const items = buildDaemonStatusItems(
    [row("autoagent", { last_run_at: null, last_status: "ok" })],
    NOW,
  );
  assert.strictEqual(itemOf(items, "autoagent").last_status, "missing");
});

test("overdue daemon (staleness > cadence × 1.5) → synthesized 'stale' (was stale 'ok' pre-fix)", () => {
  const overdueMin = CADENCE_MIN * STALE_MULTIPLIER + 1; // 2161 min
  const items = buildDaemonStatusItems(
    [row("wiki", { last_run_at: minutesAgo(overdueMin), last_status: "ok" })],
    NOW,
  );
  assert.strictEqual(
    itemOf(items, "wiki").last_status,
    "stale",
    "an overdue daemon must surface 'stale' regardless of its real last_status",
  );
});

test("within-cadence daemon → real last_status passes through (no 'stale' synthesis)", () => {
  const items = buildDaemonStatusItems(
    [row("autoagent", { last_run_at: minutesAgo(CADENCE_MIN), last_status: "partial" })],
    NOW,
  );
  assert.strictEqual(itemOf(items, "autoagent").last_status, "partial");
});

test("every board item carries a next-fire schedule (dashboard-only field attached)", () => {
  const items = buildDaemonStatusItems([], NOW);
  for (const item of items) {
    assert.ok(item.expected_next_at !== null, `${item.daemon_name} carries expected_next_at`);
  }
});
