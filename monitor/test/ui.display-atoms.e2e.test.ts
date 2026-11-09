// Display atoms measured in a real browser: the page header's line box, a card's bars on one inline column per side, the current-page look, the stat row's hairlines, the badge chip and the drawer fact row.
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
const statRow = renderToStaticMarkup(h(UI.StatRow, { stats: [
  { label: "Spend", value: "$41.20", context: "last 7 days" },
  { label: "Runs", value: "1,284", href: "#/runs" },
  { label: "Median run", value: "38", unit: "s" },
] }));
const badges = renderToStaticMarkup(h("div", null,
  h(UI.Badge, { role: "metadata" }, "html"),
  h(UI.Badge, { role: "count" }, "1,284"),
  h("button", { type: "button", className: "btn", id: "control" }, "Save"),
));
const fact = renderToStaticMarkup(h(UI.DetailField, { label: "File path", value: "hooks/track-outcome-with-a-very-long-name-that-has-to-wrap.sh", mono: true }));
const getHeader = (id: string, title: string) => renderToStaticMarkup(h("div", { id }, h(UI.PageHeader, {
  title,
  sub: "retired sub-line",
  back: h(UI.Link, { href: "#/agents" }, "Agents"),
  status: h(UI.Badge, { role: "status", tone: "warn" }, "Draft"),
  freshness: h("span", { className: "fs-meta" }, "read 2m ago"),
  refresh: h(UI.RefreshButton, { onRefresh: noop }),
  primary: h("button", { type: "button", className: "btn" }, "Save"),
})));
// the app's preflight sizes boxes border-box and zeroes heading margins → the fixture does too
const PAGE = `<!doctype html><html data-theme="light"><head><style>*, ::before, ::after { box-sizing: border-box; } h1, h2, p { margin: 0; }</style></head>
<body style="margin: 0;"><div style="padding: 24px;">${getHeader("head-wide", "Models & budgets")}</div><div style="padding: 24px; width: 420px;">${getHeader("head-narrow", "Models & budgets")}</div><div style="padding: 24px; width: 900px;">${card}</div><div style="padding: 24px; width: 900px;">${statRow}</div><div id="badges" style="padding: 24px;">${badges}</div><div id="drawer" style="padding: 24px; width: 360px;">${fact}</div><span id="sunken" style="background: rgb(var(--sunken)); color: rgb(var(--ink));"></span></body></html>`;

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

describe("the stat row", () => {
  const getStats = () => page.$$eval(".stat", (els) => els.map((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return { left: box.left, top: box.top, start: style.borderLeftWidth, above: style.borderTopWidth, background: style.backgroundColor, shadow: style.boxShadow };
  }));
  const rows = [
    { name: "1024px lays the stats on one line, a hairline before every stat but the first", width: 1024, edge: "start" as const },
    { name: "640px stacks them in one column, a hairline above every stat but the first", width: 640, edge: "above" as const },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      await page.setViewportSize({ width: row.width, height: 900 });
      const stats = await getStats();
      const axis = row.edge === "start" ? "top" : "left";

      assert.ok(stats.every((stat) => Math.abs(stat[axis] - stats[0][axis]) < 1), `${axis}s ${stats.map((stat) => stat[axis]).join(", ")}`);
      assert.deepEqual(stats.map((stat) => stat[row.edge]), ["0px", "1px", "1px"]);
      assert.ok(stats.every((stat) => stat.background === "rgba(0, 0, 0, 0)" && stat.shadow === "none"), "no stat draws a tile");
    });
  }
});

