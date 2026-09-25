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
  target: string | null;
  badge?: string;
  canRetry?: boolean;
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
  buildAlarms: (args: { harness: Fold | null; costState: unknown; installKind: string }) => Alarm[];
  buildTiles: (args: {
    harness: Fold | null;
    costState: unknown;
    agentsState: unknown;
    outcomesState: unknown;
    alarms?: Alarm[];
  }) => Tile[];
}

const dash = await buildScreenSandbox<DashHelpers>(DASH_SRC);

// Every part the shell polls answered healthy — the hook chain rides the harness wave too.
const HEALTHY: Fold = {
  status: "ready", partsOk: 7, partsChecked: 7, partsTotal: 7,
  downNames: [], uncheckedNames: [], version: "1.0.0",
};
const LOADING = { status: "loading", data: null, error: null };
const ERRORED = { status: "error", data: null, error: "HTTP 500" };
function ready(data: unknown): unknown {
  return { status: "ready", data, error: null };
}
// /api/cost/kpi shape — the baseline the screen compares against is window_7d_cost_usd / 7,
// and the pace leg extrapolates the 3 h burn, so a fixture states avg/day and $/day directly.
function kpi(today: number, avgDaily: number, paceDaily: number = today): unknown {
  return ready({
    today_cost_usd: today,
    window_7d_cost_usd: avgDaily * 7,
    burn_rate_3h_usd_per_hour: paceDaily / 24,
  });
}
function tileOf(tiles: Tile[], id: string): Tile {
  const found = tiles.find((t) => t.id === id);
  assert.ok(found, `tile ${id} must exist`);
  return found;
}

// --- The lane: empty when nothing is wrong, worst-first when something is ---

test("a healthy harness with normal spend and no update produces no lane rows", () => {
  const rows = dash.buildAlarms({ harness: HEALTHY, costState: kpi(10, 10), installKind: "hidden" });
  assert.deepEqual([...rows], [], "an empty lane renders nothing at all");
});

test("every down part becomes one harness row naming the parts", () => {
  const rows = dash.buildAlarms({
    harness: { ...HEALTHY, partsOk: 4, downNames: ["PostgreSQL", "autoagent"] },
    costState: kpi(10, 10),
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
    costState: LOADING,
    installKind: "hidden",
  });
  assert.equal(rows.length, 0, "nothing polled must never read as something broken");
  assert.equal(dash.buildAlarms({ harness: null, costState: LOADING, installKind: "hidden" }).length, 0);
});

test("spend alarms only once today is past the 7-day-average cut, at any scale", () => {
  for (const [today, avgDaily, alarms] of [
    [124, 100, false], [125, 100, true], [1.25, 1, true], [50, 100, false], [0, 0, false],
  ] as [number, number, boolean][]) {
    const rows = dash.buildAlarms({ harness: HEALTHY, costState: kpi(today, avgDaily), installKind: "hidden" });
    assert.equal(
      rows.some((r) => r.id === "spend"),
      alarms,
      `${today} against a ${avgDaily} 7-day avg/day`,
    );
  }
});

test("either leg crosses the cut on its own — so-far under it still alarms on pace", () => {
  const paceOnly = dash.buildAlarms({
    harness: HEALTHY, costState: kpi(10, 100, 200), installKind: "hidden",
  });
  assert.ok(
    paceOnly.some((r) => r.id === "spend"),
    "a day that has barely spent yet but is burning at 2x the average is running hot",
  );
  const neither = dash.buildAlarms({
    harness: HEALTHY, costState: kpi(10, 100, 110), installKind: "hidden",
  });
  assert.equal(neither.length, 0, "both legs under the cut is not an alarm");
});

test("a zero baseline never alarms — there is no pace to be ahead of", () => {
  const rows = dash.buildAlarms({ harness: HEALTHY, costState: kpi(500, 0), installKind: "hidden" });
  assert.equal(rows.length, 0, "a fake +100% is worse than no signal");
});

test("the install row appears only for the actionable update views", () => {
  for (const [kind, present] of [
    ["hidden", false], ["current", false], ["updating", false], ["available", true], ["failed", true],
  ] as [string, boolean][]) {
    const rows = dash.buildAlarms({ harness: HEALTHY, costState: kpi(10, 10), installKind: kind });
    assert.equal(rows.some((r) => r.id === "install"), present, kind);
  }
});

test("rows are ordered worst-first whatever order the sources contribute in", () => {
  const rows = dash.buildAlarms({
    harness: { ...HEALTHY, downNames: ["PostgreSQL"] },
    costState: kpi(500, 100),
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
    harness: HEALTHY, costState: kpi(10, 10), agentsState: LOADING, outcomesState: LOADING,
  });
  assert.equal(tiles.length, 4);
  assert.equal(tiles.map((t) => t.id).join(","), "harness,outcomes,fleet,spend");
  for (const tile of tiles) {
    assert.ok(tile.target, `${tile.id} must route somewhere while no alarm drills there`);
  }
});

