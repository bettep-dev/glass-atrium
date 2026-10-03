// E2E chromium harness for the outcomes screen (screens/outcomes.jsx): painted header facts a node
// render cannot hold — whether a one-line card header's meta reads whole beside its badge.
//
// Runner: npx tsx --test test/outcomes.render-structure.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify serving the cross-analysis payload below; every other /api read answers empty.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser } from "playwright";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const CROSSTAB_HEAD = "#outcomes-crosstab .card-head";
// Five-digit totals, as a long-lived install holds → the widest counts the header carries.
const CROSS_ANALYSIS = {
  by_result: [],
  by_agent_result: [],
  cells: [
    { confidence: "high", metric_pass: true, count: 9_000, is_polar_mismatch: false },
    { confidence: "high", metric_pass: false, count: 1_234, is_polar_mismatch: true },
    { confidence: "medium", metric_pass: true, count: 852, is_polar_mismatch: false },
    { confidence: "low", metric_pass: true, count: 266, is_polar_mismatch: true },
  ],
};
const POLAR_TOTAL_TEXT = "1,500";
// room past the meta's painted width → a platform painting text a few percent wider still shows it whole
const META_SLACK = 0.2;

interface HeadFit {
  meta: string;
  needPx: number;
  shownPx: number;
  badge: string;
}

describe("outcomes crosstab header", () => {
  let app: FastifyInstance;
  let browser: Browser;
  let serverUrl: string;

  before(async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
    app.get("/api/outcomes/cross-analysis", async () => CROSS_ANALYSIS);
    app.get("/api/*", async () => ({ rows: [] }));
    await app.ready();
    serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser?.close();
    await app?.close();
  });

  for (const width of [1280, 1440, 1920]) {
    test(`the meta reads whole beside the mismatch badge with ${META_SLACK * 100}% to spare at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${serverUrl}/#outcomes`, { waitUntil: "load" });
        await page.waitForSelector(`${CROSSTAB_HEAD} .pill`, { timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);
        const fit: HeadFit = await page.$eval(CROSSTAB_HEAD, (head) => {
          const sub = head.querySelector(".card-sub") as HTMLElement;
          const text = document.createRange();
          text.selectNodeContents(sub);
          return {
            meta: sub.textContent ?? "",
            needPx: text.getBoundingClientRect().width,
            shownPx: sub.clientWidth,
            badge: head.querySelector(".pill")?.textContent ?? "",
          };
        });
        const slack = fit.shownPx / fit.needPx - 1;

        assert.ok(fit.badge.includes(POLAR_TOTAL_TEXT), `the badge keeps the mismatch count: "${fit.badge}"`);
        assert.ok(
          slack >= META_SLACK,
          `"${fit.meta}" needs ${fit.needPx.toFixed(1)}px, shows ${fit.shownPx}px (${(slack * 100).toFixed(1)}% to spare)`,
        );
      } finally {
        await page.close();
      }
    });
  }
});
