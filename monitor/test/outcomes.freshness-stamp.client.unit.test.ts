// The Task results header stamp reports the last successful read through the shared
// freshness atom: a refresh in flight keeps the stamp busy, a failed panel read marks it stale.
//
// Runner: npx tsx --test test/outcomes.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTCOMES_SRC = resolve(__dirname, "../public/src/screens/outcomes.jsx");

interface PanelState {
  status: string;
}

interface FreshnessInput {
  at: string | null;
  loading: boolean;
  failed: boolean;
}

interface StampSandbox {
  window: {
    UI: { getFreshnessState: (input: FreshnessInput & { now: number }) => string };
  };
  getFreshnessInputO: (asOfAt: string | null, stampStates: ReadonlyArray<PanelState>) => FreshnessInput;
}

const sandbox = await buildScreenSandbox<StampSandbox>(OUTCOMES_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

const ready: PanelState = { status: "ready" };
const loading: PanelState = { status: "loading" };
const failed: PanelState = { status: "error" };

function getState(asOfAt: string | null, stampStates: PanelState[]): string {
  return sandbox.window.UI.getFreshnessState({ ...sandbox.getFreshnessInputO(asOfAt, stampStates), now: NOW });
}

test("the stamp carries the last successful read and marks any panel fetch in flight as busy", () => {
  assert.deepEqual({ ...sandbox.getFreshnessInputO(READ_AT, [ready, ready]) }, {
    at: READ_AT,
    loading: false,
    failed: false,
  });
  assert.strictEqual(sandbox.getFreshnessInputO(READ_AT, [ready, loading]).loading, true);
});

test("a refresh keeps the last stamp, and any failed panel read never reads as fresh", () => {
  const cases: Array<[string | null, PanelState[], string]> = [
    [READ_AT, [ready, ready], "fresh"],
    [READ_AT, [ready, loading], "fresh"],
    [null, [loading, loading], "loading"],
    [READ_AT, [ready, failed], "stale"],
    [null, [failed, failed], "not-read"],
  ];

  for (const [asOfAt, stampStates, expected] of cases) {
    const statuses = stampStates.map((st) => st.status).join(",");
    assert.strictEqual(getState(asOfAt, stampStates), expected, `asOf=${asOfAt} panels=${statuses}`);
  }
});
