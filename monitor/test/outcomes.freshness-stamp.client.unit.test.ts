// The Task results header stamp reads the page's region states: a refresh in flight keeps
// the stamp busy, and a failed panel read never reads as fresh.
//
// Runner: npx tsx --test test/outcomes.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTCOMES_SRC = resolve(__dirname, "../public/src/screens/outcomes.jsx");

interface RegionState {
  status: string;
  data: unknown;
  error: string | null;
  busy: boolean;
}

interface FreshnessInput {
  at: string | null;
  regions: ReadonlyArray<RegionState>;
}

interface StampSandbox {
  window: {
    UI: { getFreshnessState: (input: FreshnessInput & { now: number }) => string; INITIAL_REGION_STATE: RegionState };
  };
  getFreshnessInputO: (asOfAt: string | null, regions: ReadonlyArray<RegionState>) => FreshnessInput;
}

const sandbox = await buildScreenSandbox<StampSandbox>(OUTCOMES_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

const first = sandbox.window.UI.INITIAL_REGION_STATE;
const ready: RegionState = { ...first, status: "ready", data: {}, busy: false };
const refreshing: RegionState = { ...ready, busy: true };
const failedOverHeld: RegionState = { ...ready, error: "HTTP 500" };
const failedFirst: RegionState = { ...first, status: "error", busy: false, error: "HTTP 500" };

function getState(asOfAt: string | null, regions: RegionState[]): string {
  return sandbox.window.UI.getFreshnessState({ ...sandbox.getFreshnessInputO(asOfAt, regions), now: NOW });
}

const rows = [
  { name: "every panel read and settled reads as fresh", at: READ_AT, regions: [ready, ready], expected: "fresh" },
  { name: "a refresh over held data reads as refreshing, never fresh", at: READ_AT, regions: [ready, refreshing], expected: "refreshing" },
  { name: "the first wave reads as loading", at: null, regions: [first, first], expected: "loading" },
  { name: "one failed refresh beside a good panel reads as partial", at: READ_AT, regions: [ready, failedOverHeld], expected: "partial" },
  { name: "every panel failing after a read reads as stale", at: READ_AT, regions: [failedOverHeld, failedOverHeld], expected: "stale" },
  { name: "every panel failing before any read reads as not read", at: null, regions: [failedFirst, failedFirst], expected: "not-read" },
];

for (const row of rows) {
  test(`the stamp: ${row.name}`, () => {
    assert.strictEqual(getState(row.at, row.regions), row.expected);
  });
}
