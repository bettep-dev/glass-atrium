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
    'popover-in-view': () => h('div', { style: { position: 'fixed', top: '160px', right: '560px' } },
      h(UI.Popover, { label: 'Filters' }, h('button', { type: 'button' }, 'Apply'))),
    drawer: () => h(Drawer),
    'drawer-on-trigger': () => h(OnTrigger, { variant: 'drawer' }),
    'fullscreen-on-trigger': () => h(OnTrigger, { variant: 'fullscreen' }),
    'confirm-on-trigger': () => h(OnTrigger, { variant: 'confirm' }),
    rows: () => h(Rows),
  };
  const host = document.body.appendChild(document.createElement('div'));
  host.id = 'fixture';
  ReactDOM.createRoot(host).render(fixtures[fixture]());
}`;

type FixtureKind = "popover" | "popover-in-view" | "drawer" | "drawer-on-trigger" | "fullscreen-on-trigger" | "confirm-on-trigger" | "rows";

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

async function openSurfaceByEnter(page: Page, fixture: FixtureKind): Promise<void> {
  await mountFixture(page, fixture);
  await page.focus("#open-record");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "dialog", null, { timeout: 30_000 });
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)).then(() => undefined));
}

const SURFACE_RING_ROWS: Array<{ name: string; fixture: FixtureKind }> = [
  { name: "a drawer flush with the right edge at full height", fixture: "drawer-on-trigger" },
  { name: "a fullscreen surface at full height", fixture: "fullscreen-on-trigger" },
  { name: "a confirm panel centred on the scrim", fixture: "confirm-on-trigger" },
];

describe("a detail surface opened by Enter focuses its panel with the shared ring, drawn inset and whole inside the viewport", () => {
  for (const row of SURFACE_RING_ROWS) {
    test(row.name, async () => {
      const page = await openApp();
      await openSurfaceByEnter(page, row.fixture);

      assert.deepEqual(await readFocus(page), { tag: "DIV", label: "Record 1", isFocusVisible: true, outline: "solid" });
      assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement as HTMLElement).outlineOffset), "-2px");
      assert.deepEqual(await readRingOverflow(page), { top: 0, right: 0, bottom: 0, left: 0 });
      await page.close();
    });
  }
});

type Side = "top" | "right" | "bottom" | "left";
type Rgba = [number, number, number, number];

// per side, the background stack painted under the ring's centre line (topmost first) → what the ring pixels replace when focus lands
async function readRingGround(page: Page): Promise<{ ring: string; ground: Record<Side, string[]> }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth) / 2;
    const box = el.getBoundingClientRect();
    const midX = (box.left + box.right) / 2;
    const midY = (box.top + box.bottom) / 2;
    const points = { top: [midX, box.top - reach], right: [box.right + reach, midY], bottom: [midX, box.bottom + reach], left: [box.left - reach, midY] };
    const ground = Object.fromEntries(Object.entries(points).map(([side, [x, y]]) =>
      [side, document.elementsFromPoint(x, y).map((node) => getComputedStyle(node).backgroundColor)]));
    return { ring: style.outlineColor, ground: ground as Record<"top" | "right" | "bottom" | "left", string[]> };
  });
}

function parseColor(color: string): Rgba {
  const [r, g, b, a = 1] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return [r, g, b, a];
}

// topmost-first stack → one colour; caller asserts an opaque layer exists, so the empty start never shows through
function compositeStack(stack: string[]): Rgba {
  return stack.map(parseColor).reduceRight<Rgba>(([br, bg, bb], [r, g, b, a]) =>
    [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1], [0, 0, 0, 0]);
}

// WCAG 2.2 relative luminance + contrast ratio
function getContrast([r1, g1, b1]: Rgba, [r2, g2, b2]: Rgba): number {
  const luminance = (r: number, g: number, b: number) => {
    const [lr, lg, lb] = [r, g, b].map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  };
  const [high, low] = [luminance(r1, g1, b1), luminance(r2, g2, b2)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

const RING_CONTRAST_ROWS = (["light", "dark"] as const).flatMap((theme) => [
  { theme, surface: "drawer", fixture: "drawer-on-trigger" as FixtureKind },
  { theme, surface: "fullscreen", fixture: "fullscreen-on-trigger" as FixtureKind },
  { theme, surface: "confirm", fixture: "confirm-on-trigger" as FixtureKind },
  { theme, surface: "popover", fixture: "popover-in-view" as FixtureKind },
]);

describe("a keyboard-focused panel ring reaches 3:1 against the colours it is drawn on, on every side, in both themes (WCAG 1.4.11)", () => {
  for (const row of RING_CONTRAST_ROWS) {
    test(`${row.surface} in the ${row.theme} theme`, async () => {
      const page = await openApp();
      // data-theme = the attribute tweaks.theme writes
      await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), row.theme);
      if (row.fixture === "popover-in-view") {
        await mountFixture(page, row.fixture);
        await page.focus("#fixture button[aria-haspopup='dialog']");
        await page.keyboard.press("Enter");
      } else {
        await openSurfaceByEnter(page, row.fixture);
      }

      const { ring, ground } = await readRingGround(page);
      const unpainted = Object.entries(ground).filter(([, stack]) => !stack.some((color) => parseColor(color)[3] === 1));
      assert.deepEqual(unpainted, [], "every ring side lies on screen over an opaque layer");
      const contrast = Object.fromEntries(Object.entries(ground).map(([side, stack]) =>
        [side, Number(getContrast(parseColor(ring), compositeStack(stack)).toFixed(2))]));
      const failing = Object.entries(contrast).filter(([, ratio]) => ratio < 3);
      assert.deepEqual(failing, [], `ring ${ring} vs ground per side ${JSON.stringify(contrast)}`);
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
