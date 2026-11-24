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

interface PartRow {
  id: string;
  name: string;
  tone: string | null;
  statusLabel?: string | null;
  nodeIds: string[];
}

interface StampSandbox {
  window: {
    UI: {
      getFreshnessState: (input: FreshnessInput & { now: number }) => string;
      getFreshnessVerdict: (input: FreshnessInput & { tone: string; now: number }) => { label: string };
    };
  };
  getFreshnessInputAR: (healthAsOf: string | null, regions: RegionState[], mapState: RegionState) => FreshnessInput;
  getPartHealthStatusAR: (partRows: PartRow[], freshness: FreshnessInput & { now: number }) => { tone: string; text: string } | null;
  getPartStatusAR: (row: PartRow, freshness: FreshnessInput & { now: number }) => { tone: string | null; text: string };
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
  return sandbox.window.UI.getFreshnessState({ ...sandbox.getFreshnessInputAR(healthAsOf, regions, HELD), now: NOW });
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

function getPart(id: string, tone: string | null): PartRow {
  return { id, name: id, tone, nodeIds: [] };
}

test("the System parts head status follows the stamp's freshness: a failed re-read over a flagged part reads Last known", () => {
  const parts = [getPart("pg", "crit"), getPart("hooks", "ok")];
  const rows = [
    { name: "settled read", regions: [HELD, HELD], expected: "1 critical" },
    { name: "re-read failed over held data", regions: [FAILED_OVER_HELD, HELD], expected: "1 critical · Last known" },
    { name: "every re-read failed", regions: [FAILED_OVER_HELD, FAILED_OVER_HELD], expected: "1 critical · Last known" },
  ];

  for (const row of rows) {
    const status = sandbox.getPartHealthStatusAR(parts, { at: READ_AT, regions: row.regions, now: NOW });
    assert.strictEqual(status?.text, row.expected, row.name);
  }
});

test("a part row's verdict follows the health stamp: an ok row under a failed re-read never stays an unmarked Healthy", () => {
  const ok: PartRow = { ...getPart("pg", "ok"), statusLabel: "Healthy" };
  const overdue: PartRow = { ...getPart("cron", "crit"), statusLabel: "Overdue" };
  const rows = [
    { name: "settled read keeps the ok verdict", row: ok, regions: [HELD, HELD], tone: "ok", text: "Healthy" },
    { name: "ok row under a failed re-read", row: ok, regions: [FAILED_OVER_HELD, HELD], tone: "neutral", text: "Last known" },
    { name: "flagged row under a failed re-read keeps its alarm", row: overdue, regions: [FAILED_OVER_HELD, HELD], tone: "crit", text: "Last known: Overdue" },
    { name: "row with no verdict", row: getPart("hooks", null), regions: [FAILED_OVER_HELD, HELD], tone: null, text: "Not loaded" },
  ];

  for (const row of rows) {
    const shown = sandbox.getPartStatusAR(row.row, { at: READ_AT, regions: row.regions, now: NOW });
    assert.deepStrictEqual({ tone: shown.tone, text: shown.text }, { tone: row.tone, text: row.text }, row.name);
  }
});
