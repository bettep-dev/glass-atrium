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
  isHeld?: boolean;
}
interface Tile {
  id: string;
  label: string;
  status: string;
  tone: string;
  value: string;
  hint: string;
  detail?: string | null;
  trend?: string | null;
  note?: string;
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
  kpi?: Record<string, number | null> | null;
  error?: string | null;
}
interface DashHelpers {
  buildAlarms: (args: { harness: Fold | null; costState: unknown; installKind: string }) => Alarm[];
  buildTiles: (args: {
    harness: Fold | null;
    costState: unknown;
    agentsState: unknown;
    outcomesState: unknown;
    isHarnessBusy?: boolean;
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

// a held reading whose refresh failed → its row keeps its tone but reads last known, as its tile does
const HELD_ALARM_ROWS = [
  { name: "a down part held over a failed harness read", id: "harness", isHeld: true,
    harness: { ...HEALTHY, partsOk: 6, downNames: ["autoagent"], unreadSources: ["daemon status"], error: "HTTP 500" },
    costState: kpi(10, 10) },
  { name: "a down part fresh beside a failed failure-count read", id: "harness", isHeld: false,
    harness: { ...HEALTHY, partsOk: 6, downNames: ["autoagent"], unreadSources: ["the failure count"], error: "HTTP 500" },
    costState: kpi(10, 10) },
  { name: "a down part from a fresh harness read", id: "harness", isHeld: false,
    harness: { ...HEALTHY, partsOk: 6, downNames: ["autoagent"] }, costState: kpi(10, 10) },
  { name: "hot spend held over a failed cost read", id: "spend", isHeld: true,
    harness: HEALTHY, costState: { ...(kpi(500, 10) as object), error: "HTTP 500" } },
  { name: "hot spend from a fresh cost read", id: "spend", isHeld: false, harness: HEALTHY, costState: kpi(500, 10) },
];
for (const row of HELD_ALARM_ROWS) {
  test(`an alarm row is last known only when its source's latest read failed: ${row.name}`, () => {
    const rows = dash.buildAlarms({ harness: row.harness, costState: row.costState, installKind: "hidden" });
    const alarm = rows.find((r) => r.id === row.id);
    assert.ok(alarm, `row ${row.id} must exist`);
    assert.equal(Boolean(alarm.isHeld), row.isHeld);
  });
}

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
});

test("every tile drills to its own screen in a fixed order", () => {
  const tiles = dash.buildTiles({ harness: HEALTHY, costState: kpi(10, 10), agentsState: LOADING, outcomesState: LOADING });
  assert.deepEqual([...tiles.map((t) => t.target)], ["architecture", "outcomes", "agents", "cost"]);
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

// A shared ' · ' separator let the unpolled list run on into the down list → an unpolled part read as down.
test("the harness hint's down list names exactly the down parts, never an unpolled one", () => {
  const rows = [
    { name: "one down, one unpolled", downNames: ["autoagent"], uncheckedNames: ["Hook Chain"] },
    { name: "two down, two unpolled", downNames: ["autoagent", "monitor"], uncheckedNames: ["Hook Chain", "PostgreSQL"] },
  ];
  for (const row of rows) {
    const tile = tileOf(
      dash.buildTiles({
        harness: { ...HEALTHY, partsOk: 4, partsChecked: 4 + row.downNames.length, downNames: row.downNames, uncheckedNames: row.uncheckedNames },
        costState: LOADING, agentsState: LOADING, outcomesState: LOADING,
      }),
      "harness",
    );
    const downClause = /Not answering: ([^.]*)/.exec(tile.hint)?.[1] ?? "";
    assert.deepEqual(downClause.split(" · "), row.downNames, `${row.name}: hint was "${tile.hint}"`);
  }
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
  assert.equal(tile.badge, "Failures above alert line");
  assert.match(String(tile.detail), /40 of 200 failed or blocked · alert at 5%/, "the detail names both results the share counts");
  assert.match(tile.hint, /5\.0% \(10\) finished with caveats · alert at 10%/, "the caveat alert line sits beside the caveat share");
  assert.doesNotMatch(tile.hint, /writer-emitted/, "the counting rule moves out of the visible hint");
  assert.match(String(tile.note), /writer-emitted/, "and into the tile's tooltip");
});

test("the spend tile leads with the judged pace — the larger of so-far and the 3-hour pace — against the 7-day average", () => {
  const rows = [
    { name: "pace ahead of so-far", today: 3, avg: 10, pace: 20, lead: /^On pace for \$20\.00 today, 2\.0× the 7-day average \(\$10\.00\)/ },
    { name: "so-far ahead of pace", today: 30, avg: 10, pace: 5, lead: /^On pace for \$30\.00 today, 3\.0× the 7-day average/ },
    { name: "under the average", today: 2, avg: 10, pace: 8, lead: /^On pace for \$8\.00 today, 0\.8× the 7-day average/ },
  ];
  for (const row of rows) {
    const tile = tileOf(
      dash.buildTiles({ harness: HEALTHY, costState: kpi(row.today, row.avg, row.pace), agentsState: LOADING, outcomesState: LOADING }),
      "spend",
    );
    assert.match(String(tile.detail), row.lead, `${row.name}: the judged pace leads`);
    assert.doesNotMatch(String(tile.detail), /so far/, `${row.name}: so-far never leads`);
  }
});

test("the spend alarm names its pace window in plain words", () => {
  const [alarm] = dash.buildAlarms({ harness: HEALTHY, costState: kpi(3, 1), installKind: "hidden" });
  assert.equal(alarm.id, "spend");
  assert.match(String(alarm.detail), /at the last 3 hours' rate/);
  assert.doesNotMatch(String(alarm.detail), /3 h burn/);
});

test("the spend tile tones only on the pace verdict, never on the amount", () => {
  const big = tileOf(
    dash.buildTiles({ harness: HEALTHY, costState: kpi(9999, 20000), agentsState: LOADING, outcomesState: LOADING }),
    "spend",
  );
  assert.equal(big.tone, "ok", "a large but on-pace spend reads normal, never an alarm");
  assert.ok(big.badge, "the spend tile carries a status chip like the other tiles");
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

test("the harness tile names its down parts instead of restating the count", () => {
  const harness = { ...HEALTHY, partsOk: 5, downNames: ["autoagent", "monitor"] };
  const tile = tileOf(
    dash.buildTiles({ harness, costState: LOADING, agentsState: LOADING, outcomesState: LOADING }),
    "harness",
  );
  assert.equal(tile.value, "2 of 7 down");
  assert.match(tile.hint, /autoagent · monitor/, "the down parts are named on the tile");
  assert.doesNotMatch(tile.hint, /\bof 7\b/, "the count stays in the headline alone");
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
  // a held all-clear never reads healthy: the ok tone drops to neutral, the same rule the page verdicts follow
  const heldTiles = tilesFor(rows[1]);
  for (const id of ids) assert.notEqual(tileOf(heldTiles, id).tone, "ok", `${id} held after a failed refresh`);
});

test("a held tile keeps a warn or crit alarm through a failed refresh, and only an all-clear drops to neutral", () => {
  const breaker = (suspended: number) => ({ source: "loaded", suspended_count: suspended, streak_count: 0 });
  const fleetOf = (suspended: number) => ready({ meta: { total_agents: 3, circuit_breaker: breaker(suspended) } });
  for (const suspended of [0, 1]) {
    const fresh = tileOf(dash.buildTiles({ harness: HEALTHY, costState: LOADING, outcomesState: LOADING, agentsState: fleetOf(suspended) }), "fleet");
    const stale = tileOf(
      dash.buildTiles({ harness: HEALTHY, costState: LOADING, outcomesState: LOADING, agentsState: held(fleetOf(suspended), "HTTP 500") }),
      "fleet",
    );
    const isAlarm = fresh.tone === "warn" || fresh.tone === "crit";
    assert.equal(isAlarm, suspended > 0, `${suspended} suspended: a suspension is the alarm under test`);
    assert.equal(stale.tone, isAlarm ? fresh.tone : "neutral", `${suspended} suspended: fresh ${fresh.tone}`);
    assert.equal(stale.badge, "Last known", `${suspended} suspended: the held reading is still flagged`);
  }
});

test("a cold-failed tile stays the error card while its Retry is in flight, never a loader", () => {
  const retrying = { status: "loading", data: null, error: "HTTP 500", busy: true };
  const tiles = dash.buildTiles({ harness: HEALTHY, costState: retrying, agentsState: retrying, outcomesState: retrying });
  for (const id of ["outcomes", "fleet", "spend"]) {
    const tile = tileOf(tiles, id) as Tile & { error: string; isBusy: boolean };
    assert.equal(tile.status, "error", `${id} keeps its error card`);
    assert.equal(tile.error, "HTTP 500", id);
    assert.equal(tile.isBusy, true, `${id} marks the Retry in flight`);
  }
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

test("a harness refresh that failed over held readings reads last-known, keeping a held fault", () => {
  const rows = [
    { name: "held parts all up", downNames: [] as string[], tone: "info" },
    { name: "a held part down", downNames: ["autoagent"], tone: "crit" },
  ];

  for (const row of rows) {
    const harness = unreadFold({ partsOk: 7 - row.downNames.length, downNames: row.downNames });
    const tile = tileOf(
      dash.buildTiles({ harness, costState: kpi(1, 10), agentsState: ready({}), outcomesState: ready({}) }),
      "harness",
    );
    assert.equal(tile.badge, "Last known", `${row.name}: badge`);
    assert.equal(tile.tone, row.tone, `${row.name}: tone`);
    assert.match(tile.hint, /daemon status/, `${row.name}: names the source that failed`);
  }
});

test("parts lost to a cold read failure count against every part, never only the parts still read", () => {
  const rows = [
    { name: "two up, five never read", partsOk: 2, downNames: [] as string[], value: "2 of 7 up" },
    { name: "one down, five never read", partsOk: 1, downNames: ["PostgreSQL"], value: "1 of 7 down" },
  ];

  for (const row of rows) {
    const harness = unreadFold({ partsOk: row.partsOk, partsChecked: 2, downNames: row.downNames });
    const tile = tileOf(
      dash.buildTiles({ harness, costState: kpi(1, 10), agentsState: ready({}), outcomesState: ready({}) }),
      "harness",
    );
    assert.equal(tile.value, row.value, `${row.name}: value`);
    assert.equal(tile.detail, "5 not read", `${row.name}: the lost parts are counted`);
  }
});

test("part names keep their hyphens unbreakable wherever the page lists them", () => {
  const harness = { ...HEALTHY, partsOk: 6, downNames: ["daily-restart-autoagent"], uncheckedNames: ["glass-atrium-wiki-curator"] };
  const tile = tileOf(
    dash.buildTiles({ harness, costState: kpi(1, 10), agentsState: ready({}), outcomesState: ready({}) }),
    "harness",
  );
  const [row] = dash.buildAlarms({ harness, costState: kpi(10, 10), installKind: "hidden" });
  const lists = [
    { where: "tile hint", text: tile.hint },
    { where: "lane row detail", text: row?.detail ?? "" },
  ];

  for (const { where, text } of lists) {
    assert.doesNotMatch(text, /-/, `${where}: no breakable hyphen`);
    assert.match(text, /daily\u2011restart\u2011autoagent/, `${where}: still names the part`);
  }
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

test("the harness tile dims and reads busy while the shell re-reads it, like a region tile refreshing over held data", () => {
  const rows = [
    { name: "held reading, re-read in flight", harness: HEALTHY, isHarnessBusy: true, busy: true },
    { name: "held reading, no re-read", harness: HEALTHY, isHarnessBusy: false, busy: false },
    { name: "first load is not a refresh", harness: { ...HEALTHY, status: "loading" }, isHarnessBusy: true, busy: false },
  ];
  for (const row of rows) {
    const tiles = dash.buildTiles({ harness: row.harness, isHarnessBusy: row.isHarnessBusy, costState: LOADING, agentsState: LOADING, outcomesState: LOADING });
    assert.equal((tileOf(tiles, "harness") as Tile & { isBusy: boolean }).isBusy, row.busy, row.name);
  }
});

test("a harness tile with down parts says 'down' once across its value, verdict, detail and hint", () => {
  const rows = [
    { name: "one down", downNames: ["autoagent"], uncheckedNames: [] },
    { name: "two down beside unpolled parts", downNames: ["autoagent", "monitor"], uncheckedNames: ["Hook Chain"] },
  ];
  for (const row of rows) {
    const tile = tileOf(
      dash.buildTiles({
        harness: { ...HEALTHY, partsOk: 5, downNames: row.downNames, uncheckedNames: row.uncheckedNames },
        costState: LOADING, agentsState: LOADING, outcomesState: LOADING,
      }),
      "harness",
    );
    const visible = [tile.value, tile.badge, tile.detail, tile.hint].join(" ");
    assert.equal(visible.match(/down/gi)?.length, 1, `${row.name}: "${visible}"`);
    assert.equal(tile.tone, "crit");
  }
});

test("a hot spend tile's badge names the pace multiple its detail line leads with, not the so-far multiple", () => {
  const rows = [
    { name: "pace ahead of so-far", today: 2, avg: 10, pace: 23 },
    { name: "so-far ahead of pace", today: 30, avg: 10, pace: 5 },
  ];
  for (const row of rows) {
    const tile = tileOf(
      dash.buildTiles({ harness: HEALTHY, costState: kpi(row.today, row.avg, row.pace), agentsState: LOADING, outcomesState: LOADING }),
      "spend",
    );
    assert.equal(tile.tone, "warn", row.name);
    assert.match(String(tile.badge), /pace/i, `${row.name}: badge "${tile.badge}" names its basis`);
    assert.match(String(tile.detail), /^On pace/, `${row.name}: the detail line carries that same basis`);
    assert.doesNotMatch(String(tile.badge), /so far/i, `${row.name}: the badge never judges the so-far line`);
  }
});

test("the spend tile states its move against yesterday by this time from the shell's kpi reading, and none without one", () => {
  const rows = [
    { name: "up on yesterday", today: 12, yesterday: 10, trend: /^Up 20% on \$10\.00 yesterday by this time$/ },
    { name: "down on yesterday", today: 5, yesterday: 20, trend: /^Down 75% on \$20\.00 yesterday by this time$/ },
    { name: "level with yesterday", today: 10, yesterday: 10, trend: /^Level with \$10\.00 yesterday by this time$/ },
  ];
  for (const row of rows) {
    const harness = { ...HEALTHY, kpi: { today_cost_usd: row.today, yesterday_same_time_cost_usd: row.yesterday } };
    const tile = tileOf(
      dash.buildTiles({ harness, costState: kpi(row.today, 10), agentsState: LOADING, outcomesState: LOADING }),
      "spend",
    );
    assert.match(String(tile.trend), row.trend, row.name);
  }
});

test("the fleet tile fills its detail line with the failing streak, so a narrow tile is not left mostly empty", () => {
  for (const streak of [0, 3]) {
    const tile = fleetTile({ source: "loaded", suspended_count: 0, streak_count: streak });
    assert.match(String(tile.detail), new RegExp(`^${streak} on a failing streak`), `streak ${streak}`);
    assert.match(tile.hint, /12 agents/, `streak ${streak}: the hint keeps the fleet size`);
  }
});

// --- Task results tile: the prior-window delta ---

// current window starts where the prior one ends (server anchor) → 09-23..today against 09-16..09-22
function outcomesWithPrior(current: unknown, prior: unknown): unknown {
  const priorWindow = prior === null ? {} : { prior_window: { period_start: "2026-09-16", period_end: "2026-09-23", ...(prior as object) } };
  return ready({ ...(current as object), ...priorWindow });
}
const CURRENT_20PCT = {
  total: 200, reconstructed_total: 0,
  by_result: [{ result: "fail", count: 30 }, { result: "blocked", count: 10 }, { result: "done", count: 160 }],
};

test("the outcome tile's delta compares failed-or-blocked shares and names both windows", () => {
  const rows = [
    { name: "share up", prior: { total: 100, reconstructed_total: 0, by_result: [{ result: "fail", count: 5 }, { result: "done", count: 95 }] }, trend: /^Up 15\.0 pts/ },
    { name: "share down", prior: { total: 100, reconstructed_total: 0, by_result: [{ result: "blocked", count: 30 }, { result: "done", count: 70 }] }, trend: /^Down 10\.0 pts/ },
    { name: "same share on half the count", prior: { total: 100, reconstructed_total: 0, by_result: [{ result: "fail", count: 20 }, { result: "done", count: 80 }] }, trend: /^Level/ },
    { name: "prior reconstructed rows left out", prior: { total: 150, reconstructed_total: 50, by_result: [{ result: "fail", count: 30, reconstructed_count: 10 }, { result: "done", count: 120, reconstructed_count: 40 }] }, trend: /^Level/ },
  ];
  for (const row of rows) {
    const tile = tileOf(dash.buildTiles({ harness: HEALTHY, costState: LOADING, agentsState: LOADING, outcomesState: outcomesWithPrior(CURRENT_20PCT, row.prior) }), "outcomes");
    assert.match(String(tile.trend), row.trend, row.name);
    assert.match(String(tile.trend), /since 09-23/, `${row.name}: names the current window`);
    assert.match(String(tile.trend), /09-16 – 09-22/, `${row.name}: names the prior window, end inclusive`);
  }
});

test("the outcome tile states why a prior-window comparison is missing", () => {
  const none = tileOf(dash.buildTiles({ harness: HEALTHY, costState: LOADING, agentsState: LOADING, outcomesState: outcomesWithPrior(CURRENT_20PCT, null) }), "outcomes");
  assert.equal(none.trend ?? null, null, "no prior window served → no trend line");
  const thin = tileOf(dash.buildTiles({
    harness: HEALTHY, costState: LOADING, agentsState: LOADING,
    outcomesState: outcomesWithPrior(CURRENT_20PCT, { total: 1, reconstructed_total: 0, by_result: [{ result: "done", count: 1 }] }),
  }), "outcomes");
  assert.match(String(thin.trend), /too few.*09-16 – 09-22/, "a thin prior window names itself instead of a delta");
});

// --- Spend tile: one ratio, a named alarm basis, a stated day-over-day gap ---

test("the spend tile states one ratio and names the basis of its alarm", () => {
  const tile = tileOf(dash.buildTiles({ harness: HEALTHY, costState: kpi(3, 10, 8), agentsState: LOADING, outcomesState: LOADING }), "spend");
  const text = `${tile.detail} ${tile.hint}`;
  assert.equal((text.match(/\b\d+\.\d×/g) ?? []).length, 1, text);
  assert.match(tile.hint, /alarm at 1\.25× the 7-day average/i);
});

test("the spend tile says why its day-over-day change is missing", () => {
  const rows = [
    { name: "harness KPI not read", kpi: null, trend: /unavailable/i },
    { name: "yesterday's figure not read", kpi: { today_cost_usd: 5, yesterday_same_time_cost_usd: null }, trend: /unavailable/i },
    { name: "nothing spent yesterday by now", kpi: { today_cost_usd: 5, yesterday_same_time_cost_usd: 0 }, trend: /no spend yesterday/i },
    { name: "a comparand exists", kpi: { today_cost_usd: 5, yesterday_same_time_cost_usd: 4 }, trend: /^Up 25%/ },
  ];
  for (const row of rows) {
    const tile = tileOf(dash.buildTiles({ harness: { ...HEALTHY, kpi: row.kpi }, costState: kpi(5, 10), agentsState: LOADING, outcomesState: LOADING }), "spend");
    assert.match(String(tile.trend), row.trend, row.name);
  }
});
