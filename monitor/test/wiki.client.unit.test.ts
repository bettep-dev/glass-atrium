// Unit tests for the wiki screen's lane / band / state helpers in
// public/src/screens/wiki.jsx, plus the two additive read-path helpers the screen
// consumes from routes/wiki.ts. Both halves pin one contract: a fact the server did
// not report must never render as a measured value.
//
// Sandbox harness (esbuild + node:vm over the real shipped wiki.jsx): client-sandbox.ts.
// The route helpers are pure and imported directly — no DB / no network is touched.
//
// Runner: npx tsx --test test/wiki.client.unit.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";
import { buildProposalFirstSeen, extractBacklog } from "../src/server/routes/wiki.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIKI_SRC = resolve(__dirname, "../public/src/screens/wiki.jsx");

interface FetchState {
  status: string;
  data: unknown;
  error: string | null;
}
interface Tile {
  key: string;
  label: string;
  state: string;
  value: string;
  sub: string;
  tone: string;
}
interface Alarm {
  key: string;
  tone: string;
  label: string;
  detail: string;
  parked?: boolean;
}
interface LaneModel {
  alarms: Alarm[];
  pending: boolean;
  unchecked: string[];
}
interface WikiHelpers {
  buildIndexTileW: (state: FetchState) => Tile;
  buildAlarmLaneModel: (
    summaryState: FetchState,
    indexState: FetchState,
    backlogState: FetchState,
    cyclesState: FetchState,
  ) => LaneModel;
  buildThroughputModel: (cyclesState: FetchState) => { isMixUniform: boolean; rows: unknown[] };
  buildTileBandModel: (summaryState: FetchState, indexState: FetchState, backlogState: FetchState) => Tile[];
  readTileBandFailuresW: (summaryState: FetchState, indexState: FetchState) => Array<{ feeder: string; label: string }>;
  describeNotesByTypeW: (state: FetchState) => string;
  describeRunHistoryW: (cyclesState: FetchState, model: unknown, summaryState: FetchState) => string;
  window: { UI: Record<string, unknown> };
}

const helpers = await buildScreenSandbox<WikiHelpers>(WIKI_SRC);
// The shared sandbox UI stub carries no formatRelativeTime — the dirty tile's "since" line reads it.
helpers.window.UI.formatRelativeTime = (iso: string) => `at ${iso}`;

// Sandbox values carry the vm realm's Array prototype → spread before a strict deep compare.
const ready = (data: unknown): FetchState => ({ status: "ready", data, error: null });
const loading: FetchState = { status: "loading", data: null, error: null };
const errored: FetchState = { status: "error", data: null, error: "boom" };

// UTC day offsets — the helpers age against today, so fixtures must be relative.
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function proposalBacklog(hashes: string[], firstSeen?: Record<string, string>): FetchState {
  return ready({
    backlog: {
      run_date: isoDaysAgo(0),
      ...dedup(hashes),
      proposal_first_seen: firstSeen,
    },
  });
}

// An unchanged dedup count across N newest cycles is the fallback age source.
function unchangedCycles(runs: number): FetchState {
  return ready({
    cycles: Array.from({ length: runs }, (_, i) => ({
      run_date: isoDaysAgo(i),
      dedup_count: 1,
    })),
  });
}

// The index tile: row presence and index cleanliness are different facts.

test("a missing dirty-flag row never renders as a clean index, whatever the timestamp says", () => {
  // last_dirty_ms is present, so only has_dirty_flag can tell the two apart.
  const tile = helpers.buildIndexTileW(
    ready({ has_dirty_flag: false, dirty: false, last_dirty_ms: 1_781_136_000_000 }),
  );
  assert.equal(tile.state, "unavailable");
  assert.notEqual(tile.value, "Clean");
});

