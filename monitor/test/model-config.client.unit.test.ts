// Unit tests for the client-side pure logic in public/src/screens/model-config.jsx
// (validateFormMC / diffFormMC / buildFormMC / sortDomainsMC / sortBudgetsMC). The server PUT contract is covered by model-config.route.test.ts;
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
  const rows = [
    { name: "a bracketed variant suffix", value: "claude-fable-5[1m]" },
    { name: "a dotted custom id", value: "valid-custom.id" },
    { name: "an upper-case letter", value: "Bad-Upper" },
    { name: "a space", value: "white space" },
    { name: "letters and digits only", value: "ok123" },
    { name: "a leading hyphen", value: "-x" },
    { name: "a leading bracket", value: "[1m]" },
  ];
  for (const row of rows) {
    const clientErr = !!sameRealm(
      mc.validateFormMC({ models: { "model.daemon_cycle_worker": row.value }, budgets: {} }, KNOWN_MODELS_FIXTURE),
    )["model.daemon_cycle_worker"];
    const serverOk = FREE_TEXT_MODEL_PATTERN.test(row.value);
    assert.strictEqual(clientErr, !serverOk, `client/server agree on ${row.name} '${row.value}'`);
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

// --- validateFormMC: client mirror of the server PUT contract ---
// NOTE: no client-side bare-alias reject mirror — the server is the validation
// authority for the alias 400 (plan Non-Goals); covered by model-config.route.test.ts.

test("validateFormMC: a valid known id + valid 2-decimal budget → no errors", () => {
  const errors = sameRealm(
    mc.validateFormMC(
      {
        models: { "model.daemon_cycle_worker": "claude-opus-4-8" },
        budgets: { "budget.worker_max_usd": "0.50" },
      },
      KNOWN_MODELS_FIXTURE,
    ),
  );
  assert.deepStrictEqual(errors, {});
});

test("validateFormMC: empty model value → 'Enter a model id'", () => {
  const errors = sameRealm(
    mc.validateFormMC({ models: { "model.daemon_cycle_worker": "" }, budgets: {} }, KNOWN_MODELS_FIXTURE),
  );
  assert.ok(errors["model.daemon_cycle_worker"], "empty model flagged");
});

test("validateFormMC: uppercase free-text model → format error (mirrors FREE_TEXT regex)", () => {
  const errors = sameRealm(
    mc.validateFormMC({ models: { "model.daemon_cycle_worker": "Claude-Custom" }, budgets: {} }, KNOWN_MODELS_FIXTURE),
  );
  assert.ok(errors["model.daemon_cycle_worker"], "uppercase rejected by client regex");
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

describe("validateFormMC: a field alert fits the 160 control slot", () => {
  const rows: Array<{ name: string; form: McForm; key: string }> = [
    { name: "empty model", form: { models: { "model.daemon_cycle_worker": "" }, budgets: {} }, key: "model.daemon_cycle_worker" },
    { name: "free-text model off the id pattern", form: { models: { "model.daemon_cycle_worker": "Claude-Custom" }, budgets: {} }, key: "model.daemon_cycle_worker" },
    { name: "cap off the two-decimal form", form: { models: {}, budgets: { "budget.worker_max_usd": "1.234" } }, key: "budget.worker_max_usd" },
    { name: "cap outside the bounds", form: { models: {}, budgets: { "budget.worker_max_usd": "50.01" } }, key: "budget.worker_max_usd" },
    { name: "effort off the level list", form: { models: {}, budgets: {}, tiers: { "tier.worker_effort": "ultra" } }, key: "tier.worker_effort" },
    { name: "output tokens off the whole-number form", form: { models: {}, budgets: {}, tiers: { "tier.worker_max_output_tokens": "0" } }, key: "tier.worker_max_output_tokens" },
  ];
  for (const row of rows) {
    test(`${row.name}: the alert holds the 12-word bar`, () => {
      const message = sameRealm(mc.validateFormMC(row.form, KNOWN_MODELS_FIXTURE))[row.key];
      assert.ok(message, "the field is flagged");
      assert.ok(message.split(/\s+/).length <= 12, `'${message}'`);
    });
  }

  test("the format alerts read as the short range forms", () => {
    const cap = sameRealm(mc.validateFormMC(rows[2].form, []))[rows[2].key];
    const tokens = sameRealm(mc.validateFormMC(rows[5].form, []))[rows[5].key];
    assert.deepStrictEqual([cap, tokens], ["Two decimals, $0.05 to $50.00", "Whole number, 1 to 999999, or blank"]);
  });
});

// --- diffFormMC: partial-PUT payload builder (only changed fields, null when none) ---

test("diffFormMC: no change → null (clean state — save-banner hidden, Save dormant not error-disabled)", () => {
  const baseline = { models: { "model.daemon_cycle_worker": "claude-opus-4-8" }, budgets: { "budget.worker_max_usd": "0.50" } };
  const result = mc.diffFormMC(baseline, { models: { ...baseline.models }, budgets: { ...baseline.budgets } });
  assert.strictEqual(result, null);
});

test("diffFormMC: only the changed model field is sent (partial contract)", () => {
  const baseline = { models: { "model.daemon_cycle_worker": "claude-opus-4-8" }, budgets: { "budget.worker_max_usd": "0.50" } };
  const form = { models: { "model.daemon_cycle_worker": "claude-fable-5" }, budgets: { "budget.worker_max_usd": "0.50" } };
  const result = sameRealm(mc.diffFormMC(baseline, form)) as { models?: Record<string, string>; budgets?: unknown };
  assert.deepStrictEqual(result.models, { "model.daemon_cycle_worker": "claude-fable-5" });
  assert.ok(!("budgets" in result), "unchanged budgets omitted");
});

test("diffFormMC: model + budget both changed → both keys present", () => {
  const baseline = { models: { "model.daemon_cycle_worker": "claude-opus-4-8" }, budgets: { "budget.worker_max_usd": "0.50" } };
  const form = { models: { "model.daemon_cycle_worker": "claude-fable-5" }, budgets: { "budget.worker_max_usd": "0.75" } };
  const result = sameRealm(mc.diffFormMC(baseline, form)) as { models?: unknown; budgets?: unknown };
  assert.deepStrictEqual(result.models, { "model.daemon_cycle_worker": "claude-fable-5" });
  assert.deepStrictEqual(result.budgets, { "budget.worker_max_usd": "0.75" });
});

// --- buildFormMC: GET response → edit buffer (desired mirror) ---

test("buildFormMC: maps domains/budgets/tiers desired into the form buffer", () => {
  const data = {
    domains: [{ domain: "model.daemon_cycle_worker", desired: "claude-opus-4-8" }],
    budgets: [
      { domain: "budget.worker_max_usd", desired: "0.50" },
      { domain: "budget.pre_verify_max_usd", desired: null },
    ],
    tiers: [
      { domain: "tier.worker_effort", desired: "high" },
      { domain: "tier.pre_verify_max_output_tokens", desired: null },
    ],
  };
  const form = sameRealm(mc.buildFormMC(data));
  assert.strictEqual(form.models["model.daemon_cycle_worker"], "claude-opus-4-8");
  assert.strictEqual(form.budgets["budget.worker_max_usd"], "0.50");
  assert.strictEqual(form.budgets["budget.pre_verify_max_usd"], "", "null desired → empty string buffer");
  assert.strictEqual(form.tiers?.["tier.worker_effort"], "high");
  assert.strictEqual(form.tiers?.["tier.pre_verify_max_output_tokens"], INHERIT_VALUE, "an unset knob is the CLI default");
});

// --- sortDomainsMC / sortBudgetsMC: known order first, unknown appended (no silent drop) ---

test("sortDomainsMC: canonical order applied, an unknown domain is appended (never dropped)", () => {
  const input = [{ domain: "model.future_unknown" }, { domain: "model.daemon_cycle_worker" }];
  const sorted = sameRealm(mc.sortDomainsMC(input)).map((d) => d.domain);
  assert.deepStrictEqual(
    sorted,
    ["model.daemon_cycle_worker", "model.future_unknown"],
    "DOMAIN_ORDER_MC order applied, unknown appended last (never dropped)",
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
const TONE_GLYPH_MC = realUiMc.TONE_GLYPH as Record<string, string>;

// The drawer body rides in a marked slot → face text and drawer text stay separately readable.
function cardHeadStubMc(p: Record<string, unknown>): McElement {
  return hMc(
    "div",
    { className: "card-head" },
    hMc("h2", { className: "card-title" }, p.title),
    p.sub ? hMc("span", { className: "card-sub", title: p.sub }, p.sub) : null,
    p.info ? hMc("div", { "data-slot": "card-info", "data-info-label": p.infoLabel ?? "How this is counted" }, p.info) : null,
    p.right,
  );
}

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
    PageHeader: (p: Record<string, unknown>) =>
      hMc("header", { className: "page-header" }, p.sub, p.actions, p.freshness, p.range, p.refresh),
    Icon: (p: Record<string, unknown>) => hMc("i", { "data-icon": p.name, className: p.className }),
    DisclosureChevron: () => hMc("i", { "data-icon": "chevR", className: "disclosure-chevron" }),
    TypeScaleStyle: () => null,
    MachineString: (p: Record<string, unknown>) => hMc("code", { "data-atom": "MachineString" }, p.children),
    Link: (p: Record<string, unknown>) => {
      const { children, ...rest } = p;
      return hMc("a", { ...rest, "data-atom": "Link" }, children);
    },
    // the atom's shape: label (sr-only when hidden) · select with rest props, error edge and per-option titles · entry slot
    Select: (p: Record<string, unknown>) => {
      const { id, label, value, options, onChange, isLabelHidden, isError, className, children, ...rest } = p;
      const onSelect = onChange as (value: string) => void;
      return hMc(
        "div",
        { "data-atom": "Select", className },
        hMc("label", { htmlFor: id, className: isLabelHidden ? "sr-only" : "field-label" }, label),
        hMc(
          "select",
          {
            ...rest,
            id,
            value,
            className: `field field-select${isError ? " is-error" : ""}`,
            "aria-invalid": isError ? "true" : undefined,
            onChange: (event: { target: { value: string } }) => onSelect(event.target.value),
          },
          ...(options as Array<{ key: string; label: string; title?: string }>).map((o) =>
            hMc("option", { key: o.key, value: o.key, title: o.title }, o.label),
          ),
        ),
        children,
      );
    },
    Badge: (p: Record<string, unknown>) =>
      hMc("span", { className: `badge ${p.className ?? ""}`.trim(), "data-tone": p.tone ?? "neutral" }, p.children),
    CardHead: cardHeadStubMc,
    Card: (p: Record<string, unknown>) =>
      hMc(
        "div",
        { className: "card", "data-atom": "Card", "data-size": p.size },
        p.title ? hMc(cardHeadStubMc, { title: p.title, sub: p.sub, info: p.info, infoLabel: p.infoLabel, right: p.right }) : null,
        hMc("div", { className: "card-body" }, p.children),
        p.foot ? hMc("div", { className: "card-foot" }, p.foot) : null,
      ),
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
    // the atom's wide mode: caption · colgroup from widths · thead of TableHeads from columns · one tbody per body,
    // a `(view) => rows` body called with the wide view
    Table: (p: Record<string, unknown>) => {
      const columns = (p.columns ?? []) as Array<{ key: string; label: unknown }>;
      const bodies = (p.bodies ?? []) as Array<{ key: string; rows: unknown; isBusy?: boolean }>;
      const view = { isStacked: false, columnCount: columns.length || ((p.widths ?? []) as string[]).length };
      return hMc(
        "table",
        { className: `tbl ${p.className ?? ""}`.trim(), "data-atom": "Table" },
        hMc("caption", { className: "sr-only" }, p.caption),
        p.widths ? hMc("colgroup", null, ...(p.widths as string[]).map((width) => hMc("col", { style: { width } }))) : null,
        // the atom renders no thead when columns are omitted
        p.columns ? hMc("thead", null, hMc("tr", null, ...columns.map((c) => hMc("th", { "data-atom": "TableHead" }, c.label)))) : null,
        ...bodies.map((b) =>
          hMc("tbody", { "aria-busy": b.isBusy ? "true" : undefined }, typeof b.rows === "function" ? (b.rows as (v: unknown) => unknown)(view) : b.rows),
        ),
      );
    },
    TableRow: ({ view: _view, children, ...rest }: Record<string, unknown>) => hMc("tr", rest, children),
    // a span cell covers the row from its start column, as the atom's colSpan does
    TableCell: ({ view, kind, start = 0, children, className }: Record<string, unknown>) =>
      hMc(
        "td",
        { className, colSpan: kind === "span" ? Math.max(1, Number((view as { columnCount?: number })?.columnCount ?? 0) - Number(start)) : undefined },
        children,
      ),
    AgentName: (p: Record<string, unknown>) =>
      hMc("span", { "data-atom": "AgentName", title: p.name }, getAgentDisplayNameMc(p.name)),
    formatKstTime: realUiMc.formatKstTime,
    getDisplayName: realUiMc.getDisplayName,
    SplitRow: (p: Record<string, unknown>) =>
      hMc("div", { "data-atom": "SplitRow", "data-ratio": p.ratio, "data-layout": p.layout }, p.children),
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
    TONE_GLYPH: realUiMc.TONE_GLYPH,
    // tone and surface stay readable; the slots render as walkable children, the raw detail behind a Details fold as in the atom
    AlertCard: (p: Record<string, unknown>) =>
      hMc(
        "div",
        { "data-atom": "AlertCard", "data-tone": p.tone, "data-surface": p.surface ?? "raised" },
        p.title,
        p.body,
        p.details ? hMc("details", null, p.details) : null,
        p.actions,
      ),
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
    domain: "model.daemon_cycle_worker",
    desired: "claude-opus-4-8",
    actual: "claude-opus-4-8",
    drift: false,
    apply_mode: "next-cycle",
    editable: true,
    pricing_known: true,
  },
];

function domainsPropsMc(domains: unknown[] = DOMAIN_ROW_FIXTURE_MC): Record<string, unknown> {
  const form = { models: { "model.daemon_cycle_worker": "claude-opus-4-8" }, budgets: {} };
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
  assert.ok(textsMc(tagsMc(tree, "caption")).length > 0, "the table caption readable");
  assert.strictEqual(tagsMc(tree, "select").length, 1, "the editable row's select is reachable");
  // Text: row content from the fixture, not from a copy of the component.
  assert.ok(textMc(tree).includes("Self-improve and wiki compile"), "row label rendered from DOMAIN_META_MC");
  assert.strictEqual(tagsMc(tree, "select")[0].props.value, "claude-opus-4-8", "the fixture value reaches the select");
});

test("render harness: the tree tracks the props it was given, not a fixed snapshot", async () => {
  const empty = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc([]));
  assert.strictEqual(tagsMc(empty, "select").length, 0, "no rows → no controls");
  assert.ok(!textMc(empty).includes("Self-improve and wiki compile"), "no rows → no row label");
});

test("DomainsSectionMC loading skeleton reserves one placeholder row per server model domain", async () => {
  const loading = renderComponentMc(screens.DomainsSectionMC, { ...domainsPropsMc([]), state: "loading" });
  const [busy] = findAllMc(loading, (n) => n.props["aria-busy"] === "true");
  assert.ok(busy, "loading placeholder rendered");
  assert.strictEqual(busy.children.length, MODEL_DOMAINS.length);
});

test("every server model domain has a client slot: its row reads as a label, never the raw key", () => {
  const rows = MODEL_DOMAINS.map((d) => ({ ...DOMAIN_ROW_FIXTURE_MC[0], domain: d.key }));
  const text = textMc(renderComponentMc(screens.DomainsSectionMC, domainsPropsMc(rows)));
  for (const def of MODEL_DOMAINS) assert.ok(!text.includes(def.key), `${def.key}: labelled by DOMAIN_META_MC`);
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

// a daemon row's line slot under its control — what is in effect, rejected or unread lands here, nowhere else in the row
const lineSlotMc = (tree: McNode[], rowText: string): string => {
  const row = tagsMc(tree, "tr").find((tr) => textMc(tr.children).includes(rowText));
  assert.ok(row, `the '${rowText}' row is rendered`);
  const [slot] = findAllMc(row.children, (n) => n.props["data-slot"] === "line-slot");
  assert.ok(slot, `the '${rowText}' row has its line slot`);
  return textMc(slot.children);
};

describe("a knob with no key in the file stays silent when the file was read and says no value was read otherwise", () => {
  const rows = [
    { name: "a read file: silence, never an unread value", isFileRead: true, isCliDefault: true },
    { name: "a missing file: an unread value, never the CLI default", isFileRead: false, isCliDefault: false },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = renderComponentMc(screens.TiersSectionMC, { ...tiersPropsMc(), isFileRead: row.isFileRead });
      const live = lineSlotMc(tree, "Generation effort");
      assert.strictEqual(live === "", row.isCliDefault, live);
      assert.strictEqual(live.includes("No value read"), !row.isCliDefault, live);
    });
  }
});

test("a knob whose file value the daemon rejects says so under its control with the reason, never a match or the CLI default", () => {
  const rejected = { ...TIER_ROW_FIXTURE_MC[0], file_error: '"ultra" is not a valid tier (allowed: low, medium, high, xhigh, max)' };
  const tree = renderComponentMc(screens.TiersSectionMC, { ...tiersPropsMc(), tiers: [rejected, ...TIER_ROW_FIXTURE_MC.slice(1)] });
  const live = lineSlotMc(tree, "Generation effort");
  assert.ok(live.includes("File value rejected"), `the rejection is worded: ${live}`);
  assert.ok(live.includes('"ultra"'), `the rejected value is named: ${live}`);
  assert.ok(!live.includes("In effect") && !live.includes("CLI default"), live);
});

const tonedMc = (nodes: McNode[], tone: string): McTag[] =>
  findAllMc(nodes, (n) => n.props["data-tone"] === tone);

test("the three daemon tables are label and control only — no head row, no In effect column", () => {
  for (const [name, props] of [
    ["DomainsSectionMC", domainsPropsMc()],
    ["BudgetsSectionMC", budgetsPropsMc()],
    ["TiersSectionMC", tiersPropsMc()],
  ] as const) {
    const tree = renderComponentMc(screens[name], props);
    assert.strictEqual(tagsMc(tree, "th").length, 0, `${name}: no head row`);
    const rows = tagsMc(tree, "tr");
    assert.ok(rows.length > 0, `${name}: rows render`);
    for (const tr of rows) assert.strictEqual(tagsMc(tr.children, "td").length, 2, `${name}: '${textMc(tr.children)}' has two cells`);
    assert.ok(!textMc(tree).includes("In effect"), `${name}: nothing in effect differs at rest`);
  }
});

const iconsMc = (nodes: McNode[], name: string): McTag[] => findAllMc(nodes, (n) => n.props["data-icon"] === name);

test("a row in its steady state shows no mark; only a drifted row raises one warn glyph and the value in effect under its control", () => {
  const steady = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc());
  assert.strictEqual(iconsMc(steady, "check").length, 0, "agreement is silence");
  assert.strictEqual(iconsMc(steady, "warn").length, 0, "nothing to warn about");

  const drifted = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], actual: "claude-sonnet-5", drift: true }]),
  );
  assert.strictEqual(iconsMc(drifted, "warn").length, 1, "exactly one warn glyph per drifted row");
  assert.strictEqual(tonedMc(drifted, "warn").length, 0, "the drift mark is glyph + word, not a badge");
  const live = lineSlotMc(drifted, "Self-improve and wiki compile");
  const getDisplayName = realUiMc.getDisplayName as (kind: string, id: string) => string | null;
  assert.ok(live.includes(`In effect: ${getDisplayName("model", "claude-sonnet-5")}`), `the value in effect is named by its display name: ${live}`);
});

