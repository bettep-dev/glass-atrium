// Unit tests for the T1 5-tier badge taxonomy registry in public/src/ui.jsx
// (window.UI.BADGE_TONE_META + BADGE_OVERRIDES + resolveBadge).
// Runner: npx tsx --test test/ui.badge-registry.unit.test.ts
//
// ui.jsx is a browser module (top-level `const { useEffect } = React`, JSX,
// window export) outside the plain tsx --test import path. To exercise the
// ACTUAL shipped registry (not a drift-prone copy), the test esbuild-transforms
// public/src/ui.jsx in-process and evaluates the IIFE in a node:vm sandbox with
// minimal React/window stubs, then asserts against the real exported tables.
// This pins the label-unification contract: a reintroduced abbreviated "WARN"
// pill literal or a missing tone tier would now fail.

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
  DAEMON_STATUS_TONE: Record<string, ToneEntry>;
  resolveBadge: (key: string) => Override;
}
type ToneEntry = { tone: string; label: string };

// The 5 canonical tiers — status tones carry a pill token, neutral is the
// non-status descriptor tier (pill-less neutral shell).
const STATUS_TONES = ["ok", "warn", "crit", "info"];
const ALL_TONES = [...STATUS_TONES, "neutral"];

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

test("BADGE_TONE_META: exactly the 5 canonical tiers, no more no less", () => {
  assert.deepStrictEqual(Object.keys(ui.BADGE_TONE_META).sort(), [...ALL_TONES].sort());
});

test("BADGE_TONE_META: status tones carry a pill token; neutral is pill-less", () => {
  for (const tone of STATUS_TONES) {
    const meta = ui.BADGE_TONE_META[tone];
    assert.ok(meta, `${tone} tier must exist`);
    assert.ok(typeof meta.pill === "string" && meta.pill.length > 0, `${tone} must have a pill token`);
    assert.ok(typeof meta.label === "string" && meta.label.length > 0, `${tone} must have a label`);
  }
  // neutral = non-status descriptor → no pill token (glyph-less neutral shell contract).
  assert.strictEqual(ui.BADGE_TONE_META.neutral.pill, null);
});

test("Rule 2: warn label is the full-word title-case 'Warning' (abbrev retired)", () => {
  assert.strictEqual(ui.BADGE_TONE_META.warn.label, "Warning");
  assert.strictEqual(ui.BADGE_TONE_META.warn.pill, "Warning");
});

test("AC2: no tone default or override reintroduces the retired abbreviated 'WARN' pill", () => {
  const pills = [
    ...Object.values(ui.BADGE_TONE_META).map((m) => m.pill),
    ...Object.values(ui.BADGE_OVERRIDES).map((o) => o.pill),
  ];
  assert.ok(!pills.includes("WARN"), `retired 'WARN' pill must not reappear, got ${JSON.stringify(pills)}`);
});

test("BADGE_OVERRIDES: every override tone is one of the 5 canonical tiers", () => {
  const keys = Object.keys(ui.BADGE_OVERRIDES);
  assert.ok(keys.length > 0, "override enumeration must be non-empty");
  for (const [name, ov] of Object.entries(ui.BADGE_OVERRIDES)) {
    assert.ok(ALL_TONES.includes(ov.tone), `override '${name}' tone '${ov.tone}' must be canonical`);
    assert.ok(typeof ov.pill === "string" && ov.pill.length > 0, `override '${name}' must have a pill token`);
    assert.ok(typeof ov.label === "string" && ov.label.length > 0, `override '${name}' must have a label`);
  }
});

test("BADGE_OVERRIDES: enumerates the per-card tokens the health builders consume (Rule 1)", () => {
  // Rule 1 — PG OPEN/CLOSED · hook ACTIVE · daemon NO DATA · browser FAILED/UNPROBED are
  // registry overrides, never inline (browser ok reuses the 'ok' tone key → not enumerated here).
  const expected = ["pg_open", "pg_closed", "hook_active", "hook_warn", "hook_failed", "hook_unset", "daemon_no_data", "browser_failed", "browser_unprobed"];
  for (const key of expected) {
    assert.ok(ui.BADGE_OVERRIDES[key], `override '${key}' must be enumerated in the registry`);
  }
});

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

// Finding 2 drift guard: DAEMON_STATUS_TONE.ok.label MUST equal BADGE_TONE_META.ok.label.
// The literal 'Healthy' is intentionally duplicated in DAEMON_STATUS_TONE because
// daemon-nodata-consistency.test.ts's source-regex parser requires a string literal there
// (a `BADGE_TONE_META.ok.label` reference would not match). This assertion pins the two in
// sync so the duplication can never silently drift.
test("Finding 2: DAEMON_STATUS_TONE.ok.label stays in sync with BADGE_TONE_META.ok.label", () => {
  assert.ok(ui.DAEMON_STATUS_TONE, "ui.jsx must export DAEMON_STATUS_TONE");
  assert.strictEqual(ui.DAEMON_STATUS_TONE.ok.label, ui.BADGE_TONE_META.ok.label);
  assert.strictEqual(ui.DAEMON_STATUS_TONE.ok.label, "Healthy");
});
