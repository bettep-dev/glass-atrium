// Shared per-region fetch state: prior data survives a reload, failure never discards data,
// superseded responses never land. Pinned as pure transitions against the three fetch shapes screens use.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadScreenModule } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type RegionState<T> = {
  status: "loading" | "ready" | "error";
  data: T | null;
  error: string | null;
  busy: boolean;
  key: unknown;
  pendingKey: unknown;
};
type Merge<T> = (prev: T | null, next: T) => T;

const ui = (await loadScreenModule(UI_SRC)).UI as Record<string, unknown>;
const INITIAL = ui.INITIAL_REGION_STATE as RegionState<never>;
const putRegionRequest = ui.putRegionRequest as <T>(s: RegionState<T>, key: unknown) => RegionState<T>;
const putRegionData = ui.putRegionData as <T>(s: RegionState<T>, key: unknown, data: T, merge?: Merge<T>) => RegionState<T>;
const putRegionFailure = ui.putRegionFailure as <T>(s: RegionState<T>, key: unknown, err: unknown) => RegionState<T>;

const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

function settle<T>(key: unknown, data: T): RegionState<T> {
  return putRegionData(putRegionRequest(INITIAL as RegionState<T>, key), key, data);
}

test("the first request of a region reads as loading with nothing to show", () => {
  const state = putRegionRequest(INITIAL, 1);

  assert.deepEqual(
    { status: state.status, data: state.data, busy: state.busy },
    { status: "loading", data: null, busy: true },
  );
});

test("a reload keeps the prior data on screen and busy, then swaps only on settle", () => {
  const reloading = putRegionRequest(settle(1, { n: 1 }), 2);
  const settled = putRegionData(reloading, 2, { n: 2 });

  assert.deepEqual({ status: reloading.status, data: reloading.data, busy: reloading.busy }, { status: "ready", data: { n: 1 }, busy: true });
  assert.deepEqual({ status: settled.status, data: settled.data, busy: settled.busy, key: settled.key }, { status: "ready", data: { n: 2 }, busy: false, key: 2 });
});

test("a response or failure for a superseded request leaves the state untouched", () => {
  const rows = [
    { name: "late data", apply: (s: RegionState<{ n: number }>) => putRegionData(s, 1, { n: 99 }) },
    { name: "late failure", apply: (s: RegionState<{ n: number }>) => putRegionFailure(s, 1, new Error("HTTP 500")) },
  ];
  const current = putRegionRequest(settle(1, { n: 1 }), 2);

  for (const row of rows) {
    assert.equal(row.apply(current), current, row.name);
  }
});

test("a failure records the error and keeps held data; with no data the region reads as failed", () => {
  const withData = putRegionFailure(putRegionRequest(settle(1, { n: 1 }), 2), 2, new Error("HTTP 503"));
  const withoutData = putRegionFailure(putRegionRequest(INITIAL, 1), 1, new Error("HTTP 503"));

  assert.deepEqual(
    { status: withData.status, data: withData.data, error: withData.error, busy: withData.busy },
    { status: "ready", data: { n: 1 }, error: "HTTP 503", busy: false },
  );
  assert.deepEqual(
    { status: withoutData.status, data: withoutData.data, error: withoutData.error, busy: withoutData.busy },
    { status: "error", data: null, error: "HTTP 503", busy: false },
  );
});

test("a later success clears the recorded failure", () => {
  const failed = putRegionFailure(putRegionRequest(settle(1, { n: 1 }), 2), 2, new Error("HTTP 503"));
  const recovered = putRegionData(putRegionRequest(failed, 3), 3, { n: 3 });

  assert.deepEqual({ error: recovered.error, data: recovered.data }, { error: null, data: { n: 3 } });
});

test("an aborted current request stops the busy state without recording a failure", () => {
  const aborted = putRegionFailure(putRegionRequest(settle(1, { n: 1 }), 2), 2, abortError());

  assert.deepEqual(
    { status: aborted.status, data: aborted.data, error: aborted.error, busy: aborted.busy },
    { status: "ready", data: { n: 1 }, error: null, busy: false },
  );
});

test("allSettled fan-out: each region swaps or fails on its own and no region blanks mid-wave", () => {
  type Regions = Record<"cost" | "agents" | "outcomes", RegionState<{ v: string }>>;
  const names = ["cost", "agents", "outcomes"] as const;
  let regions = Object.fromEntries(names.map((n) => [n, settle(1, { v: `${n}-1` })])) as Regions;

  regions = Object.fromEntries(names.map((n) => [n, putRegionRequest(regions[n], 2)])) as Regions;
  const midWaveData = names.map((n) => regions[n].data?.v);
  regions = {
    cost: putRegionData(regions.cost, 2, { v: "cost-2" }),
    agents: putRegionFailure(regions.agents, 2, new Error("HTTP 502")),
    outcomes: regions.outcomes,
  };

  assert.deepEqual(midWaveData, ["cost-1", "agents-1", "outcomes-1"]);
  assert.deepEqual(
    names.map((n) => [n, regions[n].data?.v, regions[n].busy, regions[n].error]),
    [
      ["cost", "cost-2", false, null],
      ["agents", "agents-1", false, "HTTP 502"],
      ["outcomes", "outcomes-1", true, null],
    ],
  );
});

test("paged + search list: search keeps prior rows while typing, drops out-of-order answers, load-more appends", () => {
  type Page = { rows: string[]; total: number };
  const appendRows: Merge<Page> = (prev, next) => ({ ...next, rows: [...(prev?.rows ?? []), ...next.rows] });
  let list = settle<Page>("q=|offset=0", { rows: ["a1", "b1"], total: 4 });

  list = putRegionRequest(list, "q=a|offset=0");
  list = putRegionRequest(list, "q=ab|offset=0");
  const whileSearching = list.data?.rows;
  list = putRegionData(list, "q=a|offset=0", { rows: ["a1"], total: 1 });
  const afterStaleAnswer = list.data?.rows;
  list = putRegionData(list, "q=ab|offset=0", { rows: ["ab1"], total: 2 });
  list = putRegionRequest(list, "q=ab|offset=1");
  list = putRegionData(list, "q=ab|offset=1", { rows: ["ab2"], total: 2 }, appendRows);

  assert.deepEqual(whileSearching, ["a1", "b1"]);
  assert.deepEqual(afterStaleAnswer, ["a1", "b1"]);
  assert.deepEqual(list.data, { rows: ["ab1", "ab2"], total: 2 });
});

test("dirty edit buffer: a refresh updates the server copy and keeps unsaved edits", () => {
  type Config = { limit: number };
  type Buffer = { server: Config; draft: Config };
  const isDirty = (b: Buffer) => b.draft.limit !== b.server.limit;
  const keepDirtyDraft: Merge<Buffer> = (prev, next) => (prev && isDirty(prev) ? { server: next.server, draft: prev.draft } : next);
  const loaded = settle<Buffer>(1, { server: { limit: 10 }, draft: { limit: 10 } });
  const rows = [
    { name: "dirty buffer keeps the draft", before: { ...loaded, data: { server: { limit: 10 }, draft: { limit: 25 } } }, draft: 25 },
    { name: "clean buffer takes the server value", before: loaded, draft: 40 },
  ];

  for (const row of rows) {
    const refreshed = putRegionData(putRegionRequest(row.before, 2), 2, { server: { limit: 40 }, draft: { limit: 40 } }, keepDirtyDraft);
    assert.deepEqual([refreshed.data?.server.limit, refreshed.data?.draft.limit], [40, row.draft], row.name);
  }
});
