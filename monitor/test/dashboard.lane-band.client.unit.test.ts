// Unit tests for the Dashboard triage surface in public/src/screens/dashboard.jsx —
// buildAlarms (the cross-screen union feeding the lane) and buildTiles (the four-tile
// status band). Both are pure, so the four payload states each tile must render
// distinctly are pinned here rather than through a render.
//
// Sandbox harness (esbuild + node:vm over the real shipped ui.jsx + dashboard.jsx):
// client-sandbox.ts.
//
// Runner: npx tsx --test test/dashboard.lane-band.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH_SRC = resolve(__dirname, "../public/src/screens/dashboard.jsx");

interface Alarm {
  id: string;
  tone: string;
  title: string;
  detail: string | null;
  target: string | null;
}
interface Tile {
  id: string;
  label: string;
  status: string;
  tone: string;
  value: string;
  hint: string;
  target: string;
}
interface Fold {
  status: string;
  partsOk: number;
  partsChecked: number;
  partsTotal: number;
  downNames: string[];
  uncheckedNames: string[];
  version?: string | null;
}
interface DashHelpers {
  buildAlarms: (args: { harness: Fold | null; kpiState: unknown; installKind: string }) => Alarm[];
  buildTiles: (args: {
    harness: Fold | null;
    kpiState: unknown;
    agentsState: unknown;
    outcomesState: unknown;
  }) => Tile[];
}

const dash = await buildScreenSandbox<DashHelpers>(DASH_SRC);

const HEALTHY: Fold = {
  status: "ready", partsOk: 6, partsChecked: 6, partsTotal: 7,
  downNames: [], uncheckedNames: ["Hook Chain"], version: "1.0.0",
};
const LOADING = { status: "loading", data: null, error: null };
const ERRORED = { status: "error", data: null, error: "HTTP 500" };
function ready(data: unknown): unknown {
  return { status: "ready", data, error: null };
}
function kpi(today: number, sameTimeYesterday: number): unknown {
  return ready({
    today_cost_usd: today,
    yesterday_same_time_cost_usd: sameTimeYesterday,
    yesterday_cost_usd: sameTimeYesterday,
  });
}
function tileOf(tiles: Tile[], id: string): Tile {
  const found = tiles.find((t) => t.id === id);
  assert.ok(found, `tile ${id} must exist`);
  return found;
}

// --- The lane: empty when nothing is wrong, worst-first when something is ---

test("a healthy harness with normal spend and no update produces no lane rows", () => {
  const rows = dash.buildAlarms({ harness: HEALTHY, kpiState: kpi(10, 10), installKind: "hidden" });
  assert.deepEqual([...rows], [], "an empty lane renders nothing at all");
});