test("a listed model shows its name only; its id rides the select tooltip, never a second line", () => {
  const tree = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc());
  const row = tagsMc(tree, "tr").find((tr) => tagsMc(tr.children, "select").length > 0);
  assert.ok(row, "an editable domain row is rendered");
  const [select] = tagsMc(row.children, "select");
  const id = String(select.props.value);
  assert.match(id, /^claude-(opus|sonnet|haiku)-/, "the fixture holds a listed family id");

  assert.strictEqual(select.props.title, id, "the id is the select's tooltip");
  assert.ok(!textMc(tagsMc(row.children, "td")[1].children).includes(id), "the id is not printed under the name");
});

test("an apply_mode the screen does not map is stated verbatim as the take-effect mode", () => {
  const unknown = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], apply_mode: "some-future-mode" }]),
  );
  assert.ok(textMc(unknown).includes("some-future-mode"), "an unmapped mode is shown verbatim");
});

test("an empty roster says so; it never renders as a table with nothing in it", () => {
  const tree = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc([]));
  assert.strictEqual(tagsMc(tree, "tr").length, 1, "the empty-state row alone — no head row");
  assert.ok(textMc(tree).includes("No model domains reported"), "empty is stated, not implied");
});

test("section headers survive every state, and a non-ready body never reads as zero rows", () => {
  for (const name of ["DomainsSectionMC", "BudgetsSectionMC"] as const) {
    const props = name === "DomainsSectionMC" ? domainsPropsMc() : budgetsPropsMc();
    const label = textMc(
      findAllMc(renderComponentMc(screens[name], { ...props, state: "ready" }), (n) =>
        String(n.props.className ?? "").includes("card-head"),
      ),
    );
    assert.ok(label.length > 0, `${name}: section header present when ready`);

    const ready = renderComponentMc(screens[name], { ...props, state: "ready" });
    const loading = renderComponentMc(screens[name], { ...props, state: "loading" });
    const columnsOf = (tree: McNode[]) => tagsMc(tree, "col").map((c) => JSON.stringify(c.props.style));
    assert.ok(textMc(loading).startsWith(label), `${name}: section header unchanged while loading`);
    assert.deepStrictEqual(
      columnsOf(loading),
      columnsOf(ready),
      `${name}: the skeleton sits on the real column grid, so nothing shifts when rows land`,
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

test("the header sync token speaks only when the file needs action and leaves the as-of stamp to the shared atom", () => {
  const ready = renderComponentMc(screens.SyncTokenMC, {
    state: "ready",
    sync: "ok",
  });
  assert.deepStrictEqual(ready, [], "a file in sync is agreement, so the token renders nothing");

  const drifted = renderComponentMc(screens.SyncTokenMC, {
    state: "ready",
    sync: "drift",
  });
  assert.ok(textMc(drifted).includes("Drift"), "the state is named in plain text");
  assert.ok(!textMc(drifted).includes("as of"), "the header freshness atom owns the stamp, not the token");
  assert.strictEqual(tagsMc(drifted, "i").length, 1, "tone rides the glyph, not the text");

  // Loading and error are distinct readings — neither may look like a settled 'in sync'.
  const unavailable = textMc(renderComponentMc(screens.SyncTokenMC, { state: "error", sync: undefined }));
  assert.ok(unavailable.includes("unavailable") && !unavailable.includes("In sync"), "error never reads as in sync");
  // the stamp beside it already reads '… loading' → the token adds no second ellipsis
  assert.strictEqual(textMc(renderComponentMc(screens.SyncTokenMC, { state: "loading", sync: undefined })), "");
});

test("a warm read error puts the shared 'Last known' prefix on an alarm and keeps an in-sync file silent", () => {
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

  assert.strictEqual(tokenFor("ok", "HTTP 500"), "", "a stale in-sync read claims nothing, so it has nothing to date");
  assert.strictEqual(tokenFor("drift", null), "Drift", "a fresh alarm keeps its state word");
  assert.strictEqual(tokenFor("drift", "HTTP 500"), "Last known: Drift", "a stale alarm keeps its word behind the shared prefix");
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

test("a save raises the result card only when daemon-config.json did not write cleanly", () => {
  const getProblem = sandboxFnMc<(d: unknown) => unknown>("getSurfaceProblemMC");
  const written = { surface: "daemon-config.json", status: "ok" };
  const failed = { surface: "daemon-config.json", status: "failed", reason: "write failed" };
  assert.strictEqual(getProblem({ surfaces: [written] }), null, "a clean write raises no card");
  assert.strictEqual(getProblem({ surfaces: [] }), null, "a save with no config change raises no card");
  assert.deepStrictEqual(sameRealm(getProblem({ surfaces: [failed] })), failed, "the failed write is the card's result");

  const card = renderComponentMc(screens.SurfaceResultCardMC, { result: failed, onDismiss: () => {} });
  assert.deepStrictEqual(tagsMc(card, "details"), [], "one result, nothing folded");
  assert.ok(textMc(card).includes("write failed"), "the failed write's reason is shown");
});

describe("a save-result row reads as words: status in plain words, mono only on the surface id", () => {
  const rows = [
    { name: "a written surface", result: { surface: "daemon-config.json", status: "ok" }, word: "Written", reason: null },
    { name: "a skipped surface", result: { surface: "daemon-config.json", status: "skipped", reason: "not written" }, word: "Skipped", reason: "not written" },
    { name: "a failed surface", result: { surface: "daemon-config.json", status: "failed", reason: "unreadable/unparseable — not overwritten" }, word: "Failed", reason: "unreadable/unparseable — not overwritten" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = renderComponentMc(screens.SurfaceResultRowMC, { result: row.result });
      const text = textMc(tree);
      const mono = findAllMc(tree, (n) => n.props["data-atom"] === "MachineString");

      assert.ok(text.includes(row.word), `status reads "${row.word}"`);
      assert.ok(!text.includes(row.result.status), "the raw status token is not shown");
      assert.deepStrictEqual(mono.map((n) => textMc(n.children)), [row.result.surface], "mono covers the surface id alone");
      const reasons = findAllMc(tree, (n) => String(n.props.className ?? "").includes("text-faint")).map((n) => textMc(n.children));
      assert.deepStrictEqual(reasons, row.reason === null ? [] : [row.reason], "the reason shows exactly when the row carries one");
    });
  }
});

test("a read-only model row with no saved value renders no placeholder badge", () => {
  const readOnly = [{ ...DOMAIN_ROW_FIXTURE_MC[0], desired: "", actual: null, editable: false }];
  const props = domainsPropsMc(readOnly);
  (props.form as { models: Record<string, string> }).models["model.daemon_cycle_worker"] = "";
  const tree = renderComponentMc(screens.DomainsSectionMC, props);
  const modelCell = tagsMc(tree, "td")[1];
  const face = modelCell.children.filter((n) => typeof n === "string" || n.props["data-slot"] !== "line-slot");

  assert.strictEqual(textMc(face), "", "the empty model value stays empty above its line slot");
});

test("the unsaved-changes count equals the field count the partial PUT sends", () => {
  const count = sandboxFnMc<(p: unknown) => number>("countChangesMC");
  const baseline = {
    models: { "model.daemon_cycle_worker": "claude-opus-4-8" },
    budgets: { "budget.worker_max_usd": "10.00" },
    tiers: { "tier.worker_effort": "inherit", "tier.pre_verify_effort": "high" },
  };
  const form = {
    models: { "model.daemon_cycle_worker": "claude-fable-5" },
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
      { domain: "model.daemon_cycle_worker", desired: dev },
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
    models: { "model.daemon_cycle_worker": "claude-sonnet-4-6", "model.dp": "claude-sonnet-4-6" },
    budgets: { "budget.worker_max_usd": "3.00" },
    tiers: { "tier.worker_effort": "xhigh", "tier.worker_max_output_tokens": "8000" },
  };

  assert.deepStrictEqual(sameRealm(getRefreshedForm(edited, prevRead, nextRead)), {
    models: { "model.daemon_cycle_worker": "claude-sonnet-4-6", "model.dp": "claude-haiku-4-5" },
    budgets: { "budget.worker_max_usd": "3.00" },
    tiers: { "tier.worker_effort": "xhigh", "tier.worker_max_output_tokens": "16000" },
  });
  assert.deepStrictEqual(
    sameRealm(getRefreshedForm(null, null, nextRead)),
    {
      models: { "model.daemon_cycle_worker": "claude-opus-5", "model.dp": "claude-haiku-4-5" },
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

describe("a config banner is the shared alert card, its tone never painted on a local tinted shell", () => {
  const rows = [
    { name: "drift warns", tone: "warn", render: () => renderComponentMc(screens.DriftBannerMC, { sync: "drift", onResync: () => {} }) },
    {
      name: "a failed save is critical",
      tone: "crit",
      render: () => renderComponentMc(screens.ErrorBannerMC, { title: "Couldn't save changes", detail: "HTTP 500", onRetry: () => {} }),
    },
  ];

  for (const row of rows) {
    test(row.name, () => {
      const tree = row.render();
      const cards = findAllMc(tree, (n) => n.props["data-atom"] === "AlertCard");
      const tinted = findAllMc(tree, (n) => n.props.style !== undefined);

      assert.deepStrictEqual(cards.map((n) => n.props["data-tone"]), [row.tone], "one alert card in the banner's tone");
      assert.strictEqual(cards[0]?.props["data-surface"], "raised", "a page-level banner is a raised card");
      assert.strictEqual(tinted.length, 0, "no element carries its own tint or tone border");
    });
  }
});

test("the drift banner triggers on any drifted row of any group, not on the file state alone", () => {
  const hasDrift = sandboxFnMc<(data: unknown) => boolean>("hasRowDriftMC");
  assert.strictEqual(hasDrift({ domains: [], budgets: [], tiers: [] }), false, "nothing drifted → no trigger");
  assert.strictEqual(
    hasDrift({ domains: [{ domain: "model.daemon_cycle_worker", drift: true }], budgets: [] }),
    true,
    "one drifted model row raises it on its own",
  );
  assert.strictEqual(
    hasDrift({ domains: [], budgets: [{ domain: "budget.worker_max_usd", drift: true }] }),
    true,
    "one drifted budget row raises it on its own",
  );
  assert.strictEqual(
    hasDrift({ domains: [], budgets: [], tiers: [{ domain: "tier.worker_effort", drift: true }] }),
    true,
    "one drifted tier row raises it on its own",
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
      { domain: "model.daemon_cycle_worker", desired: "claude-opus-4-8", actual: "stale", drift: true },
      { domain: "model.future_unknown", desired: "claude-haiku-4-8", actual: "claude-haiku-4-8", drift: false },
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
    { "model.daemon_cycle_worker": "claude-opus-4-8" },
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

  const edited = buildResync(data, { models: { "model.future_unknown": "claude-sonnet-4-8" } });
  assert.strictEqual(
    edited?.models?.["model.future_unknown"],
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

// The line slot of the first body row — under its control, where a differing or unread value lands.
function liveCellMc(tree: McNode[]): McTag {
  const bodyRow = tagsMc(tagsMc(tree, "tbody")[0].children, "tr")[0];
  const [slot] = findAllMc(bodyRow.children, (n) => n.props["data-slot"] === "line-slot");
  assert.ok(slot, "the first row has its line slot");
  return slot;
}

test("Live repeats nothing in the steady state and shows the value only when it differs", () => {
  for (const [name, props, drifted] of [
    ["DomainsSectionMC", domainsPropsMc(), domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], actual: "claude-sonnet-5", drift: true }])],
    ["BudgetsSectionMC", budgetsPropsMc(), budgetsPropsMc([{ ...BUDGET_ROW_FIXTURE_MC[0], actual: "12.00", drift: true }])],
  ] as const) {
    const steady = liveCellMc(renderComponentMc(screens[name], props));
    assert.strictEqual(textMc([steady]).trim(), "", `${name}: a matching live value adds no words`);

    const differs = textMc([liveCellMc(renderComponentMc(screens[name], drifted))]);
    assert.ok(!differs.includes("Matches saved"), `${name}: a differing value never reads as matching`);
    assert.ok(/Sonnet 5|\$12\.00/.test(differs), `${name}: the differing value is shown: ${differs}`);
  }
});

test("an inherit live value names what it inherits from, never a bare 'inherit'", () => {
  const actual = "inherit (settings.json)";
  const tree = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], actual, drift: true }]),
  );
  const live = textMc([liveCellMc(tree)]);
  assert.ok(live.includes("settings.json model"), `${actual}: names the settings.json model`);
  assert.notStrictEqual(live.replace(/\s*drift$/, ""), actual, `${actual}: not shown raw`);
});

test("the three daemon tables sit on one two-column grid, so their controls share both edges", () => {
  const gridOf = (tree: McNode[]): string =>
    JSON.stringify(tagsMc(tree, "col").map((c) => c.props.style ?? c.props.width));
  const domains = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc());
  const budgets = renderComponentMc(screens.BudgetsSectionMC, budgetsPropsMc());
  const tiers = renderComponentMc(screens.TiersSectionMC, tiersPropsMc());
  assert.strictEqual(tagsMc(domains, "col").length, 2, "label and control columns");
  assert.strictEqual(gridOf(domains), gridOf(budgets), "identical column widths in the model and cap tables");
  assert.strictEqual(gridOf(domains), gridOf(tiers), "identical column widths in the model and tier tables");
  for (const tree of [domains, budgets, tiers]) {
    const [table] = tagsMc(tree, "table");
    assert.strictEqual(table.props["data-atom"], "Table", "the ledger is the Table atom");
    assert.ok(String(table.props.className).split(/\s+/).includes("table-fixed"), "widths come from the grid, not the content");
  }
});

test("all three tier tables take the shared .tbl geometry in the house face, with no cell padding of their own", () => {
  const PADDING_KEYS_MC = /^padding/i;
  const PADDING_CLASS_MC = /(^|\s)-?(p|px|py|pt|pb|pl|pr|ps|pe)-/;
  for (const [name, props] of [
    ["DomainsSectionMC", domainsPropsMc()],
    ["BudgetsSectionMC", budgetsPropsMc()],
    ["TiersSectionMC", tiersPropsMc()],
  ] as const) {
    const tree = renderComponentMc(screens[name], props);
    const [table] = tagsMc(tree, "table");
    const tableClasses = String(table.props.className).split(/\s+/);
    assert.strictEqual(table.props["data-atom"], "Table", `${name}: the ledger is the Table atom`);
    assert.ok(tableClasses.includes("tbl") && !tableClasses.includes("tbl--own-face"), `${name}: a house .tbl table — no own-face modifier, so the face stays`);
    const cells = tagsMc(tree, "td");
    assert.ok(cells.length >= 2, `${name}: a ready row renders its cells`);
    for (const cell of cells) {
      const style = (cell.props.style ?? {}) as Record<string, unknown>;
      const own = Object.keys(style).filter((key) => PADDING_KEYS_MC.test(key));
      assert.deepStrictEqual(own, [], `${name}: '${textMc(cell.children)}' carries no inline padding — .tbl sets it`);
      assert.ok(!PADDING_CLASS_MC.test(String(cell.props.className ?? "")), `${name}: no padding utility on '${textMc(cell.children)}'`);
    }
  }
});

// the daemon row plus two domains the server added before the client → fallback meta
const THREE_TIERS_MC = ["model.daemon_cycle_worker", "model.future_a", "model.future_b"].map((domain) => ({
  ...DOMAIN_ROW_FIXTURE_MC[0],
  domain,
}));

test("each ledger is an h2 section with a captioned table, so the outline never skips h1 to h3", () => {
  for (const [name, props, title] of [
    ["DomainsSectionMC", domainsPropsMc(), "Daemon model"],
    ["BudgetsSectionMC", budgetsPropsMc(), "Per-call budget caps"],
  ] as const) {
    const tree = renderComponentMc(screens[name], props);
    assert.deepStrictEqual(textsMc(tagsMc(tree, "h2")), [title], `${name}: one h2 naming the section`);
    assert.strictEqual(textsMc(tagsMc(tree, "caption")).length, 1, `${name}: the table is named by a caption`);
  }
});

test("tier notes show one unfolded entry per described tier", () => {
  const [domainMeta] = vm.runInContext("[DOMAIN_META_MC]", screens) as Array<Record<string, unknown>>;
  const rows = Object.values(domainMeta);
  const tree = renderComponentMc(screens.TierNotesMC, { title: "Who each tier covers", rows });
  assert.strictEqual(tagsMc(tree, "details").length, 0, "the notes are not folded away");
  assert.strictEqual(tagsMc(tree, "dt").length, rows.length, "one entry per tier");
  assert.ok(textMc(tree).includes("self-improve proposals"), "every description stays reachable");
});

test("the call-tier notes draw the CLI flag and the env variable as machine strings", () => {
  const [tierMeta] = vm.runInContext("[TIER_META_MC]", screens) as Array<Record<string, unknown>>;
  const tree = renderComponentMc(screens.TierNotesMC, { title: "What each setting does", rows: Object.values(tierMeta) });
  const mono = textsMc(findAllMc(tree, (n) => n.props["data-atom"] === "MachineString"));
  assert.deepStrictEqual(mono, ["--effort", "--effort", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"]);
  assert.ok(textMc(tree).includes("Default: no --effort flag"), "the sentence around the flag reads whole");
});

test("the model glossary names the tier's own saved id under its label", () => {
  const props = domainsPropsMc(THREE_TIERS_MC.map((d) => ({ ...d, desired: "claude-opus-4-8" })));
  const drawer = drawersMc(renderComponentMc(screens.DomainsSectionMC, props))[0];
  const entries = tagsMc(drawer.children, "dl")[0].children.filter((n): n is McTag => typeof n !== "string");
  const savedIdOf = Object.fromEntries(
    entries.map((entry) => [
      textsMc(tagsMc(entry.children, "dt"))[0],
      textsMc(tagsMc(entry.children, "dd")).find((text) => text.startsWith("Saved id")) ?? null,
    ]),
  );
  assert.deepStrictEqual(
    savedIdOf,
    { "Self-improve and wiki compile": "Saved id claude-opus-4-8" },
    "the label carries its own tier's id; a domain with no client meta adds no entry",
  );
});

test("no ledger text drops below the 13px type floor", () => {
  const overridden = {
    ...domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], actual: "claude-sonnet-5", drift: true }]),
    baseline: { models: { "model.daemon_cycle_worker": "claude-sonnet-5" }, budgets: {} },
  };
  const tree = renderComponentMc(screens.DomainsSectionMC, overridden);
  const micro = findAllMc(tree, (n) => String(n.props.className ?? "").includes("fs-micro"));
  assert.strictEqual(micro.length, 0, "no fs-micro text");
  const literal = findAllMc(tree, (n) => {
    const px = /text-\[(\d+)px\]/.exec(String(n.props.className ?? ""))?.[1];
    const inline = (n.props.style as { fontSize?: unknown } | undefined)?.fontSize;
    return (px !== undefined && Number(px) < 13) || (typeof inline === "number" && inline < 13);
  });
  assert.strictEqual(literal.length, 0, "no literal size below 13px");
});

test("the saved-value line keeps its slot whether or not the field differs, so an edit never grows the row", () => {
  const slotsOf = (baselineValue: string): number => {
    const tree = renderComponentMc(screens.DomainsSectionMC, {
      ...domainsPropsMc(),
      baseline: { models: { "model.daemon_cycle_worker": baselineValue }, budgets: {} },
    });
    return findAllMc(tree, (n) => n.props["data-slot"] === "line-slot").length;
  };
  assert.strictEqual(slotsOf("claude-opus-4-8"), 1, "slot reserved while the field matches");
  assert.strictEqual(slotsOf("claude-sonnet-5"), 1, "the same slot carries the saved value once it differs");
});

test("the daemon model card leaves Cost & usage to the agent card, and an unpriced tier says why its cost is a fallback", () => {
  for (const pricingKnown of [true, false]) {
    const tree = renderComponentMc(
      screens.DomainsSectionMC,
      domainsPropsMc(THREE_TIERS_MC.map((d) => ({ ...d, pricing_known: pricingKnown }))),
    );
    const links = tagsMc(tree, "a").filter((a) => a.props.href === "#cost");
    assert.strictEqual(links.length, 0, `pricing_known=${pricingKnown}: the page's one Cost & usage link sits on the agent card`);
    assert.strictEqual(
      textMc(tree).includes("No price listed"),
      !pricingKnown,
      `pricing_known=${pricingKnown}: the fallback note follows pricing_known`,
    );
  }
});

test("an unpriced tier's note carries its warning on a glyph, while its words stay neutral", () => {
  const tree = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], pricing_known: false }]),
  );
  const [words] = findAllMc(tree, (n) => n.children.some((c) => typeof c === "string" && c.includes("No price listed")));
  const glyphs = findAllMc(tree, (n) => textMc(n.children) === TONE_GLYPH_MC.warn);

  assert.ok(words, "the fallback note renders");
  assert.doesNotMatch(String(words.props.className), /text-(warn|crit|ok|info)\b/, "the words carry no tone");
  assert.strictEqual(glyphs.length, 1, "one warning glyph leads the note");
  assert.match(String(glyphs[0].props.className), /\btext-warn\b/, "the glyph carries the warn tone");
  assert.strictEqual(glyphs[0].props["aria-hidden"], "true", "the glyph is decoration — the words already say it");
});

