// The Models & budgets header stamp reads the config region through the shared freshness atom:
// a refresh in flight reads as refreshing, a failed read never reads as fresh.
//
// Runner: npx tsx --test test/model-config.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MC_SRC = resolve(__dirname, "../public/src/screens/model-config.jsx");

interface RegionState {
  status: string;
  data: unknown;
  error: string | null;
  busy: boolean;
}

interface FreshnessInput {
  at: number | null;
  regions: RegionState[];
}

interface StampSandbox {
  window: {
    UI: { getFreshnessState: (input: FreshnessInput & { now: number }) => string };
  };
  getFreshnessInputMC: (asOfAt: number | null, state: RegionState) => FreshnessInput;
}

const sandbox = await buildScreenSandbox<StampSandbox>(MC_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = NOW - 60_000;

const settled: RegionState = { status: "ready", data: {}, error: null, busy: false };

test("a refresh keeps the last stamp, and a failed config read never reads as fresh", () => {
  const cases: Array<[number | null, RegionState, string]> = [
    [READ_AT, settled, "fresh"],
    [READ_AT, { ...settled, busy: true }, "refreshing"],
    [null, { status: "loading", data: null, error: null, busy: true }, "loading"],
    [READ_AT, { ...settled, error: "HTTP 500 Internal Server Error" }, "stale"],
    [null, { status: "error", data: null, error: "HTTP 500 Internal Server Error", busy: false }, "not-read"],
  ];

  for (const [asOfAt, state, expected] of cases) {
    const input = sandbox.getFreshnessInputMC(asOfAt, state);
    assert.strictEqual(
      sandbox.window.UI.getFreshnessState({ ...input, now: NOW }),
      expected,
      `asOf=${asOfAt} busy=${state.busy} error=${state.error}`,
    );
  }
});
