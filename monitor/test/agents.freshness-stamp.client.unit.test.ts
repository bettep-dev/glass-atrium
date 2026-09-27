// The Agents header stamp reports the summary's last successful read through the shared
// freshness atom: a refresh keeps the held payload and the last stamp, a failed read never advances it.
//
// Runner: npx tsx --test test/agents.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_SRC = resolve(__dirname, "../public/src/screens/agents.jsx");

interface FetchState {
  status: string;
  data: { fetched_at?: string } | null;
  busy?: boolean;
  key?: string | null;
}

interface StampSandbox {
  window: {
    UI: {
      INITIAL_REGION_STATE: FetchState;
      getFreshnessState: (input: { at: string | null; regions: FetchState[]; now: number }) => string;
      putRegionData: (state: FetchState, request: object, data: unknown) => FetchState;
      putRegionFailure: (state: FetchState, request: object, err: unknown) => FetchState;
    };
  };
  getLastReadAtAg: (prevAt: string | null, state: FetchState) => string | null;
  putRegionRequestAg: (state: FetchState, key: string, request: object) => FetchState;
}

const sandbox = await buildScreenSandbox<StampSandbox>(AGENTS_SRC);
const UI = sandbox.window.UI;

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const PREV_AT = new Date(NOW - 120_000).toISOString();
const READ_AT = new Date(NOW - 60_000).toISOString();

const ready: FetchState = { status: "ready", data: { fetched_at: READ_AT } };
const loading: FetchState = { status: "loading", data: null };
const failed: FetchState = { status: "error", data: null };

const KEY_30D = "/api/agents/summary?days=30";
const KEY_7D = "/api/agents/summary?days=7";

function getReadSummary(key: string): FetchState {
  const request = {};
  return UI.putRegionData(sandbox.putRegionRequestAg(UI.INITIAL_REGION_STATE, key, request), request, { fetched_at: READ_AT });
}

test("only a successful summary read advances the stamp; loading and failure keep the last one", () => {
  assert.strictEqual(sandbox.getLastReadAtAg(PREV_AT, ready), READ_AT);
  assert.strictEqual(sandbox.getLastReadAtAg(PREV_AT, loading), PREV_AT);
  assert.strictEqual(sandbox.getLastReadAtAg(PREV_AT, failed), PREV_AT);
  assert.strictEqual(sandbox.getLastReadAtAg(null, failed), null);
});

test("a refresh of the same request keeps the payload on screen and the stamp reads refreshing, never fresh", () => {
  const refreshing = sandbox.putRegionRequestAg(getReadSummary(KEY_30D), KEY_30D, {});
  assert.equal(refreshing.status, "ready", "the held payload stays rendered");
  assert.deepEqual(refreshing.data, { fetched_at: READ_AT });
  assert.equal(sandbox.getLastReadAtAg(null, refreshing), READ_AT, "the stamp keeps the last read time");
  assert.equal(UI.getFreshnessState({ at: READ_AT, regions: [refreshing], now: NOW }), "refreshing");
});

test("a failed refresh keeps the held payload and the stamp stops reading fresh", () => {
  const request = {};
  const refreshing = sandbox.putRegionRequestAg(getReadSummary(KEY_30D), KEY_30D, request);
  const settled = UI.putRegionFailure(refreshing, request, new Error("HTTP 500 Internal Server Error"));
  assert.deepEqual(settled.data, { fetched_at: READ_AT }, "last-known values survive the failure");
  assert.notEqual(UI.getFreshnessState({ at: READ_AT, regions: [settled], now: NOW }), "fresh");
});

test("a new period drops the held payload, so one window's numbers never sit under another's label", () => {
  const switched = sandbox.putRegionRequestAg(getReadSummary(KEY_30D), KEY_7D, {});
  assert.equal(switched.status, "loading");
  assert.equal(switched.data, null);
  assert.equal(UI.getFreshnessState({ at: null, regions: [switched], now: NOW }), "loading");
});