test("a reported clean index stays clean and a reported dirty index tints", () => {
  const clean = helpers.buildIndexTileW(
    ready({ has_dirty_flag: true, dirty: false, last_dirty_ms: 1_781_136_000_000 }),
  );
  assert.equal(clean.state, "ready");
  assert.equal(clean.value, "Clean");
  assert.equal(clean.tone, "neutral");

  const dirty = helpers.buildIndexTileW(
    ready({ has_dirty_flag: true, dirty: true, last_dirty_ms: 1_781_136_000_000 }),
  );
  assert.equal(dirty.state, "ready");
  assert.equal(dirty.tone, "warn");
});

test("a payload predating the presence flag still separates absence from clean", () => {
  const absent = helpers.buildIndexTileW(ready({ dirty: false, last_dirty_ms: null }));
  assert.equal(absent.state, "unavailable");

  const clean = helpers.buildIndexTileW(ready({ dirty: false, last_dirty_ms: 1_781_136_000_000 }));
  assert.equal(clean.value, "Clean");
});

test("loading, error and unreported each read as themselves, never as a value", () => {
  const states = [
    helpers.buildIndexTileW(loading),
    helpers.buildIndexTileW(errored),
    helpers.buildIndexTileW(ready({ has_dirty_flag: false, dirty: false, last_dirty_ms: null })),
  ];
  const subs = states.map((t) => `${t.value} ${t.sub ?? ""}`);
  assert.equal(new Set(subs).size, subs.length, `states must read distinctly: ${subs.join(" / ")}`);
  for (const tile of states) {
    assert.equal(/\d/.test(tile.value), false, `placeholder must carry no figure: ${tile.value}`);
    assert.equal(tile.tone, "neutral");
  }
});

// State contract: loading and failure never share a token, and a failed payload is announced once at its group.

test("notes by type reads loading, failure and a count as three different tokens", () => {
  const tokens = [
    helpers.describeNotesByTypeW(loading),
    helpers.describeNotesByTypeW(errored),
    helpers.describeNotesByTypeW(ready({ by_type: [{ note_type: "concept", count: 3 }] })),
  ];
  assert.equal(new Set(tokens).size, 3, `tokens must differ: ${tokens.join(" / ")}`);
  assert.equal(tokens[2], "1 types");
});

