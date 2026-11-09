// Task results controls on their DESIGN.md §7.15 tiers, measured in a real browser on the shipped tokens.css, base.css and the
// screen's own style block, rendered from the shipped components: the ledger's page "Previous / Next" each keep one box in every
// state, the Time sort control draws the drawer's small ghost button, a card head's static
// pill stands on the 32 control height (§7.16), and the Results filter bar holds still as a keyword lands, each trigger naming its value.
// Runner: npx tsx --test test/outcomes.control-tiers.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, CDPSession, Page } from "playwright";
import { chromium } from "playwright";

import { createReactStub, collectText, findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";
import { createControlProbe, isSameBox } from "./lib/control-probe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

type Component = (props: unknown) => unknown;
const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const resultsScreen = await loadScreenModule(resolve(HERE, "../public/src/screens/outcomes.jsx"), {
  UI: ui.UI,
  React: createReactStub(),
  location: { hash: "" },
  URLSearchParams,
});
const getMarkup = (component: string, props: Record<string, unknown>): string =>
  getHtml(renderScreen((resultsScreen[component] as Component)(props)) as RenderedNode);
const SCREEN_CSS = findNodes(renderScreen((resultsScreen.ScreenOutcomes as Component)({ onNav: () => {} })), (n) => n.type === "style")
  .map((n) => collectText(n))
  .join("\n");

// The app loads Tailwind preflight and utilities from its CDN; these are the rules the measured geometry depends on, at their shipped values.
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; font-family: ui-sans-serif, system-ui, sans-serif; }
  svg { display: block; vertical-align: middle; }
  button { font: inherit; line-height: inherit; color: inherit; margin: 0; padding: 0; background-color: transparent; }
  .flex { display: flex; } .items-center { align-items: center; } .justify-between { justify-content: space-between; }
  summary { display: list-item; }
  .ml-auto { margin-left: auto; } .shrink-0 { flex-shrink: 0; } .inline-grid { display: inline-grid; } .justify-items-end { justify-items: end; }
  .col-start-1 { grid-column-start: 1; } .row-start-1 { grid-row-start: 1; } .invisible { visibility: hidden; }
  .tabular-nums { font-variant-numeric: tabular-nums; }
  .gap-2 { gap: 0.5rem; } .mb-1 { margin-bottom: 0.25rem; } .mr-auto { margin-right: auto; } .px-4 { padding-left: 1rem; padding-right: 1rem; }
  .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; } .border-t { border-top-width: 1px; } .border-b { border-bottom-width: 1px; }
  .border-line { border-color: rgb(var(--line)); } .gap-1 { gap: 0.25rem; } .flex-wrap { flex-wrap: wrap; }
  .font-mono { font-family: ui-monospace, SFMono-Regular, monospace; }
  .uppercase { text-transform: uppercase; } .tracking-wider { letter-spacing: 0.05em; }`;

const noop = () => undefined;
const READY = { status: "ready", busy: false, data: null, error: null };
const LEDGER_PROPS = {
  state: READY, rows: [], totalMatched: 120, limit: 50, sort: "newest",
  onPageChange: noop, onSortChange: noop, onResetFilter: noop, onRowClick: noop, onRetry: noop,
  closure: { pendingIds: new Set(), closedOverrides: new Map() }, needsYou: { rows: [], hiddenCount: 0 }, needsYouCap: 5,
};
const getLedger = (page: number) => getMarkup("ResultTableCard", { ...LEDGER_PROPS, page, filter: {} });
// the Results head while the search is idle, once a typed keyword reaches the filter, and with a popover filter set
const getResultsHead = (filter: Record<string, unknown>, keywordInput: string) =>
  getMarkup("ResultTableCard", { ...LEDGER_PROPS, page: 0, filter, filterControls: { keywordInput, distinctAgents: [], includeAll: false } });
const HEADS = {
  idle: getResultsHead({ days: 30 }, ""),
  typed: getResultsHead({ days: 30, q: "phase" }, "phase"),
  filtered: getResultsHead({ days: 30, agent: "glass-atrium-dev-front" }, ""),
};
const RECORDS = [41, 42, 43].map((id) => ({ id, agent: "glass-atrium-dev-front", task_type: "refactor", result: "done", record_ts: "2026-10-29T10:00:00Z" }));
// the column headers render only for a loaded ledger with rows
const LEDGER_WITH_ROWS = getMarkup("ResultTableCard", {
  ...LEDGER_PROPS, state: { ...READY, data: { rows: RECORDS } }, rows: RECORDS, sort: "record_ts:desc", page: 0, filter: {},
});
const DRAWER = getMarkup("DetailModal", {
  detailRow: RECORDS[1], detailState: { status: "loading", data: null, error: null }, rows: RECORDS, onClose: noop, onNav: noop,
});

// a card head whose right slot holds a static status pill: beside the info button (Confident but failed) or alone
const CROSSTAB = getMarkup("CrosstabCard", {
  state: { status: "ready", data: { crosstab: { polarTotal: 4, total: 40, byCell: { "high|false": { count: 3 } }, cells: [] } }, error: null },
  onRetry: noop, shared: {},
});
const LOADING = { status: "loading", data: null, error: null };
const ATTRIBUTION = getMarkup("AttributionHealthCard", { state: LOADING, period: 30, onRetry: noop, shared: {} });
const CHANNELS = getMarkup("ChannelLivenessCard", { state: LOADING, onRetry: noop, shared: {} });

const PAGE = `<!doctype html><html data-theme="dark"><head><style>${PREFLIGHT}</style></head><body style="margin: 0;">
  <div id="first-page" style="width: 1170px; padding: 24px;">${getLedger(0)}</div>
  <div id="mid-page" style="width: 1170px; padding: 24px;">${getLedger(1)}</div>
  <div id="ledger-rows" style="width: 1170px; padding: 24px;">${LEDGER_WITH_ROWS}</div>
  <div id="drawer">${DRAWER}</div>
  <div id="crosstab" style="width: 560px; padding: 24px;">${CROSSTAB}</div>
  <div id="attribution" style="width: 560px; padding: 24px;">${ATTRIBUTION}</div>
  <div id="channels" style="width: 560px; padding: 24px;">${CHANNELS}</div>
  ${Object.entries(HEADS).map(([name, markup]) => `<div id="head-${name}" style="width: 1170px; padding: 24px;">${markup}</div>`).join("\n  ")}
