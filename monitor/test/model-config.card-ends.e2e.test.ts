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

// the daemon cards as one settings form (spec 44117 §2.4): one 160 control column, so every control shares both edges;
// each label and hint holds one line, and every row is one 68 step (32 control + 4 + the 24 line slot + 2 × 3.5 + the 1 rule, none on the last);
// a call-tier control starts its text at one inset, so `CLI default` starts at one x whether a select option or a field placeholder shows it
for (const width of [1280, 1440, 1568]) {
  test(`${width}px: every daemon control shares both edges at 160, each label and hint holds one line, every row is 68, and the call-tier controls start their text at one x`, async () => {
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
      // anonymous callbacks only: tsx wraps a named const in a __name() helper the page lacks
      const form = await page.evaluate(() => {
        const tierColumn = document.querySelector(".split-row")!.children[1];
        const rows = [...document.querySelectorAll<HTMLTableRowElement>(".split-row tbody tr")];
        return rows.map((tr) => {
          const control = tr.cells[tr.cells.length - 1].querySelector("select, .field-affix, input.field")!.getBoundingClientRect();
          const field = tr.cells[tr.cells.length - 1].querySelector("select, input.field")!;
          const fieldStyle = getComputedStyle(field);
          // the two columns hold equal cards → an edge is read from its own card's end edge
          const cardRight = tr.closest(".card")!.getBoundingClientRect().right;
          const lines = [...tr.cells[0].children].map((line) => {
            const range = document.createRange();
            range.selectNodeContents(line);
            return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
          });
          return {
            label: tr.cells[0].firstElementChild?.textContent ?? "",
            cells: tr.cells.length,
            left: control.left - cardRight,
            right: control.right - cardRight,
            lines,
            height: tr.getBoundingClientRect().height,
            isLast: tr === tr.parentElement!.lastElementChild,
            isTier: tierColumn.contains(tr),
            tag: field.tagName,
            inset: parseFloat(fieldStyle.paddingLeft) + parseFloat(fieldStyle.borderLeftWidth),
            align: fieldStyle.textAlign,
          };
        });
      });

      assert.strictEqual(form.length, CONFIG.domains.length + CONFIG.budgets.length + CONFIG.tiers.length, `${width}px: one row per setting`);
      const tiers = form.filter((row) => row.isTier);
      assert.strictEqual(tiers.length, CONFIG.tiers.length, `${width}px: one call-tier row per knob`);
      for (const row of tiers) {
        assert.ok(Math.abs(row.inset - tiers[0].inset) <= 0.5, `${width}px ${row.label}: text inset ${row.inset}, the first ${tiers[0].inset}`);
      }
      const inputAligns = tiers.filter((row) => row.tag === "INPUT").map((row) => (row.align === "left" ? "start" : row.align));
      assert.deepStrictEqual(inputAligns, ["start", "start"], `${width}px: the output-token fields align their value and placeholder to the start`);
      const [first] = form;
      for (const row of form) {
        assert.strictEqual(row.cells, 2, `${width}px ${row.label}: label and control only`);
        assert.ok(Math.abs(row.right - row.left - 160) <= 0.5, `${width}px ${row.label}: control ${row.right - row.left} wide`);
        assert.ok(Math.abs(row.left - first.left) <= 0.5 && Math.abs(row.right - first.right) <= 0.5, `${width}px ${row.label}: control at ${row.left}–${row.right}, the first at ${first.left}–${first.right}`);
        assert.deepStrictEqual(row.lines, row.lines.map(() => 1), `${width}px ${row.label}: label and hint lines ${row.lines}`);
        assert.ok(Math.abs(row.height - (row.isLast ? 67 : 68)) <= 0.5, `${width}px ${row.label}: row ${row.height} tall`);
      }
    } finally {
      await browser.close();
      await app.close();
    }
  });
}

