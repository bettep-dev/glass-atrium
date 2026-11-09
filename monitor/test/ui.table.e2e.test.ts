// The table's stacked-mode switch in a real browser: the measured wrapper flips the mode across the threshold, the wide sections, the stacked semantics and the body key handlers.
// Runner: npx tsx --test test/ui.table.e2e.test.ts
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
const WIDE_PX = 900;
const NARROW_PX = 500;

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
// fixture data per spec §6: a long name, an empty value, 1,000+ numbers; two bodies, the second busy and led by a span row
const MOUNT_FIXTURE = `(widthPx) => {
  const { React, ReactDOM, UI } = window;
  const h = React.createElement;
  const COLUMNS = [{ key: 'agent', label: 'Agent' }, { key: 'runs', label: 'Runs', isNumeric: true, sort: 'descending' }, { key: 'cost', label: 'Cost', isNumeric: true }];
  const AGENTS = [{ id: 'a', name: 'glass-atrium-dev-react-with-a-very-long-agent-name', runs: '1,284', cost: 'None' }, { id: 'b', name: 'dev-front', runs: '12', cost: '$3.40' }];
  const move = (event) => {
    if (event.key !== 'ArrowDown') return;
    const rows = [...document.querySelectorAll('#fixture tr[tabindex]')];
    const next = rows[rows.indexOf(document.activeElement) + 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  const row = (view, r) => h(UI.TableRow, { view, key: r.id, id: 'row-' + r.id, tabIndex: 0 },
    h(UI.TableCell, { view, kind: 'row-header' }, r.name),
    h(UI.TableCell, { view, textRole: 'meta', label: 'Runs', isNumeric: true }, r.runs),
    h(UI.TableCell, { view, textRole: 'meta', label: 'Cost', isNumeric: true }, r.cost));
  const host = document.createElement('div');
  host.id = 'fixture';
  host.style.width = widthPx + 'px';
  document.body.prepend(host);
  ReactDOM.createRoot(host).render(h(UI.Table, {
    caption: 'Runs by agent', columns: COLUMNS, widths: ['50%', '25%', '25%'], stackBelowPx: 700,
    bodies: [
      { key: 'agents', onKeyDown: move, rows: (view) => AGENTS.map((r) => row(view, r)) },
      { key: 'pseudo', isBusy: true, onKeyDown: move, rows: (view) => [
        h(UI.TableRow, { view, key: 'lead' }, h(UI.TableCell, { view, kind: 'span' }, 'Pseudo-agents')),
        row(view, { id: 'c', name: '(unattributed)', runs: '1,002', cost: '$0.00' })] },
    ],
    foot: (view) => h(UI.TableRow, { view }, h(UI.TableCell, { view, kind: 'row-header' }, 'Total'), h(UI.TableCell, { view, kind: 'span', start: 1 }, '2,298 runs')),
  }));
}`;

async function openFixture(widthPx: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${serverUrl}/#dashboard`, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean((window as unknown as { UI?: unknown; ReactDOM?: unknown }).UI && (window as unknown as { ReactDOM?: unknown }).ReactDOM), null, { timeout: 30_000 });
  await page.evaluate(`(${MOUNT_FIXTURE})(${widthPx})`);
  await page.waitForSelector(`#fixture [data-table-mode="${widthPx < 700 ? "stacked" : "wide"}"]`, { timeout: 30_000 });
  return page;
}

async function resizeTo(page: Page, widthPx: number, mode: string): Promise<void> {
  await page.evaluate((px) => { (document.getElementById("fixture") as HTMLElement).style.width = `${px}px`; }, widthPx);
  await page.waitForSelector(`#fixture [data-table-mode="${mode}"]`);
}

const readActiveId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");

describe("table — wide mode", () => {
  test("widths apply, cells show no label prefix, only the second body is busy, and no role is restated", async () => {
    const page = await openFixture(WIDE_PX);
    const facts = await page.evaluate(() => {
      const table = document.querySelector("#fixture table") as HTMLTableElement;
      return {
        widths: [...table.querySelectorAll("col")].map((col) => (col as HTMLElement).style.width),
        cells: [...table.querySelectorAll("#row-a td")].map((td) => td.textContent),
        busy: [...table.tBodies].map((body) => body.getAttribute("aria-busy")),
        roles: table.querySelectorAll("[role]").length + (table.hasAttribute("role") ? 1 : 0),
      };
    });

    assert.deepEqual(facts, { widths: ["50%", "25%", "25%"], cells: ["1,284", "None"], busy: [null, "true"], roles: 0 });
    await page.close();
  });
});

