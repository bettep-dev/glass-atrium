// End-to-end pin for the core.DaemonStatus enum across its five representation surfaces:
// the Prisma schema, its migration, the three route narrowing sets, the three local type
// unions, and the ui.jsx tone table. A value added on one surface only is the failure this
// suite exists to catch — an unnarrowed value silently becomes null, and an untoned value
// renders as a raw enum token at an info tone (quieter than the state it reports).
// Runner: npx tsx --test test/daemon-status.enum-parity.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildDaemonStatusItems } from "../src/server/routes/dashboard.js";
import { deriveNeedsAuth } from "../src/server/routes/health-detail.js";
import type { DaemonAggRow } from "../src/server/architecture/live-overlay.js";

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

function getQuotedMembers(src: string, blockRe: RegExp, label: string): string[] {
  const block = src.match(blockRe);
  assert.ok(block, `${label} must declare its DaemonStatus member list`);
  return [...stripLineComments(block[1]).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

function getNarrowingSet(routeFile: string): string[] {
  return getQuotedMembers(
    repoRead(`src/server/routes/${routeFile}`),
    /const KNOWN_DAEMON_STATUSES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/,
    routeFile,
  );
}

function getTypeUnion(typeFile: string, typeName: string): string[] {
  return getQuotedMembers(
    repoRead(`src/server/types/${typeFile}`),
    new RegExp(`export type ${typeName} =([\\s\\S]*?);`),
    typeFile,
  );
}

// Same source-regex shape daemon-nodata-consistency.test.ts parses — ui.jsx is the tone SoT.
function getToneTable(): Record<string, { tone: string; label: string }> {
  const block = repoRead("public/src/ui.jsx").match(/const DAEMON_STATUS_TONE\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(block, "ui.jsx must declare const DAEMON_STATUS_TONE");
  const table: Record<string, { tone: string; label: string }> = {};
  for (const m of block[1].matchAll(/(\w+):\s*\{\s*tone:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)) {
    table[m[1]] = { tone: m[2], label: m[3] };
  }
  return table;
}

const SCHEMA_VALUES = getSchemaEnumValues();

test("schema.prisma carries both apply-health values", () => {
  for (const value of [APPLY_FAILED, APPLY_UNAVAILABLE]) {
    assert.ok(
      SCHEMA_VALUES.includes(value),
      `enum DaemonStatus must carry '${value}' (found: ${SCHEMA_VALUES.join(", ")})`,
    );
  }
  // Distinguishability is the deliverable: reusing 'partial' would conflate an aborted
  // apply with a partial patch generation, and reusing 'apply_failed' would conflate a
  // stage that aborted with one that never ran — two different operator repairs.
  assert.ok(SCHEMA_VALUES.includes("partial"), "'partial' stays a separate value");
});

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

test("all three route narrowing sets equal the schema enum", () => {
  for (const routeFile of ["dashboard.ts", "health-detail.ts", "wiki.ts"]) {
    assert.deepStrictEqual(
      getNarrowingSet(routeFile).slice().sort(),
      SCHEMA_VALUES.slice().sort(),
      `${routeFile} narrowing set drifted from enum DaemonStatus (drift → silent null)`,
    );
  }
});

test("all three local type unions equal the schema enum", () => {
  const unions: Array<[string, string]> = [
    ["dashboard.ts", "DaemonStatusValue"],
    ["health-detail.ts", "DaemonStatusValue"],
    ["wiki.ts", "WikiDaemonStatusValue"],
  ];
  for (const [typeFile, typeName] of unions) {
    assert.deepStrictEqual(
      getTypeUnion(typeFile, typeName).slice().sort(),
      SCHEMA_VALUES.slice().sort(),
      `${typeFile} ${typeName} drifted from enum DaemonStatus`,
    );
  }
});

test("ui.jsx tone table holds every emitted value, and the new one renders louder than info", () => {
  const table = getToneTable();
  for (const value of SCHEMA_VALUES) {
    assert.ok(table[value], `DAEMON_STATUS_TONE must carry '${value}' (absent → raw token at info tone)`);
  }
  const labels = SCHEMA_VALUES.map((value) => table[value].label);
  const expected: Record<string, { tone: string; label: string }> = {
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
