// Body text painted in a real browser: the shipped ProseText markup under tokens.css + base.css and the Tailwind preflight —
// 15 / 24 on the sheet and 14 / 22 compact, never wider than 66ch of its own size, list markers restored (disc, circle, square
// by level), blocks 12 and items 4 apart, an inline document link always underlined, a table's frame scrolling inside the
// sheet's width while the sheet never does, a folded fence's disclosure right under its 20 lines, and the heading, quote,
// rule and fence faces.
// Runner: npx tsx --test test/ui.prose-text.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");
const UI_SRC = resolve(HERE, "..", "public", "src", "ui.jsx");

// the preflight rules prose rendering meets on the page: markers, heading faces and block margins removed, links inherit colour
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; }
  h4, h5 { font-size: inherit; font-weight: inherit; }
  blockquote, h4, h5, hr, p, pre { margin: 0; }
  hr { height: 0; color: inherit; border-top-width: 1px; }
  ol, ul { list-style: none; margin: 0; padding: 0; }
  table { text-indent: 0; border-color: inherit; border-collapse: collapse; }
  summary { display: list-item; }
  a { color: inherit; text-decoration: inherit; }
  code, pre { font-size: 1em; }
  strong { font-weight: bolder; }`;

const TEXT = [
  "큐 페이지 점검 결과를 보고합니다. 남은 일은 큐 실사용 확인과 모니터 문서 정리이며, 각 세션이 이어받을 순서를 아래에 적었습니다. 이 문단은 측정 폭보다 길어야 합니다.",
  "둘째 줄",
  "",
  "- 하나",
  "- 둘",
  "  - 셋",
  "",
  "1. 첫째",
  "",
  "`npm test` 와 **모니터 44060** 문서",
  "",
  "```",
  "const a = 1;",
  "```",
].join("\n");

const ui = await loadScreenModule(UI_SRC);
const UI = ui.UI as Record<string, unknown>;
const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };

function getProseHtml(isCompact: boolean): string {
  const node = React.createElement(UI.ProseText as (props: unknown) => unknown, { text: TEXT, linkedDocIds: [44060], isCompact });
  return getHtml(renderScreen(node) as RenderedNode);
}

// an HTML parser reads `</br>` as a second line break → the void elements are written open-only
const renderProse = (props: Record<string, unknown>): string =>
  getHtml(renderScreen(React.createElement(UI.ProseText as (props: unknown) => unknown, props)) as RenderedNode).replace(/<(br|hr)><\/\1>/g, "<$1>");

const WIDE_WORD = "configuration-key-with-a-long-name";
const WIDE_TABLE = `| a | b | c | d |\n|---|---|---|--:|\n${`| ${Array(4).fill(WIDE_WORD).join(" | ")} |`}`;
const NARROW_TABLE = "| Agent | Runs |\n|---|--:|\n| dev-react | 12 |";
const LISTS = "- one\n  - two\n    - three\n\n1. one\n   1. two\n      1. three";
const FENCE_LINES = 84;
const FENCE = `\`\`\`\n${Array.from({ length: FENCE_LINES }, (_, index) => `line ${index + 1}`).join("\n")}\n\`\`\``;
const BLOCKS = "## Title\n본문 첫 줄\n### Step\n> quoted\n---\n```\nconst a = 1;\n```";

// the sheet's column at the owner's window and at 1280 (spec §5: 590 · 388); the bubble's own width
const SHEET_PX = 590;
const NARROW_PX = 388;
const BUBBLE_PX = 300;

const PAGE = `<!doctype html><html><head><style>${PREFLIGHT}</style></head><body style="margin: 0; padding: 24px; width: 1600px;">
  <div data-case="sheet">${getProseHtml(false)}</div>
  <div data-case="compact" style="margin-top: 24px;">${getProseHtml(true)}</div>
  <div data-probe="measure-15" style="width: 66ch; font-size: 15px;"></div>
  <div data-probe="measure-14" style="width: 66ch; font-size: 14px;"></div>
  <span data-probe="ink" style="color: rgb(var(--ink));">ink</span>
  <span data-probe="faint" style="color: rgb(var(--faint));">faint</span>
  <div id="table-fits" style="width: ${SHEET_PX}px;">${renderProse({ text: NARROW_TABLE })}</div>
  <div id="table-narrow" style="width: ${NARROW_PX}px;">${renderProse({ text: WIDE_TABLE })}</div>
  <div id="table-bubble" class="queue-bubble" style="width: ${BUBBLE_PX}px;">${renderProse({ text: `### Step\n${WIDE_TABLE}`, isCompact: true })}</div>
  <div id="lists" style="width: ${SHEET_PX}px;">${renderProse({ text: LISTS })}</div>
  <div id="fold" style="width: ${SHEET_PX}px;">${renderProse({ text: FENCE, canFoldCode: true })}</div>
  <div id="blocks" style="width: ${SHEET_PX}px;">${renderProse({ text: BLOCKS })}</div>
