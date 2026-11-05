// Agents controls on their DESIGN.md §7.15 tiers, measured in a real browser on the shipped tokens.css, base.css and the screen's own
// style block, rendered from the shipped components: a static pill in a card head stands on the 32 control height beside the head's
// info button, the ledger's Sort label sits 4 from its select, and a Most-failing pairs agent link is a 24 target in a 40 row (§7.16).
// Runner: npx tsx --test test/agents.control-tiers.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, CDPSession, Page } from "playwright";
import { chromium } from "playwright";

import { createReactStub, collectText, findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";
import { createControlProbe, type Box } from "./lib/control-probe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

type Component = (props: unknown) => unknown;
const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const agentsScreen = await loadScreenModule(resolve(HERE, "../public/src/screens/agents.jsx"), {
  UI: ui.UI,
  React: createReactStub(),
  Recharts: {},
});
const getMarkup = (component: string, props: Record<string, unknown>): string =>
  getHtml(renderScreen((agentsScreen[component] as Component)(props)) as RenderedNode);
const SCREEN_CSS = findNodes(renderScreen((agentsScreen.ScreenAgents as Component)({ onNav: () => {} })), (n) => n.type === "style")
  .map((n) => collectText(n))
  .join("\n");

// The app loads Tailwind preflight and utilities from its CDN; these are the rules the measured geometry depends on, at their shipped values.
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; font-family: ui-sans-serif, system-ui, sans-serif; }
  svg { display: block; vertical-align: middle; }
  table { border-collapse: collapse; }
  button, select { font: inherit; line-height: inherit; color: inherit; margin: 0; padding: 0; background-color: transparent; }
  .flex { display: flex; } .items-center { align-items: center; } .gap-1 { gap: 0.25rem; } .gap-2 { gap: 0.5rem; }
  .ml-auto { margin-left: auto; } .mr-2 { margin-right: 0.5rem; } .shrink-0 { flex-shrink: 0; } .min-w-0 { min-width: 0; }
  .max-w-full { max-width: 100%; } .whitespace-nowrap { white-space: nowrap; }
  .font-mono { font-family: ui-monospace, SFMono-Regular, monospace; } .font-semibold { font-weight: 600; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }`;

const noop = () => undefined;
const DAYS = 30;
const LIFECYCLE = getMarkup("LifecycleStatsCard", {
  state: { status: "ready", data: { rows: [{ agent: "glass-atrium-dev-front", start_count: 12, completed_count: 9 }] }, error: null },
  days: DAYS, onSelect: noop, onRetry: noop,
});
const MATRIX = getMarkup("SuccessRateMatrixCard", {
  state: { status: "ready", data: { rows: [], truncated: true }, error: null }, days: DAYS, onRetry: noop,
});

const SORT = getMarkup("SummarySortAg", { sortBy: "runs", onSortChange: noop, note: "" });
// a display name longer than the 160 agent cell → the link has to keep the cell's ellipsis
const LONG_AGENT = "glass-atrium-dev-front-with-a-display-name-past-the-agent-cell";
const PAIRS = getMarkup("TopNFailingAgentsTable", {
  pairs: ["glass-atrium-dev-react", LONG_AGENT].map((agent) => ({
    agent, task_type: "feature", successCount: 1, rateDenominator: 9, pooledRate: 0.11, totalCount: 9, lastFailureDate: "2026-10-28",
  })),
  failureByAgent: new Map(), days: DAYS,
});

const PAGE = `<!doctype html><html data-theme="dark"><head><style>${PREFLIGHT}</style></head><body style="margin: 0;">
  <div id="lifecycle" style="width: 560px; padding: 24px;">${LIFECYCLE}</div>
  <div id="matrix" style="width: 560px; padding: 24px;">${MATRIX}</div>
  <div id="sort" style="padding: 24px;">${SORT}</div>
  <div id="pairs" style="width: 640px; padding: 24px;">${PAIRS}</div>
</body></html>`;

let browser: Browser;
let page: Page;
let cdp: CDPSession;
const { readBox } = createControlProbe(() => page, () => cdp);

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.setContent(PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
  await page.addStyleTag({ content: SCREEN_CSS });
  cdp = await page.context().newCDPSession(page);
});

after(async () => {
  await browser?.close();
});

const centreOf = (box: Box) => box.top + box.height / 2;
const readText = (selector: string) => page.$eval(selector, (el) => el.textContent ?? "");

describe("a static pill in a card head stands on the head's 32 control height", () => {
  test("No completion record: the unfinished pill matches the info button's height and centre line", async () => {
    const pill = await readBox("#lifecycle .card-head .pill");
    const info = await readBox("#lifecycle .card-head .btn.icon");
    assert.match(await readText("#lifecycle .card-head .pill"), /3 unfinished/);
    assert.equal(info.height, 32);
    assert.equal(pill.height, info.height, `pill ${pill.height} vs info ${info.height}`);
    assert.ok(Math.abs(centreOf(pill) - centreOf(info)) < 0.5, "one centre line");
  });

  test("Success by agent: the row-limit pill is 32 and carries its own hover title", async () => {
    const selector = "#matrix .card-head .pill";
    assert.match(await readText(selector), /Row limit hit/);
    assert.equal((await readBox(selector)).height, 32);
    assert.match(await page.$eval(selector, (el) => el.getAttribute("title") ?? ""), /matrix incomplete/);
  });
});

describe("the ledger head's Sort label sits on the label-to-group step", () => {
  test("Sort: is 4 from its select and shares its centre line", async () => {
    const label = await readBox("#sort span:not([role])");
    const select = await readBox("#sort select");
    assert.match(await readText("#sort span:not([role])"), /^Sort:$/);
    assert.equal(select.left - label.right, 4);
    assert.ok(Math.abs(centreOf(label) - centreOf(select)) < 0.5, "one centre line");
  });
});

describe("a Most-failing pairs agent link is a 24 target in a 40 row", () => {
  const LINK = "#pairs tbody tr td:first-child a";

  test("every agent link is 24 tall and its row stays 40", async () => {
    const heights = await page.$$eval(LINK, (links) => links.map((a) => [a.getBoundingClientRect().height, a.closest("tr")!.getBoundingClientRect().height]));
    assert.equal(heights.length, 2);
    for (const [link, row] of heights) {
      assert.equal(link, 24);
      assert.equal(row, 40);
    }
  });

  test("a name past the cell still ends in an ellipsis inside the cell", async () => {
    const fit = await page.$$eval(LINK, (links) => {
      const a = links[1];
      const name = a.querySelector("span")!;
      return { linkRight: a.getBoundingClientRect().right, cellRight: a.closest("td")!.getBoundingClientRect().right, isClipped: name.scrollWidth > name.clientWidth, overflow: getComputedStyle(name).textOverflow };
    });
    assert.ok(fit.linkRight <= fit.cellRight, `link ends at ${fit.linkRight}, cell at ${fit.cellRight}`);
    assert.equal(fit.isClipped, true);
    assert.equal(fit.overflow, "ellipsis");
  });
});
