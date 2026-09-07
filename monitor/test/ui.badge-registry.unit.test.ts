// Unit tests for the T1 5-tier badge taxonomy registry in public/src/ui.jsx
// (window.UI.BADGE_TONE_META + BADGE_OVERRIDES + resolveBadge).
// Runner: npx tsx --test test/ui.badge-registry.unit.test.ts
//
// ui.jsx is a browser module (top-level `const { useEffect } = React`, JSX,
// window export) outside the plain tsx --test import path. To exercise the
// ACTUAL shipped registry (not a drift-prone copy), the test esbuild-transforms
// public/src/ui.jsx in-process and evaluates the IIFE in a node:vm sandbox with
// minimal React/window stubs, then asserts against the real exported tables.
// This pins resolveBadge's three resolution paths: override, tone default and
// unknown-key fallback.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type ToneMeta = { pill: string | null; label: string };
type Override = { tone: string; pill: string | null; label: string };
interface UiExport {
  BADGE_TONE_META: Record<string, ToneMeta>;
  BADGE_OVERRIDES: Record<string, Override>;
  resolveBadge: (key: string) => Override;
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
  assert.ok(ui.BADGE_TONE_META, "must export BADGE_TONE_META");
  assert.ok(ui.BADGE_OVERRIDES, "must export BADGE_OVERRIDES");
  assert.strictEqual(typeof ui.resolveBadge, "function");
  return ui;
}

const ui = await loadUi();
// resolveBadge returns an object from the vm realm — its prototype differs from
// this realm's, so deepStrictEqual's prototype check fails. Re-materialize into a
// same-realm plain object before asserting (mirrors ui.review-flag-reasons pattern).
const badge = (key: string): Override => {
  const b = ui.resolveBadge(key);
  return { tone: b.tone, pill: b.pill, label: b.label };
};

test("browser card: non-ok launch states resolve to their preserved pill/label (Finding 1)", () => {
  assert.deepStrictEqual(badge("browser_failed"), { tone: "crit", pill: "FAILED", label: "Failed to start" });
  assert.deepStrictEqual(badge("browser_unprobed"), { tone: "info", pill: "UNPROBED", label: "Unverified" });
});

test("resolveBadge: override key returns the override entry verbatim", () => {
  assert.deepStrictEqual(badge("pg_open"), { tone: "ok", pill: "OPEN", label: "Connected" });
  assert.deepStrictEqual(badge("hook_warn"), {
    tone: "warn",
    pill: "Warning",
    label: "Failed in 24 h (retried)",
  });
  // 로스터 중 유일하게 실사용 소비자가 있는 키 — agents 화면이 예산 초과 배지로 이 항목만 해석한다.
  assert.deepStrictEqual(
    badge("budget_near_cap"),
    { tone: "warn", pill: "NEAR CAP", label: "Hit tool-use budget" },
    "budget_near_cap 이 축자 그대로 나오지 않음 — agents 화면 예산 초과 배지의 톤·pill·문구가 바뀜",
  );
});

test("resolveBadge: bare tone key returns that tier's default pill + label", () => {
  assert.deepStrictEqual(badge("ok"), { tone: "ok", pill: "OK", label: "Healthy" });
  assert.deepStrictEqual(badge("warn"), { tone: "warn", pill: "Warning", label: "Warning" });
});

test("resolveBadge: unknown key falls back to info (no fabricated ok)", () => {
  const b = badge("nonexistent_key");
  assert.strictEqual(b.tone, "info");
  assert.strictEqual(b.pill, ui.BADGE_TONE_META.info.pill);
});
