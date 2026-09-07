// Unit tests for the F12 review-flag REASON rendering in
// public/src/ui.jsx (window.UI.reviewFlagReasons + REVIEW_FLAG_REASON_ORDER
// + REVIEW_FLAG_REASON_META).
// Runner: npx tsx --test test/ui.review-flag-reasons.unit.test.ts
//
// ui.jsx is a browser module (top-level `const { useEffect } = React`, JSX,
// window export) outside the plain tsx --test import path. To exercise the
// ACTUAL shipped logic (not a drift-prone copy), the test esbuild-transforms
// public/src/ui.jsx in-process and evaluates the IIFE in a node:vm sandbox with
// minimal React/window stubs, then asserts against the real exported function.
// The label map is additionally paired against the recorder's own vocabulary
// declaration, so a recorder token without a monitor label fails here.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const RECORDER_LIB = resolve(__dirname, "../../hooks/lib/review-flag-reasons.sh");

type Reason = { key: string; label: string; title: string };
interface ReviewRow {
  review_flag?: boolean | null;
  review_flag_reasons?: unknown;
}
interface UiExport {
  reviewFlagReasons: (row: ReviewRow | null | undefined) => Reason[];
  REVIEW_FLAG_REASON_ORDER: string[];
  REVIEW_FLAG_REASON_META: Record<string, { label: string; title: string }>;
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

// The recorder declares the vocabulary once as a space-separated shell literal.
function recorderTokens(): string[] {
  const src = readFileSync(RECORDER_LIB, "utf8");
  const m = src.match(/REVIEW_FLAG_REASON_TOKENS='([^']*)'/);
  assert.ok(m, "recorder lib must declare REVIEW_FLAG_REASON_TOKENS");
  return m[1].split(/\s+/).filter(Boolean);
}

const ui = await loadUi();
// reviewFlagReasons returns an array from the vm realm — its Array prototype
// differs from this realm's, so deepStrictEqual would fail the reference-equal
// prototype check. Re-materialize into a same-realm string[] before asserting.
const reasonKeys = (row: ReviewRow | null | undefined): string[] =>
  Array.from(ui.reviewFlagReasons(row), (r) => r.key);
// Same cross-realm reason for the exported order array.
const reasonOrder: string[] = Array.from(ui.REVIEW_FLAG_REASON_ORDER);

const flagged = (...reasons: string[]): ReviewRow => ({
  review_flag: true,
  review_flag_reasons: reasons,
});

test("reviewFlagReasons: review_flag !== true → 빈 배열 (단락)", () => {
  assert.deepStrictEqual(reasonKeys({ review_flag: false }), []);
  assert.deepStrictEqual(reasonKeys({ review_flag: null }), []);
  assert.deepStrictEqual(reasonKeys({}), []);
  assert.deepStrictEqual(reasonKeys(null), []);
  assert.deepStrictEqual(reasonKeys(undefined), []);
});

test("AC-4.8: 기록된 모든 사유 토큰이 고유 라벨 + 실질 title 로 렌더 — catch-all 0건", () => {
  const seenLabels = new Set<string>();
  for (const code of recorderTokens()) {
    const reasons = Array.from(ui.reviewFlagReasons(flagged(code)));
    assert.strictEqual(reasons.length, 1, `${code}: 단일 사유여야 함`);
    assert.strictEqual(reasons[0].key, code, `${code}: catch-all 로 떨어짐`);
    assert.ok(reasons[0].label, `${code}: 라벨 누락`);
    assert.ok(!seenLabels.has(reasons[0].label), `${code}: 라벨 중복 (${reasons[0].label})`);
    // title 은 배지 툴팁의 유일한 설명 채널 · 전파 지점과 META 항목 어느 쪽이 죽어도 툴팁이 빈다.
    // 등식만 두면 META 를 비웠을 때 양변이 함께 비어 통과하므로 비어있지 않음 단언이 그 구멍을 막는다.
    assert.strictEqual(
      reasons[0].title,
      ui.REVIEW_FLAG_REASON_META[code].title,
      `${code}: title 이 META 테이블 값으로 전파되지 않음 — 배지 툴팁이 사유와 다른 문구를 보임 (got ${JSON.stringify(reasons[0].title)})`,
    );
    assert.ok(
      reasons[0].title,
      `${code}: title 이 비어 있음 — 툴팁이 사라져 운영자가 이 사유가 왜 붙었는지 알 수 없음`,
    );
    seenLabels.add(reasons[0].label);
  }
});

