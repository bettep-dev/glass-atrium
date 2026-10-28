// Shared-atom geometry read in a real browser: an icon stays inline with its label, and a .tbl row holding a 32px control stays 40.
// Runner: npx tsx --test test/ui.row-geometry.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { loadScreenModule } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

interface SvgElement { type: string; props: Record<string, unknown> }

const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const Icon = ui.Icon as (props: Record<string, unknown>) => SvgElement;

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

const PAGE = `<!doctype html><html data-theme="light"><head><style>${PREFLIGHT}</style></head><body style="margin: 0; padding: 24px;">
  ${ICON_ROWS.map((row) => `<p id="${row.id}" style="width: 320px;">${row.markup} Healthy</p>`).join("\n  ")}
  <p id="bare" style="width: 320px;"><svg width="14" height="14" viewBox="0 0 24 24"></svg> Healthy</p>
  <table class="tbl" style="width: 480px;"><tbody>
    <tr data-row="text"><td>dev-react</td><td>12 runs</td></tr>
    <tr data-row="pill"><td>dev-react</td><td><span class="pill">Done</span></td></tr>
    ${CONTROL_ROWS.map((row, i) => `<tr data-row="control-${i}"><td>dev-react</td><td>${row.control}</td></tr>`).join("\n    ")}
    <tr data-row="last"><td>last row</td><td>no rule below — keeps every measured row ruled</td></tr>
  </tbody></table>
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
