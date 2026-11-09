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

import { TEXT_SCALE, getWidenedMetaFits } from "./lib/painted-text.js";

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
    test(`the meta reads whole beside the mismatch badge with the header text ${TEXT_SCALE}× as wide at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${serverUrl}/#outcomes`, { waitUntil: "load" });
        await page.waitForSelector(`${CROSSTAB_HEAD} .pill`, { timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);
        const badge = await page.textContent(`${CROSSTAB_HEAD} .pill`);
        const [fit] = await page.$$eval(`${CROSSTAB_HEAD} .card-sub`, getWidenedMetaFits, TEXT_SCALE);

        assert.ok(badge?.includes(POLAR_TOTAL_TEXT), `the badge keeps the mismatch count: "${badge}"`);
        assert.ok(fit, "the header carries a meta");
        assert.ok(
          fit.needPx <= fit.shownPx,
          `text ×${TEXT_SCALE}: "${fit.text}" needs ${fit.needPx.toFixed(1)}px, shows ${fit.shownPx.toFixed(1)}px`,
        );
      } finally {
        await page.close();
      }
    });
  }

  test("the cross table's body and total rows sit on the 40 step, each count on its row's centre line", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${serverUrl}/#outcomes`, { waitUntil: "load" });
      await page.waitForSelector("#outcomes-crosstab table tbody tr", { timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      // inline callbacks only — a named helper inside the page function picks up tsx's __name shim, absent in the page
      const rows = await page.$$eval("#outcomes-crosstab table :is(tbody, tfoot) > tr", (trs) => trs.map((tr) => {
        const [label, ...counts] = [tr.querySelector("th"), ...tr.querySelectorAll("td[aria-label] > span:first-child")]
          .map((el) => (el ? (el.getBoundingClientRect().top + el.getBoundingClientRect().bottom) / 2 : NaN));
        return { height: tr.getBoundingClientRect().height, label, counts };
      }));
      assert.ok(rows.length >= 4, `${rows.length} rows (three confidence rows and the total)`);
      for (const row of rows) {
        assert.ok(Math.abs(row.height - 40) < 0.5, `row ${row.height}px`);
        for (const count of row.counts) assert.ok(Math.abs(count - row.label) < 1, `count centre ${count} vs label ${row.label}`);
      }
      assert.ok(rows.some((row) => row.counts.length > 0), "the body rows carry count + bar cells");
    } finally {
      await page.close();
    }
  });
});

// The status band and the ledger as painted: a stretched "Needs you" hero keeps its body at the top,
// each prior range paints whole on one line, and every summary starts at one x beside its row's pill.
const BAND_AGENT = "glass-atrium-dev-react";
const BAND_OVERALL = {
  total: 400, reconstructed_total: 0, excluded_poisoned_count: 0,
  by_result: [
    { result: "done", count: 300, reconstructed_count: 0 },
    { result: "fail", count: 30, reconstructed_count: 0 },
    { result: "blocked", count: 10, reconstructed_count: 0 },
    { result: "done_with_concerns", count: 60, reconstructed_count: 0 },
  ],
  by_agent_result: [], by_agent_top_10: [], cells: [],
  prior_window: {
    period_start: "2026-08-29", period_end: "2026-09-28", total: 300, reconstructed_total: 0, excluded_poisoned_count: 0,
    by_result: [{ result: "done", count: 250, reconstructed_count: 0 }, { result: "fail", count: 4, reconstructed_count: 0 }],
  },
};
const LEDGER_ROWS = [
  { id: 1, agent: BAND_AGENT, task_type: "feature", result: "done_with_concerns", closed_at: null, record_ts: "2026-10-01T10:00:00Z", summary: "An open caveat", review_flag: false },
  { id: 2, agent: BAND_AGENT, task_type: "refactor", result: "done", closed_at: null, record_ts: "2026-10-01T09:00:00Z", summary: "A flagged row", review_flag: true, review_flag_reasons: ["scope-excess", "overconfidence"] },
  { id: 3, agent: BAND_AGENT, task_type: "bug-fix", result: "fail", closed_at: null, record_ts: "2026-10-01T08:00:00Z", summary: "A failed row", review_flag: false },
  { id: 4, agent: BAND_AGENT, task_type: "review", result: "done", closed_at: null, record_ts: "2026-10-01T07:00:00Z", summary: "A routine row", review_flag: false },
];
// the needs-you wave reads totals only (limit=1); the headline carries the prior count
const getAttentionTotal = (query: Record<string, string>): number => {
  if (query.review_flag === "true") return 20;
  return ({ fail: 8, blocked: 2, done_with_concerns: 10 } as Record<string, number>)[query.result] ?? 40;
};

