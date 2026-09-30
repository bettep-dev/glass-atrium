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

interface MapVerdict {
  tone: string;
  freshness: FreshnessInput;
}

interface StampSandbox {
  window: {
    UI: {
      getFreshnessState: (input: FreshnessInput & { now: number }) => string;
      getFreshnessVerdict: (input: FreshnessInput & { tone: string; now: number }) => { label: string };
    };
  };
  getFreshnessInputAR: (healthAsOf: string | null, regions: RegionState[], hasMap: boolean) => FreshnessInput;
  getPageVerdictAR: (partRows: PartRow[], caption: string, nodeIndex: null, freshness: FreshnessInput) => MapVerdict;
  getAttentionEmptyAR: (partRows: PartRow[], busy: boolean, errored: number) => string;
  getPartStatusAR: (row: PartRow, freshness: FreshnessInput & { now: number }) => { tone: string | null; text: string };
  getMapCopyNoteAR: (diagState: RegionState) => string | null;
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
  return sandbox.window.UI.getFreshnessState({ ...sandbox.getFreshnessInputAR(healthAsOf, regions, true), now: NOW });
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

const ALL_CLEAR = "No part needs attention";

function getPart(id: string, tone: string | null): PartRow {
  return { id, name: id, tone, nodeIds: [] };
}

test("the map verdict follows the stamp's freshness: a failed re-read over an all-ok map reads Last known", () => {
  const okParts = [getPart("pg", "ok"), getPart("hooks", "ok")];
  const rows = [
    { name: "settled read", regions: [HELD, HELD], expected: "Healthy" },
    { name: "re-read failed over held data", regions: [FAILED_OVER_HELD, HELD], expected: "Last known" },
    { name: "every re-read failed", regions: [FAILED_OVER_HELD, FAILED_OVER_HELD], expected: "Last known" },
  ];

  for (const row of rows) {
    const freshness = sandbox.getFreshnessInputAR(READ_AT, row.regions, true);
    const verdict = sandbox.getPageVerdictAR(okParts, "All 2 parts ok", null, freshness);
    const shown = sandbox.window.UI.getFreshnessVerdict({ ...verdict.freshness, tone: verdict.tone, now: NOW });
    assert.strictEqual(shown.label, row.expected, row.name);
  }
});

test("part health names the all-clear only once the first health read settles with some part judged", () => {
  const rows = [
    { name: "health read in flight", parts: [getPart("pg", null)], busy: true, errored: 0, isClear: false },
    { name: "health stores unreadable", parts: [getPart("pg", null)], busy: false, errored: 2, isClear: false },
    { name: "nothing read and nothing in flight", parts: [getPart("pg", null)], busy: false, errored: 0, isClear: false },
    { name: "one verdict arrived, one still out", parts: [getPart("pg", "ok"), getPart("hooks", null)], busy: true, errored: 0, isClear: false },
    { name: "every part ok", parts: [getPart("pg", "ok")], busy: false, errored: 0, isClear: true },
  ];

  for (const row of rows) {
    const text = sandbox.getAttentionEmptyAR(row.parts, row.busy, row.errored);
    assert.strictEqual(text === ALL_CLEAR, row.isClear, `${row.name}: ${text}`);
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
    const shown = sandbox.getPartStatusAR(row.row, { ...sandbox.getFreshnessInputAR(READ_AT, row.regions, true), now: NOW });
    assert.deepStrictEqual({ tone: shown.tone, text: shown.text }, { tone: row.tone, text: row.text }, row.name);
  }
});

test("the map carries a last-good-copy label exactly when a re-read failed over the held map", () => {
  const rows = [
    { name: "failed re-read over held map", state: FAILED_OVER_HELD, isLabelled: true },
    { name: "held map, settled", state: HELD, isLabelled: false },
    { name: "held map, re-reading", state: REREADING, isLabelled: false },
    { name: "cold error, nothing held", state: DOWN, isLabelled: false },
    { name: "first read in flight", state: FIRST_READ, isLabelled: false },
  ];

  for (const row of rows) {
    const note = sandbox.getMapCopyNoteAR(row.state);
    assert.strictEqual(/last good copy/i.test(note ?? ""), row.isLabelled, `${row.name}: ${note}`);
  }
});
