// Models & budgets controls on their DESIGN.md §7.15 tiers, measured in a real browser on the shipped tokens.css, base.css and type
// scale, rendered from the shipped components: the save-results fold on the disclosure
// atom — each keeps one box closed, open and in every pointer/keyboard state (§7.16) — the Cost & usage links as 24 targets, the agent selection bar at one height in every tick state, and a
// field's inline Reset as a 24 target in a saved line that keeps its height whether the field is overridden or not.
// Runner: npx tsx --test test/model-config.control-tiers.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, CDPSession, Page } from "playwright";
import { chromium } from "playwright";

import { createReactStub, collectText, findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";
import { createControlProbe } from "./lib/control-probe.js";
import { getRoleKeyCss } from "./lib/role-keys.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

type Component = (props: unknown) => unknown;
const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const UI = ui.UI as Record<string, Component>;
const screen = await loadScreenModule(resolve(HERE, "../public/src/screens/model-config.jsx"), {
  UI,
  React: createReactStub(),
  addEventListener: () => {},
  removeEventListener: () => {},
});
const getMarkup = (component: string, props: Record<string, unknown>): string =>
  getHtml(renderScreen((screen[component] as Component)(props)) as RenderedNode);
const TYPE_SCALE_CSS = findNodes(renderScreen(UI.TypeScaleStyle({})), (n) => n.type === "style")
  .map((n) => collectText(n))
  .join("\n");

// The app loads Tailwind preflight and utilities from its CDN; these are the rules the measured geometry depends on, at their shipped values — role keys come from the shared shim.
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; font-family: ui-sans-serif, system-ui, sans-serif; }
  svg { display: block; vertical-align: middle; }
  table { border-collapse: collapse; } select { font: inherit; }
  button { font: inherit; line-height: inherit; color: inherit; margin: 0; padding: 0; background-color: transparent; }
  a { color: inherit; text-decoration: inherit; }
  summary { display: list-item; }
  .flex { display: flex; } .inline-flex { display: inline-flex; } .flex-col { flex-direction: column; } .flex-wrap { flex-wrap: wrap; }
  .items-center { align-items: center; } .min-w-0 { min-width: 0; } .max-w-full { max-width: 100%; } .shrink-0 { flex-shrink: 0; }
  .gap-1 { gap: 0.25rem; } .gap-1\\.5 { gap: 0.375rem; } .gap-2 { gap: 0.5rem; }
  .mt-1 { margin-top: 0.25rem; } .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
  .py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; } .border { border-width: 1px; } .border-b { border-bottom-width: 1px; }
  .underline { text-decoration-line: underline; } .underline-offset-2 { text-underline-offset: 2px; }
  .text-right { text-align: right; } .table-fixed { table-layout: fixed; } .tabular-nums { font-variant-numeric: tabular-nums; } .whitespace-nowrap { white-space: nowrap; } .font-mono { font-family: ui-monospace, SFMono-Regular, monospace; }
  .font-medium { font-weight: 500; } .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }`;

const noop = () => undefined;
const MODEL = "claude-opus-5-5";
const DOMAINS = [
  {
    domain: "model.daemon_cycle_worker",
    desired: MODEL,
    actual: MODEL,
    drift: false,
    apply_mode: "next-cycle",
    editable: true,
    pricing_known: true,
  },
];
const BUDGETS = [{ domain: "budget.worker_max_usd", desired: "10.00", actual: "10.00", drift: false, apply_mode: "next-cycle" }];
const MODELS = getMarkup("DomainsSectionMC", {
  state: "ready",
  domains: DOMAINS,
  knownModels: [MODEL],
  form: { models: { "model.daemon_cycle_worker": MODEL } },
  baseline: { models: { "model.daemon_cycle_worker": MODEL } },
  errors: {},
  isStale: false,
  onModelChange: noop,
});
const CAPS = getMarkup("BudgetsSectionMC", {
  state: "ready",
  budgets: BUDGETS,
  form: { budgets: { "budget.worker_max_usd": "10.00" } },
  baseline: { budgets: { "budget.worker_max_usd": "10.00" } },
  errors: {},
  isStale: false,
  onBudgetChange: noop,
});
const RESULTS = getMarkup("SurfaceResultsCardMC", {
  results: [
    { status: "skipped", surface: "agents/glass-atrium-dev-front.md", reason: "file is read-only" },
    { status: "ok", surface: "agents/glass-atrium-dev-react.md" },
  ],
  onDismiss: noop,
});

const AGENTS = getMarkup("AgentModelsSectionMC", {
  state: "ready",
  agents: [{ name: "glass-atrium-dev-android", file: "glass-atrium-dev-android.md", role: "Android apps in Kotlin and Compose", pin: MODEL, registered: true }],
  unreadable: [],
  knownModels: [MODEL],
  onAgentsRead: noop,
  showToast: noop,
});

// the selection bar in its card slot: nothing ticked, three ticked, and Apply pressed with no model chosen
const getBar = (count: number, isModelMissing: boolean) =>
  `<div class="card-bar">${getMarkup("AgentBarMC", { count, model: "", knownModels: [MODEL], isModelMissing, isApplying: false, onModel: noop, onApply: noop, onClear: noop })}</div>`;
const BAR_STATES = { idle: getBar(0, false), ticked: getBar(3, false), missing: getBar(3, true) } as const;

// a field's saved line: overridden (Saved value + Reset) and back at the saved value (the empty slot)
const getSavedLine = (overridden: boolean) => getMarkup("GhostResetMC", { overridden, defaultValue: overridden ? MODEL : null, onReset: noop });

const PAGE = `<!doctype html><html><head><style>${PREFLIGHT}</style></head><body style="margin: 0;">
  <div id="models" style="width: 760px; padding: 24px;">${MODELS}</div>
  <div id="agents" style="width: 1100px; padding: 24px;">${AGENTS}</div>
