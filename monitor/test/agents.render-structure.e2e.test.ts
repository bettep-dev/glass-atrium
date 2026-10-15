// E2E chromium harness for the agents screen (screens/agents.jsx): painted facts a node render
// cannot hold — focus rings inside clipping scrollers, the review-flag chart's height, the
// task-type matrix fitting its card at 1440, and the ring after a keyboard Retry.
//
// Runner: npx tsx --test test/agents.render-structure.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify serving the row payloads below; every other /api read answers empty.

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
const AGENT_NAMES = ["dev-react", "dev-shell", "dev-db"];
const TASK_TYPES = ["bug-fix", "feature", "refactor", "research", "plan", "review", "diagnosis", "doc", "cleanup"];
const MATRIX_SELECTOR = '[aria-label^="Success rate per agent"]';
// More lifecycle agents than the S slot holds → the no-record card has a remainder to roll up.
const LIFECYCLE_AGENTS = ["dev-react", "dev-shell", "dev-db", "dev-node", "dev-python", "dev-front", "dev-swift", "dev-rag"];
const PAIRED_CARD_IDS = ["agents-failing-pairs", "agents-lifecycle"];
// One list row: more empty body than this under a card's last row is a half-empty card.
const ROW_PX = 40;
// The type scale's floor: no chart label renders below it.
const META_FLOOR_PX = 13;

const ROW_TABLES = [
  { name: "ledger", selector: ".agent-table-minibars tr[data-roving-row]" },
  { name: "lifecycle", selector: "#agents-lifecycle tr[data-roving-row]" },
];

interface RenderContext {
  app: FastifyInstance;
  browser: Browser;
  page: Page;
}

interface RingEdges {
  left: boolean;
  right: boolean;
}

// summary answers 500 while set — the cold-error page a Retry recovers from
const summaryOutage = { isOn: false };

// every pair filled, one agent at a low sample → the widest cell text in every column
function getSuccessRateRows() {
  return AGENT_NAMES.flatMap((name, index) => TASK_TYPES.map((task_type) => {
    const total = index === 0 ? 3 : 140;
    const failure = index === 2 ? 70 : 1;
    return {
      agent: `glass-atrium-${name}`, task_type, event_date: "2026-09-24", total_count: total,
      success_count: total - failure, failure_count: failure, reconstructed_count: 0, success_rate: (total - failure) / total,
    };
  }));
}

// 30 days → enough labels to crowd the x-axis at 1024
function getReviewFlagRows() {
  const lastDay = Date.UTC(2026, 8, 24);
  return Array.from({ length: 30 }, (_, index) => {
    const event_date = new Date(lastDay - (29 - index) * 86_400_000).toISOString().slice(0, 10);
    const flagged = (index % 5) + 1;
    return {
      event_date, total_count: 20, review_flagged_count: flagged, empty_metric_count: flagged - 1, polar_mismatch_count: 1,
      review_flag_ratio: flagged / 20, empty_metric_ratio: (flagged - 1) / 20,
    };
  });
}

async function openRenderContext(width = 1024): Promise<RenderContext> {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });

  app.get("/api/agents/summary", async (_request, reply) => {
    if (summaryOutage.isOn) return reply.code(500).send({ error: "summary read failed" });
    return {
      agents: AGENT_NAMES.map((name) => ({
        agent_id: `glass-atrium-${name}`, agent_name: name, status: "active", success_pct: 92, runs: 40, needs_context_count: 2,
      })),
      meta: { total_agents: AGENT_NAMES.length },
    };
  });
  app.get("/api/agents/success-rate", async () => ({ rows: getSuccessRateRows() }));
  app.get("/api/agents/review-flag-timeseries", async () => ({ rows: getReviewFlagRows() }));
  app.get("/api/agents/lifecycle-stats", async () => ({
    rows: LIFECYCLE_AGENTS.map((agent_type) => ({ agent_type, start_count: 4, stop_count: 4, completed_count: 3, p95_duration_sec: 60 })),
  }));
  app.get("/api/*", async () => ({ rows: [] }));

  await app.ready();
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${serverUrl}/#agents`, { waitUntil: "load" });

  for (const table of ROW_TABLES) {
    await page.waitForSelector(table.selector, { timeout: 30_000 });
  }
  return { app, browser, page };
}

async function closeRenderContext(ctx: RenderContext | undefined): Promise<void> {
  await ctx?.browser?.close();
  await ctx?.app?.close();
}

