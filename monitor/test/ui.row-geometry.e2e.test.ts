// Shared-atom geometry read in a real browser: an icon stays inline with its label, a .tbl row holding a 32px control or a
// value + bar cell stays 40, a column-header row sits on the 32 compact step (40 when sortable or holding a control),
// and a word KPI value sits on the figure's baseline.
// Runner: npx tsx --test test/ui.row-geometry.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

interface SvgElement { type: string; props: Record<string, unknown> }

const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const Icon = ui.Icon as (props: Record<string, unknown>) => SvgElement;
const React = ui.React as { createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown };

// The app loads Tailwind preflight from its CDN; these are the preflight rules the measured geometry depends on — the block svg
// is the cause of the icon-over-label defect, so the fixture has to carry it for the test to mean anything.
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; }
  svg { display: block; vertical-align: middle; }
  table { border-collapse: collapse; }
  button, input, select { font: inherit; line-height: inherit; color: inherit; margin: 0; padding: 0; }`;

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// one rendered Icon as markup — the inline style is what this suite is about, so it is carried over verbatim
function iconMarkup(props: Record<string, unknown>): string {
  const { props: attrs } = Icon(props);
  const style = Object.entries((attrs.style as Record<string, string> | undefined) ?? {})
    .map(([key, value]) => `${kebab(key)}: ${value}`)
    .join("; ");
  const className = String(attrs.className ?? "");
  return `<svg width="${attrs.width}" height="${attrs.height}" viewBox="0 0 24 24"${className ? ` class="${className}"` : ""}${style ? ` style="${style}"` : ""}></svg>`;
}

// a rendered host tree as markup — class and children only, enough for the KpiValue atom
function toMarkup(node: RenderedNode | string): string {
  if (typeof node === "string") return node;
  const inner = node.children.map(toMarkup).join("");
  if (!/^[a-z]/.test(node.type)) return inner;
  const className = String(node.props.className ?? "");
  return `<${node.type}${className ? ` class="${className}"` : ""}>${inner}</${node.type}>`;
}

const kpiValueMarkup = (props: Record<string, unknown>, value: string): string =>
  toMarkup(renderScreen(React.createElement(ui.KpiValue, props, value)) as RenderedNode);

const KPI_VALUES = [
  { id: "kpi-figure", markup: kpiValueMarkup({}, "1,284") },
  { id: "kpi-word", markup: kpiValueMarkup({ isWord: true }, "Healthy") },
  { id: "kpi-word-toned", markup: kpiValueMarkup({ isWord: true, tone: "warn" }, "Stale") },
] as const;

const ICON_ROWS = [
  { name: "an icon before its label", id: "plain", markup: iconMarkup({ name: "check", size: 14 }) },
  { name: "an icon whose caller passes an align class", id: "aligned", markup: iconMarkup({ name: "check", size: 14, className: "align-middle" }) },
] as const;

// control family of the .tbl control-cell rule — each sits in a row beside a text cell
const CONTROL_ROWS = [
  { name: "a small button", control: `<button type="button" class="btn sm">Edit</button>` },
  { name: "a button", control: `<button type="button" class="btn">Retry</button>` },
  { name: "a segmented control", control: `<div class="seg"><button type="button" class="active">7d</button><button type="button">30d</button></div>` },
  { name: "a select field", control: `<select class="field field-select"><option>claude-opus</option></select>` },
  { name: "an affixed field", control: `<span class="field-affix"><span class="field-affix__sym">$</span><input class="field" value="12" /></span>` },
  { name: "an interactive pill", control: `<button type="button" class="pill pill--interactive">Implementing</button>` },
] as const;

// column-header rows, one table each: a house .tbl, a geometry-only .tbl--own-face, a table off .tbl that opts in through
// thead.tbl-head (its own rule and inline padding, as the matrix and crosstab tables carry), and the sortable and control cases
const headTable = (row: string, tableAttrs: string, theadAttrs: string, cells: string): string =>
  `<table ${tableAttrs} style="width: 480px;"><thead${theadAttrs}><tr data-row="${row}">${cells}</tr></thead>` +
  `<tbody><tr><td>dev-react</td><td>12</td></tr></tbody></table>`;
const OFF_TBL_TH = `style="padding-inline: 8px; border-bottom: 1px solid;"`;
const HEAD_ROWS = [
  { name: "a house .tbl header row", row: "head-house", px: 32,
    markup: headTable("head-house", `class="tbl"`, "", `<th>Agent</th><th class="num">Runs</th>`) },
  { name: "an own-face .tbl header row", row: "head-own-face", px: 32,
    markup: headTable("head-own-face", `class="tbl tbl--own-face fs-meta"`, "", `<th>Pair</th><th>Fails</th>`) },
  { name: "a header row off .tbl, through thead.tbl-head", row: "head-off-tbl", px: 32,
    markup: headTable("head-off-tbl", `class="fs-meta" style="border-collapse: separate; border-spacing: 0;"`, ` class="tbl-head"`,
      `<th ${OFF_TBL_TH}>Cause</th><th ${OFF_TBL_TH}>Events</th>`) },
  { name: "a sortable header row (a th carrying aria-sort)", row: "head-sortable", px: 40,
    markup: headTable("head-sortable", `class="tbl"`, "", `<th aria-sort="descending"><span style="display: inline-flex;">Time</span></th><th>Agent</th>`) },
  { name: "a header row holding a 32px control", row: "head-control", px: 40,
    markup: headTable("head-control", `class="tbl"`, "", `<th>Agent</th><th><button type="button" class="btn sm">Filter</button></th>`) },
  { name: "a sortable header row holding a 32px control", row: "head-sortable-control", px: 40,
    markup: headTable("head-sortable-control", `class="tbl"`, "", `<th aria-sort="none"><button type="button" class="btn sm">Time</button></th><th>Agent</th>`) },
] as const;

const PAGE = `<!doctype html><html data-theme="light"><head><style>${PREFLIGHT}</style></head><body style="margin: 0; padding: 24px;">
  ${ICON_ROWS.map((row) => `<p id="${row.id}" style="width: 320px;">${row.markup} Healthy</p>`).join("\n  ")}
  <p id="bare" style="width: 320px;"><svg width="14" height="14" viewBox="0 0 24 24"></svg> Healthy</p>
  <table class="tbl" style="width: 480px;"><tbody>
    <tr data-row="text"><td>dev-react</td><td>12 runs</td></tr>
    <tr data-row="pill"><td>dev-react</td><td><span class="pill">Done</span></td></tr>
    <tr data-row="bar"><td>dev-react</td><td class="num tbl-bar-cell"><span id="bar-value" style="display: inline-flex;">92.0%</span><div style="height: 8px;"></div></td></tr>
    ${CONTROL_ROWS.map((row, i) => `<tr data-row="control-${i}"><td>dev-react</td><td>${row.control}</td></tr>`).join("\n    ")}
    <tr data-row="last"><td>last row</td><td>no rule below — keeps every measured row ruled</td></tr>
  </tbody></table>
  ${HEAD_ROWS.map((row) => row.markup).join("\n  ")}
  <div style="display: flex; align-items: flex-start; gap: 24px;">
    ${KPI_VALUES.map((value) => `<div id="${value.id}">${value.markup}</div>`).join("\n    ")}
  </div>