describe("outcomes status band and ledger as painted", () => {
  let app: FastifyInstance;
  let browser: Browser;
  let serverUrl: string;

  before(async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
    app.get("/api/outcomes/cross-analysis", async () => BAND_OVERALL);
    app.get("/api/outcomes/search", async (req) => {
      const query = req.query as Record<string, string>;
      if (query.limit === "1") return { rows: [], total: getAttentionTotal(query), prior_window: { total: 25 } };
      return { rows: LEDGER_ROWS, total: LEDGER_ROWS.length };
    });
    app.get("/api/*", async () => ({ rows: [] }));
    await app.ready();
    serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser?.close();
    await app?.close();
  });

  for (const width of [800, 1440]) {
    test(`the hero body sits at the top, no tile states a range, every summary starts at one x at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${serverUrl}/#outcomes`, { waitUntil: "load" });
        await page.waitForSelector("tr.outcome-row td", { timeout: 30_000 });
        await page.waitForFunction(() => / pt\b|\bLevel\b/.test(document.body.innerText), null, { timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);
        const painted = await page.evaluate(() => {
          const hero = [...document.querySelectorAll<HTMLElement>(".kpi")].find((tile) => /Needs you/.test(tile.textContent ?? ""))!;
          const heroStyle = getComputedStyle(hero);
          const ranges = [...document.querySelectorAll<HTMLElement>(".kpi .whitespace-nowrap")]
            .filter((span) => /^\d\d-\d\d – \d\d-\d\d$/.test(span.textContent ?? ""));
          const summaries = [...document.querySelectorAll<HTMLTableRowElement>("tr.outcome-row")].map((tr) => ({
            rowH: tr.getBoundingClientRect().height,
            x: tr.cells[tr.cells.length - 1].querySelector(".truncate")!.getBoundingClientRect().x,
          }));
          return {
            heroH: hero.getBoundingClientRect().height,
            headOffset: hero.querySelector(".kpi-head")!.getBoundingClientRect().y - hero.getBoundingClientRect().y,
            headFloor: parseFloat(heroStyle.borderTopWidth) + parseFloat(heroStyle.paddingTop),
            ranges: ranges.length,
            summaries,
          };
        });

        assert.ok(painted.heroH > 200, `the hero stretches beside the volume column: ${painted.heroH}px`);
        assert.ok(Math.abs(painted.headOffset - painted.headFloor) <= 1, `label row ${painted.headOffset}px below the tile top, not ${painted.headFloor}px`);
        assert.strictEqual(painted.ranges, 0, "the comparison window sits in the band's ⓘ, never on a tile");
        // the needs-you read answers with the same fixture rows → the ledger paints at least every fixture row
        assert.ok(painted.summaries.length >= LEDGER_ROWS.length, `ledger rows painted: ${painted.summaries.length}`);
        const xs = painted.summaries.map((row) => row.x);
        assert.ok(Math.max(...xs) - Math.min(...xs) <= 0.5, `summaries start at one x: ${xs.join(", ")}`);
        for (const row of painted.summaries) assert.ok(Math.abs(row.rowH - 40) <= 0.5, `ledger row ${row.rowH}px`);
      } finally {
        await page.close();
      }
    });
  }
});

describe("the Results filter bar drives the ledger fetch", () => {
  const BAR = "#outcomes-ledger .card-bar";
  let app: FastifyInstance;
  let browser: Browser;
  let serverUrl: string;

  before(async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
    app.get("/api/outcomes/search", async () => ({ rows: [], total: 0 }));
    app.get("/api/*", async () => ({ rows: [] }));
    await app.ready();
    serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("every filter axis is a trigger on the bar naming its value, with no Filters popover left", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${serverUrl}/#outcomes`, { waitUntil: "load" });
      await page.waitForSelector(`${BAR} .filter-trigger`, { timeout: 30_000 });
      const triggers = await page.$$eval(`${BAR} .filter-trigger`, (buttons) => buttons.map((button) =>
        [button.querySelector(".filter-trigger-axis")!.textContent, button.querySelector(".filter-trigger-value")!.textContent]));
      assert.deepEqual(triggers, [
        ["Agent", "All"], ["Result", "All"], ["Flagged", "All"], ["Task type", "All"], ["Confidence", "All"],
        ["Self-check", "All"], ["Attribution", "All"], ["Scope", "Registry agents"], ["Sort", "Newest first"],
      ]);
      assert.equal(await page.locator('#outcomes-ledger [aria-haspopup="dialog"]').count(), 0, "Filters popover trigger");
    } finally {
      await page.close();
    }
  });

  const picks = [
    { name: "a Result pick reaches the ledger request as its wire value", axis: "Result", option: "Failed", param: "result", wire: "fail" },
    { name: "the All records scope reaches the ledger request as include_all", axis: "Scope", option: "All records", param: "include_all", wire: "1" },
  ];
  for (const row of picks) {
    test(row.name, async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${serverUrl}/#outcomes`, { waitUntil: "load" });
        const trigger = page.locator(`${BAR} .filter-trigger`, { hasText: row.axis });
        await trigger.click();
        const request = page.waitForRequest((req) => {
          const url = new URL(req.url());
          return url.pathname === "/api/outcomes/search" && url.searchParams.get(row.param) === row.wire;
        }, { timeout: 30_000 });
        await page.getByRole("menuitemradio", { name: row.option }).click();
        await request;
        assert.equal(await trigger.locator(".filter-trigger-value").textContent(), row.option);
      } finally {
        await page.close();
      }
    });
  }
});