describe("the page header", () => {
  // no named helper inside the evaluated function — the test transform wraps named functions in a `__name` call the page lacks
  const getLine = async (id: string) => {
    const { boxes, controls, text } = await page.$eval(`#${id}`, (root) => {
      const head = root.querySelector(".page-head")!;
      const parts = [head, head.querySelector(".page-head-lead")!, head.querySelector("h1")!, head.querySelector(".page-head-cluster")!];
      const lead = [...parts[1].children];
      const right = [...head.querySelectorAll(".page-head-group > *, .page-head-cluster > .btn")];
      return {
        boxes: parts.map((el) => el.getBoundingClientRect().toJSON() as DOMRect),
        controls: [...lead, ...right].map((el) => el.getBoundingClientRect().toJSON() as DOMRect),
        text: head.textContent ?? "",
      };
    });
    const [head, lead, title, cluster] = boxes;
    return { head, lead, title, cluster, controls, text };
  };

  for (const width of [1440, 1024]) {
    test(`at ${width}px back link, h1, status and the right group share the title's one line box`, async () => {
      await page.setViewportSize({ width, height: 900 });
      const line = await getLine("head-wide");
      const center = line.title.top + line.title.height / 2;

      assert.ok(line.controls.length >= 5, `${line.controls.length} controls measured`);
      for (const box of line.controls) assert.ok(Math.abs(box.top + box.height / 2 - center) < 1, `a control centers ${box.top + box.height / 2 - center}px off the title line`);
      assert.ok(Math.abs(line.head.height - line.title.height) < 1, `header ${line.head.height}px for a ${line.title.height}px title line`);
      assert.doesNotMatch(line.text, /retired sub-line/, "nothing follows the h1 below it");
    });
  }

  test("a right group that cannot fit lands on a second line, right-aligned", async () => {
    await page.setViewportSize({ width: 1024, height: 900 });
    const line = await getLine("head-narrow");
    const ends = line.controls.slice(-1)[0];

    assert.ok(line.cluster.top >= line.lead.bottom - 1, `cluster top ${line.cluster.top} vs lead bottom ${line.lead.bottom}`);
    assert.ok(Math.abs(line.cluster.right - line.head.right) < 1 && Math.abs(ends.right - line.head.right) < 1, `cluster ends ${line.head.right - line.cluster.right}px, last control ${line.head.right - ends.right}px from the edge`);
  });
});

describe("a badge", () => {
  test("is a 20px sunken chip with a 4px corner and no edge, never as tall as a control", async () => {
    const looks = await page.$$eval("#badges .pill", (els) => els.map((el) => {
      const style = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, radius: style.borderTopLeftRadius, border: style.borderTopWidth, background: style.backgroundColor };
    }));
    const sunken = await page.$eval("#sunken", (el) => getComputedStyle(el).backgroundColor);
    const control = await boxOf("#control");

    assert.equal(looks.length, 2);
    for (const look of looks) assert.deepEqual(look, { height: 20, radius: "4px", border: "0px", background: sunken });
    assert.ok(control.height > looks[0].height, `control ${control.height}px vs badge ${looks[0].height}px`);
  });

  test("a count reads in the sans face with tabular digits", async () => {
    const face = await page.$eval(".pill--count", (el) => ({ family: getComputedStyle(el).fontFamily, numeric: getComputedStyle(el).fontVariantNumeric }));
    assert.ok(!/mono/i.test(face.family), face.family);
    assert.equal(face.numeric, "tabular-nums");
  });
});

describe("a drawer fact", () => {
  test("is one 32px row: dim 13/500 label left, long machine value wrapping on the right inside the drawer", async () => {
    await page.setViewportSize({ width: 1024, height: 900 });
    const row = await boxOf("#drawer .detail-fact");
    const label = await boxOf("#drawer dt");
    const value = await boxOf("#drawer dd");
    const labelLook = await page.$eval("#drawer dt", (el) => {
      const style = getComputedStyle(el);
      return { size: style.fontSize, weight: style.fontWeight, transform: style.textTransform, isMono: /mono/i.test(style.fontFamily), color: style.color };
    });
    const valueAlign = await page.$eval("#drawer dd", (el) => getComputedStyle(el).textAlign);
    const scrolls = await page.$eval("#drawer .detail-fact", (el) => el.scrollWidth > el.clientWidth);
    const dim = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "rgb(var(--dim))";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    const read = { row, label, value, valueAlign, scrolls };

    assert.deepEqual(labelLook, { size: "13px", weight: "500", transform: "none", isMono: false, color: dim });
    assert.ok(read.row.height >= 32, `row ${read.row.height}px`);
    assert.ok(read.label.left < read.value.left && Math.abs(read.value.right - read.row.right) < 1, "label left, value on the row's end");
    assert.equal(read.valueAlign, "right");
    assert.equal(read.scrolls, false, "the long value wraps instead of scrolling");
  });
});
