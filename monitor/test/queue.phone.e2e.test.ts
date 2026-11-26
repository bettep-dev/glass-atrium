// E2E chromium check of the Queue page's phone frame (screens/queue.jsx, app.jsx): the Queue route alone lays out at the device width
// under 640, every other route and every wider device keeps index.html's 1280; there the shell's nav moves into a menu and the desk shows one view at a time.
//
// Runner: npx tsx --test test/queue.phone.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network (React and the fonts).
// Harness: test/lib/queue-render-harness.ts.

import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import type { Locator, Page } from "playwright";

import { closeHarness, getRestReadyText, type Harness, MIN_WINDOW, openHarness, openQueuePage, openShellPage, READY_TIMEOUT_MS, tickSessions, type Viewport } from "./lib/queue-render-harness.js";
import { getOffViewFixture, getRestFixture } from "./lib/queue-render-fixtures.js";

const PHONES: Viewport[] = [{ width: 360, height: 740, isMobile: true }, { width: 412, height: 915, isMobile: true }];
const PHONE = PHONES[0]!;
const DESKTOP_LAYOUT_WIDTH = 1280;
const SIDEBAR = 'aside[aria-label="Sidebar"]';
const MENU_BUTTON = { name: "Open the menu" };
const MENU = { name: "Atrium Monitor" };
const WIDE_WINDOW: Viewport = { width: 1440, height: 900 };
const SCOPE_TRIGGER = /^Sessions: /;
const ORDERS_BUTTON = { name: "Orders", exact: true };
const BACK = { name: "Back to the list" };
const PANES = [".queue-sessions", ".queue-list", ".queue-orders"];

interface PhoneView {
  name: string;
  pane: string;
  open: (page: Page) => Promise<void>;
}

const VIEWS: PhoneView[] = [
  { name: "list", pane: ".queue-list", open: async () => undefined },
  { name: "Sessions", pane: ".queue-sessions", open: (page) => page.getByRole("button", { name: SCOPE_TRIGGER }).tap() },
  { name: "Orders", pane: ".queue-orders", open: (page) => page.getByRole("button", ORDERS_BUTTON).tap() },
];
// each way out of the list, by the control that opens it
const TRIPS: PhoneView[] = [
  { ...VIEWS[1]!, name: "the scope trigger opens Sessions" },
  { ...VIEWS[2]!, name: "Orders opens Orders" },
  { name: "a row tap opens its sheet", pane: ".queue-sheet", open: (page) => page.locator(".queue-list .queue-row").last().tap() },
];

interface Widths {
  layout: number;
  scale: number;
  visual: number;
  scrollX: number;
}

// two frames after the route settles → a rewritten viewport has been laid out
function getWidths(page: Page): Promise<Widths> {
  return page.evaluate(() => new Promise<Widths>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      layout: document.documentElement.clientWidth, scale: window.visualViewport!.scale, visual: window.visualViewport!.width, scrollX: window.scrollX,
    })));
  }));
}

function waitForRoute(page: Page, label: string): Promise<void> {
  return page.locator(`${SIDEBAR} .nav-item[aria-current="page"][title="${label}"]`).waitFor({ state: "attached", timeout: READY_TIMEOUT_MS });
}

async function openRoute(harness: Harness, viewport: Viewport, hash: string, label: string): Promise<Page> {
  const page = await openShellPage(harness, viewport, hash);
  await waitForRoute(page, label);
  return page;
}

async function openPhoneQueue(harness: Harness): Promise<Page> {
  return openQueuePage(harness, PHONE, getRestReadyText());
}

// a locator's matches that draw a box: a phone-only control is in the DOM at every width, drawn only on the phone
function getShownCount(locator: Locator): Promise<number> {
  return locator.evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).length);
}

async function pickFromMenu(page: Page, label: string): Promise<void> {
  await page.getByRole("button", MENU_BUTTON).tap();
  await page.getByRole("dialog", MENU).locator(`.nav-item[title="${label}"]`).tap();
  await waitForRoute(page, label);
}