test("the lane and the band offer one drill per destination, and every destination keeps one", () => {
  const cases: Array<[string, Fold, unknown]> = [
    ["no alarms", HEALTHY, kpi(10, 10)],
    ["harness alarm", { ...HEALTHY, partsOk: 6, downNames: ["autoagent"] }, kpi(10, 10)],
    ["both alarms", { ...HEALTHY, partsOk: 6, downNames: ["autoagent"] }, kpi(40, 10)],
  ];
  for (const [name, harness, costState] of cases) {
    const alarms = dash.buildAlarms({ harness, costState, installKind: "hidden" });
    const tiles = dash.buildTiles({ harness, costState, agentsState: LOADING, outcomesState: LOADING, alarms });
    const drills = [...alarms.map((a) => a.target), ...tiles.map((t) => t.target)].filter(Boolean);
    assert.equal(new Set(drills).size, drills.length, `${name}: a destination is drilled twice: ${drills}`);
    assert.deepEqual(new Set(drills), new Set(["architecture", "outcomes", "agents", "cost"]), name);
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
      dash.buildTiles({ harness: HEALTHY, costState: LOADING, agentsState, outcomesState: LOADING }),
      "fleet",
    );
    assert.equal(tile.status, expected, name);
    assert.equal(tile.value, "—", `${name} must not render a number nobody loaded`);
    assert.equal(tile.tone, "neutral", `${name} carries no verdict tone`);
  }
});

test("a failed tile names its own region and source, so its Retry reloads that region alone", () => {
  const tiles = dash.buildTiles({ harness: HEALTHY, costState: ERRORED, agentsState: ERRORED, outcomesState: ERRORED });
  const regions = [["outcomes", "outcomes"], ["fleet", "agents"], ["spend", "cost"]];
  for (const [tileId, region] of regions) {
    const tile = tileOf(tiles, tileId) as Tile & { region: string; source: string; error: string };
    assert.equal(tile.status, "error", tileId);
    assert.equal(tile.region, region, tileId);
    assert.ok(tile.source, `${tileId} names what failed to load`);
    assert.equal(tile.error, "HTTP 500", `${tileId} carries the raw answer for Details`);
  }
});

test("a tile refreshing over held data is busy; a first load is not a refresh", () => {
  const refreshing = { ...(kpi(10, 10) as object), busy: true };
  const tiles = dash.buildTiles({ harness: HEALTHY, costState: refreshing, agentsState: { ...LOADING, busy: true }, outcomesState: LOADING });
  const spend = tileOf(tiles, "spend") as Tile & { isBusy: boolean };
  const fleet = tileOf(tiles, "fleet") as Tile & { isBusy: boolean };
  assert.equal(spend.status, "ready");
  assert.equal(spend.isBusy, true);
  assert.equal(fleet.isBusy, false);
});

function fleetTile(circuitBreaker: unknown): Tile {
  return tileOf(
    dash.buildTiles({
      harness: HEALTHY, costState: LOADING, outcomesState: LOADING,
      agentsState: ready({ meta: { total_agents: 12, circuit_breaker: circuitBreaker } }),
    }),
    "fleet",
  );
}

test("the fleet tile headlines the suspended count and tones by the worst breaker state", () => {
  const rows: Array<[string, number, number, string]> = [
    ["nothing tripped", 0, 0, "ok"],
    ["a streak short of suspension", 0, 2, "warn"],
    ["a suspended agent", 1, 2, "crit"],
  ];
  for (const [name, suspended, streak, tone] of rows) {
    const tile = fleetTile({ source: "loaded", registry_agents: 20, suspended_count: suspended, streak_count: streak, alarms: [] });
    assert.equal(tile.status, "ready", name);
    assert.equal(tile.value, String(suspended), `${name}: the suspended count is the headline`);
    assert.equal(tile.tone, tone, name);
    assert.ok(tile.hint.includes(String(streak)), `${name}: the streak count stays visible`);
  }
});

test("the fleet tile reads unavailable when the breaker state is, never a zero suspended", () => {
  for (const breaker of [undefined, { source: "unavailable", registry_agents: 0, suspended_count: 0, streak_count: 0, alarms: [] }]) {
    const tile = fleetTile(breaker);
    assert.equal(tile.status, "unavailable");
    assert.equal(tile.value, "—");
    assert.equal(tile.tone, "neutral");
  }
});

