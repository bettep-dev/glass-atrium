// Side-by-side layout atoms measured in a real browser: split rows pair up only from xl, tile splits pair up only below it.
// Runner: npx tsx --test test/ui.card-layout.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { loadScreenModule } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const ratios = (ui.UI as Record<string, unknown>).SPLIT_ROW_RATIOS as Record<string, string>;
const layouts = (ui.UI as Record<string, unknown>).SPLIT_ROW_LAYOUTS as Record<string, string>;

// sub-pixel rounding of fr tracks
const RATIO_TOLERANCE = 0.02;

const splitRows = Object.entries(ratios).map(([ratio, modifier]) =>
  `<div class="split-row split-row--${modifier}" data-ratio="${ratio}"><div>a</div><div>b</div></div>`).join("");
// rail sticks at this offset from the viewport top at xl
const RAIL_TOP_PX = 24;
const CARD = { GAP_PX: 16, HEAD_H_PX: 48, PAD_PX: 16 } as const;
const variantRows = `
  <div class="split-row split-row--1-1 split-row--${layouts.content}" data-variant="content"><div style="height: 400px;">tall</div><div>short</div></div>
  <div class="split-row split-row--1-1 split-row--${layouts.equal}" data-variant="equal"><div style="height: 400px;">tall</div><div>short</div></div>
  <div class="split-row split-row--2-1 split-row--${layouts.content}" data-variant="rail"><div style="height: 2000px;">main</div>
    <div class="split-col split-col--rail" id="rail"><div style="height: 100px;">one</div><div style="height: 100px;">two</div></div></div>`;
const LAYOUT_PAGE = `<!doctype html><html data-theme="light"><body style="margin: 0;">
  <div style="padding: 24px;">${splitRows}
    <div class="tile-split" id="tile"><div class="tile-split-lead">42</div><div class="tile-split-detail">detail text</div></div>
    ${variantRows}
  </div>
</body></html>`;

const viewportRows = [
  { name: "below 641px both atoms stack", width: 600, isRowSplit: false, isTileSplit: false },
  { name: "between 641px and xl only the tile splits", width: 1024, isRowSplit: false, isTileSplit: true },
  { name: "from xl only the split rows pair up", width: 1440, isRowSplit: true, isTileSplit: false },
] as const;

interface PairReading { key: string; isSideBySide: boolean; widthRatio: number }

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(LAYOUT_PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
});

after(async () => {
  await browser?.close();
});

// side by side = second child starts level with the first and to its right
async function readPairs(): Promise<PairReading[]> {
  return page.evaluate(() => {
    const pairs = [...document.querySelectorAll<HTMLElement>(".split-row[data-ratio], .tile-split")];
    return pairs.map((pair) => {
      const [first, second] = [...pair.children].map((child) => child.getBoundingClientRect());
      return {
        key: pair.dataset.ratio ?? pair.id,
        isSideBySide: Math.abs(first.top - second.top) < 1 && second.left >= first.right,
        widthRatio: first.width / second.width,
      };
    });
  });
}

describe("split row and tile split at real viewports", () => {
  for (const row of viewportRows) {
    test(row.name, async () => {
      await page.setViewportSize({ width: row.width, height: 900 });
      const readings = await readPairs();

      for (const reading of readings) {
        const isExpectedSplit = reading.key === "tile" ? row.isTileSplit : row.isRowSplit;
        assert.equal(reading.isSideBySide, isExpectedSplit, `${reading.key} at ${row.width}px`);
      }
    });
  }

  test("from xl each split row divides its width at its preset ratio", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const rows = (await readPairs()).filter((reading) => reading.key !== "tile");

    assert.equal(rows.length, Object.keys(ratios).length);
    for (const reading of rows) {
      const [left, right] = reading.key.split(":").map(Number);
      assert.ok(Math.abs(reading.widthRatio - left / right) < RATIO_TOLERANCE, `${reading.key} width ratio ${reading.widthRatio}`);
    }
  });
});

interface VariantReading { variant: string; first: DOMRect; second: DOMRect }

async function readVariants(): Promise<VariantReading[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".split-row[data-variant]")].map((row) => {
    const [first, second] = [...row.children].map((child) => child.getBoundingClientRect().toJSON() as DOMRect);
    return { variant: row.dataset.variant ?? "", first, second };
  }));
}

const variantOf = (readings: VariantReading[], name: string) => {
  const reading = readings.find((r) => r.variant === name);
  assert.ok(reading, `fixture row ${name}`);
  return reading;
};

