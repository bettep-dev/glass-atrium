// Unit tests for the Dashboard triage surface in public/src/screens/dashboard.jsx —
// buildAlarms (the cross-screen union feeding the lane) and buildStats (the four-stat
// status row). Both are pure, so the four payload states each stat must render
// distinctly are pinned here rather than through a render.
//
// Sandbox harness (esbuild + node:vm over the real shipped ui.jsx + dashboard.jsx):
// client-sandbox.ts.
//
// Runner: npx tsx --test test/dashboard.lane-band.client.unit.test.ts

import test, { describe } from "node:test";
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
  targetLabel?: string | null;
  isHeld?: boolean;
}
interface Stat {
  id: string;
  isContextTripped?: boolean;
  label: string;
  window?: string;
  status: string;
  tone: string;
  value: string | null;
  absent?: "none" | "not-loaded";
  // the one visible line under the value; everything else rides ⓘ
  context: string | null;
  // the full sentence behind a short context — the line's title and one ⓘ note
  cause?: string;
  notes: string[];
  target: string | null;
  isHeld?: boolean;
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
  buildAlarms: (args: {
    harness: Fold | null;
    costState: unknown;
    installKind: string;
    outcomesState?: unknown;
    agentsState?: unknown;
  }) => Alarm[];
  buildStats: (args: {
    harness: Fold | null;
    costState: unknown;
    agentsState: unknown;
    outcomesState: unknown;
    isHarnessBusy?: boolean;
  }) => Stat[];
}

const dash = await buildScreenSandbox<DashHelpers>(DASH_SRC);

