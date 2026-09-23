// Unit tests for the wiki screen's lane / band / state helpers in
// public/src/screens/wiki.jsx, plus the two additive read-path helpers the screen
// consumes from routes/wiki.ts. Both halves pin one contract: a fact the server did
// not report must never render as a measured value.
//
// Sandbox harness (esbuild + node:vm over the real shipped wiki.jsx): client-sandbox.ts.
// The route helpers are pure and imported directly — no DB / no network is touched.
//
// Runner: npx tsx --test test/wiki.client.unit.test.ts

import test from "node:test";
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
  const subs = states.map((t) => t.sub);
  assert.equal(new Set(subs).size, subs.length, `states must read distinctly: ${subs.join(" / ")}`);
  for (const tile of states) {
    assert.equal(/\d/.test(tile.value), false, `placeholder must carry no figure: ${tile.value}`);
    assert.equal(tile.tone, "neutral");
  }
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

  // The 30-run streak would park this pair if the run fallback were still in charge.
  const parked = helpers.buildAlarmLaneModel(
    ready({}),
    ready({}),
    proposalBacklog(["h1", "h2"], { h1: isoDaysAgo(20), h2: isoDaysAgo(1) }),
    unchangedCycles(30),
  ).alarms[0] as Alarm;
  assert.equal(parked.parked, true);
  // The oldest waiting pair sets the age, not the newest.
  assert.match(parked.detail, /Waiting 20 days/);
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