describe("the Queue page on a phone", () => {
  let harness: Harness;

  before(async () => {
    harness = await openHarness();
  });

  beforeEach(() => {
    harness.fixture = getRestFixture();
  });

  after(() => closeHarness(harness));

  describe("lays out at the device width while every other screen keeps 1280", () => {
    for (const viewport of PHONES) {
      test(`#queue on a ${viewport.width}-wide phone lays out at that width, unscaled`, async () => {
        const page = await openQueuePage(harness, viewport, getRestReadyText());
        const widths = await getWidths(page);
        await page.close();

        assert.deepEqual({ layout: widths.layout, scale: widths.scale }, { layout: viewport.width, scale: 1 }, JSON.stringify(widths));
      });

      test(`every other route on a ${viewport.width}-wide phone still lays out at 1280`, async () => {
        const page = await openRoute(harness, viewport, "dashboard", "Dashboard");
        const labels = (await page.locator(`${SIDEBAR} .nav-item`).evaluateAll((items) => items.map((item) => item.getAttribute("title") ?? ""))).filter((label) => label !== "Queue");
        const layoutByRoute: Record<string, number> = {};
        for (const label of labels) {
          await page.locator(`${SIDEBAR} .nav-item[title="${label}"]`).tap();
          await waitForRoute(page, label);
          layoutByRoute[label] = (await getWidths(page)).layout;
        }
        await page.close();

        assert.deepEqual(layoutByRoute, Object.fromEntries(labels.map((label) => [label, DESKTOP_LAYOUT_WIDTH])));
      });
    }

    const WIDER_DEVICES = [
      { name: "a tablet in portrait keeps the 1280 layout on #queue", viewport: { width: 820, height: 1180, isMobile: true }, expected: DESKTOP_LAYOUT_WIDTH },
      { name: "a phone in landscape keeps the 1280 layout on #queue", viewport: { width: 740, height: 360, isMobile: true }, expected: DESKTOP_LAYOUT_WIDTH },
      { name: "a desktop browser keeps its window width on #queue", viewport: { width: 1440, height: 900 }, expected: 1440 },
    ];
    for (const row of WIDER_DEVICES) {
      test(row.name, async () => {
        const page = await openQueuePage(harness, row.viewport, getRestReadyText());
        const widths = await getWidths(page);
        await page.close();

        assert.equal(widths.layout, row.expected, JSON.stringify(widths));
      });
    }

    test("the Queue viewport keeps pinch zoom: no maximum-scale and no user-scalable", async () => {
      const page = await openPhoneQueue(harness);
      const content = await page.locator('meta[name="viewport"]').getAttribute("content");
      await page.close();

      assert.ok(content?.includes("width=device-width") && !/maximum-scale|user-scalable/.test(content), String(content));
    });

    test("entering Queue from the 1280 sidebar lays the page out at the phone's width, unscaled, at its left edge", async () => {
      const page = await openRoute(harness, PHONE, "dashboard", "Dashboard");
      await page.locator(`${SIDEBAR} .nav-item[title="Queue"]`).tap();
      await page.getByText(getRestReadyText()).first().waitFor({ timeout: READY_TIMEOUT_MS });
      const widths = await getWidths(page);
      await page.close();

      assert.deepEqual({ layout: widths.layout, scale: widths.scale, scrollX: widths.scrollX }, { layout: PHONE.width, scale: 1, scrollX: 0 }, JSON.stringify(widths));
    });

    const LEAVE_STARTS = [
      { name: "loaded directly on #queue", open: (harness: Harness) => openPhoneQueue(harness) },
      {
        name: "entered from another route",
        open: async (harness: Harness) => {
          const page = await openRoute(harness, PHONE, "dashboard", "Dashboard");
          await page.locator(`${SIDEBAR} .nav-item[title="Queue"]`).tap();
          await page.getByText(getRestReadyText()).first().waitFor({ timeout: READY_TIMEOUT_MS });
          return page;
        },
      },
    ];
    for (const start of LEAVE_STARTS) {
      test(`leaving Queue through the menu, ${start.name}, shows the whole 1280 page as a fresh load would`, async () => {
        const page = await start.open(harness);
        await pickFromMenu(page, "Dashboard");
        const widths = await getWidths(page);
        await page.close();

        assert.deepEqual({ layout: widths.layout, isWholeWidthInView: widths.visual >= DESKTOP_LAYOUT_WIDTH - 1 }, { layout: DESKTOP_LAYOUT_WIDTH, isWholeWidthInView: true }, JSON.stringify(widths));
      });
    }

    test("an item link loaded fresh shows that item's sheet at the phone's width", async () => {
      const item = getRestFixture().items.find((row) => row.id === 103)!;
      const page = await openShellPage(harness, PHONE, `queue?item=${item.id}`);
      await page.locator(".queue-sheet").getByText(item.title).first().waitFor({ timeout: READY_TIMEOUT_MS });
      const widths = await getWidths(page);
      await page.close();

      assert.equal(widths.layout, PHONE.width, JSON.stringify(widths));
    });
  });

  describe("moves the shell's nav into a menu", () => {
    test("the sidebar is not drawn, and the menu lists the sidebar's items in order with Queue current", async () => {
      const page = await openPhoneQueue(harness);
      const isSidebarShown = await page.locator(SIDEBAR).isVisible();
      const sidebarItems = await page.locator(`${SIDEBAR} .nav-item`).evaluateAll((items) => items.map((item) => item.getAttribute("title")));
      await page.getByRole("button", MENU_BUTTON).tap();
      const menu = page.getByRole("dialog", MENU);
      const menuItems = await menu.locator(".nav-item").evaluateAll((items) => items.map((item) => item.getAttribute("title")));
      const current = await menu.locator('.nav-item[aria-current="page"]').evaluateAll((items) => items.map((item) => item.getAttribute("title")));
      await page.close();

      assert.deepEqual({ isSidebarShown, menuItems, current }, { isSidebarShown: false, menuItems: sidebarItems, current: ["Queue"] });
    });

    test("the menu button is a 44 by 44 target at the start of the Queue header", async () => {
      const page = await openPhoneQueue(harness);
      const button = page.getByRole("button", MENU_BUTTON);
      const box = await button.boundingBox();
      const isBeforeTitle = await button.evaluate((node) => {
        const title = document.querySelector(".queue-screen .page-head-title")!;
        return Boolean(node.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING) && node.getAttribute("title") === "Open the menu";
      });
      await page.close();

      assert.deepEqual({ width: box?.width, height: box?.height, isBeforeTitle }, { width: 44, height: 44, isBeforeTitle: true });
    });

    for (const viewport of [MIN_WINDOW, WIDE_WINDOW]) {
      test(`at ${viewport.width} the sidebar stays and the page draws none of the phone's controls`, async () => {
        const page = await openQueuePage(harness, viewport, getRestReadyText());
        const shown = {
          sidebar: await page.locator(SIDEBAR).isVisible(),
          menuButton: await page.getByRole("button", MENU_BUTTON).isVisible(),
          scopeTrigger: await page.getByRole("button", { name: SCOPE_TRIGGER }).isVisible(),
          ordersButton: await page.getByRole("button", ORDERS_BUTTON).isVisible(),
          viewBacks: await getShownCount(page.locator(".queue-sessions, .queue-orders").getByRole("button", BACK)),
        };
        await page.close();

        assert.deepEqual(shown, { sidebar: true, menuButton: false, scopeTrigger: false, ordersButton: false, viewBacks: 0 });
      });
    }

    test("Esc closes the menu and returns focus to the menu button", async () => {
      const page = await openPhoneQueue(harness);
      await page.getByRole("button", MENU_BUTTON).tap();
      await page.getByRole("dialog", MENU).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog", MENU).waitFor({ state: "detached" });
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      await page.close();

      assert.equal(focused, MENU_BUTTON.name);
    });
  });

  describe("shows one view at a time, each a tap from the list and back by its arrow", () => {
    for (const view of VIEWS) {
      test(`in the ${view.name} view the one pane drawn is that view's, edge to edge`, async () => {
        const page = await openPhoneQueue(harness);
        await view.open(page);
        await page.locator(view.pane).waitFor();
        const shown = await page.evaluate((panes) => panes.filter((pane) => document.querySelector(pane)!.getClientRects().length > 0), PANES);
        const box = await page.locator(view.pane).boundingBox();
        await page.close();

        assert.deepEqual({ shown, left: box?.x, right: box && box.x + box.width }, { shown: [view.pane], left: 0, right: PHONE.width });
      });
    }

    test("the list's head holds the scope trigger and Orders, each 44 tall, and no keys button", async () => {
      const page = await openPhoneQueue(harness);
      const head = page.locator(".queue-list > .card-head");
      const trigger = head.getByRole("button", { name: "Sessions: All sessions" });
      const orders = head.getByRole("button", ORDERS_BUTTON);
      const facts = {
        triggerHeight: (await trigger.boundingBox())?.height,
        ordersHeight: (await orders.boundingBox())?.height,
        isKeysShown: await head.getByRole("button", { name: "Keyboard shortcuts" }).isVisible(),
      };
      await page.close();

      assert.deepEqual(facts, { triggerHeight: 44, ordersHeight: 44, isKeysShown: false });
    });

    for (const trip of TRIPS) {
      test(`${trip.name}, and its back arrow returns to the list at the scroll it had`, async () => {
        // a list longer than the phone's screen → a scroll to keep
        harness.fixture = getOffViewFixture();
        const page = await openQueuePage(harness, PHONE, getRestReadyText(harness.fixture));
        const body = page.locator(".queue-list > .card-body");
        const top = await body.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          return node.scrollTop;
        });
        await trip.open(page);
        await page.locator(trip.pane).getByRole("button", BACK).tap();
        await page.locator(".queue-list").waitFor();
        const kept = await body.evaluate((node) => node.scrollTop);
        await page.close();

        assert.deepEqual({ isScrolled: top > 0, kept }, { isScrolled: true, kept: top });
      });
    }

    test("a tick in Sessions keeps the reader there, and back on the list the trigger names that session and the rows are its own", async () => {
      const page = await openPhoneQueue(harness);
      await VIEWS[1]!.open(page);
      await tickSessions(page, ["gersona"]);
      const isStillInSessions = await page.locator(".queue-sessions").isVisible();
      await page.locator(".queue-sessions").getByRole("button", BACK).tap();
      const trigger = await page.getByRole("button", { name: SCOPE_TRIGGER }).getAttribute("aria-label");
      const rowIds = await page.locator(".queue-list .queue-row").evaluateAll((rows) => rows.map((row) => Number(row.id.replace("queue-row-", ""))));
      await page.close();

      const gersonaIds = getRestFixture().items.filter((item) => item.status === "open" && item.session.name === "gersona").map((item) => item.id);
      assert.deepEqual({ isStillInSessions, trigger, rowIds: rowIds.sort((a, b) => a - b) }, { isStillInSessions: true, trigger: "Sessions: gersona", rowIds: gersonaIds.sort((a, b) => a - b) });
    });
  });
});
