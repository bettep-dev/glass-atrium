// E2E chromium checks for the Learning screen's loop-output row (screens/improvement.jsx):
// the trend's y labels and both cards' basis metas are painted whole, which a node render cannot measure.
//
// Runner: npx tsx --test test/improvement.loop-output.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify serving loop events below; every other /api read answers empty.

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { chromium, type Page } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const TREND_LABELS = "#improvement-trend [data-chart-y-scale] span";
const LOOP_METAS = [
  "#improvement-change-summary .card-head .card-sub",
  "#improvement-trend .card-head .card-sub",
  "#improvement-learning-memory .card-head .card-sub",
].join(", ");

// eight cycle days with a rising reject share → a full 0–100% axis
function getLoopEvents() {
  return Array.from({ length: 8 }, (_, day) => day).flatMap((day) =>
    Array.from({ length: 4 }, (_, i) => ({
      event_ts: `2026-09-${String(22 + day).padStart(2, "0")}T0${i}:00:00Z`,
      eval_result: i < day % 5 ? "reject" : "verified",
      changes_added: i,
      changes_removed: 0,
    })),
  );
}

// the loop-events fetch limit, newest first → the longest basis a card heads
function getCutLoopEvents() {
  return Array.from({ length: 200 }, (_, i) => ({
    event_ts: `2026-09-${String(1 + (i % 30)).padStart(2, "0")}T0${i % 10}:00:00Z`,
    eval_result: i % 3 === 0 ? "reject" : "verified",
    changes_added: 1,
    changes_removed: 0,
  }));
}

// stripped app serving these loop events; every other /api read answers empty
async function withLearningPage(width: number, events: unknown[], check: (page: Page) => Promise<void>) {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/improvement/loop-events", async () => ({ events }));
  app.get("/api/*", async () => ({ rows: [] }));
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${serverUrl}/#improvement`, { waitUntil: "load" });
    await check(page);
  } finally {
    await browser.close();
    await app.close();
  }
}

for (const width of [1440, 1024]) {
  test(`the trend's y labels sit whole inside their card at ${width}px`, async () => {
    await withLearningPage(width, getLoopEvents(), async (page) => {
      await page.waitForSelector(TREND_LABELS, { timeout: 30_000 });
      const labels = await page.evaluate((selector) => {
        const card = document.getElementById("improvement-trend")!.getBoundingClientRect();
        return [...document.querySelectorAll<HTMLElement>(selector)].map((span) => {
          const box = span.getBoundingClientRect();
          return {
            text: span.textContent ?? "",
            isInside: box.left >= card.left && box.right <= card.right,
            isWhole: span.scrollWidth <= Math.ceil(box.width),
          };
        });
      }, TREND_LABELS);

      assert.ok(labels.length >= 2, "the axis prints a scale");
      for (const label of labels) {
        assert.ok(label.isInside && label.isWhole, `${width}px: "${label.text}" is clipped`);
      }
    });
  });
}

// 1280 is the narrowest three-card row; below it the cards pair up and widen
for (const width of [1280, 1440]) {
  test(`every loop card shows its whole header meta at ${width}px`, async () => {
    await withLearningPage(width, getCutLoopEvents(), async (page) => {
      await page.waitForSelector(LOOP_METAS, { timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      const metas = await page.evaluate(
        (selector) =>
          [...document.querySelectorAll<HTMLElement>(selector)].map((sub) => ({
            text: sub.textContent ?? "",
            isWhole: sub.scrollWidth <= sub.clientWidth,
          })),
        LOOP_METAS,
      );

      assert.equal(metas.length, 3, "all three loop cards head a meta");
      for (const meta of metas) {
        assert.ok(meta.isWhole, `${width}px: "${meta.text}" is cut`);
      }
    });
  });
}
