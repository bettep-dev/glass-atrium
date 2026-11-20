// E2E chromium check for the Models & budgets screen (screens/model-config.jsx): the agent card spans the page above the
// daemon split row, ticking an agent never moves a row, and the split row's two columns end together — none of which a node render can measure.
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

// the shipped roster: one model tier, two caps, four call tiers, one saved cap among them
const CONFIG = {
  domains: [
    {
      domain: "model.daemon_cycle_worker",
      desired: MODEL,
      actual: MODEL,
      drift: false,
      apply_mode: "next-cycle",
      editable: true,
      pricing_known: true,
    },
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
// one-row bound kept for the two-card left column: the caps card's foot names the source for the whole column,
// so the daemon model card carries no foot of its own (designer ruling, layout-ruling.md item 1)
for (const width of [1280, 1440, 1568, 1920]) {
  test(`the daemon model + caps column and the call-tier column end within one row of each other at ${width}px`, async () => {
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
        const stack = [...row.children[0].querySelectorAll(".card")].map((card) => card.getBoundingClientRect());
        const tiers = row.children[1].getBoundingClientRect();
        return {
          rowPx: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h")),
          isSideBySide: stack.every((box) => tiers.left >= box.right),
          stackBottom: Math.max(...stack.map((box) => box.bottom)),
          tiersBottom: tiers.bottom,
        };
      });

      assert.ok(ends.rowPx > 0, "the row-height token resolves");
      assert.ok(ends.isSideBySide, `${width}px: the call tiers sit beside the daemon model + caps stack`);
      const gap = Math.abs(ends.stackBottom - ends.tiersBottom);
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
      const controls = ".btn, .seg, .field, .field-affix, .disclosure";
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
      assert.strictEqual(table.header.transform, "none", `${table.caption}: headers keep sentence case`);
      assert.ok(table.cells.length >= 3, `${table.caption}: rows render`);
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
        const controls = ".btn, .seg, .field, .field-affix, .disclosure";
        const offsets: { row: string; offset: number }[] = [];
        for (const tr of document.querySelectorAll<HTMLTableRowElement>("tbody tr.is-top-aligned")) {
          const control = tr.querySelector(controls)!.getBoundingClientRect();
          for (const td of tr.cells) {
            if (td.querySelector(controls)) continue;
            const first = td.querySelector(".tbl-first-line");
            // a silent cell has no line to centre · a worded cell without the first-line hook fails as NaN
            if (!first) {
              if ((td.textContent ?? "").trim() !== "") offsets.push({ row: tr.cells[0].textContent ?? "", offset: NaN });
              continue;
            }
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
        const modelSelects = [...document.querySelectorAll<HTMLSelectElement>("tbody select")].filter((select) =>
          (select.labels?.[0]?.textContent ?? "").endsWith(" model"),
        );
        const selects = modelSelects.map((select) => {
          const style = getComputedStyle(select);
          canvas.font = `${style.fontSize} ${style.fontFamily}`;
          const labels = [...select.options].filter((o) => o.value !== "__custom__").map((o) => o.textContent ?? "");
          return {
            name: select.labels?.[0]?.textContent ?? null,
            room: select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            longest: Math.max(...labels.map((label) => canvas.measureText(label).width)),
          };
        });
        const files = [...document.querySelectorAll<HTMLElement>(".card-foot code.machine")].map((token) => ({
          lines: token.getClientRects().length,
          height: token.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(token).lineHeight),
        }));
        return { offsets, selects, files };
      });

      const rowCount = CONFIG.domains.length + CONFIG.budgets.length + CONFIG.tiers.length;
      assert.ok(geometry.offsets.length >= rowCount, `${width}px: every row has a text cell beside its control`);
      for (const { row, offset } of geometry.offsets) {
        assert.ok(Math.abs(offset) <= 0.5, `${width}px ${row}: first text line ${offset}px off the control center`);
      }
      assert.strictEqual(geometry.selects.length, CONFIG.domains.length, `${width}px: one select per model tier`);
      for (const { name, room, longest } of geometry.selects) {
        assert.ok(longest <= room, `${width}px ${name}: longest label ${longest}px in ${room}px`);
      }
      assert.ok(geometry.files.length > 0, `${width}px: the card feet name their file`);
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

// a listed agent folder: a long name, a missing role, an unregistered file and an unreadable one
const AGENTS_CONFIG = {
  ...CONFIG,
  agents: [
    { name: "glass-atrium-dev-android", file: "glass-atrium-dev-android.md", role: "Android apps in Kotlin and Compose", pin: MODEL, registered: true },
    { name: "glass-atrium-intel-researcher", file: "glass-atrium-intel-researcher.md", role: "Web and codebase research with cited sources", pin: null, registered: true },
    { name: "glass-atrium-sec-guard", file: "glass-atrium-sec-guard.md", role: null, pin: "claude-3-retired-alias", registered: true },
    { name: "my-new-agent-with-a-forty-character-name", file: "my-new-agent-with-a-forty-character-name.md", role: "Drafts release notes", pin: null, registered: false },
  ],
  unreadable: [{ file: "glass-atrium-broken.md", reason: "No frontmatter block" }],
};

for (const width of [1280, 1568]) {
  test(`${width}px: the agent card spans the page above the split row, and ticking an agent moves no row`, async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
    app.get("/api/model-config", async () => AGENTS_CONFIG);
    app.get("/api/*", async () => ({ rows: [] }));
    const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${serverUrl}/#model-config`, { waitUntil: "load" });
      await page.waitForSelector("[data-roving-row] input[type=checkbox]", { timeout: 30_000 });
      const readRows = () => page.evaluate(() => [...document.querySelectorAll("[data-roving-row]")].map((row) => row.getBoundingClientRect().top));
      const layout = await page.evaluate(() => {
        const agent = document.querySelector("#mc-models .card")!.getBoundingClientRect();
        const split = document.querySelector(".split-row")!.getBoundingClientRect();
        return { agentWidth: agent.width, splitWidth: split.width, agentBottom: agent.bottom, splitTop: split.top };
      });
      const before = await readRows();
      // the role cell of the first agent with a box — the unreadable file sorts first and has none
      await page.click("[data-roving-row]:has(input[type=checkbox]) td:nth-child(3)");
      await page.waitForFunction(() => document.querySelector(".card-bar")?.textContent?.includes("1 selected"));
      const after = await readRows();

      assert.ok(Math.abs(layout.agentWidth - layout.splitWidth) <= 1, `${width}px: agent card ${layout.agentWidth} vs split row ${layout.splitWidth}`);
      assert.ok(layout.agentBottom <= layout.splitTop, `${width}px: the agent card ends above the split row`);
      assert.deepStrictEqual(after, before, `${width}px: ticking a row moved the rows`);
    } finally {
      await browser.close();
      await app.close();
    }
  });
}

