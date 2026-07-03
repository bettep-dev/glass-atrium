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
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

import {
  FREE_TEXT_MODEL_PATTERN,
  BUDGET_VALUE_PATTERN,
  BUDGET_MIN_USD,
  BUDGET_MAX_USD,
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
}

// Module-level `const` declarations (the client constant mirror) stay lexically
// scoped inside the evaluated script — they never become vm-context-global
// properties, so they cannot be read directly. The surviving mirrors are instead
// verified BEHAVIORALLY: the helper that closes over them (validateFormMC —
// free-text regex + budget regex/bounds) is cross-checked against the server SoT
// validators below.

// Build once, evaluate in a sandbox — the real top-level helper declarations.
async function loadMc(): Promise<McHelpers> {
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
  const code = built.outputFiles[0].text;

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
  const key = "budget.haiku_max_usd";
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

// --- modelOptionsMC: API-driven option assembly per domain (P7 AC: exactly the GET
// known_models + inherit where the domain allows; no bare alias option) ---

test("modelOptionsMC: unknown domain (fallback meta) lists exactly the injected known_models (no inherit)", () => {
  const opts = sameRealm(mc.modelOptionsMC("model.future_unknown", KNOWN_MODELS_FIXTURE));
  assert.deepStrictEqual(opts, KNOWN_MODELS_FIXTURE);
});

test("modelOptionsMC: dev = inherit + known_models verbatim, no bare alias option", () => {
  const opts = sameRealm(mc.modelOptionsMC("model.dev", KNOWN_MODELS_FIXTURE));
  assert.deepStrictEqual(opts, ["inherit", ...KNOWN_MODELS_FIXTURE]);
  for (const alias of ["opus", "sonnet", "haiku"]) {
    assert.ok(!opts.includes(alias), `dev has no bare alias '${alias}'`);
  }
});

test("modelOptionsMC: research = inherit + known_models verbatim, no bare alias option", () => {
  const opts = sameRealm(mc.modelOptionsMC("model.research", KNOWN_MODELS_FIXTURE));
  assert.deepStrictEqual(opts, ["inherit", ...KNOWN_MODELS_FIXTURE]);
  for (const alias of ["opus", "sonnet", "haiku"]) {
    assert.ok(!opts.includes(alias), `research has no bare alias '${alias}'`);
  }
});

test("modelOptionsMC: daemon_cycle_haiku — no inherit (concrete id only)", () => {
  const opts = sameRealm(mc.modelOptionsMC("model.daemon_cycle_haiku", KNOWN_MODELS_FIXTURE));
  assert.deepStrictEqual(opts, KNOWN_MODELS_FIXTURE);
  assert.ok(!opts.includes("inherit"), "daemon cycle helper does not inherit");
});

test("modelOptionsMC: options track the injected roster, not a baked-in mirror", () => {
  const altRoster = ["some-brand-new-model", "another-id"];
  const opts = sameRealm(mc.modelOptionsMC("model.daemon_cycle_haiku", altRoster));
  assert.deepStrictEqual(opts, altRoster, "a different roster yields different options");
});

test("modelOptionsMC: empty known_models (SoT fail-open, D3) → inherit-only where allowed", () => {
  assert.deepStrictEqual(sameRealm(mc.modelOptionsMC("model.dev", [])), ["inherit"]);
  assert.deepStrictEqual(sameRealm(mc.modelOptionsMC("model.daemon_cycle_haiku", [])), []);
});

// --- validateFormMC: client mirror of the server PUT contract ---
// NOTE: no client-side bare-alias reject mirror — the server is the validation
// authority for the alias 400 (plan Non-Goals); covered by model-config.route.test.ts.

test("validateFormMC: a valid known id + valid 2-decimal budget → no errors", () => {
  const errors = sameRealm(
    mc.validateFormMC(
      {
        models: { "model.dev": "claude-opus-4-8" },
        budgets: { "budget.haiku_max_usd": "0.50" },
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
      mc.validateFormMC({ models: {}, budgets: { "budget.haiku_max_usd": bad } }, []),
    );
    assert.ok(errors["budget.haiku_max_usd"], `'${bad}' rejected`);
    assert.ok(!BUDGET_VALUE_PATTERN.test(bad), `server pattern also rejects '${bad}'`);
  }
});

test("validateFormMC: budget out of [0.05, 50.00] bounds → error; in-bounds → ok", () => {
  const below = sameRealm(
    mc.validateFormMC({ models: {}, budgets: { "budget.haiku_max_usd": "0.04" } }, []),
  );
  assert.ok(below["budget.haiku_max_usd"], "below floor flagged");
  const above = sameRealm(
    mc.validateFormMC({ models: {}, budgets: { "budget.haiku_max_usd": "50.01" } }, []),
  );
  assert.ok(above["budget.haiku_max_usd"], "above ceiling flagged");
  const edge = sameRealm(
    mc.validateFormMC(
      {
        models: {},
        budgets: { "budget.haiku_max_usd": "0.05", "budget.pre_verify_max_usd": "50.00" },
      },
      [],
    ),
  );
  assert.deepStrictEqual(edge, {}, "exact bounds accepted");
});

// --- diffFormMC: partial-PUT payload builder (only changed fields, null when none) ---

test("diffFormMC: no change → null (clean state — save-banner hidden, Save dormant not error-disabled)", () => {
  const baseline = { models: { "model.dev": "claude-opus-4-8" }, budgets: { "budget.haiku_max_usd": "0.50" } };
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
  const baseline = { models: { "model.dev": "claude-opus-4-8" }, budgets: { "budget.haiku_max_usd": "0.50" } };
  const form = { models: { "model.dev": "claude-fable-5" }, budgets: { "budget.haiku_max_usd": "0.75" } };
  const result = sameRealm(mc.diffFormMC(baseline, form)) as { models?: unknown; budgets?: unknown };
  assert.deepStrictEqual(result.models, { "model.dev": "claude-fable-5" });
  assert.deepStrictEqual(result.budgets, { "budget.haiku_max_usd": "0.75" });
});

// --- buildFormMC: GET response → edit buffer (desired mirror) ---

test("buildFormMC: maps domains/budgets desired into the form buffer", () => {
  const data = {
    domains: [{ domain: "model.dev", desired: "claude-opus-4-8" }, { domain: "model.research", desired: null }],
    budgets: [{ domain: "budget.haiku_max_usd", desired: "0.50" }],
  };
  const form = sameRealm(mc.buildFormMC(data));
  assert.strictEqual(form.models["model.dev"], "claude-opus-4-8");
  assert.strictEqual(form.models["model.research"], "", "null desired → empty string buffer");
  assert.strictEqual(form.budgets["budget.haiku_max_usd"], "0.50");
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
    { domain: "budget.haiku_max_usd" },
  ];
  const sorted = sameRealm(mc.sortBudgetsMC(input)).map((b) => b.domain);
  assert.strictEqual(sorted[0], "budget.haiku_max_usd");
  assert.ok(sorted.includes("budget.future_unknown"));
  assert.strictEqual(sorted.length, 2);
});
