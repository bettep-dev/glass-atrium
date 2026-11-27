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

import { REMOTE_ADMIN_PATH } from "../src/server/remote/admin-routes.js";
import { createBrowser } from "./lib/house-face.js";

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
  /** every network read fails → the unread-network line */
  readonly isNetworkUnreadable?: boolean;
  readonly acts?: Array<{ readonly status: number; readonly body: unknown }>;
}

async function openRenderContext(setup: Record<string, unknown>, devices: unknown[] = [], answers: ScriptedAnswers = {}): Promise<RenderContext> {
  const acts: string[] = [];
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get(REMOTE_ADMIN_PATH.SETUP, async () => setup);
  app.get(REMOTE_ADMIN_PATH.DEVICES, async () => ({ devices }));
  app.get(REMOTE_ADMIN_PATH.CONFIRM_NETWORK, async (_request, reply) => (answers.isNetworkUnreadable
    ? reply.code(500).send({ error: "internal" })
    : answers.networks?.shift() ?? { router: ROUTER, link: "wifi", isNetworkTrusted: false }));
  app.get(REMOTE_ADMIN_PATH.CERTIFICATE, async (_request, reply) => reply.code(404).send({ error: "certificate_unavailable" }));
  app.post("/api/remote/*", async (request, reply) => {
    acts.push(request.url);
    const scripted = answers.acts?.shift();
    return scripted ? reply.code(scripted.status).send(scripted.body) : { outcome: "written" };
  });
  app.get("/api/*", async () => ({ rows: [] }));

  await app.ready();
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await createBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await page.goto(`${serverUrl}/#remote-access`, { waitUntil: "load" });
  await page.getByRole("heading", { name: "Remote access", level: 1 }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  await page.locator(".pill").first().waitFor({ timeout: WAIT_TIMEOUT_MS });
  // every measure in the page's own faces, never the fallback painted before they arrive
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
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

describe("remote access off at 1440px, a turn-on whose network cannot be read", () => {
  let ctx: RenderContext;
  before(async () => { ctx = await openRenderContext(SETUP_OFF, [], { isNetworkUnreadable: true }); });
  after(async () => closeRenderContext(ctx));

  test("the unread-network line stands under the off line at the label gap, on the off line's column", async () => {
    await ctx.page.getByRole("button", { name: "Turn on" }).click();
    await ctx.page.getByRole("alert").waitFor({ timeout: WAIT_TIMEOUT_MS });

    // anonymous callbacks only: the test transform names a const-bound function with a helper the page lacks
    const at = await ctx.page.evaluate(() => {
      const alert = document.querySelector("[role=alert]");
      const card = alert?.closest(".card");
      // the innermost box holding the off line
      const line = [...(card?.querySelectorAll("div") ?? [])].filter((el) => el.textContent?.startsWith("Turn on to use this monitor")).at(-1);
      const textBoxes = [line, alert?.querySelector("p")].map((el) => {
        if (!el) return null;
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect();
      });
      const gapLabel = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--gap-label"));
      // gap between the two blocks' boxes, the column from their text
      return { gap: Math.round((alert?.getBoundingClientRect().top ?? Number.NaN) - (line?.getBoundingClientRect().bottom ?? Number.NaN)), gapLabel, sameColumn: textBoxes[0]?.left === textBoxes[1]?.left };
    });

    assert.deepEqual(at, { gap: at.gapLabel, gapLabel: at.gapLabel, sameColumn: true });
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
// tokens.css → --space-3
const SPACE_3_PX = 12;
// a glyph's own side bearing, far under the 8px a centred numeral sits in from its 24px column
const GLYPH_BEARING_PX = 2;
// the owner's window (spec 44105 → Layout → Page)
const OWNER_WINDOW = { width: 1568, height: 759 };

/** Opens the named device's steps from the connect card's device choice. */
async function chooseDevice(page: Page, device: string): Promise<void> {
  await page.getByRole("button", { name: device, exact: true }).click();
  await page.getByText(`Step 1 of 5 · ${device}`).waitFor({ timeout: WAIT_TIMEOUT_MS });
}

// each device's compare step: reached by its own forward presses, its rail titles one line each where the spec measured it
const COMPARE_STEPS = [
  { device: "iPhone or iPad", forward: ["Next"], title: "Match the fingerprint before installing", isRailOneLine: true },
  { device: "Galaxy phone", forward: ["Next", "Next", "Next"], title: "Match the fingerprint right after installing", isRailOneLine: false },
];

/** The Connect card's procedure as painted: card, rail, pane, the pane's foot controls and the fingerprint lines. */
async function readProcedure(page: Page) {
  // anonymous callbacks only: the test transform names a const-bound function with a helper the page lacks
  return page.evaluate(() => {
    const card = [...document.querySelectorAll(".card")].find((el) => el.textContent?.includes("Connect a device"));
    const pane = card?.querySelector(".ra-pane");
    const foot = pane?.querySelector(".ra-pane-foot");
    const lines = [...(pane?.querySelectorAll(".ra-fingerprint .machine > span") ?? [])];
    // the step between the groups beyond one pair space: group 1's end → group 2's start, less the drawn width of a pair's space
    const groupStep = lines.map((line) => {
      const [first, second] = [...line.children];
      const spaceText = first?.firstChild;
      if (!second || !spaceText) return null;
      const space = document.createRange();
      space.setStart(spaceText, 2);
      space.setEnd(spaceText, 3);
      return Math.round(second.getBoundingClientRect().left - first.getBoundingClientRect().right - space.getBoundingClientRect().width);
    });
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
      fingerprint: { count: lines.length, size: lines[0] ? getComputedStyle(lines[0]).fontSize : null, groups: lines.map((line) => line.children.length), groupStep, text: lines.map((line) => line.textContent) },
      scroll: { width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, top: document.scrollingElement?.scrollTop },
    };
  });
}

for (const compare of COMPARE_STEPS) describe(`remote access on, the ${compare.device} procedure at each supported width, its compare step open`, () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON);
    await chooseDevice(ctx.page, compare.device);
    for (const name of compare.forward) await ctx.page.getByRole("button", { name, exact: true }).click();
    await ctx.page.getByRole("heading", { name: compare.title, level: 3 }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  });
  after(async () => closeRenderContext(ctx));

  for (const row of WIDTHS) {
    test(`at ${row.viewport}px the card spans the ${row.content}px column, the 320px rail beside the pane, Back and the forward control on the pane's foot`, async () => {
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

  test("the fingerprint reads at 16px, each of its four lines two groups of four pairs set --space-3 wider than a pair's space, its text single-spaced", async () => {
    await ctx.page.setViewportSize({ width: 1440, height: 900 });
    const pairs = SETUP_ON.fingerprint.split(":");
    const text = [0, 8, 16, 24].map((start) => pairs.slice(start, start + 8).join(" "));

    const { fingerprint } = await readProcedure(ctx.page);

    assert.deepEqual(fingerprint, { count: 4, size: "16px", groups: [2, 2, 2, 2], groupStep: [SPACE_3_PX, SPACE_3_PX, SPACE_3_PX, SPACE_3_PX], text });
  });

  if (compare.isRailOneLine) test("every rail title stays on one line at each supported width, the open one included", async () => {
    const lines: Record<number, number[]> = {};
    for (const row of WIDTHS) {
      await ctx.page.setViewportSize({ width: row.viewport, height: 900 });
      // two lines still fit the 40px row → count the title's own lines
      lines[row.viewport] = await ctx.page.evaluate(() =>
        [...document.querySelectorAll(".ra-rail .ra-step-title")].map((title) => Math.round(title.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(title).lineHeight))),
      );
    }

    assert.deepEqual(lines, Object.fromEntries(WIDTHS.map((row) => [row.viewport, [1, 1, 1, 1, 1]])));
  });

  test("the rail head's first letter, the done mark and every numeral start on one column", async () => {
    await ctx.page.setViewportSize({ width: 1440, height: 900 });

    const starts = await ctx.page.evaluate(() =>
      [document.querySelector(".ra-rail-head"), ...document.querySelectorAll(".ra-rail .ra-step-mark")].map((el) => {
        const walker = el ? document.createTreeWalker(el, NodeFilter.SHOW_TEXT) : null;
        const glyph = walker?.nextNode();
        if (!glyph) return Number.NaN;
        const range = document.createRange();
        range.setStart(glyph, 0);
        range.setEnd(glyph, 1);
        return range.getBoundingClientRect().left;
      }),
    );

    assert.equal(starts.length, 6, JSON.stringify(starts));
    assert.ok(starts.every((left) => Math.abs(left - starts[0]) <= GLYPH_BEARING_PX), `head, ✓ and numerals 2-5 within ${GLYPH_BEARING_PX}px: ${JSON.stringify(starts)}`);
  });

  test("a card narrower than 44rem stacks the rail over the pane", async () => {
    await ctx.page.setViewportSize({ width: 760, height: 900 });

    const at = await readProcedure(ctx.page);

    assert.ok(at.rail && at.pane, JSON.stringify(at));
    assert.deepEqual({ below: at.pane.top >= at.rail.bottom, sameWidth: at.pane.width === at.rail.width }, { below: true, sameWidth: true });
  });
});

describe("remote access on at 1440px, the device choice", () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON);
  });
  after(async () => closeRenderContext(ctx));

  for (const device of ["iPhone or iPad", "Galaxy phone"]) {
    test(`a second press where ${device} stood lands on no control of the step it opens, so a double-click never presses one`, async () => {
      const change = ctx.page.getByRole("button", { name: "Change device", exact: true });
      if (await change.count()) await change.click();
      const pressed = await ctx.page.getByRole("button", { name: device, exact: true }).boundingBox();
      await chooseDevice(ctx.page, device);

      const hits = await ctx.page.evaluate((box) => {
        const card = [...document.querySelectorAll(".card")].find((el) => el.textContent?.includes("Connect a device"));
        const controls = [...(card?.querySelectorAll("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])") ?? [])];
        return controls.filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left < box.x + box.width && rect.right > box.x && rect.top < box.y + box.height && rect.bottom > box.y;
        }).map((el) => el.textContent?.trim());
      }, pressed ?? { x: 0, y: 0, width: 0, height: 0 });

      assert.ok(pressed, `${device} was on the choice`);
      assert.deepEqual(hits, []);
    });
  }
});