// The footer reads CHECKING… for the first-poll wait; the tile must not call the same wait 'unavailable'.
test("the harness tile is loading exactly while the fold is, and unavailable only after", () => {
  const empty = { ...HEALTHY, partsOk: 0, partsChecked: 0, uncheckedNames: ["PostgreSQL"] };
  for (const [foldStatus, expected] of [["loading", "loading"], ["unavailable", "unavailable"]]) {
    const tile = tileOf(
      dash.buildTiles({
        harness: { ...empty, status: foldStatus },
        costState: LOADING, agentsState: LOADING, outcomesState: LOADING,
      }),
      "harness",
    );
    assert.equal(tile.status, expected, foldStatus);
    assert.equal(tile.value, "—", `${foldStatus} must not render a count nobody polled`);
    assert.equal(tile.tone, "neutral");
    assert.equal(tile.canRetry === true, foldStatus === "unavailable", `${foldStatus}: only a lost reading offers Retry`);
  }
});

test("the harness tile counts only the parts the shell actually polled", () => {
  const tile = tileOf(
    dash.buildTiles({
      harness: {
        ...HEALTHY,
        partsOk: 5, partsChecked: 6,
        downNames: ["autoagent"], uncheckedNames: ["Hook Chain"],
      },
      costState: LOADING, agentsState: LOADING, outcomesState: LOADING,
    }),
    "harness",
  );
  assert.equal(tile.value, "1 of 6 down", "the verdict leads, over what answered, not what exists");
  assert.equal(tile.tone, "crit");
  assert.ok(tile.hint.includes("Hook Chain"), "the unchecked part is named, not silently dropped");
});

test("the outcome tile takes its verdict from the shared rule", () => {
  const crit = tileOf(
    dash.buildTiles({
      harness: HEALTHY, costState: LOADING, agentsState: LOADING,
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
      harness: HEALTHY, costState: LOADING, agentsState: LOADING,
      outcomesState: ready({ total: 4, by_result: [{ result: "fail", count: 4 }] }),
    }),
    "outcomes",
  );
  assert.equal(lowN.status, "unavailable", "a sample too small to judge is not a ready verdict");
  assert.equal(lowN.tone, "neutral");
});

test("the outcome tile leads with the failed share and moves the verdict into its badge", () => {
  const tile = tileOf(
    dash.buildTiles({
      harness: HEALTHY, costState: LOADING, agentsState: LOADING,
      outcomesState: ready({
        total: 200,
        by_result: [{ result: "fail", count: 40 }, { result: "done_with_concerns", count: 10 }, { result: "done", count: 150 }],
      }),
    }),
    "outcomes",
  );
  assert.match(tile.value, /^20\.0%/, "the failed share is the headline");
  assert.equal(tile.badge, "Failures above line");
});

test("the spend tile tones only on the pace verdict, never on the amount", () => {
  const big = tileOf(
    dash.buildTiles({ harness: HEALTHY, costState: kpi(9999, 20000), agentsState: LOADING, outcomesState: LOADING }),
    "spend",
  );
  assert.equal(big.tone, "neutral", "a large but on-pace spend is not an alarm");
  const hot = tileOf(
    dash.buildTiles({ harness: HEALTHY, costState: kpi(3, 1), agentsState: LOADING, outcomesState: LOADING }),
    "spend",
  );
  assert.equal(hot.tone, "warn", "a small but off-pace spend is");
});

test("the harness tile headlines its verdict — the down count when any part is down, else the healthy count", () => {
  const cases: Array<[Fold, string]> = [
    [{ ...HEALTHY }, "7 of 7 up"],
    [{ ...HEALTHY, partsOk: 4, downNames: ["a", "b", "c"] }, "3 of 7 down"],
  ];
  for (const [fold, value] of cases) {
    const tile = tileOf(
      dash.buildTiles({ harness: fold, costState: LOADING, agentsState: LOADING, outcomesState: LOADING }),
      "harness",
    );
    assert.equal(tile.value, value);
  }
});

test("no tile hint repeats a fact its active alarm row already states", () => {
  const harness = { ...HEALTHY, partsOk: 5, downNames: ["autoagent", "monitor"] };
  const costState = kpi(40, 10);
  const alarms = dash.buildAlarms({ harness, costState, installKind: "current" });
  const tiles = dash.buildTiles({ harness, costState, agentsState: LOADING, outcomesState: LOADING });
  assert.equal(alarms.length, 2, "both alarms are active in this fixture");
  for (const alarm of alarms) {
    const tile = tileOf(tiles, alarm.id);
    for (const fact of String(alarm.detail).split(" · ")) {
      const figure = fact.replace(/ .*$/, "");
      assert.ok(!tile.hint.includes(figure), `${alarm.id} hint repeats "${figure}": ${tile.hint}`);
    }
    assert.doesNotMatch(tile.hint, /alarm/i, `${alarm.id} hint carries its own fact, not a pointer at the lane`);
    assert.ok(tile.hint.length > 0, `${alarm.id} hint is not blank`);
  }
});

