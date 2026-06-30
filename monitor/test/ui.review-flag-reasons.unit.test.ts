// Unit tests for the F12 review-flag REASON partition logic in
// public/src/ui.jsx (window.UI.reviewFlagReasons + REVIEW_FLAG_REASON_ORDER).
// Runner: npx tsx --test test/ui.review-flag-reasons.unit.test.ts
//
// ui.jsx is a browser module (top-level `const { useEffect } = React`, JSX,
// window export) outside the plain tsx --test import path. To exercise the
// ACTUAL shipped logic (not a drift-prone copy), the test esbuild-transforms
// public/src/ui.jsx in-process and evaluates the IIFE in a node:vm sandbox with
// minimal React/window stubs, then asserts against the real exported function.
// This brings the F12 reason buckets under regression coverage: a wrong bucket
// assignment or a REVIEW_FLAG_REASON_ORDER↔push-order desync would now fail.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Reason = { key: string; label: string; title: string };
interface ReviewRow {
  review_flag?: boolean | null;
  confidence?: string | null;
  metric_pass?: boolean | null;
  grader_verdict?: string | null;
}
interface UiExport {
  reviewFlagReasons: (row: ReviewRow | null | undefined) => Reason[];
  REVIEW_FLAG_REASON_ORDER: string[];
}

// Build the bundle once and evaluate it in a sandbox — the real window.UI.
async function loadUi(): Promise<UiExport> {
  const built = await esbuild.build({
    entryPoints: [UI_SRC],
    bundle: false,
    write: false,
    loader: { ".jsx": "jsx" },
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    target: "es2022",
    format: "iife",
  });
  const code = built.outputFiles[0].text;

  const windowStub: Record<string, unknown> = {};
  // React stub — every accessed prop returns a no-op factory; module-eval only
  // touches React.createElement inside (uninvoked) component bodies.
  const reactStub = new Proxy(
    { createElement: () => ({}), Fragment: "frag" },
    { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => ({})) },
  );
  const ctx: Record<string, unknown> = {
    window: windowStub,
    React: reactStub,
    document: { documentElement: {} },
    Intl,
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);

  const ui = windowStub.UI as UiExport | undefined;
  assert.ok(ui, "ui.jsx must export window.UI");
  assert.strictEqual(typeof ui.reviewFlagReasons, "function");
  assert.ok(Array.isArray(ui.REVIEW_FLAG_REASON_ORDER));
  return ui;
}

const ui = await loadUi();
// reviewFlagReasons returns an array from the vm realm — its Array prototype
// differs from this realm's, so deepStrictEqual would fail the reference-equal
// prototype check. Re-materialize into a same-realm string[] before asserting.
const reasonKeys = (row: ReviewRow | null | undefined): string[] =>
  Array.from(ui.reviewFlagReasons(row), (r) => r.key);
// Same cross-realm reason for the exported order array.
const reasonOrder: string[] = Array.from(ui.REVIEW_FLAG_REASON_ORDER);

test("reviewFlagReasons: review_flag !== true → 빈 배열 (단락)", () => {
  assert.deepStrictEqual(reasonKeys({ review_flag: false }), []);
  assert.deepStrictEqual(reasonKeys({ review_flag: null }), []);
  assert.deepStrictEqual(reasonKeys({}), []);
  assert.deepStrictEqual(reasonKeys(null), []);
  assert.deepStrictEqual(reasonKeys(undefined), []);
});

test("reviewFlagReasons: confidence=high + metric_pass=false → overconfident", () => {
  const keys = reasonKeys({ review_flag: true, confidence: "high", metric_pass: false });
  assert.deepStrictEqual(keys, ["overconfident"]);
});

test("reviewFlagReasons: confidence=low + metric_pass=true → underconfident", () => {
  const keys = reasonKeys({ review_flag: true, confidence: "low", metric_pass: true });
  assert.deepStrictEqual(keys, ["underconfident"]);
});

test("reviewFlagReasons: metric_pass null/undefined → empty (no self-check)", () => {
  assert.deepStrictEqual(
    reasonKeys({ review_flag: true, confidence: "medium", metric_pass: null }),
    ["empty"],
  );
  assert.deepStrictEqual(
    reasonKeys({ review_flag: true, confidence: "medium" }),
    ["empty"],
  );
});

test("reviewFlagReasons: metric_pass=true + grader_verdict=verified_fail → grader_mismatch", () => {
  const keys = reasonKeys({
    review_flag: true,
    confidence: "medium",
    metric_pass: true,
    grader_verdict: "verified_fail",
  });
  assert.deepStrictEqual(keys, ["grader_mismatch"]);
});

test("reviewFlagReasons: flagged 행이지만 알려진 사유 없음 → other 폴백", () => {
  // review_flag true 인데 confidence/metric_pass 조합이 어느 버킷에도 안 맞음.
  const keys = reasonKeys({ review_flag: true, confidence: "medium", metric_pass: false });
  assert.deepStrictEqual(keys, ["other"]);
});

test("reviewFlagReasons: 복수 사유 동시 보유 시 push 우선순위 순서 보존", () => {
  // confidence=low + metric_pass=true (underconfident) AND grader_mismatch
  // 동시 충족 → underconfident 가 grader_mismatch 보다 먼저 (push 순서).
  const keys = reasonKeys({
    review_flag: true,
    confidence: "low",
    metric_pass: true,
    grader_verdict: "verified_fail",
  });
  assert.deepStrictEqual(keys, ["underconfident", "grader_mismatch"]);
  // 정렬 인덱스가 ORDER 와 일치 (오름차순) — partition 순서 회귀 방지.
  const idx = keys.map((k) => reasonOrder.indexOf(k));
  assert.ok(
    idx.every((v, i) => i === 0 || idx[i - 1] <= v),
    `reason keys must be in REVIEW_FLAG_REASON_ORDER sequence, got ${JSON.stringify(keys)}`,
  );
});

test("REVIEW_FLAG_REASON_ORDER: reviewFlagReasons push 순서와 정합 (모든 버킷 커버)", () => {
  // 함수가 push 할 수 있는 모든 key 가 ORDER 에 존재하고 순서가 동일해야 함.
  const expected = ["overconfident", "underconfident", "empty", "grader_mismatch", "other"];
  assert.deepStrictEqual(reasonOrder, expected);

  // 각 버킷을 단독 트리거하고 [0].key 가 기대 버킷인지 확인 (배치 정확성).
  const single = (row: ReviewRow): string => reasonKeys(row)[0];
  assert.strictEqual(single({ review_flag: true, confidence: "high", metric_pass: false }), "overconfident");
  assert.strictEqual(single({ review_flag: true, confidence: "low", metric_pass: true }), "underconfident");
  assert.strictEqual(single({ review_flag: true, confidence: "high", metric_pass: null }), "empty");
  assert.strictEqual(
    single({ review_flag: true, confidence: "medium", metric_pass: true, grader_verdict: "verified_fail" }),
    "grader_mismatch",
  );
  assert.strictEqual(single({ review_flag: true, confidence: "medium", metric_pass: false }), "other");
});

test("reviewFlagReasons: 반환 객체는 key/label/title 3필드 보유 (배지 렌더 계약)", () => {
  const reasons = ui.reviewFlagReasons({ review_flag: true, confidence: "high", metric_pass: false });
  assert.strictEqual(reasons.length, 1);
  for (const r of reasons) {
    assert.ok(typeof r.key === "string" && r.key);
    assert.ok(typeof r.label === "string" && r.label);
    assert.ok(typeof r.title === "string" && r.title);
  }
});
