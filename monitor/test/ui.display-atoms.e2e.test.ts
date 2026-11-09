// Display atoms measured in a real browser: a card's bars on one inline column per side and the current-page look.
// Runner: npx tsx --test test/ui.display-atoms.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { loadScreenModule } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// react-dom ships no types and @types/react-dom is not installed → the one call used here, typed by hand
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as { renderToStaticMarkup: (element: React.ReactElement) => string };
const STYLES = resolve(HERE, "..", "public", "styles");

const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"), { React });
const UI = ui.UI as Record<string, React.FC<Record<string, unknown>>>;
const h = React.createElement;
const noop = () => {};

const CARD_PAD_PX = 16;
const card = renderToStaticMarkup(h(UI.Card, {
  title: "Runs",
  right: h(UI.QuietButton, { id: "head-end" }, "Export"),
  bar: h(UI.FilterBar, { label: "Run filters", isApplied: true, onReset: noop }, h(UI.BarSearch, { label: "Search runs", value: "", onChange: noop })),
  foot: h(UI.Pagination, { page: 1, pageSize: 20, total: 1284, onPageChange: noop }),
}, h("div", { id: "body-text" }, "rows")));
// the app's preflight sizes boxes border-box and zeroes heading margins → the fixture does too
const PAGE = `<!doctype html><html data-theme="light"><head><style>*, ::before, ::after { box-sizing: border-box; } h2, p { margin: 0; }</style></head>
<body style="margin: 0;"><div style="padding: 24px; width: 900px;">${card}</div><span id="sunken" style="background: rgb(var(--sunken)); color: rgb(var(--ink));"></span></body></html>`;

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
});

after(async () => {
  await browser?.close();
});

const boxOf = (selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);

describe("a card's head, bar and foot share one inline column per side", () => {
  for (const width of [1440, 1024]) {
    test(`at ${width}px the first and last control of each bar sit on the card's inset`, async () => {
      await page.setViewportSize({ width, height: 900 });
      const frame = await boxOf(".card");
      const start = frame.left + 1 + CARD_PAD_PX;
      const end = frame.right - 1 - CARD_PAD_PX;
      const starts = { title: await boxOf(".card-title"), search: await boxOf(".bar-search"), range: await boxOf(".pagination-range"), body: await boxOf("#body-text") };
      const ends = { head: await boxOf("#head-end"), reset: await boxOf(".filter-bar-reset"), next: await boxOf('[aria-label="Next page"]') };

      for (const [name, box] of Object.entries(starts)) assert.ok(Math.abs(box.left - start) < 1, `${name} starts at ${box.left - frame.left}px`);
      for (const [name, box] of Object.entries(ends)) assert.ok(Math.abs(box.right - end) < 1, `${name} ends ${frame.right - box.right}px from the edge`);
    });
  }
});

describe("the current page", () => {
  test("is a sunken square at the control height, ink at 500, with no border", async () => {
    const look = await page.$eval(".pagination-current", (el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return { background: style.backgroundColor, color: style.color, weight: style.fontWeight, border: style.borderTopWidth, height: box.height, isSquare: box.width >= box.height };
    });
    const expected = await page.$eval("#sunken", (el) => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
    const next = await boxOf('[aria-label="Next page"]');

    assert.deepEqual({ background: look.background, color: look.color, weight: look.weight, border: look.border }, { ...expected, weight: "500", border: "0px" });
    assert.ok(look.isSquare && Math.abs(look.height - next.height) < 1, `current ${look.height}px vs Next ${next.height}px`);
  });
});
