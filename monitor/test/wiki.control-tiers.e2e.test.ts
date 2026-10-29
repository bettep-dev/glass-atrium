// Wiki folds on the DESIGN.md §7.15 disclosure tier, measured in a real browser on the shipped tokens.css, base.css and the screen's
// own style block, rendered from the shipped components: each fold's summary is a 32 row — chevron, heading and count on one centre
// line, the count at the row's far end — that keeps one box open, closed and in every pointer/keyboard state (§7.16).
// Runner: npx tsx --test test/wiki.control-tiers.e2e.test.ts — needs an installed chromium; no network, no app server.
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
const wikiScreen = await loadScreenModule(resolve(HERE, "../public/src/screens/wiki.jsx"), { UI: ui.UI, React: createReactStub() });
const getMarkup = (component: string, props: Record<string, unknown>): string =>
  getHtml(renderScreen((wikiScreen[component] as Component)(props)) as RenderedNode);
// the screen's style block carries the .fs-* type scale too (TypeScaleStyle renders inside it)
const SCREEN_CSS = findNodes(renderScreen((wikiScreen.ScreenWiki as Component)({})), (n) => n.type === "style")
  .map((n) => collectText(n))
  .join("\n");

// The app loads Tailwind preflight and utilities from its CDN; these are the rules the measured geometry depends on, at their shipped values.
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; font-family: ui-sans-serif, system-ui, sans-serif; }
  h2 { font-size: inherit; font-weight: inherit; margin: 0; }
  svg { display: block; vertical-align: middle; }
  button { font: inherit; line-height: inherit; color: inherit; margin: 0; padding: 0; background-color: transparent; }
  summary { display: list-item; }
  .flex { display: flex; } .flex-col { flex-direction: column; } .flex-wrap { flex-wrap: wrap; } .items-center { align-items: center; }
  .gap-2 { gap: 0.5rem; } .ml-auto { margin-left: auto; } .m-0 { margin: 0; } .min-w-0 { min-width: 0; }
  .px-3 { padding-left: 0.75rem; padding-right: 0.75rem; } .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; } .pb-3 { padding-bottom: 0.75rem; }
  .inline-block { display: inline-block; } .font-medium { font-weight: 500; } .leading-tight { line-height: 1.25; }
  .rounded-md { border-radius: 0.375rem; } .border { border-width: 1px; }`;

const noop = () => undefined;
const LOADING = { status: "loading", data: null, error: null, busy: true };
const READY_BACKLOG = {
  status: "ready",
  error: null,
  data: { backlog: { run_date: "2026-10-28", dedup_proposals: { proposals: [{ cluster_hash: "c1", notes: ["a", "b"] }] } } },
};
const RUN_TABLE = getMarkup("WikiRunTableSection", { reportState: LOADING, days: 30, onChangeDays: noop, onRetry: noop });
const MAINTENANCE = getMarkup("WikiMaintenanceSection", { backlogState: READY_BACKLOG, cyclesState: LOADING, onRetry: noop });

// the fold widths the audit measured: the 1440 content column (1170) and the 820 one
const FOLD_WIDTHS = [1170, 740] as const;
const PAGE = `<!doctype html><html data-theme="dark"><head><style>${PREFLIGHT}</style></head><body style="margin: 0;">
  ${FOLD_WIDTHS.map((w) => `<div id="runs-${w}" style="width: ${w}px; padding: 24px;">${RUN_TABLE}</div>`).join("")}
  <div id="merge" style="width: ${FOLD_WIDTHS[0]}px; padding: 24px;">${MAINTENANCE}</div>
</body></html>`;

const FOLDS = [...FOLD_WIDTHS.map((w) => ({ name: `Per-run table at ${w}`, id: `runs-${w}` })), { name: "Merge proposals", id: "merge" }];
const SUMMARY = (id: string) => `#${id} details > summary`;

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

async function setOpen(id: string, isOpen: boolean): Promise<void> {
  await page.$eval(`#${id} details`, (el, value) => { (el as HTMLDetailsElement).open = value; }, isOpen);
}

const PSEUDO_STATES = [["hover"], ["focus-visible"], ["active"]] as const;
const isSameBox = (a: Box, b: Box) => Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01;
const centreOf = (box: Box) => box.top + box.height / 2;
const QUARTER_TURN = /^matrix\(6\.1\d*e-17, 1, -1, 6\.1\d*e-17, 0, 0\)$|^matrix\(0, 1, -1, 0, 0, 0\)$/;

for (const fold of FOLDS) {
  describe(`the ${fold.name} fold opens from a 32 disclosure row`, () => {
    const summary = SUMMARY(fold.id);

    test("its summary is 32 tall, with no UA marker", async () => {
      assert.equal((await readBox(summary)).height, 32);
      assert.notEqual(await readStyle(summary, "display"), "list-item", "no UA marker");
    });

    test("chevron, heading and count share one centre line, the count at the row's far end", async () => {
      const row = await readBox(summary);
      const items = await Promise.all([".disclosure-chevron", "h2", "h2 + span"].map((s) => readBox(`${summary} > ${s}`)));
      for (const item of items) assert.ok(Math.abs(centreOf(item) - centreOf(row)) < 0.5, `item centre ${centreOf(item)} vs row ${centreOf(row)}`);
      // the fold's inner edge, not the summary's own: a shrink-wrapped summary would end its count at its own edge
      const foldEnd = await page.$eval(`#${fold.id} details`, (el) => el.getBoundingClientRect().left + el.clientLeft + el.clientWidth);
      const inlineEnd = foldEnd - parseFloat(await readStyle(summary, "padding-right"));
      assert.ok(Math.abs(items[2].right - inlineEnd) < 0.5, `count ends ${items[2].right} vs fold content end ${inlineEnd}`);
    });

    test("the shared chevron turns a quarter once open, and the row keeps its box", async () => {
      const chevron = `${summary} > .disclosure-chevron`;
      // a warn-toned fold renders open (Merge proposals here) → read the closed state first, then restore the rendered one
      const wasOpen = await page.$eval(`#${fold.id} details`, (el) => (el as HTMLDetailsElement).open);
      try {
        await setOpen(fold.id, false);
        const closed = await readBox(summary);
        assert.equal(await readStyle(chevron, "transform"), "none");
        await setOpen(fold.id, true);
        const open = await readBox(summary);
        assert.ok(isSameBox(open, closed), `open ${open.width}x${open.height} vs closed ${closed.width}x${closed.height}`);
        assert.match(await readStyle(chevron, "transform"), QUARTER_TURN);
      } finally {
        await setOpen(fold.id, wasOpen);
      }
    });

    test("hover, focus-visible and active keep its box", async () => {
      const rest = await readBox(summary);
      for (const state of PSEUDO_STATES) {
        await forcePseudo(summary, state);
        try {
          const changed = await readBox(summary);
          assert.ok(isSameBox(changed, rest), `${state[0]} ${changed.width}x${changed.height} vs resting ${rest.width}x${rest.height}`);
        } finally {
          await forcePseudo(summary, []);
        }
      }
    });
  });
}