// stacked: one line per row for box, name and model, then the role (or None, Not registered, the file's reason) at the name's x
const AGENT_LINE_TWO = ["Android apps in Kotlin and Compose", "Web and codebase research with cited sources", "None", "Not registered", "Drafts release notes", "No frontmatter block"];

for (const width of [960, 768]) {
  test(`${width}px stacked: every second line starts at the name's x, line one shares its top, and the head names Agent and Model`, async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
    app.get("/api/model-config", async () => AGENTS_CONFIG);
    app.get("/api/*", async () => ({ rows: [] }));
    const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${serverUrl}/#model-config`, { waitUntil: "load" });
      await page.waitForSelector("#mc-models table.tbl--stacked [data-roving-row]", { timeout: 30_000 });
      // anonymous callbacks only: tsx wraps a named const in a __name() helper the page lacks
      const read = await page.evaluate((lineTwo) => {
        const rows = [...document.querySelectorAll("#mc-models tbody [data-roving-row]")].map((row) => {
          const [tick, name, model] = [...row.children].slice(0, 3);
          const firstLine = [name.firstElementChild!, model.firstElementChild!].map((el) => el.getBoundingClientRect());
          const lineOneBottom = Math.max(tick.getBoundingClientRect().bottom, ...firstLine.map((rect) => rect.bottom));
          const input = row.querySelector("input[type=checkbox]")?.getBoundingClientRect();
          return {
            nameLeft: name.getBoundingClientRect().left,
            tops: firstLine.map((rect) => rect.top),
            boxCentre: input ? (input.top + input.bottom) / 2 : null,
            nameCentre: (firstLine[0].top + firstLine[0].bottom) / 2,
            lineTwo: lineTwo.flatMap((text) => {
              const leaf = [...row.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent?.trim() === text);
              if (!leaf) return [];
              const rect = leaf.getBoundingClientRect();
              return [{ text, left: rect.left, top: rect.top, lineOneBottom, size: getComputedStyle(leaf).fontSize, color: getComputedStyle(leaf).color }];
            }),
          };
        });
        const heads = [...document.querySelectorAll("#mc-models thead th")].filter((th) => th.getBoundingClientRect().width > 0);
        const faint = getComputedStyle(document.documentElement).getPropertyValue("--faint").trim().split(/\s+/).join(", ");
        return {
          rows,
          faint: `rgb(${faint})`,
          heads: heads.map((th) => ({ text: th.textContent?.trim(), left: th.getBoundingClientRect().left, right: (th.firstElementChild ?? th).getBoundingClientRect().right })),
          modelRight: document.querySelector("#mc-models tbody [data-roving-row]:has(input) > :nth-child(3)")!.getBoundingClientRect().right,
        };
      }, AGENT_LINE_TWO);

      const lines = read.rows.flatMap((row) => row.lineTwo.map((line) => ({ ...line, nameLeft: row.nameLeft })));
      assert.deepStrictEqual(lines.map((line) => line.text).sort(), [...AGENT_LINE_TWO].sort(), "every second line is drawn once");
      for (const line of lines) {
        assert.ok(Math.abs(line.left - line.nameLeft) <= 1, `${width}px: '${line.text}' starts at ${line.left}, the name at ${line.nameLeft}`);
        assert.ok(line.top >= line.lineOneBottom - 0.5, `${width}px: '${line.text}' sits under the whole first line`);
        assert.strictEqual(line.size, "13px", `${width}px: '${line.text}' is the 13 meta size`);
      }
      assert.strictEqual(lines.find((line) => line.text === "None")!.color, read.faint, "an absent role is faint");
      for (const row of read.rows) {
        assert.ok(Math.abs(row.tops[0] - row.tops[1]) <= 1, `${width}px: name top ${row.tops[0]} vs model top ${row.tops[1]}`);
      }
      const boxed = read.rows.filter((row) => row.boxCentre !== null);
      assert.strictEqual(boxed.length, AGENTS_CONFIG.agents.length, "every agent row has its box");
      for (const row of boxed) {
        assert.ok(Math.abs(row.boxCentre! - row.nameCentre) <= 1, `${width}px: the box centre ${row.boxCentre} sits on the name line ${row.nameCentre}`);
      }
      assert.deepStrictEqual(read.heads.map((head) => head.text), ["", "Agent", "Model"], "the stacked head drops Role");
      assert.ok(Math.abs(read.heads[1].left - read.rows[0].nameLeft) <= 1, `${width}px: Agent heads the name x`);
      assert.ok(Math.abs(read.heads[2].right - read.modelRight) <= 1, `${width}px: Model ends over the model cell`);
    } finally {
      await browser.close();
      await app.close();
    }
  });
}