const countMc = (text: string, needle: string): number => text.split(needle).length - 1;

// The card face an operator reads with every drawer closed.
function faceMc(nodes: McNode[]): McNode[] {
  return nodes.flatMap((n): McNode[] =>
    typeof n === "string" ? [n] : n.props["data-slot"] === "card-info" ? [] : [{ ...n, children: faceMc(n.children) }],
  );
}
const drawersMc = (nodes: McNode[]): McTag[] => findAllMc(nodes, (n) => n.props["data-slot"] === "card-info");
const headMetaMc = (nodes: McNode[]): string[] =>
  textsMc(findAllMc(faceMc(nodes), (n) => String(n.props.className ?? "").includes("card-sub")));
const footMc = (nodes: McNode[]): string[] =>
  textsMc(findAllMc(nodes, (n) => String(n.props.className ?? "").includes("card-foot")));

test("a timing shared by every row is stated once on the card face, and a row that differs names its own", () => {
  const uniform = textMc(faceMc(renderComponentMc(screens.DomainsSectionMC, domainsPropsMc(THREE_TIERS_MC))));
  assert.strictEqual(countMc(uniform, "next cycle"), 1, "three next-cycle rows → stated once");

  const mixed = THREE_TIERS_MC.map((d, i) => (i === 2 ? { ...d, apply_mode: "next-spawn" } : d));
  const text = textMc(faceMc(renderComponentMc(screens.DomainsSectionMC, domainsPropsMc(mixed))));
  assert.strictEqual(countMc(text, "next cycle"), 1, "the shared mode stays stated once");
  assert.strictEqual(countMc(text, "next spawn"), 1, "the differing row names its own mode");
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
  assert.strictEqual(input.props["aria-describedby"], alerts[0].props.id, "the field names its reason as its description");
});