test("every down part becomes one harness row naming the parts", () => {
  const rows = dash.buildAlarms({
    harness: { ...HEALTHY, partsOk: 4, downNames: ["PostgreSQL", "autoagent"] },
    kpiState: kpi(10, 10),
    installKind: "hidden",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "harness");
  assert.equal(rows[0]!.tone, "crit");
  assert.equal(rows[0]!.target, "architecture", "the row routes to the screen that owns the fact");
  assert.ok(rows[0]!.detail?.includes("PostgreSQL"), "the parts are named, not just counted");
});

test("an unavailable harness fold raises no alarm — absence is not a fault", () => {
  const rows = dash.buildAlarms({
    harness: { ...HEALTHY, status: "unavailable", partsChecked: 0, downNames: [] },
    kpiState: LOADING,
    installKind: "hidden",
  });
  assert.equal(rows.length, 0, "nothing polled must never read as something broken");
  assert.equal(dash.buildAlarms({ harness: null, kpiState: LOADING, installKind: "hidden" }).length, 0);
});

test("spend alarms only once today is past the pace cut, at any scale", () => {
  for (const [today, basis, alarms] of [
    [125, 100, false], [126, 100, true], [1.26, 1, true], [50, 100, false], [0, 0, false],
  ] as [number, number, boolean][]) {
    const rows = dash.buildAlarms({ harness: HEALTHY, kpiState: kpi(today, basis), installKind: "hidden" });
    assert.equal(
      rows.some((r) => r.id === "spend"),
      alarms,
      `${today} against ${basis} at this time yesterday`,
    );
  }
});

test("a zero baseline never alarms — there is no pace to be ahead of", () => {
  const rows = dash.buildAlarms({ harness: HEALTHY, kpiState: kpi(500, 0), installKind: "hidden" });
  assert.equal(rows.length, 0, "a fake +100% is worse than no signal");
});

test("the install row appears only for the actionable update views", () => {
  for (const [kind, present] of [
    ["hidden", false], ["current", false], ["updating", false], ["available", true], ["failed", true],
  ] as [string, boolean][]) {
    const rows = dash.buildAlarms({ harness: HEALTHY, kpiState: kpi(10, 10), installKind: kind });
    assert.equal(rows.some((r) => r.id === "install"), present, kind);
  }
});

test("rows are ordered worst-first whatever order the sources contribute in", () => {
  const rows = dash.buildAlarms({
    harness: { ...HEALTHY, downNames: ["PostgreSQL"] },
    kpiState: kpi(500, 100),
    installKind: "available",
  });
  assert.equal(rows.length, 3);
  const ranks = rows.map((r) => ({ crit: 3, warn: 2, info: 1, neutral: 0 })[r.tone] ?? 0);
  assert.deepEqual(
    [...ranks],
    [...ranks].sort((a, b) => b - a),
    "severity must be non-increasing down the lane",
  );
});

// --- The band: four tiles, and four distinguishable payload states ---

test("the band is always the four tiles, in the priority spine's order", () => {
  const tiles = dash.buildTiles({
    harness: HEALTHY, kpiState: kpi(10, 10), agentsState: LOADING, outcomesState: LOADING,
  });
  assert.equal(tiles.length, 4);
  assert.equal(tiles.map((t) => t.id).join(","), "harness,outcomes,fleet,spend");
  for (const tile of tiles) {
    assert.ok(tile.target, `${tile.id} must route somewhere`);
  }
});

test("loading, error and unavailable each read differently and none reads as a value", () => {
  const states: [string, unknown, string][] = [
    ["loading", LOADING, "loading"],
    ["error", ERRORED, "error"],
    ["unavailable", ready({ meta: {} }), "unavailable"],
  ];
  for (const [name, agentsState, expected] of states) {
    const tile = tileOf(
      dash.buildTiles({ harness: HEALTHY, kpiState: LOADING, agentsState, outcomesState: LOADING }),
      "fleet",
    );
    assert.equal(tile.status, expected, name);
    assert.equal(tile.value, "—", `${name} must not render a number nobody loaded`);
    assert.equal(tile.tone, "neutral", `${name} carries no verdict tone`);
  }
});

test("the fleet tile separates an empty population from an unavailable one", () => {
  const empty = tileOf(
    dash.buildTiles({
      harness: HEALTHY, kpiState: LOADING, outcomesState: LOADING,
      agentsState: ready({ meta: { total_agents: 0 } }),
    }),
    "fleet",
  );
  assert.equal(empty.status, "empty");
  assert.equal(empty.value, "0", "a loaded zero is a real reading and shows as one");
});

test("the harness tile counts only the parts the shell actually polled", () => {
  const tile = tileOf(
    dash.buildTiles({
      harness: { ...HEALTHY, partsOk: 5, partsChecked: 6, downNames: ["autoagent"] },
      kpiState: LOADING, agentsState: LOADING, outcomesState: LOADING,
    }),
    "harness",
  );
  assert.equal(tile.value, "5 of 6", "the denominator is what answered, not what exists");
  assert.equal(tile.tone, "crit");
  assert.ok(tile.hint.includes("Hook Chain"), "the unchecked part is named, not silently dropped");
});

test("the outcome tile takes its verdict from the shared rule", () => {
  const crit = tileOf(
    dash.buildTiles({
      harness: HEALTHY, kpiState: LOADING, agentsState: LOADING,
      outcomesState: ready({
        total: 200,
        by_result: [{ result: "fail", count: 40 }, { result: "done", count: 160 }],
      }),
    }),
    "outcomes",
  );
  assert.equal(crit.tone, "crit");
  assert.equal(crit.status, "ready");

  const lowN = tileOf(
    dash.buildTiles({
      harness: HEALTHY, kpiState: LOADING, agentsState: LOADING,
      outcomesState: ready({ total: 4, by_result: [{ result: "fail", count: 4 }] }),
    }),
    "outcomes",
  );
  assert.equal(lowN.status, "unavailable", "a sample too small to judge is not a ready verdict");
  assert.equal(lowN.tone, "neutral");
});

test("the spend tile tones only on the pace verdict, never on the amount", () => {
  const big = tileOf(
    dash.buildTiles({ harness: HEALTHY, kpiState: kpi(9999, 20000), agentsState: LOADING, outcomesState: LOADING }),
    "spend",
  );
  assert.equal(big.tone, "neutral", "a large but on-pace spend is not an alarm");
  const hot = tileOf(
    dash.buildTiles({ harness: HEALTHY, kpiState: kpi(3, 1), agentsState: LOADING, outcomesState: LOADING }),
    "spend",
  );
  assert.equal(hot.tone, "warn", "a small but off-pace spend is");
});
