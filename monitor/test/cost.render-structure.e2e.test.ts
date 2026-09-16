// E2E chromium STRUCTURE harness for the cost screen (screens/cost.jsx).
// Runner: npx tsx --test test/cost.render-structure.e2e.test.ts
//
// Asserts DOM-structure facts only — the decision tier renders above the instrumentation
// tier in priority order, the alarm lane occupies the DOM only when a trigger fires, and
// the decision tier draws exactly one chart root. No value, colour or pixel assertion
// lives here: the derivations behind those values are pinned in cost.client.unit.test.ts.
//
// TWO render contexts, one per fixture (calm · hot). The lane is a function of the
// payloads, so a single context can only ever measure one side of it: absence in the calm
// context means nothing unless the same screen renders the lane in the hot one.
//
// App: stripped Fastify (fastify-static + the cost screen's seven payload routes) on an
// ephemeral port. registerCostRoutes is NOT called — it stands up Prisma-backed handlers
// whose output depends on live data, which would make a structure assertion a data
// assertion. A catch-all keeps the app shell's own polling quiet.
// Browser: Playwright chromium headless, NO mocking.
//
// Page-level network prerequisite: the page pulls React and Recharts from CDN, so the run
// REQUIRES outbound network and an installed chromium. An unmet prerequisite fails RED
// (asserted in before) — no skip guard absorbs it. The shipped bundle under public/dist is
// the artifact under test, so `npm run build:jsx` must precede the run.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");

// The screen's own tier order, as the target composition states it: four KPI tiles, then the
// three decision cards, then the three instrumentation disclosures.
const DECISION_CARD_TITLES = ["Cost over time", "Cost by model", "Most expensive sessions"];
const DISCLOSURE_TITLES = ["Token volume", "Turn statistics", "Log integrity"];
const KPI_TILE_COUNT = 4;

// A calm window: ten days of ordinary spend whose newest day sits inside its own band.
const CALM_TREND_COSTS = [10, 11, 9, 10, 11, 9, 10, 11, 9, 10];

interface CostFixture {
  kpi: Record<string, number>;
  trendCosts: readonly number[];
  parseErrorRatio: number;
}

// today = ratio x the 7-day daily normal; the burn rate extrapolates to the same ratio.
function getFixture(ratio: number, parseErrorRatio: number): CostFixture {
  const week7Cost = 70;
  const normalDaily = week7Cost / 7;
  return {
    kpi: {
      today_cost_usd: normalDaily * ratio,
      window_7d_cost_usd: week7Cost,
      burn_rate_3h_usd_per_hour: (normalDaily * ratio) / 24,
      cost_per_done_usd: 0.42,
      done_count_7d: 24,
    },
    trendCosts: CALM_TREND_COSTS,
    parseErrorRatio,
  };
}

function getDayKey(index: number): string {
  return new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
}

interface RenderContext {
  app: FastifyInstance;
  browser: Browser;
  page: Page;
}

async function openRenderContext(fixture: CostFixture): Promise<RenderContext> {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, {
    root: PUBLIC_ROOT,
    prefix: "/",
    index: ["index.html"],
  });

  const trendRows = fixture.trendCosts.map((cost, i) => ({
    day: getDayKey(i),
    cost_usd: cost,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 4000,
    cache_creation_tokens: 800,
  }));

  app.get("/api/cost/kpi", async () => fixture.kpi);
  app.get("/api/dashboard/cost-timeseries", async () => ({ rows: trendRows }));
  app.get("/api/cost/by-model", async () => ({
    rows: [
      {
        model: "claude-opus-5",
        cost_usd: 80,
        session_count: 12,
        input_tokens: 10_000,
        output_tokens: 5000,
        cache_read_tokens: 40_000,
        cache_creation_tokens: 8000,
      },
    ],
  }));
  app.get("/api/cost/cache-hit", async () => ({
    rows: trendRows.map((r) => ({ day: r.day, cache_hit_ratio: 0.8 })),
  }));
  app.get("/api/cost/session-distribution", async () => ({
    rows: Array.from({ length: 8 }, (_, i) => ({
      session_id: `session-${i}`,
      total_cost_usd: 8 - i,
      agent: "glass-atrium-dev-react",
      started_at: getDayKey(i),
    })),
    total_session_count: 8,
    truncated: false,
  }));
  app.get("/api/cost/parse-errors", async () => ({
    rows: trendRows.map((r) => ({
      day: r.day,
      error_ratio: fixture.parseErrorRatio,
      error_count: 1,
      total_count: 100,
    })),
  }));
  app.get("/api/cost/turn-stats", async () => ({
    stop_reasons: [{ stop_reason: "end_turn", event_count: 40 }],
    turns: { total_turns: 40, avg_turns: 4 },
  }));
  // The app shell polls endpoints this screen does not own; an empty payload keeps those
  // panels quiet instead of letting a 404 banner enter the structure under test.
  app.get("/api/*", async () => ({ rows: [] }));

  await app.ready();
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${serverUrl}/#cost`, { waitUntil: "load" });

  const runtimeReady = await page
    .waitForFunction(
      () => {
        const w = window as never as { React?: unknown; Recharts?: unknown };
        return Boolean(w.React && w.Recharts);
      },
      null,
      { timeout: 30_000 },
    )
    .then(
      () => true,
      () => false,
    );
  assert.equal(
    runtimeReady,
    true,
    "page-level network prerequisite unmet — React/Recharts CDN runtime did not load",
  );

  // Render complete = the wave resolved: every tile has left its loading skeleton, so the
  // lane has had its inputs and an absent lane is a verdict rather than a pending state.
  await page.waitForSelector(".cost-screen .kpi", { timeout: 30_000 });
  await page.waitForFunction(
    (expected: number) => {
      const tiles = Array.from(document.querySelectorAll(".cost-screen .kpi"));
      return (
        tiles.length === expected &&
        tiles.every((t) => t.getAttribute("aria-busy") !== "true")
      );
    },
    KPI_TILE_COUNT,
    { timeout: 30_000 },
  );

  return { app, browser, page };
}