for (const width of [960, 768]) {
  test(`${width}px stacked: a refused agent's reason line starts at its name's x`, async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
    app.get("/api/model-config", async () => AGENTS_CONFIG);
    app.put("/api/model-config/agents", async () => ({
      results: [{ name: "glass-atrium-sec-guard", status: "refused", reason: "File is outside the agents folder" }],
      agents: AGENTS_CONFIG.agents,
      unreadable: AGENTS_CONFIG.unreadable,
    }));
    app.get("/api/*", async () => ({ rows: [] }));
    const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${serverUrl}/#model-config`, { waitUntil: "load" });
      await page.waitForSelector("#mc-models table.tbl--stacked [data-roving-row]", { timeout: 30_000 });
      await page.click("label[for='mc-agent-glass-atrium-sec-guard']");
      await page.selectOption("#mc-agent-model", MODEL);
      await page.click(".card-bar .btn.primary");
      await page.waitForSelector("text=Not changed — the file is outside the agents folder", { timeout: 10_000 });
      const lefts = await page.evaluate(() => {
        const row = document.querySelector("label[for='mc-agent-glass-atrium-sec-guard']")!.closest("tr")!;
        const reason = [...row.nextElementSibling!.querySelectorAll("div")].find((el) => el.textContent?.includes("Not changed"))!;
        return { name: row.children[1].getBoundingClientRect().left, reason: reason.getBoundingClientRect().left };
      });

      assert.ok(Math.abs(lefts.reason - lefts.name) <= 1, `${width}px: the reason starts at ${lefts.reason}, the name at ${lefts.name}`);
    } finally {
      await browser.close();
      await app.close();
    }
  });
}
