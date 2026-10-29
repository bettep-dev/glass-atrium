// Documents controls on their DESIGN.md §7.15 tiers, measured in a real browser on the shipped tokens.css, base.css and the screen's
// own style block, rendered from the shipped components: the list toolbar row and its search field, the lineage and stage pills,
// the open-summary link and the version-history fold — each keeps one box in every state (§7.16).
// Runner: npx tsx --test test/clauded-docs.control-tiers.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, CDPSession, Page } from "playwright";
import { chromium } from "playwright";

import { createReactStub, collectText, findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

type Component = (props: unknown) => unknown;
const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const docsScreen = await loadScreenModule(resolve(HERE, "../public/src/screens/clauded-docs.jsx"), {
  UI: ui.UI,
  React: createReactStub(),
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
const getMarkup = (component: string, props: Record<string, unknown>): string =>
  getHtml(renderScreen((docsScreen[component] as Component)(props)) as RenderedNode);
const SCREEN_CSS = findNodes(renderScreen((docsScreen.ScreenClaudedDocs as Component)({})), (n) => n.type === "style")
  .map((n) => collectText(n))
  .join("\n");

// The app loads Tailwind preflight and utilities from its CDN and .fs-meta from ui.jsx; these are the rules the measured
// geometry depends on, at their shipped values — ChipGroup and the checkbox lay out on the utilities.
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; font-family: ui-sans-serif, system-ui, sans-serif; }
  svg { display: block; vertical-align: middle; }
  table { border-collapse: collapse; }
  button, input, select { font: inherit; line-height: inherit; color: inherit; margin: 0; padding: 0; background-color: transparent; }
  summary { display: list-item; }
  .flex { display: flex; } .flex-wrap { flex-wrap: wrap; } .flex-col { flex-direction: column; } .flex-1 { flex: 1 1 0%; }
  .items-center { align-items: center; } .justify-center { justify-content: center; } .gap-1 { gap: 0.25rem; } .gap-2 { gap: 0.5rem; }
  .gap-x-6 { column-gap: 1.5rem; } .gap-y-2 { row-gap: 0.5rem; } .relative { position: relative; } .absolute { position: absolute; }
  .mx-auto { margin-left: auto; margin-right: auto; } .ml-auto { margin-left: auto; } .min-w-0 { min-width: 0; } .overflow-x-auto { overflow-x: auto; }
  .px-4 { padding-left: 1rem; padding-right: 1rem; } .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; } .pointer-events-none { pointer-events: none; }
  .font-mono { font-family: ui-monospace, SFMono-Regular, monospace; } .uppercase { text-transform: uppercase; } .tracking-wider { letter-spacing: 0.05em; }
  .fs-meta { font-size: var(--fs-meta); line-height: 1.4; }`;

const DAY_MS = 86_400_000;
const getDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
const noop = () => undefined;
const docRow = (id: number, extra: Record<string, unknown> = {}) => ({
  id, title: `Plan ${id}`, doc_status: "implementing", format: "md", audience: "exposed",
  author: "glass-atrium-intel-planner", created_at: getDaysAgo(2), member_count: 1, folder_id: null, ...extra,
});
// the owner's case: the Open filter pressed with group counts, a revision row, and one row tagged apart → the "unless tagged" meta
const LIST_CARD = getMarkup("DocListCardCD", {
  state: { status: "ready", data: {} },
  rows: [docRow(39825, { supersedes_id: 39801, created_at: getDaysAgo(37) }), docRow(39826, { doc_status: "doc_review" }), docRow(39827, { format: "html" })],
  isSearchMode: false, selectedId: null, pendingDelete: null, hiddenCount: 0, total: 17, docTotal: 25,
  groupCounts: { open: 17, done: 26, total: 43 }, visibleCount: 3, canLoadMore: false, loadMoreRemaining: 0, isLoadingMore: false,
  onLoadMore: noop, selectedIds: new Set(), onToggleSelection: noop, onSelectAll: noop, onClearSelection: noop,
  expandedFolderIds: new Set(), onToggleExpand: noop, onGroupCreate: noop, onUngroup: noop, onExportZip: noop, onReorder: noop,
  onPickStage: noop, togglingIds: new Set(), optimisticStatusOverrides: new Map(), onSelect: noop, onRetry: noop,
  inlineFilterProps: { keyword: "", docStatusFilter: "open", audienceFilter: "all", onKeywordChange: noop, onDocStatusChange: noop, onAudienceChange: noop },
});
const VERSION_HISTORY = getMarkup("PredecessorPanelCD", { predecessorId: 39801, currentDoc: { id: 39825 }, onNavigate: noop });

// reference atoms the Documents controls must match
const REFERENCES = `<input id="ref-field" class="field" value="x" /><button id="ref-btn-sm" type="button" class="btn ghost sm">Ref</button>`;
const PAGE = `<!doctype html><html data-theme="dark"><head><style>${PREFLIGHT}</style></head><body style="margin: 0;">
  <div id="refs" style="padding: 24px; display: flex; gap: 8px;">${REFERENCES}</div>
  <div id="frame" style="padding: 24px;">${LIST_CARD}</div>
  <div style="width: 300px; padding: 24px;">${VERSION_HISTORY}</div>
</body></html>`;

// the toolbar is the list card's first row, whatever class it carries
const TOOLBAR = "#docs-list > div:first-child > div:first-child";
// card widths: the rail layout, then the 1024–1280 band the audit wrapped in, then the 820 viewport's card and below
const CARD_WIDTHS = [1300, 1100, 960, 760, 640, 520] as const;

interface Box { left: number; right: number; top: number; bottom: number; width: number; height: number }

let browser: Browser;
let page: Page;
let cdp: CDPSession;

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

const setCardWidth = (width: number) => page.$eval("#frame", (el, w) => { (el as HTMLElement).style.width = `${w + 48}px`; }, width);

const readBox = (selector: string): Promise<Box> =>
  page.$eval(selector, (el) => {
    const { left, right, top, bottom, width, height } = el.getBoundingClientRect();
    return { left, right, top, bottom, width, height };
  });

const readStyle = (selector: string, prop: string): Promise<string> =>
  page.$eval(selector, (el, name) => getComputedStyle(el).getPropertyValue(name), prop);

async function forcePseudo(selector: string, classes: readonly string[]): Promise<void> {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [...classes] });
}

const PSEUDO_STATES = [["hover"], ["focus-visible"], ["active"]] as const;

// a control's border-box at rest, then under each forced pseudo state
async function assertBoxHeldAcrossStates(selector: string): Promise<void> {
  const rest = await readBox(selector);
  for (const state of PSEUDO_STATES) {
    await forcePseudo(selector, state);
    try {
      const changed = await readBox(selector);
      assert.ok(Math.abs(changed.width - rest.width) < 0.01 && Math.abs(changed.height - rest.height) < 0.01,
        `${selector} ${state[0]} ${changed.width}x${changed.height} vs resting ${rest.width}x${rest.height}`);
    } finally {
      await forcePseudo(selector, []);
    }
  }
}

const centreOf = (box: Box) => (box.top + box.bottom) / 2;

describe("the Documents list toolbar is one control row", () => {
  test("at a width that holds it on one line, the row is 48 tall and every item centres on its one line", async () => {
    await setCardWidth(1300);
    const row = await readBox(TOOLBAR);
    assert.equal(Math.round(row.height), 48, `toolbar row ${row.height}`);
    const items = await page.$$eval(`${TOOLBAR} > *`, (els) => els.map((el) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2; }));
    for (const [index, centre] of items.entries()) assert.ok(Math.abs(centre - centreOf(row)) <= 0.5, `item ${index} centre ${centre} vs row ${centreOf(row)}`);
  });

  for (const width of CARD_WIDTHS) {
    test(`at a ${width} card every control in the row is one 32 control height`, async () => {
      await setCardWidth(width);
      const heights = await page.$$eval(`${TOOLBAR} :is(input, button)`, (els) => els.map((el) => el.getBoundingClientRect().height));
      assert.ok(heights.length >= 7, `${heights.length} controls`);
      for (const height of heights) assert.equal(height, 32, `control heights ${heights.join(", ")}`);
    });
  }
});

describe("the Documents search sits on the .field atom", () => {
  const SEARCH = `${TOOLBAR} input[type="search"]`;

  test("its box, type size and fill match a .field", async () => {
    await setCardWidth(1300);
    const [search, field] = await Promise.all([readBox(SEARCH), readBox("#ref-field")]);
    assert.equal(search.height, field.height, `search ${search.height} vs field ${field.height}`);
    for (const prop of ["font-size", "line-height", "background-color", "border-top-width", "border-top-color", "padding-top", "padding-right"]) {
      assert.equal(await readStyle(SEARCH, prop), await readStyle("#ref-field", prop), prop);
    }
  });

  test("the icon sits in the inline-start gutter: one field padding from the edge, one before the text, on the field's centre line", async () => {
    const search = await readBox(SEARCH);
    const icon = await readBox(`${TOOLBAR} .doc-search-icon`);
    const [padStart, padEnd, border] = await Promise.all(["padding-left", "padding-right", "border-left-width"].map((prop) => readStyle(SEARCH, prop).then(parseFloat)));
    assert.ok(Math.abs(icon.left - (search.left + border + padEnd)) <= 0.5, `icon at ${icon.left - search.left} from the edge`);
    assert.ok(Math.abs(search.left + border + padStart - (icon.right + padEnd)) <= 0.5, `text starts ${search.left + border + padStart - icon.right} past the icon`);
    assert.ok(Math.abs(centreOf(icon) - centreOf(search)) <= 0.5, `icon centre ${centreOf(icon)} vs field ${centreOf(search)}`);
  });

  test("hover, focus-visible and active keep its box", () => assertBoxHeldAcrossStates(SEARCH));
});

describe("each toolbar label wraps with its group, and the count meta wraps as one right-aligned unit", () => {
  for (const width of CARD_WIDTHS) {
    test(`at a ${width} card`, async () => {
      await setCardWidth(width);
      // runs in the page → no named helper: tsx's keepNames wraps one in a __name call the page does not define
      const reading = await page.$eval(TOOLBAR, (row) => {
        const chips = [...row.querySelectorAll("[role=toolbar] button")];
        const labels = [...row.querySelectorAll(".doc-filter-label")].map((label) => ({
          text: label.textContent,
          label: label.getBoundingClientRect().toJSON() as DOMRect,
          // the label's group: the first chip after it in document order
          chip: chips.find((b) => label.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)?.getBoundingClientRect().toJSON() as DOMRect | undefined,
        }));
        return {
          labels,
          count: row.querySelector("[aria-live]")?.getBoundingClientRect().toJSON() as DOMRect | undefined,
          shared: row.querySelector(".doc-list-shared")?.getBoundingClientRect().toJSON() as DOMRect | undefined,
          contentRight: row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight),
        };
      });
      for (const { text, label, chip } of reading.labels) {
        assert.ok(label && chip, `${text} has a group`);
        assert.ok(Math.abs(centreOf(label as Box) - centreOf(chip as Box)) <= 1, `${text} label line ${centreOf(label as Box)} vs its first chip ${centreOf(chip as Box)}`);
      }
      const { count, shared } = reading;
      assert.ok(count && shared, "the count and the shared tags show");
      assert.ok(Math.abs(centreOf(count as Box) - centreOf(shared as Box)) <= 1, `count line ${centreOf(count as Box)} vs shared tags ${centreOf(shared as Box)}`);
      assert.ok(Math.abs((shared as Box).right - reading.contentRight) <= 1, `meta ends at ${(shared as Box).right}, row content at ${reading.contentRight}`);
    });
  }

  test("the counter is one unbroken span that carries its value in a title", async () => {
    await setCardWidth(520);
    const counter = `${TOOLBAR} [aria-live]`;
    assert.equal(await readStyle(counter, "white-space"), "nowrap");
    const { text, title } = await page.$eval(counter, (el) => ({ text: el.textContent, title: el.getAttribute("title") }));
    assert.equal(title, text);
  });
});

describe("the ledger's pills sit on the interactive pill tier", () => {
  const LINEAGE = "#docs-list button.doc-lineage";

  test("the lineage pill is a 32 control and its row stays 40 like a row without one", async () => {
    await setCardWidth(1300);
    assert.equal((await readBox(LINEAGE)).height, 32);
    const heights = await page.$$eval("#docs-list tr.doc-row", (rows) => rows.map((tr) => tr.getBoundingClientRect().height));
    for (const height of heights) assert.ok(Math.abs(height - 40) < 0.5, `ledger rows ${heights.join(", ")}`);
  });

  test("hover, focus-visible and active keep the lineage pill's box", () => assertBoxHeldAcrossStates(LINEAGE));

  test("the stage picker and the filter chips share one .pill--interactive typography", async () => {
    const STAGE = "#docs-list .doc-stage-pill";
    const CHIP = `${TOOLBAR} [role=toolbar] button.pill--interactive`;
    for (const prop of ["font-weight", "line-height", "font-size"]) assert.equal(await readStyle(STAGE, prop), await readStyle(CHIP, prop), prop);
  });

  test("the clamped stage label keeps its face's descenders inside its box", async () => {
    const labels = await page.$$eval("#docs-list .doc-ledger-scroll .doc-stage-label", (els) => els.map((el) => ({ scroll: el.scrollHeight, client: el.clientHeight })));
    assert.ok(labels.length > 0);
    for (const { scroll, client } of labels) assert.ok(scroll <= client, `label content ${scroll} in a ${client} box`);
  });
});

describe("the open-summary rail's Oldest open link is a small button", () => {
  const OLDEST = "#docs-list .doc-open-oldest";

  test("beside the ledger it keeps the small-button padding on one line, its label starting at the rail's label edge", async () => {
    await setCardWidth(1300);
    for (const side of ["top", "right", "bottom", "left"]) {
      assert.equal(await readStyle(OLDEST, `padding-${side}`), await readStyle("#ref-btn-sm", `padding-${side}`), `padding-${side}`);
    }
    assert.equal((await readBox(OLDEST)).height, 32, "one line");
    const { text, label } = await page.$eval("#docs-list .doc-open-summary", (rail) => {
      const range = document.createRange();
      range.selectNodeContents(rail.querySelector(".doc-open-oldest")!);
      return { text: range.getBoundingClientRect().left, label: rail.querySelector("dt")!.getBoundingClientRect().left };
    });
    assert.ok(Math.abs(text - label) <= 1, `Oldest open text at ${text}, labels at ${label}`);
  });

  test("hover, focus-visible and active keep its box", () => assertBoxHeldAcrossStates(OLDEST));
});

describe("the version-history fold opens on the disclosure atom", () => {
  const SUMMARY = "details.doc-version-history > summary";

  test("its summary is a 32 disclosure with the chevron as the one open-state cue, turned 90 once open", async () => {
    const closed = await readBox(SUMMARY);
    assert.equal(closed.height, 32);
    assert.notEqual(await readStyle(SUMMARY, "display"), "list-item", "no UA marker");
    const chevron = `${SUMMARY} .disclosure-chevron`;
    assert.equal(await readStyle(chevron, "transform"), "none");
    await page.$eval("details.doc-version-history", (el) => { (el as HTMLDetailsElement).open = true; });
    try {
      const open = await readBox(SUMMARY);
      assert.ok(Math.abs(open.width - closed.width) < 0.01 && Math.abs(open.height - closed.height) < 0.01, `open ${open.width}x${open.height} vs closed ${closed.width}x${closed.height}`);
      const turn = await readStyle(chevron, "transform");
      assert.match(turn, /^matrix\(6\.1\d*e-17, 1, -1, 6\.1\d*e-17, 0, 0\)$|^matrix\(0, 1, -1, 0, 0, 0\)$/, `open chevron ${turn}`);
    } finally {
      await page.$eval("details.doc-version-history", (el) => { (el as HTMLDetailsElement).open = false; });
    }
  });

  test("hover, focus-visible and active keep its box", () => assertBoxHeldAcrossStates(SUMMARY));
});