test("a failed band feeder is named once for the group, never per tile", () => {
  const tiles = [...helpers.buildTileBandModel(errored, errored, ready({ backlog: null }))];
  for (const tile of tiles) {
    assert.equal(tile.state, "error");
    assert.doesNotMatch(tile.sub || "", /Couldn't load/, `tile ${tile.key} repeats the banner`);
  }
  assert.deepEqual(Array.from(helpers.readTileBandFailuresW(errored, errored), (f) => f.label), ["daily cycle summary", "search index"]);
  assert.deepEqual(Array.from(helpers.readTileBandFailuresW(errored, ready({})), (f) => f.label), ["daily cycle summary"]);
  assert.deepEqual(Array.from(helpers.readTileBandFailuresW(loading, ready({})), (f) => f.label), []);
});

// The alarm lane: a check that could not run is never silence.

test("every feeder that errored is named unchecked, and none is named when all answer", () => {
  const feeders: [number, string][] = [
    [0, "daily cycle"],
    [1, "search index"],
    [2, "merge proposals"],
  ];
  const answered: FetchState[] = [ready({}), ready({}), ready({ backlog: null })];

  for (const [position, label] of feeders) {
    const states = [...answered];
    states[position] = errored;
    const model = helpers.buildAlarmLaneModel(
      states[0] as FetchState,
      states[1] as FetchState,
      states[2] as FetchState,
      ready({ cycles: [] }),
    );
    assert.deepEqual([...model.unchecked], [label]);
  }

  const allAnswered = helpers.buildAlarmLaneModel(
    answered[0] as FetchState,
    answered[1] as FetchState,
    answered[2] as FetchState,
    ready({ cycles: [] }),
  );
  assert.deepEqual([...allAnswered.unchecked], []);
  assert.equal(allAnswered.pending, false);
  assert.deepEqual([...allAnswered.alarms], []);
});

test("a feeder still loading marks the lane pending rather than clear", () => {
  const model = helpers.buildAlarmLaneModel(loading, ready({}), ready({ backlog: null }), ready({ cycles: [] }));
  assert.equal(model.pending, true);
});

// Proposal age: dates when the server reports them, the run streak when it does not.

test("a first-seen date drives the waiting age and the parked threshold", () => {
  const fresh = helpers.buildAlarmLaneModel(
    ready({}),
    ready({}),
    proposalBacklog(["h1"], { h1: isoDaysAgo(2) }),
    unchangedCycles(30),
  ).alarms[0] as Alarm;
  assert.equal(fresh.parked, false);
  assert.match(fresh.detail, /Waiting 2 days \(since \d{4}-\d{2}-\d{2}\)/);
});

test("each waiting proposal gets its own lane row and age, parked rows last", () => {
  // Server order puts the long-parked pair first; the lane must not let its age speak for the others.
  const alarms = helpers.buildAlarmLaneModel(
    ready({}),
    ready({}),
    proposalBacklog(["old", "new", "mid"], {
      old: isoDaysAgo(77),
      new: isoDaysAgo(1),
      mid: isoDaysAgo(3),
    }),
    unchangedCycles(30),
  ).alarms.map((a) => ({ ...a })) as Alarm[];
  const lane = [...alarms];

  assert.equal(alarms.length, 3, "one row per proposal");
  assert.equal(new Set(alarms.map((a) => a.key)).size, 3, "row keys must be unique");
  assert.deepEqual(
    lane.map((a) => a.detail.match(/Waiting (\d+) day/)?.[1]),
    ["1", "3", "77"],
  );
  assert.deepEqual(lane.map((a) => a.parked), [false, false, true]);
});

test("a parked proposal drops to the neutral tone while a waiting one stays a warning", () => {
  const alarms = helpers.buildAlarmLaneModel(
    ready({}),
    ready({}),
    proposalBacklog(["old", "new"], { old: isoDaysAgo(77), new: isoDaysAgo(1) }),
    unchangedCycles(30),
  ).alarms as Alarm[];

  for (const alarm of alarms) {
    assert.equal(alarm.tone, alarm.parked ? "neutral" : "warn", alarm.label);
  }
  assert.deepEqual([...alarms].map((a) => a.parked).sort(), [false, true], "both states are exercised");
});

test("without a first-seen map the age falls back to the unchanged-run count", () => {
  const alarm = helpers.buildAlarmLaneModel(
    ready({}),
    ready({}),
    proposalBacklog(["h1"]),
    unchangedCycles(9),
  ).alarms[0] as Alarm;
  assert.equal(alarm.parked, true);
  assert.match(alarm.detail, /Unchanged for 9 runs/);
});

test("a loading run history reads as unknown-yet, never as absent history", () => {
  const checking = helpers.buildAlarmLaneModel(
    ready({}),
    ready({}),
    proposalBacklog(["h1"]),
    loading,
  ).alarms[0] as Alarm;
  const settled = helpers.buildAlarmLaneModel(
    ready({}),
    ready({}),
    proposalBacklog(["h1"]),
    ready({ cycles: [] }),
  ).alarms[0] as Alarm;
  assert.match(checking.detail, /Checking run history/);
  assert.match(settled.detail, /unknown/);
});

// Near-uniform = one status above 95% of runs → the mix bar carries no information and is dropped.
test("the status mix is uniform exactly when one status exceeds 95% of runs", () => {
  const cycles = (counts: Record<string, number>) =>
    ready({
      cycles: Object.entries(counts).flatMap(([status, n]) =>
        Array.from({ length: n }, (_, i) => ({
          run_date: isoDaysAgo(i),
          status,
          compiled_count: 1,
        })),
      ),
    });
  const cases: Array<[Record<string, number>, boolean]> = [
    [{ ok: 30 }, true],
    [{ error: 30 }, true],
    [{ ok: 24, error: 1 }, true],
    [{ ok: 19, partial: 1 }, false],
    [{ ok: 10, quota_exceeded: 10 }, false],
  ];
  for (const [counts, expected] of cases) {
    assert.equal(
      helpers.buildThroughputModel(cycles(counts)).isMixUniform,
      expected,
      JSON.stringify(counts),
    );
  }
});

// Server helpers for the two additive fields.

test("first-seen keeps the earliest run_date carrying each still-waiting proposal", () => {
  const rows = [
    { run_date: new Date("2026-06-11T00:00:00Z"), payload: dedup(["h1", "h2"]) },
    { run_date: new Date("2026-06-10T00:00:00Z"), payload: dedup(["h1"]) },
    { run_date: new Date("2026-06-03T00:00:00Z"), payload: dedup(["h1", "h3"]) },
  ];
  assert.deepEqual(buildProposalFirstSeen(rows), { h1: "2026-06-03", h2: "2026-06-11" });
});

test("a hash absent from the newest cycle is no longer waiting and carries no date", () => {
  const rows = [
    { run_date: new Date("2026-06-11T00:00:00Z"), payload: dedup([]) },
    { run_date: new Date("2026-06-10T00:00:00Z"), payload: dedup(["h1"]) },
  ];
  assert.deepEqual(buildProposalFirstSeen(rows), {});
});

test("an unreadable payload shape yields no dates instead of throwing", () => {
  assert.deepEqual(buildProposalFirstSeen([]), {});
  for (const payload of [null, [], { dedup_proposals: [] }, { dedup_proposals: { proposals: [{}] } }]) {
    assert.deepEqual(
      buildProposalFirstSeen([{ run_date: new Date("2026-06-11T00:00:00Z"), payload }]),
      {},
    );
  }
});

test("a backlog built without a first-seen map carries an empty map, never undefined", () => {
  const backlog = extractBacklog(new Date("2026-06-11T00:00:00Z"), dedup(["h1"]));
  assert.deepEqual(backlog.proposal_first_seen, {});
});

function dedup(hashes: string[]) {
  return { dedup_proposals: { proposals: hashes.map((h) => ({ cluster_hash: h })) } };
}

// The cycle p95 is demoted to the run-history summary line, not dropped.

test("the run-history summary carries the cycle p95 exactly when the server reports one", () => {
  const originalFormat = helpers.window.UI.formatDuration;
  helpers.window.UI.formatDuration = (v: number, unit: string) => `${v}${unit}`;
  const cycles = unchangedCycles(3);
  const model = helpers.buildThroughputModel(cycles);
  assert.ok(model.rows.length > 0, "fixture must yield run rows");

  const reported = helpers.describeRunHistoryW(cycles, model, ready({ cycle_p95_ms: 4200 }));
  assert.match(reported, /p95 4200ms/);

  for (const summary of [ready({ cycle_p95_ms: null }), loading, errored]) {
    assert.doesNotMatch(helpers.describeRunHistoryW(cycles, model, summary), /p95/);
  }
  helpers.window.UI.formatDuration = originalFormat;
});

// Broken links ride the library tile's caption, not a line of their own.
test("the library tile's caption carries the broken-link count, and says so when the backlog omits it", () => {
  const index = ready({ notes_total: 40 });
  const rows = [
    { name: "none found", deadlinks: [], expected: /0 broken links/ },
    { name: "one found", deadlinks: [{ from: "a", to: "b" }], expected: /1 broken link\b/ },
    { name: "not reported", deadlinks: undefined, expected: /broken links not reported/ },
  ];
  for (const row of rows) {
    const backlog = ready({ backlog: { run_date: isoDaysAgo(0), true_backlog: 0, deadlink_dryrun: row.deadlinks } });
    const library = helpers.buildTileBandModel(ready({}), index, backlog).find((tile) => tile.key === "library");
    assert.match(library?.sub ?? "", row.expected, `${row.name}: ${library?.sub}`);
  }
});

test("an index with no dirty flag on record says so in plain words and keeps the mechanism in its tooltip", () => {
  const tile = helpers.buildIndexTileW(ready({ has_dirty_flag: false, dirty: false, last_dirty_ms: null })) as { state: string; value: string; sub?: string; hint?: string };
  assert.equal(tile.state, "unavailable");
  assert.notEqual(tile.value, "—");
  assert.match(tile.sub ?? "", /freshness not reported/i);
  assert.doesNotMatch(tile.sub ?? "", /dirty flag/i, "the jargon stays out of the visible line");
  assert.match(tile.hint ?? "", /dirty flag/i);
});

// Run table grouping, note-type bars and the merge-proposal list's order.

interface RunGroup {
  key: string;
  count: number;
  newest: { run_date: string };
  oldest: { run_date: string };
}
const layoutHelpers = helpers as unknown as {
  groupConstantRunsW: (reports: unknown[]) => RunGroup[];
  buildNoteTypeRowsW: (rows: unknown[]) => Array<{ type: string; count: number; share: number }>;
  buildMaintenanceModel: (backlogState: FetchState, cyclesState?: FetchState) => { proposals: Array<{ cluster_hash: string }> };
};

function runs(statuses: Array<[string, number, number]>): unknown[] {
  return statuses.map(([status, deadlinks_count, dedup_count], i) => ({
    run_date: isoDaysAgo(i),
    status,
    deadlinks_count,
    dedup_count,
  }));
}

describe("consecutive runs sharing status and backlog collapse into one dated range", () => {
  const same = Array.from({ length: 27 }, () => ["ok", 0, 3] as [string, number, number]);
  const rows = [
    { name: "27 identical runs read as one row of 27", reports: runs(same), counts: [27] },
    { name: "a status change splits the streak around it", reports: runs([["ok", 0, 3], ["ok", 0, 3], ["error", 0, 3], ["ok", 0, 3]]), counts: [2, 1, 1] },
    { name: "a backlog change splits the streak", reports: runs([["ok", 0, 3], ["ok", 1, 3], ["ok", 1, 3]]), counts: [1, 2] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const groups = layoutHelpers.groupConstantRunsW(row.reports);
      assert.deepEqual([...groups].map((g) => g.count), row.counts);
      assert.equal(groups[0].newest.run_date, isoDaysAgo(0), "newest first");
      const last = groups[groups.length - 1];
      assert.equal(last.oldest.run_date, isoDaysAgo(row.reports.length - 1), "the oldest run closes the last range");
    });
  }
});