async function closeRenderContext(ctx: RenderContext | undefined): Promise<void> {
  await ctx?.browser?.close();
  await ctx?.app?.close();
}

// Card titles in document order — the screen's rendered tier sequence.
function getCardTitles(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".cost-screen .card-title")).map((el) =>
      (el.textContent || "").trim(),
    ),
  );
}

function countAlarmRows(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll('.cost-screen [role="alert"]').length,
  );
}

// Chart roots in the decision tier. A closed <details> keeps its children in the DOM and
// chromium still reports layout boxes for them, so the tier boundary — not visibility — is
// what separates the one decision chart from the instrumentation charts.
function countDecisionChartRoots(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      Array.from(document.querySelectorAll(".cost-screen .recharts-wrapper")).filter(
        (el) => el.closest("details.cost-disc") === null,
      ).length,
  );
}

describe("calm fixture — nothing is running hot", () => {
  let ctx: RenderContext;

  before(async () => {
    ctx = await openRenderContext(getFixture(1, 0));
  });

  after(async () => {
    await closeRenderContext(ctx);
  });

  test("the decision tier renders in priority order above the instrumentation tier", async () => {
    const titles = await getCardTitles(ctx.page);
    assert.deepStrictEqual(titles, [...DECISION_CARD_TITLES, ...DISCLOSURE_TITLES]);

    const kpiPrecedesFirstCard = await ctx.page.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll(".cost-screen .kpi"));
      const firstCard = document.querySelector(".cost-screen .card-title");
      if (tiles.length === 0 || firstCard === null) return false;
      const last = tiles[tiles.length - 1] as Element;
      return Boolean(
        last.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    assert.equal(
      kpiPrecedesFirstCard,
      true,
      "the four KPI tiles lead the screen — every card follows them",
    );
  });

  test("the instrumentation tier is three disclosures, all closed", async () => {
    const discs = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll(".cost-screen details.cost-disc")).map((el) => ({
        open: (el as HTMLDetailsElement).open,
        title: (el.querySelector(".card-title")?.textContent || "").trim(),
      })),
    );
    assert.deepStrictEqual(
      discs.map((d) => d.title),
      [...DISCLOSURE_TITLES],
    );
    assert.deepStrictEqual(
      discs.map((d) => d.open),
      discs.map(() => false),
      "instrumentation is a rare read — every disclosure starts closed",
    );
  });

  test("the alarm lane occupies no DOM when no trigger fires", async () => {
    assert.equal(await countAlarmRows(ctx.page), 0);
    const laneHeight = await ctx.page.evaluate(() => {
      const header = document.querySelector(".cost-screen .flex-shrink-0");
      const firstTile = document.querySelector(".cost-screen .kpi");
      if (header === null || firstTile === null) return -1;
      return firstTile.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
    });
    assert.ok(
      laneHeight >= 0 && laneHeight < 24,
      `a calm lane must cost no vertical band; measured ${laneHeight}px between header and tiles`,
    );
  });

  test("the decision tier draws exactly one chart root", async () => {
    assert.equal(
      await countDecisionChartRoots(ctx.page),
      1,
      "one trend chart — the band is a toggle on it, never a second drawing of the same series",
    );

    const strayRoots = await ctx.page.evaluate(
      () =>
        Array.from(document.querySelectorAll(".cost-screen .recharts-wrapper")).filter(
          (el) => el.closest("details.cost-disc") === null && el.closest(".card") === null,
        ).length,
    );
    assert.equal(strayRoots, 0, "every chart lives in a card or a disclosure");
  });
});

describe("hot fixture — today is running over the normal", () => {
  let ctx: RenderContext;

  before(async () => {
    // 3x the daily normal clears the 1.25x cut; the parse-error ratio clears its own.
    ctx = await openRenderContext(getFixture(3, 0.5));
  });

  after(async () => {
    await closeRenderContext(ctx);
  });

  test("the lane leads the screen with one row per fired trigger", async () => {
    await ctx.page.waitForSelector('.cost-screen [role="alert"]', { timeout: 30_000 });
    assert.equal(
      await countAlarmRows(ctx.page),
      2,
      "the hot row and the conditional parse-error row, and nothing else",
    );

    const lanePrecedesTiles = await ctx.page.evaluate(() => {
      const lastAlert = Array.from(
        document.querySelectorAll('.cost-screen [role="alert"]'),
      ).pop();
      const firstTile = document.querySelector(".cost-screen .kpi");
      if (lastAlert === undefined || firstTile === null) return false;
      return Boolean(
        lastAlert.compareDocumentPosition(firstTile) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    assert.equal(lanePrecedesTiles, true, "the lane leads — the tiles follow it");
  });

  test("a fired lane changes nothing about the tier order or the chart count", async () => {
    assert.deepStrictEqual(await getCardTitles(ctx.page), [
      ...DECISION_CARD_TITLES,
      ...DISCLOSURE_TITLES,
    ]);
    assert.equal(await countDecisionChartRoots(ctx.page), 1);
  });
});
