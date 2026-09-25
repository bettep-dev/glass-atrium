// Unit tests for the client-side pure logic in public/src/screens/model-config.jsx
// (validateFormMC / diffFormMC / modelOptionsMC / buildFormMC / sortDomainsMC /
// sortBudgetsMC). The server PUT contract is covered by model-config.route.test.ts;
// this brings the BROWSER half under regression coverage — a drift in the client
// mirror constants (BUDGET_RE_MC / bounds / free-text regex) or a regression in
// the partial-PUT payload builder would otherwise ship undetected. The known-model
// roster is NO LONGER a client mirror constant — options are API-driven from the
// GET `known_models` list (server derives it from the pricing SoT, P6/P7), so the
// option tests inject a fixture roster and assert options derive from it.
//
// Runner: npx tsx --test test/model-config.client.unit.test.ts
//
// model-config.jsx is a browser global module (top-level `const { useState } = React`,
// JSX, `window.ScreenModelConfig =` export) with NO import/export — so esbuild emits
// it as a plain script whose top-level `function` declarations land on the vm context
// global. The test evaluates the ACTUAL shipped source in a node:vm sandbox with minimal
// React/window stubs, then exercises the real helpers — not a drift-prone copy. It also
// cross-verifies the surviving client constant mirrors against the server SoT
// (model-config-consts: free-text regex + budget regex/bounds).

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

import { buildUiSandbox } from "./client-sandbox.js";

import {
  FREE_TEXT_MODEL_PATTERN,
  BUDGET_VALUE_PATTERN,
  BUDGET_MIN_USD,
  BUDGET_MAX_USD,
  BUDGET_SEED_DEFAULT_USD,
  MODEL_DOMAINS,
} from "../src/server/model-config-consts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MC_SRC = resolve(__dirname, "../public/src/screens/model-config.jsx");

interface McForm {
  models: Record<string, string>;
  budgets: Record<string, string>;
}
interface McHelpers {
  validateFormMC: (form: McForm, knownModels: string[]) => Record<string, string>;
  diffFormMC: (baseline: McForm, form: McForm) => unknown;
  modelOptionsMC: (domain: string, knownModels: string[]) => string[];
  buildFormMC: (data: unknown) => McForm;
  sortDomainsMC: (domains: { domain: string }[]) => { domain: string }[];
  sortBudgetsMC: (budgets: { domain: string }[]) => { domain: string }[];
  budgetPlaceholderMC: () => string;
}

// Module-level `const` declarations (the client constant mirror) stay lexically
// scoped inside the evaluated script — they never become vm-context-global
// properties, so they cannot be read directly. The surviving mirrors are instead
// verified BEHAVIORALLY: the helper that closes over them (validateFormMC —
// free-text regex + budget regex/bounds) is cross-checked against the server SoT
// validators below.

// Transpile once — both sandboxes (helper + render) evaluate the same emitted script.
let mcCodeCache: string | null = null;
async function buildMcCode(): Promise<string> {
  if (mcCodeCache !== null) return mcCodeCache;
  const built = await esbuild.build({
    entryPoints: [MC_SRC],
    bundle: false,
    write: false,
    loader: { ".jsx": "jsx" },
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    target: "es2022",
    // esm/plain script (the module has no import/export) → top-level fn decls
    // become context-global properties, reachable for direct unit assertions.
    format: "esm",
  });
  const output = built.outputFiles[0];
  assert.ok(output, "esbuild emitted output for model-config.jsx");
  mcCodeCache = output.text;
  return mcCodeCache;
}

// Evaluate in a sandbox — the real top-level helper declarations.
async function loadMc(): Promise<McHelpers> {
  const code = await buildMcCode();

  // React stub — every hook returns a benign default; only the (uninvoked)
  // component bodies touch React, so the stubs never actually drive a render.
  const reactStub = new Proxy(
    {
      createElement: () => ({}),
      Fragment: "frag",
      useState: () => [undefined, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
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
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);

  const h = ctx as unknown as McHelpers;
  assert.strictEqual(typeof h.validateFormMC, "function", "validateFormMC must be reachable");
  assert.strictEqual(typeof h.diffFormMC, "function");
  assert.strictEqual(typeof h.modelOptionsMC, "function");
  assert.strictEqual(typeof h.budgetPlaceholderMC, "function");
  return h;
}

const mc = await loadMc();
// Helper return values originate in the vm realm; re-materialize arrays/objects
// into this realm before deep-equality (cross-realm prototype mismatch otherwise).
const sameRealm = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

// GET known_models fixture — the server derives the real list from the pricing SoT
// `models` keys (P6); the client consumes whatever the API returns VERBATIM, so an
// arbitrary roster proves the options are API-driven, not a baked-in mirror.
const KNOWN_MODELS_FIXTURE = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
];

// --- surviving constant-mirror drift guard (BEHAVIORAL) ---
// The client mirror consts (FREE_TEXT_MODEL_RE_MC / BUDGET_RE_MC / bounds) are
// top-level `const` declarations → lexically scoped inside the evaluated module, so
// they are NOT reachable as vm-context globals (unlike the `function` helpers). The
// drift guard therefore exercises validateFormMC (which closes over them) and
// cross-checks the observable behavior against the server SoT.

test("client model-format regex mirror matches server FREE_TEXT_MODEL_PATTERN (via validateFormMC)", () => {
  // The client validate path uses FREE_TEXT_MODEL_RE_MC for free-text ids; assert the client
  // verdict agrees with the server FREE_TEXT_MODEL_PATTERN on a discriminating sample set.
  // (None of the samples sits in the injected roster → the free-text branch decides.)
  const cases = ["claude-fable-5[1m]", "valid-custom.id", "Bad-Upper", "white space", "ok123"];
  for (const value of cases) {
    const clientErr = !!sameRealm(
      mc.validateFormMC({ models: { "model.dev": value }, budgets: {} }, KNOWN_MODELS_FIXTURE),
    )["model.dev"];
    const serverOk = FREE_TEXT_MODEL_PATTERN.test(value);
    assert.strictEqual(clientErr, !serverOk, `client/server agree on '${value}'`);
  }
});

test("client budget regex + bound mirrors match server SoT (via validateFormMC)", () => {
  const key = "budget.worker_max_usd";
  // regex: exactly-2-decimal contract.
  for (const value of ["0.50", "12.34", "0.5", "1", "0.500", "abc"]) {
    const clientErr = !!sameRealm(mc.validateFormMC({ models: {}, budgets: { [key]: value } }, []))[
      key
    ];
    assert.strictEqual(clientErr, !BUDGET_VALUE_PATTERN.test(value), `regex verdict for '${value}'`);
  }
  // bounds: client floor/ceiling must equal the server BUDGET_MIN_USD / BUDGET_MAX_USD.
  const floorStr = BUDGET_MIN_USD.toFixed(2);
  const ceilStr = BUDGET_MAX_USD.toFixed(2);
  const belowFloor = (BUDGET_MIN_USD - 0.01).toFixed(2);
  const aboveCeil = (BUDGET_MAX_USD + 0.01).toFixed(2);
  const errAt = (v: string): boolean =>
    !!sameRealm(mc.validateFormMC({ models: {}, budgets: { [key]: v } }, []))[key];
  assert.ok(!errAt(floorStr), `client floor ${floorStr} accepted (matches BUDGET_MIN_USD)`);
  assert.ok(!errAt(ceilStr), `client ceiling ${ceilStr} accepted (matches BUDGET_MAX_USD)`);
  assert.ok(errAt(belowFloor), `client rejects below floor ${belowFloor}`);
  assert.ok(errAt(aboveCeil), `client rejects above ceiling ${aboveCeil}`);
});

test("budget input placeholder advertises the shipped default cap, not a stale literal", () => {
  // The placeholder is what an operator who never touched the field reads as the value in force.
  // It shipped as '0.50' while both seeds (the DB rows and hooks/daemon_config.py _FALLBACK) put
  // the real cap at BUDGET_SEED_DEFAULT_USD — a 20x understatement of the authorized spend.
  // budgetPlaceholderMC is the reachable seam over the client mirror const (module-level `const`
  // declarations stay lexically scoped in the sandbox, `function` declarations do not).
  assert.strictEqual(mc.budgetPlaceholderMC(), BUDGET_SEED_DEFAULT_USD);
  // And the advertised default must itself be a value the validators accept, or the placeholder
  // would name a cap that cannot be typed in.
  assert.ok(BUDGET_VALUE_PATTERN.test(BUDGET_SEED_DEFAULT_USD), "2-decimal string form");
  const parsed = Number.parseFloat(BUDGET_SEED_DEFAULT_USD);
  assert.ok(parsed >= BUDGET_MIN_USD && parsed <= BUDGET_MAX_USD, "inside the accepted band");
});

// Inherit roster SoT — DOMAIN_META_MC[*].inherit in the shipped model-config.jsx.
// The literal table is the independent oracle the scraped roster is compared against.
const INHERIT_ROSTER_MC: Readonly<Record<string, boolean>> = {
  "model.dev": true,
  "model.research": true,
  "model.meta": true,
  "model.wiki": true,
  "model.review": true,
  "model.docs": true,
  "model.daemon_cycle_worker": false,
};

function getInheritRosterOrFailMc(): Record<string, boolean> {
  const src = readFileSync(MC_SRC, "utf8");
  const block = /const DOMAIN_META_MC = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, "DOMAIN_META_MC declaration located in model-config.jsx");
  const roster: Record<string, boolean> = {};
  for (const [, domain, body] of block[1].matchAll(/"(model\.[a-z_]+)":\s*\{([^}]*)\}/g)) {
    roster[domain] = /\binherit:\s*true\b/.test(body);
  }
  return roster;
}