test("each note type's bar is its count's share of the largest type, and an all-zero index draws none", () => {
  const rows = layoutHelpers.buildNoteTypeRowsW([
    { note_type: "concept", count: 40 },
    { note_type: "source", count: 10 },
    { note_type: "empty", count: 0 },
  ]);
  assert.deepEqual(rows.map((r) => r.share), [100, 25, 0]);
  assert.deepEqual(
    layoutHelpers.buildNoteTypeRowsW([{ note_type: "a", count: 0 }]).map((r) => r.share),
    [0],
  );
});

test("the merge-proposal list follows the alarm lane's order", () => {
  const backlog = proposalBacklog(["old", "new", "mid"], {
    old: isoDaysAgo(77),
    new: isoDaysAgo(1),
    mid: isoDaysAgo(3),
  });
  const lane = helpers.buildAlarmLaneModel(ready({}), ready({}), backlog, unchangedCycles(30)).alarms;
  const list = layoutHelpers.buildMaintenanceModel(backlog, unchangedCycles(30)).proposals;
  assert.deepEqual(
    [...list].map((p) => `proposal-${p.cluster_hash}`),
    [...lane].map((a) => a.key),
  );
});

// Page verdict, tile causes and note-type labels.

interface Verdict {
  tone: string;
  text: string;
  chips: Array<{ label: string; targetId?: string }>;
}
interface GlanceTile {
  key: string;
  value: string;
  sub?: string | null;
  tone: string;
}
const glanceHelpers = helpers as unknown as {
  buildWikiVerdictW: (summary: FetchState, index: FetchState, backlog: FetchState, cycles: FetchState) => Verdict;
  buildCompiledTileW: (summary: FetchState, backlog?: FetchState, cycles?: FetchState) => GlanceTile;
  buildLastRunTileW: (summary: FetchState, at?: string | null) => GlanceTile;
  buildNoteTypeRowsW: (rows: unknown[]) => Array<{ type: string; label: string; pct: number }>;
};