// Every part the shell polls answered healthy — the hook chain rides the harness wave too.
const HEALTHY: Fold = {
  status: "ready", partsOk: 5, partsChecked: 5, partsTotal: 5,
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
function statOf(stats: Stat[], id: string): Stat {
  const found = stats.find((t) => t.id === id);
  assert.ok(found, `stat ${id} must exist`);
  return found;
}

// --- The lane: empty when nothing is wrong, worst-first when something is ---

test("a healthy harness with normal spend and no update produces no lane rows", () => {
  const rows = dash.buildAlarms({ harness: HEALTHY, costState: kpi(10, 10), installKind: "hidden" });
  assert.deepEqual([...rows], [], "an empty lane renders nothing at all");
});

test("every down part becomes one harness row naming the parts", () => {
  const rows = dash.buildAlarms({
    harness: { ...HEALTHY, partsOk: 3, downNames: ["PostgreSQL", "autoagent"] },
    costState: kpi(10, 10),
    installKind: "hidden",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "harness");
  assert.equal(rows[0]!.tone, "crit");
  assert.equal(rows[0]!.target, "architecture", "the row routes to the screen that owns the fact");
  assert.ok(rows[0]!.detail?.includes("PostgreSQL"), "the parts are named, not just counted");
  assert.equal(rows[0]!.title, "2 system parts are down", "the shared noun for the watched parts");
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
    harness: { ...HEALTHY, partsOk: 4, downNames: ["autoagent"], unreadSources: ["daemon status"], error: "HTTP 500" },
    costState: kpi(10, 10) },
  { name: "a down part fresh beside a failed failure-count read", id: "harness", isHeld: false,
    harness: { ...HEALTHY, partsOk: 4, downNames: ["autoagent"], unreadSources: ["the failure count"], error: "HTTP 500" },
    costState: kpi(10, 10) },
  { name: "a down part from a fresh harness read", id: "harness", isHeld: false,
    harness: { ...HEALTHY, partsOk: 4, downNames: ["autoagent"] }, costState: kpi(10, 10) },
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

// /api/outcomes/cross-analysis — 400 writer-reported outcomes, the share under test set by one result's count
function outcomes(byResult: Array<{ result: string; count: number }>): unknown {
  const counted = byResult.reduce((sum, row) => sum + row.count, 0);
  return ready({ total: 400, by_result: [...byResult, { result: "done", count: 400 - counted }] });
}
// /api/agents/summary — the circuit-breaker counts the Fleet stat headlines
function fleet(suspended: number, streak: number): unknown {
  return ready({ meta: { total_agents: 12, circuit_breaker: { source: "loaded", registry_agents: 20, suspended_count: suspended, streak_count: streak } } });
}

describe("every firing Task results or Fleet stat has its alarm row, in the stat's tone", () => {
  const rows = [
    { name: "task results under both alarm lines", outcomesState: outcomes([{ result: "fail", count: 4 }]), agentsState: fleet(0, 0) },
    { name: "failed or blocked over its line", outcomesState: outcomes([{ result: "fail", count: 30 }, { result: "blocked", count: 10 }]), agentsState: fleet(0, 0) },
    { name: "open caveats over their line", outcomesState: outcomes([{ result: "done_with_concerns", count: 48 }]), agentsState: fleet(0, 0) },
    { name: "too few outcomes to judge", outcomesState: ready({ total: 4, by_result: [{ result: "fail", count: 4 }] }), agentsState: fleet(0, 0) },
    { name: "a failing streak", outcomesState: LOADING, agentsState: fleet(0, 2) },
    { name: "a suspended agent", outcomesState: LOADING, agentsState: fleet(1, 2) },
    { name: "a suspension held over a failed refresh", outcomesState: LOADING, agentsState: held(fleet(1, 0), "HTTP 500") },
    { name: "an unloaded breaker", outcomesState: LOADING, agentsState: ready({ meta: { circuit_breaker: { source: "unavailable" } } }) },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const sources = { harness: HEALTHY, costState: kpi(10, 10), outcomesState: row.outcomesState, agentsState: row.agentsState };
      const stats = dash.buildStats(sources);
      const alarms = dash.buildAlarms({ ...sources, installKind: "hidden" });
      for (const id of ["outcomes", "fleet"]) {
        const stat = statOf(stats, id);
        const isFiring = stat.tone === "warn" || stat.tone === "crit";
        const alarm = alarms.find((candidate) => candidate.id === id);
        assert.equal(alarm?.tone ?? null, isFiring ? stat.tone : null, `${id}: stat tone ${stat.tone}`);
        if (alarm) assert.equal(alarm.isHeld === true, stat.isHeld === true, `${id}: held with its stat`);
      }
    });
  }
});

describe("a Task results or Fleet alarm states its count in words and links to the owning page", () => {
  const rows = [
    { name: "failed or blocked over its line", id: "outcomes", sources: { outcomesState: outcomes([{ result: "fail", count: 30 }, { result: "blocked", count: 10 }]) },
      title: "10% of task results failed or blocked in the last 7 days", detail: "40 of 400 task results", target: "outcomes", targetLabel: "Task results" },
    { name: "open caveats over their line", id: "outcomes", sources: { outcomesState: outcomes([{ result: "done_with_concerns", count: 48 }]) },
      title: "12% of task results have open caveats in the last 7 days", detail: "48 of 400 task results", target: "outcomes", targetLabel: "Task results" },
    { name: "one suspended agent beside a streak", id: "fleet", sources: { agentsState: fleet(1, 2) },
      title: "1 agent is suspended", detail: "2 on a failing streak", target: "agents", targetLabel: "Agents" },
    { name: "suspended agents and no streak", id: "fleet", sources: { agentsState: fleet(3, 0) },
      title: "3 agents are suspended", detail: null, target: "agents", targetLabel: "Agents" },
    { name: "agents on a failing streak", id: "fleet", sources: { agentsState: fleet(0, 2) },
      title: "2 agents are on a failing streak", detail: null, target: "agents", targetLabel: "Agents" },
    { name: "one agent on a failing streak", id: "fleet", sources: { agentsState: fleet(0, 1) },
      title: "1 agent is on a failing streak", detail: null, target: "agents", targetLabel: "Agents" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const alarms = dash.buildAlarms({ harness: HEALTHY, costState: kpi(10, 10), installKind: "hidden", ...row.sources });
      const alarm = alarms.find((candidate) => candidate.id === row.id);
      assert.ok(alarm, "the row exists");
      assert.deepEqual(
        { title: alarm.title, detail: alarm.detail, target: alarm.target, targetLabel: alarm.targetLabel },
        { title: row.title, detail: row.detail, target: row.target, targetLabel: row.targetLabel },
      );
    });
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

// --- The stat row: four stats, and four distinguishable payload states ---

test("the stat row is always the four stats, in the priority spine's order", () => {
  const stats = dash.buildStats({
    harness: HEALTHY, costState: kpi(10, 10), agentsState: LOADING, outcomesState: LOADING,
  });
  assert.equal(stats.length, 4);
  assert.equal(stats.map((t) => t.id).join(","), "harness,outcomes,fleet,spend");
});

test("every stat drills to its own screen in a fixed order", () => {
  const stats = dash.buildStats({ harness: HEALTHY, costState: kpi(10, 10), agentsState: LOADING, outcomesState: LOADING });
  assert.deepEqual([...stats.map((t) => t.target)], ["architecture", "outcomes", "agents", "cost"]);
});

test("loading, error and unavailable each read differently, none reads as a value, and only a finished unread read is unknown", () => {
  // a first read in flight is the loading state, not a value → only a finished, unread read says Not loaded
  const states: [string, unknown, string, string | null, string][] = [
    ["loading", LOADING, "loading", null, "neutral"],
    ["error", ERRORED, "error", "not-loaded", "unknown"],
    ["unavailable", ready({ meta: {} }), "unavailable", "not-loaded", "unknown"],
  ];
  for (const [name, agentsState, expected, absent, tone] of states) {
    const stat = statOf(
      dash.buildStats({ harness: HEALTHY, costState: LOADING, agentsState, outcomesState: LOADING }),
      "fleet",
    );
    assert.equal(stat.status, expected, name);
    assert.equal(stat.value, null, `${name} must not render a number nobody loaded`);
    assert.equal(stat.absent ?? null, absent, `${name}: only a finished, unread read is marked not loaded`);
    assert.equal(stat.tone, tone, `${name}: no verdict tone, unknown once the check could not run`);
  }
});

test("a failed stat names its own region and source, so its Retry reloads that region alone", () => {
  const stats = dash.buildStats({ harness: HEALTHY, costState: ERRORED, agentsState: ERRORED, outcomesState: ERRORED });
  const regions = [["outcomes", "outcomes"], ["fleet", "agents"], ["spend", "cost"]];
  for (const [statId, region] of regions) {
    const stat = statOf(stats, statId) as Stat & { region: string; source: string; error: string };
    assert.equal(stat.status, "error", statId);
    assert.equal(stat.region, region, statId);
    assert.ok(stat.source, `${statId} names what failed to load`);
    assert.equal(stat.error, "HTTP 500", `${statId} carries the raw answer for Details`);
    assert.match(String(stat.context), /agents|task results|today's spend/, `${statId}: the context line states what failed`);
  }
});

test("a stat refreshing over held data is busy; a first load is not a refresh", () => {
  const refreshing = { ...(kpi(10, 10) as object), busy: true };
  const stats = dash.buildStats({ harness: HEALTHY, costState: refreshing, agentsState: { ...LOADING, busy: true }, outcomesState: LOADING });
  const spend = statOf(stats, "spend") as Stat & { isBusy: boolean };
  const fleet = statOf(stats, "fleet") as Stat & { isBusy: boolean };
  assert.equal(spend.status, "ready");
  assert.equal(spend.isBusy, true);
  assert.equal(fleet.isBusy, false);
});

function fleetStat(circuitBreaker: unknown): Stat {
  return statOf(
    dash.buildStats({
      harness: HEALTHY, costState: LOADING, outcomesState: LOADING,
      agentsState: ready({ meta: { total_agents: 12, circuit_breaker: circuitBreaker } }),
    }),
    "fleet",
  );
}

test("the fleet stat headlines the suspended count and tones by the worst breaker state", () => {
  const rows: Array<[string, number, number, string]> = [
    ["nothing tripped", 0, 0, "ok"],
    ["a streak short of suspension", 0, 2, "warn"],
    ["a suspended agent", 1, 2, "crit"],
  ];
  for (const [name, suspended, streak, tone] of rows) {
    const stat = fleetStat({ source: "loaded", registry_agents: 20, suspended_count: suspended, streak_count: streak, alarms: [] });
    assert.equal(stat.status, "ready", name);
    assert.equal(stat.value, String(suspended), `${name}: the suspended count is the headline`);
    assert.equal(stat.tone, tone, name);
  }
});

test("the fleet stat reads unavailable when the breaker state is, never a zero suspended", () => {
  for (const breaker of [undefined, { source: "unavailable", registry_agents: 0, suspended_count: 0, streak_count: 0, alarms: [] }]) {
    const stat = fleetStat(breaker);
    assert.equal(stat.status, "unavailable");
    assert.equal(stat.absent, "not-loaded");
    assert.equal(stat.value, null);
    assert.equal(stat.tone, "unknown");
  }
});

// The loading placeholder belongs to the first-poll wait; the stat must not call that wait 'unavailable'.
test("the harness stat is loading exactly while the fold is, and unavailable only after", () => {
  const empty = { ...HEALTHY, partsOk: 0, partsChecked: 0, uncheckedNames: ["PostgreSQL"] };
  const folds: [string, string, string | null][] = [["loading", "loading", null], ["unavailable", "unavailable", "not-loaded"]];
  for (const [foldStatus, expected, absent] of folds) {
    const stat = statOf(
      dash.buildStats({
        harness: { ...empty, status: foldStatus },
        costState: LOADING, agentsState: LOADING, outcomesState: LOADING,
      }),
      "harness",
    );
    assert.equal(stat.status, expected, foldStatus);
    assert.equal(stat.value, null, `${foldStatus} must not render a count nobody polled`);
    assert.equal(stat.absent ?? null, absent, `${foldStatus}: only a lost reading is marked not loaded`);
    assert.equal(stat.tone, foldStatus === "unavailable" ? "unknown" : "neutral", `${foldStatus}: only a lost reading is unknown`);
    assert.equal(stat.canRetry === true, foldStatus === "unavailable", `${foldStatus}: only a lost reading offers Retry`);
  }
});

test("the harness stat counts only the parts the shell actually polled", () => {
  const stat = statOf(
    dash.buildStats({
      harness: {
        ...HEALTHY,
        partsOk: 3, partsChecked: 4,
        downNames: ["autoagent"], uncheckedNames: ["Hook Chain"],
      },
      costState: LOADING, agentsState: LOADING, outcomesState: LOADING,
    }),
    "harness",
  );
  assert.equal(stat.value, "1 of 4 down", "the verdict leads, over what answered, not what exists");
  assert.equal(stat.tone, "crit");
  assert.equal(stat.context, null, "a firing stat leaves its line to the alarm row");
  assert.ok(stat.notes.some((note) => note.includes("Hook Chain")), "the unchecked part is named behind ⓘ, not silently dropped");
});

// the alarm list owns every alarm sentence (spec 44084 §9) → a firing stat keeps its value and tone, never the names or the words
test("a firing stat never restates its alarm: the harness stat leaves the down parts to the alarm row", () => {
  const rows = [
    { name: "one down", downNames: ["autoagent"], uncheckedNames: [] as string[] },
    { name: "two down beside an unpolled part", downNames: ["autoagent", "monitor"], uncheckedNames: ["Hook Chain"] },
  ];
  for (const row of rows) {
    const harness = { ...HEALTHY, partsOk: 4 - row.downNames.length, partsChecked: 5 - row.uncheckedNames.length, downNames: row.downNames, uncheckedNames: row.uncheckedNames };
    const stat = statOf(dash.buildStats({ harness, costState: LOADING, agentsState: LOADING, outcomesState: LOADING }), "harness");
    const [alarm] = dash.buildAlarms({ harness, costState: LOADING, installKind: "hidden" });
    const statText = [stat.context, ...stat.notes].join(" ");
    for (const name of row.downNames) {
      assert.ok(String(alarm.detail).includes(name), `${row.name}: the alarm row names ${name}`);
      assert.ok(!statText.includes(name), `${row.name}: the stat never names ${name} — "${statText}"`);
    }
  }
});

test("the harness and fleet stats fill the context line under their count with a secondary fact", () => {
  const harness = statOf(
    dash.buildStats({ harness: HEALTHY, costState: LOADING, agentsState: LOADING, outcomesState: LOADING }), "harness");
  assert.equal(harness.context, "All 5 checked", "a fully polled harness says its coverage");
  const agentsState = ready({
    agents: [{ agent_id: "glass-atrium-agent-a", agent_name: "glass-atrium-agent-a", runs: 2731 }],
    meta: { total_agents: 12, circuit_breaker: { source: "loaded", registry_agents: 20, suspended_count: 0, streak_count: 0, alarms: [] } },
  });
  const fleet = statOf(dash.buildStats({ harness: HEALTHY, costState: LOADING, agentsState, outcomesState: LOADING }), "fleet");
  assert.equal(fleet.context, "None on a failing streak");
  assert.ok(fleet.notes.includes("12 of 20 registered agents had a run in the last 7 days."), JSON.stringify(fleet.notes));
  assert.ok(fleet.notes.includes("Most runs: glass-atrium-agent-a, 2,731."), "the busiest agent is the region's one ordered row");
  const noRows = fleetStat({ source: "loaded", registry_agents: 20, suspended_count: 0, streak_count: 0, alarms: [] });
  assert.ok(!noRows.notes.some((note) => /Most runs/.test(note)), "no row → no busiest agent, never a made-up one");
});

test("the outcome stat takes its verdict from the shared rule", () => {
  const crit = statOf(
    dash.buildStats({
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

  const lowN = statOf(
    dash.buildStats({
      harness: HEALTHY, costState: LOADING, agentsState: LOADING,
      outcomesState: ready({ total: 4, by_result: [{ result: "fail", count: 4 }] }),
    }),
    "outcomes",
  );
  assert.equal(lowN.status, "unavailable", "a sample too small to judge is not a ready verdict");
  assert.equal(lowN.tone, "neutral");
});

test("the outcome stat leads with the failed share, its counts on the context line, its alert lines and caveats behind ⓘ", () => {
  const stat = statOf(
    dash.buildStats({
      harness: HEALTHY, costState: LOADING, agentsState: LOADING,
      outcomesState: ready({
        total: 200,
        by_result: [{ result: "fail", count: 4 }, { result: "done_with_concerns", count: 10 }, { result: "done", count: 186 }],
      }),
    }),
    "outcomes",
  );
  assert.equal(stat.value, "2%", "the failed share is the headline, its .0 dropped");
  assert.equal(stat.context, "4 of 200 task results", "the context names the count and its denominator");
  const notes = stat.notes.join(" ");
  // the drawer leads each stat's notes with its label → the failure line never restates it
  assert.equal(stat.notes[0], "Alarm at 5%.", "the failure alert line moves behind ⓘ");
  assert.match(notes, /Open caveats 5% \(10\), alarm at 10%/, "the caveat share sits beside its own alert line");
  assert.match(notes, /reported themselves/, "and the counting rule");
  assert.doesNotMatch(String(stat.context), /alarm|reported/i, "the visible line carries neither");
});

// spec 44084 §9 (R8): a firing stat is value + tone glyph; its alarm row already states the count
// spec 44084 §9.1: the glyph sits on the figure that tripped → the value, or the context line naming the tripped count
describe("the outcome stat's context line names the tripped count when the value is not the figure that tripped", () => {
  const rows = [
    { name: "caveats over their line → the line names the caveat count", byResult: [{ result: "done_with_concerns", count: 48 }], context: "48 of 400 with open caveats", isContextTripped: true },
    { name: "failures over their line → the value tripped, the line stays empty", byResult: [{ result: "fail", count: 40 }, { result: "done_with_concerns", count: 48 }], context: null, isContextTripped: false },
    { name: "neither line tripped → the failed count", byResult: [{ result: "fail", count: 4 }, { result: "done_with_concerns", count: 8 }], context: "4 of 400 task results", isContextTripped: false },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const stats = dash.buildStats({ harness: HEALTHY, costState: LOADING, agentsState: LOADING, outcomesState: outcomes(row.byResult) });
      const stat = statOf(stats, "outcomes");
      assert.equal(stat.context, row.context);
      assert.equal(stat.isContextTripped === true, row.isContextTripped, "the glyph's place");
    });
  }
});

test("the spend stat tones only on the pace verdict, never on the amount", () => {
  const big = statOf(
    dash.buildStats({ harness: HEALTHY, costState: kpi(9999, 20000), agentsState: LOADING, outcomesState: LOADING }),
    "spend",
  );
  assert.equal(big.tone, "ok", "a large but on-pace spend reads normal, never an alarm");
  const hot = statOf(
    dash.buildStats({ harness: HEALTHY, costState: kpi(3, 1), agentsState: LOADING, outcomesState: LOADING }),
    "spend",
  );
  assert.equal(hot.tone, "warn", "a small but off-pace spend is");
});

// amount first (spec 44084 §3.4) → the title states the figure that crossed the cut, the detail its multiple of the basis
describe("the spend alarm leads with the amount and states its multiple of the 7-day average", () => {
  const rows = [
    { name: "the 3-hour pace leads", today: 842, pace: 3_310,
      title: "$842 so far today, running at $3,310/day over the last 3 hours", detail: "2.4× the 7-day average ($1,380/day)" },
    { name: "so-far leads", today: 1_790, pace: 900, title: "$1,790 so far today", detail: "1.3× the 7-day average ($1,380/day)" },
    { name: "under $100, two decimals", today: 3, pace: 1, title: "$3.00 so far today", detail: "1.5× the 7-day average ($2.00/day)" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const avg = row.name.startsWith("under") ? 2 : 1_380;
      const [alarm] = dash.buildAlarms({ harness: HEALTHY, costState: kpi(row.today, avg, row.pace), installKind: "hidden" });
      assert.equal(alarm.id, "spend");
      assert.equal(alarm.title, row.title);
      assert.equal(alarm.detail, row.detail);
    });
  }
});

test("the spend stat states no multiple of its own — its alarm rule and basis sit behind ⓘ, the alarm row states the multiple", () => {
  const rows = [
    { name: "on pace", today: 3, avg: 10, pace: 8 },
    { name: "hot", today: 30, avg: 10, pace: 5 },
  ];
  for (const row of rows) {
    const stat = statOf(dash.buildStats({ harness: HEALTHY, costState: kpi(row.today, row.avg, row.pace), agentsState: LOADING, outcomesState: LOADING }), "spend");
    assert.doesNotMatch(String(stat.context), /×/, `${row.name}: "${stat.context}"`);
    assert.ok(stat.notes.some((note) => /1\.25× the 7-day average \(\$10\.00\/day\)/.test(note)), `${row.name}: ${JSON.stringify(stat.notes)}`);
  }
});

// owner rule: no sentence on a screen runs past 12 words, and none uses a recorder-internal word
test("every sentence in the Status card's ⓘ stays within 12 plain words", () => {
  const states = [
    { outcomesState: ready({ total: 200, by_result: [{ result: "fail", count: 4 }, { result: "done", count: 196 }] }), costState: kpi(3, 10, 8) },
    { outcomesState: ready({ total: 4, by_result: [{ result: "fail", count: 4 }] }), costState: kpi(0, 0) },
  ];
  for (const state of states) {
    const notes = dash.buildStats({ harness: HEALTHY, agentsState: LOADING, ...state }).flatMap((stat) => stat.notes ?? []);
    for (const sentence of notes.flatMap((note) => note.split(/(?<=\.)\s+/))) {
      assert.ok(sentence.split(/\s+/).length <= 12, `${sentence.split(/\s+/).length} words: "${sentence}"`);
      assert.doesNotMatch(sentence, /writer-emitted|synthesized|reconstructed|poisoned/, sentence);
    }
  }
});

test("stat labels carry no window text — the window is its own field the row joins on render", () => {
  const stats = dash.buildStats({ harness: HEALTHY, costState: LOADING, agentsState: LOADING, outcomesState: LOADING });
  for (const stat of stats) assert.ok(!/\(|7/.test(stat.label), `${stat.id} label: ${stat.label}`);
  const windowed = stats.filter((t) => t.window === "7d").map((t) => t.id);
  assert.deepEqual([...windowed], ["outcomes", "fleet"]);
});

// --- A failed read never reads as a current verdict, and one outage offers one Retry ---

interface FailureHelpers {
  getPageSharedFailure: (stats: Stat[], panels?: Array<{ source: string; error: string | null }>) => { sources: string[]; error: string } | null;
}
const failure = dash as unknown as FailureHelpers;

function held(state: unknown, error: string): unknown {
  return { ...(state as object), error };
}
// a fold the shell built while some harness stores failed their latest read
function unreadFold(over: Record<string, unknown>): Fold {
  return { ...HEALTHY, unreadSources: ["daemon status"], error: "HTTP 500", ...over } as Fold;
}
// the three parts a two-part read leaves out — foldHarness lists every part it could not judge
const LOST_PARTS = ["autoagent", "glass-atrium-wiki-curator", "Hook Chain"];
// every harness store the shell reads, by its label → the longest unread list a fold can carry
const HARNESS_SOURCE_LABELS = ["the failure count", "daemon status", "the health probe", "the hook chain", "hook failures"];

test("a region whose refresh failed over held data reads last-known and carries the failure", () => {
  const fleet = ready({ meta: { total_agents: 3, circuit_breaker: { source: "loaded", suspended_count: 0, streak_count: 0 } } });
  const rows = [
    { name: "fresh reads", error: null, lastKnown: false },
    { name: "held reads after a failed refresh", error: "HTTP 500", lastKnown: true },
  ];
  const ids = ["outcomes", "fleet", "spend"];
  const statsFor = (row: (typeof rows)[number]) => {
    const wrap = (state: unknown) => (row.error ? held(state, row.error) : state);
    return dash.buildStats({
      harness: HEALTHY, costState: wrap(kpi(1, 10)), agentsState: wrap(fleet), outcomesState: wrap(ready({})),
    });
  };
  for (const row of rows) {
    const stats = statsFor(row);
    for (const id of ids) {
      const stat = statOf(stats, id) as Stat & { error?: string | null; source: string };
      assert.equal(stat.isHeld === true, row.lastKnown, `${row.name}: ${id} held`);
      assert.equal(stat.context === "Last known", row.lastKnown, `${row.name}: ${id} context "${stat.context}"`);
      const cause = `Last known — couldn't refresh ${stat.source}`;
      assert.equal(stat.cause === cause && stat.notes.includes(`${cause}.`), row.lastKnown, `${row.name}: ${id} names the failed refresh behind the line`);
      assert.equal(stat.error ?? null, row.error, `${row.name}: ${id} carries the failure`);
      assert.equal(stat.canRetry === true, row.lastKnown, `${row.name}: ${id} Retry`);
    }
  }
  // a held all-clear never reads healthy: the ok tone gives way to unknown
  const heldStats = statsFor(rows[1]);
  for (const id of ids) assert.notEqual(statOf(heldStats, id).tone, "ok", `${id} held after a failed refresh`);
});

test("a held stat keeps a warn or crit alarm through a failed refresh, and only an all-clear reads unknown on its line", () => {
  const breaker = (suspended: number) => ({ source: "loaded", suspended_count: suspended, streak_count: 0 });
  const fleetOf = (suspended: number) => ready({ meta: { total_agents: 3, circuit_breaker: breaker(suspended) } });
  for (const suspended of [0, 1]) {
    const fresh = statOf(dash.buildStats({ harness: HEALTHY, costState: LOADING, outcomesState: LOADING, agentsState: fleetOf(suspended) }), "fleet");
    const stale = statOf(
      dash.buildStats({ harness: HEALTHY, costState: LOADING, outcomesState: LOADING, agentsState: held(fleetOf(suspended), "HTTP 500") }),
      "fleet",
    );
    const isAlarm = fresh.tone === "warn" || fresh.tone === "crit";
    assert.equal(isAlarm, suspended > 0, `${suspended} suspended: a suspension is the alarm under test`);
    assert.equal(stale.tone, isAlarm ? fresh.tone : "unknown", `${suspended} suspended: fresh ${fresh.tone}`);
    assert.equal(stale.isContextTripped, !isAlarm, `${suspended} suspended: the unknown glyph sits on the line, an alarm's on its value`);
    assert.equal(stale.isHeld, true, `${suspended} suspended: the held reading is still flagged`);
  }
});

test("a cold-failed stat stays failed while its Retry is in flight, never a loader", () => {
  const retrying = { status: "loading", data: null, error: "HTTP 500", busy: true };
  const stats = dash.buildStats({ harness: HEALTHY, costState: retrying, agentsState: retrying, outcomesState: retrying });
  for (const id of ["outcomes", "fleet", "spend"]) {
    const stat = statOf(stats, id) as Stat & { error: string; isBusy: boolean };
    assert.equal(stat.status, "error", `${id} keeps its failure`);
    assert.equal(stat.error, "HTTP 500", id);
    assert.equal(stat.isBusy, true, `${id} marks the Retry in flight`);
  }
});

test("held failures sharing one cause collapse into the page banner's single Retry", () => {
  const stats = dash.buildStats({
    harness: HEALTHY,
    costState: held(kpi(1, 10), "HTTP 500"),
    agentsState: held(ready({}), "HTTP 500"),
    outcomesState: held(ready({}), "HTTP 500"),
  });
  const shared = failure.getPageSharedFailure(stats);
  assert.ok(shared, "held failures join the banner");
  assert.deepEqual([...shared.sources].sort(), ["agents", "task results", "today's spend"]);
});

test("the week panels join the stats' outage when the cause is the same, so one cause keeps one Retry", () => {
  const stats = dash.buildStats({ harness: HEALTHY, costState: ERRORED, agentsState: ERRORED, outcomesState: ERRORED });
  const rows = [
    { name: "panels fail on the stats' cause", error: "HTTP 500", isJoined: true },
    { name: "panels fail on another cause", error: "HTTP 404", isJoined: false },
  ];

  for (const row of rows) {
    const panels = [{ source: "daily spend", error: row.error }, { source: "runs by hour", error: row.error }];
    const shared = failure.getPageSharedFailure(stats, panels);
    assert.ok(shared, `${row.name}: the stats still share one banner`);
    assert.equal(shared.sources.includes("daily spend") && shared.sources.includes("runs by hour"), row.isJoined, row.name);
  }
});

test("a cold harness outage is a failed stat listed in the same banner as the regions", () => {
  const harness = unreadFold({ status: "unavailable", partsOk: 0, partsChecked: 0 });
  const stats = dash.buildStats({ harness, costState: ERRORED, agentsState: ERRORED, outcomesState: ERRORED });
  const stat = statOf(stats, "harness");
  assert.equal(stat.status, "error");
  assert.ok(failure.getPageSharedFailure(stats)?.sources.includes("system parts"), "the banner names the system parts");
});

test("a harness refresh that failed over held readings reads last-known, keeping a held fault", () => {
  const rows = [
    { name: "held parts all up", downNames: [] as string[], tone: "unknown" },
    { name: "a held part down", downNames: ["autoagent"], tone: "crit" },
  ];

  for (const row of rows) {
    const harness = unreadFold({ partsOk: 5 - row.downNames.length, downNames: row.downNames });
    const stat = statOf(
      dash.buildStats({ harness, costState: kpi(1, 10), agentsState: ready({}), outcomesState: ready({}) }),
      "harness",
    );
    assert.equal(stat.context, "Last known", `${row.name}: the line says only Last known`);
    assert.equal(stat.cause, "Last known — couldn't refresh daemon status", `${row.name}: names the source that failed`);
    assert.equal(stat.tone, row.tone, `${row.name}: tone`);
  }
});

describe("a partly unread harness stat says only its state on its line; the line's title and ⓘ name every unread source", () => {
  const rows = [
    { name: "one held source", over: { unreadSources: ["daemon status"] }, context: "Last known", lead: "Last known — couldn't refresh" },
    { name: "every source held", over: { unreadSources: HARNESS_SOURCE_LABELS }, context: "Last known", lead: "Last known — couldn't refresh" },
    { name: "parts lost to a cold read", over: { unreadSources: ["daemon status", "the hook chain"], partsOk: 2, partsChecked: 2, uncheckedNames: LOST_PARTS },
      context: "3 not read", lead: "3 not read — couldn't read" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const stat = statOf(
        dash.buildStats({ harness: unreadFold(row.over), costState: LOADING, agentsState: LOADING, outcomesState: LOADING }),
        "harness",
      );
      const cause = `${row.lead} ${row.over.unreadSources.join(" · ")}`;
      assert.equal(stat.context, row.context, "the line");
      assert.equal(stat.cause, cause, "the title names every unread source");
      assert.ok(stat.notes.includes(`${cause}.`), `ⓘ names every unread source: ${stat.notes.join(" | ")}`);
    });
  }
});

test("parts lost to a cold read failure count against every part, never only the parts still read", () => {
  const rows = [
    { name: "two up, three never read", partsOk: 2, downNames: [] as string[], value: "2 of 5 up" },
    { name: "one down, three never read", partsOk: 1, downNames: ["PostgreSQL"], value: "1 of 5 down" },
  ];

  for (const row of rows) {
    const harness = unreadFold({ partsOk: row.partsOk, partsChecked: 2, downNames: row.downNames, uncheckedNames: LOST_PARTS });
    const stat = statOf(
      dash.buildStats({ harness, costState: kpi(1, 10), agentsState: ready({}), outcomesState: ready({}) }),
      "harness",
    );
    assert.equal(stat.value, row.value, `${row.name}: value`);
    assert.equal(stat.context, "3 not read", `${row.name}: the lost parts are counted`);
  }
});

test("the coverage line credits the System map only when every read answered, so a lost part never reads as unpolled by design", () => {
  const rows = [
    { name: "every read answered", fold: { ...HEALTHY, partsOk: 4, partsChecked: 4, uncheckedNames: ["Hook Chain"] } as Fold, isOnMap: true },
    { name: "a failed read lost three parts", fold: unreadFold({ partsOk: 2, partsChecked: 2, uncheckedNames: LOST_PARTS }), isOnMap: false },
  ];

  for (const row of rows) {
    const stat = statOf(
      dash.buildStats({ harness: row.fold, costState: kpi(1, 10), agentsState: ready({}), outcomesState: ready({}) }),
      "harness",
    );
    // the coverage line is the context of a full read, and moves behind ⓘ when the context names an unread source
    const coverage = [stat.context, ...stat.notes].find((line) => / of 5 (checked|read) /.test(String(line))) ?? "";
    assert.equal(/System map/.test(coverage), row.isOnMap, `${row.name}: System map credit in "${coverage}"`);
    assert.match(coverage, new RegExp(`^${row.fold.partsChecked} of 5 `), `${row.name}: states how many parts it covers`);
  }
});

test("part names keep their hyphens unbreakable wherever the page lists them", () => {
  const harness = { ...HEALTHY, partsOk: 3, partsChecked: 4, downNames: ["glass-atrium-wiki-curator"], uncheckedNames: ["Chromium-Export"] };
  const stat = statOf(
    dash.buildStats({ harness, costState: kpi(1, 10), agentsState: ready({}), outcomesState: ready({}) }),
    "harness",
  );
  const [row] = dash.buildAlarms({ harness, costState: kpi(10, 10), installKind: "hidden" });
  const lists = [
    { where: "stat coverage note", text: stat.notes.join(" "), name: /Chromium‑Export/ },
    { where: "lane row detail", text: row?.detail ?? "", name: /glass‑atrium‑wiki‑curator/ },
  ];

  for (const { where, text, name } of lists) {
    assert.doesNotMatch(text, /-/, `${where}: no breakable hyphen`);
    assert.match(text, name, `${where}: still names the part`);
  }
});

test("a partly unread harness never reads healthy: its line carries the unknown glyph", () => {
  const harness = unreadFold({ partsOk: 2, partsChecked: 2, uncheckedNames: LOST_PARTS, unreadSources: ["daemon status", "the hook chain"] });
  const stat = statOf(
    dash.buildStats({ harness, costState: kpi(1, 10), agentsState: ready({}), outcomesState: ready({}) }),
    "harness",
  );
  assert.equal(stat.tone, "unknown");
  assert.equal(stat.isContextTripped, true, "the glyph rides the line that names the unread parts");
  assert.match(String(stat.cause), /daemon status/);
  assert.equal(stat.canRetry, true, "the harness stat keeps its own Retry when no banner covers it");
});

test("the harness stat dims and reads busy while the shell re-reads it, like a region stat refreshing over held data", () => {
  const rows = [
    { name: "held reading, re-read in flight", harness: HEALTHY, isHarnessBusy: true, busy: true },
    { name: "held reading, no re-read", harness: HEALTHY, isHarnessBusy: false, busy: false },
    { name: "first load is not a refresh", harness: { ...HEALTHY, status: "loading" }, isHarnessBusy: true, busy: false },
  ];
  for (const row of rows) {
    const stats = dash.buildStats({ harness: row.harness, isHarnessBusy: row.isHarnessBusy, costState: LOADING, agentsState: LOADING, outcomesState: LOADING });
    assert.equal((statOf(stats, "harness") as Stat & { isBusy: boolean }).isBusy, row.busy, row.name);
  }
});

test("a harness stat with down parts says 'down' once across its value and context", () => {
  const rows = [
    { name: "one down", downNames: ["autoagent"], uncheckedNames: [] },
    { name: "two down beside unpolled parts", downNames: ["autoagent", "monitor"], uncheckedNames: ["Hook Chain"] },
  ];
  for (const row of rows) {
    const stat = statOf(
      dash.buildStats({
        harness: { ...HEALTHY, partsOk: 2, downNames: row.downNames, uncheckedNames: row.uncheckedNames },
        costState: LOADING, agentsState: LOADING, outcomesState: LOADING,
      }),
      "harness",
    );
    const visible = [stat.value, stat.context].join(" ");
    assert.equal(visible.match(/down/gi)?.length, 1, `${row.name}: "${visible}"`);
    assert.equal(stat.tone, "crit");
  }
});

test("the spend stat states its move against yesterday by this time from the shell's kpi reading, and none without one", () => {
  const rows = [
    { name: "up on yesterday", today: 12, yesterday: 10, context: /^Up 20% on \$10\.00 yesterday by this time$/ },
    { name: "down on yesterday", today: 5, yesterday: 20, context: /^Down 75% on \$20\.00 yesterday by this time$/ },
    { name: "level with yesterday", today: 10, yesterday: 10, context: /^Level with \$10\.00 yesterday by this time$/ },
    { name: "a fractional move keeps one decimal", today: 10.5, yesterday: 9, context: /^Up 16\.7% on \$9\.00 yesterday by this time$/ },
    { name: "a move under a tenth of a point is still a move", today: 10.001, yesterday: 10, context: /^Up <0\.1% on \$10\.00 yesterday by this time$/ },
    { name: "a rise just under double stays a percentage", today: 19.98, yesterday: 10, context: /^Up 99\.8% on \$10\.00 yesterday by this time$/ },
    { name: "a doubled day is a multiple, never a three-digit percentage", today: 20, yesterday: 10, context: /^2\.0× yesterday by this time \(\$10\.00\)$/ },
    { name: "a day far past double states its multiple", today: 88, yesterday: 11, context: /^8\.0× yesterday by this time \(\$11\.00\)$/ },
  ];
  for (const row of rows) {
    const harness = { ...HEALTHY, kpi: { today_cost_usd: row.today, yesterday_same_time_cost_usd: row.yesterday } };
    const stat = statOf(
      dash.buildStats({ harness, costState: kpi(row.today, 1000), agentsState: LOADING, outcomesState: LOADING }),
      "spend",
    );
    assert.match(String(stat.context), row.context, row.name);
  }
});

test("a firing spend stat leaves its line empty — the alarm row holds the one baseline", () => {
  const harness = { ...HEALTHY, kpi: { today_cost_usd: 30, yesterday_same_time_cost_usd: 10 } };
  const stat = statOf(dash.buildStats({ harness, costState: kpi(30, 10), agentsState: LOADING, outcomesState: LOADING }), "spend");
  assert.equal(stat.tone, "warn");
  assert.equal(stat.context, null);
});

test("the agents stat states the failing streak on its line unless a suspension trips, and keeps the fleet size behind ⓘ", () => {
  const rows = [
    { name: "no streak, no row", suspended: 0, streak: 0, context: "None on a failing streak", isContextTripped: false },
    { name: "a streak fires the row, the line names the tripped count", suspended: 0, streak: 3, context: "3 on a failing streak", isContextTripped: true },
    { name: "a suspension fires the row, the streak its detail", suspended: 1, streak: 2, context: null, isContextTripped: false },
  ];
  for (const { name, suspended, streak, context, isContextTripped } of rows) {
    const stat = fleetStat({ source: "loaded", suspended_count: suspended, streak_count: streak });
    assert.equal(stat.context, context, name);
    assert.equal(stat.isContextTripped === true, isContextTripped, `${name}: the glyph's place`);
    assert.ok(stat.notes.some((note) => /12 agents/.test(note)), `streak ${streak}: ${JSON.stringify(stat.notes)}`);
  }
});

// --- Task results stat: the prior-window delta, behind ⓘ ---

// current window starts where the prior one ends (server anchor) → 09-23..today against 09-16..09-22
function outcomesWithPrior(current: unknown, prior: unknown): unknown {
  const priorWindow = prior === null ? {} : { prior_window: { period_start: "2026-09-16", period_end: "2026-09-23", ...(prior as object) } };
  return ready({ ...(current as object), ...priorWindow });
}
const CURRENT_20PCT = {
  total: 200, reconstructed_total: 0,
  by_result: [{ result: "fail", count: 30 }, { result: "blocked", count: 10 }, { result: "done", count: 160 }],
};
function trendNoteOf(stat: Stat): string | null {
  return stat.notes.find((note) => /since|No comparison/.test(note)) ?? null;
}

test("the outcome stat's delta compares failed-or-blocked shares and names both windows", () => {
  const rows = [
    { name: "share up", prior: { total: 100, reconstructed_total: 0, by_result: [{ result: "fail", count: 5 }, { result: "done", count: 95 }] }, trend: /^Up 15 pts/ },
    { name: "share down", prior: { total: 100, reconstructed_total: 0, by_result: [{ result: "blocked", count: 30 }, { result: "done", count: 70 }] }, trend: /^Down 10 pts/ },
    { name: "same share on half the count", prior: { total: 100, reconstructed_total: 0, by_result: [{ result: "fail", count: 20 }, { result: "done", count: 80 }] }, trend: /^Level/ },
    { name: "prior reconstructed rows left out", prior: { total: 150, reconstructed_total: 50, by_result: [{ result: "fail", count: 30, reconstructed_count: 10 }, { result: "done", count: 120, reconstructed_count: 40 }] }, trend: /^Level/ },
  ];
  for (const row of rows) {
    const stat = statOf(dash.buildStats({ harness: HEALTHY, costState: LOADING, agentsState: LOADING, outcomesState: outcomesWithPrior(CURRENT_20PCT, row.prior) }), "outcomes");
    const trend = String(trendNoteOf(stat));
    assert.match(trend, row.trend, row.name);
    assert.match(trend, /since 09-23/, `${row.name}: names the current window`);
    assert.match(trend, /09-16 – 09-22/, `${row.name}: names the prior window, end inclusive`);
  }
});

test("the outcome stat states why a prior-window comparison is missing", () => {
  const none = statOf(dash.buildStats({ harness: HEALTHY, costState: LOADING, agentsState: LOADING, outcomesState: outcomesWithPrior(CURRENT_20PCT, null) }), "outcomes");
  assert.equal(trendNoteOf(none), null, "no prior window served → no trend note");
  const thin = statOf(dash.buildStats({
    harness: HEALTHY, costState: LOADING, agentsState: LOADING,
    outcomesState: outcomesWithPrior(CURRENT_20PCT, { total: 1, reconstructed_total: 0, by_result: [{ result: "done", count: 1 }] }),
  }), "outcomes");
  assert.match(String(trendNoteOf(thin)), /too few.*09-16 – 09-22/, "a thin prior window names itself instead of a delta");
});

test("the spend stat says why its day-over-day change is missing, telling a pending, a failed and an empty read apart", () => {
  const rows = [
    { name: "harness KPI not read yet", kpi: null, context: /^Change on yesterday not read yet$/ },
    { name: "harness KPI read failed", kpi: null, error: "HTTP 500", context: /unavailable — couldn't read/ },
    { name: "yesterday's figure absent from the read", kpi: { today_cost_usd: 5, yesterday_same_time_cost_usd: null }, context: /unavailable — the reading carries no spend/ },
    { name: "nothing spent yesterday by now", kpi: { today_cost_usd: 5, yesterday_same_time_cost_usd: 0 }, context: /no spend yesterday/i },
    { name: "a comparand exists", kpi: { today_cost_usd: 5, yesterday_same_time_cost_usd: 4 }, context: /^Up 25%/ },
  ];
  for (const row of rows) {
    const harness = { ...HEALTHY, kpi: row.kpi, error: row.error ?? null };
    const stat = statOf(dash.buildStats({ harness, costState: kpi(5, 10), agentsState: LOADING, outcomesState: LOADING }), "spend");
    assert.match(String(stat.context), row.context, row.name);
  }
});

// spec 44084 §9.1: one noun per thing → every outcome line says task results, never outcomes
describe("the Failed or blocked stat names its records task results in every state it can read", () => {
  const rows = [
    { name: "too few to judge", state: ready({ total: 4, by_result: [{ result: "fail", count: 4 }] }) },
    { name: "nothing recorded", state: ready({ total: 0, by_result: [] }) },
    { name: "no writer-reported record", state: ready({}) },
    { name: "a prior window too small to compare", state: outcomesWithPrior(CURRENT_20PCT, { total: 2, by_result: [{ result: "done", count: 2 }] }) },
    { name: "a judged week", state: outcomesWithPrior(CURRENT_20PCT, { total: 200, by_result: [{ result: "fail", count: 10 }, { result: "done", count: 190 }] }) },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const stat = statOf(dash.buildStats({ harness: HEALTHY, costState: LOADING, agentsState: LOADING, outcomesState: row.state }), "outcomes");
      const lines = [stat.context, ...stat.notes].filter(Boolean).join(" | ");
      assert.doesNotMatch(lines, /\boutcomes\b/, lines);
      assert.match(lines, /task results/, lines);
    });
  }
});