// --- modelOptionsMC: API-driven option assembly per domain (P7 AC: exactly the GET
// known_models + inherit where the domain allows; no bare alias option) ---

test("modelOptionsMC: unknown domain (fallback meta) lists exactly the injected known_models (no inherit)", () => {
  const opts = sameRealm(mc.modelOptionsMC("model.future_unknown", KNOWN_MODELS_FIXTURE));
  assert.deepStrictEqual(opts, KNOWN_MODELS_FIXTURE);
});

test("modelOptionsMC: the inherit roster decides the inherit option, domain by domain", () => {
  // Data-driven over the whole roster, not a hand-written case per domain.
  // A domain added to DOMAIN_META_MC is therefore covered the moment it ships.
  // Self-reference guard — a scraped expectation would shrink with the roster and pass vacuously.
  const roster = getInheritRosterOrFailMc();
  assert.deepStrictEqual(roster, INHERIT_ROSTER_MC, "shipped DOMAIN_META_MC inherit flags");
  for (const [domain, inherits] of Object.entries(INHERIT_ROSTER_MC)) {
    const opts = sameRealm(mc.modelOptionsMC(domain, KNOWN_MODELS_FIXTURE));
    assert.deepStrictEqual(
      opts,
      inherits ? ["inherit", ...KNOWN_MODELS_FIXTURE] : KNOWN_MODELS_FIXTURE,
      `${domain}: ${inherits ? "inherit + " : ""}known_models verbatim`,
    );
    assert.strictEqual(opts.includes("inherit"), inherits, `${domain}: inherit option offered?`);
    for (const alias of ["opus", "sonnet", "haiku"]) {
      assert.ok(!opts.includes(alias), `${domain} has no bare alias '${alias}'`);
    }
  }
});

test("modelOptionsMC: options track the injected roster, not a baked-in mirror", () => {
  const altRoster = ["some-brand-new-model", "another-id"];
  const opts = sameRealm(mc.modelOptionsMC("model.daemon_cycle_worker", altRoster));
  assert.deepStrictEqual(opts, altRoster, "a different roster yields different options");
});

test("modelOptionsMC: empty known_models (SoT fail-open, D3) → inherit-only where allowed", () => {
  assert.deepStrictEqual(sameRealm(mc.modelOptionsMC("model.dev", [])), ["inherit"]);
  assert.deepStrictEqual(sameRealm(mc.modelOptionsMC("model.daemon_cycle_worker", [])), []);
});

// --- validateFormMC: client mirror of the server PUT contract ---
// NOTE: no client-side bare-alias reject mirror — the server is the validation
// authority for the alias 400 (plan Non-Goals); covered by model-config.route.test.ts.

test("validateFormMC: a valid known id + valid 2-decimal budget → no errors", () => {
  const errors = sameRealm(
    mc.validateFormMC(
      {
        models: { "model.dev": "claude-opus-4-8" },
        budgets: { "budget.worker_max_usd": "0.50" },
      },
      KNOWN_MODELS_FIXTURE,
    ),
  );
  assert.deepStrictEqual(errors, {});
});

test("validateFormMC: empty model value → 'Enter a model id'", () => {
  const errors = sameRealm(
    mc.validateFormMC({ models: { "model.dev": "" }, budgets: {} }, KNOWN_MODELS_FIXTURE),
  );
  assert.ok(errors["model.dev"], "empty model flagged");
});

test("validateFormMC: uppercase free-text model → format error (mirrors FREE_TEXT regex)", () => {
  const errors = sameRealm(
    mc.validateFormMC({ models: { "model.dev": "Claude-Custom" }, budgets: {} }, KNOWN_MODELS_FIXTURE),
  );
  assert.ok(errors["model.dev"], "uppercase rejected by client regex");
  // server agrees (drift guard): the same value fails the server pattern too.
  assert.ok(!FREE_TEXT_MODEL_PATTERN.test("Claude-Custom"));
});

test("validateFormMC: budget without exactly 2 decimals → error", () => {
  for (const bad of ["0.5", "1", "0.500", "1.2.3", "abc"]) {
    const errors = sameRealm(
      mc.validateFormMC({ models: {}, budgets: { "budget.worker_max_usd": bad } }, []),
    );
    assert.ok(errors["budget.worker_max_usd"], `'${bad}' rejected`);
    assert.ok(!BUDGET_VALUE_PATTERN.test(bad), `server pattern also rejects '${bad}'`);
  }
});

test("validateFormMC: budget out of [0.05, 50.00] bounds → error; in-bounds → ok", () => {
  const below = sameRealm(
    mc.validateFormMC({ models: {}, budgets: { "budget.worker_max_usd": "0.04" } }, []),
  );
  assert.ok(below["budget.worker_max_usd"], "below floor flagged");
  const above = sameRealm(
    mc.validateFormMC({ models: {}, budgets: { "budget.worker_max_usd": "50.01" } }, []),
  );
  assert.ok(above["budget.worker_max_usd"], "above ceiling flagged");
  const edge = sameRealm(
    mc.validateFormMC(
      {
        models: {},
        budgets: { "budget.worker_max_usd": "0.05", "budget.pre_verify_max_usd": "50.00" },
      },
      [],
    ),
  );
  assert.deepStrictEqual(edge, {}, "exact bounds accepted");
});

// --- diffFormMC: partial-PUT payload builder (only changed fields, null when none) ---

