// The Dashboard header stamp reports the last successful wave read through the shared
// freshness atom: a wave in flight keeps the stamp busy, a failed panel read never reads fresh,
// and a wave with no successful read never advances the stamp.
//
// Runner: npx tsx --test test/dashboard.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH_SRC = resolve(__dirname, "../public/src/screens/dashboard.jsx");

interface PanelState {
  status: string;
  busy: boolean;
  error: string | null;
  data?: unknown;
}

interface FreshnessInput {
  at: string | null;
  regions: ReadonlyArray<PanelState>;
}

type Updater = (state: PanelState) => PanelState;

// the shell's harness fold — status, not a region's busy flag, says its read is in flight
interface HarnessFold {
  status: string;
  error: string | null;
}

interface StampSandbox {
  window: {
    UI: {
      getFreshnessState: (input: FreshnessInput & { now: number }) => string;
      INITIAL_REGION_STATE: PanelState;
    };
  };
  getFreshnessInputD: (
    settledAt: string | null,
    waveStates: ReadonlyArray<PanelState>,
    harness?: HarnessFold | null,
  ) => FreshnessInput;
  runFetch: (url: string, setter: (update: Updater) => void, request: AbortController) => Promise<boolean>;
  describeVersion: (harness: { status?: string; version?: string } | null) => string | null;
}

const sandbox = await buildScreenSandbox<StampSandbox>(DASH_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

const ready: PanelState = { status: "ready", busy: false, error: null, data: {} };
const refreshing: PanelState = { ...ready, busy: true };
const loading: PanelState = { status: "loading", busy: true, error: null };
const failed: PanelState = { status: "error", busy: false, error: "HTTP 500" };

function getState(settledAt: string | null, waveStates: PanelState[], harness: HarnessFold | null = null): string {
  return sandbox.window.UI.getFreshnessState({ ...sandbox.getFreshnessInputD(settledAt, waveStates, harness), now: NOW });
}

test("a wave in flight keeps the last stamp busy, and any failed panel read never reads as fresh", () => {
  const cases: Array<[string | null, PanelState[], string]> = [
    [READ_AT, [ready, ready], "fresh"],
    [READ_AT, [ready, refreshing], "refreshing"],
    [null, [loading, loading], "loading"],
    [READ_AT, [ready, failed], "partial"],
    [READ_AT, [failed, failed], "stale"],
    [null, [failed, failed], "not-read"],
  ];

  for (const [settledAt, waveStates, expected] of cases) {
    const statuses = waveStates.map((st) => `${st.status}${st.busy ? "+busy" : ""}`).join(",");
    assert.strictEqual(getState(settledAt, waveStates), expected, `settledAt=${settledAt} panels=${statuses}`);
  }
});

test("the header stamp answers for the shell harness read, so a pending harness read never reads as fresh", () => {
  const rows: Array<{ name: string; harness: HarnessFold | null; expected: string }> = [
    { name: "harness read settled", harness: { status: "ready", error: null }, expected: "fresh" },
    { name: "harness first read in flight", harness: { status: "loading", error: null }, expected: "refreshing" },
    { name: "harness latest read failed", harness: { status: "ready", error: "HTTP 500" }, expected: "partial" },
  ];

  for (const row of rows) {
    assert.strictEqual(getState(READ_AT, [ready, ready], row.harness), row.expected, row.name);
  }
});

function foldUpdates(): { setter: (update: Updater) => void; current: () => PanelState } {
  let state = sandbox.window.UI.INITIAL_REGION_STATE;
  return { setter: (update) => { state = update(state); }, current: () => state };
}

test("only a successful fetch counts toward advancing the wave stamp", async () => {
  const ok = foldUpdates();
  assert.strictEqual(await sandbox.runFetch("/api/cost/kpi", ok.setter, new AbortController()), true);
  assert.strictEqual(ok.current().status, "ready");
  assert.strictEqual(ok.current().busy, false);

  const context = sandbox as unknown as { fetch: unknown };
  const originalFetch = context.fetch;
  const bad = foldUpdates();
  const failing = { ok: false, status: 503, statusText: "Service Unavailable", text: async () => "down" };
  context.fetch = () => Promise.resolve(failing);
  try {
    assert.strictEqual(await sandbox.runFetch("/api/cost/kpi", bad.setter, new AbortController()), false);
  } finally {
    context.fetch = originalFetch;
  }
  assert.strictEqual(bad.current().status, "error");
  assert.match(String(bad.current().error), /^HTTP 503 Service Unavailable/);
});

test("the version label stays beside the stamp and never claims a version it does not have", () => {
  assert.strictEqual(sandbox.describeVersion({ version: "1.0.1" }), "v1.0.1");
  assert.strictEqual(sandbox.describeVersion({}), "version unknown");
  assert.strictEqual(sandbox.describeVersion(null), "version unknown");
  assert.strictEqual(sandbox.describeVersion({ status: "loading" }), null, "a pending read names no version, so the stamp alone says loading");
});
