// Task results controls on their DESIGN.md §7.15 tiers, measured in a real browser on the shipped tokens.css, base.css and the
// screen's own style block, rendered from the shipped components: the ledger's page "Previous / Next" and the result drawer's record
// "Previous / Next" draw the same small ghost button at rest and on hover, the filter panel's "More filters" fold opens on the
// disclosure atom, each keeps one box in every state, the panel's Record scope checkbox stands on the C24 inline-target tier, and a
// card head's static pill stands on the 32 control height (§7.16).
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
  .gap-2 { gap: 0.5rem; } .mb-1 { margin-bottom: 0.25rem; } .mr-auto { margin-right: auto; } .px-4 { padding-left: 1rem; padding-right: 1rem; }
  .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; } .border-t { border-top-width: 1px; }
  .font-mono { font-family: ui-monospace, SFMono-Regular, monospace; }
  .uppercase { text-transform: uppercase; } .tracking-wider { letter-spacing: 0.05em; }`;

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

const FILTERS = getMarkup("FilterPanelO", {
  filter: {}, distinctAgents: ["glass-atrium-dev-front"], includeAll: false, sort: "newest",
  onPatchFilter: noop, onToggleIncludeAll: noop, onSortChange: noop, onReset: noop,
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
  <div id="drawer">${DRAWER}</div>
  <div id="filters" style="width: 280px; padding: 12px;">${FILTERS}</div>
  <div id="crosstab" style="width: 560px; padding: 24px;">${CROSSTAB}</div>
  <div id="attribution" style="width: 560px; padding: 24px;">${ATTRIBUTION}</div>
  <div id="channels" style="width: 560px; padding: 24px;">${CHANNELS}</div>
</body></html>`;

const LEDGER_BUTTON = (id: string, label: string) => `#${id} button[aria-label="${label} page"]`;
const DRAWER_BUTTON = (label: string) => `#drawer .detail-nav button[aria-label="${label} record"]`;
const LABELS = ["Previous", "Next"] as const;
const MORE_FILTERS = "#filters details";
// the properties that make a button variant: its edge, fill, ink, type and box
const VARIANT_PROPS = ["border-top-color", "border-top-width", "background-color", "color", "font-size", "font-weight", "padding-top", "padding-left", "height"] as const;

let browser: Browser;
let page: Page;
let cdp: CDPSession;
const { readBox, readStyle, setOpen, forcePseudo, assertBoxHeldAcrossStates, assertFoldOnOneBox } = createControlProbe(() => page, () => cdp);

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

describe("the filter panel's More filters fold opens on the disclosure atom", () => {
  const summary = `${MORE_FILTERS} > summary`;

  test("its summary is a 32 disclosure with the chevron as the one open-state cue, turned 90 once open", () => assertFoldOnOneBox(MORE_FILTERS, summary));

  test("hover, focus-visible and active keep its box", () => assertBoxHeldAcrossStates(summary));
});

describe("the filter panel's Record scope checkbox stands on the C24 inline-target tier", () => {
  const hit = `${MORE_FILTERS} label:has(> input[type="checkbox"])`;
  const box = `${hit} > input`;

  test("its label is a 24 hit area around a 16 accent box, the text on the box's centre line, 4 below the group label", async () => {
    await setOpen(MORE_FILTERS, true);
    try {
      const [hitBox, visual, text, groupLabel] = await Promise.all([readBox(hit), readBox(box), readBox(`${hit} > span`), readBox(`${MORE_FILTERS} div:has(input[type="checkbox"]) > div.fs-meta`)]);
      const accent = await page.$eval(hit, (el) => {
        const probe = el.appendChild(document.createElement("i"));
        probe.style.accentColor = "rgb(var(--accent))";
        const value = getComputedStyle(probe).accentColor;
        probe.remove();
        return value;
      });
      assert.ok(hitBox.height >= 24 && hitBox.width >= 24, `hit ${hitBox.width}x${hitBox.height}`);
      assert.deepEqual([visual.width, visual.height], [16, 16], "checkbox visual");
      assert.equal(await readStyle(box, "accent-color"), accent);
      assert.ok(Math.abs(text.top + text.height / 2 - (visual.top + visual.height / 2)) < 0.5, "one centre line");
      assert.equal(hitBox.top - groupLabel.bottom, 4, "label-to-content step");
    } finally {
      await setOpen(MORE_FILTERS, false);
    }
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
