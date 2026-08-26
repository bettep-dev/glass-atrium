// Cross-screen consistency proof for 'No data'/overdue daemon semantics (F#38).
// Drives health-model.js (health/dashboard) from the REAL ui.jsx DAEMON_STATUS_TONE
// table (architecture's SoT), so a divergence between the two screens fails the suite.
// Proves: a never-reported daemon → info 'No data' on BOTH surfaces; an overdue daemon
// → crit; a within-cadence daemon → its real status. Each case is driven by the server's
// effective_status, the field both surfaces read, so the two cannot diverge on a rule of
// their own. health-model reads window.UI at call time (JSX not importable in node) →
// stub built from parsed ui.jsx source.
// Runner: npx tsx --test test/daemon-nodata-consistency.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface ToneEntry {
  tone: string;
  label: string;
}

// Parse ui.jsx const DAEMON_STATUS_TONE = { key: { tone: 'x', label: 'y' }, ... }.
// Source-level parse (mirrors architecture.daemon-binding.test.ts style) — the single
// SoT the FE renders; a hand-copied literal here would defeat the point.
function parseUiStatusTone(): Record<string, ToneEntry> {
  const uiPath = fileURLToPath(
    new URL("../public/src/ui.jsx", import.meta.url),
  );
  const src = readFileSync(uiPath, "utf8");
  const blockMatch = src.match(
    /const DAEMON_STATUS_TONE\s*=\s*\{([\s\S]*?)\};/,
  );
  assert.ok(blockMatch, "ui.jsx must declare const DAEMON_STATUS_TONE");
  const table: Record<string, ToneEntry> = {};
  const entryRe =
    /(\w+):\s*\{\s*tone:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g;
  for (const m of blockMatch[1].matchAll(entryRe)) {
    table[m[1]] = { tone: m[2], label: m[3] };
  }
  return table;
}

const TONE_TABLE = parseUiStatusTone();

// window.UI backed by the parsed ui.jsx table + a call spy (proves delegation, not a
// local literal, in resolveDaemonDisplayMeta).
const lookups: Array<[string, string]> = [];
interface StubWindow {
  UI: {
    daemonStatusTone: (status: string) => string;
    daemonStatusLabel: (status: string) => string;
  };
  HealthModel?: {
    resolveDaemonDisplayMeta: (d: unknown) => ToneEntry;
  };
}
const stubWindow: StubWindow = {
  UI: {
    daemonStatusTone: (status) => {
      lookups.push(["tone", status]);
      return (TONE_TABLE[status] ?? { tone: "info", label: status ?? "—" }).tone;
    },
    daemonStatusLabel: (status) => {
      lookups.push(["label", status]);
      return (TONE_TABLE[status] ?? { tone: "info", label: status ?? "—" }).label;
    },
  },
};
(globalThis as { window?: StubWindow }).window = stubWindow;

await import("../public/src/data/health-model.js");
const HealthModel = stubWindow.HealthModel;
assert.ok(HealthModel, "health-model.js must register window.HealthModel");

// effective_status is the server verdict: overdue ⇒ 'stale' · otherwise the reported
// status · never reported ⇒ 'missing'. Fixtures pair it with the last_status it would
// really accompany, so a client that judged for itself would disagree with the pair.
function daemon(overrides: Record<string, unknown> = {}) {
  return {
    daemon_name: "autoagent",
    last_status: "ok",
    effective_status: "ok",
    ...overrides,
  };
}

test("ui.jsx SoT: missing → info 'No data', stale → crit 'Overdue'", () => {
  assert.deepStrictEqual(
    TONE_TABLE.missing,
    { tone: "info", label: "No data" },
    "architecture 'missing' must be the benign info 'No data' default (F#38)",
  );
  assert.deepStrictEqual(TONE_TABLE.stale, { tone: "crit", label: "Overdue" });
});

test("never-reported daemon (null last_status row) → info 'No data' via shared SoT", () => {
  lookups.length = 0;
  const meta = HealthModel.resolveDaemonDisplayMeta(
    daemon({ last_status: null, effective_status: "missing" }),
  );
  assert.deepStrictEqual(
    meta,
    TONE_TABLE.missing,
    "health's null-status meta must equal architecture's 'missing' mapping",
  );
  assert.deepStrictEqual(meta, { tone: "info", label: "No data" });
  // Delegation proof: resolves via window.UI('missing'), not a local { tone:'info' } literal.
  assert.ok(
    lookups.some(([kind, s]) => kind === "tone" && s === "missing"),
    "must delegate tone to window.UI.daemonStatusTone('missing')",
  );
  assert.ok(
    lookups.some(([kind, s]) => kind === "label" && s === "missing"),
    "must delegate label to window.UI.daemonStatusLabel('missing')",
  );
});

test("null daemon (no card row) → same info 'No data' as a null-status row", () => {
  assert.deepStrictEqual(
    HealthModel.resolveDaemonDisplayMeta(null),
    { tone: "info", label: "No data" },
  );
});

test("overdue daemon → crit 'Overdue' via the server verdict, outranking last_status", () => {
  lookups.length = 0;
  const meta = HealthModel.resolveDaemonDisplayMeta(
    daemon({ last_status: "ok", effective_status: "stale" }),
  );
  assert.deepStrictEqual(
    meta,
    TONE_TABLE.stale,
    "health's overdue meta must equal architecture's 'stale' mapping",
  );
  assert.deepStrictEqual(meta, { tone: "crit", label: "Overdue" });
  // Delegation proof: the verdict is handed to window.UI, not re-judged from a threshold.
  assert.ok(
    lookups.some(([kind, s]) => kind === "tone" && s === "stale"),
    "must delegate tone to window.UI.daemonStatusTone('stale')",
  );
});

test("within-cadence daemon → its real last_status mapping (no downgrade)", () => {
  const meta = HealthModel.resolveDaemonDisplayMeta(
    daemon({ last_status: "ok", effective_status: "ok" }),
  );
  assert.deepStrictEqual(meta, TONE_TABLE.ok);
  assert.deepStrictEqual(meta, { tone: "ok", label: "Healthy" });
});
