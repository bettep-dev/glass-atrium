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
  EFFORT_LEVELS,
  INHERIT_VALUE,
  MODEL_DOMAINS,
  TIER_DOMAINS,
  validateTierValue,
} from "../src/server/model-config-consts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MC_SRC = resolve(__dirname, "../public/src/screens/model-config.jsx");

interface McForm {
  models: Record<string, string>;
  budgets: Record<string, string>;
  tiers?: Record<string, string>;
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

test("client tier mirrors match server validateTierValue on every knob (via validateFormMC)", () => {
  const samples = [INHERIT_VALUE, ...EFFORT_LEVELS, "HIGH", "ultra", "", " high", "16000", "999999", "1000000", "0", "0123", "1.5", "-1"];
  for (const def of TIER_DOMAINS) {
    for (const value of samples) {
      const clientErr = !!sameRealm(
        mc.validateFormMC({ models: {}, budgets: {}, tiers: { [def.key]: value } }, []),
      )[def.key];
      assert.strictEqual(clientErr, validateTierValue(def, value) !== null, `${def.key}='${value}'`);
    }
  }
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

test("buildFormMC: maps domains/budgets/tiers desired into the form buffer", () => {
  const data = {
    domains: [{ domain: "model.dev", desired: "claude-opus-4-8" }, { domain: "model.research", desired: null }],
    budgets: [{ domain: "budget.worker_max_usd", desired: "0.50" }],
    tiers: [
      { domain: "tier.worker_effort", desired: "high" },
      { domain: "tier.pre_verify_max_output_tokens", desired: null },
    ],
  };
  const form = sameRealm(mc.buildFormMC(data));
  assert.strictEqual(form.models["model.dev"], "claude-opus-4-8");
  assert.strictEqual(form.models["model.research"], "", "null desired → empty string buffer");
  assert.strictEqual(form.budgets["budget.worker_max_usd"], "0.50");
  assert.strictEqual(form.tiers?.["tier.worker_effort"], "high");
  assert.strictEqual(form.tiers?.["tier.pre_verify_max_output_tokens"], INHERIT_VALUE, "an unset knob is the CLI default");
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

// The fold's open rule comes from the real ui.jsx, so the stub opens exactly when the atom would.
function getDisclosureOpenMc(kind: unknown, tone: unknown): boolean {
  const rule = realUiMc.getDisclosureOpen;
  assert.strictEqual(typeof rule, "function", "getDisclosureOpen reachable in the ui sandbox");
  // typeof guard above → callable
  return Boolean((rule as (k: unknown, t: unknown) => unknown)(kind, tone));
}

// Real shared helpers the stubs above delegate to — typed once here.
const getFreshnessVerdictMc = realUiMc.getFreshnessVerdict as (input: Record<string, unknown>) => { tone: unknown; label: unknown };
const getAgentDisplayNameMc = realUiMc.getAgentDisplayName as (name: unknown) => string;

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
    Icon: (p: Record<string, unknown>) => hMc("i", { "data-icon": p.name, className: p.className }),
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
    // freshness resolves through the real shared rule, as in the atom
    PageVerdict: (p: Record<string, unknown>) => {
      const verdict = p.freshness
        ? getFreshnessVerdictMc({ ...(p.freshness as object), tone: p.tone, label: p.label })
        : { tone: p.tone, label: p.label };
      return hMc(
        "div",
        { "data-atom": "PageVerdict", "data-verdict-tone": verdict.tone, "data-verdict-label": verdict.label, chips: p.chips },
        p.children,
      );
    },
    AgentName: (p: Record<string, unknown>) =>
      hMc("span", { "data-atom": "AgentName", title: p.name }, getAgentDisplayNameMc(p.name)),
    formatKstTime: realUiMc.formatKstTime,
    SplitRow: (p: Record<string, unknown>) =>
      hMc("div", { "data-atom": "SplitRow", "data-ratio": p.ratio }, p.children),
    SplitColumn: (p: Record<string, unknown>) => hMc("div", { "data-atom": "SplitColumn" }, p.children),
    getFreshnessVerdict: getFreshnessVerdictMc,
    // body mounts only while open, as in the atom
    Disclosure: (p: Record<string, unknown>) => {
      const open = getDisclosureOpenMc(p.kind, p.tone);
      return hMc("details", { "data-kind": p.kind, open }, p.title, open ? p.children : null);
    },
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

const TIER_ROW_FIXTURE_MC = [
  { domain: "tier.worker_effort", desired: null, actual: null, file_error: null, drift: false, apply_mode: "next-cycle" },
  { domain: "tier.worker_max_output_tokens", desired: "32000", actual: "32000", file_error: null, drift: false, apply_mode: "next-cycle" },
  { domain: "tier.pre_verify_max_output_tokens", desired: null, actual: null, file_error: null, drift: false, apply_mode: "next-cycle" },
];

function tiersPropsMc(onTierChange: (key: string, value: string) => void = () => {}): Record<string, unknown> {
  const form = {
    models: {},
    budgets: {},
    tiers: {
      "tier.worker_effort": INHERIT_VALUE,
      "tier.worker_max_output_tokens": "32000",
      "tier.pre_verify_max_output_tokens": INHERIT_VALUE,
    },
  };
  return {
    state: "ready",
    tiers: TIER_ROW_FIXTURE_MC,
    isFileRead: true,
    form,
    baseline: { models: {}, budgets: {}, tiers: { ...form.tiers } },
    errors: {},
    onTierChange,
  };
}

test("the call-tier ledger offers the CLI default plus the five levels, and an unset cap reads as a blank field", () => {
  const tree = renderComponentMc(screens.TiersSectionMC, tiersPropsMc());

  const selects = tagsMc(tree, "select");
  assert.strictEqual(selects.length, 1, "one select per effort row");
  assert.strictEqual(selects[0].props.value, INHERIT_VALUE);
  assert.deepStrictEqual(
    tagsMc(selects[0].children, "option").map((o) => o.props.value),
    [INHERIT_VALUE, ...EFFORT_LEVELS],
  );
  assert.deepStrictEqual(
    tagsMc(tree, "input").map((i) => i.props.value),
    ["32000", ""],
    "a saved cap shows its digits, an unset one is blank — never the word inherit",
  );
});

test("clearing a cap field records the knob as unset ('inherit'), never as an empty value", () => {
  const changes: Array<[string, string]> = [];
  const tree = renderComponentMc(screens.TiersSectionMC, tiersPropsMc((key, value) => changes.push([key, value])));
  const [filled] = tagsMc(tree, "input").filter((i) => i.props.value === "32000");

  (filled.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "" } });

  assert.deepStrictEqual(changes, [["tier.worker_max_output_tokens", INHERIT_VALUE]]);
});

describe("a knob with no key in the file reads as the CLI default in effect only when the file was read", () => {
  const rows = [
    { name: "a read file: the CLI default, never an unread value", isFileRead: true, isCliDefault: true },
    { name: "a missing file: an unread value, never the CLI default", isFileRead: false, isCliDefault: false },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = renderComponentMc(screens.TiersSectionMC, { ...tiersPropsMc(), isFileRead: row.isFileRead });
      const effortRow = tagsMc(tree, "tr").find((tr) => textMc(tr.children).includes("generation effort"));
      assert.ok(effortRow, "the generation effort row is rendered");

      const cell = tagsMc(effortRow.children, "td")[2];
      const live = textMc(cell.children);
      const titles = findAllMc(cell.children, (n) => typeof n.props.title === "string").map((n) => String(n.props.title));
      assert.strictEqual([live, ...titles].some((s) => s.includes("CLI default")), row.isCliDefault, `${live} | ${titles.join(" | ")}`);
      assert.strictEqual(live.includes("No value read"), !row.isCliDefault, live);
    });
  }
});

test("a knob whose file value the daemon rejects shows the rejection in its row, never a match or the CLI default", () => {
  const rejected = { ...TIER_ROW_FIXTURE_MC[0], file_error: '"ultra" is not a valid tier (allowed: low, medium, high, xhigh, max)' };
  const tree = renderComponentMc(screens.TiersSectionMC, { ...tiersPropsMc(), tiers: [rejected, ...TIER_ROW_FIXTURE_MC.slice(1)] });
  const effortRow = tagsMc(tree, "tr").find((tr) => textMc(tr.children).includes("generation effort"));
  assert.ok(effortRow, "the generation effort row is rendered");

  const cell = tagsMc(effortRow.children, "td")[2];
  const live = textMc(cell.children);
  const titles = findAllMc(cell.children, (n) => typeof n.props.title === "string").map((n) => String(n.props.title));
  assert.ok(live.includes('"ultra"'), `the rejected value is named: ${live}`);
  assert.ok(![live, ...titles].some((s) => s.includes("Matches saved") || s.includes("CLI default")), `${live} | ${titles.join(" | ")}`);
});

const tonedMc = (nodes: McNode[], tone: string): McTag[] =>
  findAllMc(nodes, (n) => n.props["data-tone"] === tone);

test("both ledgers carry the same three columns — timing is stated once per section, not per row", () => {
  for (const [name, props] of [
    ["DomainsSectionMC", domainsPropsMc()],
    ["BudgetsSectionMC", budgetsPropsMc()],
  ] as const) {
    const headers = textsMc(tagsMc(renderComponentMc(screens[name], props), "th"));
    assert.strictEqual(headers.length, 3, `${name}: three columns`);
    assert.deepStrictEqual(headers.slice(2), ["In effect"], `${name}: in-effect last`);
    for (const gone of ["Sync", "Enforcement", "Actual", "Takes effect", "Live"]) {
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
  assert.ok(text.includes("dev-react") && text.includes("dev-node"), "each file is listed by its agent name");
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
    const shown = [pinned, keyless].map((file) => getAgentDisplayNameMc(file.replace(/\.md$/, "")));
    assert.ok(shown.every((name) => text.includes(name)), `${domain}: both files listed`);
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
  const unavailable = textMc(renderComponentMc(screens.SyncTokenMC, { state: "error", sync: undefined }));
  assert.ok(unavailable.includes("unavailable") && !unavailable.includes("In sync"), "error never reads as in sync");
  // the stamp beside it already reads '… loading' → the token adds no second ellipsis
  assert.strictEqual(textMc(renderComponentMc(screens.SyncTokenMC, { state: "loading", sync: undefined })), "");
});

test("a warm read error turns the sync token to the shared 'Last known' wording, never a settled 'In sync'", () => {
  const readAt = Date.parse("2026-01-10T12:00:00.000Z");
  const region = { status: "ready", data: {}, error: null, busy: false };
  const tokenFor = (sync: string, error: string | null) =>
    textMc(
      renderComponentMc(screens.SyncTokenMC, {
        state: "ready",
        sync,
        freshness: { at: readAt, now: readAt + 1_000, regions: [{ ...region, error }] },
      }),
    );

  assert.strictEqual(tokenFor("ok", null), "In sync", "a fresh read keeps its state word");
  assert.strictEqual(tokenFor("ok", "HTTP 500"), "Last known", "a stale in-sync read drops to the neutral shared word");
  assert.strictEqual(tokenFor("drift", "HTTP 500"), "Last known: Drift", "a stale alarm keeps its word behind the shared prefix");
});

test("a warm read error hands the verdict no age note — the alert under it already dates the last good read", () => {
  const verdictFor = sandboxFnMc<(tone: string, at: number | null, state: object) => Record<string, unknown>>(
    "getVerdictFreshnessMC",
  );
  const settled = { status: "ready", data: {}, error: null, busy: false };

  assert.ok("freshness" in verdictFor("ok", 1, settled), "a clean read keeps the ticking freshness input");
  const warm = verdictFor("ok", 1, { ...settled, error: "HTTP 500" });
  assert.ok(!("freshness" in warm), "a warm error carries no freshness, so no 'Read Ns ago' note");
  assert.strictEqual(warm.label, "Last known");
  assert.strictEqual(warm.tone, "neutral", "an ok verdict never stays green over the error");
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

  const rejected = textMc(renderComponentMc(screens.DriftBannerMC, { sync: "file-invalid" }));
  assert.ok(rejected.includes("rejects"), `a rejected value is named as the cause: ${rejected}`);
  assert.ok(rejected.includes("Save again"), "saving rewrites the rejected key");
  assert.ok(!rejected.includes("db-setup"), "the migration remedy does not leak into a rejected value");
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
    tiers: { "tier.worker_effort": "inherit", "tier.pre_verify_effort": "high" },
  };
  const form = {
    models: { "model.dev": "claude-fable-5", "model.wiki": "claude-sonnet-5" },
    budgets: { "budget.worker_max_usd": "12.00" },
    tiers: { "tier.worker_effort": "medium", "tier.pre_verify_effort": "high" },
  };
  assert.strictEqual(count(mc.diffFormMC(baseline, baseline)), 0, "no diff → no count");
  const payload = mc.diffFormMC(baseline, form) as Record<string, Record<string, string>>;
  const sent = sameRealm(payload);
  const fields = Object.values(sent).reduce((n, group) => n + Object.keys(group).length, 0);
  assert.deepStrictEqual(sent.tiers, { "tier.worker_effort": "medium" }, "only the changed knob is sent");
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
  type FormMc = { models: Record<string, string>; budgets: Record<string, string>; tiers: Record<string, string> };
  const getRefreshedForm = sandboxFnMc<(form: FormMc | null, prevData: unknown, data: unknown) => FormMc>(
    "getRefreshedFormMC",
  );
  const readOf = (dev: string, dp: string, worker: string, effort: string, cap: string) => ({
    domains: [
      { domain: "model.dev", desired: dev },
      { domain: "model.dp", desired: dp },
    ],
    budgets: [{ domain: "budget.worker_max_usd", desired: worker }],
    tiers: [
      { domain: "tier.worker_effort", desired: effort },
      { domain: "tier.worker_max_output_tokens", desired: cap },
    ],
  });
  const prevRead = readOf("claude-opus-4-8", "claude-sonnet-4-6", "10.00", "low", "8000");
  const nextRead = readOf("claude-opus-5", "claude-haiku-4-5", "12.00", "medium", "16000");
  const edited: FormMc = {
    models: { "model.dev": "claude-sonnet-4-6", "model.dp": "claude-sonnet-4-6" },
    budgets: { "budget.worker_max_usd": "3.00" },
    tiers: { "tier.worker_effort": "xhigh", "tier.worker_max_output_tokens": "8000" },
  };

  assert.deepStrictEqual(sameRealm(getRefreshedForm(edited, prevRead, nextRead)), {
    models: { "model.dev": "claude-sonnet-4-6", "model.dp": "claude-haiku-4-5" },
    budgets: { "budget.worker_max_usd": "3.00" },
    tiers: { "tier.worker_effort": "xhigh", "tier.worker_max_output_tokens": "16000" },
  });
  assert.deepStrictEqual(
    sameRealm(getRefreshedForm(null, null, nextRead)),
    {
      models: { "model.dev": "claude-opus-5", "model.dp": "claude-haiku-4-5" },
      budgets: { "budget.worker_max_usd": "12.00" },
      tiers: { "tier.worker_effort": "medium", "tier.worker_max_output_tokens": "16000" },
    },
    "the first read has no buffer to keep",
  );
});

test("a read in flight keeps the header Refresh busy until the first answer lands", async () => {
  const fixture = { domains: [], budgets: [], known_models: [], daemon_config_sync: "ok" };
  const cells: unknown[] = [];
  let hookIndex = 0;
  let isMounted = false;
  let land: (res: unknown) => void = () => {};
  const live = await loadMcScreens({
    fetch: () => new Promise((resolve) => (land = resolve)),
    react: {
      // hook cells persist across renders by call order → each render reads the state the last one left
      useState: (init: unknown) => {
        const i = hookIndex++;
        if (!(i in cells)) cells[i] = typeof init === "function" ? (init as () => unknown)() : init;
        return [cells[i], (next: unknown) => {
          cells[i] = typeof next === "function" ? (next as (prev: unknown) => unknown)(cells[i]) : next;
        }];
      },
      useEffect: (fn: () => unknown) => {
        if (!isMounted) fn();
      },
    },
  });
  const getRefresh = () => {
    hookIndex = 0;
    const tree = renderComponentMc(live.ScreenModelConfig, {});
    isMounted = true;
    return findAllMc(tree, (n) => n.props["data-atom"] === "RefreshButton")[0]?.props;
  };

  getRefresh();
  const inFlight = getRefresh();
  assert.strictEqual(inFlight?.isBusy, true, "first read in flight → the atom is busy");
  assert.strictEqual(inFlight?.hasRead, false, "nothing read yet → the atom says Loading");

  land({ ok: true, status: 200, json: async () => fixture });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const landed = getRefresh();
  assert.strictEqual(landed?.isBusy, false, "the answer landed → Refresh is pressable again");
  assert.strictEqual(landed?.hasRead, true, "a read landed → the atom stops saying Loading");
});

describe("a failed config read carries the shared error card with one Retry that reloads the config", () => {
  const error = "HTTP 500 Internal Server Error — boom";
  const rows = [
    { name: "cold — nothing was ever read", state: { status: "error", data: null, error, busy: false } },
    { name: "warm — a refresh failed after an earlier read", state: { status: "ready", data: {}, error, busy: false } },
  ];

  for (const row of rows) {
    test(row.name, async () => {
      const failed = { ...(realUiMc.INITIAL_REGION_STATE as object), ...row.state };
      const failedScreens = await loadMcScreens({
        react: {
          useState: (init: unknown) => [init === realUiMc.INITIAL_REGION_STATE ? failed : init, () => {}],
        },
      });
      const tree = renderComponentMc(failedScreens.ScreenModelConfig, {});
      const refresh = findAllMc(tree, (n) => n.props["data-atom"] === "RefreshButton");
      const alerts = findAllMc(tree, (n) => n.props.role === "alert");
      const cards = findAllMc(alerts, (n) => n.props["data-atom"] === "RegionUnavailable");

      assert.strictEqual(refresh[0]?.props.isBusy, false, "a settled failure leaves Refresh pressable");
      assert.strictEqual(cards.length, 1, "the failed load is announced once, as the shared card");
      assert.strictEqual(typeof cards[0].props.onRetry, "function", "the card carries its Retry");
      assert.strictEqual(cards[0].props.onRetry, refresh[0]?.props.onRefresh, "Retry performs the same reload as Refresh");
      assert.strictEqual(textsMc(tagsMc(tree, "button")).filter((t) => t === "Retry").length, 0, "no second, page-local Retry");
    });
  }
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
  type McPayload = {
    models?: Record<string, string>;
    budgets?: Record<string, string>;
    tiers?: Record<string, string>;
  } | null;
  const buildResync = sandboxFnMc<(data: unknown, edits: unknown) => McPayload>("resyncPayloadMC");
  const data = {
    daemon_config_sync: "ok",
    domains: [
      { domain: "model.dev", desired: "claude-opus-4-8", actual: "stale", drift: true },
      { domain: "model.wiki", desired: "claude-haiku-4-8", actual: "claude-haiku-4-8", drift: false },
    ],
    budgets: [{ domain: "budget.worker_max_usd", desired: "10.00", actual: "10.00", drift: false }],
    tiers: [
      { domain: "tier.worker_effort", desired: "inherit", actual: "low", drift: true },
      { domain: "tier.pre_verify_effort", desired: "high", actual: "high", drift: false },
      { domain: "tier.worker_max_output_tokens", desired: null, actual: null, drift: false },
    ],
  };

  // Sandbox objects carry the vm realm's prototype — compare a host-realm copy.
  const drifted = buildResync(data, null);
  assert.deepStrictEqual(
    { ...(drifted?.models ?? {}) },
    { "model.dev": "claude-opus-4-8" },
    "a drifted row is resent by its saved target, a steady row is not",
  );
  assert.strictEqual(drifted?.budgets, undefined, "no drifted budget row → no budget field");
  assert.deepStrictEqual(
    { ...(drifted?.tiers ?? {}) },
    { "tier.worker_effort": "inherit" },
    "a drifted knob is resent too — 'inherit' is a saved target, an unsaved knob is not",
  );
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
  // Save again must reach a rejected knob that has no saved row, or the banner offers a remedy that heals nothing.
  const rejected = buildResync(
    {
      daemon_config_sync: "file-invalid",
      domains: [],
      budgets: [],
      tiers: [{ domain: "tier.worker_effort", desired: null, actual: null, file_error: '"ultra" is not a valid tier', drift: false }],
    },
    null,
  );
  assert.deepStrictEqual(
    { ...(rejected?.tiers ?? {}) },
    { "tier.worker_effort": "inherit" },
    "a rejected knob with no saved row is rewritten to the CLI default its row shows",
  );

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
    assert.ok(textMc([steady]).startsWith("Matches saved"), `${name}: a matching live value says so in words`);
    assert.ok(!textMc([steady]).includes("claude-opus-4-8"), `${name}: the matching value is not repeated`);
    assert.strictEqual(tagsMc([steady], "i")[0]?.props["data-icon"], "check", `${name}: the match carries an ok glyph`);

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

test("tier notes show one unfolded entry per described tier", () => {
  const [domainMeta] = vm.runInContext("[DOMAIN_META_MC]", screens) as Array<Record<string, unknown>>;
  const rows = THREE_TIERS_MC.map((d) => domainMeta[(d as { domain: string }).domain]);
  const tree = renderComponentMc(screens.TierNotesMC, { title: "Who each tier covers", rows });
  assert.strictEqual(tagsMc(tree, "details").length, 0, "the notes are not folded away");
  assert.strictEqual(tagsMc(tree, "dt").length, rows.length, "one entry per tier");
  assert.ok(textMc(tree).includes("self-improvement loop"), "every description stays reachable");
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
  const [details] = tagsMc(tree, "details").filter((d) => textMc(d.children).includes("claude-sonnet-5"));
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

type VerdictMc = { tone: string; text: string; chips: { label: string; targetId: string }[] };

describe("the page verdict is ok exactly when every row matches and the file is in sync", () => {
  const getPageVerdictMc = sandboxFnMc<(data: unknown) => VerdictMc>("getPageVerdictMC");
  const clean = { daemon_config_sync: "ok", domains: THREE_TIERS_MC, budgets: BUDGET_ROW_FIXTURE_MC };
  const rows = [
    { name: "every row matching reads as one ok line with both totals", data: clean, tone: "ok", names: ["3/3 tiers", "1/1 caps", "config file in sync"], section: null },
    {
      name: "a drifted tier is named and its chip jumps to the model ledger",
      data: { ...clean, domains: THREE_TIERS_MC.map((d, i) => (i === 0 ? { ...d, drift: true } : d)) },
      tone: "warn",
      names: ["1 tier drifting", "Dev agents"],
      section: "DomainsSectionMC",
    },
    {
      name: "a drifted cap is named and its chip jumps to the cap ledger",
      data: { ...clean, budgets: [{ ...BUDGET_ROW_FIXTURE_MC[0], drift: true }] },
      tone: "warn",
      names: ["1 cap drifting", "Self-improve + wiki call cap"],
      section: "BudgetsSectionMC",
    },
    {
      name: "a tier whose live value was not read is named, never counted as matching",
      data: { ...clean, domains: THREE_TIERS_MC.map((d, i) => (i === 0 ? { ...d, actual: null, drift: false } : d)) },
      tone: "warn",
      names: ["1 tier not read", "Dev agents"],
      section: "DomainsSectionMC",
    },
    {
      name: "a cap whose live value was not read is named, never counted as matching",
      data: { ...clean, budgets: [{ ...BUDGET_ROW_FIXTURE_MC[0], actual: null, drift: false }] },
      tone: "warn",
      names: ["1 cap not read", "Self-improve + wiki call cap"],
      section: "BudgetsSectionMC",
    },
    { name: "a missing config file warns even when every row matches", data: { ...clean, daemon_config_sync: "file-missing" }, tone: "warn", names: ["File missing"], section: null },
    { name: "an empty roster claims nothing", data: { daemon_config_sync: "ok", domains: [], budgets: [] }, tone: "neutral", names: [], section: null },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const verdict = getPageVerdictMc(row.data);
      assert.strictEqual(verdict.tone, row.tone);
      assert.strictEqual(verdict.text.includes("match saved"), row.tone === "ok", "only an ok verdict claims a match");
      for (const name of row.names) assert.ok(verdict.text.includes(name), `names '${name}'`);
      if (row.section === null) {
        assert.strictEqual(verdict.chips.length, 0, "no chip without a drifted ledger");
        return;
      }
      assert.strictEqual(verdict.chips.length, 1, "one chip per drifted ledger");
      const props = row.section === "DomainsSectionMC" ? domainsPropsMc() : budgetsPropsMc();
      const tree = renderComponentMc(screens[row.section], props);
      const targets = findAllMc(tree, (n) => n.props.id === verdict.chips[0].targetId);
      assert.strictEqual(targets.length, 1, "the chip targets the ledger holding the drifted row");
    });
  }
});

test("a model id reads as its family and version; an id outside the naming pattern gets none", () => {
  const getModelFamilyMc = sandboxFnMc<(model: string) => string | null>("getModelFamilyMC");
  for (const [id, family] of [
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-haiku-4-5", "Haiku 4.5"],
    ["inherit", "Session model"],
    ["my-local-model", null],
  ] as const) {
    assert.strictEqual(getModelFamilyMc(id), family, id);
  }
});

test("the model mix counts every tier once under its family, and each select names its family in text", () => {
  const models = { "model.dev": "claude-opus-4-8", "model.research": "claude-sonnet-5", "model.meta": "claude-opus-4-8" };
  const tree = renderComponentMc(screens.DomainsSectionMC, {
    ...domainsPropsMc(THREE_TIERS_MC),
    form: { models, budgets: {} },
    baseline: { models: { ...models }, budgets: {} },
  });
  assert.ok(textMc(tree).includes("Opus 4.8 ×2 · Sonnet 5 ×1"), "the mix totals the tiers per family");
  const tags = textsMc(findAllMc(tree, (n) => n.props["data-slot"] === "family"));
  assert.strictEqual(tags.length, tagsMc(tree, "select").length, "one family tag per select");
  assert.ok(tags.every((t) => t === "Opus 4.8" || t === "Sonnet 5"), "each tag names its select's family");
});

test("the file list toggle is a control-radius pill, not a heading or a card", () => {
  const tree = renderComponentMc(screens.LiveValueMC, {
    value: "claude-opus-4-8",
    drift: false,
    files: [{ file: "agents/glass-atrium-dev-react.md", model: "claude-opus-4-8" }],
  });
  const [summary] = tagsMc(tree, "summary");
  assert.ok(summary, "the toggle is a native summary");
  assert.ok(textMc(summary.children).includes("1 file"), "the toggle names the file count");
  assert.strictEqual((summary.props.style as Record<string, string>)?.borderRadius, "var(--radius-control)");
  assert.strictEqual(findAllMc(tree, (n) => /^h[1-6]$/.test(n.tag) || "data-kind" in n.props).length, 0, "no heading, no card fold");
});

test("a file list stays folded while every file carries the saved model, and opens on drift or mixed models", () => {
  const filesOf = (models: string[]) => models.map((model, i) => ({ file: `glass-atrium-dev-${i}.md`, model }));
  const rows = [
    { name: "uniform files, no drift", drift: false, files: filesOf(["claude-opus-4-8", "claude-opus-4-8"]), open: false },
    { name: "uniform files, drifted row", drift: true, files: filesOf(["claude-opus-4-8", "claude-opus-4-8"]), open: true },
    { name: "mixed files, no drift", drift: false, files: filesOf(["claude-opus-4-8", "claude-sonnet-5"]), open: true },
  ];
  for (const row of rows) {
    const tree = renderComponentMc(
      screens.DomainsSectionMC,
      domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], drift: row.drift, files: row.files }]),
    );
    const [fold] = tagsMc(tree, "details");
    assert.ok(fold, `${row.name}: the file list sits in a fold`);
    assert.strictEqual(Boolean(fold.props.open), row.open, `${row.name}: open state`);
  }
});

