// Shared per-region fetch state: prior data survives a reload, failure never discards data,
// superseded responses never land — matched by request identity, never by key. Pinned as pure transitions.
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
  pendingRequest: object | null;
};
type Merge<T> = (prev: T | null, next: T) => T;

const ui = (await loadScreenModule(UI_SRC)).UI as Record<string, unknown>;
const INITIAL = ui.INITIAL_REGION_STATE as RegionState<never>;
const putRegionRequest = ui.putRegionRequest as <T>(s: RegionState<T>, key: unknown, request: unknown) => RegionState<T>;
const putRegionData = ui.putRegionData as <T>(s: RegionState<T>, request: object, data: T, merge?: Merge<T>) => RegionState<T>;
const putRegionFailure = ui.putRegionFailure as <T>(s: RegionState<T>, request: object, err: unknown) => RegionState<T>;

const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

// one fresh identity per request, as an AbortController would be
const createRequest = (): object => ({});

function settle<T>(key: unknown, data: T): RegionState<T> {
  const request = createRequest();
  return putRegionData(putRegionRequest(INITIAL as RegionState<T>, key, request), request, data);
}

function request<T>(state: RegionState<T>, key: unknown): [RegionState<T>, object] {
  const token = createRequest();
  return [putRegionRequest(state, key, token), token];
}

test("the first request of a region reads as loading with nothing to show", () => {
  const [state] = request(INITIAL, 1);

  assert.deepEqual(
    { status: state.status, data: state.data, busy: state.busy },
    { status: "loading", data: null, busy: true },
  );
});

test("a reload keeps the prior data on screen and busy, then swaps only on settle", () => {
  const [reloading, token] = request(settle(1, { n: 1 }), 2);
  const settled = putRegionData(reloading, token, { n: 2 });

  assert.deepEqual({ status: reloading.status, data: reloading.data, busy: reloading.busy }, { status: "ready", data: { n: 1 }, busy: true });
  assert.deepEqual({ status: settled.status, data: settled.data, busy: settled.busy, key: settled.key }, { status: "ready", data: { n: 2 }, busy: false, key: 2 });
});

test("an answer for a superseded request leaves the state untouched, even when it shares the live key", () => {
  const rows = [
    { name: "late data, earlier key", key: 1, apply: (s: RegionState<{ n: number }>, t: object) => putRegionData(s, t, { n: 99 }) },
    { name: "late failure, earlier key", key: 1, apply: (s: RegionState<{ n: number }>, t: object) => putRegionFailure(s, t, new Error("HTTP 500")) },
    { name: "late data, same key", key: 2, apply: (s: RegionState<{ n: number }>, t: object) => putRegionData(s, t, { n: 99 }) },
    { name: "late failure, same key", key: 2, apply: (s: RegionState<{ n: number }>, t: object) => putRegionFailure(s, t, new Error("HTTP 500")) },
    { name: "late abort, same key", key: 2, apply: (s: RegionState<{ n: number }>, t: object) => putRegionFailure(s, t, abortError()) },
  ];

  for (const row of rows) {
    const [superseded, olderToken] = request(settle(1, { n: 1 }), row.key);
    const [current] = request(superseded, 2);
    assert.equal(row.apply(current, olderToken), current, row.name);
  }
});

test("a same-key re-request whose older twin aborts first still lands the live answer", () => {
  const [first, olderToken] = request(settle(1, { n: 1 }), 2);
  const [second, liveToken] = request(first, 2);
  const afterAbort = putRegionFailure(second, olderToken, abortError());
  const landed = putRegionData(afterAbort, liveToken, { n: 2 });

  assert.deepEqual({ data: landed.data, busy: landed.busy, key: landed.key }, { data: { n: 2 }, busy: false, key: 2 });
});

test("a request without an object identity is refused", () => {
  const rows = [
    { name: "missing request", request: undefined },
    { name: "numeric tick reused as identity", request: 2 },
    { name: "string key reused as identity", request: "q=a|offset=0" },
  ];

  for (const row of rows) {
    assert.throws(() => putRegionRequest(INITIAL, 2, row.request), { name: "TypeError" }, row.name);
  }
});

test("a failure records the error and keeps held data; with no data the region reads as failed", () => {
  const [reloading, reloadToken] = request(settle(1, { n: 1 }), 2);
  const [firstLoad, firstToken] = request(INITIAL, 1);
  const withData = putRegionFailure(reloading, reloadToken, new Error("HTTP 503"));
  const withoutData = putRegionFailure(firstLoad, firstToken, new Error("HTTP 503"));

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
  const [reloading, failedToken] = request(settle(1, { n: 1 }), 2);
  const [retrying, retryToken] = request(putRegionFailure(reloading, failedToken, new Error("HTTP 503")), 3);
  const recovered = putRegionData(retrying, retryToken, { n: 3 });

  assert.deepEqual({ error: recovered.error, data: recovered.data }, { error: null, data: { n: 3 } });
});

test("an aborted current request stops the busy state without recording a failure", () => {
  const [reloading, token] = request(settle(1, { n: 1 }), 2);
  const aborted = putRegionFailure(reloading, token, abortError());

  assert.deepEqual(
    { status: aborted.status, data: aborted.data, error: aborted.error, busy: aborted.busy },
    { status: "ready", data: { n: 1 }, error: null, busy: false },
  );
});

test("allSettled fan-out: each region swaps or fails on its own and no region blanks mid-wave", () => {
  type Regions = Record<"cost" | "agents" | "outcomes", RegionState<{ v: string }>>;
  const names = ["cost", "agents", "outcomes"] as const;
  const settled = Object.fromEntries(names.map((n) => [n, settle(1, { v: `${n}-1` })])) as Regions;
  const waves = Object.fromEntries(names.map((n) => [n, request(settled[n], 2)])) as Record<(typeof names)[number], [RegionState<{ v: string }>, object]>;

  const midWaveData = names.map((n) => waves[n][0].data?.v);
  const regions: Regions = {
    cost: putRegionData(waves.cost[0], waves.cost[1], { v: "cost-2" }),
    agents: putRegionFailure(waves.agents[0], waves.agents[1], new Error("HTTP 502")),
    outcomes: waves.outcomes[0],
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
  let staleToken: object;
  let liveToken: object;
  let moreToken: object;

  [list, staleToken] = request(list, "q=a|offset=0");
  [list, liveToken] = request(list, "q=ab|offset=0");
  const whileSearching = list.data?.rows;
  list = putRegionData(list, staleToken, { rows: ["a1"], total: 1 });
  const afterStaleAnswer = list.data?.rows;
  list = putRegionData(list, liveToken, { rows: ["ab1"], total: 2 });
  [list, moreToken] = request(list, "q=ab|offset=1");
  list = putRegionData(list, moreToken, { rows: ["ab2"], total: 2 }, appendRows);

  assert.deepEqual(whileSearching, ["a1", "b1"]);
  assert.deepEqual(afterStaleAnswer, ["a1", "b1"]);
  assert.deepEqual(list.data, { rows: ["ab1", "ab2"], total: 2 });
  assert.equal(list.key, "q=ab|offset=1");
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
    const [refreshing, token] = request(row.before, 2);
    const refreshed = putRegionData(refreshing, token, { server: { limit: 40 }, draft: { limit: 40 } }, keepDirtyDraft);
    assert.deepEqual([refreshed.data?.server.limit, refreshed.data?.draft.limit], [40, row.draft], row.name);
  }
});