describe("remote access on at 1440px, moving through the steps", () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON);
    await chooseDevice(ctx.page, "iPhone or iPad");
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

  test("a heading a keyboard Next focuses draws no ring, so it never reads as a field", async () => {
    await ctx.page.getByRole("button", { name: "Next", exact: true }).focus();
    await ctx.page.keyboard.press("Enter");
    await ctx.page.waitForFunction(() => document.activeElement?.tagName === "H3", null, { timeout: WAIT_TIMEOUT_MS });

    const heading = await ctx.page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el?.tagName, isFocusVisible: el?.matches(":focus-visible"), outline: el ? getComputedStyle(el).outlineStyle : null };
    });

    assert.deepEqual(heading, { tag: "H3", isFocusVisible: true, outline: "none" });
  });
});

// each device's way through its five steps: the forward control per step, the step whose fold opens, the last step's open control
const WHOLE_STEP_PATHS = [
  { device: "iPhone or iPad", forward: ["Next", "Next", "Next", "Next"], foldStep: 2, open: "Show QR code" },
  { device: "Galaxy phone", forward: ["Next", "Next", "Next", "Lines match"], foldStep: 4, open: "Show address and code" },
];

for (const path of WHOLE_STEP_PATHS) describe(`remote access on in the owner's 1568 x 759 window, every open ${path.device} step is whole on the first screen`, () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON, [], { acts: [{ status: 200, body: { code: "K7QM4XZP" } }] });
    await ctx.page.setViewportSize(OWNER_WINDOW);
    await chooseDevice(ctx.page, path.device);
  });
  after(async () => closeRenderContext(ctx));

  test(`steps 1 to 4, step ${path.foldStep} with its fold open and step 5 with a code and its fold open end above the window's bottom`, async () => {
    const bottoms: Record<string, number> = {};
    const measure = async (state: string) => {
      const { card, scroll } = await readProcedure(ctx.page);
      bottoms[state] = scroll.top === 0 ? card?.bottom ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
    };
    await measure("step 1");
    for (const [i, name] of path.forward.slice(0, 3).entries()) {
      await ctx.page.getByRole("button", { name, exact: true }).click();
      const step = i + 2;
      if (step === path.foldStep) await ctx.page.getByRole("button", { name: "Trouble?" }).click();
      await measure(step === path.foldStep ? `step ${step}, fold open` : `step ${step}`);
    }
    await ctx.page.getByRole("button", { name: path.forward[3], exact: true }).click();
    await ctx.page.getByRole("button", { name: path.open }).click();
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
    await chooseDevice(ctx.page, "iPhone or iPad");
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

describe("remote access on at 1440px, the Galaxy's last step with a code open", () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON, [], { acts: [{ status: 200, body: { code: "K7QM4XZP" } }] });
    await chooseDevice(ctx.page, "Galaxy phone");
    await ctx.page.getByRole("button", { name: "Trouble?" }).click();
    await ctx.page.getByRole("button", { name: "Go to step 4" }).click();
    await ctx.page.getByRole("button", { name: "Lines match" }).click();
    await ctx.page.getByRole("button", { name: "Show address and code" }).click();
    await ctx.page.getByText("K7QM 4XZP").waitFor({ timeout: WAIT_TIMEOUT_MS });
  });
  after(async () => closeRenderContext(ctx));

  test("the address and the code stand first, the QR code at their right under its own label, top-aligned", async () => {
    // anonymous callbacks only: the test transform names a const-bound function with a helper the page lacks
    const place = await ctx.page.evaluate(() => {
      const [address, code, scan] = ["Address", "Code", "Or scan with Camera"].map((text) => [...document.querySelectorAll(".ra-pane span")].find((el) => el.textContent === text)?.getBoundingClientRect());
      return { address, code, scan, qr: document.querySelector('.ra-pane svg[role="img"]')?.getBoundingClientRect() };
    });

    assert.ok(place.address && place.code && place.scan && place.qr, JSON.stringify(place));
    assert.ok(place.code.top > place.address.top && place.qr.left >= place.address.right && place.qr.top > place.scan.top, JSON.stringify(place));
    assert.ok(Math.abs(place.scan.top - place.address.top) <= 1, JSON.stringify(place));
  });

  test("the address is the private address on one line, as text, never a link", async () => {
    const address = await ctx.page.getByText("https://192.168.0.12:16146", { exact: true }).evaluate((el) => ({
      lines: Math.round(el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight)),
      links: el.closest("a") === null ? 0 : 1,
    }));

    assert.deepEqual(address, { lines: 1, links: 0 });
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

describe("remote access on with no device at 1440px, the registered devices card", () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON);
    await ctx.page.getByText("No device registered").waitFor({ timeout: WAIT_TIMEOUT_MS });
  });
  after(async () => closeRenderContext(ctx));

  test("the empty line starts on the column of the card's title and its trusted-networks foot", async () => {
    const starts = await ctx.page.evaluate(() => {
      const card = [...document.querySelectorAll(".card")].find((el) => el.querySelector(".card-title")?.textContent === "Registered devices");
      return [card?.querySelector(".card-title"), card?.querySelector(".placeholder > div"), card?.querySelector(".card-foot")].map((el) => {
        if (!el) return Number.NaN;
        const range = document.createRange();
        range.selectNodeContents(el);
        return Math.round(range.getBoundingClientRect().left);
      });
    });

    assert.ok(starts.every(Number.isFinite), `every line was measured: ${JSON.stringify(starts)}`);
    assert.deepEqual(starts, [starts[0], starts[0], starts[0]], "title, empty line and foot start together");
  });
});

