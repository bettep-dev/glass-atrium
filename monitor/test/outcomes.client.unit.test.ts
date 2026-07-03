// Unit tests for the T13/T14 client-side pure helpers extracted into the browser
// screen modules:
//   - public/src/screens/outcomes.jsx — buildAgentFacetOptionsO (T13 registry-sourced
//     facet), extractCanonicalAgentIdsO (T13 /summary → agent-id list),
//     setIncludeAllParamO + buildSearchUrlO (T7/O2 include_all param), and
//     isNonActionableAgentO (T14 double-filter guard).
//   - public/src/screens/agents.jsx — isNonActionableAgentAg (T14 mirror guard).
//
// Runner: npx tsx --test test/outcomes.client.unit.test.ts
//
// Both screens are browser-global modules (top-level `const { useState } = React`,
// JSX, `window.Screen* =` export) with NO import/export — esbuild (bundle:false)
// emits them as plain scripts whose top-level `function` declarations land on the
// node:vm context global. The test evaluates the ACTUAL shipped source in a sandbox
// with minimal React/window/URLSearchParams stubs and exercises the real helpers —
// not a drift-prone copy. NO render harness / component / interaction assertions
// (the monitor has no jsdom/testing-library; see the plan Task Decomposition preamble).

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTCOMES_SRC = resolve(__dirname, "../public/src/screens/outcomes.jsx");
const AGENTS_SRC = resolve(__dirname, "../public/src/screens/agents.jsx");

interface OutcomesHelpers {
  buildAgentFacetOptionsO: (canonicalKeys: unknown) => string[];
  extractCanonicalAgentIdsO: (summaryData: unknown) => string[];
  setIncludeAllParamO: (params: URLSearchParams, includeAll: boolean) => URLSearchParams;
  buildSearchUrlO: (
    filter: { days: number | string },
    sort: string,
    page: number,
    limit: number,
    includeAll?: boolean,
  ) => string;
  isNonActionableAgentO: (agentId: string, visualSet?: Set<string>) => boolean;
  buildLiteralOmissionBreakdownO: (
    breakdown: unknown,
  ) => { budget: number; truncated: number; missing: number } | null;
}
interface AgentsHelpers {
  isNonActionableAgentAg: (agentId: string, visualSet?: Set<string>) => boolean;
}

// esbuild-transform + evaluate a browser screen module in a vm sandbox, returning
// its top-level `function` declarations (now context-global properties). `extraCtx`
// augments the base stub (e.g. URLSearchParams for the outcomes URL builders, or a
// non-empty window.UI for the agents module's top-level window.UI.STICKY_TH_STYLE read).
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
    // plain script (no import/export) → top-level fn decls become context globals.
    format: "esm",
  });
  const code = built.outputFiles[0].text;

  // React stub — every accessed prop returns a benign default; only the (uninvoked)
  // component bodies touch React, so the stubs never actually drive a render.
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
    window: {},
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

const outcomes = (await loadScreen(OUTCOMES_SRC)) as unknown as OutcomesHelpers;
// agents.jsx reads `window.UI.STICKY_TH_STYLE` at module top level → provide a
// non-empty UI object so the eval does not throw (the value itself is unused here).
const agents = (await loadScreen(AGENTS_SRC, { window: { UI: {} } })) as unknown as AgentsHelpers;

// Helper return arrays originate in the vm realm; re-materialize into this realm
// before deep-equality (cross-realm prototype mismatch otherwise).
const sameRealm = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

// A representative canonical registry key set (what /api/agents/summary → agent_id
// yields once the server is registry-gated). No sentinels / de-registered tokens.
const CANONICAL_KEYS = ["dev-react", "dev-nestjs", "intel-planner", "qa-code-reviewer", "orchestrator"];
// Non-registry noise that must NEVER be produced by the registry-sourced facet.
const NOISE_KEYS = ["unknown", "subagent_stop_missing", "general-purpose", "design-audio-engineer"];

test("helpers are reachable as top-level function declarations", () => {
  assert.strictEqual(typeof outcomes.buildAgentFacetOptionsO, "function");
  assert.strictEqual(typeof outcomes.extractCanonicalAgentIdsO, "function");
  assert.strictEqual(typeof outcomes.setIncludeAllParamO, "function");
  assert.strictEqual(typeof outcomes.buildSearchUrlO, "function");
  assert.strictEqual(typeof outcomes.isNonActionableAgentO, "function");
  assert.strictEqual(typeof outcomes.buildLiteralOmissionBreakdownO, "function");
  assert.strictEqual(typeof agents.isNonActionableAgentAg, "function");
});

