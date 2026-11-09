// Shared bar controls in a real browser: the filter trigger's menu-button keyboard contract, the filter bar's reset slot,
// and the roving choice sets (segmented range, tabs) — roles and keys as a keyboard or screen-reader user meets them.
// Runner: npx tsx --test test/ui.controls.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
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

interface FocusedItem { role: string | null; text: string; id: string }

let app: FastifyInstance;
let browser: Browser;
let serverUrl: string;

before(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/*", async () => ({ rows: [] }));
  serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await app?.close();
});

// page-side source as text → tsx never wraps its named helpers in __name(), which the page lacks
const MOUNT_FIXTURE = `(fixture) => {
  const { React, ReactDOM, UI } = window;
  const h = React.createElement;
  const SHOW = [{ key: 'open', label: 'Open' }, { key: 'closed', label: 'Closed' }, { key: 'all', label: 'All' }];
  const RESULT = [{ key: 'done', label: 'Done' }, { key: 'fail', label: 'Fail' }];
  const Filters = () => {
    const [show, setShow] = React.useState('closed');
    const [results, setResults] = React.useState([]);
    const toggle = (key) => setResults(results.includes(key) ? results.filter((k) => k !== key) : [...results, key]);
    const isApplied = show !== 'closed' || results.length > 0;
    return h('div', null,
      h('button', { type: 'button', id: 'before' }, 'Before'),
      h(UI.FilterBar, { label: 'Filters', isApplied, onReset: () => { setShow('closed'); setResults([]); } },
        h(UI.FilterTrigger, { axis: 'Show', value: SHOW.find((o) => o.key === show).label, options: SHOW, chosenKeys: [show], onPick: setShow }),
        h(UI.FilterTrigger, { axis: 'Result', kind: 'checkbox', value: results.length ? results.join(', ') : 'Any', options: RESULT, chosenKeys: results, onPick: toggle })),
      h('button', { type: 'button', id: 'after' }, 'After'));
  };
  const Range = () => {
    const [value, setValue] = React.useState('30d');
    return h(UI.Segmented, { label: 'Range', value, onChange: setValue,
      options: [{ key: '7d', label: '7d' }, { key: '30d', label: '30d' }, { key: '90d', label: '90d' }] });
  };
  const Views = () => {
    const [value, setValue] = React.useState('operator');
    return h('div', null,
      h(UI.Tabs, { id: 'views', label: 'Views', value, onChange: setValue,
        tabs: [{ key: 'operator', label: 'Operator' }, { key: 'instrumentation', label: 'Instrumentation' }, { key: 'history', label: 'History' }] }),
      h('div', UI.getTabPanelProps('views', value), 'Panel ' + value));
  };
  const fixtures = { filters: Filters, range: Range, views: Views };
  const host = document.body.appendChild(document.createElement('div'));
  host.id = 'fixture';
  ReactDOM.createRoot(host).render(h(fixtures[fixture]));
}`;

type FixtureKind = "filters" | "range" | "views";

async function openFixture(kind: FixtureKind): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${serverUrl}/#dashboard`, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean((window as unknown as { UI?: unknown; ReactDOM?: unknown }).UI && (window as unknown as { ReactDOM?: unknown }).ReactDOM), null, { timeout: 30_000 });
  await page.evaluate(`(${MOUNT_FIXTURE})(${JSON.stringify(kind)})`);
  await page.waitForSelector("#fixture [role]", { timeout: 30_000 });
  return page;
}

function readFocused(page: Page): Promise<FocusedItem> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    return { role: el.getAttribute("role"), text: el.textContent?.trim() ?? "", id: el.id };
  });
}

const showTrigger = (page: Page) => page.locator('#fixture [aria-haspopup="menu"]').first();
const resultTrigger = (page: Page) => page.locator('#fixture [aria-haspopup="menu"]').nth(1);

async function openShowMenu(page: Page, key = "Enter"): Promise<void> {
  await showTrigger(page).focus();
  await page.keyboard.press(key);
  await page.waitForSelector('#fixture [role="menu"]');
}

describe("filter trigger — menu-button contract", () => {
  for (const key of ["Enter", "Space", "ArrowDown"]) {
    test(`${key} on the trigger opens the menu with focus on the chosen value`, async () => {
      const page = await openFixture("filters");
      await openShowMenu(page, key);

      assert.equal(await showTrigger(page).getAttribute("aria-expanded"), "true");
      assert.deepEqual(await readFocused(page), { role: "menuitemradio", text: "✓Closed", id: "" });
      await page.close();
    });
  }

  test("the trigger names its axis and value without a colon, and only the chosen item is checked", async () => {
    const page = await openFixture("filters");
    await openShowMenu(page);
    const items = await page.locator('#fixture [role="menuitemradio"]').evaluateAll((nodes) =>
      nodes.map((node) => ({ checked: node.getAttribute("aria-checked"), text: node.textContent?.trim() })));

    assert.equal((await showTrigger(page).textContent())?.trim(), "ShowClosed");
    assert.deepEqual(items, [{ checked: "false", text: "Open" }, { checked: "true", text: "✓Closed" }, { checked: "false", text: "All" }]);
    await page.close();
  });

  test("arrows, Home and End move focus through the items and stop at the ends", async () => {
    const page = await openFixture("filters");
    await openShowMenu(page);
    const visited: string[] = [];
    for (const key of ["ArrowDown", "ArrowDown", "Home", "ArrowUp", "End"]) {
      await page.keyboard.press(key);
      visited.push((await readFocused(page)).text);
    }

    assert.deepEqual(visited, ["All", "All", "Open", "Open", "All"]);
    await page.close();
  });

  test("Escape closes the menu and returns focus to the trigger", async () => {
    const page = await openFixture("filters");
    await openShowMenu(page);
    await page.keyboard.press("Escape");

    assert.equal(await page.locator('#fixture [role="menu"]').count(), 0);
    assert.equal(await showTrigger(page).evaluate((el) => el === document.activeElement), true);
    await page.close();
  });

  test("Tab closes the menu and moves on to the next control on the bar", async () => {
    const page = await openFixture("filters");
    await openShowMenu(page);
    await page.keyboard.press("Tab");

    assert.equal(await page.locator('#fixture [role="menu"]').count(), 0);
    assert.equal(await resultTrigger(page).evaluate((el) => el === document.activeElement), true);
    await page.close();
  });

  test("picking a single-choice item applies it, closes the menu and returns focus to the trigger", async () => {
    const page = await openFixture("filters");
    await openShowMenu(page);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    assert.equal(await page.locator('#fixture [role="menu"]').count(), 0);
    assert.equal((await showTrigger(page).textContent())?.trim(), "ShowAll");
    assert.equal(await showTrigger(page).evaluate((el) => el === document.activeElement), true);
    await page.close();
  });

  test("picking a multi-choice item toggles its check and keeps the menu open on it", async () => {
    const page = await openFixture("filters");
    await resultTrigger(page).focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector('#fixture [role="menu"]');
    await page.keyboard.press("Space");

    assert.equal(await page.locator('#fixture [role="menu"]').count(), 1);
    assert.deepEqual(await readFocused(page), { role: "menuitemcheckbox", text: "✓Done", id: "" });
    assert.equal(await page.locator('#fixture [role="menuitemcheckbox"]').first().getAttribute("aria-checked"), "true");
    await page.close();
  });
});

describe("filter bar reset", () => {
  test("at defaults the reset is hidden and out of the Tab order, its slot kept", async () => {
    const page = await openFixture("filters");
    const reset = page.locator("#fixture button", { hasText: "Reset filters" });
    const box = await reset.boundingBox();
    await resultTrigger(page).focus();
    await page.keyboard.press("Tab");

    assert.equal(await reset.evaluate((el) => getComputedStyle(el).visibility), "hidden");
    assert.ok(box !== null && box.width > 0, "the hidden reset still holds its width");
    assert.equal((await readFocused(page)).id, "after");
    await page.close();
  });

  test("once a filter is applied the reset shows, and pressing it restores defaults with focus on the first trigger", async () => {
    const page = await openFixture("filters");
    await openShowMenu(page);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    const reset = page.locator("#fixture button", { hasText: "Reset filters" });
    const visibility = await reset.evaluate((el) => getComputedStyle(el).visibility);
    await reset.focus();
    await page.keyboard.press("Enter");

    assert.equal(visibility, "visible");
    assert.equal((await showTrigger(page).textContent())?.trim(), "ShowClosed");
    assert.equal(await showTrigger(page).evaluate((el) => el === document.activeElement), true);
    await page.close();
  });
});

const CHOICE_ROWS: Array<{ name: string; fixture: FixtureKind; group: string; item: string; state: string; start: string; next: string }> = [
  { name: "segmented range", fixture: "range", group: "radiogroup", item: "radio", state: "aria-checked", start: "30d", next: "90d" },
  { name: "tabs", fixture: "views", group: "tablist", item: "tab", state: "aria-selected", start: "Operator", next: "Instrumentation" },
];

describe("roving choice sets: one Tab stop on the chosen item, an arrow chooses and focuses the next", () => {
  for (const row of CHOICE_ROWS) {
    test(row.name, async () => {
      const page = await openFixture(row.fixture);
      const items = page.locator(`#fixture [role="${row.group}"] [role="${row.item}"]`);
      const tabStops = await items.evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).tabIndex === 0).map((node) => node.textContent));
      await page.locator("#fixture").evaluate((el) => (el.querySelector('[tabindex="0"]') as HTMLElement).focus());
      await page.keyboard.press("ArrowRight");
      const chosen = await items.evaluateAll((nodes, state) => nodes.filter((node) => node.getAttribute(state) === "true").map((node) => node.textContent), row.state);

      assert.deepEqual(tabStops, [row.start]);
      assert.deepEqual(chosen, [row.next]);
      const focused = await readFocused(page);
      assert.deepEqual([focused.role, focused.text], [row.item, row.next]);
      await page.close();
    });
  }

  test("each tab controls the one panel, which names the chosen tab", async () => {
    const page = await openFixture("views");
    const tab = page.locator('#fixture [role="tab"][aria-selected="true"]');
    const panel = page.locator('#fixture [role="tabpanel"]');

    assert.equal(await tab.getAttribute("aria-controls"), await panel.getAttribute("id"));
    assert.equal(await panel.getAttribute("aria-labelledby"), await tab.getAttribute("id"));
    await page.close();
  });
});
