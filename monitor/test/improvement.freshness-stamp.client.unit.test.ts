// The Learning header stamp is fed every region the screen loads, so one failed region of
// several reaches the stamp; the state rules themselves belong to ui.freshness-stamp.client.test.ts.
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
const FAILED: RegionState = { status: "error", data: null, error: "HTTP 500 Internal Server Error", busy: false };

test("one failed region of several reaches the stamp as partial", () => {
  const input = sandbox.getFreshnessInputI(READ_AT, [READY, FAILED, READY]);
  assert.strictEqual(sandbox.window.UI.getFreshnessState({ ...input, now: NOW }), "partial");
});
