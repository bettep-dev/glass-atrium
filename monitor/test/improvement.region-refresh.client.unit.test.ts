// Refresh guards for loadRegionI in public/src/screens/improvement.jsx: a refresh keeps the
// held payload on screen, and an answer that was superseded or aborted never lands — nor
// feeds the as-of stamp. Driven through the real ui.jsx region transitions with a
// hand-settled fetch.
//
// Runner: npx tsx --test test/improvement.region-refresh.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPROVEMENT_SRC = resolve(__dirname, "../public/src/screens/improvement.jsx");

interface RegionState {
  status: string;
  data: unknown;
  error: string | null;
  busy: boolean;
}

type StateUpdate = (state: RegionState) => RegionState;

interface RefreshSandbox {
  window: { UI: { INITIAL_REGION_STATE: RegionState } };
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<unknown>;
  AbortController: typeof AbortController;
  loadRegionI: (url: string, setState: (update: StateUpdate) => void, onData?: () => void) => AbortController;
}

interface PendingFetch {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

const sandbox = await buildScreenSandbox<RefreshSandbox>(IMPROVEMENT_SRC);
sandbox.AbortController = AbortController;

// Each fetch stays open until the test settles it — the order of answers is the variable under test.
function getRegionHarness() {
  const pending: PendingFetch[] = [];
  let state = sandbox.window.UI.INITIAL_REGION_STATE;
  let stampCount = 0;
  sandbox.fetch = () =>
    new Promise((resolveFetch, rejectFetch) => {
      pending.push({
        resolve: (data) => resolveFetch({ ok: true, status: 200, json: async () => data }),
        reject: rejectFetch,
      });
    });
  // one stable setter, as useState hands out
  const setState = (update: StateUpdate) => {
    state = update(state);
  };
  const load = () =>
    sandbox.loadRegionI("/api/improvement", setState, () => {
      stampCount += 1;
    });
  return { pending, load, getState: () => state, getStampCount: () => stampCount };
}

const flush = () => new Promise((resolveFlush) => setImmediate(resolveFlush));

test("a refresh keeps the held payload on screen until its own answer settles", async () => {
  const region = getRegionHarness();
  region.load();
  region.pending[0]?.resolve({ rows: ["held"] });
  await flush();

  region.load();
  assert.deepEqual(region.getState().data, { rows: ["held"] }, "held data must survive the refresh request");
  assert.equal(region.getState().status, "ready", "a refreshing region with data is still readable");
  assert.equal(region.getState().busy, true);

  region.pending[1]?.reject(new Error("HTTP 503 Service Unavailable"));
  await flush();
  assert.deepEqual(region.getState().data, { rows: ["held"] }, "a failed refresh must not blank held data");
  assert.match(String(region.getState().error), /503/);
  assert.equal(region.getState().busy, false);
});

test("a superseded answer never lands, whatever order the answers arrive in", async () => {
  const region = getRegionHarness();
  region.load();
  region.load();

  region.pending[1]?.resolve({ rows: ["newer"] });
  await flush();
  region.pending[0]?.resolve({ rows: ["older"] });
  await flush();

  assert.deepEqual(region.getState().data, { rows: ["newer"] });
  assert.equal(region.getStampCount(), 1, "only the landed answer moves the as-of stamp");
});

test("an aborted request's late answer neither lands nor moves the stamp", async () => {
  const region = getRegionHarness();
  const request = region.load();
  request.abort();

  region.pending[0]?.resolve({ rows: ["late"] });
  await flush();

  assert.equal(region.getState().data, null);
  assert.equal(region.getStampCount(), 0);
});
