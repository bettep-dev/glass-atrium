// Popover in a real browser: a card-head panel taller than its card stays fully visible and hit-testable.
// Runner: npx tsx --test test/ui.popover.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

// a zero-row Results card: the open filter panel is far taller than the card, and another card sits right below it
const SHORT_CARD_PAGE = `<!doctype html><html data-theme="light"><body>
  <div style="width: 640px; padding: 24px;">
    <div class="card" id="results">
      <div class="card-head">
        <div style="flex: 1;"><h2 class="card-title">Results</h2></div>
        <div class="popover-root">
          <button type="button" class="btn ghost sm">Filters</button>
          <div class="popover-panel" id="panel" role="dialog" aria-label="Filters" style="height: 260px;"></div>
        </div>
      </div>
      <div class="card-body">No rows</div>
    </div>
    <div class="card" id="next" style="margin-top: 16px; height: 400px;"></div>
  </div>
</body></html>`;

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  await page.setContent(SHORT_CARD_PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
});

after(async () => {
  await browser?.close();
});

describe("Popover panel inside a card head", () => {
  test("every point of a panel taller than its card hits the panel, past the card's bottom edge and over the card below", async () => {
    const probe = await page.evaluate(() => {
      const panel = document.getElementById("panel") as HTMLElement;
      const card = document.getElementById("results") as HTMLElement;
      const box = panel.getBoundingClientRect();
      const cardBottom = card.getBoundingClientRect().bottom;
      const xs = [box.left + 4, (box.left + box.right) / 2, box.right - 4];
      const ys = [box.top + 4, (cardBottom + box.bottom) / 2, box.bottom - 4];
      const misses = xs.flatMap((x) => ys.map((y) => ({ x, y, hit: document.elementFromPoint(x, y) })))
        .filter(({ hit }) => hit === null || !panel.contains(hit))
        .map(({ x, y, hit }) => `(${Math.round(x)},${Math.round(y)}) → ${hit ? hit.id || hit.tagName : "null"}`);
      return { overhang: box.bottom - cardBottom, misses };
    });

    assert.ok(probe.overhang > 100, `fixture must put the panel past the card bottom (overhang ${probe.overhang}px)`);
    assert.deepEqual(probe.misses, []);
  });
});

// three stacked rows in an open panel; `tokens` overrides the role tokens on the wrapper (inherited by the panel)
function buildRowsPage(tokens: string): string {
  return `<!doctype html><html data-theme="light"><body>
  <div style="width: 640px; padding: 24px; ${tokens}">
    <div class="popover-root" style="float: right;">
      <button type="button" class="btn ghost sm">Info</button>
      <div class="popover-panel" id="panel" role="dialog" aria-label="Info">
        <div class="row" style="height: 24px;">One</div>
        <div class="row" style="height: 24px;">Two</div>
        <div class="row" style="height: 24px;">Three</div>
      </div>
    </div>
  </div>
</body></html>`;
}

describe("Popover panel spacing follows the role tokens", () => {
  const rows = [
    { name: "default tokens", tokens: "" },
    { name: "tokens overridden on an ancestor", tokens: "--card-pad: 24px; --gap-list: 12px;" },
  ];

  for (const row of rows) {
    test(`every side's inset equals --card-pad and every row gap equals --gap-list (${row.name})`, async () => {
      const rowsPage = await browser.newPage({ viewport: { width: 1024, height: 900 } });
      try {
        await rowsPage.setContent(buildRowsPage(row.tokens));
        await rowsPage.addStyleTag({ path: resolve(STYLES, "tokens.css") });
        await rowsPage.addStyleTag({ path: resolve(STYLES, "base.css") });

        const probe = await rowsPage.evaluate(() => {
          const panel = document.getElementById("panel") as HTMLElement;
          const style = getComputedStyle(panel);
          // inline callback, never a named local → tsx's __name wrapper stays out of the page
          const [cardPad, gapList] = ["--card-pad", "--gap-list"].map((name) => {
            const ruler = document.createElement("div");
            ruler.style.width = `var(${name})`;
            panel.appendChild(ruler);
            const px = ruler.getBoundingClientRect().width;
            ruler.remove();
            return px;
          });
          const box = panel.getBoundingClientRect();
          const inner = {
            top: box.top + parseFloat(style.borderTopWidth),
            right: box.right - parseFloat(style.borderRightWidth),
            bottom: box.bottom - parseFloat(style.borderBottomWidth),
            left: box.left + parseFloat(style.borderLeftWidth),
          };
          const rects = [...panel.querySelectorAll(".row")].map((el) => el.getBoundingClientRect());
          const first = rects[0];
          const last = rects[rects.length - 1];
          return {
            cardPad,
            gapList,
            insets: {
              top: first.top - inner.top,
              right: inner.right - first.right,
              bottom: inner.bottom - last.bottom,
              left: first.left - inner.left,
            },
            gaps: rects.slice(1).map((rect, i) => rect.top - rects[i].bottom),
          };
        });

        const { cardPad, gapList } = probe;
        assert.deepEqual(probe.insets, { top: cardPad, right: cardPad, bottom: cardPad, left: cardPad },
          `inset per side vs --card-pad ${cardPad}px`);
        assert.deepEqual(probe.gaps, [gapList, gapList], `row gaps vs --gap-list ${gapList}px`);
      } finally {
        await rowsPage.close();
      }
    });
  }
});
