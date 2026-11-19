// E2E chromium harness for the Remote access screen (screens/remote-access.jsx): painted facts a node render cannot hold —
// where focus lands in a widening confirm, the step list's own numerals, the page fitting 1440 with no sideways scroll, and the
// device table on the card's inline column.
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
const DEVICES = [
  { id: "3", label: "Minji's iPhone 15 Pro Max", createdAt: "2026-11-17T08:41:40.123Z", lastSeenAt: "2026-11-17T14:02:11.456Z" },
  { id: "7", label: "iPad", createdAt: "2026-11-02T21:15:02.001Z", lastSeenAt: "2026-11-16T23:48:59.999Z" },
  { id: "9", label: "Living-room tablet (kitchen)", createdAt: "2026-10-28T07:03:12.500Z", lastSeenAt: null },
];

interface RenderContext {
  app: FastifyInstance;
  browser: Browser;
  page: Page;
  acts: string[];
}

/** Scripted answers, each used once in order, before the defaults: network reads, then access acts. */
interface ScriptedAnswers {
  readonly networks?: Array<Record<string, unknown>>;
  readonly acts?: Array<{ readonly status: number; readonly body: unknown }>;
}

async function openRenderContext(setup: Record<string, unknown>, devices: unknown[] = [], answers: ScriptedAnswers = {}): Promise<RenderContext> {
  const acts: string[] = [];
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get(REMOTE_ADMIN_PATH.SETUP, async () => setup);
  app.get(REMOTE_ADMIN_PATH.DEVICES, async () => ({ devices }));
  app.get(REMOTE_ADMIN_PATH.CONFIRM_NETWORK, async () => answers.networks?.shift() ?? { router: ROUTER, link: "wifi", isNetworkTrusted: false });
  app.get(REMOTE_ADMIN_PATH.CERTIFICATE, async (_request, reply) => reply.code(404).send({ error: "certificate_unavailable" }));
  app.post("/api/remote/*", async (request, reply) => {
    acts.push(request.url);
    const scripted = answers.acts?.shift();
    return scripted ? reply.code(scripted.status).send(scripted.body) : { outcome: "written" };
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

describe("remote access off at 1440px, a turn-on refused because the network moved", () => {
  const MOVED_ROUTER = "10.0.0.1";
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_OFF, [], {
      networks: [
        { router: ROUTER, link: "wifi", isNetworkTrusted: false, confirm: "q3Vx0Lr8TfWm1oKcYp2bGA" },
        { router: MOVED_ROUTER, link: "wifi", isNetworkTrusted: false, confirm: "Zt7nE4sJk9HdQa0uCw6yRg" },
      ],
      acts: [{ status: 409, body: { error: "confirm_stale" } }],
    });
  });
  after(async () => closeRenderContext(ctx));

  test("the moved network's confirm puts focus back on Cancel, so a second Enter turns nothing on", async () => {
    await ctx.page.getByRole("button", { name: "Turn on" }).click();
    const dialog = ctx.page.getByRole("dialog", { name: "Turn on remote access?" });
    await dialog.waitFor({ timeout: WAIT_TIMEOUT_MS });
    await dialog.getByRole("button", { name: "Turn on and trust" }).focus();
    await ctx.page.keyboard.press("Enter");
    await dialog.getByText(MOVED_ROUTER).waitFor({ timeout: WAIT_TIMEOUT_MS });
    await dialog.getByRole("button", { name: "Turn on and trust" }).waitFor({ timeout: WAIT_TIMEOUT_MS });

    const focused = await ctx.page.evaluate(() => document.activeElement?.textContent?.trim());
    await ctx.page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached", timeout: WAIT_TIMEOUT_MS });

    assert.equal(focused, "Cancel");
    assert.deepEqual(ctx.acts, [REMOTE_ADMIN_PATH.ACCESS_ON]);
  });
});

