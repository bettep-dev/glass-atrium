// Display atoms measured in a real browser: the page header's line box and its gap to the content, the two empty states, a card's bars on one inline column per side, the current-page look, the stat row's hairlines, the badge chip and the drawer fact row.
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
// the three fills in their word and count shapes; 128 is a count past the 99 cap
const fills = renderToStaticMarkup(h("div", null,
  h(UI.Badge, { fill: "solid" }, "New"),
  h(UI.Badge, { fill: "tag" }, "Decision"),
  h(UI.Badge, { fill: "warn" }, "Not received"),
  h(UI.Badge, { fill: "solid", role: "count" }, 7),
  h(UI.Badge, { fill: "tag", role: "count" }, 128),
));
// a band inside a card body: the label row above a group of rows, its count a tag count badge
const band = renderToStaticMarkup(h("div", { className: "card", style: { width: 480 } },
  h("div", { className: "queue-band", id: "band" }, h("span", { id: "band-label" }, "Decisions"), h(UI.Badge, { fill: "tag", role: "count" }, 5)),
  h("div", { id: "band-row", style: { padding: "12px 16px" } }, "row")));
const fact = renderToStaticMarkup(h(UI.DetailField, { label: "File path", value: "hooks/track-outcome-with-a-very-long-name-that-has-to-wrap.sh", mono: true }));
const getHeader = (id: string, title: string) => renderToStaticMarkup(h("div", { id }, h(UI.PageHeader, {
  title,
  sub: "retired sub-line",
  back: h(UI.Link, { href: "#/agents" }, "Agents"),
  status: h(UI.Badge, { role: "status", tone: "warn" }, "Draft"),
  freshness: h("span", { className: "fs-meta" }, "read 2m ago"),
  refresh: h(UI.RefreshButton, { onRefresh: noop }),
  primary: h("button", { type: "button", className: "btn" }, "Save"),
}), h("p", { className: "head-next" }, "content")));
const empties = renderToStaticMarkup(h("div", null,
  h(UI.EmptyState, { message: "No runs yet", hint: "the wiki compiles nightly at 04:30" }),
  h(UI.EmptyState, { kind: "no-results", hint: "Widen the date range" }),
));
// the app's preflight sizes boxes border-box and zeroes heading margins → the fixture does too
const PAGE = `<!doctype html><html data-theme="light"><head><style>*, ::before, ::after { box-sizing: border-box; } h1, h2, p { margin: 0; }</style></head>
<body style="margin: 0;"><div style="padding: 24px;">${getHeader("head-wide", "Models & budgets")}</div><div style="padding: 24px; width: 420px;">${getHeader("head-narrow", "Models & budgets")}</div><div style="padding: 24px; width: 900px;">${card}</div><div style="padding: 24px; width: 900px;">${statRow}</div><div id="badges" style="padding: 24px;">${badges}</div><div id="fills" style="padding: 24px; background: rgb(var(--elev));">${fills}</div><div style="padding: 24px;">${band}</div><div id="drawer" style="padding: 24px; width: 360px;">${fact}</div><div id="empties" style="width: 600px;">${empties}</div><span id="sunken" style="background: rgb(var(--sunken)); color: rgb(var(--ink));"></span><span id="ink-on-surface" style="background: rgb(var(--ink)); color: rgb(var(--surface));"></span><span id="tints" style="background: var(--tint-fill); color: var(--tint-warn);"></span></body></html>`;

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

describe("the content below a page header", () => {
  for (const id of ["head-wide", "head-narrow"]) {
    test(`starts 16px under the header: ${id}`, async () => {
      await page.setViewportSize({ width: 1024, height: 900 });
      const head = await boxOf(`#${id} .page-head`);
      const next = await boxOf(`#${id} .head-next`);
      assert.equal(next.top - head.bottom, 16);
    });
  }
});

