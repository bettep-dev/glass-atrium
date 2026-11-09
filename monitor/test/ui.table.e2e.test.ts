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