describe("table — stacked mode", () => {
  test("table, sections, rows and cells restate their roles, the sorted head keeps aria-sort, and the foot comes last", async () => {
    const page = await openFixture(NARROW_PX);
    const facts = await page.evaluate(() => {
      const table = document.querySelector("#fixture table") as HTMLTableElement;
      return {
        table: table.getAttribute("role"),
        sections: [...table.children].filter((n) => n.tagName !== "CAPTION").map((n) => `${n.tagName}:${n.getAttribute("role")}`),
        heads: [...table.querySelectorAll("thead th")].map((th) => `${th.getAttribute("role")}:${th.getAttribute("aria-sort")}`),
        row: [...table.querySelectorAll("#row-a > *")].map((cell) => cell.getAttribute("role")),
        prefixes: [...table.querySelectorAll("#row-a [aria-hidden='true']")].map((span) => span.textContent),
        cols: table.querySelectorAll("col").length,
      };
    });

    assert.deepEqual(facts, {
      table: "table",
      sections: ["THEAD:rowgroup", "TBODY:rowgroup", "TBODY:rowgroup", "TFOOT:rowgroup"],
      heads: ["columnheader:null", "columnheader:descending", "columnheader:null"],
      row: ["rowheader", "cell", "cell"],
      prefixes: ["Runs", "Cost"],
      cols: 0,
    });
    await page.close();
  });
});

describe("table — mode switch", () => {
  test("a resize across the threshold flips the mode both ways on the same wrapper node with focus kept", async () => {
    const page = await openFixture(WIDE_PX);
    await page.evaluate(() => { (window as unknown as { tableWrap: Element | null }).tableWrap = document.querySelector("#fixture [data-table-mode]"); });
    await page.focus("#row-b");

    await resizeTo(page, NARROW_PX, "stacked");
    const stacked = { id: await readActiveId(page), isSameNode: await page.evaluate(() => (window as unknown as { tableWrap: Element }).tableWrap === document.querySelector("#fixture [data-table-mode]")) };
    await resizeTo(page, WIDE_PX, "wide");
    const wide = { id: await readActiveId(page), isSameNode: await page.evaluate(() => (window as unknown as { tableWrap: Element }).tableWrap === document.querySelector("#fixture [data-table-mode]")) };

    assert.deepEqual({ stacked, wide }, { stacked: { id: "row-b", isSameNode: true }, wide: { id: "row-b", isSameNode: true } });
    await page.close();
  });

  for (const row of [{ name: "wide", widthPx: WIDE_PX }, { name: "stacked", widthPx: NARROW_PX }]) {
    test(`${row.name}: the body key handler moves focus from the first body into the second`, async () => {
      const page = await openFixture(row.widthPx);
      await page.focus("#row-b");

      await page.keyboard.press("ArrowDown");

      assert.equal(await readActiveId(page), "row-c");
      await page.close();
    });
  }
});

// layout fixture — a table inside a real width chain; nowrap numeric columns and an unbroken path push the table's min-content past its wrapper
// shape: block (host is the parent) · grid-track (a card on a 1fr track around a 1fr grid body) · flex-item (a card as a flex item) · scroller (300px overflow-y box) · page-card (a page-scrolled card)
const MOUNT_LAYOUT = `(opts) => {
  const { React, ReactDOM, UI } = window;
  const h = React.createElement;
  const NAMES = ['Runs', 'Tokens', 'Cost', 'Failures', 'Retries'];
  const COLUMNS = [{ key: 'agent', label: 'Agent' }, ...NAMES.map((label) => ({ key: label, label, isNumeric: true })), { key: 'actions', label: 'Actions' }];
  const rows = (view) => Array.from({ length: opts.rowCount }, (_, i) => h(UI.TableRow, { view, key: i, id: 'r' + i },
    h(UI.TableCell, { view, kind: 'row-header' }, 'outcomes/2026-11-09/glass_atrium_dev_react_long_agent_' + i),
    ...NAMES.map((label) => h(UI.TableCell, { view, key: label, textRole: 'meta', label, isNumeric: true }, '1,234,567 runs')),
    h(UI.TableCell, { view, textRole: 'meta' }, h(UI.RowActions, { label: 'More for r' + i, items: [{ key: 'copy', label: 'Copy id' }], onPick: () => undefined,
      action: h('button', { type: 'button', className: 'btn ghost sm' }, 'Open') }))));
  const table = h(UI.Table, { caption: 'Runs by agent', isCaptionShown: true, isHeadSticky: true, columns: COLUMNS, stackBelowPx: opts.stackBelowPx, bodies: [{ key: 'runs', rows }] });
  const host = document.createElement('div');
  host.id = 'fixture';
  host.style.width = opts.widthPx ? opts.widthPx + 'px' : '100%';
  const card = (style, child) => h('div', { className: 'card', style }, child);
  const tree = {
    'block': table,
    'grid-track': h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' } }, card({}, h('div', { id: 'parent', style: { display: 'grid', gridTemplateColumns: '1fr' } }, table)), card({}, 'Neighbour')),
    'flex-item': h('div', { style: { display: 'flex' } }, card({ flex: '1 1 0' }, h('div', { id: 'parent' }, table))),
    'scroller': h('div', { id: 'scroller', style: { height: '300px', overflowY: 'auto' } }, table),
    'page-card': card({}, table),
  }[opts.shape];
  document.body.prepend(host);
  ReactDOM.createRoot(host).render(tree);
}`;