</body></html>`;

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  await page.setContent(PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
});

after(async () => {
  await browser?.close();
});

interface InlineReading { iconTop: number; iconBottom: number; iconRight: number; textTop: number; textBottom: number; textLeft: number }

// the icon box against the first line box of the label text that follows it
async function readInline(id: string): Promise<InlineReading> {
  return page.$eval(`#${id}`, (p) => {
    const svg = p.querySelector("svg");
    const text = [...p.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
    if (!svg || !text) throw new Error(`fixture #${p.id} lacks its icon or label`);
    const range = document.createRange();
    range.selectNodeContents(text);
    const line = range.getClientRects()[0];
    const icon = svg.getBoundingClientRect();
    return { iconTop: icon.top, iconBottom: icon.bottom, iconRight: icon.right, textTop: line.top, textBottom: line.bottom, textLeft: line.left };
  });
}

const rowHeight = (row: string): Promise<number> =>
  page.$eval(`tr[data-row="${row}"]`, (tr) => tr.getBoundingClientRect().height);

describe("an icon stays inline with its label", () => {
  test("precondition: a bare svg under the preflight block rule drops above its label", async () => {
    const reading = await readInline("bare");
    assert.ok(reading.iconBottom <= reading.textTop + 0.5, `the fixture reproduces the defect (icon bottom ${reading.iconBottom}, label top ${reading.textTop})`);
  });

  for (const row of ICON_ROWS) {
    test(`${row.name} shares the label's line and sits before it`, async () => {
      const reading = await readInline(row.id);
      assert.ok(reading.iconTop >= reading.textTop - 1 && reading.iconBottom <= reading.textBottom + 1,
        `icon ${reading.iconTop}–${reading.iconBottom} inside the label line ${reading.textTop}–${reading.textBottom}`);
      assert.ok(reading.iconRight <= reading.textLeft + 0.5, `icon right ${reading.iconRight} before the label at ${reading.textLeft}`);
    });
  }
});