// Keyboard modality first, so the row matches :focus-visible exactly as a Tab user sees it.
async function focusRowByKeyboard(page: Page, selector: string): Promise<void> {
  const row = page.locator(selector).first();
  await row.scrollIntoViewIfNeeded();
  await page.keyboard.press("Shift");
  await row.focus();
}

// Paint check: the 2px strips just inside the scroller's left and right clip edges, at the
// row's vertical middle, compared against the resolved focus-ring token colour.
async function getRingEdges(page: Page, selector: string): Promise<RingEdges> {
  const box = await page.locator(selector).first().evaluate((row) => {
    let scroller = row.parentElement;
    while (scroller && !/(auto|hidden|scroll)/.test(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
    const rowRect = row.getBoundingClientRect();
    const clipRect = (scroller ?? row).getBoundingClientRect();
    const left = Math.max(rowRect.left, clipRect.left);
    const right = Math.min(rowRect.right, clipRect.right);
    return { x: Math.ceil(left), y: Math.round(rowRect.top + rowRect.height / 2), width: Math.floor(right - Math.ceil(left)) };
  });
  const hits = await getRingHits(page, box);

  return { left: hits.slice(0, 3).some(Boolean), right: hits.slice(-3).some(Boolean) };
}

// One screen row of pixels → which of them carry the resolved focus-ring token colour.
async function getRingHits(page: Page, box: { x: number; y: number; width: number }): Promise<boolean[]> {
  const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: 1 } });

  return page.evaluate(async (b64) => {
    const probe = document.createElement("span");
    probe.style.color = "rgb(var(--focus-ring))";
    document.body.append(probe);
    const ring = getComputedStyle(probe).color.match(/\d+/g)!.map(Number);
    probe.remove();

    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    // anonymous callbacks only: tsx wraps a named const in a __name() helper the page lacks
    return Array.from({ length: img.width }, (_, x) => {
      const [r, g, b] = ctx.getImageData(x, 0, 1, 1).data;
      return Math.abs(r - ring[0]) + Math.abs(g - ring[1]) + Math.abs(b - ring[2]) < 24;
    });
  }, png.toString("base64"));
}

// The row through the focused element's middle, spanning its left outline band → ring painted there or not.
async function getFocusedRingBox(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
    const y = Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 2));
    return {
      name: `${el.tagName.toLowerCase()}#${el.id}`,
      box: { x: Math.max(0, Math.floor(rect.left - reach - 1)), y, width: Math.ceil(reach) + 3 },
    };
  });
}

async function openTaskTypeFold(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /By task type/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.waitForSelector(MATRIX_SELECTOR, { timeout: 30_000 });
}

describe("agents screen at 1024px", () => {
  let ctx: RenderContext;

  before(async () => {
    ctx = await openRenderContext();
  });

  after(() => closeRenderContext(ctx));

  for (const table of ROW_TABLES) {
    test(`a keyboard-focused ${table.name} row paints its focus ring on both sides inside its scroller`, async () => {
      await focusRowByKeyboard(ctx.page, table.selector);

      assert.deepEqual(await getRingEdges(ctx.page, table.selector), { left: true, right: true });
    });
  }
});

