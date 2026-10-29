// E2E chromium check for the Models & budgets screen (screens/model-config.jsx): the model card and the
// caps + tiers stack end together, which a node render cannot measure.
//
// Runner: npx tsx --test test/model-config.card-ends.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify serving the config below; every other /api read answers empty.

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const MODEL = "claude-opus-5-5";

function getModelRow(domain: string, files?: string[]) {
  return {
    domain,
    desired: MODEL,
    actual: MODEL,
    drift: false,
    apply_mode: domain === "model.daemon_cycle_worker" ? "next-cycle" : "next-spawn",
    editable: true,
    pricing_known: true,
    ...(files ? { files: files.map((file) => ({ file, model: MODEL })) } : {}),
  };
}

// the shipped roster: seven model tiers, two caps, four call tiers, one saved cap among them
const CONFIG = {
  domains: [
    getModelRow("model.dev", ["glass-atrium-dev-front.md", "glass-atrium-dev-react.md"]),
    getModelRow("model.research"),
    getModelRow("model.meta"),
    getModelRow("model.wiki"),
    getModelRow("model.review", ["glass-atrium-qa-code-reviewer.md", "glass-atrium-qa-debugger.md"]),
    getModelRow("model.docs", ["glass-atrium-intel-reporter.md", "glass-atrium-intel-planner.md"]),
    getModelRow("model.daemon_cycle_worker"),
  ],
  budgets: ["budget.worker_max_usd", "budget.pre_verify_max_usd"].map((domain) => ({
    domain,
    desired: "10.00",
    actual: "10.00",
    drift: false,
    apply_mode: "next-cycle",
  })),
  tiers: [
    "tier.worker_effort",
    "tier.pre_verify_effort",
    "tier.worker_max_output_tokens",
    "tier.pre_verify_max_output_tokens",
  ].map((domain) => ({ domain, desired: null, actual: null, file_error: null, drift: false, apply_mode: "next-cycle" })),
  known_models: [MODEL],
  daemon_config_sync: "ok",
};

// side-by-side widths only — below 1280 the row stacks and has no shared end edge
for (const width of [1440, 1920]) {
  test(`the model card and the caps + tiers stack end within one row of each other at ${width}px`, async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
    app.get("/api/model-config", async () => CONFIG);
    app.get("/api/*", async () => ({ rows: [] }));
    const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${serverUrl}/#model-config`, { waitUntil: "load" });
      await page.waitForSelector(".split-row .split-col table tbody tr td input", { timeout: 30_000 });
      const ends = await page.evaluate(() => {
        const row = document.querySelector(".split-row")!;
        const lead = row.children[0].querySelector(".card")!.getBoundingClientRect();
        const stack = [...row.children[1].querySelectorAll(".card")].map((card) => card.getBoundingClientRect());
        return {
          rowPx: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h")),
          isSideBySide: stack.every((box) => box.left >= lead.right),
          leadBottom: lead.bottom,
          stackBottom: Math.max(...stack.map((box) => box.bottom)),
        };
      });

      assert.ok(ends.rowPx > 0, "the row-height token resolves");
      assert.ok(ends.isSideBySide, `${width}px: the stack sits beside the model card`);
      const gap = Math.abs(ends.leadBottom - ends.stackBottom);
      assert.ok(gap <= ends.rowPx, `${width}px: ends ${gap}px apart, more than one ${ends.rowPx}px row`);
    } finally {
      await browser.close();
      await app.close();
    }
  });
}

// the three tier tables on the shared .tbl geometry: one padding per cell kind, edges at the card padding, the house header face kept;
// the rows are top-aligned, so a text cell starts half the control-to-line difference (32 − 20) / 2 below a control cell
test("every tier-table cell takes the shared .tbl padding, a text cell starting half the control-to-line step below a control cell, and the header keeps its face", async () => {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/model-config", async () => CONFIG);
  app.get("/api/*", async () => ({ rows: [] }));
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${serverUrl}/#model-config`, { waitUntil: "load" });
    await page.waitForSelector(".split-row .split-col table tbody tr td input", { timeout: 30_000 });
    // no named helper inside evaluate — tsx would wrap it in a __name call the page does not define
    const tables = await page.evaluate(() => {
      const controls = ".btn, .seg, .field, .field-affix, .pill--interactive, .pill--ctl-h, .disclosure";
      return [...document.querySelectorAll(".split-row table")].map((table) => {
        const th = getComputedStyle(table.querySelector("thead th")!);
        return {
          caption: table.querySelector("caption")?.textContent ?? "",
          header: { transform: th.textTransform, fill: th.backgroundColor },
          cells: [...table.querySelectorAll("tbody td")].map((td) => {
            const style = getComputedStyle(td);
            const row = td.parentElement as HTMLTableRowElement;
            return {
              isControl: td.querySelector(controls) !== null,
              isFirst: td === row.cells[0],
              isLast: td === row.cells[row.cells.length - 1],
              top: Math.round(parseFloat(style.paddingTop) * 10) / 10,
              bottom: Math.round(parseFloat(style.paddingBottom) * 10) / 10,
              start: Math.round(parseFloat(style.paddingLeft) * 10) / 10,
              end: Math.round(parseFloat(style.paddingRight) * 10) / 10,
            };
          }),
        };
      });
    });

    assert.strictEqual(tables.length, 3, "model, cap and call-tier tables render");
    for (const table of tables) {
      assert.strictEqual(table.header.transform, "uppercase", `${table.caption}: the house header case stays`);
      assert.ok(table.cells.length >= 6, `${table.caption}: rows render`);
      for (const cell of table.cells) {
        const [top, bottom] = cell.isControl ? [3.5, 3.5] : [3.5 + (32 - 20) / 2, 7.5];
        assert.deepStrictEqual([cell.top, cell.bottom], [top, bottom], `${table.caption}: ${cell.isControl ? "control" : "text"} cell block padding`);
        assert.strictEqual(cell.start, cell.isFirst ? 16 : 12, `${table.caption}: inline start padding`);
        assert.strictEqual(cell.end, cell.isLast ? 16 : 12, `${table.caption}: inline end padding`);
      }
      assert.ok(table.cells.some((cell) => cell.isControl), `${table.caption}: its control column is a control cell`);
    }
  } finally {
    await browser.close();
    await app.close();
  }
});

