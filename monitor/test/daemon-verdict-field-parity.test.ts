// Field-parity pin for the aligned daemon verdict: /api/architecture/live and
// /api/health/daemons must name the verdict identically and flip it at the one server
// threshold. Both halves live here — each route's overdue leg keys on cadence ×
// STALE_MULTIPLIER read from the shared schedule module, so a threshold change moves this
// file instead of leaving it behind, and the two verdicts are compared per input class
// rather than asserted separately.
// Runner: npx tsx --test test/daemon-verdict-field-parity.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  resolveDaemonStatuses,
  type DaemonAggRow,
} from "../src/server/architecture/live-overlay.js";
import {
  buildDaemonStatusCards,
  type DaemonRow,
} from "../src/server/routes/health-detail.js";
import {
  DAEMON_CRON_SCHEDULE,
  STALE_MULTIPLIER,
  expectedIntervalMinutes,
} from "../src/server/schedule-next-fire.js";

// The single name both routes carry — the consumer half pins this same literal.
const VERDICT_FIELD = "effective_status";

const DAEMON = "wiki";
const NOW = Date.parse("2026-07-12T12:00:00Z");
const CADENCE_MIN = expectedIntervalMinutes(DAEMON_CRON_SCHEDULE[DAEMON]);
const OVERDUE_MIN = CADENCE_MIN * STALE_MULTIPLIER;

function repoRead(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

function minutesAgo(min: number): Date {
  return new Date(NOW - min * 60_000);
}

function ranAt(minutesBack: number, lastStatus: string | null): DaemonAggRow[] {
  return [
    { daemon_name: DAEMON, last_run_at: minutesAgo(minutesBack), last_status: lastStatus },
  ];
}

function verdictOf(rows: DaemonAggRow[], installAnchor: Date | null = null): string {
  const found = resolveDaemonStatuses(rows, NOW, installAnchor).find(
    (d) => d.daemon_name === DAEMON,
  );
  assert.ok(found, `daemon '${DAEMON}' must be present in the resolved set`);
  return found[VERDICT_FIELD];
}

// The health card's row carries one column the live aggregate does not; both verdict legs
// read the same three.
function healthRows(rows: DaemonAggRow[]): DaemonRow[] {
  return rows.map((row) => ({ ...row, cost_guard_state: null }));
}

function cardVerdictOf(rows: DaemonAggRow[], installAnchor: Date | null = null): string {
  const found = buildDaemonStatusCards(
    healthRows(rows),
    new Date(NOW),
    installAnchor,
    false,
  ).find((card) => card.daemon_name === DAEMON);
  assert.ok(found, `daemon '${DAEMON}' must be present on the health board`);
  return found[VERDICT_FIELD];
}

test(`DaemonLiveStatus declares '${VERDICT_FIELD}' — the name the health card mirrors`, () => {
  const block = repoRead("src/server/types/architecture.ts").match(
    /export type DaemonLiveStatus = \{([\s\S]*?)\n\};/,
  );
  assert.ok(block, "types/architecture.ts must declare type DaemonLiveStatus");
  assert.match(
    block[1],
    new RegExp(`^\\s*${VERDICT_FIELD}:`, "m"),
    `a differently-named field is exactly the mismatch this suite exists to catch`,
  );
});

test("every resolved daemon carries a non-empty verdict (no null for a client to fill in)", () => {
  for (const daemon of resolveDaemonStatuses([], NOW, null)) {
    const verdict = daemon[VERDICT_FIELD];
    assert.strictEqual(typeof verdict, "string", `${daemon.daemon_name} verdict must be a string`);
    assert.notStrictEqual(verdict, "", `${daemon.daemon_name} verdict must not be empty`);
  }
});

test("verdict rule: overdue ⇒ 'stale' · within cadence ⇒ the reported status · none ⇒ 'missing'", () => {
  assert.strictEqual(verdictOf(ranAt(OVERDUE_MIN + 1, "ok")), "stale");
  assert.strictEqual(verdictOf(ranAt(60, "partial")), "partial");
  assert.strictEqual(verdictOf(ranAt(60, null)), "missing");
  assert.strictEqual(verdictOf([]), "missing");
});

test("never-fired past a full cadence window ⇒ 'stale'; inside it ⇒ 'missing'", () => {
  assert.strictEqual(verdictOf([], minutesAgo(CADENCE_MIN + 1)), "stale");
  assert.strictEqual(verdictOf([], minutesAgo(CADENCE_MIN - 1)), "missing");
});

test("the overdue flip point is cadence × STALE_MULTIPLIER, taken from the shared module", () => {
  assert.strictEqual(
    verdictOf(ranAt(OVERDUE_MIN, "ok")),
    "ok",
    "the boundary itself is not overdue (strict >)",
  );
  assert.strictEqual(verdictOf(ranAt(OVERDUE_MIN + 1, "ok")), "stale");
});

test("health-detail.ts takes the threshold from the same module instead of copying it", () => {
  const src = repoRead("src/server/routes/health-detail.ts");
  assert.match(
    src,
    /import\s*\{[^}]*\bSTALE_MULTIPLIER\b[^}]*\}\s*from\s*"\.\.\/schedule-next-fire\.js"/,
    "the health route must import the shared threshold",
  );
  assert.doesNotMatch(
    src,
    /\bconst\s+STALE_MULTIPLIER\b/,
    "a local copy would let the two routes call the same daemon overdue at different points",
  );
});

test(`DaemonStatusCard declares '${VERDICT_FIELD}' — the name the live status carries`, () => {
  const block = repoRead("src/server/types/health-detail.ts").match(
    /export interface DaemonStatusCard \{([\s\S]*?)\n\}/,
  );
  assert.ok(block, "types/health-detail.ts must declare interface DaemonStatusCard");
  assert.match(
    block[1],
    new RegExp(`^\\s*${VERDICT_FIELD}:`, "m"),
    "a differently-named field is exactly the mismatch this suite exists to catch",
  );
});

// The input classes that can pull the two routes apart: the overdue flip point in both
// directions, an unreported status, and the never-fired daemon whose escalation depends on
// the install anchor rather than on a staleness figure it does not have.
const VERDICT_CASES: ReadonlyArray<
  readonly [string, DaemonAggRow[], Date | null, string]
> = [
  ["overdue run", ranAt(OVERDUE_MIN + 1, "ok"), null, "stale"],
  ["the flip point itself", ranAt(OVERDUE_MIN, "ok"), null, "ok"],
  ["within cadence", ranAt(60, "partial"), null, "partial"],
  ["ran, status unreported", ranAt(60, null), null, "missing"],
  ["never fired, fresh install", [], null, "missing"],
  ["never fired past a full cadence window", [], minutesAgo(CADENCE_MIN + 1), "stale"],
];

test("both routes carry the same verdict for the same daemon in every input class", () => {
  for (const [label, rows, anchor, expected] of VERDICT_CASES) {
    assert.strictEqual(verdictOf(rows, anchor), expected, `${label}: live route`);
    assert.strictEqual(cardVerdictOf(rows, anchor), expected, `${label}: health card`);
  }
});

test("every health card carries a non-empty verdict (no null for a client to fill in)", () => {
  for (const card of buildDaemonStatusCards([], new Date(NOW), null, false)) {
    const verdict = card[VERDICT_FIELD];
    assert.strictEqual(typeof verdict, "string", `${card.daemon_name} verdict must be a string`);
    assert.notStrictEqual(verdict, "", `${card.daemon_name} verdict must not be empty`);
  }
});