describe("split row layout variants at real viewports", () => {
  test("from xl a content-sized row leaves the short card at its own height", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { first, second } = variantOf(await readVariants(), "content");
    assert.ok(second.height < first.height / 2, `short ${second.height} vs tall ${first.height}`);
  });

  test("from xl an equal-height row matches its peer cards", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { first, second } = variantOf(await readVariants(), "equal");
    assert.ok(Math.abs(first.height - second.height) < 1, `${first.height} vs ${second.height}`);
  });

  test("a column stack keeps its cards in one column a card gap apart", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const [one, two] = await page.$$eval("#rail > *", (cards) => cards.map((card) => card.getBoundingClientRect().toJSON() as DOMRect));
    assert.equal(one.left, two.left);
    assert.ok(Math.abs(two.top - one.bottom - CARD.GAP_PX) < 1, `gap ${two.top - one.bottom}`);
  });

  test("from xl the rail column stays pinned while its row scrolls", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const railTop = await page.$eval("#rail", (rail) => {
      window.scrollTo(0, rail.getBoundingClientRect().top + window.scrollY + 600);
      return rail.getBoundingClientRect().top;
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.ok(Math.abs(railTop - RAIL_TOP_PX) < 1, `rail top ${railTop}`);
  });

  test("below xl every variant row stacks its columns", async () => {
    await page.setViewportSize({ width: 1024, height: 900 });
    for (const { variant, first, second } of await readVariants()) {
      assert.ok(second.top >= first.bottom, `${variant} at 1024px`);
    }
  });
});

const LONG_TEXT = "a merge proposal whose wording runs far past the width of the column it sits in, so it has to clamp";
const tallBody = (px: number) => `<div style="height: ${px}px;">rows</div>`;
const anatomyCard = (body: string, foot = "") =>
  `<div class="card"><div class="card-head"><div class="card-head-text"><h2 class="card-title">Runs</h2></div></div><div class="card-body">${body}</div>${foot}</div>`;
// the main column at a 1280px viewport: 1280 − 220 sidebar − 2 × 24 padding
const MAIN_COLUMN_PX = 1012;
// design.md caps header meta at 32 characters
const CAPPED_META = "last 30 days · 1,284 runs · $310";
// CardHead's right side: the ⓘ trigger, then a segmented control
const controlledHead = (sub: string) => `<div class="card-head">
  <div class="card-head-text"><h2 class="card-title">Cost by model</h2>${sub && `<span class="card-sub">${sub}</span>`}</div>
  <div style="margin-left: auto; display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
    <button class="btn ghost sm icon" aria-label="How this is counted"><svg width="16" height="16" aria-hidden="true"></svg></button>
    <div class="seg"><button aria-pressed="true">7d</button><button>30d</button><button>90d</button></div>
  </div>
</div>`;
const collapsedFold = `<div class="card is-collapsed"><h2 style="margin: 0; padding: 4px 16px; font-size: 15px;">History</h2></div>`;
// the app's preflight sizes boxes border-box and zeroes heading margins → the fixture does too, so heights read as they render
const ANATOMY_PAGE = `<!doctype html><html data-theme="light"><head><style>*, ::before, ::after { box-sizing: border-box; } h2, p { margin: 0; }</style></head><body style="margin: 0;">
  <div style="padding: 24px;">
    <div class="split-row split-row--1-1 split-row--${layouts.equal}" id="wrapped">
      <div>${anatomyCard(tallBody(300), '<div class="card-foot">Other</div>')}</div>
      <div>${anatomyCard(tallBody(40), '<div class="card-foot">Show all 12</div>')}</div>
    </div>
    <div class="split-row split-row--1-1 split-row--${layouts.equal}" id="fold"><div class="card">${tallBody(400)}</div>${collapsedFold}</div>
    <div class="split-row split-row--1-1 split-row--${layouts.equal}" id="fold-wrapped"><div class="card">${tallBody(400)}</div><div>${collapsedFold}</div></div>
    <div class="card" id="head-card" style="width: 600px;">
      <div class="card-head">
        <div class="card-head-text"><h2 class="card-title">Spend by model</h2><span class="card-sub">last 7 days</span></div>
        <div style="margin-left: auto; display: flex; gap: 8px;"><button class="btn ghost sm" aria-label="How this is counted">i</button><button class="btn sm">7d</button></div>
      </div>
      <div class="card-body"><span id="body-text">body</span></div>
    </div>
    <div style="width: ${MAIN_COLUMN_PX}px;"><div class="split-row split-row--1-1 split-row--${layouts.equal}" id="meta-row">
      <div class="card">${controlledHead(CAPPED_META)}<div class="card-body">a</div></div>
      <div class="card">${controlledHead("")}<div class="card-body">b</div></div>
    </div></div>
    <div class="split-row split-row--1-1 split-row--${layouts.equal}" id="stretched"><div class="card"><div class="card-body">${tallBody(2000)}</div></div><div class="card"><div class="card-body">short</div></div></div>
    <div class="card card--l" id="lone-l"><div class="card-body">${tallBody(2000)}</div></div>
    <div style="width: 400px;"><table class="tbl" id="rows"><tbody>
      <tr><td>one line</td><td>2</td></tr>
      <tr><td class="cell-clamp" title="${LONG_TEXT}">${LONG_TEXT}</td><td>3</td></tr>
    </tbody></table></div>
    <p class="clamp-2" id="clamp" style="width: 160px; font-size: 15px; line-height: 1.5;">${LONG_TEXT} ${LONG_TEXT}</p>
  </div>
</body></html>`;
const ROW_H_PX = 40;
// 70vh of the 900px viewport the anatomy rows are read at
const LONE_SCROLL_CAP_PX = 630;

