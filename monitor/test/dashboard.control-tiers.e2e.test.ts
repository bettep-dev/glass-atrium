// Dashboard controls on their DESIGN.md §7.15 tiers, measured in a real browser on the shipped tokens.css, base.css and the screen's
// own style block, rendered from the shipped components: a "Most failed or blocked" drill link is a 24 inline target that keeps its
// row's ellipsis (§7.16).
// Runner: npx tsx --test test/dashboard.control-tiers.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { createReactStub, collectText, findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

type Component = (props: unknown) => unknown;
const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const dashboardScreen = await loadScreenModule(resolve(HERE, "../public/src/screens/dashboard.jsx"), {
  UI: ui.UI,
  React: createReactStub(),
});
const getMarkup = (component: string, props: Record<string, unknown>): string =>
  getHtml(renderScreen((dashboardScreen[component] as Component)(props)) as RenderedNode);
const SCREEN_CSS = findNodes(
  renderScreen((dashboardScreen.ScreenDashboard as Component)({ onNav: () => {}, harness: null, onRetryHarness: () => {} })),
  (n) => n.type === "style",
)
  .map((n) => collectText(n))
  .join("\n");

// The app loads Tailwind preflight and utilities from its CDN; these are the rules the measured geometry depends on, at their shipped values.
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; font-family: ui-sans-serif, system-ui, sans-serif; }
  ul { list-style: none; margin: 0; padding: 0; } h3 { margin: 0; font-size: inherit; font-weight: inherit; }
  .flex { display: flex; } .flex-col { flex-direction: column; } .items-center { align-items: center; }
  .justify-between { justify-content: space-between; } .gap-1 { gap: 0.25rem; } .gap-2 { gap: 0.5rem; } .min-w-0 { min-width: 0; }
  .font-mono { font-family: ui-monospace, SFMono-Regular, monospace; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`;

// a name longer than the 240 panel → the drill has to keep its ellipsis
const LONG_AGENT = "glass-atrium-dev-front-with-a-name-longer-than-the-panel";
const AGENTS = getMarkup("BreakageAgents", {
  agents: ["glass-atrium-dev-react", "glass-atrium-qa-debugger", LONG_AGENT].map((agent, i) => ({ agent, count: 9 - i })),
});

const PAGE = `<!doctype html><html data-theme="dark"><head><style>${PREFLIGHT}</style></head><body style="margin: 0;">
  <div id="agents" style="width: 240px; padding: 24px;">${AGENTS}</div>
</body></html>`;

const DRILL = "#agents li > a";

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.setContent(PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
  await page.addStyleTag({ content: SCREEN_CSS });
});

after(async () => {
  await browser?.close();
});

describe("a Most failed or blocked drill is a 24 inline target", () => {
  test("every drill link is 24 tall", async () => {
    const heights = await page.$$eval(DRILL, (links) => links.map((a) => a.getBoundingClientRect().height));
    assert.deepEqual(heights, [24, 24, 24]);
  });

  test("a name past the panel still ends in an ellipsis inside its row", async () => {
    const fit = await page.$$eval(DRILL, (links) => {
      const a = links[2];
      const name = a.querySelector("span") ?? a;
      const style = getComputedStyle(name);
      return {
        linkRight: a.getBoundingClientRect().right, rowRight: a.closest("li")!.getBoundingClientRect().right,
        isClipped: name.scrollWidth > name.clientWidth, overflow: style.textOverflow,
      };
    });
    assert.ok(fit.linkRight <= fit.rowRight, `link ends at ${fit.linkRight}, row at ${fit.rowRight}`);
    assert.equal(fit.isClipped, true);
    assert.equal(fit.overflow, "ellipsis");
  });
});