test("each section states 'Takes effect' once, naming a departing row inside that one line", () => {
  const tree = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([
      DOMAIN_ROW_FIXTURE_MC[0],
      { ...DOMAIN_ROW_FIXTURE_MC[0], domain: "model.research" },
      { ...DOMAIN_ROW_FIXTURE_MC[0], domain: "model.daemon_cycle_worker", apply_mode: "next-cycle" },
    ]),
  );
  const lines = textsMc(findAllMc(tree, (n) => n.children.some((c) => typeof c === "string" && c.includes("Takes effect"))));
  assert.strictEqual(lines.length, 1, "one take-effect line per section");
  assert.ok(lines[0].includes("Next spawn") && lines[0].includes("Daemon cycle helper: Next cycle"), lines[0]);
});

test("tier notes sit outside the ledger and never restate a row's own hint", () => {
  const section = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc());
  assert.strictEqual(tagsMc(section, "dl").length, 0, "nothing folds open above the model table");

  const screen = renderComponentMc(screens.ScreenModelConfig);
  const [rail] = findAllMc(screen, (n) => n.props["data-atom"] === "SplitColumn");
  assert.ok(rail, "the caps column is a split column that can hold the notes");

  // script-scope consts stay off the context global, so read them through the context itself
  const tables = vm.runInContext("[DOMAIN_META_MC, BUDGET_META_MC]", screens) as object[];
  const metas = tables.flatMap((table) => Object.values(table));
  for (const meta of metas as Array<{ label: string; hint: string; desc: string }>) {
    assert.ok(!meta.desc.toLowerCase().includes(meta.hint.toLowerCase()), `${meta.label}: note restates its hint`);
  }
});