test("diffFormMC: no change → null (clean state — save-banner hidden, Save dormant not error-disabled)", () => {
  const baseline = { models: { "model.dev": "claude-opus-4-8" }, budgets: { "budget.worker_max_usd": "0.50" } };
  const result = mc.diffFormMC(baseline, { models: { ...baseline.models }, budgets: { ...baseline.budgets } });
  assert.strictEqual(result, null);
});

test("diffFormMC: only the changed model field is sent (partial contract)", () => {
  const baseline = { models: { "model.dev": "claude-opus-4-8", "model.research": "claude-sonnet-4-6" }, budgets: {} };
  const form = { models: { "model.dev": "claude-fable-5", "model.research": "claude-sonnet-4-6" }, budgets: {} };
  const result = sameRealm(mc.diffFormMC(baseline, form)) as { models?: Record<string, string>; budgets?: unknown };
  assert.deepStrictEqual(result.models, { "model.dev": "claude-fable-5" });
  assert.ok(!("budgets" in result), "unchanged budgets omitted");
});

test("diffFormMC: model + budget both changed → both keys present", () => {
  const baseline = { models: { "model.dev": "claude-opus-4-8" }, budgets: { "budget.worker_max_usd": "0.50" } };
  const form = { models: { "model.dev": "claude-fable-5" }, budgets: { "budget.worker_max_usd": "0.75" } };
  const result = sameRealm(mc.diffFormMC(baseline, form)) as { models?: unknown; budgets?: unknown };
  assert.deepStrictEqual(result.models, { "model.dev": "claude-fable-5" });
  assert.deepStrictEqual(result.budgets, { "budget.worker_max_usd": "0.75" });
});

// --- buildFormMC: GET response → edit buffer (desired mirror) ---

test("buildFormMC: maps domains/budgets desired into the form buffer", () => {
  const data = {
    domains: [{ domain: "model.dev", desired: "claude-opus-4-8" }, { domain: "model.research", desired: null }],
    budgets: [{ domain: "budget.worker_max_usd", desired: "0.50" }],
  };
  const form = sameRealm(mc.buildFormMC(data));
  assert.strictEqual(form.models["model.dev"], "claude-opus-4-8");
  assert.strictEqual(form.models["model.research"], "", "null desired → empty string buffer");
  assert.strictEqual(form.budgets["budget.worker_max_usd"], "0.50");
});

// --- sortDomainsMC / sortBudgetsMC: known order first, unknown appended (no silent drop) ---

test("sortDomainsMC: canonical order applied, an unknown domain is appended (never dropped)", () => {
  const input = [
    { domain: "model.research" },
    { domain: "model.future_unknown" },
    { domain: "model.dev" },
  ];
  const sorted = sameRealm(mc.sortDomainsMC(input)).map((d) => d.domain);
  assert.deepStrictEqual(
    sorted,
    ["model.dev", "model.research", "model.future_unknown"],
    "reduced DOMAIN_ORDER_MC order applied, unknown appended last (never dropped)",
  );
});

test("every server model domain has a client slot, in the server's order, with a matching inherit flag", () => {
  // Server SoT is the oracle — a domain the API adds without a client entry would sort last under a raw key.
  const serverKeys = MODEL_DOMAINS.map((d) => d.key);
  const shuffled = serverKeys.slice().reverse().map((domain) => ({ domain }));
  const sorted = sameRealm(mc.sortDomainsMC(shuffled)).map((d) => d.domain);
  assert.deepStrictEqual(sorted, serverKeys, "DOMAIN_ORDER_MC covers every server domain in order");

  const roster = getInheritRosterOrFailMc();
  for (const def of MODEL_DOMAINS) {
    assert.strictEqual(roster[def.key], def.allowInherit, `${def.key}: client inherit flag = server allowInherit`);
  }
});

test("sortBudgetsMC: known order first, unknown budget appended (never dropped)", () => {
  const input = [
    { domain: "budget.future_unknown" },
    { domain: "budget.worker_max_usd" },
  ];
  const sorted = sameRealm(mc.sortBudgetsMC(input)).map((b) => b.domain);
  assert.strictEqual(sorted[0], "budget.worker_max_usd");
  assert.ok(sorted.includes("budget.future_unknown"));
  assert.strictEqual(sorted.length, 2);
});


// ---------------------------------------------------------------------------
// Render harness — read a component's emitted tree without a DOM.
//
// The helper sandbox above returns `{}` from createElement, so no tree survives it. This second
// sandbox evaluates the SAME shipped source with an element-factory React plus window.UI stubs and
// deep-renders one exported-by-declaration component into plain tag/props/children nodes, which is
// what makes layout-level claims (which columns exist, which banner fires, whether a section header
// survives a failed load) assertable at all.
// ---------------------------------------------------------------------------

interface McElement {
  type: unknown;
  props: Record<string, unknown>;
}
interface McTag {
  tag: string;
  props: Record<string, unknown>;
  children: McNode[];
}
type McNode = string | McTag;
type McComponent = (props: Record<string, unknown>) => unknown;

const MC_FRAGMENT = "mc-fragment";

function hMc(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): McElement {
  const merged: Record<string, unknown> = { ...(props ?? {}) };
  if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
  return { type, props: merged };
}

function isElementMc(value: unknown): value is McElement {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

// Function components are invoked (hooks are stubbed) → the tree is fully expanded, not shallow.
function renderMc(node: unknown): McNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(renderMc);
  if (!isElementMc(node)) return [];
  if (typeof node.type === "function") return renderMc((node.type as McComponent)(node.props));
  const { children, ...rest } = node.props;
  if (node.type === MC_FRAGMENT) return renderMc(children);
  return [{ tag: String(node.type), props: rest, children: renderMc(children) }];
}

function renderComponentMc(component: unknown, props: Record<string, unknown> = {}): McNode[] {
  assert.strictEqual(typeof component, "function", "component reachable in the sandbox");
  return renderMc(hMc(component, props));
}

