// The Dashboard header stamp reports the last successful wave read through the shared
// freshness atom: a wave in flight keeps the stamp busy, a failed panel read marks it stale,
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
}

interface FreshnessInput {
  at: string | null;
  loading: boolean;
  failed: boolean;
}

interface StampSandbox {
  window: {
    UI: { getFreshnessState: (input: FreshnessInput & { now: number }) => string };
  };
  getFreshnessInputD: (settledAt: string | null, waveStates: ReadonlyArray<PanelState>) => FreshnessInput;
  runFetch: (url: string, signal: AbortSignal | undefined, setter: (state: PanelState) => void) => Promise<boolean>;
  handleError: (err: unknown, setter: (state: PanelState) => void) => boolean;
  describeVersion: (harness: { version?: string } | null) => string;
}

const sandbox = await buildScreenSandbox<StampSandbox>(DASH_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

const ready: PanelState = { status: "ready" };
const loading: PanelState = { status: "loading" };
const failed: PanelState = { status: "error" };

function getState(settledAt: string | null, waveStates: PanelState[]): string {
  return sandbox.window.UI.getFreshnessState({ ...sandbox.getFreshnessInputD(settledAt, waveStates), now: NOW });
}

test("a wave in flight keeps the last stamp busy, and any failed panel read never reads as fresh", () => {
  const cases: Array<[string | null, PanelState[], string]> = [
    [READ_AT, [ready, ready], "fresh"],
    [READ_AT, [ready, loading], "fresh"],
    [null, [loading, loading], "loading"],
    [READ_AT, [ready, failed], "stale"],
    [null, [failed, failed], "not-read"],
  ];

  for (const [settledAt, waveStates, expected] of cases) {
    const statuses = waveStates.map((st) => st.status).join(",");
    assert.strictEqual(getState(settledAt, waveStates), expected, `settledAt=${settledAt} panels=${statuses}`);
  }
  assert.strictEqual(sandbox.getFreshnessInputD(READ_AT, [ready, loading]).loading, true);
});

test("only a successful fetch counts toward advancing the wave stamp", async () => {
  const seen: PanelState[] = [];

  assert.strictEqual(await sandbox.runFetch("/api/cost/kpi", undefined, (st) => seen.push(st)), true);
  assert.strictEqual(seen[0].status, "ready");
  assert.strictEqual(sandbox.handleError(new Error("boom"), (st) => seen.push(st)), false);
  assert.strictEqual(seen[1].status, "error");
});

test("the version label stays beside the stamp and never claims a version it does not have", () => {
  assert.strictEqual(sandbox.describeVersion({ version: "1.0.1" }), "v1.0.1");
  assert.strictEqual(sandbox.describeVersion({}), "version unknown");
  assert.strictEqual(sandbox.describeVersion(null), "version unknown");
});