// The form selects ride the shared Select atom; the row header shows the name, so the atom's label is for assistive tech only.
test("each form select is the shared Select atom, named by a hidden label tied to it", () => {
  const rows = [
    { name: "model tier", tree: renderComponentMc(screens.DomainsSectionMC, domainsPropsMc()), suffix: " model" },
    { name: "effort tier", tree: renderComponentMc(screens.TiersSectionMC, tiersPropsMc()), suffix: " level" },
  ];
  for (const row of rows) {
    const atoms = findAllMc(row.tree, (n) => n.props["data-atom"] === "Select");
    assert.strictEqual(atoms.length, tagsMc(row.tree, "select").length, `${row.name}: every select is the atom`);
    const [label] = tagsMc(atoms[0].children, "label");
    const [select] = tagsMc(atoms[0].children, "select");
    assert.strictEqual(label.props.className, "sr-only", `${row.name}: the label takes no line of its own`);
    assert.strictEqual(label.props.htmlFor, select.props.id, `${row.name}: the label names its select`);
    assert.ok(textMc(label.children).endsWith(row.suffix), `${row.name}: the label words what is picked`);
  }
});

// One crit edge per row: a listed value puts it on the select, custom mode on the entry field; either names the worded reason.
test("an invalid model pick marks the control holding the value and points it at its reason", () => {
  const renderInvalid = (value: string) =>
    renderComponentMc(screens.DomainsSectionMC, {
      ...domainsPropsMc(),
      form: { models: { "model.daemon_cycle_worker": value }, budgets: {} },
      errors: { "model.daemon_cycle_worker": "Unknown model id" },
    });
  const reasonId = (tree: McNode[]) => findAllMc(tree, (n) => n.props.role === "alert")[0].props.id;

  const listed = renderInvalid("claude-opus-4-8");
  const [listedSelect] = tagsMc(listed, "select");
  assert.strictEqual(listedSelect.props["aria-invalid"], "true", "a listed value: the select is invalid");
  assert.strictEqual(listedSelect.props["aria-describedby"], reasonId(listed), "a listed value: the select names its reason");

  const custom = renderInvalid("my-model");
  const [customSelect] = tagsMc(custom, "select");
  const [entry] = tagsMc(custom, "input");
  assert.strictEqual(entry.props["aria-invalid"], "true", "custom mode: the entry field is invalid");
  assert.strictEqual(entry.props["aria-describedby"], reasonId(custom), "custom mode: the entry field names its reason");
  assert.ok(!String(customSelect.props.className).includes("is-error"), "custom mode: the select keeps no second ring");
  assert.strictEqual(customSelect.props["aria-invalid"], undefined, "custom mode: the select is not marked");
});

