// Unit tests for the hook-failures errorKind breakdown seam (P12).
// Pure seam — no DB (raw GROUP BY rows in, typed breakdown out).
// Runner: npx tsx --test test/health-detail.error-kind-breakdown.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildHookErrorKindBreakdown } from "../src/server/routes/health-detail.js";

test("breakdown: narrows known kinds + converts bigint count, preserving input order", () => {
  const result = buildHookErrorKindBreakdown([
    { error_kind: "timeout", hook_name: "track-outcome", target_table: "core.outcomes", cnt: 5n },
    {
      error_kind: "connection_refused",
      hook_name: "inject-scope",
      target_table: "core.hook_failures",
      cnt: 2n,
    },
  ]);

  assert.deepStrictEqual(result, [
    { error_kind: "timeout", hook_name: "track-outcome", target_table: "core.outcomes", count: 5 },
    {
      error_kind: "connection_refused",
      hook_name: "inject-scope",
      target_table: "core.hook_failures",
      count: 2,
    },
  ]);
});

test("breakdown: drift error_kind falls back to 'unknown' (union safety)", () => {
  const result = buildHookErrorKindBreakdown([
    { error_kind: "some_future_kind", hook_name: "h", target_table: "t", cnt: 1n },
  ]);
  assert.strictEqual(result[0]?.error_kind, "unknown");
});

test("breakdown: all four canonical kinds narrow to themselves", () => {
  const kinds = ["connection_refused", "timeout", "constraint_violation", "identifier_rejected"];
  const result = buildHookErrorKindBreakdown(
    kinds.map((k) => ({ error_kind: k, hook_name: "h", target_table: "t", cnt: 1n })),
  );
  assert.deepStrictEqual(
    result.map((r) => r.error_kind),
    kinds,
  );
});

test("breakdown: empty rows → empty array", () => {
  assert.deepStrictEqual(buildHookErrorKindBreakdown([]), []);
});

test("breakdown: count preserves large safe-int bigint", () => {
  const result = buildHookErrorKindBreakdown([
    { error_kind: "timeout", hook_name: "h", target_table: "t", cnt: 4200n },
  ]);
  assert.strictEqual(result[0]?.count, 4200);
  assert.strictEqual(typeof result[0]?.count, "number");
});
