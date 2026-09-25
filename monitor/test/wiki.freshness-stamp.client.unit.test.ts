// The Wiki header stamp reports the last successful read of its fetch wave through the shared
// freshness atom: a wave in flight keeps the stamp busy, a failed read marks it stale,
// and a read that failed never counts toward advancing the stamp.
//
// Runner: npx tsx --test test/wiki.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIKI_SRC = resolve(__dirname, "../public/src/screens/wiki.jsx");

interface FetchState {
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
  getFreshnessInputW: (settledAt: string | null, waveStates: ReadonlyArray<FetchState>) => FreshnessInput;
  runFetchW: (url: string, signal: AbortSignal | undefined, setter: (state: FetchState) => void) => Promise<boolean>;
  handleErrorW: (err: unknown, setter: (state: FetchState) => void) => boolean;
}

const sandbox = await buildScreenSandbox<StampSandbox>(WIKI_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

const ready: FetchState = { status: "ready" };
const loading: FetchState = { status: "loading" };
const failed: FetchState = { status: "error" };

function getState(settledAt: string | null, waveStates: FetchState[]): string {
  return sandbox.window.UI.getFreshnessState({ ...sandbox.getFreshnessInputW(settledAt, waveStates), now: NOW });
}

test("a wave in flight keeps the last stamp busy, and any failed wiki read never reads as fresh", () => {
  const cases: Array<[string | null, FetchState[], string]> = [
    [READ_AT, [ready, ready], "fresh"],
    [READ_AT, [ready, loading], "refreshing"],
    [null, [loading, loading], "loading"],
    [READ_AT, [ready, failed], "stale"],
    [null, [failed, failed], "not-read"],
  ];

  for (const [settledAt, waveStates, expected] of cases) {
    const statuses = waveStates.map((st) => st.status).join(",");
    assert.strictEqual(getState(settledAt, waveStates), expected, `settledAt=${settledAt} reads=${statuses}`);
  }
  assert.strictEqual(sandbox.getFreshnessInputW(READ_AT, [ready, loading]).loading, true);
});

test("only a successful fetch counts toward advancing the wave stamp; an aborted one is no failure", async () => {
  const seen: FetchState[] = [];
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });

  assert.strictEqual(await sandbox.runFetchW("/api/wiki/summary", undefined, (st) => seen.push(st)), true);
  assert.strictEqual(seen[0].status, "ready");
  assert.strictEqual(sandbox.handleErrorW(new Error("boom"), (st) => seen.push(st)), false);
  assert.strictEqual(seen[1].status, "error");
  assert.strictEqual(sandbox.handleErrorW(aborted, (st) => seen.push(st)), false);
  assert.strictEqual(seen.length, 2, "an abort sets no state");
});