test("a live value the payload does not carry is left out, never shown as a placeholder dash", () => {
  const tree = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], domain: "model.future_a", actual: null, drift: false }]),
  );
  assert.strictEqual(textMc([liveCellMc(tree)]), "", "an absent live value with no source renders nothing");
});

describe("a ledger card head counts only the unread rows that render nothing, and a row that names its unread source keeps the fact to itself", () => {
  const unreadTier = THREE_TIERS_MC.map((d, i) => (i === 1 ? { ...d, actual: null, drift: false } : d));
  const rows = [
    { name: "every model row read: the head stays silent", section: "DomainsSectionMC", props: domainsPropsMc(THREE_TIERS_MC), mark: null },
    { name: "a drifted model row: the row carries it, the head stays silent", section: "DomainsSectionMC", props: domainsPropsMc(THREE_TIERS_MC.map((d, i) => (i === 0 ? { ...d, drift: true } : d))), mark: null },
    { name: "an unread model row with no source: the head names it", section: "DomainsSectionMC", props: domainsPropsMc(unreadTier), mark: "1 not read" },
    { name: "an unread cap row names its source in the row, so the head stays silent", section: "BudgetsSectionMC", props: budgetsPropsMc([{ ...BUDGET_ROW_FIXTURE_MC[0], actual: null, drift: false }]), mark: null },
    { name: "an unread model row with a source names it in the row, so the head stays silent", section: "DomainsSectionMC", props: domainsPropsMc(THREE_TIERS_MC.map((d, i) => (i === 0 ? { ...d, actual: null, drift: false } : d))), mark: null },
    { name: "a loading ledger claims nothing", section: "DomainsSectionMC", props: { ...domainsPropsMc(unreadTier), state: "loading" }, mark: null },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = renderComponentMc(screens[row.section], row.props);
      const head = textMc(findAllMc(tree, (n) => n.props["data-atom"] === "Card").flatMap((card) => card.children.slice(0, 1)));
      assert.strictEqual(head.includes("not read"), row.mark !== null, `head: ${head}`);
      if (row.mark) assert.ok(head.includes(row.mark), `names '${row.mark}'`);
    });
  }
});