describe("a .tbl row is one 40px line whatever its cells hold", () => {
  const ROW_PX = 40;

  test("a text row rises to 40", async () => {
    assert.equal(await rowHeight("text"), ROW_PX);
  });

  test("a row holding a 24px pill stays 40", async () => {
    assert.equal(await rowHeight("pill"), ROW_PX);
  });

  CONTROL_ROWS.forEach((row, i) => {
    test(`a row holding ${row.name} (32px control) stays 40`, async () => {
      const controlHeight = await page.$eval(`tr[data-row="control-${i}"] td:last-child > *`, (el) => el.getBoundingClientRect().height);
      assert.equal(controlHeight, 32, `${row.name} is a 32px control`);
      assert.equal(await rowHeight(`control-${i}`), ROW_PX);
    });
  });
});

// R-a: one header-row system — a plain header row sits on the 32 compact step, a sortable one on the 40 row step, at the
// shared rule, so a table routed off .tbl reads the same; a header cell holding a control keeps the control step (40)
describe("a column-header row sits on the compact step, a sortable one on the row step", () => {
  for (const row of HEAD_ROWS) {
    test(`${row.name} is ${row.px}`, async () => {
      assert.equal(await rowHeight(row.row), row.px);
    });
  }

  test("a header cell's text sits on its row's centre line", async () => {
    for (const row of ["head-house", "head-off-tbl"]) {
      const { cell, text } = await page.$eval(`tr[data-row="${row}"]`, (tr) => {
        const th = tr.querySelector("th")!;
        const range = document.createRange();
        range.selectNodeContents(th);
        const line = range.getClientRects()[0];
        const box = tr.getBoundingClientRect();
        return { cell: (box.top + box.bottom - 1) / 2, text: (line.top + line.bottom) / 2 };
      });
      assert.ok(Math.abs(cell - text) < 1, `${row}: text centre ${text} vs row centre ${cell} (above its 1px rule)`);
    }
  });
});

describe("a value + bar cell keeps the row at 40", () => {
  test("a row whose cell holds a value over an 8px bar stays 40", async () => {
    assert.equal(await rowHeight("bar"), 40);
  });

  test("the value sits on the centre line of the text cell beside it", async () => {
    const { value, text } = await page.$eval(`tr[data-row="bar"]`, (tr) => {
      const range = document.createRange();
      range.selectNodeContents(tr.querySelector("td")!);
      const line = range.getClientRects()[0];
      const box = tr.querySelector("#bar-value")?.getBoundingClientRect();
      if (!box) throw new Error("fixture lacks the bar value");
      return { value: (box.top + box.bottom) / 2, text: (line.top + line.bottom) / 2 };
    });
    assert.ok(Math.abs(value - text) < 1, `value centre ${value} vs text centre ${text}`);
  });
});

describe("a word KPI value shares the figure's baseline", () => {
  // a zero-size inline-block's bottom edge is its line's baseline
  const baselineOf = (id: string): Promise<number> => page.$eval(`#${id} .kpi-value`, (value) => {
    const probe = document.createElement("span");
    probe.style.cssText = "display: inline-block; width: 0; height: 0;";
    value.append(probe);
    const y = probe.getBoundingClientRect().bottom;
    probe.remove();
    return y;
  });

  test("precondition: the word renders smaller than the figure", async () => {
    const [figure, word] = await Promise.all(["kpi-figure", "kpi-word"].map((id) =>
      page.$eval(`#${id} .kpi-value`, (value) => parseFloat(getComputedStyle(value.lastElementChild ?? value).fontSize))));
    assert.ok(word < figure, `word ${word}px vs figure ${figure}px`);
  });

  for (const id of ["kpi-word", "kpi-word-toned"]) {
    test(`${id} sits on the figure's baseline and keeps its line box height`, async () => {
      const figure = await baselineOf("kpi-figure");
      assert.ok(Math.abs((await baselineOf(id)) - figure) < 0.5, `${id} baseline vs figure ${figure}`);
      const [figureH, wordH] = await Promise.all(["kpi-figure", id].map((key) =>
        page.$eval(`#${key} .kpi-value`, (value) => value.getBoundingClientRect().height)));
      assert.ok(Math.abs(wordH - figureH) < 0.5, `${id} height ${wordH} vs figure ${figureH}`);
    });
  }
});