// Visible text of a subtree, whitespace-collapsed — the reading an operator gets.
function textMc(nodes: McNode[]): string {
  return nodes
    .map((n) => (typeof n === "string" ? n : textMc(n.children)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function findAllMc(nodes: McNode[], match: (node: McTag) => boolean): McTag[] {
  const found: McTag[] = [];
  for (const node of nodes) {
    if (typeof node === "string") continue;
    if (match(node)) found.push(node);
    found.push(...findAllMc(node.children, match));
  }
  return found;
}

const tagsMc = (nodes: McNode[], tag: string): McTag[] => findAllMc(nodes, (n) => n.tag === tag);
const textsMc = (nodes: McTag[]): string[] => nodes.map((n) => textMc(n.children));

// Pure region/error helpers come from the real ui.jsx; its components stay stubbed so their props are readable.
const realUiMc = await buildUiSandbox<Record<string, unknown>>();

async function loadMcScreens(
  overrides: { react?: Record<string, unknown>; fetch?: unknown } = {},
): Promise<Record<string, unknown>> {
  const code = await buildMcCode();
  const reactStub: Record<string, unknown> = {
    createElement: hMc,
    Fragment: MC_FRAGMENT,
    // No re-render happens, so a setter is a no-op and state stays at its initial value.
    useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
  };
  // Effect-running / state-recording variants ride in here, so the load path can be driven.
  Object.assign(reactStub, overrides.react ?? {});
  // ui.jsx atoms — rendered as tagged wrappers so their children stay readable in the tree.
  const uiStub = {
    PageHeader: (p: Record<string, unknown>) => hMc("header", { className: "page-header" }, p.sub, p.right),
    Icon: (p: Record<string, unknown>) => hMc("i", { "data-icon": p.name }),
    TypeScaleStyle: () => null,
    Badge: (p: Record<string, unknown>) =>
      hMc("span", { className: `badge ${p.className ?? ""}`.trim(), "data-tone": p.tone ?? "neutral" }, p.children),
    CardHead: (p: Record<string, unknown>) => hMc("div", { className: "card-head" }, p.title, p.right),
    SectionLabel: (p: Record<string, unknown>) =>
      hMc(p.level === 3 ? "h3" : "h2", { className: "section-label" }, p.children),
    DetailSurface: (p: Record<string, unknown>) =>
      hMc("div", { role: "dialog" }, p.title, p.children, p.footer),
    titleOf: (v: unknown) => v,
    FreshnessStamp: () => null,
    RefreshButton: (p: Record<string, unknown>) => hMc("button", { ...p, "data-atom": "RefreshButton" }, "Refresh"),
    RegionUnavailable: (p: Record<string, unknown>) =>
      hMc("div", { ...p, "data-atom": "RegionUnavailable" }, String(p.source)),
    SkeletonRows: (p: Record<string, unknown>) =>
      Array.from({ length: Number(p.rows) }, () => hMc("tr", { "aria-hidden": "true" })),
    TableHead: (p: Record<string, unknown>) => hMc("th", { "data-atom": "TableHead" }, p.children),
    INITIAL_REGION_STATE: realUiMc.INITIAL_REGION_STATE,
    putRegionRequest: realUiMc.putRegionRequest,
    putRegionData: realUiMc.putRegionData,
    putRegionFailure: realUiMc.putRegionFailure,
    getErrorCopy: realUiMc.getErrorCopy,
    getFetchError: realUiMc.getFetchError,
  };
  const ctx: Record<string, unknown> = {
    window: { UI: uiStub, addEventListener: () => {}, removeEventListener: () => {} },
    React: reactStub,
    document: { documentElement: {} },
    Intl,
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch:
      overrides.fetch ??
      (() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

const screens = await loadMcScreens();

const DOMAIN_ROW_FIXTURE_MC = [
  {
    domain: "model.dev",
    desired: "claude-opus-4-8",
    actual: "claude-opus-4-8",
    drift: false,
    apply_mode: "next-spawn",
    editable: true,
    pricing_known: true,
  },
];

function domainsPropsMc(domains: unknown[] = DOMAIN_ROW_FIXTURE_MC): Record<string, unknown> {
  const form = { models: { "model.dev": "claude-opus-4-8" }, budgets: {} };
  return {
    state: "ready",
    domains,
    knownModels: KNOWN_MODELS_FIXTURE,
    form,
    baseline: { models: { ...form.models }, budgets: {} },
    errors: {},
    onModelChange: () => {},
  };
}

test("render harness: a screen component's emitted tree is readable as tags and text", async () => {
  const tree = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc());

  // Structure: the harness expands nested function components, so the row's controls are reachable.
  assert.ok(tagsMc(tree, "table").length === 1, "one ledger table emitted");
  assert.ok(textsMc(tagsMc(tree, "th")).length > 0, "column headers readable");
  assert.strictEqual(tagsMc(tree, "select").length, 1, "the editable row's select is reachable");
  // Text: row content from the fixture, not from a copy of the component.
  assert.ok(textMc(tree).includes("Dev agents"), "row label rendered from DOMAIN_META_MC");
  assert.ok(textMc(tree).includes("claude-opus-4-8"), "the fixture value reaches the tree");
});

test("render harness: the tree tracks the props it was given, not a fixed snapshot", async () => {
  const empty = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc([]));
  assert.strictEqual(tagsMc(empty, "select").length, 0, "no rows → no controls");
  assert.ok(!textMc(empty).includes("Dev agents"), "no rows → no row label");
});

test("DomainsSectionMC loading skeleton reserves one placeholder row per server model domain", async () => {
  const loading = renderComponentMc(screens.DomainsSectionMC, { ...domainsPropsMc([]), state: "loading" });
  const [busy] = findAllMc(loading, (n) => n.props["aria-busy"] === "true");
  assert.ok(busy, "loading placeholder rendered");
  assert.strictEqual(busy.children.length, MODEL_DOMAINS.length);
});

// ---------------------------------------------------------------------------
// Rewritten screen — what the target composition makes assertable (streams 2-5).
// Each test names the relationship it pins, not a pixel: a column set, a tone
// budget, a state-to-body mapping, a remedy carried once.
// ---------------------------------------------------------------------------

function sandboxFnMc<T>(name: string): T {
  const fn = screens[name];
  assert.strictEqual(typeof fn, "function", `${name} reachable in the sandbox`);
  return fn as T;
}

const BUDGET_ROW_FIXTURE_MC = [
  {
    domain: "budget.worker_max_usd",
    desired: "10.00",
    actual: "10.00",
    drift: false,
    apply_mode: "next-cycle",
  },
];

function budgetsPropsMc(budgets: unknown[] = BUDGET_ROW_FIXTURE_MC): Record<string, unknown> {
  const form = { models: {}, budgets: { "budget.worker_max_usd": "10.00" } };
  return {
    state: "ready",
    budgets,
    form,
    baseline: { models: {}, budgets: { ...form.budgets } },
    errors: {},
    onBudgetChange: () => {},
  };
}

const tonedMc = (nodes: McNode[], tone: string): McTag[] =>
  findAllMc(nodes, (n) => n.props["data-tone"] === tone);

test("both ledgers carry the same three columns — timing is stated once per section, not per row", () => {
  for (const [name, props] of [
    ["DomainsSectionMC", domainsPropsMc()],
    ["BudgetsSectionMC", budgetsPropsMc()],
  ] as const) {
    const headers = textsMc(tagsMc(renderComponentMc(screens[name], props), "th"));
    assert.strictEqual(headers.length, 3, `${name}: three columns`);
    assert.deepStrictEqual(headers.slice(2), ["Live"], `${name}: live last`);
    for (const gone of ["Sync", "Enforcement", "Actual", "Takes effect"]) {
      assert.ok(!headers.includes(gone), `${name}: '${gone}' column removed`);
    }
  }
});

test("every ledger column header goes through the shared TableHead atom, so it carries scope=col", () => {
  for (const name of ["DomainsSectionMC", "BudgetsSectionMC"] as const) {
    const props = name === "DomainsSectionMC" ? domainsPropsMc() : budgetsPropsMc();
    const headers = tagsMc(renderComponentMc(screens[name], props), "th");
    assert.ok(headers.length > 0, `${name}: headers rendered`);
    for (const th of headers) {
      assert.strictEqual(th.props["data-atom"], "TableHead", `${name}: '${textMc(th.children)}' is a TableHead`);
    }
  }
});

test("a row in its steady state spends no tone; only a drifted row raises one warn badge", () => {
  const steady = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc());
  assert.strictEqual(tonedMc(steady, "ok").length, 0, "no steady-state ok pill");
  assert.strictEqual(tonedMc(steady, "warn").length, 0, "nothing to warn about");

  const drifted = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], actual: "claude-sonnet-5", drift: true }]),
  );
  assert.strictEqual(tonedMc(drifted, "warn").length, 1, "exactly one warn badge per drifted row");
  assert.ok(textMc(drifted).includes("claude-sonnet-5"), "the live value is shown, not just a flag");
});