test("a model option reads as its friendly name with the id leading its title; an id outside the pattern reads as itself", () => {
  const roster = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-4-5-20251101", "my-local-model"];
  const tree = renderComponentMc(screens.DomainsSectionMC, {
    ...domainsPropsMc(THREE_TIERS_MC.slice(0, 1)),
    knownModels: roster,
    form: { models: { "model.daemon_cycle_worker": "claude-sonnet-5-5" }, budgets: {} },
    baseline: { models: { "model.daemon_cycle_worker": "claude-sonnet-5-5" }, budgets: {} },
  });
  const options = tagsMc(tree, "option");
  assert.deepStrictEqual(
    textsMc(options),
    ["Opus 5.5", "Sonnet 5.5", "Opus 4.5", "my-local-model", "custom…"],
    "the known models by friendly name, a dated id included, then the custom entry",
  );
  for (const option of options.filter((o) => roster.includes(String(o.props.value)))) {
    assert.ok(String(option.props.title).startsWith(String(option.props.value)), `${option.props.value}: the id leads the title`);
  }
});

describe("each card states its shared timing in a header meta within the 32-char cap", () => {
  const rows = [
    { name: "model assignment", section: "DomainsSectionMC", props: () => domainsPropsMc(THREE_TIERS_MC), meta: "Applies at next cycle" },
    { name: "budget caps", section: "BudgetsSectionMC", props: () => budgetsPropsMc(), meta: "Applies at next cycle" },
    { name: "call tiers", section: "TiersSectionMC", props: () => tiersPropsMc(), meta: "Applies at next cycle" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const metas = headMetaMc(renderComponentMc(screens[row.section], row.props()));
      assert.deepStrictEqual(metas, [row.meta], `${row.name}: one header meta`);
      assert.ok(metas[0].length <= 32, `${row.name}: "${metas[0]}" exceeds the 32-char meta cap`);
    });
  }
});

