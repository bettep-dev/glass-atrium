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
const CARD_GAP_PX = 16;
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
    assert.ok(Math.abs(two.top - one.bottom - CARD_GAP_PX) < 1, `gap ${two.top - one.bottom}`);
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