test("the three ledgers share one split row, model assignment leading", () => {
  const tree = renderComponentMc(screens.ScreenModelConfig);
  const [split] = findAllMc(tree, (n) => n.props["data-atom"] === "SplitRow");
  assert.ok(split, "a split row holds the ledgers");
  assert.strictEqual(split.props["data-ratio"], "3:2");
  assert.deepStrictEqual(textsMc(tagsMc(split.children, "h2")), [
    "Model assignment",
    "Per-call budget caps",
    "Daemon call tiers",
  ]);
});

test("every cap carries its own reference link to Cost & usage", () => {
  const budgets = [BUDGET_ROW_FIXTURE_MC[0], { ...BUDGET_ROW_FIXTURE_MC[0], domain: "budget.pre_verify_max_usd" }];
  const tree = renderComponentMc(screens.BudgetsSectionMC, budgetsPropsMc(budgets));
  const rows = tagsMc(tagsMc(tree, "tbody")[0].children, "tr");
  assert.strictEqual(rows.length, 2, "one row per cap");
  for (const row of rows) {
    const links = tagsMc(row.children, "a").filter((a) => a.props.href === "#cost");
    assert.strictEqual(links.length, 1, "one reference link per cap row");
  }
});

test("a listed agent file reads as the shared agent name, never the raw file name", () => {
  const files = [{ file: "glass-atrium-qa-code-reviewer.md", model: "claude-opus-4-8" }];
  const tree = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], drift: true, files }]),
  );
  const names = findAllMc(tree, (n) => n.props["data-atom"] === "AgentName");

  assert.deepStrictEqual(names.map((n) => n.props.title), ["glass-atrium-qa-code-reviewer"], "the atom gets the agent name");
  assert.ok(!textMc(tree).includes(".md"), "no file extension on screen");
});

