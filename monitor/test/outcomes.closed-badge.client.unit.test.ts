// Client unit tests for the DWC closure render branch + optimistic toggle
// lifecycle in public/src/screens/outcomes.jsx (AC2 / AC3 / AC7).
//
// Harness mirrors client.df24-df25-df29.unit.test.ts: both browser modules are
// esbuild-transformed and evaluated in node:vm sandboxes, so the pure helpers
// under test are the SHIPPED ones. ui.jsx runs in its own context first (it
// exports window.UI), then outcomes.jsx runs with that UI injected — the two
// modules share top-level `const { … } = React` names, so one context each.
//
// Runner: npx tsx --test test/outcomes.closed-badge.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const OUTCOMES_SRC = resolve(__dirname, "../public/src/screens/outcomes.jsx");

interface ClosureState {
  pendingIds: Set<number>;
  closedOverrides: Map<number, string>;
}
type ClosureAction =
  | { type: "begin"; id: number }
  | { type: "settle"; id: number; closedAt: string | null };
interface OutcomesHelpers {
  resultColorVarO: (result: string, closedAt?: string | null) => string;
  buildClosureState: (state: ClosureState, action: ClosureAction) => ClosureState;
}

async function transform(src: string, format: "iife" | "esm"): Promise<string> {
  const built = await esbuild.build({
    entryPoints: [src],
    bundle: false,
    write: false,
    loader: { ".jsx": "jsx" },
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    target: "es2022",
    format,
  });
  return built.outputFiles[0].text;
}

function getReactStub(): unknown {
  return new Proxy(
    {
      createElement: () => ({}),
      Fragment: "frag",
      useState: () => [undefined, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useCallback: (fn: unknown) => fn,
      useMemo: (fn: () => unknown) => fn(),
    },
    { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => ({})) },
  );
}

async function loadHelpers(): Promise<OutcomesHelpers> {
  const uiWindow: Record<string, unknown> = {};
  const uiCtx: Record<string, unknown> = {
    window: uiWindow,
    React: getReactStub(),
    document: { documentElement: {} },
    Intl,
    console,
  };
  uiCtx.globalThis = uiCtx;
  vm.createContext(uiCtx);
  vm.runInContext(await transform(UI_SRC, "iife"), uiCtx);

  const outCtx: Record<string, unknown> = {
    window: { UI: uiWindow.UI },
    React: getReactStub(),
    document: { documentElement: {} },
    Intl,
    console,
    URLSearchParams,
    fetch: () => Promise.reject(new Error("no network in unit test")),
  };
  outCtx.globalThis = outCtx;
  vm.createContext(outCtx);
  vm.runInContext(await transform(OUTCOMES_SRC, "esm"), outCtx);
  return outCtx as unknown as OutcomesHelpers;
}

const helpers = await loadHelpers();
const emptyClosure = (): ClosureState => ({ pendingIds: new Set(), closedOverrides: new Map() });

// --- AC3: open DWC stays amber (baseline polarity pin) ---

test("AC3: DWC with NULL closed_at renders the amber warn token", () => {
  assert.strictEqual(helpers.resultColorVarO("done_with_concerns", null), "--warn");
  assert.strictEqual(helpers.resultColorVarO("done_with_concerns", undefined), "--warn");
});

// --- AC2: closed DWC de-emphasizes to grey ---

test("AC2: DWC with a closure timestamp renders de-emphasized grey", () => {
  assert.strictEqual(helpers.resultColorVarO("done_with_concerns", "2026-08-10T10:00:00.000Z"), "--dim");
});

test("closure timestamp does not repaint other results", () => {
  assert.strictEqual(helpers.resultColorVarO("done", "2026-08-10T10:00:00.000Z"), "--ok");
  assert.strictEqual(helpers.resultColorVarO("fail", "2026-08-10T10:00:00.000Z"), "--crit");
  assert.strictEqual(helpers.resultColorVarO("blocked", null), "--info");
});

// --- AC7: pending-map lifecycle ---

test("AC7: begin marks the row pending without recording a closure", () => {
  const next = helpers.buildClosureState(emptyClosure(), { type: "begin", id: 7 });
  assert.strictEqual(next.pendingIds.has(7), true);
  assert.strictEqual(next.closedOverrides.has(7), false);
});

test("AC7: settle on success clears pending and records the optimistic closure", () => {
  const begun = helpers.buildClosureState(emptyClosure(), { type: "begin", id: 7 });
  const settled = helpers.buildClosureState(begun, {
    type: "settle",
    id: 7,
    closedAt: "2026-08-10T10:00:00.000Z",
  });
  assert.strictEqual(settled.pendingIds.has(7), false);
  assert.strictEqual(settled.closedOverrides.get(7), "2026-08-10T10:00:00.000Z");
  // The override feeds the render branch → the row reads as closed.
  assert.strictEqual(helpers.resultColorVarO("done_with_concerns", settled.closedOverrides.get(7)), "--dim");
});

test("AC7: settle on failure clears pending and leaves the row open (amber)", () => {
  const begun = helpers.buildClosureState(emptyClosure(), { type: "begin", id: 7 });
  const settled = helpers.buildClosureState(begun, { type: "settle", id: 7, closedAt: null });
  assert.strictEqual(settled.pendingIds.has(7), false);
  assert.strictEqual(settled.closedOverrides.has(7), false);
  assert.strictEqual(helpers.resultColorVarO("done_with_concerns", settled.closedOverrides.get(7) ?? null), "--warn");
});

test("AC7: transitions are immutable and row-scoped", () => {
  const base = emptyClosure();
  const begun = helpers.buildClosureState(base, { type: "begin", id: 7 });
  helpers.buildClosureState(begun, { type: "settle", id: 7, closedAt: "2026-08-10T10:00:00.000Z" });
  assert.strictEqual(base.pendingIds.size, 0, "prior state must not mutate");
  assert.strictEqual(begun.pendingIds.has(7), true, "begun state must not mutate on settle");

  const twoPending = helpers.buildClosureState(begun, { type: "begin", id: 9 });
  const settledOne = helpers.buildClosureState(twoPending, { type: "settle", id: 7, closedAt: null });
  assert.strictEqual(settledOne.pendingIds.has(9), true, "settling one row must not clear another");
});