function healthySummary(extra: Record<string, unknown> = {}): FetchState {
  return ready({
    last_cycle_started_at: new Date().toISOString(),
    hours_since_last_cycle: 3,
    last_status: "ok",
    last_run_date: isoDaysAgo(0),
    latest_compiled_count: 0,
    ...extra,
  });
}

describe("the page verdict takes the worst actionable tone and parked proposals never raise it", () => {
  const clean = ready({ has_dirty_flag: true, dirty: false, last_dirty_ms: 1 });
  const noBacklog = ready({ backlog: null });
  const rows = [
    { name: "a healthy run with nothing waiting reads ok", summary: healthySummary(), index: clean, backlog: noBacklog, tone: "ok" },
    { name: "a missed daily cycle reads crit", summary: healthySummary({ hours_since_last_cycle: 40 }), index: clean, backlog: noBacklog, tone: "crit" },
    { name: "a dirty index reads warn", summary: healthySummary(), index: ready({ has_dirty_flag: true, dirty: true, last_dirty_ms: 1 }), backlog: noBacklog, tone: "warn" },
    { name: "a failed last run reads crit", summary: healthySummary({ last_status: "fail" }), index: clean, backlog: noBacklog, tone: "crit" },
    { name: "only parked proposals keep ok", summary: healthySummary(), index: clean, backlog: proposalBacklog(["a", "b"], { a: isoDaysAgo(79), b: isoDaysAgo(67) }), tone: "ok" },
    { name: "a proposal still inside its waiting window reads warn", summary: healthySummary(), index: clean, backlog: proposalBacklog(["a"], { a: isoDaysAgo(1) }), tone: "warn" },
    { name: "an unloaded summary reads no signal", summary: loading, index: clean, backlog: noBacklog, tone: "neutral" },
    { name: "an errored index withholds the all-clear", summary: healthySummary(), index: errored, backlog: noBacklog, tone: "neutral" },
    { name: "an errored backlog withholds the all-clear", summary: healthySummary(), index: clean, backlog: errored, tone: "neutral" },
    { name: "an index still loading withholds the all-clear", summary: healthySummary(), index: loading, backlog: noBacklog, tone: "neutral" },
    { name: "a backlog still loading withholds the all-clear", summary: healthySummary(), index: clean, backlog: loading, tone: "neutral" },
    { name: "an errored feeder never softens a missed cycle already known", summary: healthySummary({ hours_since_last_cycle: 40 }), index: errored, backlog: noBacklog, tone: "crit" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.equal(glanceHelpers.buildWikiVerdictW(row.summary, row.index, row.backlog, unchangedCycles(30)).tone, row.tone);
    });
  }
});