test("a row departing from the card's timing states its own timing in its row", () => {
  const departing = THREE_TIERS_MC.map((d, i) => (i === 1 ? { ...d, apply_mode: "immediate" } : d));
  const tree = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc(departing));
  assert.deepStrictEqual(headMetaMc(tree), ["Applies at next cycle"], "the header keeps the shared mode alone");
  const rows = tagsMc(tagsMc(tree, "tbody")[0].children, "tr");
  const own = rows.filter((row) => textMc(row.children).includes("Applies immediately"));
  assert.strictEqual(own.length, 1, "exactly one row states a timing of its own");
  assert.ok(textMc(own[0].children).includes("model.future_a"), "the departing row carries it");
});

describe("each card's glossary opens from its About settings drawer, never on the card face", () => {
  const rows = [
    { name: "model assignment", section: "DomainsSectionMC", props: () => domainsPropsMc(THREE_TIERS_MC), heading: "What the helper runs" },
    { name: "budget caps", section: "BudgetsSectionMC", props: () => budgetsPropsMc(), heading: "What each cap covers" },
    { name: "call tiers", section: "TiersSectionMC", props: () => tiersPropsMc(), heading: "What each setting does" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = renderComponentMc(screens[row.section], row.props());
      assert.strictEqual(tagsMc(faceMc(tree), "dl").length, 0, `${row.name}: no glossary on the face`);
      const drawers = drawersMc(tree);
      assert.strictEqual(drawers.length, 1, `${row.name}: one drawer`);
      assert.strictEqual(drawers[0].props["data-info-label"], "About settings");
      assert.deepStrictEqual(textsMc(tagsMc(drawers[0].children, "h3")), [row.heading]);
      assert.ok(tagsMc(drawers[0].children, "dt").length > 0, `${row.name}: the drawer lists its entries`);
    });
  }
});

test("a daemon row at rest shows its label alone, and Self-improve is named once across the three daemon cards", () => {
  const labels: string[] = [];
  for (const [name, props] of [
    ["DomainsSectionMC", domainsPropsMc()],
    ["BudgetsSectionMC", budgetsPropsMc()],
    ["TiersSectionMC", tiersPropsMc()],
  ] as const) {
    for (const tr of tagsMc(faceMc(renderComponentMc(screens[name], props)), "tr")) {
      const lines = tagsMc(tr.children, "td")[0].children.filter((n): n is McTag => typeof n !== "string");
      assert.strictEqual(lines.length, 1, `${name}: '${textMc(lines)}' holds its label alone`);
      labels.push(textMc(lines));
    }
  }
  assert.strictEqual(labels.filter((label) => label.includes("Self-improve")).length, 1, labels.join(" · "));
});

test("long take-effect, cap and default sentences read as short labels; their detail sits in the drawer", () => {
  const [budgetMeta, tierMeta] = vm.runInContext("[BUDGET_META_MC, TIER_META_MC]", screens) as Array<
    Record<string, { desc: string; note?: string }>
  >;
  assert.strictEqual(budgetMeta["budget.worker_max_usd"].desc, "One cap for both calls");
  for (const knob of ["tier.worker_effort", "tier.pre_verify_effort"]) {
    assert.strictEqual(tierMeta[knob].desc, "Default: no --effort flag", knob);
  }

  const domains = renderComponentMc(screens.DomainsSectionMC, domainsPropsMc(THREE_TIERS_MC));
  const caveat = "the daemon picks it up on its next cycle";
  assert.ok(!textMc(faceMc(domains)).includes(caveat), "the take-effect caveat is off the face");
  assert.ok(textMc(drawersMc(domains)[0].children).includes(caveat), "the caveat is in the drawer");

  const tiers = renderComponentMc(screens.TiersSectionMC, tiersPropsMc());
  const precedence = "settings or model default governs the call";
  assert.ok(textMc(drawersMc(tiers)[0].children).includes(precedence), "the precedence note is in the drawer");
});

test("the tier drawer names an unset output-token field by the field's own placeholder", () => {
  const tiers = renderComponentMc(screens.TiersSectionMC, tiersPropsMc());
  const placeholders = new Set(tagsMc(faceMc(tiers), "input").map((input) => input.props.placeholder));
  assert.strictEqual(placeholders.size, 1, "the output-token fields share one placeholder");
  const unsetNames = textsMc(tagsMc(drawersMc(tiers)[0].children, "dd"))
    .filter((note) => note.startsWith("Blank = "))
    .map((note) => note.slice("Blank = ".length));
  assert.ok(unsetNames.length > 0, "the drawer says what a blank field means");
  assert.deepStrictEqual(new Set(unsetNames), placeholders);
});

test("the agent card leads at full width, and the three daemon ledgers share one split row under it", () => {
  const tree = renderComponentMc(screens.ScreenModelConfig);
  const cardSizesOf = (nodes: McNode[]): unknown[] =>
    findAllMc(nodes, (n) => n.props["data-atom"] === "Card").map((c) => c.props["data-size"]);
  assert.strictEqual(textsMc(tagsMc(tree, "h2"))[0], "Agent models", "the agent card comes first");
  assert.strictEqual(cardSizesOf(tree)[0], "L", "the agent card is the L card");
  const [split] = findAllMc(tree, (n) => n.props["data-atom"] === "SplitRow");
  assert.ok(split, "a split row holds the ledgers");
  // 1:1 over 2:1 — at 1280 a third-width column overflows the cap and tier fields
  assert.strictEqual(split.props["data-ratio"], "1:1");
  assert.strictEqual(split.props["data-layout"], "content", "each column ends at its own content");
  const [column, tiers] = split.children.filter((c): c is McTag => typeof c !== "string");
  assert.strictEqual(column.props["data-atom"], "SplitColumn", "the daemon model and the caps stack in the left column");
  assert.deepStrictEqual(cardSizesOf([column]), ["M", "M"], "daemon model and caps are M cards");
  assert.deepStrictEqual(cardSizesOf([tiers]), ["M"], "the call tiers fill the right column");
  assert.deepStrictEqual(textsMc(tagsMc(split.children, "h2")), [
    "Daemon model",
    "Per-call budget caps",
    "Daemon call tiers",
  ]);
});

test("the caps card names Recent costs once, in its head, never per cap row", () => {
  const budgets = [BUDGET_ROW_FIXTURE_MC[0], { ...BUDGET_ROW_FIXTURE_MC[0], domain: "budget.pre_verify_max_usd" }];
  const tree = renderComponentMc(screens.BudgetsSectionMC, budgetsPropsMc(budgets));
  const links = tagsMc(tree, "a").filter((a) => a.props.href === "#cost");
  assert.deepStrictEqual(links.map((a) => [a.props["data-atom"], textMc(a.children)]), [["Link", "Recent costs"]], "one shared Link atom");
  assert.strictEqual(tagsMc(tagsMc(tree, "tbody")[0].children, "a").length, 0, "no cap row carries a link");
});

test("the card-head Cost & usage navigation is the shared Link atom", () => {
  const tree = renderComponentMc(screens.AgentModelsSectionMC, { state: "loading", knownModels: [], onAgentsRead: () => {}, showToast: () => {} });
  const links = tagsMc(tree, "a").filter((a) => a.props.href === "#cost");
  assert.deepStrictEqual(links.map((a) => a.props["data-atom"]), ["Link"]);
});

test("mono comes only from the machine-string atom: no element styles itself mono", () => {
  const domains = renderComponentMc(
    screens.DomainsSectionMC,
    domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], actual: "claude-sonnet-5", drift: true }]),
  );
  const trees = [
    domains,
    renderComponentMc(screens.BudgetsSectionMC, budgetsPropsMc()),
    renderComponentMc(screens.SurfaceResultRowMC, { result: { surface: "daemon-config.json", status: "failed", reason: "write failed" } }),
  ];
  for (const tree of trees) {
    const selfMono = findAllMc(tree, (n) => /\bfont-mono\b/.test(String(n.props.className ?? "")));
    assert.deepStrictEqual(selfMono.map((n) => textMc(n.children)), [], "no ad-hoc mono class");
  }
  for (const [name, tree] of [
    ["budgets", trees[1]],
    ["tiers", renderComponentMc(screens.TiersSectionMC, tiersPropsMc())],
  ] as const) {
    const numeric = findAllMc(tree, (n) => n.tag === "input" && ["decimal", "numeric"].includes(String(n.props.inputMode)));
    assert.ok(numeric.length > 0, `${name}: a numeric field renders`);
    for (const input of numeric) {
      const classes = String(input.props.className).split(/\s+/);
      assert.ok(classes.includes("tabular-nums") && !classes.includes("field--mono"), `${name}: a number field is sans tnum, never mono`);
    }
  }
});

