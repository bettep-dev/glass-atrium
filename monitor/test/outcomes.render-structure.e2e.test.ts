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

// The status band and the ledger as painted: the band is one stat row card with no tile inside it,
// no stat states the prior range, and every summary starts at one x beside its row's pill.
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
    test(`the band is one stat row, no stat states a range, every summary starts at one x at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${serverUrl}/#outcomes`, { waitUntil: "load" });
        await page.waitForSelector("tr.outcome-row td", { timeout: 30_000 });
        await page.waitForFunction(() => / pt\b|\bLevel\b/.test(document.body.innerText), null, { timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);
        const painted = await page.evaluate(() => {
          const band = [...document.querySelectorAll<HTMLElement>(".stat-row")].find((row) => /Needs you/.test(row.textContent ?? ""));
          const ranges = [...(band?.querySelectorAll<HTMLElement>(".whitespace-nowrap") ?? [])]
            .filter((span) => /^\d\d-\d\d – \d\d-\d\d$/.test(span.textContent ?? ""));
          const summaries = [...document.querySelectorAll<HTMLTableRowElement>("tr.outcome-row")].map((tr) => ({
            rowH: tr.getBoundingClientRect().height,
            x: tr.cells[tr.cells.length - 1].querySelector(".truncate")!.getBoundingClientRect().x,
          }));
          return {
            stats: band?.querySelectorAll(":scope > .stat").length ?? 0,
            tiles: band?.closest(".card")?.querySelectorAll(".kpi").length ?? -1,
            ranges: ranges.length,
            summaries,
          };
        });

        assert.strictEqual(painted.stats, 4, "needs you, failed or blocked and the two volume facts sit in one stat row");
        assert.strictEqual(painted.tiles, 0, "the band card holds no KPI tile");
        assert.strictEqual(painted.ranges, 0, "the comparison window sits in the band's ⓘ, never on a stat");
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

// Sticky heads: the ledger sticks to the page viewport (its card lifts the body cap), Failures by agent to its own 70vh card body,
// the run-event log to its 42vh log box once its fold opens.
const STICKY_ROW_PX = 40;
const STICKY_LEDGER_ROWS = Array.from({ length: 40 }, (_, i) => ({
  id: 100 + i, agent: BAND_AGENT, task_type: "review", result: "done", closed_at: null,
  record_ts: `2026-10-01T${String(23 - Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}:00Z`, summary: `Routine row ${i + 1}`, review_flag: false,
}));
const STICKY_OVERALL = {
  ...BAND_OVERALL,
  by_agent_result: Array.from({ length: 30 }, (_, i) => ({ agent: `glass-atrium-dev-sticky-${i + 1}`, result: "fail", count: 30 - i, reconstructed_count: 0 })),
};
const STICKY_TABLES = [
  { name: "the ledger", cardId: "outcomes-ledger", scroller: "the page viewport" },
  { name: "Failures by agent", cardId: "outcomes-agent-failures", scroller: "its 70vh card body" },
  { name: "the run-event log", cardId: "outcomes-loop-events", scroller: "its 42vh log box", fold: "Learning-run events" },
];
const STICKY_LOOP_EVENTS = Array.from({ length: 50 }, (_, i) => ({
  id: 500 + i, event_ts: `2026-10-01T${String(23 - Math.floor(i / 3)).padStart(2, "0")}:${String((i % 3) * 20).padStart(2, "0")}:00Z`,
  agent: BAND_AGENT, eval_result: i % 4 ? "verified" : "reject", changes_added: i, changes_removed: 1,
}));

describe("outcomes screen at 1440px, sticky table heads", () => {
  let app: FastifyInstance;
  let browser: Browser;
  let serverUrl: string;

  before(async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
    app.get("/api/outcomes/cross-analysis", async () => STICKY_OVERALL);
    app.get("/api/outcomes/search", async (req) => {
      const query = req.query as Record<string, string>;
      if (query.limit === "1") return { rows: [], total: 0 };
      return { rows: query.review_flag || query.result ? [] : STICKY_LEDGER_ROWS, total: STICKY_LEDGER_ROWS.length };
    });
    app.get("/api/improvement/loop-events", async () => ({
      events: STICKY_LOOP_EVENTS, total_events: STICKY_LOOP_EVENTS.length,
      result_distribution: [{ eval_result: "verified", count: 37 }, { eval_result: "reject", count: 13 }],
    }));
    app.get("/api/*", async () => ({ rows: [] }));
    await app.ready();
    serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser?.close();
    await app?.close();
  });

  for (const row of STICKY_TABLES) {
    test(`${row.name}: the column head sticks to the top of ${row.scroller} after a scroll into the body`, async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${serverUrl}/#outcomes`, { waitUntil: "load" });
        if (row.fold) await page.getByRole("button", { name: new RegExp(row.fold) }).click();
        await page.waitForFunction((id) => (document.querySelector(`#${id} tbody`)?.getBoundingClientRect().height ?? 0) > 800, row.cardId, { timeout: 30_000 });
        const result = await page.evaluate(({ cardId, rowPx }) => {
          const head = document.querySelector(`#${cardId} thead th`) as HTMLElement;
          const body = document.querySelector(`#${cardId} tbody`) as HTMLElement;
          let scroller: HTMLElement | null = head.parentElement;
          while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
          const target = scroller ?? (document.scrollingElement as HTMLElement);
          const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
          // a quarter of the body under the head: far enough that an unstuck head leaves the view, near enough to stay in its table
          const offsetPx = body.getBoundingClientRect().height / 4;
          const headStartPx = head.getBoundingClientRect().top - viewTop + target.scrollTop;
          const room = target.scrollHeight - target.clientHeight - headStartPx;
          target.scrollTop = headStartPx + offsetPx;
          return { isPage: scroller === null, canScroll: room > offsetPx && offsetPx >= rowPx, offsetPx: head.getBoundingClientRect().top - viewTop };
        }, { cardId: row.cardId, rowPx: STICKY_ROW_PX });

        assert.equal(result.isPage, row.cardId === "outcomes-ledger", `${row.name}: scrolls in ${row.scroller}`);
        assert.equal(result.canScroll, true, `${row.name}: the scroller reaches a quarter body past the head's start`);
        assert.ok(Math.abs(result.offsetPx) <= 1, `${row.name}: head ${result.offsetPx}px off the scroller top`);
      } finally {
        await page.close();
      }
    });
  }
});