describe("agents screen at 1024px, charts and Retry", () => {
  let ctx: RenderContext;

  before(async () => {
    ctx = await openRenderContext();
  });

  after(async () => {
    summaryOutage.isOn = false;
    await closeRenderContext(ctx);
  });

  test("the review-flag chart draws at a readable height inside its open fold", async () => {
    const chart = ctx.page.locator("#agents-review-flags [role=img]").first();
    await chart.scrollIntoViewIfNeeded();

    assert.ok(((await chart.boundingBox())?.height ?? 0) >= 160);
  });

  test("the review-flag x-axis keeps the first and last day, the minimum label gap, and every label over the plot", async () => {
    await ctx.page.locator("#agents-review-flags .recharts-xAxis").first().scrollIntoViewIfNeeded();
    const axis = await ctx.page.evaluate(() => {
      const minGap = (window as never as { UI: { CHART_TICK_MIN_GAP_PX: number } }).UI.CHART_TICK_MIN_GAP_PX;
      const root = document.querySelector("#agents-review-flags .recharts-xAxis")!;
      const plot = root.querySelector(".recharts-cartesian-axis-line")!.getBoundingClientRect();
      const boxes = Array.from(root.querySelectorAll(".recharts-cartesian-axis-tick text"))
        .map((t) => ({ label: (t.textContent || "").trim(), box: t.getBoundingClientRect() }))
        .filter((t) => t.box.width > 0)
        .sort((l, r) => l.box.left - r.box.left);
      const crowded = boxes.slice(1).flatMap((t, i) => {
        const gap = t.box.left - boxes[i]!.box.right;
        return gap < minGap ? [`${boxes[i]!.label}→${t.label} ${gap.toFixed(1)}px`] : [];
      });
      // 0.5px: subpixel text metrics at the plot edge
      const spilled = boxes.flatMap((t) => (t.box.left < plot.left - 0.5 || t.box.right > plot.right + 0.5 ? [`${t.label} past the plot`] : []));
      return { ends: [boxes[0]?.label, boxes.at(-1)?.label], faults: [...crowded, ...spilled] };
    });

    assert.deepStrictEqual(axis.ends, ["08-26", "09-24"], "first and last day stay labelled");
    assert.deepStrictEqual(axis.faults, [], `x-axis label faults: ${axis.faults.slice(0, 4).join(" · ")}`);
  });

  test("a keyboard Retry that recovers the page leaves a painted focus ring on the element it focuses", async () => {
    summaryOutage.isOn = true;
    await ctx.page.reload({ waitUntil: "load" });
    const retry = ctx.page.getByRole("button", { name: "Retry" }).first();
    await retry.waitFor({ timeout: 30_000 });
    summaryOutage.isOn = false;

    await ctx.page.keyboard.press("Shift");
    await retry.focus();
    await ctx.page.keyboard.press("Enter");
    await ctx.page.waitForSelector(ROW_TABLES[0].selector, { timeout: 30_000 });
    const { name, box } = await getFocusedRingBox(ctx.page);

    assert.ok((await getRingHits(ctx.page, box)).some(Boolean), `no ring painted beside ${name}`);
  });
});

// Each paired card: its bottom edge, and the empty body under its last table row.
async function getPairedCardFill(page: Page) {
  return page.evaluate((ids) => ids.map((id) => {
    const card = document.getElementById(id)!.querySelector(".card") ?? document.getElementById(id)!;
    const body = card.querySelector(".card-body")!;
    const lastRow = Array.from(card.querySelectorAll("tbody tr")).at(-1)!;
    return { id, bottom: card.getBoundingClientRect().bottom, slack: body.getBoundingClientRect().bottom - lastRow.getBoundingClientRect().bottom };
  }), PAIRED_CARD_IDS);
}

describe("agents screen at 1440px", () => {
  let ctx: RenderContext;

  before(async () => {
    ctx = await openRenderContext(1440);
  });

  after(() => closeRenderContext(ctx));

  test("the failing-pairs and no-record cards end at one edge with no half-empty body wherever they share a row", async () => {
    try {
      for (const width of [1440, 1920]) {
        await ctx.page.setViewportSize({ width, height: 900 });
        const cards = await getPairedCardFill(ctx.page);
        const label = `${width}: ${cards.map((c) => `${c.id} bottom ${Math.round(c.bottom)} slack ${Math.round(c.slack)}`).join(" | ")}`;
        assert.ok(Math.abs(cards[0]!.bottom - cards[1]!.bottom) < 1, label);
        for (const card of cards) assert.ok(card.slack < ROW_PX, label);
      }
    } finally {
      await ctx.page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("no chart label renders below the meta floor", async () => {
    const sizes = await ctx.page.evaluate(() =>
      Array.from(document.querySelectorAll(".recharts-wrapper text"))
        .filter((t) => (t.textContent || "").trim() !== "")
        .map((t) => ({ text: (t.textContent || "").trim(), px: parseFloat(getComputedStyle(t).fontSize) })),
    );
    assert.ok(sizes.length > 0, "the screen draws chart labels");
    const small = sizes.filter((s) => s.px < META_FLOOR_PX);
    assert.deepEqual(small, [], `${small.length} of ${sizes.length} chart labels below ${META_FLOOR_PX}px`);
  });

  test("the task-type matrix shows every column without a sideways scroll", async () => {
    await openTaskTypeFold(ctx.page);
    const overflow = await ctx.page.locator(MATRIX_SELECTOR).evaluate((el) => el.scrollWidth - el.clientWidth);

    assert.ok(overflow <= 1, `matrix overflows its card by ${overflow}px`);
  });
});