describe("remote access on over an untrusted network at 1440px, a trust whose answer leaves its state unknown", () => {
  const UNKNOWN_WORDS = "This network may or may not be trusted.";
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext({ ...SETUP_ON, listenReason: "untrusted", isNetworkTrusted: false }, [], { acts: [{ status: 500, body: { error: "act_failed" } }] });
  });
  after(async () => closeRenderContext(ctx));

  test("its words stay on the page after the confirm closes, until a later act completes", async () => {
    const commit = async (opener: string, title: string, label: string): Promise<void> => {
      await ctx.page.getByRole("button", { name: opener, exact: true }).first().click();
      const dialog = ctx.page.getByRole("dialog", { name: title });
      await dialog.getByRole("button", { name: label, exact: true }).click();
      await dialog.waitFor({ state: "detached", timeout: WAIT_TIMEOUT_MS });
    };

    await commit("Trust this network", "Trust this network?", "Trust this network");
    const isShownAfterUnknown = await ctx.page.getByText(UNKNOWN_WORDS).isVisible();
    await commit("Turn off", "Turn off remote access?", "Turn off");
    const isShownAfterDone = await ctx.page.getByText(UNKNOWN_WORDS).isVisible();

    assert.deepEqual(
      { isShownAfterUnknown, isShownAfterDone, acts: ctx.acts },
      { isShownAfterUnknown: true, isShownAfterDone: false, acts: [REMOTE_ADMIN_PATH.TRUST, REMOTE_ADMIN_PATH.ACCESS_OFF] },
    );
  });
});

describe("remote access on at 1440px, the connect steps", () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON);
    await ctx.page.getByRole("button", { name: "iPhone or iPad" }).click();
    await ctx.page.getByText("Step 1 of 5").waitFor({ timeout: WAIT_TIMEOUT_MS });
  });
  after(async () => closeRenderContext(ctx));

  test("Next moves focus to the title of the step it opens", async () => {
    await ctx.page.getByRole("button", { name: "Next" }).click();

    const focused = await ctx.page.evaluate(() => document.activeElement?.getAttribute("aria-current"));
    assert.equal(focused, "step");
  });

  test("the card with a step and its fold open fits a 900px window without scrolling", async () => {
    await ctx.page.getByRole("button", { name: "Trouble?" }).click();

    const fit = await ctx.page.evaluate(() => {
      const card = [...document.querySelectorAll(".card")].find((el) => el.textContent?.includes("Connect a device"));
      return { bottom: Math.ceil(card?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY), window: window.innerHeight, scrollTop: document.scrollingElement?.scrollTop };
    });

    assert.ok(fit.bottom <= fit.window && fit.scrollTop === 0, JSON.stringify(fit));
  });

  test("the page fits the window with no sideways scroll", async () => {
    const width = await ctx.page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));

    assert.equal(width.scroll, width.client);
  });
});

describe("remote access on with devices at 1440px, the registered devices card", () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON, DEVICES);
    await ctx.page.getByRole("table", { name: "Registered devices" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  });
  after(async () => closeRenderContext(ctx));

  test("the table's first and last columns sit on the card head's inline column", async () => {
    // anonymous callbacks only: the test transform names a const-bound function with a helper the page lacks
    const edges = await ctx.page.evaluate(() => {
      const card = [...document.querySelectorAll(".card")].find((el) => el.querySelector("table") !== null);
      const heads = [...(card?.querySelectorAll("thead th") ?? [])];
      const buttons = [...(card?.querySelectorAll("button") ?? [])];
      const textBoxes = [card?.querySelector(".card-title"), heads[0], card?.querySelector("tbody th"), heads.at(-1)].map((el) => {
        if (!el) return null;
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect();
      });
      const removeAll = buttons.find((button) => button.textContent?.trim() === "Remove all");
      const rowRemove = buttons.filter((button) => button.textContent?.trim() === "Remove").at(-1);
      return {
        start: textBoxes.slice(0, 3).map((box) => Math.round(box?.left ?? Number.NaN)),
        end: [removeAll?.getBoundingClientRect(), textBoxes[3], rowRemove?.getBoundingClientRect()].map((box) => Math.round(box?.right ?? Number.NaN)),
      };
    });

    assert.ok([...edges.start, ...edges.end].every(Number.isFinite), `every edge was measured: ${JSON.stringify(edges)}`);
    assert.deepEqual(edges.start, [edges.start[0], edges.start[0], edges.start[0]], "title, Device header and first cell start together");
    assert.deepEqual(edges.end, [edges.end[0], edges.end[0], edges.end[0]], "Remove all, the Action header and a row's Remove end together");
  });
});
