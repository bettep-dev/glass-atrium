// Unit tests for routes/wiki.ts pure helpers (no DB).
// Runner: npx tsx --test test/wiki.unit.test.ts
//
// Coverage:
//   - normalizeEpochToMs seconds-vs-ms boundary (F31 — daemon writes epoch
//     SECONDS while the API field is *_ms; 1e12 threshold is unambiguous)
//   - extractBacklog null pass-through (F38 — absent payload keys degrade to
//     null, never a fabricated 0)

import test from "node:test";
import assert from "node:assert/strict";

import { extractBacklog, normalizeEpochToMs } from "../src/server/routes/wiki.js";

test("normalizeEpochToMs: epoch seconds (< 1e12) are scaled to ms", () => {
  // 2026-06-11T00:00:00Z in seconds — the daemon's actual write unit.
  const seconds = 1_781_136_000;
  assert.strictEqual(normalizeEpochToMs(seconds), seconds * 1000);
});

test("normalizeEpochToMs: epoch ms (>= 1e12) pass through unchanged", () => {
  const ms = 1_781_136_000_000;
  assert.strictEqual(normalizeEpochToMs(ms), ms);
});

test("normalizeEpochToMs: 1e12 boundary — below scales, at/above passes", () => {
  // 1e12 - 1 as seconds is year 33658 (unreachable); as ms it is 2001 — so the
  // threshold itself must be treated as ms.
  assert.strictEqual(normalizeEpochToMs(1e12 - 1), (1e12 - 1) * 1000);
  assert.strictEqual(normalizeEpochToMs(1e12), 1e12);
});

test("extractBacklog: absent payload keys degrade to null (no fabricated zeros)", () => {
  const backlog = extractBacklog(new Date("2026-06-11T00:00:00Z"), {});
  assert.strictEqual(backlog.run_date, "2026-06-11");
  assert.strictEqual(backlog.dedup_proposals, null);
  assert.strictEqual(backlog.deadlink_dryrun, null);
  assert.strictEqual(backlog.deadlink_fixes, null);
  assert.strictEqual(backlog.raw_processed, null);
  assert.strictEqual(backlog.true_backlog, null);
});

test("extractBacklog: negative true_backlog degrades to null (contractually meaningless)", () => {
  const backlog = extractBacklog(new Date("2026-06-11T00:00:00Z"), {
    raw_processed: 3,
    true_backlog: -2,
  });
  assert.strictEqual(backlog.raw_processed, 3);
  assert.strictEqual(backlog.true_backlog, null);
});
