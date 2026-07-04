// Unit tests for the client-side pure logic in public/src/screens/dashboard.jsx
// (deriveUpdateView — the UpdateBadge state machine, 5 kinds: hidden | available |
// updating | current | failed). The server update contract is covered by
// dashboard.update.route.test.ts; this brings the BROWSER half of the Update button
// under regression coverage — a drift in the precedence (actionError → optimistic
// 'working' phase → job poll → availability → hidden), the stale in-progress
// degrade-to-failed, or the completed→current sticky (no age gate, no revert to a
// stale update-available) would otherwise ship undetected.
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

interface UpdateView {
  kind: string;
}
interface DeriveArgs {
  availabilityStatus: string;
  availabilityData: unknown;
  job: unknown;
  phase: string;
  actionError: unknown;
  now: number;
  staleMs: number;
}
interface DashHelpers {
  deriveUpdateView: (args: DeriveArgs) => UpdateView;
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
    actionError: null,
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

// --- top precedence: actionError, then optimistic 'working' phase ---

test("actionError → failed (overrides 'working' phase and a completed job)", () => {
  assert.strictEqual(
    derive({ actionError: { message: "boom" }, phase: "working", job: jobAt("completed", 0) }).kind,
    "failed",
  );
});

test("phase 'working' → updating (optimistic, overrides a completed job poll)", () => {
  assert.strictEqual(derive({ phase: "working", job: jobAt("completed", 0) }).kind, "updating");
});

// --- job poll consumption ---

test("job completed → current (sticky — no age gate, current even past staleMs)", () => {
  assert.strictEqual(derive({ job: jobAt("completed", STALE_MS + 1) }).kind, "current");
});

test("job failed → failed", () => {
  assert.strictEqual(derive({ job: jobAt("failed", 0, { failure_reason: "x" }) }).kind, "failed");
});

test("job in-progress with fresh heartbeat → updating", () => {
  assert.strictEqual(derive({ job: jobAt("in-progress", 5_000) }).kind, "updating");
});

test("job in-progress with stale heartbeat (age > staleMs) → failed (stalled degrade)", () => {
  assert.strictEqual(derive({ job: jobAt("in-progress", STALE_MS + 1) }).kind, "failed");
});

test("job in-progress with unparseable heartbeat → failed (Infinity age, never a stuck spinner)", () => {
  assert.strictEqual(derive({ job: jobAt("in-progress", 0, { heartbeat_at: "not-a-date" }) }).kind, "failed");
});

// --- availability consumption (no job) ---

test("no job + ready + update-available → available", () => {
  assert.strictEqual(derive({ job: null, availabilityData: { status: "update-available" } }).kind, "available");
});

test("no job + ready + current → current (resting)", () => {
  assert.strictEqual(derive({ job: null, availabilityData: { status: "current" } }).kind, "current");
});

test("no job + ready + non-actionable verdict → hidden (signal-free)", () => {
  for (const status of ["unknown", "source-dev", "error"]) {
    assert.strictEqual(derive({ job: null, availabilityData: { status } }).kind, "hidden", `verdict ${status}`);
  }
});

test("availability not ready (loading) + no job → hidden", () => {
  assert.strictEqual(derive({ availabilityStatus: "loading", availabilityData: null }).kind, "hidden");
});

test("availability ready but null data + no job → hidden", () => {
  assert.strictEqual(derive({ availabilityStatus: "ready", availabilityData: null }).kind, "hidden");
});

// --- precedence: job wins over availability ---

test("in-progress job (fresh) takes precedence over update-available availability → updating", () => {
  assert.strictEqual(
    derive({ job: jobAt("in-progress", 5_000), availabilityData: { status: "update-available" } }).kind,
    "updating",
  );
});

test("completed job is sticky over update-available availability → current (no revert to available)", () => {
  assert.strictEqual(
    derive({ job: jobAt("completed", STALE_MS + 1), availabilityData: { status: "update-available" } }).kind,
    "current",
  );
});
