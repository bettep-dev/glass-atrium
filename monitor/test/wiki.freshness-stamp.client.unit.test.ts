// The Wiki fetch path settles each read into its shared region state: a failed refresh keeps the
// last good payload, a superseded request lands nothing, and only a successful read advances the stamp.
//
// Runner: npx tsx --test test/wiki.freshness-stamp.client.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIKI_SRC = resolve(__dirname, "../public/src/screens/wiki.jsx");

interface RegionState {
  status: string;
  data: unknown;
  error: string | null;
  busy: boolean;
}
type Update = (state: RegionState) => RegionState;
interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}
interface WikiSandbox {
  window: {
    UI: {
      INITIAL_REGION_STATE: RegionState;
      putRegionRequest: (state: RegionState, key: string, request: object) => RegionState;
    };
  };
  fetch: (url: string) => Promise<FetchResponse>;
  runFetchW: (url: string, request: AbortController, setState: (update: Update) => void) => Promise<boolean>;
}

const sandbox = await buildScreenSandbox<WikiSandbox>(WIKI_SRC);
const URL_SUMMARY = "/api/wiki/summary";
const HELD = { cycle_p95_ms: 4200 };

function respond(ok: boolean, payload: unknown): void {
  sandbox.fetch = async () => ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => payload,
    text: async () => String(payload),
  });
}

// A region already showing HELD, with a refresh for `request` in flight.
function startRefresh(request: AbortController): { read: () => RegionState; setState: (update: Update) => void } {
  const { INITIAL_REGION_STATE, putRegionRequest } = sandbox.window.UI;
  let state: RegionState = putRegionRequest({ ...INITIAL_REGION_STATE, status: "ready", data: HELD, busy: false }, URL_SUMMARY, request);
  return { read: () => state, setState: (update) => { state = update(state); } };
}

test("a failed refresh keeps the section's last good payload and records the failure beside it", async () => {
  const request = new AbortController();
  const region = startRefresh(request);
  respond(false, "<p>relation missing</p>");

  assert.equal(await sandbox.runFetchW(URL_SUMMARY, request, region.setState), false, "a failure never advances the stamp");
  assert.equal(region.read().data, HELD, "the held payload stays on screen");
  assert.equal(region.read().busy, false);
  assert.match(String(region.read().error), /^HTTP 500/);
});

test("a successful read replaces the payload only for the request in flight", async () => {
  const fresh = { cycle_p95_ms: 900 };
  respond(true, fresh);
  for (const isCurrent of [true, false]) {
    const request = new AbortController();
    const region = startRefresh(request);
    const sender = isCurrent ? request : new AbortController();

    assert.equal(await sandbox.runFetchW(URL_SUMMARY, sender, region.setState), true, "a read that answered counts as read");
    assert.equal(region.read().data, isCurrent ? fresh : HELD, `current=${isCurrent}`);
  }
});
