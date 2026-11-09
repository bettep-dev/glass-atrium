// The one focus rule read in the running app: a ring shows exactly where :focus-visible matches, so a mouse move draws none
// and a keyboard move draws the shared ring — route headings, popovers, drawers, in-row controls and disclosures alike.
// Runner: npx tsx --test test/app.focus-ring.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify serving the model config below; every other /api read answers empty.
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
const MODEL = "claude-opus-5-5";

// one model tier carrying agent files → the screen draws its files disclosure
const CONFIG = {
  domains: [{
    domain: "model.dev", desired: MODEL, actual: MODEL, drift: false, apply_mode: "next-spawn", editable: true, pricing_known: true,
    files: ["glass-atrium-dev-front.md", "glass-atrium-dev-react.md"].map((file) => ({ file, model: MODEL })),
  }],
  budgets: [],
  tiers: [],
  known_models: [MODEL],
  daemon_config_sync: "ok",
};

interface FocusReading { tag: string; label: string; isFocusVisible: boolean; outline: string }

let app: FastifyInstance;
let browser: Browser;
let serverUrl: string;

before(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/model-config", async () => CONFIG);
  app.get("/api/*", async () => ({ rows: [] }));
  serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await app?.close();
});

async function openApp(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${serverUrl}/#model-config`, { waitUntil: "load" });
  await page.waitForSelector("summary.disclosure.pill--interactive", { timeout: 30_000 });
  return page;
}

async function readFocus(page: Page): Promise<FocusReading> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    return {
      tag: el.tagName,
      label: el.getAttribute("aria-label") ?? el.getAttribute("role") ?? el.textContent?.trim() ?? "",
      isFocusVisible: el.matches(":focus-visible"),
      outline: getComputedStyle(el).outlineStyle,
    };
  });
}

// a fixture mounted beside the app on the page's own React and window.UI, so it runs the shipped components;
// page-side source as text → tsx never wraps its named helpers in __name(), which the page lacks
const MOUNT_FIXTURE = `(fixture) => {
  const { React, ReactDOM, UI } = window;
  const h = React.createElement;
  const Drawer = () => {
    const [index, setIndex] = React.useState(0);
    const nav = { onPrev: () => setIndex(index - 1), onNext: () => setIndex(index + 1), hasPrev: index > 0, hasNext: index < 3 };
    return h(UI.DetailSurface, { open: true, onClose: () => {}, title: 'Record ' + (index + 1), nav }, h('p', null, 'Record body ' + (index + 1)));
  };
  const OnTrigger = ({ variant }) => {
    const [isOpen, setIsOpen] = React.useState(false);
    return h(React.Fragment, null,
      h('button', { type: 'button', id: 'open-record', onClick: () => setIsOpen(true) }, 'Open record'),
      isOpen && h(UI.DetailSurface, { open: true, variant, onClose: () => setIsOpen(false), title: 'Record 1' }, h('p', null, 'Record body 1')));
  };
  const Rows = () => {
    const [activeIndex, setActiveIndex] = React.useState(0);
    const rowOf = (index) => h('tr', { key: index, ...UI.getRowFocusProps({ index, activeIndex, count: 2, onActiveChange: setActiveIndex }) },
      h('td', { id: 'row-' + index }, 'Run ' + (index + 1)),
      h('td', null, h('button', { type: 'button', ...UI.ROW_CONTROL_PROPS }, 'Open')));
    return h('table', null, h('tbody', null, rowOf(0), rowOf(1)));
  };
  const fixtures = {
    popover: () => h(UI.Popover, { label: 'Filters' }, h('button', { type: 'button' }, 'Apply')),
    drawer: () => h(Drawer),
    'drawer-on-trigger': () => h(OnTrigger, { variant: 'drawer' }),
    'fullscreen-on-trigger': () => h(OnTrigger, { variant: 'fullscreen' }),
    rows: () => h(Rows),
  };
  const host = document.body.appendChild(document.createElement('div'));
  host.id = 'fixture';
  ReactDOM.createRoot(host).render(fixtures[fixture]());
}`;

type FixtureKind = "popover" | "drawer" | "drawer-on-trigger" | "fullscreen-on-trigger" | "rows";