describe("an empty state", () => {
  test("first use and no results both read a 14 ink message over a 13 dim hint, left at the card inset, with no border or fill", async () => {
    const looks = await page.$$eval("#empties > div > *", (states) => states.map((state) => {
      const [message, hint] = [...state.children].map((el) => getComputedStyle(el));
      const box = getComputedStyle(state);
      return {
        message: { size: message.fontSize, color: message.color },
        hint: { size: hint.fontSize, color: hint.color },
        box: { align: box.textAlign, padding: box.paddingLeft, border: box.borderTopWidth, background: box.backgroundColor },
      };
    }));
    const tone = await page.evaluate(() => Object.fromEntries(["ink", "dim"].map((name) => {
      const probe = document.createElement("span");
      probe.style.color = `rgb(var(--${name}))`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return [name, color];
    })));

    assert.equal(looks.length, 2);
    for (const look of looks) assert.deepEqual(look, {
      message: { size: "14px", color: tone.ink },
      hint: { size: "13px", color: tone.dim },
      box: { align: "left", padding: `${CARD_PAD_PX}px`, border: "0px", background: "rgba(0, 0, 0, 0)" },
    });
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

describe("a filled badge", () => {
  const readFills = () => page.$$eval("#fills .pill", (els) => els.map((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return { text: el.textContent ?? "", height: box.height, width: box.width, size: style.fontSize, weight: style.fontWeight, border: style.borderTopWidth,
      radius: style.borderTopLeftRadius, background: style.backgroundColor, color: style.color, numeric: style.fontVariantNumeric, padding: style.paddingInlineStart };
  }));

  test("every fill, word or count, is a 20px chip in 13/600 with no edge", async () => {
    const looks = await readFills();
    assert.equal(looks.length, 5);
    for (const look of looks) assert.deepEqual([look.height, look.size, look.weight, look.border], [20, "13px", "600", "0px"], look.text);
  });

  test("solid is an ink shell with surface text; tag and warn are tinted shells with ink text", async () => {
    const [solid, tag, warn] = await readFills();
    const inverse = await page.$eval("#ink-on-surface", (el) => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
    const tints = await page.$eval("#tints", (el) => ({ fill: getComputedStyle(el).backgroundColor, warn: getComputedStyle(el).color }));
    const ink = await page.$eval("#sunken", (el) => getComputedStyle(el).color);
    assert.deepEqual([solid.background, solid.color], [inverse.background, inverse.color]);
    assert.deepEqual([tag.background, tag.color], [tints.fill, ink]);
    assert.deepEqual([warn.background, warn.color], [tints.warn, ink]);
  });

  test("the amber badge leads with the warn glyph, in the badge's own ink", async () => {
    const lead = await page.$eval("#fills .pill--warn", (el) => {
      const glyph = el.firstElementChild as HTMLElement;
      return { text: el.textContent, glyphColor: getComputedStyle(glyph).color, isHidden: glyph.getAttribute("aria-hidden"), color: getComputedStyle(el).color };
    });
    assert.equal(lead.text, "⚠ Not received");
    assert.deepEqual([lead.glyphColor, lead.isHidden], [lead.color, "true"]);
  });

  test("a count is a round chip at least 20 wide on 6px insets, tabular digits, capped at 99+", async () => {
    const [, , , small, large] = await readFills();
    for (const look of [small, large]) {
      assert.deepEqual([look.radius, look.padding, look.numeric], ["999px", "6px", "tabular-nums"], look.text);
      assert.ok(look.width >= 20, `${look.text} is ${look.width}px wide`);
    }
    assert.deepEqual([small.text, large.text], ["7", "99+"]);
  });
});

describe("a band", () => {
  test("is a 32px row on the page ground, hairlines above and below, its 13/600 dim label on the card's inset and the count 6px after it", async () => {
    const look = await page.$eval("#band", (el) => {
      const style = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, background: style.backgroundColor, top: `${style.borderTopWidth} ${style.borderTopColor}`,
        bottom: `${style.borderBottomWidth} ${style.borderBottomColor}`, type: [style.fontSize, style.fontWeight, style.color] };
    });
    const ground = await page.$eval("body", (el) => {
      const probe = el.appendChild(document.createElement("span"));
      probe.style.cssText = "background: rgb(var(--surface)); color: rgb(var(--dim)); border-color: rgb(var(--line));";
      const style = getComputedStyle(probe);
      return { surface: style.backgroundColor, dim: style.color, line: style.borderTopColor };
    });
    const [card, label, count] = await Promise.all([boxOf(".card:has(#band)"), boxOf("#band-label"), boxOf("#band .pill")]);
    assert.deepEqual(look, { height: 32, background: ground.surface, top: `1px ${ground.line}`, bottom: `1px ${ground.line}`, type: ["13px", "600", ground.dim] });
    assert.equal(label.left - card.left, CARD_PAD_PX + 1);
    assert.equal(count.left - label.right, 6);
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