</body></html>`;

const LEDGER_BUTTON = (id: string, label: string) => `#${id} button[aria-label="${label} page"]`;
const DRAWER_BUTTON = (label: string) => `#drawer .detail-nav button[aria-label="${label} record"]`;
const LABELS = ["Previous", "Next"] as const;
// the properties that make a button variant: its edge, fill, ink, type and box
const VARIANT_PROPS = ["border-top-color", "border-top-width", "background-color", "color", "font-size", "font-weight", "padding-top", "padding-left", "height"] as const;

let browser: Browser;
let page: Page;
let cdp: CDPSession;
const { readBox, forcePseudo, assertBoxHeldAcrossStates } = createControlProbe(() => page, () => cdp);

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

// .btn eases its fill and edge (0.12s) → read once the state's transition settles, not a mid-flight value
const readVariant = (selector: string): Promise<Record<string, string>> =>
  page.$eval(selector, async (el, props) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished));
    const style = getComputedStyle(el);
    return Object.fromEntries(props.map((p) => [p, style.getPropertyValue(p)]));
  }, [...VARIANT_PROPS]);

async function readVariantIn(selector: string, state: readonly string[]): Promise<Record<string, string>> {
  await forcePseudo(selector, state);
  try {
    return await readVariant(selector);
  } finally {
    await forcePseudo(selector, []);
  }
}

describe("each pagination button keeps one 32 box in every state", () => {
  for (const label of LABELS) {
    test(`ledger ${label} keeps its box under hover, focus-visible and active`, async () => {
      const selector = LEDGER_BUTTON("mid-page", label);
      assert.equal((await readBox(selector)).height, 32);
      await assertBoxHeldAcrossStates(selector);
    });
  }

  test("unavailable on the first page, Previous stays focusable and keeps its enabled box", async () => {
    const disabled = LEDGER_BUTTON("first-page", "Previous");
    assert.equal(await page.$eval(disabled, (el) => el.getAttribute("aria-disabled")), "true");
    const enabled = await readBox(LEDGER_BUTTON("mid-page", "Previous"));
    const box = await readBox(disabled);
    assert.ok(isSameBox(box, enabled), `disabled ${box.width}x${box.height} vs enabled ${enabled.width}x${enabled.height}`);
  });
});

// the Time column's sort control: a button inside the header cell, which keeps aria-sort
const SORT_BUTTON = "#ledger-rows th[aria-sort] > button";
const TIME_CELL = "#ledger-rows tbody tr.outcome-row > td:first-child";
const LEDGER_TITLE = "#ledger-rows .card-head .card-title";

// where an element's first rendered glyph starts → a label's x, whatever box or padding wraps it
const readTextLeft = (selector: string): Promise<number> =>
  page.$eval(selector, (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !text.textContent?.trim()) text = walker.nextNode();
    if (!text) throw new Error(`no text in ${el.outerHTML.slice(0, 80)}`);
    const range = document.createRange();
    range.selectNodeContents(text);
    return range.getBoundingClientRect().left;
  });