// the three tier tables on the shared .tbl geometry: one padding per cell kind, edges at the card padding, no head row;
// the rows are top-aligned, so a text cell starts half the control-to-line difference (32 − 20) / 2 below a control cell
test("every tier-table cell takes the shared .tbl padding, a text cell starting half the control-to-line step below a control cell, and no table has a head row", async () => {
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
        return {
          caption: table.querySelector("caption")?.textContent ?? "",
          heads: table.querySelectorAll("thead").length,
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
      assert.strictEqual(table.heads, 0, `${table.caption}: the card title names the control, so no head row`);
      assert.ok(table.cells.length >= 2, `${table.caption}: rows render`);
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
// control in its row, and every model select holds its longest option label
const LONG_ROSTER = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5-1"];
for (const width of [1024, 1280, 1440, 1920]) {
  test(`${width}px: top-aligned rows center their first line on the control, and model selects fit`, async () => {
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
        return { offsets, selects };
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
        const link = [...document.querySelectorAll("#mc-models .card-head a")].find((a) => a.textContent?.includes("Cost"))!;
        const markRight = link.previousElementSibling!.getBoundingClientRect().right;
        const groupGap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--gap-control-group"));
        return { agentWidth: agent.width, splitWidth: split.width, agentBottom: agent.bottom, splitTop: split.top, markGap: link.getBoundingClientRect().left - markRight, groupGap };
      });
      const before = await readRows();
      // the role cell of the first agent with a box — the unreadable file sorts first and has none
      await page.click("[data-roving-row]:has(input[type=checkbox]) td:nth-child(3)");
      await page.waitForFunction(() => document.querySelector(".card-bar")?.textContent?.includes("1 selected"));
      const after = await readRows();

      assert.ok(Math.abs(layout.agentWidth - layout.splitWidth) <= 1, `${width}px: agent card ${layout.agentWidth} vs split row ${layout.splitWidth}`);
      assert.ok(layout.agentBottom <= layout.splitTop, `${width}px: the agent card ends above the split row`);
      assert.deepStrictEqual(after, before, `${width}px: ticking a row moved the rows`);
      assert.ok(Math.abs(layout.markGap - layout.groupGap) <= 1, `${width}px: the head mark sits ${layout.markGap} from Cost & usage, the group gap is ${layout.groupGap}`);
    } finally {
      await browser.close();
      await app.close();
    }
  });
}

// stacked: one line per row for box, name and model, then the role (or None, Not registered, the file's reason) at the name's x
const AGENT_LINE_TWO = ["Android apps in Kotlin and Compose", "Web and codebase research with cited sources", "None", "Not registered", "Drafts release notes", "No frontmatter block"];

