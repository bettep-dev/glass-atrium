// Shared bar controls and layout primitives in a real browser: the filter trigger's menu-button keyboard contract, the filter bar's reset slot,
// the roving choice sets (segmented range, tabs), one box per control in every state, and spacing on role tokens.
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

import { createControlProbe, isSameBox } from "./lib/control-probe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");

interface FocusedItem { role: string | null; text: string; id: string }
interface LayoutUI { Stack: (props: { gap: unknown }) => unknown; Cluster: (props: { gap: unknown }) => unknown }

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
  const Atoms = () => {
    const [query, setQuery] = React.useState('');
    const [model, setModel] = React.useState('opus');
    return h(UI.Stack, { gap: 'block' },
      h(UI.Cluster, { gap: 'control' },
        h(UI.BarSearch, { label: 'Search outcomes', value: query, onChange: setQuery, placeholder: 'Search' }),
        h(UI.QuietButton, { icon: 'refresh', onClick: () => {} }, 'Refresh')),
      h('p', null, 'Read the ', h(UI.Link, { href: '#outcomes' }, 'Task results')),
      h(UI.Select, { id: 'model', label: 'Model', value: model, onChange: setModel,
        options: [{ key: 'opus', label: 'Opus' }, { key: 'sonnet', label: 'Sonnet' }] }),
      h('p', null, 'Commit ', h(UI.MachineString, null, '1a251d81')));
  };
  const Gaps = () => h('div', { id: 'gaps' },
    ['block', 'label', 'stack', 'list'].map((gap) => h(UI.Stack, { key: gap, gap }, h('div', null, 'a'), h('div', null, 'b'))),
    ['control', 'control-group'].map((gap) => h(UI.Cluster, { key: gap, gap }, h('span', null, 'a'), h('span', null, 'b'))));
  const fixtures = { filters: Filters, range: Range, views: Views, atoms: Atoms, gaps: Gaps };
  const host = document.body.appendChild(document.createElement('div'));
  host.id = 'fixture';
  ReactDOM.createRoot(host).render(h(fixtures[fixture]));
}`;

type FixtureKind = "filters" | "range" | "views" | "atoms" | "gaps";

async function openFixture(kind: FixtureKind): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${serverUrl}/#dashboard`, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean((window as unknown as { UI?: unknown; ReactDOM?: unknown }).UI && (window as unknown as { ReactDOM?: unknown }).ReactDOM), null, { timeout: 30_000 });
  await page.evaluate(`(${MOUNT_FIXTURE})(${JSON.stringify(kind)})`);
  await page.waitForSelector("#fixture > *", { timeout: 30_000 });
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
  test("at defaults the reset is hidden and out of the Tab order", async () => {
    const page = await openFixture("filters");
    const reset = page.locator("#fixture button", { hasText: "Reset filters" });
    await resultTrigger(page).focus();
    await page.keyboard.press("Tab");

    assert.equal(await reset.evaluate((el) => getComputedStyle(el).visibility), "hidden");
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

  test("the hidden reset holds the box it shows in, so its neighbours stay still", async () => {
    const page = await openFixture("filters");
    const reset = "#fixture .filter-bar button:not([aria-haspopup])";
    // offsets from the bar's own corner → the app loading above the fixture cannot move the frame
    const readLayout = () => page.locator("#fixture .filter-bar").evaluate((bar) => {
      const frame = bar.getBoundingClientRect();
      const boxes = [bar.querySelector("button:not([aria-haspopup])"), document.getElementById("after")].map((el) => (el as HTMLElement).getBoundingClientRect());
      return [frame.width, frame.height, ...boxes.flatMap((box) => [box.left - frame.left, box.top - frame.top, box.width, box.height])];
    });
    const atDefaults = await readLayout();
    await openShowMenu(page);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    assert.equal(await page.locator(reset).evaluate((el) => getComputedStyle(el).visibility), "visible");
    assert.deepEqual(await readLayout(), atDefaults);
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

  test("only the selected tab reads in ink over a 2px inset underline", async () => {
    const page = await openFixture("views");
    const ink = await page.evaluate(() => `rgb(${getComputedStyle(document.documentElement).getPropertyValue("--ink").trim().split(/\s+/).join(", ")})`);
    const looks = await page.locator('#fixture [role="tab"]').evaluateAll((nodes) => nodes.map((node) => ({
      selected: node.getAttribute("aria-selected"), color: getComputedStyle(node).color, shadow: getComputedStyle(node).boxShadow })));

    for (const look of looks) {
      const isSelected = look.selected === "true";
      assert.equal(look.shadow, isSelected ? `${ink} 0px -2px 0px 0px inset` : "none", `tab selected=${look.selected} underline`);
      assert.equal(look.color === ink, isSelected, `tab selected=${look.selected} colour ${look.color}`);
    }
    await page.close();
  });

  test("each tab controls the one panel, which names the chosen tab", async () => {
    const page = await openFixture("views");
    const tab = page.locator('#fixture [role="tab"][aria-selected="true"]');
    const panel = page.locator('#fixture [role="tabpanel"]');

    assert.equal(await tab.getAttribute("aria-controls"), await panel.getAttribute("id"));
    assert.equal(await panel.getAttribute("aria-labelledby"), await tab.getAttribute("id"));
    await page.close();
  });
});

async function openProbedFixture(kind: FixtureKind) {
  const page = await openFixture(kind);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  return { page, probe: createControlProbe(() => page, () => cdp) };
}

const CONTROL_ROWS: Array<{ name: string; fixture: FixtureKind; selector: string }> = [
  { name: "filter trigger", fixture: "filters", selector: "#fixture .filter-trigger" },
  { name: "reset filters", fixture: "filters", selector: "#fixture .filter-bar button:not([aria-haspopup])" },
  { name: "segmented option", fixture: "range", selector: '#fixture [role="radio"][aria-checked="false"]' },
  { name: "tab", fixture: "views", selector: '#fixture [role="tab"][aria-selected="false"]' },
  { name: "quiet button", fixture: "atoms", selector: "#fixture button" },
  { name: "form select", fixture: "atoms", selector: "#fixture select" },
  { name: "bar search field", fixture: "atoms", selector: "#fixture .bar-search-field" },
];

describe("controls: one box in every state, a 24px+ target", () => {
  for (const row of CONTROL_ROWS) {
    test(`${row.name} keeps its box at rest, hover, focus-visible and active`, async () => {
      const { page, probe } = await openProbedFixture(row.fixture);
      await probe.assertBoxHeldAcrossStates(row.selector);
      await page.close();
    });

    test(`${row.name} is a 24px+ target`, async () => {
      const { page, probe } = await openProbedFixture(row.fixture);
      const box = await probe.readBox(row.selector);

      assert.ok(box.width >= 24 && box.height >= 24, `${box.width}x${box.height}`);
      await page.close();
    });
  }

  for (const row of CHOICE_ROWS) {
    test(`choosing a ${row.name} item keeps every item's box`, async () => {
      const page = await openFixture(row.fixture);
      const items = page.locator(`#fixture [role="${row.item}"]`);
      const readSizes = () => items.evaluateAll((nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return [r.width, r.height]; }));
      const before = await readSizes();
      await page.locator("#fixture").evaluate((el) => (el.querySelector('[tabindex="0"]') as HTMLElement).focus());
      await page.keyboard.press("ArrowRight");

      assert.deepEqual(await readSizes(), before);
      await page.close();
    });
  }

  test("opening the filter trigger keeps its box", async () => {
    const { page, probe } = await openProbedFixture("filters");
    const closed = await probe.readBox("#fixture .filter-trigger");
    await openShowMenu(page);
    const open = await probe.readBox("#fixture .filter-trigger");

    assert.ok(isSameBox(open, closed), `open ${open.width}x${open.height} vs closed ${closed.width}x${closed.height}`);
    await page.close();
  });

  test("bar search keeps its box while the field takes focus", async () => {
    const { page, probe } = await openProbedFixture("atoms");
    const rest = await probe.readBox("#fixture .bar-search");
    await page.locator("#fixture").getByRole("searchbox", { name: "Search outcomes" }).focus();
    const focused = await probe.readBox("#fixture .bar-search");

    assert.ok(isSameBox(focused, rest), `focused ${focused.width}x${focused.height} vs resting ${rest.width}x${rest.height}`);
    await page.close();
  });
});

const BAR_CONTROL_ROWS: Array<{ name: string; fixture: FixtureKind; selector: string }> = [
  { name: "filter trigger", fixture: "filters", selector: "#fixture .filter-trigger" },
  { name: "reset filters", fixture: "filters", selector: "#fixture .filter-bar button:not([aria-haspopup])" },
  { name: "segmented track", fixture: "range", selector: '#fixture [role="radiogroup"]' },
  { name: "bar search", fixture: "atoms", selector: "#fixture .bar-search" },
];

describe("bar controls draw no edge at rest", () => {
  for (const row of BAR_CONTROL_ROWS) {
    test(row.name, async () => {
      const page = await openFixture(row.fixture);
      const edge = await page.locator(row.selector).first().evaluate((el) => {
        const style = getComputedStyle(el);
        return { width: style.borderTopWidth, color: style.borderTopColor };
      });

      assert.ok(edge.width === "0px" || edge.color === "rgba(0, 0, 0, 0)", `${row.name} edge ${edge.width} ${edge.color}`);
      await page.close();
    });
  }
});

describe("menu surface on role tokens", () => {
  test("its inset equals --card-pad and its item gap equals --gap-list", async () => {
    const page = await openFixture("filters");
    await openShowMenu(page);
    const metrics = await page.locator('#fixture [role="menu"]').evaluate((menu) => {
      const root = getComputedStyle(document.documentElement);
      const style = getComputedStyle(menu);
      const boxes = [...menu.querySelectorAll('[role^="menuitem"]')].map((el) => el.getBoundingClientRect());
      return {
        inset: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        cardPad: root.getPropertyValue("--card-pad").trim(),
        gaps: boxes.slice(1).map((box, i) => box.top - boxes[i].bottom),
        gapList: parseFloat(root.getPropertyValue("--gap-list")),
      };
    });

    assert.deepEqual(metrics.inset, Array(4).fill(metrics.cardPad));
    assert.deepEqual(metrics.gaps, Array(metrics.gaps.length).fill(metrics.gapList));
    await page.close();
  });

  test("checked and unchecked items start their labels on one column", async () => {
    const page = await openFixture("filters");
    await openShowMenu(page);
    const starts = await page.locator('#fixture [role="menuitemradio"]').evaluateAll((nodes) => nodes.map((node) => {
      const range = document.createRange();
      range.selectNodeContents(node.lastChild as Node);
      return range.getBoundingClientRect().left;
    }));

    assert.equal(new Set(starts).size, 1, `label starts ${starts.join(", ")}`);
    await page.close();
  });
});

describe("markup-only atoms", () => {
  test("a link is named by its text alone and draws no box", async () => {
    const page = await openFixture("atoms");
    const link = page.locator("#fixture").getByRole("link", { name: "Task results", exact: true });
    const look = await link.evaluate((el) => ({ border: getComputedStyle(el).borderTopWidth, display: getComputedStyle(el).display }));

    assert.equal(await link.getAttribute("href"), "#outcomes");
    assert.deepEqual(look, { border: "0px", display: "inline" });
    await page.close();
  });

  test("bar search is a named search field whose fill carries the focus ring", async () => {
    const page = await openFixture("atoms");
    const field = page.locator("#fixture").getByRole("searchbox", { name: "Search outcomes" });
    await field.focus();
    const ring = await page.locator("#fixture .bar-search").evaluate((el) => getComputedStyle(el).outlineStyle);

    assert.equal(await field.evaluate((el) => el === document.activeElement), true);
    assert.equal(ring, "solid");
    await page.close();
  });

  test("a press on the bar search fill outside the field focuses the field", async () => {
    const page = await openFixture("atoms");
    await page.locator("#fixture .bar-search svg").click();

    assert.equal(await page.locator("#fixture .bar-search-field").evaluate((el) => el === document.activeElement), true);
    await page.close();
  });

  test("a form select is labelled by its visible label", async () => {
    const page = await openFixture("atoms");

    assert.equal(await page.locator("#fixture").getByLabel("Model", { exact: true }).evaluate((el) => el.tagName), "SELECT");
    await page.close();
  });

  test("a machine string sets in mono, unboxed", async () => {
    const page = await openFixture("atoms");
    const look = await page.locator("#fixture").getByText("1a251d81", { exact: true }).evaluate((el) => ({ font: getComputedStyle(el).fontFamily, border: getComputedStyle(el).borderTopWidth }));

    assert.match(look.font, /JetBrains Mono/);
    assert.equal(look.border, "0px");
    await page.close();
  });
});

describe("layout primitives space on role tokens", () => {
  test("each Stack and Cluster gap equals its role token", async () => {
    const page = await openFixture("gaps");
    const measured = await page.locator("#gaps").evaluate((root) => [...root.children].map((group) => {
      const [a, b] = [...group.children].map((el) => el.getBoundingClientRect());
      return group.children[0].tagName === "SPAN" ? b.left - a.right : b.top - a.bottom;
    }));
    const tokens = await page.evaluate(() => ["block", "label", "stack", "list", "control", "control-group"]
      .map((role) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--gap-${role}`))));

    assert.deepEqual(measured, tokens);
    await page.close();
  });

  test("a gap that is not a role name is refused", async () => {
    const page = await openFixture("gaps");
    const errors = await page.evaluate(() => [(ui: LayoutUI) => ui.Stack({ gap: 16 }), (ui: LayoutUI) => ui.Cluster({ gap: "block" })]
      .map((render) => { try { render((window as unknown as { UI: LayoutUI }).UI); return "rendered"; } catch (error) { return (error as Error).message; } }));

    assert.deepEqual(errors.map((message) => /gap role/.test(message)), [true, true]);
    await page.close();
  });
});