test("an apply_mode the screen does not map is stated verbatim as the take-effect mode", () => {
  const unknown = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], apply_mode: "some-future-mode" }]),
  );
  assert.ok(textMc(unknown).includes("some-future-mode"), "an unmapped mode is shown verbatim");
});

test("a mixed dev value discloses its per-file actuals instead of hiding them", () => {
  const tree = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([
      {
        ...DOMAIN_ROW_FIXTURE_MC[0],
        actual: "mixed",
        drift: true,
        files: [
          { file: "agents/glass-atrium-dev-react.md", model: "claude-opus-4-8" },
          { file: "agents/glass-atrium-dev-node.md", model: null },
        ],
      },
    ]),
  );
  const details = tagsMc(tree, "details");
  assert.ok(details.length >= 1, "a disclosure is emitted for the file list");
  const text = textMc(tree);
  assert.ok(text.includes("glass-atrium-dev-react.md"), "each file is listed");
  assert.ok(text.includes("inherit"), "a file with no model line reads as inherit, not blank");
});

test("a mixed review or docs pair reads as a labelled row with both files and a session-model default", () => {
  const pairs = {
    "model.review": ["Review", "glass-atrium-qa-code-reviewer.md", "glass-atrium-qa-debugger.md"],
    "model.docs": ["Documents", "glass-atrium-intel-reporter.md", "glass-atrium-intel-planner.md"],
  } as const;
  for (const [domain, [label, pinned, keyless]] of Object.entries(pairs)) {
    const tree = renderComponentMc(screens.DomainsSectionMC, {
      ...domainsPropsMc([
        {
          ...DOMAIN_ROW_FIXTURE_MC[0],
          domain,
          desired: "inherit",
          actual: "mixed",
          drift: true,
          files: [
            { file: `agents/${pinned}`, model: "claude-sonnet-5" },
            { file: `agents/${keyless}`, model: null },
          ],
        },
      ]),
      form: { models: { [domain]: "inherit" }, budgets: {} },
      baseline: { models: { [domain]: "inherit" }, budgets: {} },
    });
    const text = textMc(tree);
    assert.ok(text.includes(label), `${domain}: row label from DOMAIN_META_MC, not the raw key`);
    assert.ok(!text.includes(domain), `${domain}: raw key never shown as the label`);
    assert.ok(text.includes(pinned) && text.includes(keyless), `${domain}: both files listed`);
    assert.ok(text.includes("2 files"), `${domain}: per-file disclosure counts the pair`);
    const options = tagsMc(tree, "option");
    assert.strictEqual(options[0]?.props.value, "inherit", `${domain}: inherit is the first option`);
    assert.strictEqual(textMc([options[0]]), "session model (inherit)", `${domain}: inherit reads as the session model`);
  }
});

test("an empty roster says so; it never renders as a table with nothing in it", () => {
  const tree = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc([]));
  assert.strictEqual(tagsMc(tree, "tr").length, 2, "header row + the empty-state row");
  assert.ok(textMc(tree).includes("No model domains reported"), "empty is stated, not implied");
});

test("section headers survive every state, and a non-ready body never reads as zero rows", () => {
  for (const name of ["DomainsSectionMC", "BudgetsSectionMC"] as const) {
    const props = name === "DomainsSectionMC" ? domainsPropsMc() : budgetsPropsMc();
    const label = textMc(
      findAllMc(renderComponentMc(screens[name], { ...props, state: "ready" }), (n) =>
        String(n.props.className ?? "").includes("border-t"),
      ),
    );
    assert.ok(label.length > 0, `${name}: section header present when ready`);

    const ready = renderComponentMc(screens[name], { ...props, state: "ready" });
    const loading = renderComponentMc(screens[name], { ...props, state: "loading" });
    const columnsOf = (tree: McNode[]) => textsMc(tagsMc(tagsMc(tree, "thead"), "th"));
    assert.ok(textMc(loading).startsWith(label), `${name}: section header unchanged while loading`);
    assert.deepStrictEqual(
      columnsOf(loading),
      columnsOf(ready),
      `${name}: the skeleton sits under the real column headers, so nothing shifts when rows land`,
    );
    assert.ok(
      findAllMc(loading, (n) => n.props["aria-busy"] === "true").length === 1,
      `${name}: loading is announced as busy, not as empty`,
    );

    const unavailable = renderComponentMc(screens[name], { ...props, state: "unavailable" });
    assert.ok(textMc(unavailable).includes("Not available"), `${name}: unavailable stated`);
    assert.strictEqual(tagsMc(unavailable, "table").length, 0, "no table when unavailable");
  }
});

test("the header sync token answers once per state and leaves the as-of stamp to the shared atom", () => {
  const ready = renderComponentMc(screens.SyncTokenMC, {
    state: "ready",
    sync: "ok",
  });
  assert.ok(textMc(ready).includes("In sync"), "the state is named in plain text");
  assert.ok(!textMc(ready).includes("as of"), "the header freshness atom owns the stamp, not the token");
  assert.strictEqual(tagsMc(ready, "i").length, 0, "the freshness stamp owns the one tick, so the steady state spends no glyph");

  const drifted = renderComponentMc(screens.SyncTokenMC, {
    state: "ready",
    sync: "drift",
  });
  assert.strictEqual(tagsMc(drifted, "i").length, 1, "tone rides the glyph, not the text");

  // Loading and error are distinct readings — neither may look like a settled 'in sync'.
  for (const [state, expected] of [
    ["loading", "Checking sync"],
    ["error", "unavailable"],
  ] as const) {
    const token = textMc(renderComponentMc(screens.SyncTokenMC, { state, sync: undefined }));
    assert.ok(token.includes(expected), `${state} → '${expected}'`);
    assert.ok(!token.includes("In sync"), `${state} never reads as in sync`);
  }
});

test("the drift banner carries exactly one remedy, matched to its cause", () => {
  const drift = textMc(renderComponentMc(screens.DriftBannerMC, { sync: "drift" }));
  assert.ok(drift.includes("Save again"), "plain drift is fixed by saving again");
  assert.ok(!drift.includes("db-setup"), "the migration remedy does not leak into plain drift");
  // The ops model-config skill is retired — the epic removed it and it must not come back.
  assert.ok(!drift.includes("glass-atrium-ops-model-config"), "retired command not reinstated");

  const pending = textMc(renderComponentMc(screens.DriftBannerMC, { sync: "pending-migration" }));
  assert.ok(pending.includes("db-setup"), "a pending migration is fixed by db-setup");
  assert.ok(!pending.includes("Save again"), "saving cannot fix an un-migrated DB");
});

test("save results surface only when a surface did not write cleanly", () => {
  const extract = sandboxFnMc<(d: unknown) => unknown[] | null>("extractSurfaceResultsMC");
  const okOnly = [{ surface: "daemon-config.json", status: "ok" }];
  assert.strictEqual(extract({ surfaces: okOnly }), null, "an all-ok save raises no card");
  assert.strictEqual(extract({ surfaces: [] }), null, "no surfaces → no card");

  const mixed = [
    { surface: "daemon-config.json", status: "ok" },
    { surface: "frontmatter-dev", status: "failed", reason: "permission denied" },
  ];
  const kept = extract({ surfaces: mixed });
  assert.deepStrictEqual(sameRealm(kept), mixed, "the whole population is kept, not just failures");

  const card = renderComponentMc(screens.SurfaceResultsCardMC, {
    results: mixed,
    onDismiss: () => {},
  });
  const disclosures = tagsMc(card, "details");
  assert.strictEqual(disclosures.length, 1, "ok rows sit behind one closed disclosure");
  assert.ok(!("open" in disclosures[0].props), "the disclosure ships closed");
  assert.ok(textMc(card).includes("frontmatter-dev"), "the failed surface is shown unfolded");
  assert.ok(textMc(disclosures[0].children).includes("daemon-config.json"), "ok row still listed");
});

