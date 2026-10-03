// TrendChart's y-scale column measured in a real browser: its labels stay inside the card that clips them.
// Runner: npx tsx --test test/ui.chart-y-scale.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import type { Browser } from "playwright";
import { chromium } from "playwright";

import { loadScreenModule } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// react-dom ships no types and @types/react-dom is not installed → the one call used here, typed by hand
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as { renderToStaticMarkup: (element: React.ReactElement) => string };
const STYLES = resolve(HERE, "..", "public", "styles");

const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"), { React });
const TrendChart = (ui.UI as Record<string, unknown>).TrendChart as React.FC<Record<string, unknown>>;

// the Learning "Verified vs rejected" series: its widest label is the one the card clipped
const REJECT_SHARES = [0.2, 0.5, 1, 0.4, 0.8, 0, 0.6];
const points = REJECT_SHARES.map((value, i) => ({ label: `09-0${i + 1}`, value }));
const chart = renderToStaticMarkup(React.createElement(TrendChart, {
  label: "Share of scored cycles rejected, per day",
  points,
  yScale: true,
  formatValue: (v: number) => `${Math.round(v * 100)}% rejected`,
}));
// px-5 pb-4 body inside an overflow:hidden card, half the page wide like a split-row column
const CARD_PAGE = `<!doctype html><html data-theme="light"><body style="margin: 0;">
  <div style="padding: 24px; width: 50%;">
    <div class="card" id="card"><div style="padding: 0 20px 16px;">${chart}</div></div>
  </div>
</body></html>`;

const viewportRows = [
  { name: "at 1440 the y-scale labels sit inside the card, left of the plot", width: 1440 },
  { name: "at 1024 the y-scale labels sit inside the card, left of the plot", width: 1024 },
] as const;

let browser: Browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

describe("TrendChart y-scale inside a clipping card", () => {
  for (const row of viewportRows) {
    test(row.name, async () => {
      const page = await browser.newPage({ viewport: { width: row.width, height: 600 } });
      await page.setContent(CARD_PAGE);
      await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
      await page.addStyleTag({ path: resolve(STYLES, "base.css") });

      const reading = await page.evaluate(() => {
        const card = document.getElementById("card")!.getBoundingClientRect();
        const plot = document.querySelector<HTMLElement>(".trend-chart [role='img']")!.getBoundingClientRect();
        const labels = [...document.querySelectorAll<HTMLElement>("[data-chart-y-scale] span")].map((span) => {
          const box = span.getBoundingClientRect();
          return { text: span.textContent, left: Math.round(box.left), right: Math.round(box.right) };
        });
        return { cardLeft: Math.round(card.left), cardRight: Math.round(card.right), plotLeft: Math.round(plot.left), labels };
      });
      await page.close();

      assert.equal(reading.labels.length, 2, "the scale renders a top and a bottom label");
      for (const label of reading.labels) {
        assert.ok(label.left >= reading.cardLeft && label.right <= reading.cardRight,
          `"${label.text}" spans ${label.left}–${label.right}, outside the card ${reading.cardLeft}–${reading.cardRight}`);
        assert.ok(label.right <= reading.plotLeft, `"${label.text}" ends at ${label.right}, over the plot starting at ${reading.plotLeft}`);
      }
    });
  }
});

describe("Recharts day ticks in a real browser", () => {
  const { ChartAxisTick, CHART_TICK_CHAR_PX } = ui.UI as { ChartAxisTick: React.FC<Record<string, unknown>>; CHART_TICK_CHAR_PX: number };
  const label = "2026-09-30";
  const tick = renderToStaticMarkup(React.createElement("svg", { width: 400, height: 40 },
    React.createElement(ChartAxisTick, { x: 200, y: 4, payload: { value: label, coordinate: 200 }, index: 1, visibleTicksCount: 3 })));

  test("a rendered tick label is no wider than the per-character estimate the gap math uses", async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 200 } });
    await page.setContent(`<!doctype html><html data-theme="light"><body>${tick}</body></html>`);
    await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
    await page.addStyleTag({ path: resolve(STYLES, "base.css") });
    const width = await page.evaluate(() => document.querySelector("text")!.getComputedTextLength());
    await page.close();

    assert.ok(width <= label.length * CHART_TICK_CHAR_PX, `"${label}" renders ${width.toFixed(1)}px, over the ${label.length * CHART_TICK_CHAR_PX}px estimate`);
  });
});
