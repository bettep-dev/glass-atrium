// DetailSurface geometry read in a real browser: the overlay head is the 48 card-head with its title on the close button.
// Runner: npx tsx --test test/ui.detail-surface.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const React = ui.React as { createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown; Fragment: unknown };
const h = React.createElement;

// the Tailwind preflight rules the measured boxes depend on
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; }
  svg { display: block; vertical-align: middle; }
  button { font: inherit; line-height: inherit; color: inherit; margin: 0; padding: 0; }`;

const render = (type: unknown, props: Record<string, unknown>, ...children: unknown[]): string =>
  getHtml(renderScreen(h(type, props, ...children)) as RenderedNode);

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

// one drawer per head shape; each overlay is fixed over the viewport, so each head is read by its own wrapper
const HEADS = [
  { name: "a one-line title", id: "one-line", props: { title: "Session cost" } },
  { name: "a title with a sub-line", id: "with-sub", props: { title: "dev-react", sub: "Agent · last 30 days" } },
  { name: "a title that wraps", id: "wrapped",
    props: { title: "Review of the monitor control sizing plan, every route and every drawer, measured at both widths in both themes" } },
] as const;
const HEAD_PAGE = HEADS.map((head) =>
  `<div data-head="${head.id}">${render(ui.DetailSurface, { open: true, onClose: () => undefined, ...head.props }, "body")}</div>`).join("\n");

interface HeadReading { head: number; close: number; lines: Array<{ top: number; bottom: number }>; fontSize: number }

describe("the overlay head", () => {
  let page: Page;

  before(async () => {
    page = await openPage(HEAD_PAGE);
  });

  const readHead = (id: string): Promise<HeadReading> => page.$eval(`[data-head="${id}"]`, (wrap) => {
    const title = wrap.querySelector(".detail-title")!;
    const range = document.createRange();
    range.selectNodeContents(title);
    const close = wrap.querySelector(".detail-head > button")!.getBoundingClientRect();
    return {
      head: wrap.querySelector(".detail-head")!.getBoundingClientRect().height,
      close: (close.top + close.bottom) / 2,
      lines: [...range.getClientRects()].map((line) => ({ top: line.top, bottom: line.bottom })),
      fontSize: parseFloat(getComputedStyle(title).fontSize),
    };
  });

  test("a one-line head is the 48 card-head, its rule included", async () => {
    assert.equal((await readHead("one-line")).head, 48);
  });

  for (const head of HEADS) {
    test(`${head.name}: the title's first line centres on the close button within 1px`, async () => {
      const { close, lines } = await readHead(head.id);
      const first = (lines[0].top + lines[0].bottom) / 2;
      assert.ok(Math.abs(first - close) <= 1, `${head.id} title first-line centre ${first} vs close centre ${close}`);
    });
  }

  test("a wrapped title keeps its normal leading", async () => {
    const { lines, fontSize } = await readHead("wrapped");
    assert.ok(lines.length >= 2, "the fixture title wraps");
    const pitch = lines[1].top - lines[0].top;
    assert.ok(Math.abs(pitch - fontSize * 1.5) < 0.5, `line pitch ${pitch} at ${fontSize}px`);
  });
});
