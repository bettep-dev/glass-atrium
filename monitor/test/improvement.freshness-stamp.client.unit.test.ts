// The Learning header stamp is derived from every region the screen loads: a region in flight
// reads as refreshing, one failed region of several reads as partial, and it is fresh only
// when every region holds a successful answer.
//
// Runner: npx tsx --test test/improvement.freshness-stamp.client.unit.test.ts

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

interface FreshnessInput {
  at: string | null;
  regions: RegionState[];
}

interface StampSandbox {
  window: {
    UI: { getFreshnessState: (input: FreshnessInput & { now: number }) => string };
  };
  getFreshnessInputI: (asOf: string | null, regions: RegionState[]) => FreshnessInput;
}

const sandbox = await buildScreenSandbox<StampSandbox>(IMPROVEMENT_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

const READY: RegionState = { status: "ready", data: {}, error: null, busy: false };
const REFRESHING: RegionState = { status: "ready", data: {}, error: null, busy: true };
const FIRST_LOAD: RegionState = { status: "loading", data: null, error: null, busy: true };
const FAILED: RegionState = { status: "error", data: null, error: "HTTP 500 Internal Server Error", busy: false };

const rows: Array<{ name: string; asOf: string | null; regions: RegionState[]; expected: string }> = [
  { name: "every region answered reads as fresh", asOf: READ_AT, regions: [READY, READY, READY], expected: "fresh" },
  { name: "one region still in flight reads as refreshing", asOf: READ_AT, regions: [READY, REFRESHING, READY], expected: "refreshing" },
  { name: "the first wave with nothing read reads as loading", asOf: null, regions: [FIRST_LOAD, FIRST_LOAD], expected: "loading" },
  { name: "one failed region of several reads as partial", asOf: READ_AT, regions: [READY, FAILED, READY], expected: "partial" },
  { name: "every region failed never reads as fresh", asOf: READ_AT, regions: [FAILED, FAILED], expected: "stale" },
];

for (const row of rows) {
  test(row.name, () => {
    const input = sandbox.getFreshnessInputI(row.asOf, row.regions);
    assert.strictEqual(sandbox.window.UI.getFreshnessState({ ...input, now: NOW }), row.expected);
  });
}
