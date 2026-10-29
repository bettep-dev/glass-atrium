// Cost controls on their DESIGN.md §7.15 tiers, measured in a real browser on the shipped tokens.css, base.css and the screen's own
// style block, rendered from the shipped components: the Cost by model head's "est. rate" pill at its control row's height, and the
// model ledger's row expander as a 24 target that keeps one box collapsed, expanded and in every pointer/keyboard state (§7.16).
// Runner: npx tsx --test test/cost.control-tiers.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, CDPSession, Page } from "playwright";
import { chromium } from "playwright";

import { createReactStub, collectText, findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";
import { type Box, createControlProbe, QUARTER_TURN, isSameBox } from "./lib/control-probe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");
const COST_SRC = resolve(HERE, "../public/src/screens/cost.jsx");

type Component = (props: unknown) => unknown;
const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
// one priced model and one the catalog does not know → the head carries the "est. rate" pill
const PRICED = "claude-opus-5-5";
const getTokenRate = (model: string) => (model === PRICED ? { input: 5, output: 25, cache_read: 0.5, cache_creation: 6.25 } : null);
const getScreen = (react: Record<string, unknown>) =>
  loadScreenModule(COST_SRC, { UI: ui.UI, React: react, Recharts: {}, getTokenRate, addEventListener: () => {}, removeEventListener: () => {} });
const closedScreen = await getScreen(createReactStub());
// the stub never re-renders, so the expanded row renders from a module whose boolean state starts true
const openScreen = await getScreen({ ...createReactStub(), useState: (initial: unknown) => [initial === false ? true : initial, () => undefined] });
const getMarkup = (screen: Record<string, unknown>, component: string, props: Record<string, unknown>): string =>
  getHtml(renderScreen((screen[component] as Component)(props)) as RenderedNode);
const SCREEN_CSS = findNodes(renderScreen((closedScreen.ScreenCost as Component)({ onNav: () => {} })), (n) => n.type === "style")
  .map((n) => collectText(n))
  .join("\n");

// The app loads Tailwind preflight and utilities from its CDN; these are the rules the measured geometry depends on, at their shipped values.
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; font-family: ui-sans-serif, system-ui, sans-serif; }
  svg { display: block; vertical-align: middle; }
  table { border-collapse: collapse; }
  button { font: inherit; line-height: inherit; color: inherit; margin: 0; padding: 0; background-color: transparent; }
  .flex { display: flex; } .items-center { align-items: center; } .gap-1 { gap: 0.25rem; } .gap-2 { gap: 0.5rem; }
  .ml-auto { margin-left: auto; } .shrink-0 { flex-shrink: 0; } .text-left { text-align: left; } .pl-6 { padding-left: 1.5rem; }
  .font-mono { font-family: ui-monospace, SFMono-Regular, monospace; } .font-semibold { font-weight: 600; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .rotate-90 { transform: rotate(90deg); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }`;

const noop = () => undefined;
const ROWS = [
  { model: PRICED, cost_usd: 41.2, session_count: 12, input_tokens: 120000, output_tokens: 48000, cache_read_tokens: 900000, cache_creation_tokens: 30000 },
  { model: "claude-fable-5-1", cost_usd: 3.4, session_count: 2, input_tokens: 9000, output_tokens: 3000, cache_read_tokens: 40000, cache_creation_tokens: 2000 },
];
const MODEL_CARD = getMarkup(closedScreen, "ModelCostCard", {
  state: { status: "ready", data: { rows: ROWS }, error: null },
  days: 30,
  failures: {},
  onRetry: noop,
  onNav: noop,
});
const LEDGER_ROW = { ...ROWS[0], fullModel: ROWS[0].model };
const getLedger = (screen: Record<string, unknown>) =>
  `<table class="tbl cost-tbl" style="width: 560px;"><tbody>${getMarkup(screen, "ModelCostRow", { r: LEDGER_ROW })}</tbody></table>`;

// the server capped the session read → the head says how many of the window's sessions loaded
const SESSION_ROW = { session_id: "s-1", cost_usd: 4.2, started_at: "2026-10-29T10:00:00Z", agent_count: 2 };
const SESSIONS_CARD = getMarkup(closedScreen, "SessionDistributionCard", {
  state: { status: "ready", data: { rows: [SESSION_ROW], truncated: true, total_session_count: 1800 }, error: null },
  days: 30, failures: {}, onRetry: noop, onNav: noop,
});

const PAGE = `<!doctype html><html data-theme="dark"><head><style>${PREFLIGHT}</style></head><body style="margin: 0;">
  <div id="card" style="width: 640px; padding: 24px;">${MODEL_CARD}</div>
  <div id="closed" style="padding: 24px;">${getLedger(closedScreen)}</div>
  <div id="open" style="padding: 24px;">${getLedger(openScreen)}</div>
  <div id="sessions" style="width: 640px; padding: 24px;">${SESSIONS_CARD}</div>
</body></html>`;

const EXPANDER = (id: string) => `#${id} tbody tr:first-child td:first-child > button`;

let browser: Browser;
let page: Page;
let cdp: CDPSession;
const { readBox, readStyle, assertBoxHeldAcrossStates } = createControlProbe(() => page, () => cdp);

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.setContent(PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
  await page.addStyleTag({ content: SCREEN_CSS });
  cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
});

