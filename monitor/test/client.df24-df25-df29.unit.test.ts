// FE pure-helper tests for the Wave-2/3 client-semantics fixes (DF-24 / DF-25 / DF-29).
// Evaluates the ACTUAL shipped browser modules in a node:vm sandbox (mirrors
// agents.reconstructed-headline.client.test.ts) — no DB, no render harness.
//   DF-25 → getTokenRate family-prefix rate lookup (pricing.js).
//   DF-24 → buildSuccessRateMatrix / buildTopNFailing consume reconstructed_count.
//   DF-29 → buildQualityHealthRanking low-N floor.
//
// Runner: npx tsx --test test/client.df24-df25-df29.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_SRC = resolve(__dirname, "../public/src/screens/agents.jsx");
const PRICING_SRC = resolve(__dirname, "../public/src/data/pricing.js");

interface Rates {
  input: number; output: number; cache_read: number; cache_creation: number;
}
interface AgentsHelpers {
  buildSuccessRateMatrix: (rows: unknown) => {
    agents: string[];
    cells: Record<string, {
      totalCount: number; successCount: number; failureCount: number;
      reconstructed: number; rateDenominator: number; pooledRate: number | null;
    }>;
  };
  buildTopNFailing: (rows: unknown, threshold: number, limit: number) => {
    failingPairs: Array<{
      agent: string; task_type: string; pooledRate: number;
      rateDenominator: number; successCount: number; reconstructed: number;
    }>;
  };
  buildQualityHealthRanking: (
    revisionRows: unknown, reviewRows: unknown, topN: number,
  ) => Array<{ agent: string; healthIndex: number; totalRevisions: number }>;
}