interface LayoutOptions { shape: string; widthPx: number | null; stackBelowPx: number; rowCount: number }

const nextFrames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

async function openLayout(opts: LayoutOptions, mode: string, viewportPx = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: viewportPx, height: 900 } });
  await page.goto(`${serverUrl}/#dashboard`, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean((window as unknown as { UI?: unknown; ReactDOM?: unknown }).UI && (window as unknown as { ReactDOM?: unknown }).ReactDOM), null, { timeout: 30_000 });
  await page.evaluate(`(${MOUNT_LAYOUT})(${JSON.stringify(opts)})`);
  await nextFrames(page);
  await page.waitForSelector(`#fixture [data-table-mode="${mode}"]`, { timeout: 5_000 });
  return page;
}

// how far the widest cell runs past the wrapper's right edge (≤ 0 → it fits)
const readOverrunPx = (page: Page) => page.evaluate(() => {
  const wrap = document.querySelector("#fixture .tbl-wrap") as HTMLElement;
  const right = Math.max(...[...wrap.querySelectorAll("th, td")].map((cell) => cell.getBoundingClientRect().right));
  return right - wrap.getBoundingClientRect().right;
});

describe("table — fit and look", () => {
  const rows = [
    { name: "at its threshold the wide table", opts: { shape: "block", widthPx: 840, stackBelowPx: 840, rowCount: 3 }, mode: "wide", viewportPx: 1440 },
    { name: "one pixel under its threshold the stacked table", opts: { shape: "block", widthPx: 839, stackBelowPx: 840, rowCount: 3 }, mode: "stacked", viewportPx: 1440 },
    { name: "at a 1024 viewport the stacked table", opts: { shape: "block", widthPx: null, stackBelowPx: 1100, rowCount: 3 }, mode: "stacked", viewportPx: 1024 },
  ];
  for (const row of rows) {
    test(`${row.name} keeps every cell inside its wrapper`, async () => {
      const page = await openLayout(row.opts, row.mode, row.viewportPx);

      const overrunPx = await readOverrunPx(page);

      assert.ok(overrunPx <= 0.5, `${row.name}: overrun ${overrunPx}px`);
      await page.close();
    });
  }

  test("a shown caption starts on the card-pad column and numbers set sans with tabular figures", async () => {
    const page = await openLayout({ shape: "block", widthPx: 900, stackBelowPx: 700, rowCount: 1 }, "wide");

    const look = await page.evaluate(() => {
      const caption = getComputedStyle(document.querySelector("#fixture caption")!);
      const num = getComputedStyle(document.querySelector("#fixture td.num")!);
      return { captionPad: caption.paddingLeft, numFont: num.fontFamily, numFigures: num.fontVariantNumeric, numAlign: num.textAlign };
    });

    assert.equal(look.captionPad, "16px");
    assert.doesNotMatch(look.numFont, /JetBrains Mono/);
    assert.deepEqual([look.numFigures, look.numAlign], ["tabular-nums", "right"]);
    await page.close();
  });

  test("wide: a second body and the foot each start below a rule", async () => {
    const page = await openFixture(WIDE_PX);

    const rules = await page.evaluate(() => {
      const table = document.querySelector("#fixture table") as HTMLTableElement;
      return [table.tBodies[1]!.rows[0]!.cells[0]!, table.tFoot!.rows[0]!.cells[0]!].map((cell) => getComputedStyle(cell).borderTopWidth);
    });

    assert.deepEqual(rules, ["1px", "1px"]);
    await page.close();
  });

  test("stacked: a row is a two-line item — its header on line one, meta facts on line two behind their label — a span cell runs full width and the foot sits below a rule", async () => {
    const page = await openFixture(NARROW_PX);

    const item = await page.evaluate(() => {
      const row = document.querySelector("#row-a") as HTMLElement;
      const [head, ...metas] = [...row.children] as HTMLElement[];
      const [headBox, metaBox] = [head!.getBoundingClientRect(), metas[0]!.getBoundingClientRect()];
      const lead = document.querySelector("#fixture tbody:nth-of-type(2) tr td") as HTMLElement;
      const leadRow = getComputedStyle(lead.parentElement as HTMLElement);
      const rowStyle = getComputedStyle(row);
      return {
        isHeadAbove: headBox.bottom <= metaBox.top + 0.5,
        isMetaOneLine: metas.every((m) => Math.abs(m.getBoundingClientRect().top - metaBox.top) < 0.5),
        sizes: [getComputedStyle(head!).fontSize, getComputedStyle(metas[0]!).fontSize],
        isTall: row.getBoundingClientRect().height >= 56,
        labelGap: getComputedStyle(metas[0]!.querySelector(".tbl-cell-label")!).marginRight,
        leadFill: Math.round(lead.getBoundingClientRect().width - (parseFloat(leadRow.width) - parseFloat(leadRow.paddingLeft) - parseFloat(leadRow.paddingRight))),
        edgePad: rowStyle.paddingLeft,
        footRule: getComputedStyle(document.querySelector("#fixture tfoot tr")!).borderTopWidth,
      };
    });

    assert.deepEqual(item, { isHeadAbove: true, isMetaOneLine: true, sizes: ["15px", "13px"], isTall: true, labelGap: "4px", leadFill: 0, edgePad: "16px", footRule: "1px" });
    await page.close();
  });
});

