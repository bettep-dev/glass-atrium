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
import {
  DAEMON_CRON_SCHEDULE,
  STALE_MULTIPLIER,
  expectedIntervalMinutes,
} from "../src/server/schedule-next-fire.js";

const DAEMON_BOARD = [
  "autoagent",
  "wiki",
  "daily-restart-autoagent",
  "daily-restart-wiki",
] as const;

// One derivation covers the board: every DAEMON_BOARD entry is built as a daily-at rule.
const CADENCE_MIN = expectedIntervalMinutes(DAEMON_CRON_SCHEDULE.autoagent);
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

// The cases above feed rows=[], where the raw row value and the synthesized verdict cannot
// disagree. A PRESENT row is the only shape that separates them, so the delegation to
// resolveDaemonStatuses is pinned here — on both synthesis branches at once, plus a fresh row
// proving the board still publishes a real status rather than blanket-overwriting one, and a
// daemon no row mentions proving membership comes from DAEMON_BOARD rather than from the rows.
test("a present row publishes the synthesized status, never its own last_status — and a daemon with no row stays on the board (F#38 delegation)", () => {
  const rows = [
    // Overdue: the run itself ended 'ok' — the silence since is what makes the board stale.
    {
      daemon_name: "autoagent",
      last_run_at: minutesAgo(CADENCE_MIN * STALE_MULTIPLIER + 1),
      last_status: "ok",
    },
    // Row present, no run recorded: 'missing' comes from the anchor, not from the row.
    { daemon_name: "wiki", last_run_at: null, last_status: "ok" },
    // Inside the cadence window the row's own status IS the verdict.
    {
      daemon_name: "daily-restart-autoagent",
      last_run_at: minutesAgo(1),
      last_status: "quota_exceeded",
    },
  ];

  const items = buildDaemonStatusItems(rows, NOW, null);

  assert.strictEqual(
    itemOf(items, "autoagent").last_status,
    "stale",
    "an overdue row surfaced its raw last_status — the board leaks past the staleness synthesis " +
      "the architecture overlay + health board apply (the F#38 bug class this seam fixed)",
  );
  assert.strictEqual(
    itemOf(items, "wiki").last_status,
    "missing",
    "a row with no last_run_at surfaced its raw last_status — a daemon that never ran reads as " +
      "healthy on the dashboard while the other two boards call it missing",
  );
  assert.strictEqual(
    itemOf(items, "daily-restart-autoagent").last_status,
    "quota_exceeded",
    "an in-cadence row lost its real status — synthesis must replace a stale/missing verdict only, " +
      "never overwrite a fresh run's outcome",
  );
  assert.strictEqual(
    itemOf(items, "daily-restart-wiki").last_status,
    "missing",
    "a daemon with no row dropped off the board — the board is DAEMON_BOARD-driven, not rows-driven",
  );
});

test("every board item carries a next-fire schedule (dashboard-only field attached)", () => {
  const items = buildDaemonStatusItems([], NOW, null);
  for (const item of items) {
    assert.ok(item.expected_next_at !== null, `${item.daemon_name} carries expected_next_at`);
  }
});
