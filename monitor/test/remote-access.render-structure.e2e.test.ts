// E2E chromium harness for the Remote access screen (screens/remote-access.jsx): painted facts a node render cannot hold —
// where focus lands in a widening confirm, the connect card's rail and pane at each supported width (spec 44105 → Layout),
// every open step fitting the owner's window, and the device table on the card's inline column.
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
  const UNKNOWN_WORDS = "This network may or may not be trusted; refresh to check.";
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

// spec 44105 → Layout → Page: viewport → the content width the page column takes
const WIDTHS = [
  { viewport: 1280, content: 1012 },
  { viewport: 1440, content: 1172 },
  { viewport: 1568, content: 1300 },
];
// spec 44105 → Layout → Connect a device: --ra-rail-w 20rem · the pane body and foot inset by --card-pad
const RAIL_PX = 320;
const CARD_PAD_PX = 16;
// the owner's window (spec 44105 → Layout → Page)
const OWNER_WINDOW = { width: 1568, height: 759 };

/** The Connect card's procedure as painted: card, rail, pane, the pane's foot controls and the fingerprint lines. */
async function readProcedure(page: Page) {
  // anonymous callbacks only: the test transform names a const-bound function with a helper the page lacks
  return page.evaluate(() => {
    const card = [...document.querySelectorAll(".card")].find((el) => el.textContent?.includes("Connect a device"));
    const pane = card?.querySelector(".ra-pane");
    const foot = pane?.querySelector(".ra-pane-foot");
    const lines = [...(pane?.querySelectorAll(".ra-fingerprint .machine > span") ?? [])];
    const [cardBox, rail, paneBox, footBox, footStart, footEnd] = [card, card?.querySelector(".ra-rail"), pane, foot, foot?.firstElementChild, foot?.lastElementChild].map((el) => {
      const rect = el?.getBoundingClientRect();
      return rect ? { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width) } : null;
    });
    return {
      card: cardBox,
      rail,
      pane: paneBox,
      foot: footBox,
      footStart,
      footEnd,
      fingerprint: { count: lines.length, size: lines[0] ? getComputedStyle(lines[0]).fontSize : null, groups: lines.map((line) => line.children.length) },
      scroll: { width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, top: document.scrollingElement?.scrollTop },
    };
  });
}

describe("remote access on, the connect card's procedure at each supported width, step 2 open", () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON);
    await ctx.page.getByRole("button", { name: "Next" }).click();
    await ctx.page.getByRole("heading", { name: "Match the fingerprint before installing", level: 3 }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  });
  after(async () => closeRenderContext(ctx));

  for (const row of WIDTHS) {
    test(`at ${row.viewport}px the card spans the ${row.content}px column, the 320px rail beside the pane, Back and Next on the pane's foot`, async () => {
      await ctx.page.setViewportSize({ width: row.viewport, height: 900 });

      const at = await readProcedure(ctx.page);

      assert.ok(at.card && at.rail && at.pane && at.foot && at.footStart && at.footEnd, JSON.stringify(at));
      assert.deepEqual(
        {
          card: at.card.width,
          rail: at.rail.width,
          railStart: at.rail.left - at.card.left <= 1,
          paneStart: at.pane.left - at.rail.right,
          paneEnd: at.card.right - at.pane.right <= 1,
          sameTop: at.pane.top === at.rail.top,
          footOnPaneBottom: at.foot.bottom === at.pane.bottom,
          back: at.footStart.left - at.pane.left,
          next: at.pane.right - at.footEnd.right,
          sideways: at.scroll.width - at.scroll.client,
        },
        { card: row.content, rail: RAIL_PX, railStart: true, paneStart: 0, paneEnd: true, sameTop: true, footOnPaneBottom: true, back: CARD_PAD_PX, next: CARD_PAD_PX, sideways: 0 },
      );
    });
  }

  test("the fingerprint reads at 16px, each of its four lines in two groups of four pairs", async () => {
    await ctx.page.setViewportSize({ width: 1440, height: 900 });

    const { fingerprint } = await readProcedure(ctx.page);

    assert.deepEqual(fingerprint, { count: 4, size: "16px", groups: [2, 2, 2, 2] });
  });

  test("a card narrower than 44rem stacks the rail over the pane", async () => {
    await ctx.page.setViewportSize({ width: 760, height: 900 });

    const at = await readProcedure(ctx.page);

    assert.ok(at.rail && at.pane, JSON.stringify(at));
    assert.deepEqual({ below: at.pane.top >= at.rail.bottom, sameWidth: at.pane.width === at.rail.width }, { below: true, sameWidth: true });
  });
});