// ScreenModelConfig's useState calls in declaration order → a named seed lands in its slot.
const MC_STATE_SLOTS = ["config", "form", "saving", "saveError", "surfaceResults", "refreshTick", "asOfAt", "toast", "discardConfirm"];

async function renderSeededScreenMc(seed: Record<string, unknown>): Promise<McNode[]> {
  let slot = 0;
  const seeded = await loadMcScreens({
    react: {
      useState: (init: unknown) => {
        const name = MC_STATE_SLOTS[slot++];
        const initial = typeof init === "function" ? (init as () => unknown)() : init;
        return [name !== undefined && name in seed ? seed[name] : initial, () => {}];
      },
    },
  });
  return renderComponentMc(seeded.ScreenModelConfig, {});
}

describe("a config read that failed after an earlier read shows the last good read, never an all-clear", () => {
  const data = {
    domains: DOMAIN_ROW_FIXTURE_MC,
    budgets: BUDGET_ROW_FIXTURE_MC,
    known_models: [],
    daemon_config_sync: "ok",
  };
  const form = { models: { "model.dev": "claude-opus-4-8" }, budgets: { "budget.worker_max_usd": "10.00" } };
  const error = "HTTP 500 Internal Server Error";
  const rows = [
    { name: "fresh read", region: { status: "ready", data, error: null, busy: false }, isLastKnown: false },
    { name: "warm error, settled", region: { status: "ready", data, error, busy: false }, isLastKnown: true },
    { name: "warm error, Retry in flight", region: { status: "ready", data, error, busy: true }, isLastKnown: true },
  ];

  for (const row of rows) {
    test(row.name, async () => {
      const config = { ...(realUiMc.INITIAL_REGION_STATE as object), ...row.region };
      const tree = await renderSeededScreenMc({ config, form, asOfAt: Date.now() - 60_000 });
      const [verdict] = findAllMc(tree, (n) => n.props["data-atom"] === "PageVerdict");
      const alerts = findAllMc(tree, (n) => n.props.role === "alert");
      const [card] = findAllMc(alerts, (n) => n.props["data-atom"] === "RegionUnavailable");
      const label = String(verdict?.props["data-verdict-label"]);

      assert.strictEqual(label.startsWith("Last known"), row.isLastKnown, `verdict label: ${label}`);
      assert.strictEqual(verdict?.props["data-verdict-tone"] === "ok", !row.isLastKnown, "only a fresh read is toned ok");
      assert.strictEqual(textMc(alerts).includes("last good read"), row.isLastKnown, "the banner names the held data");
      if (!row.isLastKnown) return;
      assert.strictEqual(card?.props.isBusy, row.region.busy, "the Retry reports its own request");
      assert.strictEqual(card?.props.focusTargetId, "mc-models", "focus lands on the ledger if the card leaves");
    });
  }
});