// On the shipped roster, with top-aligned rows and compact units, at every side-by-side width and the stacked one: the first text line of a cell centers on the
// control in its row, every model select holds its longest option label, and an In effect file name never breaks at its hyphens
const LONG_ROSTER = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5-1"];
for (const width of [1024, 1280, 1440, 1920]) {
  test(`${width}px: top-aligned rows center their first line on the control, model selects fit, file names stay whole`, async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
    app.get("/api/model-config", async () => ({ ...CONFIG, known_models: LONG_ROSTER }));
    app.get("/api/*", async () => ({ rows: [] }));
    const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${serverUrl}/#model-config`, { waitUntil: "load" });
      await page.waitForSelector(".split-row .split-col table tbody tr td input", { timeout: 30_000 });
      // no named helper inside evaluate — tsx would wrap it in a __name call the page does not define
      const geometry = await page.evaluate(() => {
        const controls = ".btn, .seg, .field, .field-affix, .pill--interactive, .pill--ctl-h, .disclosure";
        const offsets: { row: string; offset: number }[] = [];
        for (const tr of document.querySelectorAll<HTMLTableRowElement>("tbody tr.is-top-aligned")) {
          const control = tr.querySelector(controls)!.getBoundingClientRect();
          for (const td of tr.cells) {
            if (td.querySelector(controls)) continue;
            const first = td.querySelector(".tbl-first-line")!;
            const range = document.createRange();
            range.selectNodeContents(first);
            const line = range.getClientRects()[0];
            offsets.push({
              row: tr.cells[0].textContent ?? "",
              offset: line.top + line.height / 2 - (control.top + control.height / 2),
            });
          }
        }
        const canvas = document.createElement("canvas").getContext("2d")!;
        const selects = [...document.querySelectorAll<HTMLSelectElement>('tbody select[aria-label$=" model"]')].map((select) => {
          const style = getComputedStyle(select);
          canvas.font = `${style.fontSize} ${style.fontFamily}`;
          const labels = [...select.options].filter((o) => o.value !== "__custom__").map((o) => o.textContent ?? "");
          return {
            name: select.getAttribute("aria-label"),
            room: select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            longest: Math.max(...labels.map((label) => canvas.measureText(label).width)),
          };
        });
        const files = [...document.querySelectorAll<HTMLElement>("tbody td span[title='daemon-config.json']")].map((token) => ({
          lines: token.getClientRects().length,
          height: token.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(token).lineHeight),
        }));
        return { offsets, selects, files };
      });

      assert.ok(geometry.offsets.length >= 13, `${width}px: every row has a text cell beside its control`);
      for (const { row, offset } of geometry.offsets) {
        assert.ok(Math.abs(offset) <= 0.5, `${width}px ${row}: first text line ${offset}px off the control center`);
      }
      assert.strictEqual(geometry.selects.length, CONFIG.domains.length, `${width}px: one select per model tier`);
      for (const { name, room, longest } of geometry.selects) {
        assert.ok(longest <= room, `${width}px ${name}: longest label ${longest}px in ${room}px`);
      }
      assert.ok(geometry.files.length > 0, `${width}px: the cap and tier rows name their file`);
      for (const file of geometry.files) {
        assert.strictEqual(file.lines, 1, `${width}px: daemon-config.json is one token`);
        assert.ok(file.height <= file.lineHeight + 1, `${width}px: daemon-config.json never breaks at its hyphens`);
      }
    } finally {
      await browser.close();
      await app.close();
    }
  });
}