test("a differing model's saved line names the saved model, never its raw id", () => {
  const tree = renderComponentMc(screens.DomainsSectionMC, {
    ...domainsPropsMc(),
    baseline: { models: { "model.daemon_cycle_worker": "claude-sonnet-5" }, budgets: {} },
  });
  const [slot] = findAllMc(tree, (n) => n.props["data-slot"] === "line-slot");
  const text = textMc(slot.children);
  assert.ok(!text.includes("claude-sonnet-5"), `no raw id: ${text}`);
  assert.ok(text.includes("Sonnet 5"), `the friendly name: ${text}`);
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

describe("a toast keeps its tone class on the shell and shows the tone only as a leading glyph", () => {
  for (const tone of ["ok", "crit"]) {
    test(`${tone} toast`, async () => {
      const tree = await renderSeededScreenMc({ toast: { tone, message: "Changes saved" } });
      const [toast] = findAllMc(tree, (n) => String(n.props.className ?? "").split(" ").includes("doc-toast"));
      assert.ok(toast, "the toast renders");
      const [glyph] = findAllMc([toast], (n) => n.props.className === "doc-toast-glyph");

      assert.ok(String(toast.props.className).split(" ").includes(tone), "the tone class stays on the root");
      assert.strictEqual(textMc(glyph ? [glyph] : []), TONE_GLYPH_MC[tone], "the glyph is the tone's shared mark");
      assert.strictEqual(glyph?.props["aria-hidden"], "true", "the glyph is decoration");
      assert.ok(textMc(toast.children).startsWith(TONE_GLYPH_MC[tone]), "the glyph leads the message");
      assert.ok(textMc(toast.children).includes("Changes saved"), "the message stays inside the toast");
    });
  }
});

describe("a config read that failed after an earlier read shows the last good read, never an all-clear", () => {
  const data = {
    domains: DOMAIN_ROW_FIXTURE_MC,
    budgets: BUDGET_ROW_FIXTURE_MC,
    known_models: [],
    daemon_config_sync: "ok",
  };
  const form = { models: { "model.daemon_cycle_worker": "claude-opus-4-8" }, budgets: { "budget.worker_max_usd": "10.00" } };
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
      const alerts = findAllMc(tree, (n) => n.props.role === "alert");
      const [card] = findAllMc(alerts, (n) => n.props["data-atom"] === "RegionUnavailable");
      const text = textMc(tree);

      assert.ok(!text.includes("In sync") && !text.includes("match saved"), "no line claims the saved config is in force");
      assert.strictEqual(textMc(alerts).includes("last good read"), row.isLastKnown, "the banner names the held data");
      if (!row.isLastKnown) return;
      assert.strictEqual(card?.props.isBusy, row.region.busy, "the Retry reports its own request");
      assert.strictEqual(card?.props.focusTargetId, "mc-models", "focus lands on the ledger if the card leaves");
    });
  }
});

// Screen-level reads: announcements, stale rows, file lists, rail headings, In-effect sources.

const SCREEN_DATA_MC = {
  domains: DOMAIN_ROW_FIXTURE_MC,
  budgets: BUDGET_ROW_FIXTURE_MC,
  tiers: TIER_ROW_FIXTURE_MC,
  known_models: [],
  daemon_config_sync: "ok",
};
const SCREEN_FORM_MC = { models: { "model.daemon_cycle_worker": "claude-opus-4-8" }, budgets: { "budget.worker_max_usd": "10.00" } };

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

test("a matching row stays silent whether the read is fresh or a failed reload holds it", async () => {
  for (const [name, error] of [
    ["fresh read", null],
    ["warm error", "HTTP 500"],
  ] as const) {
    const tree = await renderSeededScreenMc({
      config: seededConfigMc({ status: "ready", data: SCREEN_DATA_MC, key: "config", error, busy: false }),
      form: SCREEN_FORM_MC,
      asOfAt: Date.now() - 60_000,
    });
    const bodies = tagsMc(tree, "tbody");
    const rowCount = bodies.flatMap((b) => tagsMc(b.children, "tr")).length;
    const text = textMc(bodies);

    assert.ok(rowCount > 0, `${name}: rows rendered`);
    for (const claim of ["Matches saved", "Matched at last read", "Read from daemon-config.json"]) {
      assert.strictEqual(countMc(text, claim), 0, `${name}: no row says '${claim}'`);
    }
    assert.strictEqual(iconsMc(bodies, "check").length, 0, `${name}: no ok glyphs`);
  }
});

test("an invalid edit puts a sentence-case alert in the save bar", async () => {
  const tree = await renderSeededScreenMc({
    config: seededConfigMc({ status: "ready", data: SCREEN_DATA_MC, key: "config", busy: false }),
    form: { ...SCREEN_FORM_MC, budgets: { "budget.worker_max_usd": "abc" } },
    asOfAt: Date.now(),
  });
  const [bar] = findAllMc(tree, (n) => n.props["aria-label"] === "Unsaved changes");
  assert.ok(bar, "a dirty form shows the save bar");
  const [alert] = findAllMc(bar.children, (n) => String(n.props.className ?? "").includes("text-crit"));
  assert.strictEqual(textMc(alert.children).replace("✕", "").trim(), "Fix the highlighted fields before saving");
});

test("the glossary labels are headings, and their notes never repeat the agent a row already names", async () => {
  const tree = await renderSeededScreenMc({
    config: seededConfigMc({ status: "ready", data: SCREEN_DATA_MC, key: "config", busy: false }),
    form: SCREEN_FORM_MC,
    asOfAt: Date.now(),
  });
  const headings = textsMc(tagsMc(tree, "h3"));
  assert.ok(headings.includes("What the helper runs"), `headings: ${headings}`);
  assert.ok(headings.includes("What each cap covers"), `headings: ${headings}`);

  const notes = textsMc(tagsMc(tree, "dd")).join(" ");
  assert.ok(notes.length > 0, "the notes are rendered");
  assert.ok(!notes.includes("glass-atrium-"), `a note repeats an agent id the row shows: ${notes}`);
});

test("no daemon card has a foot, and a row at rest never names the file it reads", () => {
  for (const [name, tree] of [
    ["models", renderComponentMc(screens.DomainsSectionMC, domainsPropsMc())],
    ["budgets", renderComponentMc(screens.BudgetsSectionMC, budgetsPropsMc())],
    ["tiers", renderComponentMc(screens.TiersSectionMC, tiersPropsMc())],
  ] as const) {
    assert.deepStrictEqual(footMc(tree), [], `${name}: no foot`);
    assert.ok(!textMc(tree).includes("daemon-config.json"), `${name}: the file is named only where a line needs it`);
  }
});

test("a sourced row with no live value says no value was read, naming the file in the line's title", () => {
  const trees = [
    ["model.daemon_cycle_worker", renderComponentMc(
      screens.DomainsSectionMC,
      domainsPropsMc([{ ...DOMAIN_ROW_FIXTURE_MC[0], actual: null, drift: false }]),
    )] as const,
    ["budget.worker_max_usd", renderComponentMc(
      screens.BudgetsSectionMC,
      budgetsPropsMc([{ ...BUDGET_ROW_FIXTURE_MC[0], actual: null, drift: false }]),
    )] as const,
  ];
  for (const [domain, tree] of trees) {
    const slot = liveCellMc(tree);
    assert.strictEqual(textMc([slot]), "No value read", `${domain}: says nothing was read`);
    const titles = findAllMc([slot], (n) => typeof n.props.title === "string").map((n) => n.props.title);
    assert.deepStrictEqual(titles, ["No value read from daemon-config.json"], `${domain}: the file rides the title`);
  }
});
