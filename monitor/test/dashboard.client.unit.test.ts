// Unit tests for the client-side pure logic in public/src/screens/dashboard.jsx
// (deriveUpdateView / classifyDiffLine — the P3-T4 update-control state machine +
// unified-diff line classifier). The server preview/commit contract is covered by
// dashboard.update.route.test.ts; this brings the BROWSER half of the interactive
// Update button under regression coverage — a drift in the view precedence (local
// interaction phase over poll), the stale/recency windows, the dismissed-reservation
// suppression, or the +/− diff dual-encode split would otherwise ship undetected.
//
// Runner: npx tsx --test test/dashboard.client.unit.test.ts
//
// dashboard.jsx is a browser global module (top-level `const { useState } = React`,
// JSX, `window.ScreenDashboard =` export) with NO import/export — so esbuild emits it
// as a plain script whose top-level `function` declarations land on the vm context
// global. The test evaluates the ACTUAL shipped source in a node:vm sandbox with
// minimal React/window stubs (module-top reads window.UI.formatUsd etc.), then
// exercises the real helpers — not a drift-prone copy. No DB / no network is touched
// (the tested helpers are pure).

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH_SRC = resolve(__dirname, "../public/src/screens/dashboard.jsx");

interface DiffLine {
  variant: "add" | "del" | "hunk" | "ctx";
  glyph: string;
  text: string;
}
interface UpdateView {
  kind: string;
}
interface DeriveArgs {
  availabilityStatus: string;
  availabilityData: unknown;
  job: unknown;
  phase: string;
  preview: unknown;
  actionError: unknown;
  dismissedJobId: number | null;
  now: number;
  staleMs: number;
}
interface DashHelpers {
  deriveUpdateView: (args: DeriveArgs) => UpdateView;
  classifyDiffLine: (line: string) => DiffLine;
}

// Build once, evaluate in a sandbox — the real top-level helper declarations.
async function loadDash(): Promise<DashHelpers> {
  const built = await esbuild.build({
    entryPoints: [DASH_SRC],
    bundle: false,
    write: false,
    loader: { ".jsx": "jsx" },
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    target: "es2022",
    // No import/export → top-level fn decls become vm-context-global properties.
    format: "esm",
  });
  const code = built.outputFiles[0].text;

  // React stub — every hook returns a benign default; only the (uninvoked) component
  // bodies touch React, so the stubs never actually drive a render.
  const reactStub = new Proxy(
    {
      createElement: () => ({}),
      Fragment: "frag",
      useState: () => [undefined, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useMemo: (fn: () => unknown) => fn(),
      useCallback: (fn: unknown) => fn,
    },
    { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => ({})) },
  );
  // Module-top reads window.UI.formatUsd/formatUsdCompact/formatInt/formatTokenCompact.
  const uiStub = {
    formatUsd: () => "",
    formatUsdCompact: () => "",
    formatInt: (n: number) => String(n),
    formatTokenCompact: () => "",
  };
  const ctx: Record<string, unknown> = {
    window: { UI: uiStub },
    React: reactStub,
    document: { documentElement: {} },
    Intl,
    console,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);

  const h = ctx as unknown as DashHelpers;
  assert.strictEqual(typeof h.deriveUpdateView, "function", "deriveUpdateView must be reachable");
  assert.strictEqual(typeof h.classifyDiffLine, "function", "classifyDiffLine must be reachable");
  return h;
}

const dash = await loadDash();

const NOW = 1_700_000_000_000;
const STALE_MS = 30 * 60 * 1000;

// Convenience builder — the deriveUpdateView arg bag with sensible idle defaults.
function derive(overrides: Partial<DeriveArgs>): UpdateView {
  return dash.deriveUpdateView({
    availabilityStatus: "ready",
    availabilityData: { status: "current" },
    job: null,
    phase: "idle",
    preview: null,
    actionError: null,
    dismissedJobId: null,
    now: NOW,
    staleMs: STALE_MS,
    ...overrides,
  });
}

const jobAt = (status: string, heartbeatMsAgo: number, extra: Record<string, unknown> = {}) => ({
  id: 42,
  status,
  target_version: "v1.2.3",
  started_at: new Date(NOW - heartbeatMsAgo).toISOString(),
  heartbeat_at: new Date(NOW - heartbeatMsAgo).toISOString(),
  failure_reason: null,
  ...extra,
});

// --- local interaction phase precedence (over poll) ---

test("actionError overrides everything → error", () => {
  assert.strictEqual(
    derive({ actionError: { message: "boom" }, phase: "reviewing", job: jobAt("in-progress", 0) }).kind,
    "error",
  );
});

test("phase committing → committing (even with a fresh job)", () => {
  assert.strictEqual(derive({ phase: "committing", job: jobAt("in-progress", 0) }).kind, "committing");
});

test("phase previewing → previewing", () => {
  assert.strictEqual(derive({ phase: "previewing" }).kind, "previewing");
});

