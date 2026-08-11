// Unit tests for the closure-aware Task-results logic in
// public/src/screens/dashboard.jsx — getOpenCount / computeOutcomeHint /
// computeWorstRollup. The norm warning keys on OPEN done-with-concerns
// (count - closed_count), so an all-closed DWC population must stop warning
// while the total count and the fail/blocked thresholds stay closure-blind.
//
// Harness mirrors dashboard.client.unit.test.ts: the shipped source is
// esbuild-transformed and evaluated in a node:vm sandbox, so the helpers under
// test are the real ones (no drift-prone copy). No DB / no network.
//
// Runner: npx tsx --test test/dashboard.dwc-closure.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH_SRC = resolve(__dirname, "../public/src/screens/dashboard.jsx");

// LOW_N_MIN mirrors ui.jsx (30) — the rollup skips samples below it.
const LOW_N_MIN = 30;

interface ByResultRow {
  result: string;
  count: number;
  closed_count?: number;
}
interface Hint {
  tone: string;
  text: string;
}
interface DashHelpers {
  getOpenCount: (row: ByResultRow | undefined) => number;
  computeOutcomeHint: (byResultMap: Map<string, ByResultRow>, total: number) => Hint | null;
  computeWorstRollup: (args: { outcomesState: unknown }) => string | null;
}

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
  const uiStub = {
    formatUsd: () => "",
    formatUsdCompact: () => "",
    formatInt: (n: number) => String(n),
    formatTokenCompact: () => "",
    formatPctWithDenominator: (n: number, d: number) => `${((n / d) * 100).toFixed(1)}% (${n}/${d})`,
    LOW_N_MIN,
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
  vm.runInContext(built.outputFiles[0].text, ctx);
  return ctx as unknown as DashHelpers;
}

const helpers = await loadDash();

function buildMap(rows: ByResultRow[]): Map<string, ByResultRow> {
  return new Map(rows.map((r) => [r.result, r]));
}
function buildRollupState(rows: ByResultRow[], total: number): { outcomesState: unknown } {
  return { outcomesState: { status: "ready", data: { total, by_result: rows } } };
}

// --- getOpenCount: the shared open-count derivation ---

test("getOpenCount subtracts closed_count and treats an absent field as zero closed", () => {
  assert.strictEqual(helpers.getOpenCount({ result: "done_with_concerns", count: 10, closed_count: 4 }), 6);
  assert.strictEqual(helpers.getOpenCount({ result: "done_with_concerns", count: 10 }), 10);
  assert.strictEqual(helpers.getOpenCount(undefined), 0);
});

test("getOpenCount clamps at zero when closed_count exceeds count", () => {
  assert.strictEqual(helpers.getOpenCount({ result: "done_with_concerns", count: 3, closed_count: 9 }), 0);
});

// --- AC2: the norm warning keys on OPEN done-with-concerns ---

test("AC2: 10 open DWC of 100 warns above the 7-day norm", () => {
  const hint = helpers.computeOutcomeHint(
    buildMap([{ result: "done", count: 90 }, { result: "done_with_concerns", count: 10, closed_count: 0 }]),
    100,
  );
  assert.strictEqual(hint?.tone, "warn");
  assert.match(hint?.text ?? "", /above the 7-day norm/);
});

test("AC2: 10 DWC of 100 ALL CLOSED no longer warns", () => {
  const hint = helpers.computeOutcomeHint(
    buildMap([{ result: "done", count: 90 }, { result: "done_with_concerns", count: 10, closed_count: 10 }]),
    100,
  );
  assert.strictEqual(hint, null);
});

test("AC2: mixed closure crosses the threshold on the open share only", () => {
  const below = helpers.computeOutcomeHint(
    buildMap([{ result: "done", count: 90 }, { result: "done_with_concerns", count: 10, closed_count: 6 }]),
    100,
  );
  assert.strictEqual(below, null, "4 open of 100 is under the 10% threshold");

  const above = helpers.computeOutcomeHint(
    buildMap([{ result: "done", count: 80 }, { result: "done_with_concerns", count: 20, closed_count: 5 }]),
    100,
  );
  assert.strictEqual(above?.tone, "warn", "15 open of 100 is over the threshold");
});

test("AC2: an absent closed_count stays backward-compatible (all open)", () => {
  const hint = helpers.computeOutcomeHint(
    buildMap([{ result: "done", count: 90 }, { result: "done_with_concerns", count: 10 }]),
    100,
  );
  assert.strictEqual(hint?.tone, "warn");
});

test("AC2: fail/blocked logic is untouched by closure", () => {
  const crit = helpers.computeOutcomeHint(
    buildMap([
      { result: "done", count: 94 },
      { result: "fail", count: 4, closed_count: 4 },
      { result: "blocked", count: 2, closed_count: 2 },
    ]),
    100,
  );
  assert.strictEqual(crit?.tone, "crit", "closure never de-escalates the breakage threshold");

  // Breakage outranks an open-DWC warn, as before.
  const both = helpers.computeOutcomeHint(
    buildMap([{ result: "done_with_concerns", count: 20 }, { result: "fail", count: 10 }]),
    100,
  );
  assert.strictEqual(both?.tone, "warn", "DWC is evaluated first — precedence unchanged");
});

// --- AC2: computeWorstRollup uses the same open-based rate ---

test("AC2: rollup warns on open DWC and clears once they are all closed", () => {
  assert.strictEqual(
    helpers.computeWorstRollup(buildRollupState(
      [{ result: "done", count: 90 }, { result: "done_with_concerns", count: 10, closed_count: 0 }],
      100,
    )),
    "warn",
  );
  assert.strictEqual(
    helpers.computeWorstRollup(buildRollupState(
      [{ result: "done", count: 90 }, { result: "done_with_concerns", count: 10, closed_count: 10 }],
      100,
    )),
    "ok",
  );
});

test("AC2: rollup breakage stays closure-blind and outranks DWC", () => {
  assert.strictEqual(
    helpers.computeWorstRollup(buildRollupState(
      [
        { result: "done", count: 84 },
        { result: "done_with_concerns", count: 10, closed_count: 10 },
        { result: "fail", count: 6, closed_count: 6 },
      ],
      100,
    )),
    "crit",
  );
});

test("rollup still skips low-n samples regardless of closure", () => {
  assert.strictEqual(
    helpers.computeWorstRollup(buildRollupState(
      [{ result: "done_with_concerns", count: 5, closed_count: 0 }],
      LOW_N_MIN - 1,
    )),
    "ok",
  );
});