test("the verdict sentence names each feeder it could not check", () => {
  const verdict = glanceHelpers.buildWikiVerdictW(healthySummary(), errored, errored, unchangedCycles(30));
  assert.match(verdict.text, /couldn't check search index, merge proposals$/);
});

test("parked proposals fold into the verdict sentence with their count, oldest age and one chip to the list", () => {
  const verdict = glanceHelpers.buildWikiVerdictW(
    healthySummary(),
    ready({}),
    proposalBacklog(["a", "b", "c"], { a: isoDaysAgo(79), b: isoDaysAgo(70), c: isoDaysAgo(67) }),
    unchangedCycles(30),
  );
  assert.match(verdict.text, /3 merges parked, oldest 79 d/);
  assert.match(verdict.text, /0 compiled/);
  assert.equal(verdict.chips.length, 1);
  assert.equal(typeof verdict.chips[0].targetId, "string");
});

test("with no proposals the verdict sentence names no merge and offers no chip", () => {
  const none = glanceHelpers.buildWikiVerdictW(healthySummary(), ready({}), ready({ backlog: null }), unchangedCycles(30));
  assert.doesNotMatch(none.text, /merge/);
  assert.deepEqual([...none.chips], []);
});

describe("the compiled tile names why it reads zero, adds the window total and tints only when originals wait", () => {
  const cycles = ready({ cycles: [4, 0, 8].map((compiled_count, i) => ({ run_date: isoDaysAgo(i), compiled_count })) });
  const backlog = (waiting: number) => ready({ backlog: { run_date: isoDaysAgo(0), true_backlog: waiting } });
  const rows = [
    { name: "idle — nothing waiting stays quiet", compiled: 0, waiting: 0, sub: /nothing to compile.* · 12 in 3 d$/i, tone: "neutral" },
    { name: "stalled — originals waiting with none compiled tints", compiled: 0, waiting: 5, sub: /5 originals waiting.* · 12 in 3 d$/, tone: "warn" },
    { name: "producing — a compiled cycle shows the window total only", compiled: 4, waiting: 5, sub: /^12 in 3 d$/, tone: "neutral" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tile = glanceHelpers.buildCompiledTileW(healthySummary({ latest_compiled_count: row.compiled }), backlog(row.waiting), cycles);
      assert.match(tile.sub ?? "", row.sub);
      assert.equal(tile.tone, row.tone);
    });
  }
});

