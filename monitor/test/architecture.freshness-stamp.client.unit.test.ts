// The System map header stamp reports the last successful headline health read through the
// shared freshness atom, fed with every region the page reads: a read in flight keeps the stamp
// busy, a region whose re-read failed over held data turns it partial, and no successful read
// leaves it unread.
//
// Runner: npx tsx --test test/architecture.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH_SRC = resolve(__dirname, "../public/src/screens/architecture.jsx");

interface RegionState {
  status: "loading" | "ready" | "error";
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
  getFreshnessInputAR: (healthAsOf: string | null, regions: RegionState[]) => FreshnessInput;
}

const sandbox = await buildScreenSandbox<StampSandbox>(ARCH_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

const HELD: RegionState = { status: "ready", data: { ok: true }, error: null, busy: false };
const REREADING: RegionState = { ...HELD, busy: true };
const FIRST_READ: RegionState = { status: "loading", data: null, error: null, busy: true };
// a failed re-read keeps its held data and status 'ready' — only the error field records it
const FAILED_OVER_HELD: RegionState = { ...HELD, error: "HTTP 502" };
const DOWN: RegionState = { status: "error", data: null, error: "HTTP 502", busy: false };

function getState(healthAsOf: string | null, regions: RegionState[]): string {
  return sandbox.window.UI.getFreshnessState({ ...sandbox.getFreshnessInputAR(healthAsOf, regions), now: NOW });
}

test("the stamp answers for every region: a failure over held data shows, and reads in flight keep it busy", () => {
  const rows: Array<{ name: string; asOf: string | null; regions: RegionState[]; expected: string }> = [
    { name: "all regions held and settled", asOf: READ_AT, regions: [HELD, HELD, HELD], expected: "fresh" },
    { name: "one region re-reading", asOf: READ_AT, regions: [HELD, REREADING, HELD], expected: "refreshing" },
    { name: "first read in flight", asOf: null, regions: [FIRST_READ, FIRST_READ], expected: "loading" },
    { name: "a re-read failed over held data", asOf: READ_AT, regions: [FAILED_OVER_HELD, HELD, HELD], expected: "partial" },
    { name: "one region down with nothing held", asOf: READ_AT, regions: [HELD, DOWN, HELD], expected: "partial" },
    { name: "every region failed", asOf: READ_AT, regions: [DOWN, FAILED_OVER_HELD], expected: "stale" },
    { name: "no successful read and nothing in flight", asOf: null, regions: [DOWN, DOWN], expected: "not-read" },
  ];

  for (const row of rows) {
    assert.strictEqual(getState(row.asOf, row.regions), row.expected, row.name);
  }
});
