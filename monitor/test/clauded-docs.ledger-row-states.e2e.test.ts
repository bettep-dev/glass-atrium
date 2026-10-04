// Documents ledger row states measured in a real browser on the shipped tokens.css, base.css and the screen's own style block:
// the fill each state paints under the shared table hover, and the pending-delete dimming's contrast on that fill.
// Runner: npx tsx --test test/clauded-docs.ledger-row-states.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { createReactStub, collectText, findNodes, loadScreenModule, renderScreen } from "./lib/render-screen.js";
import { compositeOver, contrastRatio, parseColor, type Rgba } from "./lib/wcag-contrast.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const docsScreen = await loadScreenModule(resolve(HERE, "../public/src/screens/clauded-docs.jsx"), {
  UI: ui.UI,
  React: createReactStub(),
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
const SCREEN_CSS = findNodes(renderScreen((docsScreen.ScreenClaudedDocs as (props: unknown) => unknown)({})), (n) => n.type === "style")
  .map((n) => collectText(n))
  .join("\n");

const STATES = {
  plain: "",
  viewer: "is-selected",
  checked: "is-multi-selected",
  both: "is-multi-selected is-selected",
  pending: "is-pending-delete",
  pendingChecked: "is-pending-delete is-multi-selected",
} as const;
type State = keyof typeof STATES;

// the ledger sits in the list card's elev; the cells carry the screen's dim meta text, the crit glyph and the ink title
const ledgerPage = (theme: string) => `<!doctype html><html data-theme="${theme}"><body style="margin: 0;">
  <div style="padding: 48px;"><div class="card"><table class="tbl"><tbody>
    ${Object.entries(STATES).map(([state, classes]) => `<tr id="${state}" class="doc-row ${classes}">
      <td class="dim" style="color: rgb(var(--dim));">2026-10-04</td>
      <td class="title-cell"><span class="glyph" style="color: rgb(var(--crit));">!</span> <span class="doc-title-text" style="color: rgb(var(--ink));">Plan</span></td>
    </tr>`).join("")}
  </tbody></table></div></div>
</body></html>`;

interface RowReading {
  fill: Rgba;
  dim: Rgba;
  ink: Rgba;
  glyph: Rgba;
  opacity: number;
  boxShadow: string;
  titleWeight: string;
}

interface Ledger {
  card: Rgba;
  rest: Record<State, RowReading>;
  hovered: Record<State, RowReading>;
}

async function readRow(page: Page, state: State): Promise<RowReading> {
  const raw = await page.evaluate((id) => {
    const row = document.getElementById(id)!;
    const style = getComputedStyle(row);
    // no named helper in here: tsx's keepNames wraps it in a __name call the page does not define
    const [dim, title, glyph] = [".dim", ".doc-title-text", ".glyph"].map((selector) => getComputedStyle(row.querySelector(selector)!));
    return {
      fill: style.backgroundColor,
      dim: dim.color,
      ink: title.color,
      glyph: glyph.color,
      opacity: Number(style.opacity),
      boxShadow: style.boxShadow,
      titleWeight: title.fontWeight,
    };
  }, state);
  return { ...raw, fill: parseColor(raw.fill), dim: parseColor(raw.dim), ink: parseColor(raw.ink), glyph: parseColor(raw.glyph) };
}

async function readLedger(theme: string): Promise<Ledger> {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, reducedMotion: "reduce" });
  await page.setContent(ledgerPage(theme));
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
  await page.addStyleTag({ content: SCREEN_CSS });
  const states = Object.keys(STATES) as State[];
  const rest = {} as Record<State, RowReading>;
  const hovered = {} as Record<State, RowReading>;
  for (const state of states) rest[state] = await readRow(page, state);
  for (const state of states) {
    await page.hover(`#${state}`);
    hovered[state] = await readRow(page, state);
  }
  const card = parseColor(await page.evaluate(() => getComputedStyle(document.querySelector(".card")!).backgroundColor));
  await page.close();
  return { card, rest, hovered };
}

// a row's opacity composites its whole group over the card → the fill's alpha and every opaque text colour scale by it
const paintedFill = (row: RowReading, card: Rgba) => compositeOver({ ...row.fill, a: row.fill.a * row.opacity }, card);
const paintedText = (color: Rgba, row: RowReading, card: Rgba) => compositeOver({ ...color, a: color.a * row.opacity }, card);
const rgbKey = (c: Rgba) => [c.r, c.g, c.b].map(Math.round).join(" ");

let browser: Browser;
const ledgers: Record<string, Ledger> = {};
const THEMES = ["light", "dark"] as const;

before(async () => {
  browser = await chromium.launch();
  for (const theme of THEMES) ledgers[theme] = await readLedger(theme);
});

after(async () => {
  await browser?.close();
});

describe("ledger row fills under the shared table hover", () => {
  for (const theme of THEMES) {
    test(`${theme}: viewer focus, checked and both paint the same fill hovered as at rest`, () => {
      const { card, rest, hovered } = ledgers[theme];
      for (const state of ["viewer", "checked", "both"] as const) {
        assert.equal(rgbKey(paintedFill(hovered[state], card)), rgbKey(paintedFill(rest[state], card)), `${state} row changes fill on hover`);
      }
    });

    test(`${theme}: hover, viewer focus, checked and both paint four distinct fills, and hover differs from a resting row`, () => {
      const { card, rest, hovered } = ledgers[theme];
      const fills = {
        hover: rgbKey(paintedFill(hovered.plain, card)),
        viewer: rgbKey(paintedFill(rest.viewer, card)),
        checked: rgbKey(paintedFill(rest.checked, card)),
        both: rgbKey(paintedFill(rest.both, card)),
      };
      assert.equal(new Set(Object.values(fills)).size, 4, `fills ${JSON.stringify(fills)} must differ`);
      assert.notEqual(fills.hover, rgbKey(paintedFill(rest.plain, card)), "a hovered row reads apart from a resting one");
    });

    test(`${theme}: no row state draws a stripe, and the viewer row's title carries the heavier weight`, () => {
      const { rest, hovered } = ledgers[theme];
      for (const reading of [...Object.values(rest), ...Object.values(hovered)]) assert.equal(reading.boxShadow, "none");
      assert.equal(rest.viewer.titleWeight, "600");
      assert.equal(hovered.viewer.titleWeight, "600");
    });
  }
});

describe("pending-delete dimming on every fill the row can paint", () => {
  const rows = THEMES.flatMap((theme) =>
    (["pending", "pendingChecked"] as const).flatMap((state) =>
      (["rest", "hovered"] as const).map((pointer) => ({ name: `${theme} ${state} row ${pointer}: dim and ink cells ≥ 4.5:1, crit glyph ≥ 3:1, row dimmed`, theme, state, pointer })),
    ),
  );
  for (const row of rows) {
    test(row.name, () => {
      const { card, ...readings } = ledgers[row.theme];
      const reading = readings[row.pointer][row.state];
      const fill = paintedFill(reading, card);
      const ratio = (color: Rgba) => contrastRatio(paintedText(color, reading, card), fill);
      assert.ok(reading.opacity < 1, "a pending row reads dimmed");
      assert.ok(ratio(reading.dim) >= 4.5, `dim cell ${ratio(reading.dim).toFixed(2)}:1`);
      assert.ok(ratio(reading.ink) >= 4.5, `ink title ${ratio(reading.ink).toFixed(2)}:1`);
      assert.ok(ratio(reading.glyph) >= 3, `crit glyph ${ratio(reading.glyph).toFixed(2)}:1`);
    });
  }
});