test("AC-4.9: 빈 carrier(구행)와 미상 토큰은 서로 구별되는 상태로 렌더", () => {
  const legacy = Array.from(ui.reviewFlagReasons({ review_flag: true, review_flag_reasons: [] }));
  const absent = reasonKeys({ review_flag: true });
  const unknown = Array.from(ui.reviewFlagReasons(flagged("not-a-real-reason")));

  assert.deepStrictEqual(legacy.map((r) => r.key), ["unclassified"]);
  assert.deepStrictEqual(absent, ["unclassified"]);
  assert.deepStrictEqual(unknown.map((r) => r.key), ["unknown"]);
  assert.notStrictEqual(legacy[0].label, unknown[0].label);
  // 미상 토큰 원문이 title 에 실려야 운영자가 무엇이 안 붙었는지 안다.
  assert.match(unknown[0].title, /not-a-real-reason/);
});

test("reviewFlagReasons: 복수 사유는 기록 순서와 무관하게 ORDER 순서로 정렬 + 중복 제거 — 미상 버킷은 말미", () => {
  const keys = reasonKeys(flagged("grader-contradiction", "overconfidence", "overconfidence"));
  assert.deepStrictEqual(keys, ["overconfidence", "grader-contradiction"]);

  const idx = keys.map((k) => reasonOrder.indexOf(k));
  assert.ok(
    idx.every((v, i) => i === 0 || idx[i - 1] <= v),
    `reason keys must be in REVIEW_FLAG_REASON_ORDER sequence, got ${JSON.stringify(keys)}`,
  );

  // 미상 버킷은 ORDER 말미의 별도 항목 · 꼬리 버킷이 상수에서 빠지면 indexOf 가 -1 이라 맨 앞으로 샌다.
  // 기대값을 ORDER 로 재계산하면 뮤테이션된 상수와 자기 정합해 통과하므로 리터럴 키 나열로 적는다.
  const mixed = reasonKeys(flagged("not-a-real-reason", "grader-contradiction", "overconfidence"));
  assert.deepStrictEqual(
    mixed,
    ["overconfidence", "grader-contradiction", "unknown"],
    `알려진 사유는 미상 버킷보다 항상 앞에 와야 함 — improvement 화면 행 분할이 [0].key 기준이라 미상이 앞으로 새면 분할이 뒤집힘 (got ${JSON.stringify(mixed)})`,
  );
});

test("reviewFlagReasons: 미상 토큰 여러 개는 한 버킷으로 접히되 각자 title 유지", () => {
  const reasons = Array.from(ui.reviewFlagReasons(flagged("ghost-a", "ghost-b")));
  assert.deepStrictEqual(reasons.map((r) => r.key), ["unknown", "unknown"]);
  assert.notStrictEqual(reasons[0].title, reasons[1].title);
});

test("reviewFlagReasons: carrier 가 배열이 아니거나 빈 문자열이면 미분류로 처리", () => {
  assert.deepStrictEqual(reasonKeys({ review_flag: true, review_flag_reasons: "overconfidence" }), ["unclassified"]);
  assert.deepStrictEqual(reasonKeys({ review_flag: true, review_flag_reasons: null }), ["unclassified"]);
  assert.deepStrictEqual(reasonKeys(flagged("", "  ".trim())), ["unclassified"]);
});
