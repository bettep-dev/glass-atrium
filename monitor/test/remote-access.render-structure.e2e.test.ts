// E2E chromium harness for the Remote access screen (screens/remote-access.jsx): painted facts a node render cannot hold —
// where focus lands in a widening confirm, the step list's own numerals, and the page fitting 1440 with no sideways scroll.
//
// Runner: npx tsx --test test/remote-access.render-structure.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify answering the Mac-only reads below; every act is recorded, never performed.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { REMOTE_ADMIN_PATH } from "../src/server/remote/admin-routes.js";

const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const ROUTER = "192.168.0.1";
const WAIT_TIMEOUT_MS = 30_000;
const SETUP_OFF = {
  enabled: false, isOffByDevice: false, listenReason: "disabled", hasRouter: true, isNetworkTrusted: false, trustedCount: 0,
  isAnswering: false, hostName: "studio-mac.local", address: "192.168.0.12", port: 16146, deviceLimit: 10,
  fingerprint: "9A:3F:1C:07:5E:B2:44:D0:61:0B:F8:2A:93:7C:E5:18:C4:2D:70:AB:06:9E:53:F1:8B:14:D7:3A:6F:20:CE:95",
};
const SETUP_ON = { ...SETUP_OFF, enabled: true, listenReason: "trusted", isNetworkTrusted: true, trustedCount: 1, isAnswering: true };

interface RenderContext {
  app: FastifyInstance;
  browser: Browser;
  page: Page;
  acts: string[];
}

async function openRenderContext(setup: Record<string, unknown>): Promise<RenderContext> {
  const acts: string[] = [];
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get(REMOTE_ADMIN_PATH.SETUP, async () => setup);
  app.get(REMOTE_ADMIN_PATH.DEVICES, async () => ({ devices: [], access: { enabled: setup.enabled, trustedCount: setup.trustedCount } }));
  app.get(REMOTE_ADMIN_PATH.CONFIRM_NETWORK, async () => ({ router: ROUTER, link: "wifi", isNetworkTrusted: false }));
  app.get(REMOTE_ADMIN_PATH.CERTIFICATE, async (_request, reply) => reply.code(404).send({ error: "certificate_unavailable" }));
  app.post("/api/remote/*", async (request) => {
    acts.push(request.url);
    return { outcome: "written" };
  });
  app.get("/api/*", async () => ({ rows: [] }));

  await app.ready();
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await page.goto(`${serverUrl}/#remote-access`, { waitUntil: "load" });
  await page.getByRole("heading", { name: "Remote access", level: 1 }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  await page.locator(".pill").first().waitFor({ timeout: WAIT_TIMEOUT_MS });
  return { app, browser, page, acts };
}

async function closeRenderContext(ctx: RenderContext | undefined): Promise<void> {
  await ctx?.browser?.close();
  await ctx?.app?.close();
}

describe("remote access off at 1440px, the turn-on confirm", () => {
  let ctx: RenderContext;
  before(async () => { ctx = await openRenderContext(SETUP_OFF); });
  after(async () => closeRenderContext(ctx));

  test("focus enters on Cancel beside the router, so Enter closes the confirm and nothing is turned on", async () => {
    await ctx.page.getByRole("button", { name: "Turn on" }).click();
    const dialog = ctx.page.getByRole("dialog", { name: "Turn on remote access?" });
    await dialog.waitFor({ timeout: WAIT_TIMEOUT_MS });

    const focused = await ctx.page.evaluate(() => document.activeElement?.textContent?.trim());
    const hasRouter = (await dialog.innerText()).includes(ROUTER);
    await ctx.page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached", timeout: WAIT_TIMEOUT_MS });

    assert.equal(focused, "Cancel");
    assert.equal(hasRouter, true);
    assert.deepEqual(ctx.acts, []);
  });
});

describe("remote access on at 1440px, the connect steps", () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON);
    await ctx.page.getByText("Send this Mac's certificate to the device").waitFor({ timeout: WAIT_TIMEOUT_MS });
  });
  after(async () => closeRenderContext(ctx));

  test("the five steps paint the list's own numerals", async () => {
    const list = await ctx.page.locator("ol").evaluate((ol) => ({
      marker: getComputedStyle(ol).listStyleType,
      items: [...ol.children].map((li) => getComputedStyle(li).display),
    }));

    assert.deepEqual(list, { marker: "decimal", items: ["list-item", "list-item", "list-item", "list-item", "list-item"] });
  });

  test("the page fits the window with no sideways scroll", async () => {
    const width = await ctx.page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));

    assert.equal(width.scroll, width.client);
  });
});
