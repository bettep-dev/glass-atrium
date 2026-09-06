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

const DAEMON_BOARD = [
  "autoagent",
  "wiki",
  "daily-restart-autoagent",
  "daily-restart-wiki",
] as const;

const CADENCE_MIN = 1440; // all four daemons are daily jobs
const NOW = new Date("2026-07-12T12:00:00Z");

function minutesAgo(min: number): Date {
  return new Date(NOW.getTime() - min * 60_000);
}

function itemOf(items: ReturnType<typeof buildDaemonStatusItems>, name: string) {
  const found = items.find((i) => i.daemon_name === name);
  assert.ok(found, `daemon '${name}' must be present on the board`);
  return found;
}

test("never-reported daemon (zero rows) + null anchor → synthesized 'missing' (was raw null pre-fix)", () => {
  const items = buildDaemonStatusItems([], NOW, null);
  for (const name of DAEMON_BOARD) {
    const item = itemOf(items, name);
    assert.strictEqual(item.last_status, "missing", `${name} → 'missing'`);
    assert.strictEqual(item.last_run_at, null);
  }
});

test("never-fired daemon + old install anchor → board escalates to 'stale' (shares live-overlay anchor logic)", () => {
  const oldAnchor = minutesAgo(CADENCE_MIN + 1); // system older than one cadence
  const items = buildDaemonStatusItems([], NOW, oldAnchor);
  for (const name of DAEMON_BOARD) {
    assert.strictEqual(
      itemOf(items, name).last_status,
      "stale",
      `${name} installed-but-never-fired → crit on the board too`,
    );
  }
});

test("every board item carries a next-fire schedule (dashboard-only field attached)", () => {
  const items = buildDaemonStatusItems([], NOW, null);
  for (const item of items) {
    assert.ok(item.expected_next_at !== null, `${item.daemon_name} carries expected_next_at`);
  }
});