async function mountFixture(page: Page, kind: FixtureKind): Promise<void> {
  await page.evaluate(`(${MOUNT_FIXTURE})(${JSON.stringify(kind)})`);
}

// px by which the focused element's outline crosses each viewport edge → 0 on every side = the whole ring on screen
async function readRingOverflow(page: Page): Promise<Record<"top" | "right" | "bottom" | "left", number>> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
    const box = el.getBoundingClientRect();
    const { clientWidth, clientHeight } = document.documentElement;
    return {
      top: Math.max(0, reach - box.top),
      right: Math.max(0, box.right + reach - clientWidth),
      bottom: Math.max(0, box.bottom + reach - clientHeight),
      left: Math.max(0, reach - box.left),
    };
  });
}

const SURFACE_RING_ROWS: Array<{ name: string; fixture: FixtureKind }> = [
  { name: "a drawer flush with the right edge at full height", fixture: "drawer-on-trigger" },
  { name: "a fullscreen surface at full height", fixture: "fullscreen-on-trigger" },
];

describe("a detail surface opened by Enter focuses its panel with the shared ring, drawn whole inside the viewport", () => {
  for (const row of SURFACE_RING_ROWS) {
    test(row.name, async () => {
      const page = await openApp();
      await mountFixture(page, row.fixture);
      await page.focus("#open-record");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "dialog", null, { timeout: 30_000 });
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)).then(() => undefined));

      assert.deepEqual(await readFocus(page), { tag: "DIV", label: "Record 1", isFocusVisible: true, outline: "solid" });
      assert.deepEqual(await readRingOverflow(page), { top: 0, right: 0, bottom: 0, left: 0 });
      await page.close();
    });
  }
});

describe("focus after a mouse move draws no ring, after a keyboard move draws the shared ring", () => {
  test("a nav click moves focus to the new route's h1 without a ring", async () => {
    const page = await openApp();
    await page.click("button.nav-item:not(.active)");
    await page.waitForFunction(() => document.activeElement?.tagName === "H1", null, { timeout: 30_000 });

    assert.deepEqual(await readFocus(page).then(({ isFocusVisible, outline }) => ({ isFocusVisible, outline })), { isFocusVisible: false, outline: "none" });
    await page.close();
  });

  test("ArrowRight from a mouse-focused row moves into its control and rings it", async () => {
    const page = await openApp();
    await mountFixture(page, "rows");
    await page.click("#row-0");
    await page.keyboard.press("ArrowRight");

    assert.deepEqual(await readFocus(page), { tag: "BUTTON", label: "Open", isFocusVisible: true, outline: "solid" });
    await page.close();
  });

  test("a popover opened by a mouse click focuses its panel without a ring", async () => {
    const page = await openApp();
    await mountFixture(page, "popover");
    await page.click("#fixture button[aria-haspopup='dialog']");

    assert.deepEqual(await readFocus(page), { tag: "DIV", label: "Filters", isFocusVisible: false, outline: "none" });
    await page.close();
  });

  test("a popover opened by Enter focuses its panel with the ring", async () => {
    const page = await openApp();
    await mountFixture(page, "popover");
    await page.focus("#fixture button[aria-haspopup='dialog']");
    await page.keyboard.press("Enter");

    assert.deepEqual(await readFocus(page), { tag: "DIV", label: "Filters", isFocusVisible: true, outline: "solid" });
    await page.close();
  });

  test("a mouse click on the drawer's Next record button walks the record and draws no ring", async () => {
    const page = await openApp();
    await mountFixture(page, "drawer");
    await page.click("[aria-label='Next record']");

    assert.equal(await page.textContent(".detail-title"), "Record 2");
    assert.deepEqual(await readFocus(page), { tag: "BUTTON", label: "Next record", isFocusVisible: false, outline: "none" });
    await page.close();
  });

  test("a mouse click on the model files disclosure opens it and draws no ring", async () => {
    const page = await openApp();
    await page.click("summary.disclosure.pill--interactive");

    assert.equal(await page.$eval("summary.disclosure.pill--interactive", (el) => (el.parentElement as HTMLDetailsElement).open), true);
    const { tag, isFocusVisible, outline } = await readFocus(page);
    assert.deepEqual({ tag, isFocusVisible, outline }, { tag: "SUMMARY", isFocusVisible: false, outline: "none" });
    await page.close();
  });
});