test("a cap field fits the longest valid cap and is never squeezed by its link", () => {
  const tree = renderComponentMc(screens.BudgetsSectionMC, budgetsPropsMc());
  const [input] = tagsMc(tree, "input");
  const [affix] = findAllMc(tree, (n) => String(n.props.className ?? "").includes("field-affix"));
  const widthCh = Number(/(\d+)ch/.exec(String((input?.props.style as { width?: string })?.width))?.[1]);

  assert.ok(widthCh >= BUDGET_MAX_USD.toFixed(2).length, `field width ${widthCh}ch holds ${BUDGET_MAX_USD.toFixed(2)}`);
  assert.ok(String(affix?.props.className).includes("flex-shrink-0"), "the field keeps its width beside the link");
});

test("a section lead line wraps instead of clipping", () => {
  const tree = renderComponentMc(screens.BudgetsSectionMC, budgetsPropsMc());
  const leads = findAllMc(tree, (n) => String(n.props.className ?? "").includes("card-sub"));

  assert.ok(leads.length > 0, "the caps section carries a lead line");
  assert.ok(leads.every((n) => String(n.props.className).includes("is-wrap")), "every lead line wraps");
});

// Screen-level reads: announcements, stale rows, file lists, rail headings, In-effect sources.

const ALL_TIERS_MC = [
  "model.dev",
  "model.research",
  "model.meta",
  "model.wiki",
  "model.review",
  "model.docs",
  "model.daemon_cycle_worker",
].map((domain) => ({ ...DOMAIN_ROW_FIXTURE_MC[0], domain }));