test("phase reviewing with ready preview + files → reviewing (poll in-progress suppressed)", () => {
  const preview = { status: "ready", job_id: 42, nonce: "n", target_version: "v1.2.3", files: [{ path: "a", diff: "", is_new: false }] };
  // The preview reserved an in_progress row; local reviewing MUST win over the poll.
  assert.strictEqual(derive({ phase: "reviewing", preview, job: jobAt("in-progress", 0) }).kind, "reviewing");
});

test("phase reviewing with up_to_date preview → up-to-date", () => {
  assert.strictEqual(derive({ phase: "reviewing", preview: { status: "up_to_date", files: [] } }).kind, "up-to-date");
});

test("phase reviewing with ready-but-empty files → up-to-date", () => {
  assert.strictEqual(derive({ phase: "reviewing", preview: { status: "ready", files: [] } }).kind, "up-to-date");
});

// --- idle: job poll consumption ---

test("idle in-progress with fresh heartbeat → in-progress", () => {
  assert.strictEqual(derive({ job: jobAt("in-progress", 5_000) }).kind, "in-progress");
});

test("idle in-progress with stale heartbeat → stale (no infinite spinner)", () => {
  assert.strictEqual(derive({ job: jobAt("in-progress", STALE_MS + 1) }).kind, "stale");
});

test("idle completed within recency window → completed", () => {
  assert.strictEqual(derive({ job: jobAt("completed", 60_000) }).kind, "completed");
});

test("idle completed past recency window → falls through (no permanent nag)", () => {
  // availability current → hidden; nothing lingers forever.
  assert.strictEqual(derive({ job: jobAt("completed", STALE_MS + 1) }).kind, "hidden");
});

test("idle failed within recency window → failed", () => {
  assert.strictEqual(derive({ job: jobAt("failed", 60_000, { failure_reason: "x" }) }).kind, "failed");
});

test("idle failed past recency window → falls through to hidden", () => {
  assert.strictEqual(derive({ job: jobAt("failed", STALE_MS + 1) }).kind, "hidden");
});

test("dismissed reservation is suppressed → shows availability instead", () => {
  const job = jobAt("in-progress", 0); // id 42, our own reserved-but-dismissed row
  assert.strictEqual(
    derive({ job, dismissedJobId: 42, availabilityData: { status: "update-available" } }).kind,
    "available",
  );
});

// --- availability + precedence + signal-free ---

test("no job + update-available → available", () => {
  assert.strictEqual(derive({ availabilityData: { status: "update-available" } }).kind, "available");
});

test("job in-progress takes precedence over update-available availability", () => {
  assert.strictEqual(
    derive({ job: jobAt("in-progress", 0), availabilityData: { status: "update-available" } }).kind,
    "in-progress",
  );
});

test("non-update-available verdict with no job → hidden (signal-free)", () => {
  for (const status of ["current", "unknown", "source-dev"]) {
    assert.strictEqual(derive({ availabilityData: { status } }).kind, "hidden", `verdict ${status}`);
  }
});

test("availability not ready (loading) + no job → hidden", () => {
  assert.strictEqual(derive({ availabilityStatus: "loading", availabilityData: null }).kind, "hidden");
});

test("job with unparseable heartbeat in-progress → stale (Infinity age, never a stuck spinner)", () => {
  assert.strictEqual(derive({ job: jobAt("in-progress", 0, { heartbeat_at: "not-a-date" }) }).kind, "stale");
});

// --- classifyDiffLine: +/− dual-encode split ---

test("addition line → add variant, + glyph, leading char stripped", () => {
  const c = dash.classifyDiffLine("+const x = 1;");
  assert.deepStrictEqual({ variant: c.variant, glyph: c.glyph, text: c.text }, { variant: "add", glyph: "+", text: "const x = 1;" });
});

test("deletion line → del variant, − glyph, leading char stripped", () => {
  const c = dash.classifyDiffLine("-const x = 1;");
  assert.deepStrictEqual({ variant: c.variant, glyph: c.glyph, text: c.text }, { variant: "del", glyph: "−", text: "const x = 1;" });
});

test("hunk header @@ → hunk variant, no glyph, full text", () => {
  const c = dash.classifyDiffLine("@@ -1,4 +1,6 @@");
  assert.deepStrictEqual({ variant: c.variant, glyph: c.glyph, text: c.text }, { variant: "hunk", glyph: "", text: "@@ -1,4 +1,6 @@" });
});

test("file headers +++/--- → hunk variant (not add/del)", () => {
  assert.strictEqual(dash.classifyDiffLine("+++ b/file.ts").variant, "hunk");
  assert.strictEqual(dash.classifyDiffLine("--- a/file.ts").variant, "hunk");
});

test("context line (leading space) → ctx, leading space stripped", () => {
  const c = dash.classifyDiffLine(" unchanged");
  assert.deepStrictEqual({ variant: c.variant, glyph: c.glyph, text: c.text }, { variant: "ctx", glyph: "", text: "unchanged" });
});

test("bare line (no prefix) → ctx, unchanged text", () => {
  const c = dash.classifyDiffLine("bare");
  assert.deepStrictEqual({ variant: c.variant, glyph: c.glyph, text: c.text }, { variant: "ctx", glyph: "", text: "bare" });
});
