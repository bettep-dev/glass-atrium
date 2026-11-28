// E2E chromium check of the Queue page's phone frame (screens/queue.jsx, app.jsx): the Queue route alone lays out at the device width
// under 640, every other route and every wider device keeps index.html's 1280; there the shell's nav moves into a menu and the desk shows one view at a time.
//
// Runner: npx tsx --test test/queue.phone.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network (React and the fonts).
// Harness: test/lib/queue-render-harness.ts.

import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { type Browser, chromium, type Locator, type Page } from "playwright";

import {
  closeHarness, getRestReadyText, getSelfNamedFixture, type Harness, MIN_WINDOW, openHarness, openQueuePage, openShellPage, READY_TIMEOUT_MS, tickSessions, type Viewport, waitForDoneBands,
} from "./lib/queue-render-harness.js";
import {
  getAnswerNotReceivedFixture, getOffViewFixture, getProseFixture, getRelayListFixture, getRelayRowFixture, getRelayThreadFixture, getRestFixture, getScanApprovalFixture, type QueueFixture, RELAY_ROW_IDS, SCAN_IDS, SCAN_MARK_POINTS,
} from "./lib/queue-render-fixtures.js";

const PHONES: Viewport[] = [{ width: 360, height: 740, isMobile: true }, { width: 412, height: 915, isMobile: true }];
const PHONE = PHONES[0]!;
const DESKTOP_LAYOUT_WIDTH = 1280;
const SIDEBAR = 'aside[aria-label="Sidebar"]';
const MENU_BUTTON = { name: "Open the menu" };
const MENU = { name: "Atrium Monitor" };
const WIDE_WINDOW: Viewport = { width: 1440, height: 900 };
const NARROW_WINDOW: Viewport = { width: 1100, height: 900 };
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

function getRouteMark(page: Page, label: string): Locator {
  return page.locator(`${SIDEBAR} .nav-item[aria-current="page"][title="${label}"]`);
}

function waitForRoute(page: Page, label: string): Promise<void> {
  return getRouteMark(page, label).waitFor({ state: "attached", timeout: READY_TIMEOUT_MS });
}

