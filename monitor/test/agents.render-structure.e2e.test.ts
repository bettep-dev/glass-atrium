// E2E chromium harness for the agents screen (screens/agents.jsx): painted facts a node render
// cannot hold — a keyboard-focused table row shows its focus ring inside the scroller that
// clips it, at the 1024px width where the ledger fills its card edge to edge.
//
// Runner: npx tsx --test test/agents.render-structure.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify serving the two row payloads; every other /api read answers empty.

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

async function openRenderContext(): Promise<RenderContext> {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });

  app.get("/api/agents/summary", async () => ({
    agents: AGENT_NAMES.map((name) => ({
      agent_id: `glass-atrium-${name}`, agent_name: name, status: "active", success_pct: 92, runs: 40, needs_context_count: 2,
    })),
    meta: { total_agents: AGENT_NAMES.length },
  }));
  app.get("/api/agents/lifecycle-stats", async () => ({
    rows: AGENT_NAMES.map((agent_type) => ({ agent_type, start_count: 4, stop_count: 4, completed_count: 3, p95_duration_sec: 60 })),
  }));
  app.get("/api/*", async () => ({ rows: [] }));

  await app.ready();
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  await page.goto(`${serverUrl}/#agents`, { waitUntil: "load" });

  for (const table of ROW_TABLES) {
    await page.waitForSelector(table.selector, { timeout: 30_000 });
  }
  return { app, browser, page };
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
    const hits = [0, 1, 2, img.width - 3, img.width - 2, img.width - 1].map((x) => {
      const [r, g, b] = ctx.getImageData(x, 0, 1, 1).data;
      return Math.abs(r - ring[0]) + Math.abs(g - ring[1]) + Math.abs(b - ring[2]) < 24;
    });
    return { left: hits.slice(0, 3).some(Boolean), right: hits.slice(3).some(Boolean) };
  }, png.toString("base64"));
}

describe("agents screen at 1024px", () => {
  let ctx: RenderContext;

  before(async () => {
    ctx = await openRenderContext();
  });

  after(async () => {
    await ctx?.browser?.close();
    await ctx?.app?.close();
  });

  for (const table of ROW_TABLES) {
    test(`a keyboard-focused ${table.name} row paints its focus ring on both sides inside its scroller`, async () => {
      await focusRowByKeyboard(ctx.page, table.selector);

      assert.deepEqual(await getRingEdges(ctx.page, table.selector), { left: true, right: true });
    });
  }
});