test("the last-run tile names the outcome instead of repeating the cycle date", () => {
  const tile = glanceHelpers.buildLastRunTileW(healthySummary({ cycle_p95_ms: 1000 }));
  assert.match(tile.sub ?? "", /^Healthy/);
  assert.doesNotMatch(tile.sub ?? "", /Cycle/);
});

describe("the last-run tile keeps the shared freshness rule over a failed refresh", () => {
  const at = new Date().toISOString();
  const warm = (summary: FetchState): FetchState => ({ ...summary, error: "HTTP 500" });
  const rows = [
    { name: "a settled healthy run names its outcome", summary: healthySummary({ cycle_p95_ms: 1000 }), sub: /^Healthy · p95/, tone: "neutral" },
    { name: "a healthy run held under a failed read reads Last known, never Healthy", summary: warm(healthySummary({ cycle_p95_ms: 1000 })), sub: /^Last known · p95/, tone: "neutral" },
    { name: "a failed run held under a failed read keeps its alarm", summary: warm(healthySummary({ last_status: "fail" })), sub: /^Last known: Failed$/, tone: "crit" },
    { name: "a settled missed cycle reads Overdue", summary: healthySummary({ hours_since_last_cycle: 40 }), sub: /^Overdue · cycle /, tone: "crit" },
    { name: "a missed cycle held under a failed read reads Last known: Overdue and keeps crit", summary: warm(healthySummary({ hours_since_last_cycle: 40 })), sub: /^Last known: Overdue · cycle /, tone: "crit" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tile = glanceHelpers.buildLastRunTileW(row.summary, at);
      assert.match(tile.sub ?? "", row.sub);
      assert.equal(tile.tone, row.tone);
    });
  }
});

