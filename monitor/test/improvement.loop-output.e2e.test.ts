// E2E chromium check for the Learning screen's loop-output row (screens/improvement.jsx):
// the trend's y labels are painted inside their card, which a node render cannot measure.
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
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const TREND_LABELS = "#improvement-trend [data-chart-y-scale] span";

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

for (const width of [1440, 1024]) {
  test(`the trend's y labels sit whole inside their card at ${width}px`, async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
    app.get("/api/improvement/loop-events", async () => ({ events: getLoopEvents() }));
    app.get("/api/*", async () => ({ rows: [] }));
    const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${serverUrl}/#improvement`, { waitUntil: "load" });
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
    } finally {
      await browser.close();
      await app.close();
    }
  });
}
