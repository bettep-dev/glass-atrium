// The System map header stamp reports the last successful headline health read through the
// shared freshness atom: headline reads in flight keep the stamp busy, a store that did not
// answer marks it stale, and no successful read leaves it unread.
//
// Runner: npx tsx --test test/architecture.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH_SRC = resolve(__dirname, "../public/src/screens/architecture.jsx");

interface FreshnessInput {
  at: string | null;
  loading: boolean;
  failed: boolean;
}

interface StampSandbox {
  window: {
    UI: { getFreshnessState: (input: FreshnessInput & { now: number }) => string };
  };
  getFreshnessInputAR: (healthAsOf: string | null, healthBusy: boolean, erroredCount: number) => FreshnessInput;
}

const sandbox = await buildScreenSandbox<StampSandbox>(ARCH_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

function getState(healthAsOf: string | null, healthBusy: boolean, erroredCount: number): string {
  return sandbox.window.UI.getFreshnessState({ ...sandbox.getFreshnessInputAR(healthAsOf, healthBusy, erroredCount), now: NOW });
}

test("a failed headline store read never reads as fresh, and reads in flight keep the stamp busy", () => {
  const cases: Array<[string | null, boolean, number, string]> = [
    [READ_AT, false, 0, "fresh"],
    [READ_AT, true, 0, "fresh"],
    [null, true, 0, "loading"],
    [READ_AT, false, 1, "stale"],
    [null, false, 4, "not-read"],
    [null, false, 0, "not-read"],
  ];

  for (const [healthAsOf, healthBusy, erroredCount, expected] of cases) {
    const label = `asOf=${healthAsOf} busy=${healthBusy} errored=${erroredCount}`;
    assert.strictEqual(getState(healthAsOf, healthBusy, erroredCount), expected, label);
  }
  assert.strictEqual(sandbox.getFreshnessInputAR(READ_AT, true, 0).loading, true);
});