test("note types read as human labels with their share of all notes", () => {
  const rows = glanceHelpers.buildNoteTypeRowsW([
    { note_type: "source-summary", count: 480 },
    { note_type: "raw", count: 471 },
    { note_type: "source", count: 1 },
  ]);
  assert.deepEqual(rows.map((r) => r.label), ["Summary notes", "Saved originals", "Other · source"]);
  assert.deepEqual(rows.map((r) => r.pct), [50, 49, 0]);
});

test("the per-run fold's summary states the run streak, so a one-row table needs no click", () => {
  const h = helpers as unknown as { describeRunTableW: (state: FetchState, days: number) => string };
  const same = Array.from({ length: 27 }, () => ["ok", 0, 3] as [string, number, number]);
  assert.equal(h.describeRunTableW(ready({ reports: runs(same) }), 30), `27 healthy runs in a row since ${isoDaysAgo(26)}`);
  assert.equal(h.describeRunTableW(ready({ reports: runs([["ok", 0, 3], ["error", 0, 3], ["ok", 0, 3]]) }), 30), "3 runs in 3 streaks");
});

describe("the run trend fills every calendar day between its first and last run", () => {
  const h = helpers as unknown as {
    buildThroughputModel: (state: FetchState) => { compiledDates: string[]; compiledSeries: number[]; spanDays: number; total: number; rows: unknown[] };
  };
  const rows = [
    { name: "a skipped day becomes a zero bar", cycles: [["2026-09-01", 2], ["2026-09-04", 3], ["2026-09-02", 1]], dates: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"], series: [2, 1, 0, 3] },
    { name: "a month boundary keeps counting days", cycles: [["2026-09-29", 1], ["2026-10-01", 1]], dates: ["2026-09-29", "2026-09-30", "2026-10-01"], series: [1, 0, 1] },
    { name: "a single run is one day", cycles: [["2026-09-10", 5]], dates: ["2026-09-10"], series: [5] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const cycles = row.cycles.map(([run_date, compiled_count]) => ({ run_date, compiled_count, status: "ok" }));
      const model = h.buildThroughputModel(ready({ cycles }));
      assert.deepEqual([...model.compiledDates], row.dates);
      assert.deepEqual([...model.compiledSeries], row.series);
      assert.equal(model.spanDays, row.dates.length);
      assert.equal(model.rows.length, row.cycles.length, "runs stay counted as runs");
    });
  }
});

test("the trend's tick cap is the largest one up to seven that splits its days into equal steps", () => {
  const h = helpers as unknown as { getEvenTickCapW: (count: number) => number };
  for (let count = 1; count <= 60; count++) {
    const cap = h.getEvenTickCapW(count);
    assert.ok(cap >= 2 && cap <= 7, `count ${count}`);
    if (count > 1) assert.equal((count - 1) % (cap - 1), 0, `count ${count}: cap ${cap} leaves an uneven step`);
    for (let bigger = cap + 1; bigger <= Math.min(7, count); bigger++) {
      assert.notEqual((count - 1) % (bigger - 1), 0, `count ${count}: cap ${bigger} was also even`);
    }
  }
});

test("the compiled tile and Run history name the same span for the same total", () => {
  const h = helpers as unknown as {
    buildThroughputModel: (state: FetchState) => unknown;
    describeRunHistoryW: (cycles: FetchState, model: unknown, summary: FetchState) => string;
  };
  const cycles = ready({ cycles: [["2026-09-01", 20], ["2026-09-18", 0], ["2026-09-29", 2]].map(([run_date, compiled_count]) => ({ run_date, compiled_count, status: "ok" })) });
  const tile = glanceHelpers.buildCompiledTileW(healthySummary({ latest_compiled_count: 2 }), ready({ backlog: null }), cycles);
  const history = h.describeRunHistoryW(cycles, h.buildThroughputModel(cycles), ready({}));
  assert.match(tile.sub ?? "", /\b22 in 29 d\b/);
  assert.match(history, /^3 runs in 29 d\b/, "runs are counted as runs over the same span");
});
