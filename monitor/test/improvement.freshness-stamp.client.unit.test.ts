// The Learning header stamp reports the pattern list's last successful read through the
// shared freshness atom: a refresh in flight keeps the stamp busy, a failed read marks it stale.
//
// Runner: npx tsx --test test/improvement.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPROVEMENT_SRC = resolve(__dirname, "../public/src/screens/improvement.jsx");

interface FreshnessInput {
  at: string | null;
  loading: boolean;
  failed: boolean;
}

interface StampSandbox {
  window: {
    UI: { getFreshnessState: (input: FreshnessInput & { now: number }) => string };
  };
  getFreshnessInputI: (asOf: string | null, listState: { status: string }) => FreshnessInput;
}

const sandbox = await buildScreenSandbox<StampSandbox>(IMPROVEMENT_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

function getState(asOf: string | null, status: string): string {
  return sandbox.window.UI.getFreshnessState({ ...sandbox.getFreshnessInputI(asOf, { status }), now: NOW });
}

test("the stamp carries the last successful read and marks a list fetch in flight as busy", () => {
  assert.deepEqual({ ...sandbox.getFreshnessInputI(READ_AT, { status: "ready" }) }, {
    at: READ_AT,
    loading: false,
    failed: false,
  });
  assert.strictEqual(sandbox.getFreshnessInputI(READ_AT, { status: "loading" }).loading, true);
});

test("a refresh keeps the last stamp, and a failed list read never reads as fresh", () => {
  const cases: Array<[string | null, string, string]> = [
    [READ_AT, "ready", "fresh"],
    [READ_AT, "loading", "fresh"],
    [null, "loading", "loading"],
    [READ_AT, "error", "stale"],
    [null, "error", "not-read"],
  ];

  for (const [asOf, status, expected] of cases) {
    assert.strictEqual(getState(asOf, status), expected, `asOf=${asOf} list=${status}`);
  }
});