describe("table — width source", () => {
  const rows = [
    { name: "a card on a 1fr track around a 1fr grid body", shape: "grid-track", narrowPx: 1400, widePx: 1500 },
    { name: "a card as a flex item", shape: "flex-item", narrowPx: 650, widePx: 760 },
  ];
  for (const row of rows) {
    test(`${row.name}: the wrapper takes its parent's width in both modes, so the table's own width moves no mode`, async () => {
      const page = await openLayout({ shape: row.shape, widthPx: row.narrowPx, stackBelowPx: 700, rowCount: 2 }, "stacked");
      const readFit = () => page.evaluate(() => {
        const wrap = document.querySelector("#fixture .tbl-wrap") as HTMLElement;
        return { mode: wrap.dataset.tableMode, gapPx: Math.round(wrap.getBoundingClientRect().width - (document.getElementById("parent") as HTMLElement).clientWidth) };
      });
      const stacked = await readFit();
      await page.evaluate((px) => { (document.getElementById("fixture") as HTMLElement).style.width = `${px}px`; }, row.widePx);
      await nextFrames(page);
      await nextFrames(page);

      const wide = await readFit();

      assert.deepEqual({ stacked, wide }, { stacked: { mode: "stacked", gapPx: 0 }, wide: { mode: "wide", gapPx: 0 } });
      await page.close();
    });
  }
});

describe("table — sticky head", () => {
  const rows = [
    { name: "wide in a scroll box", shape: "scroller", stackBelowPx: 700, mode: "wide" },
    { name: "stacked in a scroll box", shape: "scroller", stackBelowPx: 1000, mode: "stacked" },
    { name: "wide in a page-scrolled card lifted by an open row menu", shape: "page-card", stackBelowPx: 700, mode: "wide" },
    { name: "stacked in a page-scrolled card lifted by an open row menu", shape: "page-card", stackBelowPx: 1000, mode: "stacked" },
  ];
  for (const row of rows) {
    test(`${row.name}: the column head sticks to the nearest vertical scroller`, async () => {
      const page = await openLayout({ shape: row.shape, widthPx: 900, stackBelowPx: row.stackBelowPx, rowCount: 40 }, row.mode);
      const isPageCard = row.shape === "page-card";
      if (isPageCard) await page.getByRole("button", { name: "More for r0" }).click();
      const menuOverrunPx = isPageCard ? await page.evaluate(() => document.querySelector("#fixture .menu")!.getBoundingClientRect().right - document.querySelector("#fixture .tbl-wrap")!.getBoundingClientRect().right) : 0;

      // wide → each th sticks on its own; stacked → the head row block sticks as one
      const offsetPx = await page.evaluate(({ isPage, headSelector }) => {
        const head = document.querySelector(headSelector) as HTMLElement;
        const scroller = isPage ? null : document.getElementById("scroller")!;
        if (scroller) scroller.scrollTop = 400;
        else window.scrollTo(0, head.getBoundingClientRect().top + window.scrollY + 400);
        return head.getBoundingClientRect().top - (scroller ? scroller.getBoundingClientRect().top : 0);
      }, { isPage: isPageCard, headSelector: row.mode === "stacked" ? "#fixture thead" : "#fixture thead th" });

      assert.ok(Math.abs(offsetPx) <= 1, `${row.name}: head ${offsetPx}px off the scroller top`);
      assert.ok(menuOverrunPx <= 0.5, `${row.name}: menu runs ${menuOverrunPx}px past the wrapper`);
      await page.close();
    });
  }
});