${Object.entries(BAR_STATES).map(([state, bar]) => `  <div id="bar-${state}" style="width: 1100px; padding: 24px;">${bar}</div>`).join("\n")}
  <div id="caps" style="width: 560px; padding: 24px;">${CAPS}</div>
  <div id="results" style="width: 560px; padding: 24px;">${RESULTS}</div>
  <div id="saved-overridden" style="width: 280px; padding: 24px;">${getSavedLine(true)}</div>
  <div id="saved-empty" style="width: 280px; padding: 24px;">${getSavedLine(false)}</div>
</body></html>`;

const RESULTS_FOLD = "#results details";
const RESULTS_SUMMARY = `${RESULTS_FOLD} > summary`;

let browser: Browser;
let page: Page;
let cdp: CDPSession;
const { readBox, readStyle, assertBoxHeldAcrossStates, assertFoldOnOneBox } = createControlProbe(() => page, () => cdp);

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.setContent(PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
  await page.addStyleTag({ content: TYPE_SCALE_CSS });
  await page.addStyleTag({ content: getRoleKeyCss() });
  cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
});

after(async () => {
  await browser?.close();
});

describe("the save-results fold opens on the disclosure atom", () => {
  test("its summary is a 32 disclosure whose chevron alone marks it open", () => assertFoldOnOneBox(RESULTS_FOLD, RESULTS_SUMMARY));

  test("hover, focus-visible and active keep its box", () => assertBoxHeldAcrossStates(RESULTS_SUMMARY));
});

// engine floors the half-leading → only a whole-pixel line box keeps any face within 0.5; the line-height check is face-independent
const assertTextOnTargetCentre = async (selector: string) => {
  const box = await readBox(selector);
  assert.equal(box.height, 24);
  const lineHeight = await readStyle(selector, "line-height");
  assert.ok(Number.isInteger(parseFloat(lineHeight)), `line box ${lineHeight} is not a whole pixel`);
  const text = await page.$eval(selector, (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const { top, height } = range.getClientRects()[0];
    return top + height / 2;
  });
  assert.ok(Math.abs(text - (box.top + box.height / 2)) <= 0.5, `text centre ${text} vs box centre ${box.top + box.height / 2}`);
};

describe("the Cost & usage links are 24 targets", () => {
  for (const [name, selector] of [
    ["the agent card's Cost & usage link", "#agents a[href='#cost']"],
    ["a cap's Recent costs link", "#caps a[href='#cost']"],
  ] as const) {
    test(`${name} is 24 tall with its text on the box's centre line`, () => assertTextOnTargetCentre(selector));
  }
});

describe("a field's inline Reset is a 24 target in a slot that holds its height", () => {
  const RESET = "#saved-overridden button[aria-label='Reset this field to the saved value']";
  const SLOT = (state: "overridden" | "empty") => `#saved-${state} [data-slot='saved-line']`;

  test("Reset is 24 tall with its text on the box's centre line", () => assertTextOnTargetCentre(RESET));

  test("the saved line is as tall overridden as back at the saved value", async () => {
    const overridden = await readBox(SLOT("overridden"));
    const empty = await readBox(SLOT("empty"));
    assert.equal(overridden.height, empty.height, `overridden ${overridden.height} vs empty ${empty.height}`);
  });
});

describe("the selection bar never moves a row as ticks come and go", () => {
  test("idle, three ticked and the missing-model alert lay the bar out at one 48 height", async () => {
    const heights = await Promise.all(Object.keys(BAR_STATES).map(async (state) => [state, (await readBox(`#bar-${state} .card-bar`)).height] as const));
    assert.deepEqual(Object.fromEntries(heights), { idle: 48, ticked: 48, missing: 48 });
  });

  test("the count cell keeps its width when the missing-model alert takes its place", async () => {
    const cell = (state: string) => readBox(`#bar-${state} .agent-bar > :first-child`);
    const [count, alert] = await Promise.all([cell("ticked"), cell("missing")]);
    assert.equal(alert.width, count.width, `count ${count.width} vs alert ${alert.width}`);
  });
});
