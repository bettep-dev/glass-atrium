// Documents ledger row states measured in a real browser on the shipped tokens.css, base.css and the screen's own style block:
// the fill each state paints under the shared table hover, the pending-delete cue matching its twin, and each text pair's contrast on that fill.
// Runner: npx tsx --test test/clauded-docs.ledger-row-states.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

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
// App writes the Tweaks default accent inline on <html> at mount → rows paint under it, never under the tokens.css fallback
const app = await loadScreenModule(resolve(HERE, "../public/src/app.jsx"), {
  ReactDOM: { createRoot: () => ({ render: () => {} }) },
  document: { getElementById: () => null },
});
const RUNTIME_ACCENT = (app.hexToRgbTriplet as (hex: string) => string)(vm.runInContext("TWEAK_DEFAULTS.accent", app) as string);
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

// the ledger sits in the list card's elev; the cells carry the screen's dim meta text, the group member's faint placeholder, an empty stage pip, the stale flag's warn glyph, the crit glyph and the ink title
const ledgerPage = (theme: string) => `<!doctype html><html data-theme="${theme}" style="--accent: ${RUNTIME_ACCENT};"><body style="margin: 0;">
  <div style="padding: 48px;"><div class="card"><table class="tbl"><tbody>
    ${Object.entries(STATES).map(([state, classes]) => `<tr id="${state}" class="doc-row ${classes}">
      <td><span class="doc-stage-meter"><span class="stage-pip"></span></span></td>
      <td class="dim" style="color: rgb(var(--dim));">2026-10-04<div class="doc-age-flag"><span class="glyph-warn" style="color: rgb(var(--warn));">!</span> stale</div></td>
      <td><span class="faint" style="color: rgb(var(--faint));">—</span></td>
      <td class="title-cell"><span class="glyph-crit" style="color: rgb(var(--crit));">!</span> <span class="doc-title-text" style="color: rgb(var(--ink));">Plan</span></td>
    </tr>`).join("")}
  </tbody></table></div></div>
</body></html>`;

interface RowReading {
  fill: Rgba;
  dim: Rgba;
  faint: Rgba;
  ink: Rgba;
  pip: Rgba;
  glyph: { crit: Rgba; warn: Rgba };
  opacity: number;
  boxShadow: string;
  title: { weight: string; decoration: string };
}

interface Ledger {
  card: Rgba;
  sunken: Rgba;
  rest: Record<State, RowReading>;
  hovered: Record<State, RowReading>;
}

async function readRow(page: Page, state: State): Promise<RowReading> {
  const raw = await page.evaluate((id) => {
    const row = document.getElementById(id)!;
    const style = getComputedStyle(row);
    // no named helper in here: tsx's keepNames wraps it in a __name call the page does not define
    const [dim, faint, title, pip, critGlyph, warnGlyph] = [".dim", ".faint", ".doc-title-text", ".stage-pip", ".glyph-crit", ".glyph-warn"].map((selector) =>
      getComputedStyle(row.querySelector(selector)!),
    );
    return {
      fill: style.backgroundColor,
      dim: dim.color,
      faint: faint.color,
      ink: title.color,
      pip: pip.backgroundColor,
      glyph: { crit: critGlyph.color, warn: warnGlyph.color },
      opacity: Number(style.opacity),
      boxShadow: style.boxShadow,
      title: { weight: title.fontWeight, decoration: title.textDecorationLine },
    };
  }, state);
  return {
    ...raw,
    fill: parseColor(raw.fill),
    dim: parseColor(raw.dim),
    faint: parseColor(raw.faint),
    ink: parseColor(raw.ink),
    pip: parseColor(raw.pip),
    glyph: { crit: parseColor(raw.glyph.crit), warn: parseColor(raw.glyph.warn) },
  };
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
  const sunken = parseColor(
    await page.evaluate(() => {
      const probe = document.querySelector(".card")!.appendChild(document.createElement("div"));
      probe.style.background = "rgb(var(--sunken))";
      return getComputedStyle(probe).backgroundColor;
    }),
  );
  await page.close();
  return { card, sunken, rest, hovered };
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

    test(`${theme}: a hovered plain row paints the shared table hover --sunken`, () => {
      const { card, sunken, hovered } = ledgers[theme];
      assert.equal(rgbKey(paintedFill(hovered.plain, card)), rgbKey(sunken));
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
      assert.equal(rest.viewer.title.weight, "600");
      assert.equal(hovered.viewer.title.weight, "600");
    });
  }
});

// a pending row's cue must leave every pair it carries as its non-pending twin paints it → no floor the twin holds can drop
describe("pending-delete cue on every fill the row can paint", () => {
  const TWIN = { pending: "plain", pendingChecked: "checked" } as const;
  const rows = THEMES.flatMap((theme) =>
    (["pending", "pendingChecked"] as const).flatMap((state) =>
      (["rest", "hovered"] as const).map((pointer) => ({ name: `${theme} ${state} row ${pointer}`, theme, state, pointer })),
    ),
  );
  for (const row of rows) {
    test(`${row.name}: paints the fill, text, pip and tone glyphs of its non-pending twin, and strikes the title through`, () => {
      const { card, ...readings } = ledgers[row.theme];
      const reading = readings[row.pointer][row.state];
      const twin = readings[row.pointer][TWIN[row.state]];
      const painted = (r: RowReading) =>
        [paintedFill(r, card), ...[r.dim, r.faint, r.ink, r.pip, r.glyph.crit, r.glyph.warn].map((color) => paintedText(color, r, card))].map(rgbKey);
      assert.deepEqual(painted(reading), painted(twin), `opacity ${reading.opacity}`);
      assert.match(reading.title.decoration, /line-through/);
      assert.doesNotMatch(twin.title.decoration, /line-through/);
    });
  }
});

// every pair a row carries clears its WCAG floor on the fill it paints, at rest and hovered
describe("row-state contrast floors on every fill", () => {
  const FLOORS = { dim: 4.5, faint: 4.5, ink: 4.5, pip: 3, crit: 3, warn: 3 } as const;
  type Pair = keyof typeof FLOORS;
  const pairColor = (r: RowReading, pair: Pair) => (pair === "crit" || pair === "warn" ? r.glyph[pair] : r[pair]);
  const rows = THEMES.flatMap((theme) =>
    (Object.keys(STATES) as State[]).flatMap((state) =>
      (["rest", "hovered"] as const).map((pointer) => ({ name: `${theme} ${state} row ${pointer}`, theme, state, pointer })),
    ),
  );
  for (const row of rows) {
    const ratioOf = (pair: Pair) => {
      const { card, ...readings } = ledgers[row.theme];
      const reading = readings[row.pointer][row.state];
      return contrastRatio(paintedText(pairColor(reading, pair), reading, card), paintedFill(reading, card));
    };

    test(`${row.name}: dim, faint and ink ≥ 4.5:1, empty stage pip, crit and warn glyphs ≥ 3:1`, () => {
      for (const pair of Object.keys(FLOORS) as Pair[]) {
        assert.ok(ratioOf(pair) >= FLOORS[pair], `${pair} ${ratioOf(pair).toFixed(3)}:1`);
      }
    });
  }
});
