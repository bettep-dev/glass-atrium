// End-to-end pin for the core.DaemonStatus enum across the surfaces a running system
// reads: its migration, the three route narrowing sets, and the ui.jsx tone table, all
// compared against the Prisma schema as the SoT. A value added on one surface only is the
// failure this suite exists to catch — an unnarrowed value silently becomes null, and an
// untoned value renders as a raw enum token at an info tone (quieter than the state it
// reports). The route sets and the tone table are read as the values that ship, never as
// source text. Compile-time-only surfaces are left to the typecheck job.
// Runner: npx tsx --test test/daemon-status.enum-parity.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildDaemonStatusItems,
  KNOWN_DAEMON_STATUSES as dashboardStatuses,
} from "../src/server/routes/dashboard.js";
import {
  deriveNeedsAuth,
  KNOWN_DAEMON_STATUSES as healthDetailStatuses,
} from "../src/server/routes/health-detail.js";
import { KNOWN_DAEMON_STATUSES as wikiStatuses } from "../src/server/routes/wiki.js";
import type { DaemonAggRow } from "../src/server/architecture/live-overlay.js";
import { buildUiSandbox } from "./client-sandbox.js";

// The value this cycle adds — apply health, previously inexpressible (the run row is
// written pre-apply and its status derives solely from per-patch errors).
const APPLY_FAILED = "apply_failed";
// The apply stage could not run at all (script absent or non-executable). The precondition
// guard returns success for that case, so without a distinct value it composes as 'ok' —
// a stage that never ran rendering as a healthy apply.
const APPLY_UNAVAILABLE = "apply_unavailable";

function repoRead(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

// Line comments carry prose that must never be mistaken for a member of the set.
function stripLineComments(src: string): string {
  return src.replace(/^\s*(\/\/|\/{3}).*$/gm, "");
}

function getSchemaEnumValues(): string[] {
  const block = repoRead("prisma/schema.prisma").match(/enum DaemonStatus\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, "schema.prisma must declare enum DaemonStatus");
  return stripLineComments(block[1])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+$/.test(line));
}

interface ToneEntry {
  tone: string;
  label: string;
}

const UI = await buildUiSandbox<{ DAEMON_STATUS_TONE: Record<string, ToneEntry> }>();

const NARROWING_SETS: Array<{ route: string; statuses: ReadonlySet<string> }> = [
  { route: "dashboard.ts", statuses: dashboardStatuses },
  { route: "health-detail.ts", statuses: healthDetailStatuses },
  { route: "wiki.ts", statuses: wikiStatuses },
];

const SCHEMA_VALUES = getSchemaEnumValues();

test("a migration adds each value (schema-only addition would never reach a database)", () => {
  const migrationsDir = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
  const sqls = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readFileSync(`${migrationsDir}/${entry.name}/migration.sql`, "utf8"));
  for (const value of [APPLY_FAILED, APPLY_UNAVAILABLE]) {
    // Reversal prose in a sibling migration names the value too — anchor on the ADD VALUE
    // statement so only the migration that actually adds it counts.
    const adding = sqls.filter((sql) =>
      new RegExp(`ALTER TYPE\\s+"core"\\."DaemonStatus"\\s+ADD VALUE[^;]*'${value}'`, "i").test(sql),
    );
    assert.strictEqual(adding.length, 1, `exactly one migration must add '${value}'`);
  }
});

for (const { route, statuses } of NARROWING_SETS) {
  // Equality, not inclusion: a missing member nulls a real value, an extra one admits a
  // value no database can hold.
  test(`${route} narrowing set equals the schema enum`, () => {
    assert.deepStrictEqual(
      [...statuses].sort(),
      SCHEMA_VALUES.slice().sort(),
      `${route} narrowing set drifted from enum DaemonStatus (drift → silent null)`,
    );
  });
}

test("ui.jsx tone table holds every emitted value, and the new one renders louder than info", () => {
  const table = UI.DAEMON_STATUS_TONE;
  for (const value of SCHEMA_VALUES) {
    assert.ok(table[value], `DAEMON_STATUS_TONE must carry '${value}' (absent → raw token at info tone)`);
  }
  const labels = SCHEMA_VALUES.map((value) => table[value].label);
  const expected: Record<string, ToneEntry> = {
    [APPLY_FAILED]: { tone: "crit", label: "Apply failed" },
    // Unavailability, not failure — an install that legitimately ships without an apply
    // script must read as a standing warn, never a standing red.
    [APPLY_UNAVAILABLE]: { tone: "warn", label: "Apply unavailable" },
  };
  for (const [value, want] of Object.entries(expected)) {
    const entry = table[value];
    assert.notStrictEqual(entry.tone, "info", "the unknown-value fallback tone is not an acceptable entry");
    assert.strictEqual(entry.tone, want.tone, `'${value}' must render at the ${want.tone} tone`);
    assert.strictEqual(entry.label, want.label);
    // Distinct label: an operator must be able to tell it from every other status.
    assert.strictEqual(
      labels.filter((label) => label === want.label).length,
      1,
      `'${want.label}' must not collide with another status label`,
    );
  }
});

test("dashboard board passes each value through narrowing instead of nulling it", () => {
  const now = new Date("2026-07-12T12:00:00Z");
  for (const value of [APPLY_FAILED, APPLY_UNAVAILABLE]) {
    const rows: DaemonAggRow[] = [
      {
        daemon_name: "autoagent",
        last_run_at: new Date(now.getTime() - 60 * 60_000), // within cadence → no stale synthesis
        last_status: value,
      },
    ];
    const item = buildDaemonStatusItems(rows, now, null).find((i) => i.daemon_name === "autoagent");
    assert.ok(item, "autoagent must be on the board");
    assert.strictEqual(
      item.last_status,
      value,
      `an unnarrowed '${value}' arrives as null and the board renders 'No data' on an unhealthy apply`,
    );
  }
});

test("the needs-auth failing-state predicate splits failure from unavailability", () => {
  const firing = {
    lastRunAt: new Date("2026-07-12T11:00:00Z"),
    isStale: false,
    costGuardState: null,
    secretsAbsent: true,
  };
  assert.strictEqual(deriveNeedsAuth({ ...firing, lastStatus: APPLY_FAILED }), true);
  // D1 addendum: an absent or non-executable apply script is not a credential condition,
  // so routing it to needs-auth would prescribe the wrong repair.
  assert.strictEqual(deriveNeedsAuth({ ...firing, lastStatus: APPLY_UNAVAILABLE }), false);
});
