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

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

import {
  FREE_TEXT_MODEL_PATTERN,
  BUDGET_VALUE_PATTERN,
  BUDGET_MIN_USD,
  BUDGET_MAX_USD,
  BUDGET_SEED_DEFAULT_USD,
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

async function loadMcScreens(): Promise<Record<string, unknown>> {
  const code = await buildMcCode();
  const reactStub = {
    createElement: hMc,
    Fragment: MC_FRAGMENT,
    // No re-render happens, so a setter is a no-op and state stays at its initial value.
    useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
  };
  // ui.jsx atoms — rendered as tagged wrappers so their children stay readable in the tree.
  const uiStub = {
    PageHeader: (p: Record<string, unknown>) => hMc("header", { className: "page-header" }, p.sub, p.right),
    Icon: (p: Record<string, unknown>) => hMc("i", { "data-icon": p.name }),
    TypeScaleStyle: () => null,
    Badge: (p: Record<string, unknown>) =>
      hMc("span", { className: `badge ${p.className ?? ""}`.trim(), "data-tone": p.tone ?? "neutral" }, p.children),
    CardHead: (p: Record<string, unknown>) => hMc("div", { className: "card-head" }, p.title, p.right),
    DetailSurface: (p: Record<string, unknown>) =>
      hMc("div", { role: "dialog" }, p.title, p.children, p.footer),
    titleOf: (v: unknown) => v,
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
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
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
