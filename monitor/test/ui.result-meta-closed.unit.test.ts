// Unit tests for the closed-state presentation token in public/src/ui.jsx
// (window.UI.CLOSED_META + resolveResultMeta) — T4 of the DWC closure UX cycle.
//
// Harness mirrors ui.review-flag-reasons.unit.test.ts: esbuild-transform the real
// browser module in-process and evaluate the IIFE in a node:vm sandbox, so the
// assertions run against the SHIPPED map rather than a drift-prone copy.
//
// Runner: npx tsx --test test/ui.result-meta-closed.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

// A7 invariant — closed glyph must stay inside the canonical dual-encoding set.
const CANONICAL_GLYPHS = ["✓", "⚠", "✕", "ℹ"];

interface ResultMeta {
  tone: string;
  glyph: string;
  icon: string;
  label: string;
  closed?: boolean;
}
interface UiExport {
  RESULT_META: Record<string, ResultMeta>;
  CLOSED_META: ResultMeta;
  resolveResultMeta: (result: string, closedAt: string | null | undefined) => ResultMeta;
}

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
  return windowStub.UI as UiExport;
}

const UI = await loadUi();

test("CLOSED_META dual-encodes: neutral tone + canonical glyph + text label", () => {
  assert.strictEqual(UI.CLOSED_META.tone, "neutral");
  assert.ok(CANONICAL_GLYPHS.includes(UI.CLOSED_META.glyph), "glyph must be in the canonical set");
  assert.ok(UI.CLOSED_META.label.length > 0, "text label is the second encoding channel");
  assert.strictEqual(UI.CLOSED_META.icon, "check");
});

test("RESULT_META keeps exactly the 5 result-enum keys (closed is a separate dimension)", () => {
  assert.deepStrictEqual(Object.keys(UI.RESULT_META).sort(), [
    "blocked",
    "done",
    "done_with_concerns",
    "fail",
    "needs_context",
  ]);
});

test("resolveResultMeta: closed DWC folds to the closed token", () => {
  const meta = UI.resolveResultMeta("done_with_concerns", "2026-08-10T10:00:00.000Z");
  assert.strictEqual(meta.closed, true);
  assert.strictEqual(meta.tone, "neutral");
  assert.strictEqual(meta.icon, "check");
  assert.strictEqual(meta.label, UI.CLOSED_META.label);
});

test("resolveResultMeta: open DWC keeps the amber warn token (polarity pin)", () => {
  for (const openValue of [null, undefined, ""]) {
    const meta = UI.resolveResultMeta("done_with_concerns", openValue as string | null);
    assert.strictEqual(meta.closed, false, `closedAt=${String(openValue)} must read as open`);
    assert.strictEqual(meta.tone, "warn");
    assert.strictEqual(meta.icon, "warn");
  }
});

test("resolveResultMeta: non-DWC results ignore closed_at (taxonomy unchanged)", () => {
  for (const result of ["done", "fail", "blocked", "needs_context"]) {
    const meta = UI.resolveResultMeta(result, "2026-08-10T10:00:00.000Z");
    assert.strictEqual(meta.closed, false);
    assert.strictEqual(meta.tone, UI.RESULT_META[result].tone);
  }
});

test("resolveResultMeta: unknown result falls back without throwing", () => {
  const meta = UI.resolveResultMeta("weird_value", null);
  assert.strictEqual(meta.closed, false);
  assert.strictEqual(meta.label, "weird_value");
});
