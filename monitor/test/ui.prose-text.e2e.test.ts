// Body text painted in a real browser: the shipped ProseText markup under tokens.css + base.css and the Tailwind preflight —
// 15 / 24 on the sheet and 14 / 22 compact, never wider than 66ch of its own size, list markers restored, blocks 12 and items
// 4 apart, an inline document link always underlined.
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

// the preflight rules prose rendering meets on the page: list markers and block margins removed, links inherit colour
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; }
  p, pre { margin: 0; }
  ol, ul { list-style: none; margin: 0; padding: 0; }
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

const PAGE = `<!doctype html><html data-theme="light"><head><style>${PREFLIGHT}</style></head><body style="margin: 0; padding: 24px; width: 1600px;">
  <div data-case="sheet">${getProseHtml(false)}</div>
  <div data-case="compact" style="margin-top: 24px;">${getProseHtml(true)}</div>
  <div data-probe="measure-15" style="width: 66ch; font-size: 15px;"></div>
  <div data-probe="measure-14" style="width: 66ch; font-size: 14px;"></div>
  <span data-probe="ink" style="color: rgb(var(--ink));">ink</span>
  <span data-probe="faint" style="color: rgb(var(--faint));">faint</span>
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