const SCREEN_DATA_MC = {
  domains: DOMAIN_ROW_FIXTURE_MC,
  budgets: BUDGET_ROW_FIXTURE_MC,
  tiers: TIER_ROW_FIXTURE_MC,
  known_models: [],
  daemon_config_sync: "ok",
};
const SCREEN_FORM_MC = { models: { "model.dev": "claude-opus-4-8" }, budgets: { "budget.worker_max_usd": "10.00" } };

function seededConfigMc(region: Record<string, unknown>): Record<string, unknown> {
  return { ...(realUiMc.INITIAL_REGION_STATE as object), ...region };
}

// The one visually hidden polite region — the toast's own status node is transient and visible.
function announcerMc(tree: McNode[]): McTag[] {
  return findAllMc(
    tree,
    (n) => n.props["aria-live"] === "polite" && String(n.props.className ?? "").includes("sr-only"),
  );
}

describe("a Refresh or Retry result is announced in one polite live region, mounted before the read settles", () => {
  const readAt = Date.now() - 60_000;
  const time = String((realUiMc.formatKstTime as (at: number) => string)(readAt));
  const rows = [
    { name: "first load is not announced", tick: 0, region: { status: "ready", data: SCREEN_DATA_MC, key: "config", busy: false }, says: null },
    { name: "a read in flight says nothing yet", tick: 1, region: { status: "ready", data: SCREEN_DATA_MC, key: "config", busy: true }, says: null },
    { name: "a reload that landed names its read time", tick: 1, region: { status: "ready", data: SCREEN_DATA_MC, key: "config", busy: false }, says: ["reloaded", time] },
    { name: "a failed reload over held data leaves the announcement to the alert card it mounts", tick: 1, region: { status: "ready", data: SCREEN_DATA_MC, key: "config", error: "HTTP 500", busy: false }, says: null },
    { name: "a failed first read says nothing was read", tick: 1, region: { status: "error", data: null, error: "HTTP 500", busy: false }, says: ["Couldn't read"] },
    { name: "a save leaves the announcement to its own toast", tick: 1, region: { status: "ready", data: SCREEN_DATA_MC, key: "save", busy: false }, says: null },
  ];

  for (const row of rows) {
    test(row.name, async () => {
      const tree = await renderSeededScreenMc({
        config: seededConfigMc(row.region),
        form: row.region.data ? SCREEN_FORM_MC : null,
        refreshTick: row.tick,
        asOfAt: row.region.data ? readAt : null,
      });
      const regions = announcerMc(tree);
      assert.strictEqual(regions.length, 1, "exactly one announcer, present in every state");
      assert.strictEqual(regions[0].props.role, "status");
      const said = textMc(regions[0].children);
      if (row.says === null) {
        assert.strictEqual(said, "", `silent: ${said}`);
        return;
      }
      for (const phrase of row.says) assert.ok(said.includes(phrase), `"${said}" names ${phrase}`);
    });
  }
});

