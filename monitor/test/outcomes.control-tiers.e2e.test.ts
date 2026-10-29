// Task results pagination on one DESIGN.md §7.15 variant, measured in a real browser on the shipped tokens.css, base.css and the
// screen's own style block, rendered from the shipped components: the ledger's page "Previous / Next" and the result drawer's record
// "Previous / Next" draw the same small ghost button at rest and on hover, and each keeps one box in every state (§7.16).
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
  .gap-2 { gap: 0.5rem; } .mr-auto { margin-right: auto; } .px-4 { padding-left: 1rem; padding-right: 1rem; }
  .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; } .border-t { border-top-width: 1px; }
  .font-mono { font-family: ui-monospace, SFMono-Regular, monospace; }`;

const noop = () => undefined;
const READY = { status: "ready", busy: false, data: null, error: null };
const getLedger = (page: number) =>
  getMarkup("ResultTableCard", {
    state: READY, rows: [], totalMatched: 120, page, limit: 50, sort: "newest", filter: {},
    onPageChange: noop, onSortChange: noop, onResetFilter: noop, onRowClick: noop, onRetry: noop,
    closure: { pendingIds: new Set(), closedOverrides: new Map() }, needsYou: { rows: [], hiddenCount: 0 }, needsYouCap: 5,
  });
const RECORDS = [41, 42, 43].map((id) => ({ id, agent: "glass-atrium-dev-front", task_type: "refactor", result: "done", record_ts: "2026-10-29T10:00:00Z" }));
const DRAWER = getMarkup("DetailModal", {
  detailRow: RECORDS[1], detailState: { status: "loading", data: null, error: null }, rows: RECORDS, onClose: noop, onNav: noop,
});

const PAGE = `<!doctype html><html data-theme="dark"><head><style>${PREFLIGHT}</style></head><body style="margin: 0;">
  <div id="first-page" style="width: 1170px; padding: 24px;">${getLedger(0)}</div>
  <div id="mid-page" style="width: 1170px; padding: 24px;">${getLedger(1)}</div>
  <div id="drawer">${DRAWER}</div>
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

describe("the ledger pages with the drawer's Previous / Next variant", () => {
  for (const label of LABELS) {
    test(`ledger ${label} reads "${label}" and draws the drawer's ${label} button at rest and on hover`, async () => {
      const ledger = LEDGER_BUTTON("mid-page", label);
      assert.equal((await page.$eval(ledger, (el) => el.textContent))?.trim(), label);
      for (const state of [[], ["hover"]] as const) {
        assert.deepEqual(await readVariantIn(ledger, state), await readVariantIn(DRAWER_BUTTON(label), state), `${state[0] ?? "rest"}`);
      }
    });
  }
});

describe("each pagination button keeps one 32 box in every state", () => {
  for (const label of LABELS) {
    test(`ledger ${label} keeps its box under hover, focus-visible and active`, async () => {
      const selector = LEDGER_BUTTON("mid-page", label);
      assert.equal((await readBox(selector)).height, 32);
      await assertBoxHeldAcrossStates(selector);
    });
  }

  test("disabled on the first page, Previous keeps its enabled box", async () => {
    const disabled = LEDGER_BUTTON("first-page", "Previous");
    assert.equal(await page.$eval(disabled, (el) => (el as HTMLButtonElement).disabled), true);
    const enabled = await readBox(LEDGER_BUTTON("mid-page", "Previous"));
    const box = await readBox(disabled);
    assert.ok(isSameBox(box, enabled), `disabled ${box.width}x${box.height} vs enabled ${enabled.width}x${enabled.height}`);
  });
});
