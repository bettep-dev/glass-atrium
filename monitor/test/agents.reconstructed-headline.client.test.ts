// FE pure-helper tests for the writer-vs-reconstructed headline default (finding #34).
// Evaluates the ACTUAL shipped browser modules in a node:vm sandbox (mirrors
// outcomes.client.unit.test.ts) — no DB, no render harness. Proves that a
// synthesized-heavy agent's per-agent dashboard HEADLINE shows the writer-emitted
// count (not the inflated total), with the reconstructed sub-count preserved for
// the artifact sub-line.
//
// Runner: npx tsx --test test/agents.reconstructed-headline.client.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_SRC = resolve(__dirname, "../public/src/screens/agents.jsx");
const OUTCOMES_SRC = resolve(__dirname, "../public/src/screens/outcomes.jsx");

interface AgentsHelpers {
  buildReviewFlagMap: (rows: unknown) => Map<string, {
    total: number; flagged: number; rawFlagged: number; reconstructed: number; ratio: number;
  }>;
  buildQualityHealthRanking: (
    revisionRows: unknown,
    reviewRows: unknown,
    topN: number,
  ) => Array<{ agent: string; healthIndex: number; reviewFlagRatio: number; reviewFlaggedReconstructed: number; reviewFlaggedWriter: number }>;
}
interface OutcomesHelpers {
  buildAgentStackO: (
    byAgentResult: unknown[],
    resultOrder: string[],
    topN: number,
  ) => Array<{ agent: string; total: number; reconstructed: number; byResult: Record<string, number> }>;
}