describe("remote access on at 1440px, moving through the steps", () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON);
    await ctx.page.getByText("Step 1 of 5").waitFor({ timeout: WAIT_TIMEOUT_MS });
  });
  after(async () => closeRenderContext(ctx));

  test("Next stands at one place on steps 1, 3 and 4 and moves focus to the heading of the step it opens", async () => {
    const readNext = () => ctx.page.getByRole("button", { name: "Next", exact: true }).evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return `${Math.round(rect.left)},${Math.round(rect.top)}`;
    });
    const places = [await readNext()];
    await ctx.page.getByRole("button", { name: "Next", exact: true }).click();
    const focused = await ctx.page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim() }));
    await ctx.page.getByRole("button", { name: "Next", exact: true }).click();
    places.push(await readNext());
    await ctx.page.getByRole("button", { name: "Next", exact: true }).click();
    places.push(await readNext());

    assert.deepEqual(focused, { tag: "H3", text: "Match the fingerprint before installing" });
    assert.deepEqual(places, [places[0], places[0], places[0]], "steps 1, 3 and 4");
  });

  test("every rail row's title starts on one column, whether the row is done, open or ahead", async () => {
    const starts = await ctx.page.evaluate(() =>
      [...document.querySelectorAll(".ra-rail ol > li")].map((row) => Math.round(row.querySelector(".ra-step-title")?.getBoundingClientRect().left ?? Number.NaN)),
    );

    assert.equal(starts.length, 5);
    assert.deepEqual(starts, starts.map(() => starts[0]));
  });
});

describe("remote access on in the owner's 1568 x 759 window, every open step is whole on the first screen", () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON, [], { acts: [{ status: 200, body: { code: "K7QM4XZP" } }] });
    await ctx.page.setViewportSize(OWNER_WINDOW);
    await ctx.page.getByText("Step 1 of 5").waitFor({ timeout: WAIT_TIMEOUT_MS });
  });
  after(async () => closeRenderContext(ctx));

  test("steps 1 to 4, step 2 with its fold open and step 5 with a code and its fold open end above the window's bottom", async () => {
    const bottoms: Record<string, number> = {};
    const measure = async (state: string) => {
      const { card, scroll } = await readProcedure(ctx.page);
      bottoms[state] = scroll.top === 0 ? card?.bottom ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
    };
    const next = () => ctx.page.getByRole("button", { name: "Next", exact: true }).click();
    await measure("step 1");
    await next();
    await ctx.page.getByRole("button", { name: "Trouble?" }).click();
    await measure("step 2, fold open");
    await next();
    await measure("step 3");
    await next();
    await measure("step 4");
    await next();
    await ctx.page.getByRole("button", { name: "Show QR code" }).click();
    await ctx.page.getByText("K7QM 4XZP").waitFor({ timeout: WAIT_TIMEOUT_MS });
    await ctx.page.getByRole("button", { name: "Trouble?" }).click();
    await measure("step 5, code and fold open");

    const over = Object.entries(bottoms).filter(([, bottom]) => bottom > OWNER_WINDOW.height);
    assert.equal(Object.keys(bottoms).length, 5);
    assert.deepEqual(over, [], JSON.stringify(bottoms));
  });
});

describe("remote access on at 1440px, the scan step with a code open", () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON, [], { acts: [{ status: 200, body: { code: "K7QM4XZP" } }] });
    await ctx.page.getByRole("button", { name: "Trouble?" }).click();
    await ctx.page.getByRole("button", { name: "Go to step 5" }).click();
    await ctx.page.getByRole("button", { name: "Show QR code" }).click();
    await ctx.page.getByText("K7QM 4XZP").waitFor({ timeout: WAIT_TIMEOUT_MS });
    await ctx.page.getByRole("button", { name: "Trouble?" }).click();
  });
  after(async () => closeRenderContext(ctx));

  test("the shell's encoder draws the open code's QR code at full size under its fixed name", async () => {
    const qr = await ctx.page.evaluate(() => {
      const svg = document.querySelector('.ra-pane svg[role="img"]');
      return { label: svg?.getAttribute("aria-label"), side: svg?.getBoundingClientRect().width, drawn: Number(svg?.getAttribute("width")) };
    });

    assert.equal(qr.label, "QR code for the sign-in page with this code");
    assert.equal(qr.side, qr.drawn, "the layout never scales the modules off their 4 px");
  });

  test("the code and its new-code button stand at the QR code's right, top-aligned", async () => {
    const place = await ctx.page.evaluate(() => {
      const qr = document.querySelector('svg[role="img"]')?.getBoundingClientRect();
      const code = [...document.querySelectorAll("span")].find((el) => el.textContent === "Code")?.getBoundingClientRect();
      const button = [...document.querySelectorAll("button")].find((el) => el.textContent === "Show a new code")?.getBoundingClientRect();
      return { qrRight: qr?.right, qrTop: qr?.top, codeLeft: code?.left, codeTop: code?.top, buttonLeft: button?.left };
    });

    assert.ok(Number(place.codeLeft) >= Number(place.qrRight) && Number(place.buttonLeft) >= Number(place.qrRight), JSON.stringify(place));
    assert.ok(Math.abs(Number(place.codeTop) - Number(place.qrTop)) <= 1, JSON.stringify(place));
  });

  test("the open fold tells the person to type the open code", async () => {
    const fold = await ctx.page.getByText("Then type this code:").textContent();

    assert.equal(fold?.replace(/\s+/g, " ").trim(), "Then type this code: K7QM 4XZP");
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