// no busy region left in the screen → its first reads have rendered, so a screen that throws on its data has unmounted the shell by now
async function waitForRouteRead(page: Page, label: string): Promise<void> {
  await waitForRoute(page, label);
  await page.locator('#main-content [aria-busy="true"]').first().waitFor({ state: "detached", timeout: READY_TIMEOUT_MS });
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

// the statement on names (SR-3, SR-3b): the rail's sentence, the short form of every other view drawing names; both end alike
const STATEMENT = {
  FULL: "Session names are written by the sessions themselves and are not checked. Only the id identifies a session.",
  SHORT: "Names are self-written and unchecked. Only the id identifies a session.",
  END: "Only the id identifies a session.",
};

const DECISION = getRestFixture().items.find((item) => item.id === 103)!;
const SECOND_ACCOUNT = ".claude-personal";

// the first open item under a second account → the list tells two accounts apart and draws its Account filter
function getTwoAccountFixture(): QueueFixture {
  const rest = getRestFixture();
  const [first, ...others] = rest.items;
  return { ...rest, items: [{ ...first!, session: { ...first!.session, profileLabel: SECOND_ACCOUNT } }, ...others] };
}
const LONG_SCAN_READY = "2 of 3 lines assign a literal value.";

// every sheet kind in one list: the prose report, decision and relay, the relay read's refusal, a one-line and the three-line secret approval
const getEveryViewFixture = () => getScanApprovalFixture({ ...getProseFixture(), relays: getRelayThreadFixture() });
const SHEETS = [
  { name: "a decision", row: "#queue-row-103", ready: "Options" },
  { name: "a report", row: "#queue-row-101", ready: "마이그레이션 순서" },
  { name: "a relay", row: `#queue-row-${RELAY_ROW_IDS.one}`, ready: "응답 예시 표도 함께" },
  { name: "a refused relay", row: '.queue-row[aria-label^="Refused relay"]', ready: "Refused relay from" },
  { name: "a one-line secret approval", row: `#queue-row-${SCAN_IDS.one}`, ready: "The line assigns a literal value." },
  { name: "the three-line secret approval with its 4,000-character line", row: `#queue-row-${SCAN_IDS.long}`, ready: LONG_SCAN_READY },
];

async function openRowSheet(page: Page, row: string, ready: string): Promise<void> {
  await page.locator(row).tap();
  await page.locator(".queue-sheet").getByText(ready).first().waitFor({ timeout: READY_TIMEOUT_MS });
}

// a row's sheet on the phone, once it shows `ready`
function openSheet(page: Page, id: number, ready: string): Promise<void> {
  return openRowSheet(page, `#queue-row-${id}`, ready);
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
        const layoutByRoute: Record<string, { layout: number; isShown: boolean }> = {};
        for (const label of labels) {
          await page.locator(`${SIDEBAR} .nav-item[title="${label}"]`).tap();
          await waitForRouteRead(page, label);
          const { layout } = await getWidths(page);
          layoutByRoute[label] = { layout, isShown: (await getRouteMark(page, label).count()) === 1 };
        }
        await page.close();

        assert.deepEqual(layoutByRoute, Object.fromEntries(labels.map((label) => [label, { layout: DESKTOP_LAYOUT_WIDTH, isShown: true }])));
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

  // layout §7 pin 20: the phone's controls and dropped floors stay under 640
  describe("leaves the desktop as it was", () => {
    for (const viewport of [MIN_WINDOW, WIDE_WINDOW]) {
      test(`at ${viewport.width} the sidebar stays and the page draws none of the phone's controls, the Account filter in its bar`, async () => {
        harness.fixture = getTwoAccountFixture();
        const page = await openQueuePage(harness, viewport, getRestReadyText());
        const shown = {
          sidebar: await page.locator(SIDEBAR).isVisible(),
          menuButton: await page.getByRole("button", MENU_BUTTON).isVisible(),
          scopeTrigger: await page.getByRole("button", { name: SCOPE_TRIGGER }).isVisible(),
          ordersButton: await page.getByRole("button", ORDERS_BUTTON).isVisible(),
          viewBacks: await getShownCount(page.locator(".queue-sessions, .queue-orders").getByRole("button", BACK)),
          accountGlyph: await getShownCount(page.locator(".queue-list > .card-head").getByRole("button", { name: /^Account: / })),
          barAccount: await getShownCount(page.locator(".queue-list > .card-bar .filter-trigger")),
        };
        await page.close();

        assert.deepEqual(shown, { sidebar: true, menuButton: false, scopeTrigger: false, ordersButton: false, viewBacks: 0, accountGlyph: 0, barAccount: 1 });
      });
    }

    test("at 1100 the desk keeps its 1012 floor and its three panes, the page scrolling sideways instead", async () => {
      const page = await openQueuePage(harness, NARROW_WINDOW, getRestReadyText());
      const desk = await page.evaluate((panes) => {
        const node = document.querySelector<HTMLElement>(".queue-desk")!;
        return {
          minWidth: getComputedStyle(node).minWidth,
          isAtFloor: node.getBoundingClientRect().width >= 1012,
          shown: panes.filter((pane) => document.querySelector(pane)!.getClientRects().length > 0),
        };
      }, PANES);
      await page.close();

      assert.deepEqual(desk, { minWidth: "1012px", isAtFloor: true, shown: PANES });
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

  // the chrome above the first row: the remote banner, the header and each pane's head one line apiece, the cadence line out of sight until a check fails
  describe("keeps the top of the screen to one line per part", () => {
    const REMOTE_ORIGIN = "https://phone.remote.test";
    const DEVICE_LABEL = "Galaxy S26";
    const STATUS = ".queue-screen .page-head [role=status]";
    // the remote listener's page: an https origin the harness answers, this device's session read answered here
    const openRemoteQueuePage = async (viewport: Viewport) => {
      const page = await openShellPage(harness, viewport, "queue");
      await page.route(`${REMOTE_ORIGIN}/**`, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/remote/session") return route.fulfill({ json: { csrf: "c3Jm", device: { id: "3", label: DEVICE_LABEL } } });
        return route.fulfill({ response: await route.fetch({ url: `${harness.url}${url.pathname}${url.search}` }) });
      });
      await page.goto(`${REMOTE_ORIGIN}/#queue`, { waitUntil: "load" });
      await page.getByText(getRestReadyText()).first().waitFor({ timeout: READY_TIMEOUT_MS });
      await page.locator(".remote-banner").getByText(DEVICE_LABEL).waitFor({ timeout: READY_TIMEOUT_MS });
      return page;
    };

    for (const viewport of PHONES) {
      test(`at ${viewport.width} the remote banner is one 45 line: the device label in it, both acts 44 tall on one top, nothing past the screen`, async () => {
        const page = await openRemoteQueuePage(viewport);
        const banner = page.getByRole("complementary", { name: "Remote access" });
        const facts = await banner.evaluate((node) => {
          const acts = [...node.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
          return {
            height: Math.round(node.getBoundingClientRect().height),
            acts: acts.map((box) => box.height),
            isOneTop: Math.max(...acts.map((box) => box.top)) - Math.min(...acts.map((box) => box.top)) <= 1,
            isInside: [...node.querySelectorAll("*")].every((child) => child.getBoundingClientRect().right <= window.innerWidth + 0.5),
          };
        });
        const tree = await banner.ariaSnapshot();
        await page.close();

        assert.deepEqual({ ...facts, isNamed: tree.includes(`Remote device · ${DEVICE_LABEL}`) }, { height: 45, acts: [44, 44], isOneTop: true, isInside: true, isNamed: true });
      });

      // the owner's case: the Account filter in the list head, so the bar under it is the statement's line alone
      test(`at ${viewport.width} under the remote banner with two accounts the list's bar holds its statement alone and the first row starts at 220 or above`, async () => {
        harness.fixture = getTwoAccountFixture();
        const page = await openRemoteQueuePage(viewport);
        const bar = await page.locator(".queue-list > .card-bar").evaluate((node) => (node as HTMLElement).innerText.trim());
        const firstRowTop = await page.locator(".queue-list .queue-row").first().evaluate((node) => node.getBoundingClientRect().top);
        await page.close();

        assert.deepEqual({ bar, isFirstRowHigh: firstRowTop <= 220 }, { bar: STATEMENT.SHORT, isFirstRowHigh: true }, `first row at ${firstRowTop}`);
      });

      test(`at ${viewport.width} the header is one 44 line at the top, the title and the menu on one centre, the menu glyph on the column of Sessions' and every sheet's back arrow`, async () => {
        harness.fixture = getEveryViewFixture();
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        const getGlyphLeft = (selector: string) => page.locator(`${selector} svg`).evaluate((node) => node.getBoundingClientRect().left);
        const head = await page.locator(".queue-screen .page-head").evaluate((node) => {
          const centreOf = (box: DOMRect) => box.top + box.height / 2;
          const [title, menu] = [node.querySelector(".page-head-title")!, node.querySelector(".queue-menu")!].map((part) => part.getBoundingClientRect());
          return { top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height, isOneCentre: Math.abs(centreOf(title!) - centreOf(menu!)) <= 1 };
        });
        const menuGlyph = await getGlyphLeft(".queue-menu");
        await VIEWS[1]!.open(page);
        const backGlyphs: Record<string, number> = { Sessions: await getGlyphLeft(".queue-sessions .queue-view-back") };
        await page.locator(".queue-sessions").getByRole("button", BACK).tap();
        for (const sheet of SHEETS) {
          await openRowSheet(page, sheet.row, sheet.ready);
          backGlyphs[sheet.name] = await getGlyphLeft(".queue-sheet-head .queue-back > .btn");
          await page.locator(".queue-sheet-head .queue-back button").tap();
        }
        await page.close();

        const offColumn = Object.entries(backGlyphs).filter(([, left]) => Math.abs(menuGlyph - left) > 1).map(([name, left]) => `${name} ${left - menuGlyph}`);
        assert.deepEqual({ ...head, offColumn }, { top: 0, height: 44, isOneCentre: true, offColumn: [] });
      });

      test(`at ${viewport.width} the list, Sessions and Orders heads are each one 45 line, and the list's first row starts at 175 or above`, async () => {
        const page = await openQueuePage(harness, viewport, getRestReadyText());
        const firstRowTop = await page.locator(".queue-list .queue-row").first().evaluate((node) => node.getBoundingClientRect().top);
        const heads: Record<string, number> = {};
        for (const view of VIEWS) {
          await view.open(page);
          heads[view.name] = await page.locator(`${view.pane} .card-head`).first().evaluate((node) => Math.round(node.getBoundingClientRect().height));
          if (view.name !== "list") await page.locator(view.pane).getByRole("button", BACK).tap();
        }
        await page.close();

        assert.deepEqual({ heads, isFirstRowHigh: firstRowTop <= 175 }, { heads: { list: 45, Sessions: 45, Orders: 45 }, isFirstRowHigh: true });
      });

      // switching Sessions ↔ Orders → the title holds still, and each back target stays in its own head
      test(`at ${viewport.width} the Sessions and Orders titles sit at one height, each back arrow inside its own head`, async () => {
        const page = await openQueuePage(harness, viewport, getRestReadyText());
        const heads: Record<string, { titleTop: number; isBackInside: boolean }> = {};
        for (const view of VIEWS.slice(1)) {
          await view.open(page);
          heads[view.name] = await page.locator(`${view.pane} .card-head`).first().evaluate((head) => {
            const [box, title, back] = [head, head.querySelector(".card-title")!, head.querySelector(".queue-view-back")!].map((node) => node.getBoundingClientRect());
            return { titleTop: title!.top, isBackInside: back!.top >= box!.top - 0.5 && back!.bottom <= box!.bottom + 0.5 };
          });
          await page.locator(view.pane).getByRole("button", BACK).tap();
        }
        await page.close();

        const { Sessions, Orders } = heads;
        assert.deepEqual(
          { titleApart: Math.abs(Sessions!.titleTop - Orders!.titleTop) <= 1 ? 0 : Orders!.titleTop - Sessions!.titleTop, isBackInside: [Sessions!.isBackInside, Orders!.isBackInside] },
          { titleApart: 0, isBackInside: [true, true] },
        );
      });
    }

    test("the cadence line stays in the tree clipped to 1 px at rest, and a failed check shows it whole on its own line under the title", async () => {
      const page = await openQueuePage(harness, PHONE, getRestReadyText(), true);
      const getLine = () => page.locator(STATUS).evaluate((node) => {
        const [box, title] = [node.getBoundingClientRect(), document.querySelector(".queue-screen .page-head-title")!.getBoundingClientRect()];
        return { isClipped: box.width <= 1 && box.height <= 1, isUnderTitle: box.top >= title.bottom - 0.5, isInside: box.bottom <= window.innerHeight && box.right <= window.innerWidth };
      });
      try {
        const atRest = { ...(await getLine()), isInTree: (await page.locator(".queue-screen .page-head").ariaSnapshot()).includes("Checks every 15s") };
        harness.isListDown = true;
        await page.clock.fastForward(15_000);
        await page.locator(STATUS).filter({ hasText: "Not updated" }).waitFor({ timeout: READY_TIMEOUT_MS });
        const failed = await getLine();

        assert.deepEqual({ atRest: [atRest.isClipped, atRest.isInTree], failed }, { atRest: [true, true], failed: { isClipped: false, isUnderTitle: true, isInside: true } });
      } finally {
        harness.isListDown = false;
        await page.close();
      }
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

    // a quiet filter trigger as wide as its words; Orders a glyph button, edgeless as every glyph
    for (const viewport of PHONES) {
      test(`at ${viewport.width} the scope trigger draws All sessions whole with no edge at rest, and Orders has no edge either`, async () => {
        const page = await openQueuePage(harness, viewport, getRestReadyText());
        const facts = await page.locator(".queue-list > .card-head").evaluate((head) => {
          const words = head.querySelector(".queue-scope-words")!;
          const edgeOf = (selector: string) => getComputedStyle(head.querySelector(selector)!).borderTopColor;
          return { isWhole: words.scrollWidth === words.clientWidth, words: getComputedStyle(words, "::before").content, trigger: edgeOf(".queue-scope-trigger"), orders: edgeOf(".queue-orders-open") };
        });
        await page.close();

        const CLEAR = "rgba(0, 0, 0, 0)";
        assert.deepEqual([facts.isWhole, facts.words, facts.trigger, facts.orders], [true, '"All sessions"', CLEAR, CLEAR]);
      });
    }

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

  // every view and every sheet states once, under its head, that names are unchecked — the rail the full sentence, every other view and every sheet the short one
  // design note G3.6: what a glyph can say is a glyph on the phone, its words its name and tooltip; statements, the self mark and tags keep their words
  describe("draws a glyph for each control a glyph can say, named and titled by its words", () => {
    const ACCOUNT = { name: /^Account: / };
    const PLACES = [
      { name: "the list", open: VIEWS[0]!.open },
      { name: "Sessions", open: VIEWS[1]!.open },
      { name: "Orders", open: VIEWS[2]!.open },
      { name: "a decision's sheet", open: (page: Page) => openSheet(page, DECISION.id, DECISION.title) },
    ];
    // each drawn glyph button's faults: no name, no tooltip, not 44 square, words drawn, its Lucide glyph unresolved
    const getGlyphFaults = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".queue-screen .btn.icon")]
      .filter((node) => node.getClientRects().length > 0)
      .flatMap((node) => {
        const box = node.getBoundingClientRect();
        const faults = [
          !node.getAttribute("aria-label") && "no name", !node.title && "no tooltip", (Math.round(box.width) !== 44 || Math.round(box.height) !== 44) && `${box.width}x${box.height}`,
          node.innerText.trim() !== "" && "words drawn", node.querySelector("svg > *") === null && "no glyph",
        ].filter(Boolean);
        return faults.length === 0 ? [] : [`${node.className} "${node.getAttribute("aria-label")}": ${faults.join(", ")}`];
      }));
    // the drawn controls after the scope trigger in the list head, and the words a glyph took over if the list card still draws them
    const getHeadFacts = (page: Page) => page.locator(".queue-list").evaluate((card) => ({
      controls: [...card.querySelectorAll<HTMLElement>(":scope > .card-head button:not(.queue-scope-trigger)")].filter((node) => node.getClientRects().length > 0)
        .map((node) => ({ name: node.getAttribute("aria-label"), title: node.title, words: node.innerText.trim(), height: Math.round(node.getBoundingClientRect().height) })),
      words: ["Account", "Orders"].filter((word) => (card as HTMLElement).innerText.includes(word)),
    }));

    for (const place of PLACES) {
      test(`in ${place.name} every drawn glyph button is named, titled, 44 by 44 and draws its glyph with no words`, async () => {
        harness.fixture = getTwoAccountFixture();
        const page = await openPhoneQueue(harness);
        await place.open(page);
        const faults = await getGlyphFaults(page);
        await page.close();

        assert.deepEqual(faults, []);
      });
    }

    for (const viewport of PHONES) {
      test(`at ${viewport.width} with two accounts the list head ends in the Account filter's glyph and Orders' glyph, the card drawing neither word`, async () => {
        harness.fixture = getTwoAccountFixture();
        const page = await openQueuePage(harness, viewport, getRestReadyText());
        const facts = await getHeadFacts(page);
        await page.close();

        const glyph = (name: string) => ({ name, title: name, words: "", height: 44 });
        assert.deepEqual(facts, { controls: [glyph("Account: All"), glyph("Orders")], words: [] });
      });
    }

    test("an applied account draws its word beside the glyph, and picking All puts the glyph back alone", async () => {
      harness.fixture = getTwoAccountFixture();
      const page = await openShellPage(harness, PHONE, `queue?profile=${SECOND_ACCOUNT}`);
      await page.getByText(getRestReadyText()).first().waitFor({ timeout: READY_TIMEOUT_MS });
      const getAccount = () => page.locator(".queue-list > .card-head").getByRole("button", ACCOUNT).evaluate((node) => {
        const box = node.getBoundingClientRect();
        return { name: node.getAttribute("aria-label"), title: (node as HTMLElement).title, words: (node as HTMLElement).innerText.trim(), width: Math.round(box.width), height: Math.round(box.height) };
      });
      const applied = await getAccount();
      await page.locator(".queue-list > .card-head").getByRole("button", ACCOUNT).tap();
      await page.getByRole("menuitemradio", { name: "All" }).tap();
      await page.locator(".queue-list > .card-head").getByRole("button", { name: "Account: All" }).waitFor();
      const reset = await getAccount();
      await page.close();

      const name = `Account: ${SECOND_ACCOUNT}`;
      assert.deepEqual({ applied: { ...applied, width: applied.width > 44 }, reset }, {
        applied: { name, title: name, words: SECOND_ACCOUNT, width: true, height: 44 },
        reset: { name: "Account: All", title: "Account: All", words: "", width: 44, height: 44 },
      });
    });
  });

  describe("states once in each view and each sheet that names are unchecked, under its head", () => {
    const CLOSE_SHEET = ".queue-sheet-head .queue-back button";
    const PLACES = [
      { name: "list", statement: STATEMENT.SHORT, open: VIEWS[0]!.open, close: async () => undefined },
      { name: "Sessions", statement: STATEMENT.FULL, open: VIEWS[1]!.open, close: (page: Page) => page.locator(".queue-sessions").getByRole("button", BACK).tap() },
      { name: "Orders", statement: STATEMENT.SHORT, open: VIEWS[2]!.open, close: (page: Page) => page.locator(".queue-orders").getByRole("button", BACK).tap() },
      ...SHEETS.map((sheet) => ({ name: sheet.name, statement: STATEMENT.SHORT, open: (page: Page) => openRowSheet(page, sheet.row, sheet.ready), close: (page: Page) => page.locator(CLOSE_SHEET).tap() })),
    ];
    // every drawn statement, measured before and after each drawn scroller is scrolled to its end
    const getStatements = (page: Page) => page.evaluate((texts) => {
      const nodes = [...document.querySelectorAll<HTMLElement>(".queue-screen *")].filter((node) => texts.includes(node.textContent ?? "") && node.childElementCount === 0 && node.getClientRects().length > 0);
      const tops = nodes.map((node) => node.getBoundingClientRect().top);
      // the words on the statement's last line, read by each word's own box
      const getLastLineCount = (node: HTMLElement) => {
        const text = node.firstChild!;
        const wordTops = [...text.textContent!.matchAll(/\S+/g)].map((match) => {
          const range = document.createRange();
          range.setStart(text, match.index);
          range.setEnd(text, match.index + match[0].length);
          return range.getClientRects()[0]!.top;
        });
        return wordTops.filter((top) => Math.abs(top - Math.max(...wordTops)) < 0.5).length;
      };
      const lastLineCounts = nodes.map(getLastLineCount);
      for (const scroller of document.querySelectorAll<HTMLElement>(".queue-screen .card-body, .queue-thread")) scroller.scrollTop = scroller.scrollHeight;
      return nodes.map((node, index) => {
        const [box, card] = [node.getBoundingClientRect(), node.closest(".card")!];
        const [head, body] = [card.querySelector(":scope > .card-head")!.getBoundingClientRect(), card.querySelector(":scope > .card-body")!.getBoundingClientRect()];
        return {
          text: node.textContent, element: `${node.tagName.toLowerCase()} ${["fs-meta", "text-dim"].filter((name) => node.classList.contains(name)).join(" ")}`,
          isWhole: node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth && box.top >= 0 && box.bottom <= window.innerHeight,
          isPlain: node.closest('[aria-hidden="true"], [hidden], [title], [aria-live], [role="status"], [role="log"], [role="alert"]') === null,
          isBetweenHeadAndBody: box.top >= head.bottom - 0.5 && box.bottom <= body.top + 0.5, isFixed: Math.abs(box.top - tops[index]!) < 0.5,
          isLastWordAccompanied: lastLineCounts[index]! >= 2,
        };
      });
    }, [STATEMENT.FULL, STATEMENT.SHORT]);
    const getTreeCount = async (page: Page) => (await page.locator(".queue-screen").ariaSnapshot()).split(STATEMENT.END).length - 1;

    for (const viewport of PHONES) {
      test(`at ${viewport.width} each view and each sheet shows its one statement whole, plain and fixed, no word alone on its last line, and the decision's head still marks its name`, async () => {
        harness.fixture = getEveryViewFixture();
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        const shown: Record<string, unknown> = {};
        for (const place of PLACES) {
          await place.open(page);
          shown[place.name] = { statements: await getStatements(page), treeCount: await getTreeCount(page) };
          if (place.name === "a decision") shown["a decision head"] = (await page.locator(".queue-sheet-head").textContent())?.includes("(self-named)");
          await place.close(page);
        }
        await page.close();

        const getExpected = (text: string) => ({ text, element: "p fs-meta text-dim", isWhole: true, isPlain: true, isBetweenHeadAndBody: true, isFixed: true, isLastWordAccompanied: true });
        assert.deepEqual(shown, {
          ...Object.fromEntries(PLACES.map((place) => [place.name, { statements: [getExpected(place.statement)], treeCount: 1 }])),
          "a decision head": true,
        });
      });
    }
  });

  // layout §7 pin 5: the page and each drawn pane's body stay inside the screen; code and table boxes scroll inside themselves
  describe("scrolls nothing sideways in any view", () => {
    const PLACES = [...VIEWS.map(({ name, open }) => ({ name: `the ${name} view`, open })), ...SHEETS.map(({ name, row, ready }) => ({ name, open: (page: Page) => openRowSheet(page, row, ready) }))];
    for (const viewport of PHONES) {
      for (const place of PLACES) {
        test(`at ${viewport.width} in ${place.name} neither the page nor a drawn pane's body is wider than the screen`, async () => {
          harness.fixture = getEveryViewFixture();
          const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
          await place.open(page);
          const widths = await page.evaluate(() => {
            const bodies = [...document.querySelectorAll<HTMLElement>(":is(.queue-pane, .queue-orders-card) .card-body")].filter((body) => body.getClientRects().length > 0);
            return {
              isPageInside: document.scrollingElement!.scrollWidth <= document.documentElement.clientWidth,
              bodies: bodies.length,
              wide: bodies.filter((body) => body.scrollWidth > body.clientWidth).map((body) => `${body.parentElement!.className} ${body.scrollWidth}>${body.clientWidth}`),
            };
          });
          await page.close();

          assert.deepEqual({ isPageInside: widths.isPageInside, hasBody: widths.bodies > 0, wide: widths.wide }, { isPageInside: true, hasBody: true, wide: [] });
        });
      }
    }
  });

  // a styled scrollbar takes width on a touch phone, an unstyled one overlays; the harness's browser hides every bar → this one draws them
  describe("runs the list from edge to edge where the page's scrollbars take width", () => {
    let hiddenBarBrowser: Browser;

    before(async () => {
      hiddenBarBrowser = harness.browser;
      harness.browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
    });

    after(async () => {
      await harness.browser.close();
      harness.browser = hiddenBarBrowser;
    });

    // the list body's widths, its rows' right edges and whether the page fits its width
    const getScrollerWidths = (page: Page) => page.locator(".queue-list > .card-body").evaluate((body: HTMLElement) => ({
      isScrolling: body.scrollHeight > body.clientHeight,
      client: body.clientWidth,
      offset: body.offsetWidth,
      rowRights: [...new Set([...body.querySelectorAll(".queue-row")].map((row) => Math.round(row.getBoundingClientRect().right)))],
      isPageInside: document.scrollingElement!.scrollWidth <= document.documentElement.clientWidth,
    }));

    for (const viewport of PHONES) {
      test(`at ${viewport.width} on a touch screen the scrolling list's body and its rows reach the screen's right edge`, async () => {
        harness.fixture = getOffViewFixture();
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        const isCoarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
        const widths = await getScrollerWidths(page);
        await page.close();

        assert.deepEqual({ isCoarse, ...widths }, { isCoarse: true, isScrolling: true, client: viewport.width, offset: viewport.width, rowRights: [viewport.width], isPageInside: true });
      });
    }

    test("at 1440 with a mouse the scrolling list keeps the page's 10 scrollbar", async () => {
      harness.fixture = getOffViewFixture();
      const page = await openQueuePage(harness, { width: 1440, height: 600 }, getRestReadyText(harness.fixture));
      const widths = await getScrollerWidths(page);
      await page.close();

      assert.deepEqual({ isScrolling: widths.isScrolling, bar: widths.offset - widths.client }, { isScrolling: true, bar: 10 });
    });
  });

  describe("draws every list row as one 44 line: name 80 · title · tag 80 · age 32", () => {
    for (const viewport of PHONES) {
      // every row kind in one list: decisions, reports, secret approvals, relays on their way, Done rows and a refused relay
      test(`at ${viewport.width} every drawn row is one 44 line of one 20 title on the phone's columns, no fact and no chevron cell drawn`, async () => {
        harness.fixture = getScanApprovalFixture(getRelayListFixture(true));
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        await waitForDoneBands(page);
        const facts = await page.evaluate(() => {
          const rows = [...document.querySelectorAll<HTMLElement>(".queue-listbox .queue-row")].filter((row) => row.getClientRects().length > 0);
          const getCells = (selector: string) => rows.flatMap((row) => [...row.querySelectorAll<Element>(`:scope > ${selector}`)]);
          const getHeights = (nodes: Element[]) => [...new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().height)))];
          const getWidths = (selector: string) => [...new Set(getCells(selector).map((cell) => Math.round(cell.getBoundingClientRect().width)))];
          const getShownCount = (selector: string) => getCells(selector).filter((cell) => cell.getClientRects().length > 0).length;
          return {
            rowHeights: getHeights(rows), titleHeights: getHeights(getCells(".queue-row-title")),
            widths: { name: getWidths(".queue-row-who"), tag: getWidths(".queue-row-tag"), age: getWidths(".queue-row-age") },
            shown: { fact: getShownCount(".queue-row-fact"), chevron: getShownCount(".queue-row-chevron") },
          };
        });
        await page.close();

        assert.deepEqual(facts, { rowHeights: [44], titleHeights: [20], widths: { name: [80], tag: [80], age: [32] }, shown: { fact: 0, chevron: 0 } });
      });

      test(`at ${viewport.width} a self-named relay sender's mark lies whole inside the 80 name cell, and each relay's title starts with →`, async () => {
        harness.fixture = getSelfNamedFixture(getRelayRowFixture(), RELAY_ROW_IDS.one, "dashboard");
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        const rows = await page.evaluate((ids) => ids.map((id) => {
          const row = document.getElementById(`queue-row-${id}`)!;
          const cell = row.querySelector(":scope > .queue-row-who")!.getBoundingClientRect();
          const mark = row.querySelector<HTMLElement>(":scope > .queue-row-who .queue-row-mark");
          const box = mark?.getBoundingClientRect();
          return {
            titleStart: row.querySelector(":scope > .queue-row-title")!.textContent!.trimStart().charAt(0),
            isMarkInside: box !== undefined && box.left >= cell.left - 0.5 && box.right <= cell.right + 0.5 && mark!.scrollWidth <= mark!.clientWidth,
          };
        }), [RELAY_ROW_IDS.one, RELAY_ROW_IDS.several]);
        await page.close();

        assert.deepEqual(rows, [{ titleStart: "→", isMarkInside: true }, { titleStart: "→", isMarkInside: true }]);
      });
    }

    // the captured line's words and mark labels: the queue's list holds none of them, only its sheet's read does
    const getCapturedWords = (fixture: QueueFixture) => [...new Set(Object.values(fixture.scanReads ?? {})
      .flatMap((read) => read.lines.flatMap((line) => line.segments.map((segment) => ("text" in segment ? segment.text : segment.mark))))
      .flatMap((text) => text.match(/[\p{L}\p{N}+]{3,}/gu) ?? []))];
    const APPROVAL_TICKS = [
      { name: "with nothing ticked", scope: async () => undefined },
      {
        name: "with its session ticked",
        scope: async (page: Page) => {
          await VIEWS[1]!.open(page);
          await tickSessions(page, ["gersona"]);
          await page.locator(".queue-sessions").getByRole("button", BACK).tap();
        },
      },
    ];
    for (const viewport of PHONES) {
      for (const ticks of APPROVAL_TICKS) {
        test(`at ${viewport.width} ${ticks.name} a secret approval's tag cell holds Approval whole, an ended one Expired or Gone, and no row says a word of its captured lines`, async () => {
          harness.fixture = getScanApprovalFixture();
          const words = getCapturedWords(harness.fixture);
          const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
          await ticks.scope(page);
          const rows = await page.evaluate(({ ids, words }) => ids.map((id) => {
            const row = document.getElementById(`queue-row-${id}`)!;
            const cell = row.querySelector(":scope > .queue-row-tag")!.getBoundingClientRect();
            const badges = [...row.querySelectorAll<HTMLElement>(":scope > .queue-row-tag .pill")].filter((badge) => badge.getClientRects().length > 0);
            const said = [row.innerText, row.getAttribute("aria-label") ?? "", ...[row, ...row.querySelectorAll("[title]")].map((node) => node.getAttribute("title") ?? "")].join("\n");
            return {
              tag: badges.map((badge) => badge.innerText.trim()),
              isInside: badges.every((badge) => { const box = badge.getBoundingClientRect(); return box.left >= cell.left - 0.5 && box.right <= cell.right + 0.5 && badge.scrollWidth <= badge.clientWidth; }),
              said: words.filter((word) => said.includes(word)),
            };
          }), { ids: [SCAN_IDS.one, SCAN_IDS.long, SCAN_IDS.expired, SCAN_IDS.gone], words });
          await page.close();

          assert.ok(words.includes("hello") && words.includes("U+200B"), JSON.stringify(words));
          assert.deepEqual(rows, ["Approval", "Approval", "Expired", "Gone"].map((tag) => ({ tag: [tag], isInside: true, said: [] })));
        });
      }
    }
  });

  // each line's texts on one baseline: at most 0.5 apart, as a 1 px step shows at a phone's pixel ratio
  describe("sets each line of the phone layout on one baseline", () => {
    /** @property cells - per cell: "&" the line itself, "+" its next sibling, any other a selector inside the line */
    interface Line {
      name: string;
      lines: string;
      cells: string[];
    }
    const LIST_LINES: Line[] = [
      { name: "a list row's title, name, self mark, tag and age", lines: ".queue-listbox .queue-row", cells: [":scope > .queue-row-title", ".queue-row-name", ".queue-row-mark", ".queue-row-tag .pill", ".queue-row-kind", ":scope > .queue-row-age"] },
      { name: "a list band's label and its count or day", lines: ".queue-listbox .queue-band", cells: ["&", ":scope > *"] },
    ];
    const SHEET_LINES: Line[] = [
      { name: "the letterhead's kind and name", lines: ".queue-sheet-head .queue-letter", cells: [":scope > .pill", ".queue-letter-name"] },
      { name: "a fact's label and value", lines: ".queue-sheet .scan-facts > dt", cells: ["&", "+"] },
      { name: "a side label and its text", lines: ".queue-sheet .queue-option-sides > .queue-label", cells: ["&", "+"] },
      { name: "the foot's button row labels", lines: ".queue-sheet .queue-compose-buttons", cells: [":scope > .btn"] },
    ];
    // a line with two or more texts drawn → its spread: each text's first glyph box top + that glyph's font ascent, highest less lowest
    const getSpreads = (page: Page, lines: Line[]) => page.evaluate((lines) => {
      const context = document.createElement("canvas").getContext("2d")!;
      const getBaseline = (cell: Element) => {
        const isDrawn = (node: Node) => node.textContent!.trim() !== "" && node.parentElement!.getClientRects().length > 0 && node.parentElement!.closest(".sr-only") === null;
        const text = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, { acceptNode: (node) => (isDrawn(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) }).nextNode();
        if (text === null) return [];
        const start = text.textContent!.search(/\S/);
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + 1);
        // the computed font shorthand reads empty here → the canvas takes the parts
        const style = getComputedStyle(text.parentElement!);
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return [range.getClientRects()[0]!.top + context.measureText(text.textContent![start]!).fontBoundingBoxAscent];
      };
      const getCells = (line: Element, cell: string) => (cell === "&" ? [line] : cell === "+" ? [line.nextElementSibling!] : [...line.querySelectorAll(cell)]);
      return lines.map(({ name, lines: selector, cells }) => {
        const measured = [...document.querySelectorAll(selector)].filter((line) => line.getClientRects().length > 0)
          .map((line) => ({ text: line.textContent!.trim().slice(0, 24), baselines: cells.flatMap((cell) => getCells(line, cell)).flatMap(getBaseline) }))
          .filter((line) => line.baselines.length >= 2);
        const apart = measured.map((line) => ({ text: line.text, spread: Math.max(...line.baselines) - Math.min(...line.baselines) })).filter((line) => line.spread > 0.5);
        return { name, isMeasured: measured.length > 0, apart: apart.map((line) => `${line.text} ${line.spread.toFixed(2)}`) };
      });
    }, lines);

    for (const viewport of PHONES) {
      test(`at ${viewport.width} every list row and band holds its texts on one baseline`, async () => {
        harness.fixture = getSelfNamedFixture(getScanApprovalFixture(getRelayListFixture(true)), RELAY_ROW_IDS.one, "dashboard");
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        await waitForDoneBands(page);
        const spreads = await getSpreads(page, LIST_LINES);
        await page.close();

        assert.deepEqual(spreads, LIST_LINES.map(({ name }) => ({ name, isMeasured: true, apart: [] })));
      });

      test(`at ${viewport.width} every sheet's letterhead, facts, side labels and foot buttons hold their texts on one baseline`, async () => {
        harness.fixture = getEveryViewFixture();
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        const spreads = [];
        for (const sheet of SHEETS) {
          await openRowSheet(page, sheet.row, sheet.ready);
          spreads.push(...(await getSpreads(page, SHEET_LINES)).filter((line) => line.isMeasured).map((line) => ({ ...line, sheet: sheet.name })));
          await page.locator(".queue-sheet-head .queue-back button").tap();
        }
        await page.close();

        assert.deepEqual(
          { measured: [...new Set(spreads.map((line) => line.name))].sort(), apart: spreads.filter((line) => line.apart.length > 0) },
          { measured: SHEET_LINES.map((line) => line.name).sort(), apart: [] },
        );
      });
    }
  });

  describe("opens an item as one sheet, its head in two rows and its answer in reach of the thumb", () => {
    test("the head holds back, the count, previous and next on its first row and the letterhead whole across the second; previous and next 44 by 44, 4 apart", async () => {
      const page = await openPhoneQueue(harness);
      await openSheet(page, DECISION.id, DECISION.title);
      const head = await page.evaluate(() => {
        const getBox = (selector: string) => document.querySelector(`.queue-sheet-head ${selector}`)!.getBoundingClientRect();
        const row = [getBox(".queue-back > .btn"), getBox(".queue-steps > .tabular-nums"), getBox('[aria-label="Previous item"]'), getBox('[aria-label="Next item"]')];
        const [, , previous, next] = row;
        const title = document.querySelector(".queue-sheet-head > .card-title")!.getBoundingClientRect();
        // the back arrow steps into the head's inset (its glyph on the menu's column) → the letterhead spans the head's content box
        const sheetHead = document.querySelector<HTMLElement>(".queue-sheet-head")!;
        const contentLeft = sheetHead.getBoundingClientRect().left + parseFloat(getComputedStyle(sheetHead).paddingLeft);
        return {
          isFirstRowOneLine: Math.max(...row.map((box) => box.top)) < Math.min(...row.map((box) => box.bottom)),
          isLetterheadBelow: title.top >= Math.max(...row.map((box) => box.bottom)) - 0.5,
          isLetterheadAcross: Math.abs(title.left - contentLeft) < 0.5 && Math.abs(title.right - next!.right) < 0.5,
          steps: [previous, next].map((box) => [box!.width, box!.height]),
          apart: next!.left - previous!.right,
        };
      });
      await page.close();

      assert.deepEqual(head, { isFirstRowOneLine: true, isLetterheadBelow: true, isLetterheadAcross: true, steps: [[44, 44], [44, 44]], apart: 4 });
    });

    // the answered decision carrying the prose report's 30-line fence, its question unfolded → a body longer than the screen
    const getLongAnswerNotReceivedFixture = () => {
      const fixture = getAnswerNotReceivedFixture();
      const body = getProseFixture().items.find((item) => item.id === 101)!.body;
      return { ...fixture, items: fixture.items.map((item) => (item.id === 108 ? { ...item, body } : item)) };
    };
    // the decision's box, the approval's buttons alone, an answer not received with Resend answer alone
    const FEET = [
      { name: "a decision", getFixture: getRestFixture, id: DECISION.id, ready: DECISION.title, buttons: [/^Send answer/, /^Answer later$/], unfold: async () => undefined },
      {
        name: "a secret approval, no text box", getFixture: () => getScanApprovalFixture(), id: SCAN_IDS.long, ready: LONG_SCAN_READY, buttons: [/^Send answer/, /^Answer later$/],
        unfold: async () => undefined,
      },
      {
        name: "an answer not received", getFixture: getLongAnswerNotReceivedFixture, id: 108, ready: "Resend answer", buttons: [/^Resend answer$/],
        unfold: (page: Page) => page.locator(".queue-sheet .queue-fold").tap(),
      },
    ];
    for (const foot of FEET) {
      test(`on ${foot.name} the foot's buttons lie whole on the screen at the body's top and at its end`, async () => {
        harness.fixture = foot.getFixture();
        const page = await openQueuePage(harness, PHONE, getRestReadyText(harness.fixture));
        await openSheet(page, foot.id, foot.ready);
        await foot.unfold(page);
        const buttons = foot.buttons.map((name) => page.locator(".queue-sheet > .card-foot").getByRole("button", { name }));
        const isInView = () => Promise.all(buttons.map((button) => button.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth;
        })));
        const atTop = await isInView();
        const isBodyLong = await page.locator(".queue-sheet > .card-body").evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          window.scrollTo(0, document.scrollingElement!.scrollHeight);
          return node.scrollHeight > node.clientHeight;
        });
        const atEnd = await isInView();
        await page.close();

        assert.deepEqual({ atTop, atEnd, isBodyLong }, { atTop: foot.buttons.map(() => true), atEnd: foot.buttons.map(() => true), isBodyLong: true });
      });
    }

    // the foot top to bottom: the box across the foot, its note line, then one row of buttons, later first, ending 16 from the screen's edge
    const getFootRow = (page: Page) => page.locator(".queue-sheet > .card-foot").evaluate((foot) => {
      const box = foot.querySelector(".queue-compose-box")?.getBoundingClientRect();
      const note = foot.querySelector(".queue-note-text")!.getBoundingClientRect();
      const buttons = [...foot.querySelectorAll<HTMLElement>(".queue-composer button")].filter((button) => button.getClientRects().length > 0 && !button.closest(".queue-compose-box"));
      const boxes = buttons.map((button) => button.getBoundingClientRect());
      return {
        boxWidth: box && Math.round(box.width),
        isNoteUnderBox: !box || note.top >= box.bottom - 0.5,
        labels: buttons.map((button) => button.textContent!.trim().replace(/^(Send answer).*/, "$1")),
        heights: boxes.map((button) => button.height),
        sizes: new Set(buttons.map((button) => getComputedStyle(button).fontSize)).size,
        isOneRowUnderNote: Math.max(...boxes.map((button) => button.top)) - Math.min(...boxes.map((button) => button.top)) <= 1 && boxes[0]!.top >= note.bottom - 0.5,
        endGap: Math.round(window.innerWidth - boxes.at(-1)!.right),
      };
    });
    const withResend = () => ({ ...getRestFixture(), items: getRestFixture().items.map((item) => (item.id === DECISION.id ? { ...item, canResend: true } : item)) });
    const REPORT = getRestFixture().items.find((item) => item.id === 101)!;
    const ROWS = [
      { name: "a decision", getFixture: getRestFixture, id: DECISION.id, ready: DECISION.title, labels: ["Answer later", "Send answer"] },
      { name: "a decision with Resend", getFixture: withResend, id: DECISION.id, ready: DECISION.title, labels: ["Answer later", "Resend", "Send answer"] },
      { name: "an open report", getFixture: getRestFixture, id: REPORT.id, ready: REPORT.title, labels: ["Read later", "Mark as read", "Send order"] },
    ];
    for (const viewport of PHONES) {
      for (const row of ROWS) {
        test(`at ${viewport.width} on ${row.name} the box spans the foot, the note lies under it, and ${row.labels.join(", ")} share one last row of 44 in one type size, ending 16 from the edge`, async () => {
          harness.fixture = row.getFixture();
          const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
          await openSheet(page, row.id, row.ready);
          const foot = await getFootRow(page);
          await page.close();

          assert.deepEqual(foot, {
            boxWidth: viewport.width - 32, isNoteUnderBox: true, labels: row.labels, heights: row.labels.map(() => 44), sizes: 1, isOneRowUnderNote: true, endGap: 16,
          });
        });
      }
    }

    test("Tab goes from the box to Answer later to Send answer, and the sheet's tree holds one Answer later", async () => {
      const page = await openPhoneQueue(harness);
      await openSheet(page, DECISION.id, DECISION.title);
      await page.locator(".queue-sheet .queue-compose-box :is(textarea, button)").last().focus();
      const focused = [];
      for (const _ of [1, 2]) {
        await page.keyboard.press("Tab");
        focused.push(await page.evaluate(() => document.activeElement?.textContent?.trim().replace(/^(Send answer).*/, "$1")));
      }
      const laterCount = (await page.locator(".queue-sheet").ariaSnapshot()).split("Answer later").length - 1;
      await page.close();

      assert.deepEqual({ focused, laterCount }, { focused: ["Answer later", "Send answer"], laterCount: 1 });
    });

    test("the body's code blocks wrap inside their box and its tables scroll inside theirs", async () => {
      harness.fixture = getProseFixture();
      const page = await openQueuePage(harness, PHONE, getRestReadyText(harness.fixture));
      // the report holding a table and a 30-line fence
      const report = harness.fixture.items.find((item) => item.id === 101)!;
      await openSheet(page, report.id, report.title);
      const widths = await page.evaluate(() => {
        const body = document.querySelector<HTMLElement>(".queue-sheet > .card-body")!;
        const boxes = [...body.querySelectorAll<HTMLElement>(".prose-text :is(.prose-pre, .prose-table-frame)")];
        return {
          boxes: [...new Set(boxes.map((box) => box.className))].sort(),
          isEveryBoxInside: boxes.every((box) => box.getBoundingClientRect().right <= body.getBoundingClientRect().right + 0.5),
          isEveryTableScrolledInside: boxes.filter((box) => box.matches(".prose-table-frame")).every((box) => getComputedStyle(box).overflowX === "auto"),
        };
      });
      await page.close();

      assert.deepEqual(widths, { boxes: ["prose-pre", "prose-table-frame"], isEveryBoxInside: true, isEveryTableScrolledInside: true });
    });
  });

  // the 3-line and long-line captures at the bleed width (layout §5): every line whole on the plate, the plate inside the screen's 16 inset
  describe("draws the secret-approval card at the phone's width, every line whole", () => {
    for (const viewport of PHONES) {
      test(`at ${viewport.width} each plate wraps inside the screen's 16 inset, each mark a whole tile`, async () => {
        harness.fixture = getScanApprovalFixture();
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        await openSheet(page, SCAN_IDS.long, LONG_SCAN_READY);
        const shown = await page.evaluate((points) => {
          const plates = [...document.querySelectorAll<HTMLElement>(".queue-sheet .scan-plate")];
          const marks = [...document.querySelectorAll<HTMLElement>(".queue-sheet .scan-mark")];
          const texts = plates.flatMap((plate) => [...plate.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? ""));
          return {
            plates: plates.length,
            isEveryPlateInside: plates.every((plate) => plate.getBoundingClientRect().right <= document.documentElement.clientWidth - 16),
            isEveryPlateWhole: plates.every((plate) => plate.scrollWidth === plate.clientWidth && plate.scrollHeight === plate.clientHeight),
            isEveryPlateUncut: plates.every((plate) => { const style = getComputedStyle(plate); return style.textOverflow !== "ellipsis" && style.maxHeight === "none" && style.overflowX !== "auto"; }),
            isLongWrapped: plates[1]!.getBoundingClientRect().height > 20 * parseFloat(getComputedStyle(plates[1]!).lineHeight),
            isEveryTileWhole: marks.length > 0 && marks.every((mark) => mark.getClientRects().length === 1),
            hasRawMark: texts.some((text) => points.some((point) => text.includes(String.fromCodePoint(point)))),
          };
        }, [...SCAN_MARK_POINTS]);
        await page.close();

        assert.deepEqual(shown, { plates: 3, isEveryPlateInside: true, isEveryPlateWhole: true, isEveryPlateUncut: true, isLongWrapped: true, isEveryTileWhole: true, hasRawMark: false });
      });

      test(`at ${viewport.width} each line head is two rows: the cue and the length, then the classes below them`, async () => {
        harness.fixture = getScanApprovalFixture();
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        await openSheet(page, SCAN_IDS.long, LONG_SCAN_READY);
        const heads = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".queue-sheet .scan-line-head")].map((head) => {
          const [cue, length, classes] = [...head.children].map((cell) => cell.getBoundingClientRect());
          return { isLengthBesideCue: length!.top < cue!.bottom && length!.left >= cue!.right, isClassesBelow: classes!.top >= Math.max(cue!.bottom, length!.bottom) };
        }));
        await page.close();

        assert.deepEqual(heads, Array.from({ length: 3 }, () => ({ isLengthBesideCue: true, isClassesBelow: true })));
      });

      test(`at ${viewport.width} the Session fact starts with the whole session id and its text ends inside the screen's 16 inset`, async () => {
        harness.fixture = getScanApprovalFixture();
        const { session } = harness.fixture.items.find((item) => item.id === SCAN_IDS.long)!;
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        await openSheet(page, SCAN_IDS.long, LONG_SCAN_READY);
        const fact = await page.evaluate(() => {
          const label = [...document.querySelectorAll(".queue-sheet .scan-facts > dt")].find((dt) => dt.textContent === "Session")!;
          const value = label.nextElementSibling as HTMLElement;
          const range = document.createRange();
          range.selectNodeContents(value);
          return { first: value.firstElementChild?.matches("code.machine") ? value.firstElementChild.textContent : null, text: value.textContent, isInside: range.getBoundingClientRect().right <= document.documentElement.clientWidth - 16 };
        });
        await page.close();

        assert.deepEqual(fact, { first: session.id, text: `${session.id} ${session.name}`, isInside: true });
      });
    }
  });

  // every view of the phone layout (layout §6): a 44 target per control, type never under the 13 floor
  describe("keeps every target 44 and every text at 13 or more", () => {
    const PLACES = [
      { name: "the list", open: async () => undefined, prose: [] },
      { name: "Sessions", open: VIEWS[1]!.open, prose: [] },
      { name: "Orders", open: VIEWS[2]!.open, prose: [] },
      { name: "a decision's sheet", open: (page: Page) => openSheet(page, DECISION.id, DECISION.title), prose: ["15px"] },
      { name: "a secret approval's sheet", open: (page: Page) => openSheet(page, SCAN_IDS.long, LONG_SCAN_READY), prose: ["15px"] },
    ];
    // a tap target: buttons, disclosures, links outside running prose, list and rail rows; a box or a radio by the row or label that holds it
    const CONTROLS = 'button, summary, select, a[href], [role="button"], [role="option"], [role="menuitem"], label.queue-rail-row';
    const getSmallTargets = (page: Page, root: string) => page.evaluate(({ root, selector }) => [...document.querySelectorAll<HTMLElement>(`${root} :is(${selector})`)]
      .filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden" && !node.closest(".prose-text"))
      .map((node) => ({ node, box: node.getBoundingClientRect() }))
      .filter(({ node, box }) => box.height < 44 || (node.matches(".btn.icon") && box.width < 44))
      .map(({ node, box }) => `${node.tagName.toLowerCase()}.${node.className} "${(node.getAttribute("aria-label") ?? node.textContent ?? "").trim().slice(0, 30)}" ${Math.round(box.width)}x${Math.round(box.height)}`), { root, selector: CONTROLS });

    for (const place of PLACES) {
      test(`in ${place.name} every drawn control is at least 44 tall, an icon button 44 wide too`, async () => {
        harness.fixture = getScanApprovalFixture();
        const page = await openQueuePage(harness, PHONE, getRestReadyText(harness.fixture));
        await place.open(page);
        const small = await getSmallTargets(page, ".queue-screen");
        await page.close();

        assert.deepEqual(small, []);
      });

      test(`in ${place.name} no drawn text computes under 13 px, and an open item's prose computes 15`, async () => {
        harness.fixture = getScanApprovalFixture();
        const page = await openQueuePage(harness, PHONE, getRestReadyText(harness.fixture));
        await place.open(page);
        const sizes = await page.evaluate(() => {
          const texts = [...document.querySelectorAll<HTMLElement>(".queue-screen *")]
            .filter((node) => node.getClientRects().length > 0 && [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent!.trim() !== ""));
          return {
            small: texts.filter((node) => parseFloat(getComputedStyle(node).fontSize) < 13).map((node) => `${node.tagName.toLowerCase()}.${node.className} ${getComputedStyle(node).fontSize}`),
            prose: [...new Set([...document.querySelectorAll<HTMLElement>(".queue-sheet .prose-text, .queue-sheet .scan-cue")].map((node) => getComputedStyle(node).fontSize))],
          };
        });
        await page.close();

        assert.deepEqual(sizes, { small: [], prose: place.prose });
      });
    }

    test("in the menu every drawn control is at least 44 tall, an icon button 44 wide too", async () => {
      const page = await openPhoneQueue(harness);
      await page.getByRole("button", MENU_BUTTON).tap();
      await page.getByRole("dialog", MENU).waitFor();
      const small = await getSmallTargets(page, '[role="dialog"]');
      await page.close();

      assert.deepEqual(small, []);
    });
  });
});
