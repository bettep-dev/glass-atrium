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

// sub-pixel rounding of fr tracks
const RATIO_TOLERANCE = 0.02;

const splitRows = Object.entries(ratios).map(([ratio, modifier]) =>
  `<div class="split-row split-row--${modifier}" data-ratio="${ratio}"><div>a</div><div>b</div></div>`).join("");
const LAYOUT_PAGE = `<!doctype html><html data-theme="light"><body style="margin: 0;">
  <div style="padding: 24px;">${splitRows}
    <div class="tile-split" id="tile"><div class="tile-split-lead">42</div><div class="tile-split-detail">detail text</div></div>
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
    const pairs = [...document.querySelectorAll<HTMLElement>(".split-row, .tile-split")];
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