test("under a failed reload no row keeps a green 'Matches saved'; the match is dated to the last good read", async () => {
  for (const [name, error, isStale] of [
    ["fresh read", null, false],
    ["warm error", "HTTP 500", true],
  ] as const) {
    const tree = await renderSeededScreenMc({
      config: seededConfigMc({ status: "ready", data: SCREEN_DATA_MC, key: "config", error, busy: false }),
      form: SCREEN_FORM_MC,
      asOfAt: Date.now() - 60_000,
    });
    const bodies = tagsMc(tree, "tbody");
    const rowCount = bodies.flatMap((b) => tagsMc(b.children, "tr")).length;
    const text = textMc(bodies);
    const checks = findAllMc(bodies, (n) => n.props["data-icon"] === "check").length;

    assert.strictEqual(countMc(text, "Matches saved"), isStale ? 0 : rowCount, `${name}: matching rows`);
    assert.strictEqual(checks, isStale ? 0 : rowCount, `${name}: ok glyphs`);
    assert.strictEqual(countMc(text, "Matched at last read"), isStale ? rowCount : 0, `${name}: stale rows dated`);
  }
});

test("the file list toggle shows a chevron and its opened list is never clipped by an inner scroller", () => {
  const files = Array.from({ length: 13 }, (_, i) => ({ file: `agents/glass-atrium-dev-${i}.md`, model: "claude-opus-4-8" }));
  const tree = renderComponentMc(screens.LiveValueMC, { value: "claude-opus-4-8", drift: false, files });
  const [summary] = tagsMc(tree, "summary");
  const [list] = findAllMc(tree, (n) => n.props.role === "region");

  const chevron = tagsMc([summary], "i").find((n) => String(n.props["data-icon"]).startsWith("chevron"));

  assert.ok(chevron, "the pill carries a chevron");
  // the class ui.shared-states.e2e turns over while the disclosure is open
  assert.ok(String(chevron.props.className ?? "").split(/\s+/).includes("chevron"), "the chevron takes the shared open-state turn");
  assert.strictEqual((list.props.style as Record<string, unknown> | undefined)?.maxHeight, undefined, "no height cap");
  assert.ok(!String(list.props.className).includes("overflow-y-auto"), "no inner scroller");
  assert.strictEqual(tagsMc(list.children, "span").length, files.length, "every file is listed");
});