after(async () => {
  await browser?.close();
});

const centreOf = (box: Box) => box.top + box.height / 2;

describe("the Cost by model head holds one control height", () => {
  test("the est. rate pill is as tall as the Models & budgets button and shares its centre line", async () => {
    const pill = await page.$eval("#card .pill", (el) => {
      const { top, height } = el.getBoundingClientRect();
      return { top, height, text: el.textContent };
    });
    const button = await readBox("#card .btn.sm");
    assert.match(pill.text ?? "", /1 est\. rate/);
    assert.equal(pill.height, button.height, `pill ${pill.height} vs button ${button.height}`);
    assert.equal(button.height, 32);
    assert.ok(Math.abs(pill.top + pill.height / 2 - centreOf(button)) < 0.5, "one centre line");
  });
});

describe("the Most expensive sessions head holds the loaded-count pill on the control height", () => {
  test("the pill is 32 and carries its own hover title", async () => {
    const selector = "#sessions .card-head .pill";
    assert.match((await page.$eval(selector, (el) => el.textContent)) ?? "", /1 of 1800 loaded/);
    assert.equal((await readBox(selector)).height, 32);
    assert.equal(await page.$eval(selector, (el) => el.getAttribute("title")), "Showing 1 of 1800 sessions");
  });
});

describe("a model ledger row's expander is a 24 target that keeps one box", () => {
  test("collapsed, it is 24 tall and its row stays 40", async () => {
    const box = await readBox(EXPANDER("closed"));
    assert.equal(box.height, 24);
    assert.equal((await readBox("#closed tbody tr:first-child")).height, 40);
  });

  test("the rotating disclosure chevron, not a swapped glyph, marks it expanded", async () => {
    const chevron = (id: string) => `${EXPANDER(id)} .disclosure-chevron`;
    assert.equal(await readStyle(chevron("closed"), "transform"), "none");
    assert.match(await readStyle(chevron("open"), "transform"), QUARTER_TURN);
    const glyphs = await page.$eval(EXPANDER("open"), (el) => el.textContent?.replace(/claude-[\w-]+|\s/g, "") ?? "");
    assert.equal(glyphs, "", "no text glyph beside the model name");
  });

  test("expanded, it keeps its collapsed box", async () => {
    const closed = await readBox(EXPANDER("closed"));
    const open = await readBox(EXPANDER("open"));
    assert.ok(isSameBox(open, closed), `expanded ${open.width}x${open.height} vs collapsed ${closed.width}x${closed.height}`);
  });

  test("hover, focus-visible and active keep its box", () => assertBoxHeldAcrossStates(EXPANDER("closed")));
});