async function loadScreen(src: string, extraCtx: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    URLSearchParams,
    ...extraCtx,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

const agents = (await loadScreen(AGENTS_SRC)) as unknown as AgentsHelpers;
const outcomes = (await loadScreen(OUTCOMES_SRC)) as unknown as OutcomesHelpers;

test("helpers reachable as top-level function declarations", () => {
  assert.strictEqual(typeof agents.buildReviewFlagMap, "function");
  assert.strictEqual(typeof agents.buildQualityHealthRanking, "function");
  assert.strictEqual(typeof outcomes.buildAgentStackO, "function");
});

// --- buildReviewFlagMap: flagged headline defaults to writer-emitted ---

test("buildReviewFlagMap: synthesized-heavy agent → flagged defaults to writer-emitted, reconstructed preserved", () => {
  // qa-code-reviewer: 27 flagged, 25 of them harness-synthesized (≈93% recording artifact).
  const map = agents.buildReviewFlagMap([
    { agent: "qa-code-reviewer", total_count: 30, review_flagged_count: 27, reconstructed_count: 25 },
  ]);
  const entry = map.get("qa-code-reviewer");
  assert.ok(entry, "agent entry present");
  assert.strictEqual(entry.rawFlagged, 27, "rawFlagged keeps the inflated count for the sub-line");
  assert.strictEqual(entry.reconstructed, 25, "reconstructed sub-count preserved");
  assert.strictEqual(entry.flagged, 2, "headline flagged defaults to writer-emitted (27 - 25), NOT the inflated 27");
  // ratio uses writer-emitted flagged over total.
  assert.ok(Math.abs(entry.ratio - 2 / 30) < 1e-9, "review_flag ratio is writer-emitted based");
});

test("buildReviewFlagMap: backward-compat — no reconstructed_count field → writer-emitted == raw", () => {
  const map = agents.buildReviewFlagMap([
    { agent: "dev-nestjs", total_count: 20, review_flagged_count: 6 },
  ]);
  const entry = map.get("dev-nestjs");
  assert.ok(entry);
  assert.strictEqual(entry.reconstructed, 0);
  assert.strictEqual(entry.flagged, 6, "genuine DEV flags unaffected by the split");
});

test("buildReviewFlagMap: reconstructed > flagged is clamped (writer-emitted never negative)", () => {
  const map = agents.buildReviewFlagMap([
    { agent: "intel-planner", total_count: 10, review_flagged_count: 4, reconstructed_count: 99 },
  ]);
  const entry = map.get("intel-planner");
  assert.ok(entry);
  assert.strictEqual(entry.reconstructed, 4, "clamped to the flagged headline");
  assert.strictEqual(entry.flagged, 0);
  assert.ok(entry.ratio >= 0);
});

// --- end-to-end: the Health Index headline reflects writer-emitted flags ---

test("buildQualityHealthRanking: synthesized-heavy agent's health headline uses writer-emitted flags (not the inflated regression)", () => {
  // Zero reworks (all revision bucket '0') isolates the review_flag component:
  //   health = 1 - 0.4 × reviewFlagRatio.
  const revisionRows = [{ agent: "qa-code-reviewer", revision_bucket: "0", occurrence_count: 10 }];
  // 27 flagged, 25 synthesized → writer-emitted ratio 2/30 ≈ 0.067 (healthy),
  // vs the inflated raw ratio 27/30 = 0.9 (looks like a severe regression).
  const reviewRows = [
    { agent: "qa-code-reviewer", total_count: 30, review_flagged_count: 27, reconstructed_count: 25 },
  ];
  const ranking = JSON.parse(JSON.stringify(
    agents.buildQualityHealthRanking(revisionRows, reviewRows, 10),
  )) as AgentsHelpers extends never ? never : Array<{ agent: string; healthIndex: number; reviewFlaggedReconstructed: number }>;
  const entry = ranking.find((e) => e.agent === "qa-code-reviewer");
  assert.ok(entry, "agent ranked");
  // Writer-emitted health ≈ 1 - 0.4 × (2/30) ≈ 0.973 — NOT the inflated ≈ 0.64.
  assert.ok(entry.healthIndex > 0.9, `writer-emitted health index is healthy (got ${entry.healthIndex})`);
  assert.ok(entry.healthIndex < 1);
  // Reconstructed count carried to the row for the artifact sub-line.
  assert.strictEqual(entry.reviewFlaggedReconstructed, 25);
});

// --- buildAgentStackO: by_agent_result single-query accumulation (P14) ---

test("buildAgentStackO: sums count + reconstructed across an agent's results (writer-emitted headline base)", () => {
  // Single combined by_agent_result array — one (agent, result) row each; total + reconstructed sum.
  const byAgentResult = [
    { agent: "qa-code-reviewer", result: "done", count: 5, reconstructed_count: 1 },
    { agent: "qa-code-reviewer", result: "done_with_concerns", count: 20, reconstructed_count: 18 },
  ];
  const stack = outcomes.buildAgentStackO(byAgentResult, ["done", "done_with_concerns"], 10);
  const row = stack.find((r) => r.agent === "qa-code-reviewer");
  assert.ok(row);
  assert.strictEqual(row.total, 25, "total sums all in-order results (bar distribution base)");
  assert.strictEqual(row.reconstructed, 19, "reconstructed sums per-result reconstructed_count");
  assert.strictEqual(row.byResult.done, 5);
  assert.strictEqual(row.byResult.done_with_concerns, 20);
  // writer-emitted headline = total - reconstructed = 6 (the non-inflated count).
  assert.strictEqual(row.total - row.reconstructed, 6);
});

test("buildAgentStackO: backward-compat — rows without reconstructed_count → reconstructed 0", () => {
  const byAgentResult = [{ agent: "dev-nestjs", result: "done", count: 8 }];
  const stack = outcomes.buildAgentStackO(byAgentResult, ["done"], 10);
  const row = stack.find((r) => r.agent === "dev-nestjs");
  assert.ok(row);
  assert.strictEqual(row.reconstructed, 0);
  assert.strictEqual(row.total, 8);
});

test("buildAgentStackO: results outside resultOrder are excluded from total (bar sums to 100%)", () => {
  // needs_context is a valid result but outside the 4-KPI stack order — must not inflate total.
  const byAgentResult = [
    { agent: "dev-python", result: "done", count: 10, reconstructed_count: 0 },
    { agent: "dev-python", result: "needs_context", count: 4, reconstructed_count: 0 },
  ];
  const stack = outcomes.buildAgentStackO(byAgentResult, ["done", "done_with_concerns", "blocked", "fail"], 10);
  const row = stack.find((r) => r.agent === "dev-python");
  assert.ok(row);
  assert.strictEqual(row.total, 10, "needs_context excluded from total");
  assert.strictEqual(row.byResult.needs_context, undefined, "off-order result not stacked");
});