// --- budget-truncation visibility: literal_omission_breakdown sub-line helper ---

test("buildLiteralOmissionBreakdownO: parses the 3 integer sub-counts (budget/truncated/missing)", () => {
  const out = sameRealm(
    outcomes.buildLiteralOmissionBreakdownO({
      budget_truncation: 3,
      truncated_completion: 1,
      completion_missing: 5,
    }),
  );
  assert.deepStrictEqual(out, { budget: 3, truncated: 1, missing: 5 });
});

test("buildLiteralOmissionBreakdownO: absent / all-zero / malformed → null (no fabricated sub-line)", () => {
  assert.strictEqual(outcomes.buildLiteralOmissionBreakdownO(null), null);
  assert.strictEqual(outcomes.buildLiteralOmissionBreakdownO(undefined), null);
  assert.strictEqual(outcomes.buildLiteralOmissionBreakdownO("nope"), null);
  assert.strictEqual(
    outcomes.buildLiteralOmissionBreakdownO({ budget_truncation: 0, truncated_completion: 0, completion_missing: 0 }),
    null,
  );
  // partial / non-numeric fields coerce to 0, non-empty total still yields a value.
  assert.deepStrictEqual(
    sameRealm(outcomes.buildLiteralOmissionBreakdownO({ budget_truncation: 2 })),
    { budget: 2, truncated: 0, missing: 0 },
  );
});

// --- attribution_source exact-match filter reaches the search request (pinned contract) ---

test("buildSearchUrlO: attribution_source is sent as an exact-match query param when set", () => {
  const url = outcomes.buildSearchUrlO(
    { days: 30, attribution_source: "budget-truncation" },
    "record_ts:desc",
    0,
    50,
    false,
  );
  assert.ok(url.includes("attribution_source=budget-truncation"), "attribution_source filter carried to /api/outcomes/search");
});

test("buildSearchUrlO: attribution_source omitted when unset (default view)", () => {
  const url = outcomes.buildSearchUrlO({ days: 30, attribution_source: "" }, "record_ts:desc", 0, 50, false);
  assert.ok(!url.includes("attribution_source"), "empty attribution_source → param omitted");
});

// --- T13 (a): facet option list sourced from the registry, not page rows ---

test("buildAgentFacetOptionsO: returns the canonical keys sorted + deduped (registry-sourced)", () => {
  const opts = sameRealm(outcomes.buildAgentFacetOptionsO([...CANONICAL_KEYS, "dev-react"]));
  assert.deepStrictEqual(opts, [...CANONICAL_KEYS].sort());
  // dedupe: the duplicated dev-react appears once.
  assert.strictEqual(opts.filter((o) => o === "dev-react").length, 1);
});

test("buildAgentFacetOptionsO: never derives from page rows — only the passed registry keys appear", () => {
  // Even if noise agents exist on a page, the facet builder takes registry keys ONLY;
  // passing the registry set yields no noise (the caller feeds /summary agent_ids).
  const opts = sameRealm(outcomes.buildAgentFacetOptionsO(CANONICAL_KEYS));
  for (const noise of NOISE_KEYS) assert.ok(!opts.includes(noise), `facet excludes noise '${noise}'`);
  for (const canon of CANONICAL_KEYS) assert.ok(opts.includes(canon), `facet includes canonical '${canon}'`);
});

test("buildAgentFacetOptionsO: empty / non-array / dirty input → clean [] or filtered", () => {
  assert.deepStrictEqual(sameRealm(outcomes.buildAgentFacetOptionsO([])), []);
  assert.deepStrictEqual(sameRealm(outcomes.buildAgentFacetOptionsO(null)), []);
  assert.deepStrictEqual(sameRealm(outcomes.buildAgentFacetOptionsO(undefined)), []);
  assert.deepStrictEqual(sameRealm(outcomes.buildAgentFacetOptionsO("dev-react")), []);
  // empty-string / non-string members are dropped.
  assert.deepStrictEqual(
    sameRealm(outcomes.buildAgentFacetOptionsO(["dev-react", "", null, 7, "dev-node"])),
    ["dev-node", "dev-react"],
  );
});

test("extractCanonicalAgentIdsO: pulls agent_id from a /api/agents/summary response shape", () => {
  const summary = {
    agents: [
      { agent_id: "dev-react", runs: 12 },
      { agent_id: "intel-planner", runs: 3 },
      { agent_id: "", runs: 1 }, // empty id dropped
      { runs: 4 }, // missing id dropped
      { agent_id: 42 }, // non-string dropped
    ],
  };
  assert.deepStrictEqual(sameRealm(outcomes.extractCanonicalAgentIdsO(summary)), ["dev-react", "intel-planner"]);
});

