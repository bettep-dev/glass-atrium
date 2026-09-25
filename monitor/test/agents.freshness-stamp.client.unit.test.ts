// The Agents header stamp reports the summary's last successful read through the shared
// freshness atom: a refresh keeps the last stamp busy, a failed read never advances it.
//
// Runner: npx tsx --test test/agents.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_SRC = resolve(__dirname, "../public/src/screens/agents.jsx");

interface FetchState {
  status: string;
  data: { fetched_at?: string } | null;
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
  getLastReadAtAg: (prevAt: string | null, state: FetchState) => string | null;
  getFreshnessInputAg: (asOfAt: string | null, state: FetchState, regionStates?: FetchState[]) => FreshnessInput;
}

const sandbox = await buildScreenSandbox<StampSandbox>(AGENTS_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const PREV_AT = new Date(NOW - 120_000).toISOString();
const READ_AT = new Date(NOW - 60_000).toISOString();

const ready: FetchState = { status: "ready", data: { fetched_at: READ_AT } };
const loading: FetchState = { status: "loading", data: null };
const failed: FetchState = { status: "error", data: null };

test("only a successful summary read advances the stamp; loading and failure keep the last one", () => {
  assert.strictEqual(sandbox.getLastReadAtAg(PREV_AT, ready), READ_AT);
  assert.strictEqual(sandbox.getLastReadAtAg(PREV_AT, loading), PREV_AT);
  assert.strictEqual(sandbox.getLastReadAtAg(PREV_AT, failed), PREV_AT);
  assert.strictEqual(sandbox.getLastReadAtAg(null, failed), null);
});

test("a refresh keeps the last stamp, and a failed summary read never reads as fresh", () => {
  const cases: Array<[string | null, FetchState, string]> = [
    [READ_AT, ready, "fresh"],
    [READ_AT, loading, "refreshing"],
    [null, loading, "loading"],
    [READ_AT, failed, "stale"],
    [null, failed, "not-read"],
  ];

  for (const [asOfAt, state, expected] of cases) {
    const input = sandbox.getFreshnessInputAg(asOfAt, state);
    assert.strictEqual(input.loading, state.status === "loading", `busy mirrors loading (${state.status})`);
    assert.strictEqual(
      sandbox.window.UI.getFreshnessState({ ...input, now: NOW }),
      expected,
      `asOf=${asOfAt} summary=${state.status}`,
    );
  }
});

test("the stamp stays busy while any region is loading, even once the summary has been read", () => {
  const rows = [
    { name: "a sibling region still loading", regions: [ready, loading], busy: true },
    { name: "every region settled, one failed", regions: [ready, failed], busy: false },
    { name: "every region read", regions: [ready, ready], busy: false },
  ];
  for (const row of rows) {
    const input = sandbox.getFreshnessInputAg(READ_AT, ready, row.regions);
    assert.strictEqual(input.loading, row.busy, row.name);
    assert.strictEqual(input.failed, false, `${row.name}: only the summary read decides failure`);
  }
});
