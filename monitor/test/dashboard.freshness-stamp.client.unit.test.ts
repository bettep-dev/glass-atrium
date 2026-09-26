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

interface StampSandbox {
  window: {
    UI: {
      getFreshnessState: (input: FreshnessInput & { now: number }) => string;
      INITIAL_REGION_STATE: PanelState;
    };
  };
  getFreshnessInputD: (settledAt: string | null, waveStates: ReadonlyArray<PanelState>) => FreshnessInput;
  runFetch: (url: string, setter: (update: Updater) => void, request: AbortController) => Promise<boolean>;
  describeVersion: (harness: { version?: string } | null) => string;
}

const sandbox = await buildScreenSandbox<StampSandbox>(DASH_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

const ready: PanelState = { status: "ready", busy: false, error: null, data: {} };
const refreshing: PanelState = { ...ready, busy: true };
const loading: PanelState = { status: "loading", busy: true, error: null };
const failed: PanelState = { status: "error", busy: false, error: "HTTP 500" };

function getState(settledAt: string | null, waveStates: PanelState[]): string {
  return sandbox.window.UI.getFreshnessState({ ...sandbox.getFreshnessInputD(settledAt, waveStates), now: NOW });
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
});
