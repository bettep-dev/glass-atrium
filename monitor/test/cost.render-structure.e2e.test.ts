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

// The screen's own tier order, as the target composition states it: the Spend stat card, then the
// three decision cards, then the three instrumentation status cards.
const DECISION_CARD_TITLES = ["Spend", "Cost over time", "Cost by model", "Most expensive sessions"];
const DISCLOSURE_TITLES = ["Token volume", "Turn statistics", "Log integrity"];
const SPEND_STAT_COUNT = 4;
// the Spend region's row — the instrumentation cards carry stat rows of their own
const SPEND_STAT_ROW = "#cost-region-kpis .stat-row";
const SPEND_STAT_SELECTOR = `${SPEND_STAT_ROW} .stat`;
const LEDGER_MODELS = [
  "claude-opus-5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-fable-5",
  "claude-opus-4-8", "claude-haiku-4-5-20251001", "claude-sonnet-5-5", "unknown",
];
// The seven payloads the screen reads — the trend series lives under the dashboard namespace.
const COST_PAYLOAD_PREFIXES = ["/api/cost/", "/api/dashboard/cost-timeseries"];
// The type scale's floor: no chart label renders below it.
const META_FLOOR_PX = 13;

// A calm month of ordinary spend whose newest day sits inside its own band; 30 days crowd a 1024 axis.
const CALM_TREND_COSTS = Array.from({ length: 30 }, (_, i) => [11, 9, 10][i % 3]!);