test("tile labels carry no window text — the window is its own field so the heading case cannot swallow it", () => {
  const tiles = dash.buildTiles({ harness: HEALTHY, costState: LOADING, agentsState: LOADING, outcomesState: LOADING });
  for (const tile of tiles) assert.ok(!/\(/.test(tile.label), `${tile.id} label: ${tile.label}`);
  const windowed = tiles.filter((t) => (t as Tile & { window?: string }).window === "7 d").map((t) => t.id);
  assert.deepEqual([...windowed], ["outcomes", "fleet"]);
});

// --- A failed read never reads as a current verdict, and one outage offers one Retry ---

interface FailureHelpers {
  getTileSharedFailure: (tiles: Tile[]) => { sources: string[]; error: string } | null;
  getAlarmReadiness: (sources: Record<string, unknown>) => { status: string; unread: string[] };
}
const failure = dash as unknown as FailureHelpers;

function held(state: unknown, error: string): unknown {
  return { ...(state as object), error };
}
// a fold the shell built while some harness stores failed their latest read
function unreadFold(over: Record<string, unknown>): Fold {
  return { ...HEALTHY, unreadSources: ["daemon status"], error: "HTTP 500", ...over } as Fold;
}

test("a region whose refresh failed over held data reads last-known and carries the failure", () => {
  const fleet = ready({ meta: { total_agents: 3, circuit_breaker: { source: "loaded", suspended_count: 0, streak_count: 0 } } });
  const rows = [
    { name: "fresh reads", error: null, lastKnown: false },
    { name: "held reads after a failed refresh", error: "HTTP 500", lastKnown: true },
  ];
  const ids = ["outcomes", "fleet", "spend"];
  const tilesFor = (row: (typeof rows)[number]) => {
    const wrap = (state: unknown) => (row.error ? held(state, row.error) : state);
    return dash.buildTiles({
      harness: HEALTHY, costState: wrap(kpi(1, 10)), agentsState: wrap(fleet), outcomesState: wrap(ready({})),
    });
  };
  for (const row of rows) {
    const tiles = tilesFor(row);
    for (const id of ids) {
      const tile = tileOf(tiles, id) as Tile & { error?: string | null };
      assert.equal(tile.badge === "Last known", row.lastKnown, `${row.name}: ${id} badge`);
      assert.equal(tile.error ?? null, row.error, `${row.name}: ${id} carries the failure`);
      assert.equal(tile.canRetry === true, row.lastKnown, `${row.name}: ${id} Retry`);
    }
  }
  // held data → the info tone, never the healthy one
  const heldTiles = tilesFor(rows[1]);
  for (const id of ids) assert.equal(tileOf(heldTiles, id).tone, "info", `${id} held after a failed refresh`);
});

test("held failures sharing one cause collapse into the page banner's single Retry", () => {
  const tiles = dash.buildTiles({
    harness: HEALTHY,
    costState: held(kpi(1, 10), "HTTP 500"),
    agentsState: held(ready({}), "HTTP 500"),
    outcomesState: held(ready({}), "HTTP 500"),
  });
  const shared = failure.getTileSharedFailure(tiles);
  assert.ok(shared, "held failures join the banner");
  assert.deepEqual([...shared.sources].sort(), ["task results", "the fleet summary", "today's spend"]);
});

test("a cold harness outage is an error tile listed in the same banner as the regions", () => {
  const harness = unreadFold({ status: "unavailable", partsOk: 0, partsChecked: 0 });
  const tiles = dash.buildTiles({ harness, costState: ERRORED, agentsState: ERRORED, outcomesState: ERRORED });
  const tile = tileOf(tiles, "harness");
  assert.equal(tile.status, "error");
  assert.ok(failure.getTileSharedFailure(tiles)?.sources.includes("harness health"), "the banner names the harness");
});

test("a partly unread harness never reads healthy, and the lane cannot claim an all-clear", () => {
  const harness = unreadFold({ partsOk: 2, partsChecked: 2, unreadSources: ["daemon status", "the hook chain"] });
  const tile = tileOf(
    dash.buildTiles({ harness, costState: kpi(1, 10), agentsState: ready({}), outcomesState: ready({}) }),
    "harness",
  );
  assert.notEqual(tile.tone, "ok");
  assert.notEqual(tile.badge ?? "", "Healthy");
  assert.match(tile.hint, /daemon status/);
  assert.equal(tile.canRetry, true, "the harness tile keeps its own Retry when no banner covers it");

  const readiness = failure.getAlarmReadiness({ harness, costState: kpi(1, 10), updateState: ready({}) });
  assert.equal(readiness.status, "unknown");
  assert.ok(readiness.unread.includes("harness health"));
});