describe("card anatomy at real viewports", () => {
  let anatomy: Page;
  const boxOf = (selector: string) => anatomy.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);

  before(async () => {
    anatomy = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await anatomy.setContent(ANATOMY_PAGE);
    await anatomy.addStyleTag({ path: resolve(STYLES, "tokens.css") });
    await anatomy.addStyleTag({ path: resolve(STYLES, "base.css") });
  });

  test("peer cards held in wrappers end at one edge, their feet level", async () => {
    const [tall, short] = await anatomy.$$eval("#wrapped .card", (cards) => cards.map((c) => c.getBoundingClientRect().bottom));
    const [tallFoot, shortFoot] = await anatomy.$$eval("#wrapped .card-foot", (feet) => feet.map((f) => f.getBoundingClientRect().bottom));
    assert.ok(Math.abs(tall - short) <= 1, `card bottoms ${tall} vs ${short}`);
    assert.ok(Math.abs(tallFoot - shortFoot) <= 1, `foot bottoms ${tallFoot} vs ${shortFoot}`);
  });

  for (const row of ["fold", "fold-wrapped"]) {
    test(`a collapsed fold beside a tall peer keeps its header height (${row})`, async () => {
      const fold = await boxOf(`#${row} .card.is-collapsed`);
      assert.ok(fold.height < CARD.HEAD_H_PX, `fold ${fold.height}px`);
    });
  }

  test("a header with title, meta and two small buttons is one 48px line", async () => {
    const head = await boxOf("#head-card .card-head");
    const title = await boxOf("#head-card .card-title");
    const sub = await boxOf("#head-card .card-sub");
    assert.ok(Math.abs(head.height - CARD.HEAD_H_PX) < 1, `head ${head.height}px`);
    assert.ok(Math.abs((sub.top + sub.bottom) / 2 - (title.top + title.bottom) / 2) < 4, "meta sits on the title's line");
    assert.ok(sub.left > title.right, "meta follows the title");
  });

  test("a half-width card's capped meta ellipsizes instead of wrapping the controls under it", async () => {
    const [withMeta, withoutMeta] = await anatomy.$$eval("#meta-row .card-head", (heads) => heads.map((h) => h.getBoundingClientRect().toJSON() as DOMRect));
    assert.ok(withMeta.width < MAIN_COLUMN_PX / 2, `card head ${withMeta.width}px is half the column`);
    assert.ok(Math.abs(withMeta.height - CARD.HEAD_H_PX) < 1, `head ${withMeta.height}px`);
    assert.ok(Math.abs(withMeta.height - withoutMeta.height) < 1, `meta head ${withMeta.height}px vs bare peer ${withoutMeta.height}px`);
  });

  test("header text and body content share the card's inner edge", async () => {
    const card = await boxOf("#head-card");
    const title = await boxOf("#head-card .card-title");
    const body = await boxOf("#body-text");
    assert.equal(title.left, body.left);
    assert.ok(Math.abs(body.left - card.left - 1 - CARD.PAD_PX) < 1, `inset ${body.left - card.left}px`);
  });

  test("a light card rests on its border alone; a dark card keeps its depth", async () => {
    const shadowOf = () => anatomy.$eval("#head-card", (el) => getComputedStyle(el).boxShadow);
    assert.equal(await shadowOf(), "none");
    await anatomy.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const dark = await shadowOf();
    await anatomy.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    assert.notEqual(dark, "none");
  });

  test("a stretched row grows with its content instead of scrolling inside a card", async () => {
    const scroll = await anatomy.$eval("#stretched .card-body", (el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
    assert.ok(scroll.scroll <= scroll.client + 1, `inner scroll ${scroll.scroll} in ${scroll.client}`);
  });

  test("a lone L card caps its body and scrolls it", async () => {
    const body = await anatomy.$eval("#lone-l .card-body", (el) => ({ client: el.clientHeight, scroll: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
    assert.ok(body.client <= LONE_SCROLL_CAP_PX + 1, `body ${body.client}px`);
    assert.ok(body.scroll > body.client && body.overflow === "auto");
  });

  test("table rows are one 40px line, a long cell ellipsizing instead of wrapping", async () => {
    const heights = await anatomy.$$eval("#rows tr", (rows) => rows.map((r) => r.getBoundingClientRect().height));
    for (const height of heights) assert.ok(Math.abs(height - ROW_H_PX) < 1, `row ${height}px`);
    const cell = await anatomy.$eval("#rows .cell-clamp", (el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(cell.scroll > cell.client, "the long cell is cut, not widened");
  });

  test("a two-line clamp stops at two lines", async () => {
    const clamp = await boxOf("#clamp");
    assert.ok(clamp.height <= 2 * 15 * 1.5 + 1, `clamp ${clamp.height}px`);
  });
});