describe("a save-result row reads as words: status in plain words, mono only on the surface id", () => {
  const rows = [
    { name: "a written surface", result: { surface: "daemon-config.json", status: "ok" }, word: "Written", reason: null },
    { name: "a skipped surface", result: { surface: "tmux", status: "skipped", reason: "session not running" }, word: "Skipped", reason: "session not running" },
    { name: "a failed surface", result: { file: "frontmatter-dev", status: "failed", reason: "permission denied" }, word: "Failed", reason: "permission denied" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = renderComponentMc(screens.SurfaceResultRowMC, { result: row.result });
      const text = textMc(tree);
      const surface = row.result.surface ?? row.result.file;
      const mono = findAllMc(tree, (n) => String(n.props.className ?? "").includes("font-mono"));

      assert.ok(text.includes(row.word), `status reads "${row.word}"`);
      assert.ok(!text.includes(row.result.status), "the raw status token is not shown");
      assert.deepStrictEqual(mono.map((n) => textMc(n.children)), [surface], "mono covers the surface id alone");
      const reasons = findAllMc(tree, (n) => String(n.props.className ?? "").includes("text-faint")).map((n) => textMc(n.children));
      assert.deepStrictEqual(reasons, row.reason === null ? [] : [row.reason], "the reason shows exactly when the row carries one");
    });
  }

  test("a result missing its surface and status renders no placeholder", () => {
    const tree = renderComponentMc(screens.SurfaceResultRowMC, { result: { reason: "no target resolved" } });
    assert.ok(!textMc(tree).includes("—"), "no dash stands in for an empty field");
    assert.ok(textMc(tree).includes("no target resolved"), "the reason still shows");
  });
});

test("a read-only model row with no saved value renders no placeholder badge", () => {
  const readOnly = [{ ...DOMAIN_ROW_FIXTURE_MC[0], desired: "", actual: null, editable: false }];
  const props = domainsPropsMc(readOnly);
  (props.form as { models: Record<string, string> }).models["model.dev"] = "";
  const tree = renderComponentMc(screens.DomainsSectionMC, props);
  const modelCell = tagsMc(tree, "td")[1];

  assert.strictEqual(textMc(modelCell.children), "", "the empty model cell stays empty");
});

test("the unsaved-changes count equals the field count the partial PUT sends", () => {
  const count = sandboxFnMc<(p: unknown) => number>("countChangesMC");
  const baseline = {
    models: { "model.dev": "claude-opus-4-8", "model.wiki": "claude-sonnet-5" },
    budgets: { "budget.worker_max_usd": "10.00" },
  };
  const form = {
    models: { "model.dev": "claude-fable-5", "model.wiki": "claude-sonnet-5" },
    budgets: { "budget.worker_max_usd": "12.00" },
  };
  assert.strictEqual(count(mc.diffFormMC(baseline, baseline)), 0, "no diff → no count");
  const payload = mc.diffFormMC(baseline, form) as Record<string, Record<string, string>>;
  const sent = sameRealm(payload);
  const fields = Object.values(sent).reduce((n, group) => n + Object.keys(group).length, 0);
  assert.strictEqual(count(payload), fields, "count tracks the payload, not the row total");
});

// Drives the screen's load effect once with hook state kept in cells, so the landed values are readable.
async function runScreenLoadMc(fetchImpl: unknown): Promise<unknown[]> {
  const cells: Array<{ value: unknown }> = [];
  const live = await loadMcScreens({
    fetch: fetchImpl,
    react: {
      useEffect: (fn: () => unknown) => {
        fn();
      },
      useState: (init: unknown) => {
        const cell = { value: typeof init === "function" ? (init as () => unknown)() : init };
        cells.push(cell);
        return [cell.value, (next: unknown) => {
          cell.value = typeof next === "function" ? (next as (prev: unknown) => unknown)(cell.value) : next;
        }];
      },
    },
  });
  renderComponentMc(live.ScreenModelConfig, {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  return cells.map((cell) => cell.value);
}

const isRegionMc = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && "pendingRequest" in v;

test("a completed GET lands the config and stamps the header with its receive time", async () => {
  const fixture = { domains: [], budgets: [], known_models: [], daemon_config_sync: "ok" };
  const before = Date.now();
  const values = await runScreenLoadMc(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => fixture }),
  );

  const config = values.find(isRegionMc);
  assert.strictEqual(config?.status, "ready", "the read landed");
  assert.strictEqual(config?.busy, false, "nothing is in flight once it landed");
  assert.deepStrictEqual(sameRealm(config?.data), fixture, "the region holds the read");
  const stamps = values.filter((v) => typeof v === "number" && v >= before);
  assert.strictEqual(stamps.length, 1, "the header stamp carries the time the read was received");
});

test("a failed GET keeps the region out of ready and never advances the stamp", async () => {
  const before = Date.now();
  const values = await runScreenLoadMc(() =>
    Promise.resolve({ ok: false, status: 500, statusText: "Internal Server Error", text: async () => "boom" }),
  );

  const config = values.find(isRegionMc);
  assert.strictEqual(config?.status, "error", "no data was ever read");
  assert.ok(String(config?.error).startsWith("HTTP 500"), "the failure keeps its cause for Details");
  assert.strictEqual(values.filter((v) => typeof v === "number" && v >= before).length, 0, "no stamp from a failure");
});

test("a refresh keeps every unsaved edit and takes every untouched field from the new read", () => {
  type FormMc = { models: Record<string, string>; budgets: Record<string, string> };
  const getRefreshedForm = sandboxFnMc<(form: FormMc | null, prevData: unknown, data: unknown) => FormMc>(
    "getRefreshedFormMC",
  );
  const readOf = (dev: string, dp: string, worker: string) => ({
    domains: [
      { domain: "model.dev", desired: dev },
      { domain: "model.dp", desired: dp },
    ],
    budgets: [{ domain: "budget.worker_max_usd", desired: worker }],
  });
  const prevRead = readOf("claude-opus-4-8", "claude-sonnet-4-6", "10.00");
  const nextRead = readOf("claude-opus-5", "claude-haiku-4-5", "12.00");
  const edited: FormMc = {
    models: { "model.dev": "claude-sonnet-4-6", "model.dp": "claude-sonnet-4-6" },
    budgets: { "budget.worker_max_usd": "3.00" },
  };

  assert.deepStrictEqual(sameRealm(getRefreshedForm(edited, prevRead, nextRead)), {
    models: { "model.dev": "claude-sonnet-4-6", "model.dp": "claude-haiku-4-5" },
    budgets: { "budget.worker_max_usd": "3.00" },
  });
  assert.deepStrictEqual(
    sameRealm(getRefreshedForm(null, null, nextRead)),
    { models: { "model.dev": "claude-opus-5", "model.dp": "claude-haiku-4-5" }, budgets: { "budget.worker_max_usd": "12.00" } },
    "the first read has no buffer to keep",
  );
});