for (const width of [960, 768, 640]) {
  test(`${width}px stacked: every second line starts at the name's x under the name, line one shares its top, names show whole, models end on one edge, and the head names Agent and Model`, async () => {
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
            nameBottom: name.getBoundingClientRect().bottom,
            nameFit: [...name.querySelectorAll("label")].map((label) => ({ text: label.textContent, need: label.scrollWidth, has: label.clientWidth })),
            nameRoom: (() => { const range = document.createRange(); range.selectNodeContents(model.firstElementChild!); return range.getBoundingClientRect().left - name.getBoundingClientRect().right - parseFloat(getComputedStyle(row).columnGap); })(),
            modelTextRight: (() => { const range = document.createRange(); range.selectNodeContents(model.firstElementChild!); return range.getBoundingClientRect().right; })(),
            tops: firstLine.map((rect) => rect.top),
            boxCentre: input ? (input.top + input.bottom) / 2 : null,
            nameCentre: (firstLine[0].top + firstLine[0].bottom) / 2,
            lineTwo: lineTwo.flatMap((text) => {
              const leaf = [...row.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent?.trim() === text);
              if (!leaf) return [];
              const rect = leaf.getBoundingClientRect();
              return [{ text, left: rect.left, top: rect.top, lineOneBottom, isInName: name.contains(leaf), cellTop: leaf.closest("td")!.getBoundingClientRect().top, cellRight: leaf.closest("td")!.getBoundingClientRect().right, isModelOneLine: model.children.length === 1, size: getComputedStyle(leaf).fontSize, color: getComputedStyle(leaf).color }];
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
          isSubWhole: (() => { const sub = document.querySelector("#mc-models .card-sub")!; return sub.scrollWidth <= sub.clientWidth; })(),
        };
      }, AGENT_LINE_TWO);

      const lines = read.rows.flatMap((row) => row.lineTwo.map((line) => ({ ...line, nameLeft: row.nameLeft, nameBottom: row.nameBottom })));
      assert.deepStrictEqual(lines.map((line) => line.text).sort(), [...AGENT_LINE_TWO].sort(), "every second line is drawn once");
      for (const line of lines) {
        assert.ok(Math.abs(line.left - line.nameLeft) <= 1, `${width}px: '${line.text}' starts at ${line.left}, the name at ${line.nameLeft}`);
        assert.ok(line.top >= line.lineOneBottom - 0.5, `${width}px: '${line.text}' sits under the whole first line`);
        assert.strictEqual(line.size, "13px", `${width}px: '${line.text}' is the 13 meta size`);
        assert.ok(line.isInName || Math.abs(line.cellTop - line.nameBottom) <= 1, `${width}px: '${line.text}' at ${line.cellTop} sits directly under the name (${line.nameBottom}), whatever the model's height`);
      }
      for (const line of lines.filter((entry) => !entry.isInName && entry.isModelOneLine)) {
        assert.ok(Math.abs(line.cellRight - read.modelRight) <= 1, `${width}px: '${line.text}' runs to ${line.cellRight}, the row end is ${read.modelRight}`);
      }
      assert.ok(read.isSubWhole, `${width}px: the card head's sub shows whole`);
      assert.strictEqual(lines.find((line) => line.text === "None")!.color, read.faint, "an absent role is faint");
      for (const row of read.rows) {
        assert.ok(Math.abs(row.tops[0] - row.tops[1]) <= 1, `${width}px: name top ${row.tops[0]} vs model top ${row.tops[1]}`);
      }
      const boxed = read.rows.filter((row) => row.boxCentre !== null);
      assert.strictEqual(boxed.length, AGENTS_CONFIG.agents.length, "every agent row has its box");
      for (const row of boxed) {
        assert.ok(Math.abs(row.boxCentre! - row.nameCentre) <= 1, `${width}px: the box centre ${row.boxCentre} sits on the name line ${row.nameCentre}`);
        assert.ok(Math.abs(row.modelTextRight - read.modelRight) <= 1, `${width}px: a model ends at ${row.modelTextRight}, the column at ${read.modelRight}`);
        for (const fit of row.nameFit) {
          assert.ok(fit.need <= fit.has || row.nameRoom <= 1, `${width}px: '${fit.text}' needs ${fit.need}, has ${fit.has} with ${row.nameRoom} left before the model — a name is cut only where it meets the model`);
        }
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

test("1280px: a refused agent's reason line sits under its main line on the row's own fill", async () => {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/model-config", async () => AGENTS_CONFIG);
  app.put("/api/model-config/agents", async () => ({
    results: [{ name: "glass-atrium-dev-android", status: "refused", reason: "File is outside the agents folder" }],
    agents: AGENTS_CONFIG.agents,
    unreadable: AGENTS_CONFIG.unreadable,
  }));
  app.get("/api/*", async () => ({ rows: [] }));
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${serverUrl}/#model-config`, { waitUntil: "load" });
    await page.waitForSelector("#mc-models [data-roving-row] input[type=checkbox]", { timeout: 30_000 });
    await page.click("label[for='mc-agent-glass-atrium-dev-android']");
    await page.selectOption("#mc-agent-model", MODEL);
    await page.click(".card-bar .btn.primary");
    await page.waitForSelector("text=Not changed — the file is outside the agents folder", { timeout: 10_000 });
    const read = await page.evaluate(() => {
      const row = document.querySelector("label[for='mc-agent-glass-atrium-dev-android']")!.closest("tr")!;
      const detail = row.nextElementSibling!;
      const reason = [...detail.querySelectorAll("div")].find((el) => el.textContent?.includes("Not changed"))!.getBoundingClientRect();
      const space2 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-2"));
      return {
        fills: [row, detail].map((tr) => getComputedStyle(tr).backgroundColor),
        mainBottom: row.querySelector("label[for='mc-agent-glass-atrium-dev-android']")!.getBoundingClientRect().bottom,
        reasonTop: reason.top,
        padBelow: detail.getBoundingClientRect().bottom - reason.bottom,
        space2,
      };
    });

    assert.strictEqual(read.fills[1], read.fills[0], "the reason row takes its agent row's ticked fill");
    assert.ok(read.reasonTop >= read.mainBottom - 0.5 && read.reasonTop - read.mainBottom <= 4, `the reason starts at ${read.reasonTop}, the main line ends at ${read.mainBottom}`);
    assert.ok(Math.abs(read.padBelow - read.space2) <= 1.5, `the reason row keeps ${read.padBelow} below its line, --space-2 is ${read.space2}`);
  } finally {
    await browser.close();
    await app.close();
  }
});

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