</body></html>`;

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1680, height: 900 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setContent(PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
});

after(async () => {
  await browser?.close();
});

const readStyle = (selector: string, prop: string, pseudo: string | null = null): Promise<string> =>
  page.$eval(selector, (el, [name, at]) => getComputedStyle(el, at).getPropertyValue(name), [prop, pseudo] as const);

interface Rect {
  top: number;
  bottom: number;
  width: number;
}
const readRect = (selector: string): Promise<Rect> =>
  page.$eval(selector, (el) => {
    const { top, bottom, width } = el.getBoundingClientRect();
    return { top, bottom, width };
  });

describe("computed type and decoration", () => {
  const SHEET = '[data-case="sheet"]';
  const rows = [
    { name: "sheet text is 15 px", selector: `${SHEET} .prose-text`, prop: "font-size", expected: "15px" },
    { name: "sheet text sits on a 24 px line", selector: `${SHEET} .prose-text`, prop: "line-height", expected: "24px" },
    { name: "sheet text is regular weight", selector: `${SHEET} .prose-text`, prop: "font-weight", expected: "400" },
    { name: "compact text is 14 px", selector: '[data-case="compact"] .prose-text', prop: "font-size", expected: "14px" },
    { name: "compact text sits on a 22 px line", selector: '[data-case="compact"] .prose-text', prop: "line-height", expected: "22px" },
    { name: "Korean lines break at spaces, never inside a word", selector: `${SHEET} .prose-text`, prop: "word-break", expected: "keep-all" },
    { name: "a long path or hash still wraps", selector: `${SHEET} .prose-text`, prop: "overflow-wrap", expected: "anywhere" },
    { name: "bullets come back as discs under the preflight", selector: `${SHEET} ul`, prop: "list-style-type", expected: "disc" },
    { name: "numbers come back as decimals under the preflight", selector: `${SHEET} ol`, prop: "list-style-type", expected: "decimal" },
    { name: "a list is indented 16 px", selector: `${SHEET} ul`, prop: "padding-inline-start", expected: "16px" },
    { name: "a code span is 13 px", selector: `${SHEET} p code`, prop: "font-size", expected: "13px" },
    { name: "a fenced block is 13 px", selector: `${SHEET} pre`, prop: "font-size", expected: "13px" },
    { name: "a fenced block sits on a 1.5 line", selector: `${SHEET} pre`, prop: "line-height", expected: "19.5px" },
    { name: "a fenced block wraps its long lines", selector: `${SHEET} pre`, prop: "white-space", expected: "pre-wrap" },
    { name: "a fenced block has no fill", selector: `${SHEET} pre`, prop: "background-color", expected: "rgba(0, 0, 0, 0)" },
    { name: "a fenced block has no border", selector: `${SHEET} pre`, prop: "border-top-width", expected: "0px" },
    { name: "a bold run is 600", selector: `${SHEET} strong`, prop: "font-weight", expected: "600" },
    { name: "a document link is underlined at rest", selector: `${SHEET} a.prose-link`, prop: "text-decoration-line", expected: "underline" },
    { name: "a document link's underline is 1 px at rest", selector: `${SHEET} a.prose-link`, prop: "text-decoration-thickness", expected: "1px" },
    { name: "a document link's underline sits 0.2em under the text", selector: `${SHEET} a.prose-link`, prop: "text-underline-offset", expected: "3px" },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      assert.equal(await readStyle(row.selector, row.prop), row.expected);
    });
  }
});

test("the code spans and fenced blocks are set in the mono family", async () => {
  for (const selector of ['[data-case="sheet"] p code', '[data-case="sheet"] pre']) {
    assert.match(await readStyle(selector, "font-family"), /JetBrains Mono/, selector);
  }
});

test("the text never runs wider than 66 characters of its own size, even with room to spare", async () => {
  for (const [scope, size] of [["sheet", 15], ["compact", 14]] as const) {
    const prose = await readRect(`[data-case="${scope}"] .prose-text`);
    const measure = await readRect(`[data-probe="measure-${size}"]`);
    assert.ok(Math.abs(prose.width - measure.width) <= 1, `${scope}: prose ${prose.width} vs 66ch of ${size}px ${measure.width}`);
  }
});

test("blocks sit 12 px apart and list items 4 px apart, a nested list included", async () => {
  const first = await readRect('[data-case="sheet"] .prose-text > p:first-child');
  const list = await readRect('[data-case="sheet"] .prose-text > ul');
  const items = await page.$$eval('[data-case="sheet"] .prose-text > ul > li', (els) => els.map((el) => {
    const { top, bottom } = el.getBoundingClientRect();
    return { top, bottom };
  }));
  const nested = await readRect('[data-case="sheet"] .prose-text > ul > li ul');
  const lineBox = 24;
  assert.equal(Math.round(list.top - first.bottom), 12, "paragraph → list");
  assert.equal(Math.round(items[1].top - items[0].bottom), 4, "item → item");
  assert.equal(Math.round(nested.top - (items[1].top + lineBox)), 4, "item's line → its nested list");
});

test("list markers paint in the faint ink, the text in ink", async () => {
  assert.equal(await readStyle('[data-case="sheet"] li', "color", "::marker"), await readStyle('[data-probe="faint"]', "color"));
  assert.equal(await readStyle('[data-case="sheet"] .prose-text', "color"), await readStyle('[data-probe="ink"]', "color"));
});

test("hovering a document link thickens its underline to 2 px", async () => {
  await page.hover('[data-case="sheet"] a.prose-link');
  assert.equal(await readStyle('[data-case="sheet"] a.prose-link', "text-decoration-thickness"), "2px");
});

interface FrameReading { frame: number; frameScroll: number; host: number; hostScroll: number; overflowX: string }

async function readFrame(host: string): Promise<FrameReading> {
  return page.$eval(host, (element) => {
    const frame = element.querySelector(".prose-table-frame") as HTMLElement;
    return { frame: frame.clientWidth, frameScroll: frame.scrollWidth, host: element.clientWidth, hostScroll: element.scrollWidth, overflowX: getComputedStyle(frame).overflowX };
  });
}

describe("a table's frame", () => {
  const rows = [
    { name: "a table wider than a 388 sheet scrolls inside its frame and the sheet never scrolls", host: "#table-narrow", width: NARROW_PX },
    { name: "a table wider than a bubble scrolls inside the bubble's width", host: "#table-bubble", width: BUBBLE_PX },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const reading = await readFrame(row.host);
      assert.equal(reading.overflowX, "auto");
      assert.ok(reading.frameScroll > reading.frame, JSON.stringify(reading));
      assert.ok(reading.frame <= row.width, JSON.stringify(reading));
      assert.ok(reading.hostScroll <= reading.host, JSON.stringify(reading));
    });
  }

  test("a table that fits does not scroll, and its first and last columns stand on the text's own edges", async () => {
    const reading = await readFrame("#table-fits");
    const edges = await page.$eval("#table-fits", (element) => {
      const text = element.querySelector(".prose-text")!.getBoundingClientRect();
      const cells = [...element.querySelectorAll("tbody td")];
      // a named helper here would carry the bundler's name shim into the page, which lacks it → inline
      const range = document.createRange();
      range.selectNodeContents(cells[0]);
      return { start: Math.round(range.getBoundingClientRect().left - text.left), paddingStart: getComputedStyle(cells[0]).paddingInlineStart, paddingEnd: getComputedStyle(cells.at(-1)!).paddingInlineEnd };
    });
    assert.equal(reading.frameScroll, reading.frame);
    assert.deepEqual(edges, { start: 0, paddingStart: "0px", paddingEnd: "0px" });
  });

  test("the frame is a Tab stop that draws the global focus outline", async () => {
    // the document links of the earlier cases are the only Tab stops ahead of the first frame
    const stopsBefore = await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      const frame = document.querySelector(".prose-table-frame")!;
      return [...document.querySelectorAll("a[href]")].filter((link) => link.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).length;
    });
    for (let stop = 0; stop <= stopsBefore; stop += 1) await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement;
      return { isFrame: active.classList.contains("prose-table-frame"), label: active.getAttribute("aria-label"), outline: getComputedStyle(active).outlineStyle };
    });
    assert.deepEqual(focused, { isFrame: true, label: "Table, scrolls sideways", outline: "solid" });
  });
});

describe("table cell faces", () => {
  const rows = [
    { name: "a header cell on the sheet is 14 / 600 ink, never the 13 / dim label face", selector: "#table-narrow th", size: "14px", weight: "600" },
    { name: "a body cell on the sheet is 14 / 400 ink on a 20 line", selector: "#table-narrow td", size: "14px", weight: "400", lineHeight: "20px" },
    { name: "a header cell in a bubble is 13 / 600 ink", selector: "#table-bubble th", size: "13px", weight: "600" },
    { name: "a body cell in a bubble is 13 / 400 ink", selector: "#table-bubble td", size: "13px", weight: "400" },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const face = await page.$eval(row.selector, (cell) => {
        const style = getComputedStyle(cell);
        const ink = getComputedStyle(document.querySelector(".prose-text")!).color;
        return { size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight, isInk: style.color === ink };
      });
      assert.deepEqual(face, { size: row.size, weight: row.weight, lineHeight: row.lineHeight ?? face.lineHeight, isInk: true });
    });
  }

  test("a column aligned to the end by its delimiter ends its text on the cell's end edge", async () => {
    const align = await page.$eval("#table-fits", (element) => [...element.querySelectorAll("th, td")].map((cell) => getComputedStyle(cell).textAlign));
    assert.deepEqual(align, ["start", "end", "start", "end"]);
  });
});

describe("list markers by level", () => {
  test("an unordered list marks its levels disc, circle, square and a numbered list stays decimal at every level", async () => {
    const markers = await page.$eval("#lists", (element) => [...element.querySelectorAll("ul, ol")].map((list) => `${list.tagName} ${getComputedStyle(list).listStyleType}`));
    assert.deepEqual(markers, ["UL disc", "UL circle", "UL square", "OL decimal", "OL decimal", "OL decimal"]);
  });
});

describe("the fence fold line", () => {
  test("a folded fence shows exactly its first 20 lines and the disclosure starts right under them", async () => {
    const fold = await page.$eval("#fold", (element) => {
      const pre = element.querySelector("pre")!;
      const summary = element.querySelector("summary")!;
      return {
        lines: pre.clientHeight / Number.parseFloat(getComputedStyle(pre).lineHeight),
        gap: summary.getBoundingClientRect().top - pre.getBoundingClientRect().bottom,
        label: summary.textContent?.trim(),
      };
    });
    assert.equal(Math.round(fold.lines), 20);
    assert.equal(Math.round(fold.gap), 0);
    assert.equal(fold.label, `Show all ${FENCE_LINES} lines`);
  });
});

describe("block faces", () => {
  const rows = [
    { name: "a level-4 heading is 16 / 600 with no space above when it opens the text", selector: "#blocks h4", face: { size: "16px", weight: "600", marginTop: "0px", marginBottom: "8px" } },
    { name: "a level-5 heading is 15 / 600 with 16 above and 4 below", selector: "#blocks h5", face: { size: "15px", weight: "600", marginTop: "16px", marginBottom: "4px" } },
    { name: "a quote is dim, set in 16, with no stripe", selector: "#blocks blockquote", face: { isDim: true, paddingStart: "16px", borderStart: "0px" } },
    { name: "a rule is one 1 px line with 16 above and below", selector: "#blocks hr", face: { borderTop: "1px", marginTop: "16px", marginBottom: "16px" } },
    { name: "a fence is set in 16 like a list item, with no fill", selector: "#blocks pre", face: { paddingStart: "16px", fill: "rgba(0, 0, 0, 0)" } },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const read = await page.$eval(row.selector, (element) => {
        const style = getComputedStyle(element);
        const dim = getComputedStyle(document.documentElement).getPropertyValue("--dim").trim().split(/\s+/).join(", ");
        return {
          size: style.fontSize, weight: style.fontWeight, marginTop: style.marginTop, marginBottom: style.marginBottom,
          isDim: style.color === `rgb(${dim})`, paddingStart: style.paddingInlineStart, borderStart: style.borderInlineStartWidth,
          borderTop: style.borderTopWidth, fill: style.backgroundColor,
        };
      });
      const picked = Object.fromEntries(Object.keys(row.face).map((key) => [key, read[key as keyof typeof read]]));
      assert.deepEqual(picked, row.face);
    });
  }
});