test("the header Refresh is the one retry: busy while a read is in flight, and a failed load adds no second Retry", async () => {
  const inFlight = findAllMc(renderComponentMc(screens.ScreenModelConfig, {}), (n) => n.props["data-atom"] === "RefreshButton");
  assert.strictEqual(inFlight[0]?.props.isBusy, true, "first read in flight → the atom is busy");
  assert.strictEqual(inFlight[0]?.props.hasRead, false, "nothing read yet → the atom says Loading");

  const failed = { ...(realUiMc.INITIAL_REGION_STATE as object), status: "error", busy: false, error: "HTTP 500 Internal Server Error — boom" };
  const failedScreens = await loadMcScreens({
    react: {
      useState: (init: unknown) => [init === realUiMc.INITIAL_REGION_STATE ? failed : init, () => {}],
    },
  });
  const tree = renderComponentMc(failedScreens.ScreenModelConfig, {});
  const refresh = findAllMc(tree, (n) => n.props["data-atom"] === "RefreshButton");
  assert.strictEqual(refresh[0]?.props.isBusy, false, "a settled failure leaves Refresh pressable");
  const alerts = findAllMc(tree, (n) => n.props.role === "alert");
  const cards = findAllMc(alerts, (n) => n.props["data-atom"] === "RegionUnavailable");
  assert.strictEqual(cards.length, 1, "the failed load is announced once, as a plain-sentence card");
  assert.strictEqual(cards[0].props.onRetry, undefined, "the card carries no Retry of its own");
  assert.strictEqual(textsMc(tagsMc(tree, "button")).filter((t) => t === "Retry").length, 0, "no Retry beside Refresh");
});

test("a failed save names the next step and keeps the server's raw answer behind Details", () => {
  const raw = "HTTP 422 Unprocessable Entity — budget.worker_max_usd must be between 0.05 and 50.00";
  const tree = renderComponentMc(screens.ErrorBannerMC, { title: "Couldn't save changes", detail: raw, onRetry: () => {} });

  const details = tagsMc(tree, "details");
  assert.strictEqual(details.length, 1, "one Details toggle");
  assert.ok(textMc(details).includes(raw), "the raw answer stays reachable");
  const visible = textMc(tree).replace(textMc(details), "");
  assert.ok(!visible.includes("HTTP 422"), "no raw status in the visible copy");
  assert.ok(visible.includes("Open Details"), "a refused request points at Details");
  assert.strictEqual(textsMc(tagsMc(tree, "button")).filter((t) => t === "Retry").length, 1, "one Retry for the save");
});

test("the drift banner triggers on any drifted row, not on the file state alone", () => {
  const hasDrift = sandboxFnMc<(data: unknown) => boolean>("hasRowDriftMC");
  assert.strictEqual(hasDrift({ domains: [], budgets: [] }), false, "nothing drifted → no trigger");
  assert.strictEqual(
    hasDrift({ domains: [{ domain: "model.dev", drift: true }], budgets: [] }),
    true,
    "one drifted model row raises it on its own",
  );
  assert.strictEqual(
    hasDrift({ domains: [], budgets: [{ domain: "budget.worker_max_usd", drift: true }] }),
    true,
    "one drifted budget row raises it on its own",
  );
});

test("the drift banner's remedy is pressable and resends the drifted rows' saved targets", () => {
  type McPayload = { models?: Record<string, string>; budgets?: Record<string, string> } | null;
  const buildResync = sandboxFnMc<(data: unknown, edits: unknown) => McPayload>("resyncPayloadMC");
  const data = {
    daemon_config_sync: "ok",
    domains: [
      { domain: "model.dev", desired: "claude-opus-4-8", actual: "stale", drift: true },
      { domain: "model.wiki", desired: "claude-haiku-4-8", actual: "claude-haiku-4-8", drift: false },
    ],
    budgets: [{ domain: "budget.worker_max_usd", desired: "10.00", actual: "10.00", drift: false }],
  };

  // Sandbox objects carry the vm realm's prototype — compare a host-realm copy.
  const drifted = buildResync(data, null);
  assert.deepStrictEqual(
    { ...(drifted?.models ?? {}) },
    { "model.dev": "claude-opus-4-8" },
    "a drifted row is resent by its saved target, a steady row is not",
  );
  assert.strictEqual(drifted?.budgets, undefined, "no drifted budget row → no budget field");
  assert.strictEqual(
    buildResync({ daemon_config_sync: "ok", domains: [], budgets: [] }, null),
    null,
    "nothing to heal → nothing to press",
  );

  // A file-level mismatch is healed by the full desired state, not by a per-row diff.
  const fileMissing = buildResync({ ...data, daemon_config_sync: "file-missing" }, null);
  assert.strictEqual(
    Object.keys(fileMissing?.models ?? {}).length,
    data.domains.length,
    "a missing daemon-config resends every domain",
  );
  assert.ok(fileMissing?.budgets, "and every budget key that file consumes");

  // The PUT response reinitializes the form buffer, so an unsaved edit must ride along.
  const edited = buildResync(data, { models: { "model.wiki": "claude-sonnet-4-8" } });
  assert.strictEqual(
    edited?.models?.["model.wiki"],
    "claude-sonnet-4-8",
    "an unsaved edit wins over the saved target it would otherwise discard",
  );

  const actionable = renderComponentMc(screens.DriftBannerMC, {
    sync: "drift",
    onResync: () => {},
    saving: false,
  });
  assert.strictEqual(
    tagsMc(actionable, "button").length,
    1,
    "the remedy is a control, not only a sentence",
  );
  const inert = renderComponentMc(screens.DriftBannerMC, { sync: "drift", onResync: null });
  assert.strictEqual(tagsMc(inert, "button").length, 0, "no payload → no dead button");
  const pending = renderComponentMc(screens.DriftBannerMC, {
    sync: "pending-migration",
    onResync: () => {},
  });
  assert.strictEqual(tagsMc(pending, "button").length, 0, "saving cannot fix an un-migrated DB");
});

test("an empty roster never reads as in sync, whatever the file state says", () => {
  const headerSync = sandboxFnMc<(data: unknown) => string>("headerSyncMC");
  for (const fileSync of ["ok", "drift", "file-missing"]) {
    const sync = headerSync({ daemon_config_sync: fileSync, domains: [], budgets: [] });
    const token = textMc(renderComponentMc(screens.SyncTokenMC, { state: "ready", sync }));
    assert.ok(!token.includes("In sync"), `${fileSync}: an empty roster is not 'In sync'`);
    assert.ok(token.includes("Nothing to sync"), `${fileSync}: the empty roster is named`);
  }
  const populated = headerSync({ daemon_config_sync: "ok", domains: DOMAIN_ROW_FIXTURE_MC, budgets: [] });
  assert.strictEqual(populated, "ok", "a populated roster keeps the file's sync state");
});

// Live cell of the first body row — the third column in both ledgers.
function liveCellMc(tree: McNode[]): McTag {
  const bodyRow = tagsMc(tagsMc(tree, "tbody")[0].children, "tr")[0];
  return tagsMc(bodyRow.children, "td")[2];
}

test("Live repeats nothing in the steady state and shows the value only when it differs", () => {
  for (const [name, props, drifted] of [
    ["DomainsSectionMC", domainsPropsMc(), domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], actual: "claude-sonnet-5", drift: true }])],
    ["BudgetsSectionMC", budgetsPropsMc(), budgetsPropsMc([{ ...BUDGET_ROW_FIXTURE_MC[0], actual: "12.00", drift: true }])],
  ] as const) {
    const steady = liveCellMc(renderComponentMc(screens[name], props));
    assert.strictEqual(textMc([steady]), "Matches saved", `${name}: a matching live value says so in words`);

    const differs = textMc([liveCellMc(renderComponentMc(screens[name], drifted))]);
    assert.ok(!differs.includes("Matches saved"), `${name}: a differing value never reads as matching`);
    assert.ok(/claude-sonnet-5|\$12\.00/.test(differs), `${name}: the differing value is shown`);
  }
});

