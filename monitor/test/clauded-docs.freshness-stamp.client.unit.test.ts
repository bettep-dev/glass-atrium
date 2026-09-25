// The Documents header stamp reports the list's last successful read through the shared
// freshness atom: a refresh keeps the last stamp busy, a failed read never reads as fresh.
//
// Runner: npx tsx --test test/clauded-docs.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_SRC = resolve(__dirname, "../public/src/screens/clauded-docs.jsx");

interface FreshnessInput {
  at: string | null;
  loading: boolean;
  failed: boolean;
}

interface StampSandbox {
  window: {
    UI: { getFreshnessState: (input: FreshnessInput & { now: number }) => string };
  };
  getFreshnessInputCD: (asOf: string | null, listStatus: string) => FreshnessInput;
}

const sandbox = await buildScreenSandbox<StampSandbox>(DOCS_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

test("a list refresh keeps the last stamp busy, and a failed list read never reads as fresh", () => {
  const cases: Array<[string | null, string, string]> = [
    [READ_AT, "ready", "fresh"],
    [READ_AT, "loading", "refreshing"],
    [null, "loading", "loading"],
    [READ_AT, "error", "stale"],
    [null, "error", "not-read"],
  ];

  for (const [asOf, listStatus, expected] of cases) {
    const input = sandbox.getFreshnessInputCD(asOf, listStatus);
    assert.strictEqual(input.at, asOf, `the stamp time is the last successful read (${listStatus})`);
    assert.strictEqual(input.loading, listStatus === "loading", `busy mirrors loading (${listStatus})`);
    assert.strictEqual(
      sandbox.window.UI.getFreshnessState({ ...input, now: NOW }),
      expected,
      `asOf=${asOf} list=${listStatus}`,
    );
  }
});