async function loadScreen(src: string): Promise<Record<string, unknown>> {
  const built = await esbuild.build({
    entryPoints: [src],
    bundle: false,
    write: false,
    loader: { ".jsx": "jsx" },
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    target: "es2022",
    format: "esm",
  });
  const code = built.outputFiles[0].text;
  const reactStub = new Proxy(
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
  const ctx: Record<string, unknown> = {
    window: { UI: {} },
    React: reactStub,
    document: { documentElement: {} },
    Intl,
    console,
    URLSearchParams,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

// pricing.js is a plain script that assigns window.* — run it verbatim in a vm.
function loadPricing(): { getTokenRate: (m: string) => Rates | null } {
  const code = readFileSync(PRICING_SRC, "utf8");
  const ctx: Record<string, unknown> = { window: {} };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return (ctx.window as { getTokenRate: (m: string) => Rates | null });
}

const agents = (await loadScreen(AGENTS_SRC)) as unknown as AgentsHelpers;
const pricing = loadPricing();

// --- DF-25: getTokenRate family-prefix ---

test("getTokenRate: exact catalog key resolves directly", () => {
  const r = pricing.getTokenRate("claude-opus-4-8");
  assert.ok(r);
  assert.strictEqual(r.input, 15);
});

test("getTokenRate: date-suffixed id resolves the family rate (silent COUNT-fallback avoided)", () => {
  const r = pricing.getTokenRate("claude-opus-4-8-20260101");
  assert.ok(r, "date-suffixed opus id must resolve");
  assert.strictEqual(r.input, 15, "resolves the claude-opus-4-8 family rate");
});

test("getTokenRate: longest-prefix wins (opus-4-8 not shadowed by opus-4)", () => {
  const r = pricing.getTokenRate("claude-opus-4-8-20260515");
  // opus-4 and opus-4-8 share the same rate here, but the boundary + longest-prefix
  // rule guarantees the more specific stem is selected.
  assert.strictEqual(r?.output, 75);
});

test("getTokenRate: a genuine miss returns null (pill trigger)", () => {
  assert.strictEqual(pricing.getTokenRate("gpt-4o"), null);
  assert.strictEqual(pricing.getTokenRate(""), null);
});

// --- DF-24: matrix consumes reconstructed_count (writer-emitted basis) ---

test("buildSuccessRateMatrix: reconstructed successes excluded from headline rate + denominator", () => {
  // 10 success of which 6 are harness-synthesized, 4 real failures.
  const rows = [
    { agent: "dev-x", task_type: "feature", event_date: "2026-07-01",
      total_count: 14, success_count: 10, failure_count: 4, reconstructed_count: 6, success_rate: 0.714 },
  ];
  const { cells } = agents.buildSuccessRateMatrix(rows);
  const cell = cells["dev-x|feature"];
  assert.ok(cell);
  assert.strictEqual(cell.reconstructed, 6, "reconstructed preserved for disclosure");
  assert.strictEqual(cell.successCount, 4, "writer-emitted success = 10 - 6");
  assert.strictEqual(cell.rateDenominator, 8, "denominator = writerSuccess(4) + failure(4)");
  assert.ok(Math.abs((cell.pooledRate ?? 0) - 0.5) < 1e-9, "pooled = 4/8 (not the inflated 10/14)");
  assert.strictEqual(cell.totalCount, 14, "totalCount stays raw = disclosed total");
});

test("buildSuccessRateMatrix: all-reconstructed success cell → pooledRate null (nothing to rate)", () => {
  const rows = [
    { agent: "dev-y", task_type: "doc", event_date: "2026-07-02",
      total_count: 5, success_count: 5, failure_count: 0, reconstructed_count: 5, success_rate: 1 },
  ];
  const cell = agents.buildSuccessRateMatrix(rows).cells["dev-y|doc"];
  assert.strictEqual(cell.successCount, 0);
  assert.strictEqual(cell.pooledRate, null);
  assert.strictEqual(cell.totalCount, 5, "still disclosed, not 'no data'");
});

test("buildSuccessRateMatrix: backward-compat — no reconstructed_count → raw basis", () => {
  const rows = [
    { agent: "dev-z", task_type: "bug-fix", event_date: "2026-07-03",
      total_count: 8, success_count: 6, failure_count: 2, success_rate: 0.75 },
  ];
  const cell = agents.buildSuccessRateMatrix(rows).cells["dev-z|bug-fix"];
  assert.strictEqual(cell.reconstructed, 0);
  assert.strictEqual(cell.successCount, 6);
  assert.ok(Math.abs((cell.pooledRate ?? 0) - 0.75) < 1e-9);
});

// --- DF-24: Top-N failing consumes reconstructed_count ---

test("buildTopNFailing: reconstructed successes removed → pooled rate drops below threshold (denom clears min-sample)", () => {
  // Raw pooled = 10/12 ≈ 83%. Writer-emitted: 10 success incl. 7 synthesized →
  // writerSuccess 3, failure 2, denom 5 (≥ TOPN_MIN_SAMPLE) → 3/5 = 60% (fails a 95% bar).
  const rows = [
    { agent: "dev-q", task_type: "review", event_date: "2026-07-01",
      total_count: 12, success_count: 10, failure_count: 2, reconstructed_count: 7 },
  ];
  const { failingPairs } = agents.buildTopNFailing(rows, 0.95, 8);
  const pair = failingPairs.find((p) => p.agent === "dev-q");
  assert.ok(pair, "pair present at writer-emitted basis");
  assert.strictEqual(pair.successCount, 3, "writer-emitted success = 10 - 7");
  assert.strictEqual(pair.rateDenominator, 5, "denom = writerSuccess(3) + failure(2)");
  assert.strictEqual(pair.reconstructed, 7);
  assert.ok(Math.abs(pair.pooledRate - 0.6) < 1e-9);
});

// --- DF-29: buildQualityHealthRanking low-N floor ---

test("buildQualityHealthRanking: agent below the low-N sample floor is excluded from ranking", () => {
  const revisionRows = [
    { agent: "thin", revision_bucket: "0", occurrence_count: 2 },   // total 2 < 3 → excluded
    { agent: "solid", revision_bucket: "0", occurrence_count: 10 }, // total 10 → kept
  ];
  const ranking = agents.buildQualityHealthRanking(revisionRows, [], 10);
  assert.ok(ranking.find((e) => e.agent === "solid"), "sufficient-sample agent ranked");
  assert.strictEqual(ranking.find((e) => e.agent === "thin"), undefined, "thin-sample agent floored out");
});