// the header row it sits in stays 40: ui.row-geometry pins a sortable header row holding a 32px control
describe("the ledger's Time header sorts through the drawer's small ghost button", () => {
  test("it draws the drawer's Next variant and keeps one 32 box in every state", async () => {
    assert.deepEqual(await readVariantIn(SORT_BUTTON, []), await readVariantIn(DRAWER_BUTTON("Next"), []));
    assert.equal((await readBox(SORT_BUTTON)).height, 32);
    await assertBoxHeldAcrossStates(SORT_BUTTON);
  });

  test("its label starts on the column's text axis: the Time cells' text and the card head's title", async () => {
    const label = await readTextLeft(SORT_BUTTON);
    for (const [name, selector] of [["the Time cells' text", TIME_CELL], ["the card head's title", LEDGER_TITLE]]) {
      const axis = await readTextLeft(selector);
      assert.ok(Math.abs(label - axis) < 0.01, `label x ${label} ↔ ${name} x ${axis}`);
    }
  });

  test("Enter and Space on the focused button each activate it", async () => {
    await page.$eval(SORT_BUTTON, (el) => {
      el.addEventListener("click", () => { (el as HTMLElement).dataset.clicks = String(Number((el as HTMLElement).dataset.clicks ?? 0) + 1); });
    });
    await page.focus(SORT_BUTTON);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    assert.equal(await page.$eval(SORT_BUTTON, (el) => (el as HTMLElement).dataset.clicks), "2");
  });
});

describe("the ledger's pagination row is the card's 40 foot", () => {
  test("it is 40 tall with its page buttons centred below its top rule", async () => {
    const { foot, button } = await page.$eval(LEDGER_BUTTON("mid-page", "Next"), (el) => ({
      foot: el.closest(".card > *")!.getBoundingClientRect().toJSON() as DOMRect,
      button: el.getBoundingClientRect().toJSON() as DOMRect,
    }));
    assert.equal(foot.height, 40);
    const centre = (button.top + button.bottom) / 2;
    const below = (foot.top + 1 + foot.bottom) / 2;
    assert.ok(Math.abs(centre - below) <= 0.5, `button centre ${centre} vs the foot's ${below} below its rule`);
  });
});

describe("a static pill in a card head stands on the head's 32 control height", () => {
  test("Confident but failed: the mismatches pill matches the info button's height and centre line", async () => {
    const pill = await readBox("#crosstab .card-head .pill");
    const info = await readBox("#crosstab .card-head .btn.icon");
    assert.match((await page.$eval("#crosstab .card-head .pill", (el) => el.textContent)) ?? "", /4 mismatches/);
    assert.equal(info.height, 32);
    assert.equal(pill.height, info.height, `pill ${pill.height} vs info ${info.height}`);
    assert.ok(Math.abs(pill.top + pill.height / 2 - (info.top + info.height / 2)) < 0.5, "one centre line");
  });

  for (const card of ["attribution", "channels"]) {
    test(`${card}: the head's lone status pill is 32 too`, async () => {
      assert.equal((await readBox(`#${card} .card-head .pill`)).height, 32);
    });
  }
});

describe("the Results filter bar holds still as its filters change", () => {
  const BAR_CONTROLS = ':is(input[aria-label="Keyword search"], .filter-trigger, .filter-bar-reset)';
  const readBar = (name: keyof typeof HEADS) =>
    page.$$eval(`#head-${name} .card-bar ${BAR_CONTROLS}`, (controls) => controls.map((control) => {
      const bar = control.closest(".card-bar")!.getBoundingClientRect();
      const { left, top, width, height } = control.getBoundingClientRect();
      return { left: left - bar.left, top: top - bar.top, width, height, visibility: getComputedStyle(control).visibility };
    }));

  test("a typed keyword reaching the filter shows Reset in the slot it kept at defaults, every control in place", async () => {
    const [idle, typed] = await Promise.all([readBar("idle"), readBar("typed")]);
    assert.deepEqual(idle.map(({ visibility }) => visibility).at(-1), "hidden", "Reset at defaults");
    assert.deepEqual(typed.map(({ visibility }) => visibility).at(-1), "visible", "Reset once a keyword applies");
    assert.deepEqual(typed.map(({ visibility, ...box }) => box), idle.map(({ visibility, ...box }) => box), "boxes typed vs idle");
  });

  test("an applied axis names its value on its trigger, the rest name All", async () => {
    const readValues = (name: keyof typeof HEADS) =>
      page.$$eval(`#head-${name} .filter-trigger`, (triggers) => triggers.map((trigger) => trigger.querySelector(".filter-trigger-value")!.textContent));
    const [idle, filtered] = await Promise.all([readValues("idle"), readValues("filtered")]);
    // loadScreenModule types every export unknown → ui.jsx's shipped name helper
    const { getAgentDisplayName } = ui.UI as { getAgentDisplayName: (name: string) => string };
    assert.equal(filtered[0], getAgentDisplayName("glass-atrium-dev-front"));
    assert.deepEqual(filtered.slice(1), idle.slice(1));
    assert.equal(idle[0], "All");
  });
});