test("an inherit live value names what it inherits from, never a bare 'inherit'", () => {
  for (const [actual, source] of [
    ["inherit", "session model"],
    ["inherit (settings.json)", "settings.json model"],
  ] as const) {
    const tree = renderComponentMc(
      screens.DomainsSectionMC,
      domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], actual, drift: true }]),
    );
    const live = textMc([liveCellMc(tree)]);
    assert.ok(live.includes(source), `${actual}: names the ${source}`);
    assert.notStrictEqual(live.replace(/\s*drift$/, ""), actual, `${actual}: not shown raw`);
  }
});

test("both ledgers sit on one column grid, so their Live columns line up", () => {
  const gridOf = (tree: McNode[]): string =>
    JSON.stringify(tagsMc(tree, "col").map((c) => c.props.style ?? c.props.width));
  const domains = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc());
  const budgets = renderComponentMc(screens.BudgetsSectionMC, budgetsPropsMc());
  assert.strictEqual(tagsMc(domains, "col").length, tagsMc(domains, "th").length, "one col per ledger column");
  assert.strictEqual(gridOf(domains), gridOf(budgets), "identical column widths in both ledgers");
  for (const tree of [domains, budgets]) {
    const style = tagsMc(tree, "table")[0].props.style as Record<string, unknown> | undefined;
    assert.strictEqual(style?.tableLayout, "fixed", "widths come from the grid, not the content");
  }
});

const THREE_TIERS_MC = ["model.dev", "model.research", "model.meta"].map((domain) => ({
  ...DOMAIN_ROW_FIXTURE_MC[0],
  domain,
}));

test("each ledger is an h2 section with a captioned table, so the outline never skips h1 to h3", () => {
  for (const [name, props, title] of [
    ["DomainsSectionMC", domainsPropsMc(), "Model assignment"],
    ["BudgetsSectionMC", budgetsPropsMc(), "Per-call budget caps"],
  ] as const) {
    const tree = renderComponentMc(screens[name], props);
    assert.deepStrictEqual(textsMc(tagsMc(tree, "h2")), [title], `${name}: one h2 naming the section`);
    assert.strictEqual(textsMc(tagsMc(tree, "caption")).length, 1, `${name}: the table is named by a caption`);
  }
});

test("tier descriptions sit behind one section disclosure, not one per row", () => {
  const tree = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc(THREE_TIERS_MC));
  assert.strictEqual(tagsMc(tree, "details").length, 1, "one disclosure for three described tiers");
  assert.ok(textMc(tree).includes("glass-atrium-meta-agent"), "every description stays reachable");
});

test("no ledger text drops below the 12px type floor", () => {
  const overridden = {
    ...domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], files: [{ file: "agents/a.md", model: "claude-opus-4-8" }] }]),
    baseline: { models: { "model.dev": "claude-sonnet-5" }, budgets: {} },
  };
  const tree = renderComponentMc(screens.DomainsSectionMC, overridden);
  const micro = findAllMc(tree, (n) => String(n.props.className ?? "").includes("fs-micro"));
  assert.strictEqual(micro.length, 0, "no fs-micro (11px) text");
});

test("the saved-value line keeps its slot whether or not the field differs, so an edit never grows the row", () => {
  const slotsOf = (baselineValue: string): number => {
    const tree = renderComponentMc(screens.DomainsSectionMC, {
      ...domainsPropsMc(),
      baseline: { models: { "model.dev": baselineValue }, budgets: {} },
    });
    return findAllMc(tree, (n) => n.props["data-slot"] === "saved-line").length;
  };
  assert.strictEqual(slotsOf("claude-opus-4-8"), 1, "slot reserved while the field matches");
  assert.strictEqual(slotsOf("claude-sonnet-5"), 1, "the same slot carries the saved value once it differs");
});

test("Cost & usage is linked once per ledger, and an unpriced tier says why its cost is a fallback", () => {
  for (const pricingKnown of [true, false]) {
    const tree = renderComponentMc(
      screens.DomainsSectionMC,
      domainsPropsMc(THREE_TIERS_MC.map((d) => ({ ...d, pricing_known: pricingKnown }))),
    );
    const links = tagsMc(tree, "a").filter((a) => a.props.href === "#cost");
    assert.strictEqual(links.length, 1, `pricing_known=${pricingKnown}: one section link for three tiers`);
    assert.strictEqual(
      textMc(tree).includes("No price listed"),
      !pricingKnown,
      `pricing_known=${pricingKnown}: the fallback note follows pricing_known`,
    );
  }
});

const countMc = (text: string, needle: string): number => text.split(needle).length - 1;

test("a take-effect mode shared by every row is stated once, and a row that differs names its own", () => {
  const uniform = textMc(renderComponentMc(screens.DomainsSectionMC, domainsPropsMc(THREE_TIERS_MC)));
  assert.strictEqual(countMc(uniform, "Next spawn"), 1, "three next-spawn rows → stated once");

  const mixed = THREE_TIERS_MC.map((d, i) => (i === 2 ? { ...d, apply_mode: "next-cycle" } : d));
  const text = textMc(renderComponentMc(screens.DomainsSectionMC, domainsPropsMc(mixed)));
  assert.strictEqual(countMc(text, "Next spawn"), 1, "the shared mode stays stated once");
  assert.strictEqual(countMc(text, "Next cycle"), 1, "the differing row names its own mode");
});

test("the per-file list groups files under each model, so every model value is shown whole once", () => {
  const tree = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([
      {
        ...DOMAIN_ROW_FIXTURE_MC[0],
        actual: "mixed",
        drift: true,
        files: [
          { file: "agents/a.md", model: "claude-opus-4-8" },
          { file: "agents/b.md", model: "claude-opus-4-8" },
          { file: "agents/c.md", model: "claude-sonnet-5" },
        ],
      },
    ]),
  );
  const [details] = tagsMc(tree, "details").filter((d) => textMc(d.children).includes("agents/a.md"));
  const listed = textMc(details.children);
  assert.strictEqual(countMc(listed, "claude-opus-4-8"), 1, "a model shared by two files is named once");
  assert.strictEqual(countMc(listed, "claude-sonnet-5"), 1, "each model gets its group");
  const truncatedModel = findAllMc(details.children, (n) =>
    String(n.props.className ?? "").includes("truncate") && textMc(n.children).includes("claude-"));
  assert.strictEqual(truncatedModel.length, 0, "no model value is cut off");
});

test("an invalid cap shows its reason and aria-invalid as soon as it is invalid, not only after blur", () => {
  const props = budgetsPropsMc();
  const tree = renderComponentMc(screens.BudgetsSectionMC, {
    ...props,
    form: { models: {}, budgets: { "budget.worker_max_usd": "-5" } },
    errors: { "budget.worker_max_usd": "Must be between $0.05 and $50.00" },
  });
  const [input] = tagsMc(tree, "input");
  assert.strictEqual(input.props["aria-invalid"], "true", "the field is marked invalid");
  const alerts = findAllMc(tree, (n) => n.props.role === "alert");
  assert.ok(textsMc(alerts).some((t) => t.includes("Must be between")), "the reason sits beside the field");
});

test("a live value the payload does not carry is left out, never shown as a placeholder dash", () => {
  const tree = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], actual: null, drift: false }]),
  );
  assert.strictEqual(textMc([liveCellMc(tree)]), "", "an absent live value renders nothing");
});
