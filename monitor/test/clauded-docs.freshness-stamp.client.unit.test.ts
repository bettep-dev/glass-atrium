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

interface ListRegion {
  status: string;
  busy: boolean;
  error: string | null;
}

interface FreshnessInput {
  at: string | null;
  regions: ListRegion[];
}

interface StampSandbox {
  window: {
    UI: { getFreshnessState: (input: FreshnessInput & { now: number }) => string };
  };
  getFreshnessInputCD: (asOf: string | null, listState: ListRegion) => FreshnessInput;
}

const sandbox = await buildScreenSandbox<StampSandbox>(DOCS_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

test("a list refresh keeps the last stamp busy, and a failed list read never reads as fresh", () => {
  const cases: Array<{ name: string; asOf: string | null; region: ListRegion; expected: string }> = [
    { name: "settled read", asOf: READ_AT, region: { status: "ready", busy: false, error: null }, expected: "fresh" },
    { name: "refresh over held rows", asOf: READ_AT, region: { status: "ready", busy: true, error: null }, expected: "refreshing" },
    { name: "first read in flight", asOf: null, region: { status: "loading", busy: true, error: null }, expected: "loading" },
    { name: "failed refresh over held rows", asOf: READ_AT, region: { status: "ready", busy: false, error: "HTTP 500" }, expected: "stale" },
    { name: "failed first read", asOf: null, region: { status: "error", busy: false, error: "HTTP 500" }, expected: "not-read" },
  ];

  for (const { name, asOf, region, expected } of cases) {
    const input = sandbox.getFreshnessInputCD(asOf, region);
    assert.strictEqual(input.at, asOf, `the stamp time is the last successful read (${name})`);
    assert.strictEqual(sandbox.window.UI.getFreshnessState({ ...input, now: NOW }), expected, name);
  }
});
