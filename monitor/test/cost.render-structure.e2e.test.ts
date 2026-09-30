// E2E chromium STRUCTURE harness for the cost screen (screens/cost.jsx): DOM-structure facts
// only — tier order, the alarm lane's presence, one decision-tier chart root — over two render
// contexts (calm · hot), since one context can only measure one side of the lane. Values behind
// those structures are pinned in cost.client.unit.test.ts.
//
// Runner: npx tsx --test test/cost.render-structure.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify serving the seven cost payloads; registerCostRoutes stays out, its
// Prisma-backed output would make a structure assertion a data assertion.

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
// three decision cards, then the three instrumentation status cards.
const DECISION_CARD_TITLES = ["Cost over time", "Cost by model", "Most expensive sessions"];
const DISCLOSURE_TITLES = ["Token volume", "Turn statistics", "Log integrity"];
const KPI_TILE_COUNT = 4;
const LEDGER_MODELS = [
  "claude-opus-5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-fable-5",
  "claude-opus-4-8", "claude-haiku-4-5-20251001", "claude-sonnet-5-5", "unknown",
];
// Two columns "end near the same height": less than one table row of dead space under the shorter.
const DECISION_SPLIT_MAX_SLACK_PX = 48;

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
    date: getDayKey(i),
    cost_usd: cost,
    session_count: 3,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 4000,
    cache_creation_tokens: 800,
  }));

  app.get("/api/cost/kpi", async () => fixture.kpi);
  app.get("/api/dashboard/cost-timeseries", async () => ({
    days: trendRows.length,
    points: trendRows,
    timezone: "UTC",
  }));
  // A month's real model spread: more models than the ledger's top five, so it rolls up an Other row.
  app.get("/api/cost/by-model", async () => ({
    rows: LEDGER_MODELS.map((model, i) => ({
      model,
      cost_usd: 80 - i * 8,
      session_count: 12,
      input_tokens: 10_000,
      output_tokens: 5000,
      cache_read_tokens: 40_000,
      cache_creation_tokens: 8000,
    })),
  }));
  app.get("/api/cost/cache-hit", async () => ({
    rows: trendRows.map((r) => ({ day: r.date, cache_hit_ratio: 0.8 })),
  }));
  app.get("/api/cost/session-distribution", async () => ({
    // A month holds hundreds of sessions → the table always shows its full top rows plus Other.
    rows: Array.from({ length: 40 }, (_, i) => ({
      session_id: `session-${i}`,
      total_cost_usd: 40 - i,
      agent: "glass-atrium-dev-react",
      started_at: getDayKey(i % 10),
    })),
    total_session_count: 40,
    truncated: false,
  }));
  app.get("/api/cost/parse-errors", async () => ({
    rows: trendRows.map((r) => ({
      day: r.date,
      error_ratio: fixture.parseErrorRatio,
      error_count: 1,
      total_count: 100,
    })),
  }));
  // Every stop reason with its described label → the table at its widest real content.
  app.get("/api/cost/turn-stats", async () => ({
    stop_reasons: [
      { stop_reason: "no_assistant_in_turn", event_count: 12840, session_count: 412 },
      { stop_reason: "end_turn", event_count: 9310, session_count: 560 },
      { stop_reason: "tool_use", event_count: 1204, session_count: 188 },
      { stop_reason: "unknown", event_count: 96, session_count: 31 },
    ],
    stop_reason_session_count: 582,
    turns: {
      total_turns: 23450, avg_turns: 4, max_turns: 212,
      avg_turns_per_session: 91.25, turn_session_count: 257,
    },
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

// Plain card titles + Disclosure header titles — coupled to the Disclosure atom's markup (ui.jsx)
const CARD_TITLE_SELECTOR = ".cost-screen .card-title, .cost-screen .cost-inst > h3 .font-medium";

// Card titles in document order — the screen's rendered tier sequence.
function getCardTitles(page: Page): Promise<string[]> {
  return page.evaluate(
    (selector) =>
      Array.from(document.querySelectorAll(selector)).map((el) => (el.textContent || "").trim()),
    CARD_TITLE_SELECTOR,
  );
}

function countAlarmRows(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll('.cost-screen [role="alert"]').length,
  );
}

// Chart roots in the decision tier. The instrumentation cards render open, so the tier
// boundary is what separates the one decision chart from the instrumentation charts.
function countDecisionChartRoots(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      Array.from(document.querySelectorAll(".cost-screen .recharts-wrapper")).filter(
        (el) => el.closest(".cost-inst") === null,
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

  test("the instrumentation tier is three status cards, all open", async () => {
    const discs = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll(".cost-screen .cost-inst")).map((el) => ({
        open: el.querySelector("h3 [aria-expanded]")?.getAttribute("aria-expanded") === "true",
        title: (el.querySelector("h3 .font-medium")?.textContent || "").trim(),
      })),
    );
    assert.deepStrictEqual(
      discs.map((d) => d.title),
      [...DISCLOSURE_TITLES],
    );
    assert.deepStrictEqual(
      discs.map((d) => d.open),
      discs.map(() => true),
      "instrumentation is a status summary — every card starts open",
    );
  });

  test("the alarm lane occupies no DOM when no trigger fires", async () => {
    assert.equal(await countAlarmRows(ctx.page), 0);
    const laneHeight = await ctx.page.evaluate(() => {
      const header = document.querySelector(".cost-screen .flex-shrink-0");
      const verdict = document.querySelector(".cost-screen .page-verdict");
      if (header === null || verdict === null) return -1;
      return verdict.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
    });
    assert.ok(
      laneHeight >= 0 && laneHeight < 24,
      `a calm lane must cost no vertical band; measured ${laneHeight}px between header and verdict`,
    );
  });

  test("the ledger Total row carries no session count — per-model counts do not sum", async () => {
    const totalCells = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll(".cost-screen .cost-tbl tfoot td")).map((td) =>
        (td.textContent || "").trim(),
      ),
    );
    assert.strictEqual(totalCells[0], "Total");
    assert.deepStrictEqual(totalCells.slice(2), ["—", "—"]);
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
          (el) => el.closest(".card") === null,
        ).length,
    );
    assert.equal(strayRoots, 0, "every chart lives in a card");
  });

  test("one verdict line precedes the tiles, and every tile carries its window tag", async () => {
    const shape = await ctx.page.evaluate(() => {
      const verdicts = document.querySelectorAll(".cost-screen .page-verdict");
      const firstTile = document.querySelector(".cost-screen .kpi");
      const tags = Array.from(document.querySelectorAll(".cost-screen .kpi")).map((tile) =>
        Array.from(tile.querySelectorAll(".kpi-window")).map((t) => (t.textContent || "").trim()),
      );
      const leads = verdicts.length === 1 && firstTile !== null
        && Boolean(verdicts[0]!.compareDocumentPosition(firstTile) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { count: verdicts.length, leads, tags };
    });
    assert.equal(shape.count, 1, "one spend verdict per page");
    assert.equal(shape.leads, true, "the verdict reads before the tiles");
    assert.equal(shape.tags.length, KPI_TILE_COUNT);
    for (const tags of shape.tags) {
      assert.equal(tags.length, 1, "each tile names its window exactly once");
      assert.ok(tags[0]!.length > 0, "a window tag is never blank");
    }
  });

  test("paired cards sit side by side at xl and stack below it", async () => {
    const pairs = [
      ["Cost by model", "Most expensive sessions"],
      ["Turn statistics", "Log integrity"],
    ] as const;
    const measure = () =>
      ctx.page.evaluate(({ names, selector }) => {
        const titleEls = Array.from(document.querySelectorAll(selector));
        // no named inner function — the tsx transform wraps one in a helper the page does not define
        const tops = new Map(
          titleEls.map((t) => [(t.textContent || "").trim(), t.closest(".card")?.getBoundingClientRect().top]),
        );
        return names.map(([left, right]) => (tops.get(right) ?? Number.NaN) - (tops.get(left) ?? Number.NaN));
      }, { names: pairs.map((p) => [...p]), selector: CARD_TITLE_SELECTOR });
    try {
      for (const [i, gap] of (await measure()).entries()) {
        assert.ok(Math.abs(gap) < 1, `${pairs[i]!.join(" | ")} share one row at 1440; top gap ${gap}px`);
      }
      await ctx.page.setViewportSize({ width: 1024, height: 768 });
      for (const [i, gap] of (await measure()).entries()) {
        assert.ok(gap > 0, `${pairs[i]!.join(" | ")} stack at 1024; top gap ${gap}px`);
      }
    } finally {
      await ctx.page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("the decision split's two columns end near the same height at 1440", async () => {
    const columnBottoms = await ctx.page.evaluate((selector) => {
      const title = Array.from(document.querySelectorAll(selector))
        .find((t) => (t.textContent || "").trim() === "Cost by model");
      const row = title?.closest(".split-row");
      if (!row) return [];
      return Array.from(row.children).map((col) => {
        const cards = Array.from(col.querySelectorAll(".card"));
        return Math.max(...cards.map((c) => c.getBoundingClientRect().bottom));
      });
    }, CARD_TITLE_SELECTOR);
    assert.equal(columnBottoms.length, 2, "the decision split holds two columns");
    const slack = Math.abs(columnBottoms[0]! - columnBottoms[1]!);
    assert.ok(slack <= DECISION_SPLIT_MAX_SLACK_PX,
      `empty space under the shorter column is ${Math.round(slack)}px (bottoms ${columnBottoms.map(Math.round).join(" | ")})`);
  });

  test("no card content reaches past its own card's edges at xl", async () => {
    const measureOverflow = () =>
      ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll(".cost-screen .card")).flatMap((card) => {
          const box = card.getBoundingClientRect();
          return Array.from(card.querySelectorAll("*"))
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1))
            .map(({ el, r }) => `${el.tagName.toLowerCase()} [${Math.round(r.left)}, ${Math.round(r.right)}] outside card [${Math.round(box.left)}, ${Math.round(box.right)}]`);
        }),
      );
    try {
      for (const width of [1440, 1280]) {
        await ctx.page.setViewportSize({ width, height: 900 });
        const overflow = await measureOverflow();
        assert.deepStrictEqual(overflow, [], `at ${width}: ${overflow.slice(0, 3).join(" · ")}`);
      }
    } finally {
      await ctx.page.setViewportSize({ width: 1440, height: 900 });
    }
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
