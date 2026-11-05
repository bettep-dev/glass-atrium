// Cross-screen consistency proof for 'No data'/overdue daemon semantics (F#38).
// Drives health-model.js (health/dashboard) from the REAL ui.jsx window.UI
// (architecture's SoT), so a divergence between the two screens fails the suite.
// Proves: a never-reported daemon → info 'No data' on BOTH surfaces; an overdue daemon
// → crit; a within-cadence daemon → its real status. Each case is driven by the server's
// effective_status, the field both surfaces read, so the two cannot diverge on a rule of
// their own. health-model reads window.UI at call time (JSX not importable in node) →
// the shipped ui.jsx is evaluated in a sandbox and installed as window.UI.
// Runner: npx tsx --test test/daemon-nodata-consistency.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildUiSandbox } from "./client-sandbox.js";

interface ToneEntry {
  tone: string;
  label: string;
}
interface DaemonStatusUi {
  DAEMON_STATUS_TONE: Record<string, ToneEntry>;
  daemonStatusTone: (status: string) => string;
  daemonStatusLabel: (status: string) => string;
}

const UI = await buildUiSandbox<DaemonStatusUi>();

/**
 * Spread → sandbox-realm entry copied into this realm.
 * deepStrictEqual then compares values, never failing on the foreign Object prototype.
 */
function getToneEntryOrFail(status: string): ToneEntry {
  const entry = UI.DAEMON_STATUS_TONE[status];
  assert.ok(entry, `ui.jsx DAEMON_STATUS_TONE must carry '${status}'`);
  return { ...entry };
}

// Call spy over the real window.UI lookups → proves resolveDaemonDisplayMeta delegates, not a local literal
const lookups: Array<[string, string]> = [];
interface SpyWindow {
  UI: DaemonStatusUi;
  HealthModel?: {
    resolveDaemonDisplayMeta: (d: unknown) => ToneEntry;
  };
}
const spyWindow: SpyWindow = {
  UI: {
    ...UI,
    daemonStatusTone: (status) => {
      lookups.push(["tone", status]);
      return UI.daemonStatusTone(status);
    },
    daemonStatusLabel: (status) => {
      lookups.push(["label", status]);
      return UI.daemonStatusLabel(status);
    },
  },
};
// Double-cast is required, not laziness: with the DOM lib loaded `globalThis.window` is
// `Window & typeof globalThis`, which does not overlap this object — and installing a
// non-Window object is exactly the point, since the module under test is a browser
// module loaded in node.
(globalThis as unknown as { window?: SpyWindow }).window = spyWindow;

await import("../public/src/data/health-model.js");
const HealthModel = spyWindow.HealthModel;
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

test("never-reported daemon (null last_status row) → info 'No data' via shared SoT", () => {
  lookups.length = 0;
  const meta = HealthModel.resolveDaemonDisplayMeta(
    daemon({ last_status: null, effective_status: "missing" }),
  );
  assert.deepStrictEqual(
    meta,
    getToneEntryOrFail("missing"),
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
    getToneEntryOrFail("stale"),
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
  assert.deepStrictEqual(meta, getToneEntryOrFail("ok"));
  assert.deepStrictEqual(meta, { tone: "ok", label: "Healthy" });
});