interface CostFixture {
  kpi: Record<string, number>;
  trendCosts: readonly number[];
  parseErrorRatio: number;
  // every cost payload route answers 503 → a cold shared outage, nothing ever loaded
  isOutage?: boolean;
  // every by-model row carries tokens but no priced cost → the share bar yields to its footnote
  isLedgerUnpriced?: boolean;
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
  if (fixture.isOutage) {
    app.addHook("onRequest", async (request, reply) => {
      if (COST_PAYLOAD_PREFIXES.some((prefix) => request.url.startsWith(prefix))) await reply.code(503).send({ error: "unavailable" });
    });
  }

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
  app.get<{ Querystring: { prior_window?: string } }>("/api/dashboard/cost-timeseries", async (request) => ({
    days: trendRows.length,
    points: trendRows,
    timezone: "UTC",
    // the route's opt-in rule → a Cost fetch that drops prior_window=1 lays out no delta line
    ...(request.query.prior_window === "1" || request.query.prior_window === "true" ? {
      prior_window: {
        period_start: "2025-12-01", period_end: trendRows[0]?.date ?? "2026-01-01", cut_time: "12:00:00",
        input_tokens: 1_000, output_tokens: 1_000, cache_read_tokens: 10_000, cache_creation_tokens: 1_000, cost_usd: 1,
      },
    } : {}),
  }));
  // A month's real model spread: more models than the ledger's row budget, so it rolls up an Other foot.
  app.get("/api/cost/by-model", async () => ({
    rows: LEDGER_MODELS.map((model, i) => ({
      model,
      cost_usd: fixture.isLedgerUnpriced ? 0 : 80 - i * 8,
      session_count: 12,
      input_tokens: 10_000,
      output_tokens: 5000,
      cache_read_tokens: 40_000,
      cache_creation_tokens: 8000,
    })),
  }));
  app.get("/api/cost/cache-hit", async () => ({
    // Alternating days reach a whole 100% → the y-axis carries its widest label.
    rows: trendRows.map((r, i) => ({
      event_date: r.date,
      cache_hit_rate: i % 2 === 0 ? 1 : 0.9,
      total_cache_read: r.cache_read_tokens,
      total_input: r.input_tokens,
    })),
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

  if (fixture.isOutage) {
    await page.waitForSelector('.cost-screen [role="alert"]', { timeout: 30_000 });
    return { app, browser, page };
  }

  // Render complete = the wave resolved: the stat row has left its loading state, so the
  // lane has had its inputs and an absent lane is a verdict rather than a pending state.
  await page.waitForSelector(SPEND_STAT_SELECTOR, { timeout: 30_000 });
  await page.waitForFunction(
    ({ expected, selector }: { expected: number; selector: string }) =>
      document.querySelectorAll(selector).length === expected
      && document.querySelector('.cost-screen [aria-busy="true"] > .stat-row') === null,
    { expected: SPEND_STAT_COUNT, selector: SPEND_STAT_SELECTOR },
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

// Computed CSS colour → its rgb channels, alpha dropped: two marks share a tone when these match.
function getToneKey(color: string): string {
  const channels = color.match(/[\d.]+/g) ?? [];
  return channels.slice(0, 3).join(",");
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

    const statCardTitle = await ctx.page.evaluate(
      (selector) => (document.querySelector(selector)?.closest(".card")?.querySelector(".card-title")?.textContent || "").trim(),
      SPEND_STAT_SELECTOR,
    );
    assert.equal(statCardTitle, "Spend", "the four spend stats live in the leading Spend card");
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
      const firstCard = document.querySelector(".cost-screen .card");
      if (header === null || firstCard === null) return -1;
      return firstCard.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
    });
    assert.ok(
      laneHeight >= 0 && laneHeight < 24,
      `a calm lane must cost no vertical band; measured ${laneHeight}px between header and first card`,
    );
  });

  test("every cost table sits flush in its card, its edge cells carrying the card padding, in the house table face", async () => {
    const tables = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll(".cost-screen table.tbl")).map((table) => {
        const card = table.closest(".card")!;
        const cardBox = card.getBoundingClientRect();
        const border = parseFloat(getComputedStyle(card).borderLeftWidth);
        const tableBox = table.getBoundingClientRect();
        const firstCell = table.querySelector("tbody td")!;
        const lastCell = table.querySelector("tbody tr td:last-child")!;
        const head = getComputedStyle(table.querySelector("thead th")!);
        return {
          caption: (table.querySelector("caption")?.textContent || "").trim().slice(0, 32),
          inset: [Math.round(tableBox.left - cardBox.left - border), Math.round(cardBox.right - border - tableBox.right)],
          edge: [getComputedStyle(firstCell).paddingLeft, getComputedStyle(lastCell).paddingRight],
          headCase: head.textTransform,
          // the section labels and the turn aggregates inset themselves to the card padding
          contentInsets: Array.from(card.querySelectorAll(".section-label, dl"))
            .filter((el) => el.closest("thead, .card-head") === null)
            .map((el) => Math.round(el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft) - cardBox.left - border)),
        };
      }),
    );
    assert.equal(tables.length, 3, `the model ledger, the session list and the stop-reason table: ${JSON.stringify(tables)}`);
    for (const table of tables) {
      const label = JSON.stringify(table);
      assert.deepEqual(table.inset, [0, 0], `flush, never nested in a padded body — ${label}`);
      assert.deepEqual(table.edge, ["16px", "16px"], `edge cells line up with the card head — ${label}`);
      assert.equal(table.headCase, "none", `headers keep sentence case — ${label}`);
      assert.ok(table.contentInsets.every((x) => x === 16), `content beside the table keeps the card padding — ${label}`);
    }
  });

  test("the ledger Total row carries no session count — per-model counts do not sum", async () => {
    const totalCells = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll(".cost-screen table.tbl tfoot :is(th, td)")).map((cell) =>
        (cell.textContent || "").trim(),
      ),
    );
    assert.strictEqual(totalCells[0], "Total");
    assert.deepStrictEqual(totalCells.slice(2), ["None", "None"]);
  });

  for (const width of [1440, 1024]) {
    test(`at ${width}px the by-model head sticks to the viewport top after a page scroll`, async () => {
      await ctx.page.setViewportSize({ width, height: 900 });
      const SCROLL_INTO_TABLE_PX = 80;
      const measured = await ctx.page.evaluate((scrollIntoPx) => {
        const table = Array.from(document.querySelectorAll(".cost-screen table.tbl"))
          .find((t) => (t.querySelector("caption")?.textContent || "").startsWith("Cost by model"));
        const head = table?.querySelector("thead th") as HTMLElement | undefined;
        if (!table || !head) return null;
        window.scrollTo(0, 0);
        const headStartPx = head.getBoundingClientRect().top;
        const headHeightPx = head.getBoundingClientRect().height;
        const tableHeightPx = table.getBoundingClientRect().height;
        // the page must scroll past the head's start, and the table must outlast the scroll, or a non-sticky head passes too
        const pageRoomPx = document.documentElement.scrollHeight - window.innerHeight - headStartPx;
        const precondition = { canPageScroll: pageRoomPx > scrollIntoPx, isTableTaller: tableHeightPx - headHeightPx > scrollIntoPx };
        window.scrollTo(0, headStartPx + scrollIntoPx);
        const offsetPx = head.getBoundingClientRect().top;
        window.scrollTo(0, 0);
        return { precondition, offsetPx };
      }, SCROLL_INTO_TABLE_PX);
      await ctx.page.setViewportSize({ width: 1440, height: 900 });
      assert.ok(measured, "the by-model ledger renders a column head");
      assert.deepEqual(measured.precondition, { canPageScroll: true, isTableTaller: true });
      assert.ok(Math.abs(measured.offsetPx) <= 1, `head ${measured.offsetPx}px off the viewport top`);
    });
  }

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

  test("no page verdict and no window tag — each ranged stat names its window in its label", async () => {
    const shape = await ctx.page.evaluate((row) => ({
      verdicts: document.querySelectorAll(".cost-screen .page-verdict").length,
      windowTags: document.querySelectorAll(".cost-screen .kpi-window").length,
      labels: Array.from(document.querySelectorAll(`${row} .stat-label`))
        .map((el) => (el.textContent || "").trim()),
    }), SPEND_STAT_ROW);
    assert.equal(shape.verdicts, 0, "spend state rides the stat and the alarm lane, not a verdict line");
    assert.equal(shape.windowTags, 0, "the window is part of the label, never a separate tag");
    assert.equal(shape.labels.length, SPEND_STAT_COUNT);
    assert.equal(
      shape.labels.filter((label) => /, last \d+ days$/.test(label)).length,
      2,
      `the cost and the cache-share stats follow the range: ${shape.labels.join(" | ")}`,
    );
  });

  test("the stats compare with the prior window the screen opts into", async () => {
    const contexts = await ctx.page.evaluate((row) =>
      Array.from(document.querySelectorAll(`${row} .stat-context`)).map((el) => (el.textContent || "").trim()),
    SPEND_STAT_ROW);
    assert.ok(contexts.some((text) => /cut at this time of day/.test(text)), "a measured delta line renders");
    assert.ok(!contexts.some((text) => /did not arrive/.test(text)), "no stat reads the prior window as missing");
  });

  test("each card pair splits from the narrowest width its content fits and stacks below it", async () => {
    const pairs = [
      ["Cost by model", "Most expensive sessions"],
      ["Turn statistics", "Log integrity"],
    ] as const;
    // the session table's fixed-width cells outgrow a half of the lg column → that pair waits for xl
    const rows = [
      { width: 1440, isShared: [true, true] },
      { width: 1024, isShared: [false, true] },
      { width: 960, isShared: [false, false] },
    ];
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
      for (const row of rows) {
        await ctx.page.setViewportSize({ width: row.width, height: 768 });
        for (const [i, gap] of (await measure()).entries()) {
          const layout = row.isShared[i] ? "share one row" : "stack";
          const isMatch = row.isShared[i] ? Math.abs(gap) < 1 : gap > 0;
          assert.ok(isMatch, `${pairs[i]!.join(" | ")} ${layout} at ${row.width}; top gap ${gap}px`);
        }
      }
    } finally {
      await ctx.page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("peer cards in a pair end at the same edge wherever the pair shares a row", async () => {
    const pairs = [
      { titles: ["Cost by model", "Most expensive sessions"], widths: [1440, 1920] },
      { titles: ["Turn statistics", "Log integrity"], widths: [1024, 1440, 1920] },
    ];
    try {
      for (const { titles, widths } of pairs) {
        for (const width of widths) {
          await ctx.page.setViewportSize({ width, height: 900 });
          const bottoms = await ctx.page.evaluate(({ names, selector }) => {
            const titleEls = Array.from(document.querySelectorAll(selector));
            return names.map((name) => titleEls
              .find((t) => (t.textContent || "").trim() === name)?.closest(".card")?.getBoundingClientRect().bottom ?? Number.NaN);
          }, { names: titles, selector: CARD_TITLE_SELECTOR });
          const spread = Math.abs(bottoms[0]! - bottoms[1]!);
          assert.ok(spread < 1, `${titles.join(" | ")} at ${width}: bottoms ${bottoms.map(Math.round).join(" | ")}`);
        }
      }
    } finally {
      await ctx.page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("the instrumentation pair keeps one 2:1 split from lg up", async () => {
    try {
      for (const width of [1024, 1440]) {
        await ctx.page.setViewportSize({ width, height: 900 });
        const columns = await ctx.page.evaluate((selector) => {
          const title = Array.from(document.querySelectorAll(selector))
            .find((t) => (t.textContent || "").trim() === "Turn statistics");
          const row = title?.closest(".split-row");
          return row ? Array.from(row.children).map((col) => col.getBoundingClientRect().width) : [];
        }, CARD_TITLE_SELECTOR);
        assert.equal(columns.length, 2, `two columns at ${width}`);
        assert.ok(Math.abs(columns[0]! / columns[1]! - 2) < 0.02, `columns ${columns.map(Math.round).join(" | ")} at ${width}`);
      }
    } finally {
      await ctx.page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("no chart label renders below the meta floor", async () => {
    const sizes = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll(".cost-screen .recharts-wrapper text"))
        .filter((t) => (t.textContent || "").trim() !== "")
        .map((t) => ({ text: (t.textContent || "").trim(), px: parseFloat(getComputedStyle(t).fontSize) })),
    );
    assert.ok(sizes.length > 0, "the screen draws chart labels");
    const small = sizes.filter((s) => s.px < META_FLOOR_PX);
    assert.deepEqual(small, [], `${small.length} of ${sizes.length} chart labels below ${META_FLOOR_PX}px`);
  });

  test("x-axis labels on every chart keep the minimum gap and stay over the plot at 1024", async () => {
    try {
      await ctx.page.setViewportSize({ width: 1024, height: 768 });
      const faults = await ctx.page.evaluate(() => {
        const minGap = (window as never as { UI: { CHART_TICK_MIN_GAP_PX: number } }).UI.CHART_TICK_MIN_GAP_PX;
        return Array.from(document.querySelectorAll(".cost-screen .recharts-xAxis")).flatMap((axis) => {
          const plot = axis.querySelector(".recharts-cartesian-axis-line")!.getBoundingClientRect();
          const boxes = Array.from(axis.querySelectorAll(".recharts-cartesian-axis-tick text"))
            .map((t) => ({ label: (t.textContent || "").trim(), box: t.getBoundingClientRect() }))
            .filter((t) => t.box.width > 0)
            .sort((l, r) => l.box.left - r.box.left);
          const crowded = boxes.slice(1).flatMap((t, i) => {
            const gap = t.box.left - boxes[i]!.box.right;
            return gap < minGap ? [`${boxes[i]!.label}→${t.label} ${gap.toFixed(1)}px`] : [];
          });
          // 0.5px: subpixel text metrics at the plot edge
          const spilled = boxes.flatMap((t) => (t.box.left < plot.left - 0.5 || t.box.right > plot.right + 0.5 ? [`${t.label} past the plot`] : []));
          return [...crowded, ...spilled];
        });
      });
      assert.deepStrictEqual(faults, [], `x-axis label faults: ${faults.slice(0, 4).join(" · ")}`);
    } finally {
      await ctx.page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("the cache-hit line draws in the tone of the cache-read category it measures", async () => {
    const tones = await ctx.page.evaluate((selector) => {
      const title = Array.from(document.querySelectorAll(selector))
        .find((t) => (t.textContent || "").trim() === "Token volume");
      const card = title?.closest(".cost-inst");
      const line = card?.querySelector(".recharts-line-curve");
      // the share row's entry: swatch first, then its label text
      const swatch = Array.from(card?.querySelectorAll('span > span[style*="background"]:first-child') ?? [])
        .find((el) => (el.parentElement?.textContent || "").trim().startsWith("Cache read"));
      return {
        line: line ? getComputedStyle(line).stroke : "",
        category: swatch ? getComputedStyle(swatch).backgroundColor : "",
      };
    }, CARD_TITLE_SELECTOR);
    assert.ok(tones.line && tones.category, `both marks render (line ${tones.line} · swatch ${tones.category})`);
    assert.equal(getToneKey(tones.line), getToneKey(tones.category));
  });

  test("the hit-rate axis labels the 100% its clamped domain reaches", async () => {
    const labels = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll("#cost-region-cache .recharts-yAxis .recharts-cartesian-axis-tick text"))
        .map((t) => (t.textContent || "").trim()),
    );
    // alternating 100% / 90% days → domain [88.5, 100], wide enough for whole-percent labels
    assert.strictEqual(labels.at(-1), "100%", `y-axis labels: ${labels.join(" ")}`);
  });

  test("no card content reaches past its own card's edges at lg and xl", async () => {
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
      for (const width of [1440, 1280, 1024]) {
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

    const lanePrecedesStats = await ctx.page.evaluate((row) => {
      const lastAlert = Array.from(
        document.querySelectorAll('.cost-screen [role="alert"]'),
      ).pop();
      const statRow = document.querySelector(row);
      if (lastAlert === undefined || statRow === null) return false;
      return Boolean(
        lastAlert.compareDocumentPosition(statRow) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }, SPEND_STAT_ROW);
    assert.equal(lanePrecedesStats, true, "the lane leads — the spend stats follow it");
  });

  test("the log-integrity threshold is a faint reference line and only the day over it takes the crit tone", async () => {
    const tones = await ctx.page.evaluate((selector) => {
      const title = Array.from(document.querySelectorAll(selector))
        .find((t) => (t.textContent || "").trim() === "Log integrity");
      const card = title?.closest(".cost-inst");
      const line = card?.querySelector(".recharts-line-curve");
      const bar = card?.querySelector(".recharts-bar-rectangle path");
      const root = getComputedStyle(document.documentElement);
      return {
        line: line ? getComputedStyle(line).stroke : "", bar: bar ? getComputedStyle(bar).fill : "",
        faint: root.getPropertyValue("--faint").trim(), crit: root.getPropertyValue("--crit").trim(),
      };
    }, CARD_TITLE_SELECTOR);
    assert.ok(tones.line && tones.bar, `both marks render (line ${tones.line} · bar ${tones.bar})`);
    assert.equal(getToneKey(tones.line), getToneKey(tones.faint), "a reference line, never a series or severity colour");
    assert.equal(getToneKey(tones.bar), getToneKey(tones.crit), "the day over the threshold is the one mark that takes a tone");
  });

  test("a fired lane changes nothing about the tier order or the chart count", async () => {
    assert.deepStrictEqual(await getCardTitles(ctx.page), [
      ...DECISION_CARD_TITLES,
      ...DISCLOSURE_TITLES,
    ]);
    assert.equal(await countDecisionChartRoots(ctx.page), 1);
  });
});

describe("cold outage — every cost payload fails before any has loaded", () => {
  let ctx: RenderContext;

  before(async () => {
    ctx = await openRenderContext({ ...getFixture(1, 0), isOutage: true });
  });

  after(async () => {
    await closeRenderContext(ctx);
  });

  test("one banner speaks for every region, each left as a quiet covered slot with no Retry of its own", async () => {
    const regionCount = 8; // kpis · trend · models · sessions · tokens · cache · turns · log
    const settled = await ctx.page
      .waitForFunction(
        (expected: number) => document.querySelectorAll(".cost-screen [data-covered-card-id]").length === expected,
        regionCount,
        { timeout: 30_000 },
      )
      .then(() => true, () => false);
    const counts = await ctx.page.evaluate(() => ({
      banners: document.querySelectorAll('.cost-screen [role="alert"]').length,
      covered: Array.from(document.querySelectorAll(".cost-screen [data-covered-card-id]"))
        .map((el) => el.getAttribute("data-covered-card-id")),
      retries: Array.from(document.querySelectorAll(".cost-screen button"))
        .filter((b) => /retry/i.test(b.textContent || "")).length,
    }));
    assert.ok(settled, `covered slots: ${counts.covered.join(", ")}`);
    assert.equal(counts.banners, 1);
    assert.equal(counts.retries, 1, "the banner's Retry is the only one");
  });
});

describe("unpriced ledger — the models carry tokens but no priced cost", () => {
  let ctx: RenderContext;

  before(async () => {
    ctx = await openRenderContext({ ...getFixture(1, 0), isLedgerUnpriced: true });
  });

  after(async () => {
    await closeRenderContext(ctx);
  });

  test("the category footnote stands in for the share bar and keeps the card padding beside the flush ledger", async () => {
    await ctx.page.waitForSelector('.cost-screen .card [role="note"]', { timeout: 30_000 });
    const notes = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll('.cost-screen .card [role="note"]')).flatMap((note) => {
        const card = note.closest(".card");
        if (card === null || card.querySelector("table.tbl") === null) return [];
        const cardLeft = card.getBoundingClientRect().left + parseFloat(getComputedStyle(card).borderLeftWidth);
        return [{
          text: (note.textContent || "").trim(),
          inset: Math.round(note.getBoundingClientRect().left + parseFloat(getComputedStyle(note).paddingLeft) - cardLeft),
          hasShareBar: card.querySelector('[role="img"]') !== null,
        }];
      }),
    );
    assert.equal(notes.length, 1, `one footnote, in the model ledger card: ${JSON.stringify(notes)}`);
    assert.match(notes[0]!.text, /^No priced token cost in this window/);
    assert.equal(notes[0]!.hasShareBar, false, "the footnote replaces the share bar, never sits beside it");
    assert.equal(notes[0]!.inset, 16, "the footnote insets to the card padding like the section labels");
  });
});