test("extractCanonicalAgentIdsO: absent / malformed response → [] (facet degrades to 'All' only)", () => {
  assert.deepStrictEqual(sameRealm(outcomes.extractCanonicalAgentIdsO(null)), []);
  assert.deepStrictEqual(sameRealm(outcomes.extractCanonicalAgentIdsO({})), []);
  assert.deepStrictEqual(sameRealm(outcomes.extractCanonicalAgentIdsO({ agents: "nope" })), []);
});

test("extract → build pipeline yields the registry facet (integration of the two pure helpers)", () => {
  const summary = { agents: CANONICAL_KEYS.map((k) => ({ agent_id: k })) };
  const keys = outcomes.extractCanonicalAgentIdsO(summary);
  const opts = sameRealm(outcomes.buildAgentFacetOptionsO(keys));
  assert.deepStrictEqual(opts, [...CANONICAL_KEYS].sort());
});

// --- T13 (b) / T7: include_all param builder emits the param iff the toggle is on ---

test("setIncludeAllParamO: sets include_all=1 iff includeAll is truthy", () => {
  assert.strictEqual(outcomes.setIncludeAllParamO(new URLSearchParams(), true).get("include_all"), "1");
  assert.strictEqual(outcomes.setIncludeAllParamO(new URLSearchParams(), false).get("include_all"), null);
});

test("setIncludeAllParamO: idempotent — re-applying with the same state does not duplicate", () => {
  const params = new URLSearchParams();
  outcomes.setIncludeAllParamO(params, true);
  outcomes.setIncludeAllParamO(params, true);
  assert.deepStrictEqual(params.getAll("include_all"), ["1"]);
});

test("buildSearchUrlO: include_all present only when the toggle is on (T7 contract)", () => {
  const filter = { days: 30 };
  const on = outcomes.buildSearchUrlO(filter, "record_ts:desc", 0, 50, true);
  const off = outcomes.buildSearchUrlO(filter, "record_ts:desc", 0, 50, false);
  const omitted = outcomes.buildSearchUrlO(filter, "record_ts:desc", 0, 50);
  assert.ok(on.includes("include_all=1"), "toggle on → include_all=1 present");
  assert.ok(!off.includes("include_all"), "toggle off → include_all omitted");
  assert.ok(!omitted.includes("include_all"), "arg omitted → include_all omitted (default-gated view)");
});

test("buildSearchUrlO: carries the base pagination + sort params regardless of the toggle", () => {
  const url = outcomes.buildSearchUrlO({ days: 90 }, "revision_count:desc", 2, 50, true);
  assert.ok(url.startsWith("/api/outcomes/search?"));
  assert.ok(url.includes("days=90"));
  assert.ok(url.includes("limit=50"));
  assert.ok(url.includes("offset=100"), "page 2 × limit 50 → offset 100");
  assert.ok(url.includes("sort=revision_count%3Adesc"));
});

// --- T14: double-filter guard — canonical agents never hidden; sentinels still flagged ---

test("isNonActionableAgentO: every canonical agent → false (no residual client double-filter)", () => {
  for (const canon of CANONICAL_KEYS) {
    assert.strictEqual(outcomes.isNonActionableAgentO(canon), false, `canonical '${canon}' not hidden`);
  }
});

test("isNonActionableAgentO: a legitimately-appearing sentinel is still flagged (forensic view)", () => {
  assert.strictEqual(outcomes.isNonActionableAgentO("subagent_stop_missing"), true);
  assert.strictEqual(outcomes.isNonActionableAgentO("unknown"), true);
});

test("isNonActionableAgentO: honors a caller-supplied visual set", () => {
  const empty = new Set<string>();
  assert.strictEqual(outcomes.isNonActionableAgentO("subagent_stop_missing", empty), false);
  const custom = new Set(["cron:daily"]);
  assert.strictEqual(outcomes.isNonActionableAgentO("cron:daily", custom), true);
});

test("isNonActionableAgentAg (agents.jsx mirror): same verdicts as the outcomes guard", () => {
  for (const canon of CANONICAL_KEYS) {
    assert.strictEqual(agents.isNonActionableAgentAg(canon), false, `canonical '${canon}' not hidden`);
  }
  assert.strictEqual(agents.isNonActionableAgentAg("subagent_stop_missing"), true);
  assert.strictEqual(agents.isNonActionableAgentAg("unknown"), true);
});
