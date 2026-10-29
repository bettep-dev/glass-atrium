// DetailSurface geometry read in a real browser: a drawer opened from inside a KPI tile still covers the viewport and sits on top,
// and the KPI label row keeps its gap to the ⓘ that opens it.
// Runner: npx tsx --test test/ui.detail-surface.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

type Component = (props: Record<string, unknown>) => unknown;

const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const React = ui.React as { createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown; Fragment: unknown };
const h = React.createElement;

// the Tailwind preflight rules the measured boxes depend on
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; }
  svg { display: block; vertical-align: middle; }
  button { font: inherit; line-height: inherit; color: inherit; margin: 0; padding: 0; }`;

// host-element tree → HTML, so the browser lays out the shipped KPI and DetailSurface markup, not a hand copy of it
function toHtml(node: RenderedNode | string): string {
  if (typeof node === "string") return node.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  if (!/^[a-z]/.test(node.type)) return node.children.map(toHtml).join("");
  const attrs = Object.entries(node.props)
    .filter(([key, value]) => key !== "children" && key !== "ref" && value != null && value !== false && typeof value !== "function")
    .map(([key, value]) => {
      const name = key === "className" ? "class" : key.startsWith("stroke") ? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`) : key;
      const text =
        key === "style"
          ? Object.entries(value as Record<string, unknown>).map(([prop, v]) => `${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${String(v)}`).join("; ")
          : String(value);
      return ` ${name}="${text.replace(/"/g, "&quot;")}"`;
    })
    .join("");
  return `<${node.type}${attrs}>${node.children.map(toHtml).join("")}</${node.type}>`;
}

const render = (type: unknown, props: Record<string, unknown>, ...children: unknown[]): string =>
  toHtml(renderScreen(h(type, props, ...children)) as RenderedNode);

const pageOf = (body: string): string =>
  `<!doctype html><html data-theme="light"><head><style>${PREFLIGHT}</style></head><body style="margin: 0; padding: 24px;">${body}</body></html>`;

const VIEWPORT = { width: 1024, height: 700 };

let browser: Browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

async function openPage(body: string): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.setContent(pageOf(body));
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
  return page;
}

// an open CardInfo as a KPI tile's ⓘ: its trigger and the drawer it opens, rendered beside each other inside .kpi-info;
// the label is long enough to ellipsize, so the aside sits at the end of the row's reserve; a plain tile follows in the grid
const INFO_LABEL = "How cost is counted";
const KPI_GRID = `<div style="display: grid; grid-template-columns: repeat(2, 240px); gap: 16px;">
  ${render(ui.KPI, {
    id: "spend", label: "Cost across every model and every agent", aside: "(30 d)", value: "$412",
    info: h(React.Fragment, null,
      h(ui.CardInfo as Component, { label: INFO_LABEL }, "Sum of every priced call"),
      h(ui.DetailSurface as Component, { open: true, onClose: () => undefined, title: INFO_LABEL }, "Sum of every priced call")),
  })}
  ${render(ui.KPI, { id: "runs", label: "Runs", value: "1,284" })}
</div>`;

describe("a drawer opened from a KPI tile's ⓘ", () => {
  let page: Page;

  before(async () => {
    page = await openPage(KPI_GRID);
  });

  test("precondition: the drawer is rendered inside the tile's ⓘ slot", async () => {
    assert.equal(await page.locator(".kpi > .kpi-info .detail-overlay").count(), 1);
  });

  test("covers the whole viewport", async () => {
    const rect = await page.$eval(".kpi-info .detail-overlay", (el) => {
      const box = el.getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    });
    assert.deepEqual(rect, { left: 0, top: 0, ...VIEWPORT });
  });

  test("is the topmost layer at every viewport corner", async () => {
    const misses = await page.evaluate(({ width, height }) => {
      const overlay = document.querySelector(".kpi-info .detail-overlay");
      const corners = [[1, 1], [width - 2, 1], [1, height - 2], [width - 2, height - 2]];
      return corners
        .map(([x, y]) => ({ x, y, hit: document.elementFromPoint(x, y) }))
        .filter(({ hit }) => hit === null || !overlay?.contains(hit))
        .map(({ x, y, hit }) => `(${x},${y}) → ${hit ? hit.className || hit.tagName : "null"}`);
    }, VIEWPORT);
    assert.deepEqual(misses, []);
  });

  test("the ⓘ sits on the label row's centre line", async () => {
    const { row, info } = await page.$eval("#spend", (tile) => {
      const [head, button] = [tile.querySelector(".kpi-head"), tile.querySelector(".kpi-info > button")].map((el) => el!.getBoundingClientRect());
      return { row: (head.top + head.bottom) / 2, info: (button.top + button.bottom) / 2 };
    });
    assert.ok(Math.abs(row - info) < 0.5, `ⓘ centre ${info} vs label row centre ${row}`);
  });

  test("a truncated label row keeps the 4px meta gap before the ⓘ", async () => {
    const { isTruncated, gap } = await page.$eval("#spend", (tile) => {
      const label = tile.querySelector(".kpi-label-text") as HTMLElement;
      const aside = tile.querySelector(".kpi-aside")!.getBoundingClientRect();
      const button = tile.querySelector(".kpi-info > button")!.getBoundingClientRect();
      return { isTruncated: label.scrollWidth > label.clientWidth, gap: button.left - aside.right };
    });
    assert.ok(isTruncated, "the fixture label ellipsizes, so the aside ends at the row's reserve");
    assert.ok(Math.abs(gap - 4) < 0.5, `aside → ⓘ gap ${gap}`);
  });
});