test("the rail labels are headings, and their notes never repeat the agent a row already names", async () => {
  const tree = await renderSeededScreenMc({
    config: seededConfigMc({ status: "ready", data: { ...SCREEN_DATA_MC, domains: ALL_TIERS_MC }, key: "config", busy: false }),
    form: SCREEN_FORM_MC,
    asOfAt: Date.now(),
  });
  const headings = textsMc(tagsMc(tree, "h3"));
  assert.ok(headings.includes("Who each tier covers"), `headings: ${headings}`);
  assert.ok(headings.includes("When a cap trips"), `headings: ${headings}`);

  const notes = textsMc(tagsMc(tree, "dd")).join(" ");
  assert.ok(notes.length > 0, "the notes are rendered");
  assert.ok(!notes.includes("glass-atrium-"), `a note repeats an agent id the row shows: ${notes}`);
});

test("every In-effect cell is filled: a tier without a file list names where its value was read from", () => {
  const tree = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc(ALL_TIERS_MC));
  const bodyRows = tagsMc(tagsMc(tree, "tbody")[0].children, "tr");
  const sources: Record<string, string> = {
    "model.research": "intel-researcher",
    "model.meta": "meta-agent",
    "model.wiki": "wiki-curator",
    "model.daemon_cycle_worker": "daemon-config.json",
  };
  assert.strictEqual(bodyRows.length, ALL_TIERS_MC.length);
  for (const [domain, source] of Object.entries(sources)) {
    const row = bodyRows[ALL_TIERS_MC.findIndex((tier) => tier.domain === domain)];
    const live = textMc([tagsMc(row.children, "td")[2]]);
    assert.ok(live.includes("Read from"), `${domain}: names its source (${live})`);
    assert.ok(live.includes(source), `${domain}: reads from ${source} (${live})`);
  }

  const cap = textMc([liveCellMc(renderComponentMc(screens.BudgetsSectionMC, budgetsPropsMc()))]);
  assert.ok(cap.includes("Read from daemon-config.json"), `a cap names its source (${cap})`);
});

test("a sourced In-effect cell with no live value names the source without claiming it was read", () => {
  const unread = ALL_TIERS_MC.map((tier) => ({ ...tier, actual: null, drift: false }));
  const tree = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc(unread));
  const bodyRows = tagsMc(tagsMc(tree, "tbody")[0].children, "tr");
  const cells = [
    ...["model.research", "model.meta", "model.wiki", "model.daemon_cycle_worker"].map((domain) =>
      [domain, textMc([tagsMc(bodyRows[unread.findIndex((tier) => tier.domain === domain)].children, "td")[2]])] as const),
    ["budget.worker_max_usd", textMc([liveCellMc(renderComponentMc(
      screens.BudgetsSectionMC,
      budgetsPropsMc([{ ...BUDGET_ROW_FIXTURE_MC[0], actual: null, drift: false }]),
    ))])] as const,
  ];
  for (const [domain, live] of cells) {
    assert.ok(live.startsWith("No value read from"), `${domain}: says nothing was read (${live})`);
    assert.ok(!live.includes("Matches saved"), `${domain}: an unread value never reads as matching (${live})`);
  }
});
