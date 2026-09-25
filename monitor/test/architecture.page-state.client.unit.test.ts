// The System map's page-level state copy: which failed reads earn the one page alert, how the
// caption's failure count lines up with the stamp's, when the stamp may name a read time, and
// what a drawer connection row names.
//
// Runner: npx tsx --test test/architecture.page-state.client.unit.test.ts

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

interface PageFailure {
  sources: string[];
  error: string;
}

interface PartRow {
  name: string;
  tone: string | null;
}

interface Flow {
  id: string;
  from: string;
  to: string;
}

interface PageStateSandbox {
  window: {
    UI: {
      getFreshnessState: (input: { at: string | null; regions: RegionState[]; now: number }) => string;
      getRegionSummary: (regions: RegionState[]) => { failedCount: number; regionCount: number };
    };
  };
  getPageReadEntriesAR: (
    diagState: RegionState,
    liveState: RegionState,
    healthStates: Record<string, RegionState>,
  ) => Array<{ source: string; state: RegionState }>;
  getPageFailureAR: (entries: Array<{ source: string; state: RegionState }>) => PageFailure | null;
  getHealthCaptionAR: (
    partRows: PartRow[],
    busy: boolean,
    errored: number,
    reads: { failedCount: number; regionCount: number },
  ) => string;
  getFreshnessInputAR: (
    healthAsOf: string | null,
    regions: RegionState[],
    hasMap: boolean,
  ) => { at: string | null; regions: RegionState[] };
  getFlowPeerLabelAR: (flow: Flow, direction: "in" | "out", nodeIndex: Map<string, { label: string }>) => string;
}

const sandbox = await buildScreenSandbox<PageStateSandbox>(ARCH_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

const HELD: RegionState = { status: "ready", data: { ok: true }, error: null, busy: false };
const FAILED_OVER_HELD: RegionState = { ...HELD, error: "HTTP 502 Bad Gateway" };
const DOWN: RegionState = { status: "error", data: null, error: "HTTP 502 Bad Gateway", busy: false };
const DOWN_OTHER_CAUSE: RegionState = { status: "error", data: null, error: "HTTP 404 Not Found", busy: false };
const FIRST_READ: RegionState = { status: "loading", data: null, error: null, busy: true };

function getEntries(diag: RegionState, live: RegionState, health: RegionState): Array<{ source: string; state: RegionState }> {
  return sandbox.getPageReadEntriesAR(diag, live, {
    daemonState: health,
    hookState: health,
    pgState: health,
    hookFailState: health,
  });
}

test("every failed read reaches one page alert, and a clean or single cold failure leaves it to the region", () => {
  const rows: Array<{ name: string; entries: Array<{ source: string; state: RegionState }>; failedSources: number | null }> = [
    { name: "nothing failed", entries: getEntries(HELD, HELD, HELD), failedSources: null },
    { name: "a warm re-read failed over held data", entries: getEntries(FAILED_OVER_HELD, HELD, HELD), failedSources: 1 },
    { name: "every warm re-read failed", entries: getEntries(FAILED_OVER_HELD, FAILED_OVER_HELD, FAILED_OVER_HELD), failedSources: 6 },
    { name: "a total cold outage", entries: getEntries(DOWN, DOWN, DOWN), failedSources: 6 },
    { name: "one cold failure with nothing held", entries: getEntries(DOWN, HELD, HELD), failedSources: null },
    { name: "cold failures of different causes", entries: getEntries(DOWN, DOWN_OTHER_CAUSE, HELD), failedSources: null },
  ];

  for (const row of rows) {
    const failure = sandbox.getPageFailureAR(row.entries);
    const failedCount = row.entries.filter((entry) => entry.state.error != null).length;
    if (row.failedSources === null) {
      assert.strictEqual(failure, null, row.name);
      continue;
    }
    assert.ok(failure, row.name);
    assert.strictEqual(failure.sources.length, failedCount, row.name);
    assert.strictEqual(failure.sources.length, row.failedSources, row.name);
  }
});

test("the alert names each source mid-sentence, so only a proper noun keeps its capital", () => {
  const failure = sandbox.getPageFailureAR(getEntries(DOWN, DOWN, DOWN));

  assert.ok(failure);
  for (const source of failure.sources) {
    const isProperNoun = source === "PostgreSQL";
    assert.ok(isProperNoun || source === source.toLowerCase(), `"${source}" is capitalised mid-sentence`);
  }
});

test("the caption's failed-read count is the stamp's own tally over the same regions", () => {
  const regions = [HELD, DOWN, HELD, DOWN, HELD, HELD];
  const tally = sandbox.window.UI.getRegionSummary(regions);
  const partRows: PartRow[] = [
    { name: "a", tone: "ok" },
    { name: "b", tone: "ok" },
    { name: "c", tone: "ok" },
    { name: "d", tone: null },
    { name: "e", tone: null },
    { name: "f", tone: null },
    { name: "g", tone: null },
  ];

  const caption = sandbox.getHealthCaptionAR(partRows, false, 1, tally);

  assert.ok(
    caption.includes(`${tally.failedCount} of ${tally.regionCount} reads failed`),
    `caption "${caption}" does not carry the stamp's ${tally.failedCount} of ${tally.regionCount}`,
  );
});

test("the stamp names a read time only once the map itself has been read", () => {
  const rows: Array<{ name: string; asOf: string | null; regions: RegionState[]; hasMap: boolean; expected: string }> = [
    { name: "a health read landed before the map", asOf: READ_AT, regions: [FIRST_READ, HELD], hasMap: false, expected: "loading" },
    { name: "the map never read and nothing in flight", asOf: READ_AT, regions: [DOWN, HELD], hasMap: false, expected: "not-read" },
    { name: "the map read and every region settled", asOf: READ_AT, regions: [HELD, HELD], hasMap: true, expected: "fresh" },
  ];

  for (const row of rows) {
    const input = sandbox.getFreshnessInputAR(row.asOf, row.regions, row.hasMap);
    assert.strictEqual(sandbox.window.UI.getFreshnessState({ ...input, now: NOW }), row.expected, row.name);
  }
});

test("a drawer connection row names the other end of the edge, never the open node", () => {
  const nodeIndex = new Map([
    ["open", { label: "Open node" }],
    ["peer", { label: "Peer node" }],
  ]);
  const inbound: Flow = { id: "e1", from: "peer", to: "open" };
  const outbound: Flow = { id: "e2", from: "open", to: "peer" };

  assert.strictEqual(sandbox.getFlowPeerLabelAR(inbound, "in", nodeIndex), "Peer node");
  assert.strictEqual(sandbox.getFlowPeerLabelAR(outbound, "out", nodeIndex), "Peer node");
});