// the server's label cap (routes.ts → label maxLength 64), a real model name
const LONG_LABEL = "Minji’s iPad Pro 12.9-inch (6th generation) Wi-Fi + Cellular 1TB";
const NARROWEST_VIEWPORT = 1024;
// narrower than the narrowest supported width → the Device column is narrower than the long name
const CUTTING_VIEWPORT = 800;

describe("remote access on with a 64-character device name, the device table", () => {
  let ctx: RenderContext;
  before(async () => {
    ctx = await openRenderContext(SETUP_ON, [{ ...DEVICES[0], label: LONG_LABEL }, ...DEVICES.slice(1)]);
    await ctx.page.getByRole("table", { name: "Registered devices" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  });
  after(async () => closeRenderContext(ctx));

  test("a Device column narrower than the name keeps it on one line, cut with an ellipsis, whole in its title, its row as tall as a short name's", async () => {
    await ctx.page.setViewportSize({ width: CUTTING_VIEWPORT, height: 900 });

    const at = await ctx.page.evaluate(() => {
      const rows = [...document.querySelectorAll("table tbody tr")];
      const cell = rows[0]?.querySelector("th");
      const cut = cell?.querySelector("[title]") ?? cell;
      return {
        title: cut?.getAttribute("title"),
        isCut: cut ? cut.scrollWidth > cut.clientWidth && getComputedStyle(cut).textOverflow === "ellipsis" : false,
        heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
      };
    });

    assert.deepEqual(at, { title: LONG_LABEL, isCut: true, heights: [at.heights[1], at.heights[1], at.heights[1]] });
  });
});
describe("the device table at the narrowest supported width, its Registered and Last seen columns", () => {
  const rows = [
    { name: "beside a long name, each date and header reads on one line, the columns no wider than their widest text", devices: [{ ...DEVICES[0], label: LONG_LABEL }, ...DEVICES.slice(1)] },
    { name: "with no device seen yet, the Last seen header still reads on one line, the columns no wider than their widest text", devices: [{ ...DEVICES[0], lastSeenAt: null }] },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const ctx = await openRenderContext(SETUP_ON, row.devices);
      try {
        await ctx.page.setViewportSize({ width: NARROWEST_VIEWPORT, height: 900 });
        await ctx.page.getByRole("table", { name: "Registered devices" }).waitFor({ timeout: WAIT_TIMEOUT_MS });

        const columns = await ctx.page.evaluate(() => {
          const table = document.querySelector("table");
          return [2, 3].map((nth) => {
            const cells = [...(table?.querySelectorAll(`tr > :nth-child(${nth})`) ?? [])];
            const texts = cells.map((cell) => {
              const range = document.createRange();
              range.selectNodeContents(cell);
              const rects = [...range.getClientRects()];
              return { width: range.getBoundingClientRect().width, lines: new Set(rects.map((rect) => Math.round(rect.top))).size };
            });
            const cell = cells[0];
            const style = cell ? getComputedStyle(cell) : null;
            const inner = cell && style ? cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) : Number.NaN;
            return { lines: texts.map((text) => text.lines), slack: Math.round(inner - Math.max(...texts.map((text) => text.width))) };
          });
        });

        assert.deepEqual(columns, columns.map((column) => ({ lines: column.lines.map(() => 1), slack: 0 })), JSON.stringify(columns));
      } finally {
        await closeRenderContext(ctx);
      }
    });
  }
});
