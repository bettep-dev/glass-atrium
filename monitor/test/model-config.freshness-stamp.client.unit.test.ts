// The Models & budgets header stamp reports the config's last successful read through the shared
// freshness atom: a refresh keeps the last stamp busy, a failed read never advances it.
//
// Runner: npx tsx --test test/model-config.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MC_SRC = resolve(__dirname, "../public/src/screens/model-config.jsx");

interface FetchState {
  status: string;
  receivedAt?: number;
}

interface FreshnessInput {
  at: number | null;
  loading: boolean;
  failed: boolean;
}

interface StampSandbox {
  window: {
    UI: { getFreshnessState: (input: FreshnessInput & { now: number }) => string };
  };
  getLastReadAtMC: (prevAt: number | null, state: FetchState) => number | null;
  getFreshnessInputMC: (asOfAt: number | null, state: FetchState) => FreshnessInput;
}

const sandbox = await buildScreenSandbox<StampSandbox>(MC_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const PREV_AT = NOW - 120_000;
const READ_AT = NOW - 60_000;

const ready: FetchState = { status: "ready", receivedAt: READ_AT };
const loading: FetchState = { status: "loading" };
const failed: FetchState = { status: "error" };

test("only a successful config read advances the stamp; loading and failure keep the last one", () => {
  assert.strictEqual(sandbox.getLastReadAtMC(PREV_AT, ready), READ_AT);
  assert.strictEqual(sandbox.getLastReadAtMC(PREV_AT, loading), PREV_AT);
  assert.strictEqual(sandbox.getLastReadAtMC(PREV_AT, failed), PREV_AT);
  assert.strictEqual(sandbox.getLastReadAtMC(null, failed), null);
});

test("a refresh keeps the last stamp, and a failed config read never reads as fresh", () => {
  const cases: Array<[number | null, FetchState, string]> = [
    [READ_AT, ready, "fresh"],
    [READ_AT, loading, "fresh"],
    [null, loading, "loading"],
    [READ_AT, failed, "stale"],
    [null, failed, "not-read"],
  ];

  for (const [asOfAt, state, expected] of cases) {
    const input = sandbox.getFreshnessInputMC(asOfAt, state);
    assert.strictEqual(input.loading, state.status === "loading", `busy mirrors loading (${state.status})`);
    assert.strictEqual(
      sandbox.window.UI.getFreshnessState({ ...input, now: NOW }),
      expected,
      `asOf=${asOfAt} config=${state.status}`,
    );
  }
});
