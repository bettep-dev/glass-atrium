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

import { createReactStub, collectText, findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";
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
const ledgerPage = (theme: string) => `<!doctype html><html data-theme="${theme}" style="--accent: ${RUNTIME_ACCENT};"><head><style>${UTILITIES}</style></head><body style="margin: 0;">
  <div style="padding: 48px;"><div class="card"><table class="tbl"><tbody>
    ${Object.entries(STATES).map(([state, classes]) => `<tr id="${state}" class="doc-row ${classes}">
      <td><span class="doc-stage-meter"><span class="stage-pip"></span></span></td>
      <td class="doc-age-cell doc-col-num text-dim"><div class="doc-age-line flex justify-end items-center gap-label-inline"><span class="doc-age-value flex-none">15d</span><span class="doc-age-flag relative inline-flex items-center flex-none text-dim"><span class="glyph-warn" style="color: rgb(var(--warn));">!</span><span class="sr-only">stale</span></span></div></td>
      <td><span class="faint" style="color: rgb(var(--faint));">—</span></td>
      <td class="title-cell"><span class="glyph-crit" style="color: rgb(var(--crit));">!</span> <span class="doc-title-text text-ink">Plan</span></td>
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

async function readLedger(theme: string): Promise<Ledger> {
  const page = await openLedgerPage(theme);
  const states = Object.keys(STATES) as State[];
  const rest = {} as Record<State, RowReading>;
  const hovered = {} as Record<State, RowReading>;
  for (const state of states) rest[state] = await readRow(page, state);
  for (const state of states) {
    await page.hover(`#${state}`);
    hovered[state] = await readRow(page, state);
  }
  const surfaces = await readSurfaces(page);
  await page.close();
  return { ...surfaces, rest, hovered };
}

async function openLedgerPage(theme: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, reducedMotion: "reduce" });
  await page.setContent(ledgerPage(theme));
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
  await page.addStyleTag({ content: SCREEN_CSS });
  return page;
}

async function readRow(page: Page, state: State): Promise<RowReading> {
  return parseRowStyles(await page.evaluate(readRowStyles, state));
}

// runs in the page → closes over nothing and holds no named helper: tsx's keepNames wraps one in a __name call the page does not define
const readRowStyles = (id: string) => {
  const row = document.getElementById(id)!;
  const style = getComputedStyle(row);
  const [dim, faint, title, pip, critGlyph, warnGlyph] = [".doc-age-cell", ".faint", ".doc-title-text", ".stage-pip", ".glyph-crit", ".glyph-warn"].map((selector) =>
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
};

const parseRowStyles = (raw: ReturnType<typeof readRowStyles>): RowReading => ({
  ...raw,
  fill: parseColor(raw.fill),
  dim: parseColor(raw.dim),
  faint: parseColor(raw.faint),
  ink: parseColor(raw.ink),
  pip: parseColor(raw.pip),
  glyph: { crit: parseColor(raw.glyph.crit), warn: parseColor(raw.glyph.warn) },
});

async function readSurfaces(page: Page): Promise<Pick<Ledger, "card" | "sunken">> {
  const card = parseColor(await page.evaluate(() => getComputedStyle(document.querySelector(".card")!).backgroundColor));
  const sunken = parseColor(
    await page.evaluate(() => {
      const probe = document.querySelector(".card")!.appendChild(document.createElement("div"));
      probe.style.background = "rgb(var(--sunken))";
      return getComputedStyle(probe).backgroundColor;
    }),
  );
  return { card, sunken };
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

// hand fixtures carry the page's utility classes → the Tailwind values they resolve to, minus the runtime
const UTILITIES = ".relative { position: relative; } .absolute { position: absolute; } .flex { display: flex; } .items-center { align-items: center; }" +
  " .justify-center { justify-content: center; } .mx-auto { margin-left: auto; margin-right: auto; } .pointer-events-none { pointer-events: none; }" +
  " .flex-auto { flex: 1 1 auto; } .min-w-0 { min-width: 0; } .flex-nowrap { flex-wrap: nowrap; } .text-faint { color: rgb(var(--faint) / 1); }" +
  " .inline-flex { display: inline-flex; } .justify-end { justify-content: flex-end; } .flex-none { flex: none; } .gap-label-inline { gap: var(--gap-label-inline); }" +
  " .text-dim { color: rgb(var(--dim) / 1); } .text-ink { color: rgb(var(--ink) / 1); }";

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

const ageCellHtml = (label: string) =>
  getHtml(renderScreen((docsScreen.DocAgeCellCD as (props: unknown) => unknown)({ createdAt: "2026-10-04T00:00:00Z", age: { label }, isStale: true })) as RenderedNode);

// a Created column at its floor holding stale rows → the age and its glyph share one line box inside the floor; --fs-meta raised on one cell stands in for a wider face.
// The app loads Tailwind preflight and .sr-only from its CDN; the rules below are the ones this geometry depends on (as in ui.row-geometry) — the block svg among them.
const AGE_PREFLIGHT =
  "*, ::before, ::after { box-sizing: border-box; border: 0 solid; } html { line-height: 1.5; } svg { display: block; vertical-align: middle; } table { border-collapse: collapse; }" +
  " .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border-width: 0; }";
const ageCellPage = (floor: number) => `<!doctype html><html data-theme="dark"><head><style>${AGE_PREFLIGHT} ${UTILITIES}</style></head><body style="margin: 0;">
  <div style="padding: 48px; width: 600px;"><div class="card"><table class="tbl"><thead><tr><th>Title</th><th class="doc-col-num" style="width: ${floor}px; min-width: ${floor}px;">Created</th></tr></thead><tbody>
    <tr id="two-digit" class="doc-row"><td>Plan</td>${ageCellHtml("15d")}</tr>
    <tr id="three-digit" class="doc-row"><td>Plan</td>${ageCellHtml("120d")}</tr>
    <tr id="wide-face" class="doc-row" style="--fs-meta: 20px;"><td>Plan</td>${ageCellHtml("120d")}</tr>
  </tbody></table></div></div>
</body></html>`;

describe("the Created cell keeps its age and stale glyph on one line", () => {
  type AgeReading = {
    rowH: number;
    lineW: number;
    gap: number;
    roleGap: number;
    valueTop: number;
    valueBottom: number;
    flagTop: number;
    flagBottom: number;
    glyphShown: boolean;
    wordPainted: boolean;
    word: string;
    flagTitle: string;
  };
  const readings: Record<string, AgeReading> = {};
  let content = 0;

  before(async () => {
    const floor = vm.runInContext("LEDGER_CD.FLOOR.created", docsScreen) as number;
    content = floor - (vm.runInContext("LEDGER_CD.PADDING.edge", docsScreen) as number);
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.setContent(ageCellPage(floor));
    await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
    await page.addStyleTag({ path: resolve(STYLES, "base.css") });
    await page.addStyleTag({ content: SCREEN_CSS });
    for (const id of ["two-digit", "three-digit", "wide-face"])
      // runs in the page → no named helper (see readRowStyles)
      readings[id] = await page.evaluate((rowId) => {
        const row = document.getElementById(rowId)!;
        const flagEl = row.querySelector(".doc-age-flag")!;
        const flag = flagEl.getBoundingClientRect();
        const value = row.querySelector(".doc-age-value")!.getBoundingClientRect();
        const glyph = row.querySelector(".doc-age-flag svg")!.getBoundingClientRect();
        const wordEl = row.querySelector(".doc-age-flag .sr-only")!;
        const word = wordEl.getBoundingClientRect();
        const probe = document.createElement("div");
        probe.style.columnGap = "var(--gap-label-inline)";
        row.append(probe);
        const roleGap = parseFloat(getComputedStyle(probe).columnGap);
        probe.remove();
        return {
          rowH: row.getBoundingClientRect().height,
          lineW: flag.right - value.left,
          gap: flag.left - value.right,
          roleGap,
          valueTop: value.top,
          valueBottom: value.bottom,
          flagTop: flag.top,
          flagBottom: flag.bottom,
          glyphShown: glyph.width > 0 && glyph.top >= flag.top - 0.5 && glyph.bottom <= flag.bottom + 0.5,
          wordPainted: word.width > 1 && word.height > 1,
          word: wordEl.textContent ?? "",
          flagTitle: flagEl.getAttribute("title") ?? "",
        };
      }, id);
    await page.close();
  });

  for (const id of ["two-digit", "three-digit"])
    test(`a ${id} stale age shows its glyph one inline-label gap beside the value on one 40px row, inside the Created floor`, () => {
      const r = readings[id];
      assert.equal(Math.round(r.rowH), 40, `row height ${r.rowH}`);
      assert.ok(Math.abs((r.flagTop + r.flagBottom) / 2 - (r.valueTop + r.valueBottom) / 2) <= 1, `flag ${r.flagTop}–${r.flagBottom} off the value's line ${r.valueTop}–${r.valueBottom}`);
      assert.ok(r.lineW <= content, `age line ${r.lineW}px past the ${content}px floor content`);
      assert.ok(r.roleGap > 0 && Math.abs(r.gap - r.roleGap) <= 0.5, `value ↔ glyph ${r.gap}px, role gap ${r.roleGap}px`);
      assert.ok(r.glyphShown, "the glyph shows");
    });

  test("the glyph-only flag keeps the word stale for a screen reader and in its tooltip, never painted", () => {
    const r = readings["three-digit"];
    assert.equal(r.word, "stale");
    assert.equal(r.wordPainted, false, "the word is visually hidden");
    assert.match(r.flagTitle, /stale/i);
  });

  test("a wider face never stacks the glyph under the value", () => {
    const r = readings["wide-face"];
    assert.ok(Math.abs((r.flagTop + r.flagBottom) / 2 - (r.valueTop + r.valueBottom) / 2) <= 1, `flag ${r.flagTop}–${r.flagBottom} off the value's line ${r.valueTop}–${r.valueBottom}`);
    assert.ok(r.glyphShown, "the glyph stays");
  });
});

describe("the select column and the stage section heads sit on the ledger's grid", () => {
  // the shipped DocCheckboxCD; its wrapper lays out on Tailwind utilities, which the app loads from its CDN → their rules ride the page
  const checkbox = getHtml(renderScreen((docsScreen.DocCheckboxCD as (props: unknown) => unknown)({ checked: false, onChange: () => {}, ariaLabel: "Select Plan" })) as RenderedNode);
  // the app's preflight sizes boxes border-box → the select floor is the cell's whole width, as it renders
  const gridPage = `<!doctype html><html data-theme="light"><head><style>*, ::before, ::after { box-sizing: border-box; } button { padding: 0; } ${UTILITIES}</style></head><body style="margin: 0;">
    <div style="padding: 48px;"><div class="card"><table class="tbl" style="width: 600px;">
      <thead><tr><th scope="col" class="doc-checkbox-cell" id="head-select">${checkbox}</th><th scope="col">Title</th></tr></thead>
      <tbody>
        <tr class="doc-stage-section" id="section"><th scope="colgroup" colspan="2" role="heading" aria-level="2" tabindex="-1" class="tbl-cell tbl-cell--group-header">Implementing<span class="doc-stage-section-count text-faint ml-label-inline">3</span></th></tr>
        <tr class="doc-row" id="doc"><td class="doc-checkbox-cell" id="row-select">${checkbox}</td><td>Plan</td></tr>
        <tr class="doc-row" id="group"><td class="doc-checkbox-cell"></td><td class="title-cell"><div class="doc-title-row"><span class="doc-title-lead" id="group-lead"><button type="button" class="doc-group-toggle inline-target gap-label-inline" id="group-toggle" aria-label="Expand group (3 documents)"><svg class="chevron" width="10" height="10"></svg></button></span><span class="doc-title-main flex flex-auto min-w-0 items-center flex-nowrap">Group</span></div></td></tr>
      </tbody>
    </table></div></div>
  </body></html>`;
  let page: Page;

  before(async () => {
    page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.setContent(gridPage);
    await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
    await page.addStyleTag({ path: resolve(STYLES, "base.css") });
    await page.addStyleTag({ content: SCREEN_CSS });
  });

  after(async () => {
    await page?.close();
  });

  for (const id of ["head-select", "row-select"]) {
    test(`the checkbox sits on its cell's centre (${id})`, async () => {
      const { cell, box } = await page.$eval(`#${id}`, (el) => ({
        cell: el.getBoundingClientRect().toJSON() as DOMRect,
        box: el.querySelector("input")!.getBoundingClientRect().toJSON() as DOMRect,
      }));
      const offset = (box.left + box.right) / 2 - (cell.left + cell.right) / 2;
      assert.ok(Math.abs(offset) <= 0.5, `checkbox centre ${offset}px off the cell centre`);
    });
  }

  // a click 3px past the 16 box on each side still toggles it; the cell keeps the select floor and the row its 40
  test("the checkbox keeps its 16 box inside the select floor and takes a 24 hit area that toggles it", async () => {
    const floor = vm.runInContext("LEDGER_CD.FLOOR.select", docsScreen) as number;
    const { cell, box, rowH } = await page.$eval("#row-select", (el) => ({
      cell: el.getBoundingClientRect().toJSON() as DOMRect,
      box: el.querySelector("input")!.getBoundingClientRect().toJSON() as DOMRect,
      rowH: el.parentElement!.getBoundingClientRect().height,
    }));
    assert.equal(box.width, 16);
    assert.equal(box.height, 16);
    assert.ok(Math.abs(cell.width - floor) < 0.5, `select cell ${cell.width}px vs the ${floor}px floor`);
    assert.ok(Math.abs(rowH - 40) < 0.5, `row ${rowH}px`);
    const centre = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
    const edges = [
      { name: "left", x: box.left - 3, y: centre.y },
      { name: "right", x: box.right + 3, y: centre.y },
      { name: "top", x: centre.x, y: box.top - 3 },
      { name: "bottom", x: centre.x, y: box.bottom + 3 },
    ];
    for (const edge of edges) {
      const before = await page.$eval("#row-select input", (el) => (el as HTMLInputElement).checked);
      await page.mouse.click(edge.x, edge.y);
      const after = await page.$eval("#row-select input", (el) => (el as HTMLInputElement).checked);
      assert.notEqual(after, before, `a click 3px past the ${edge.name} edge toggles the checkbox`);
    }
  });

  // the button resets to no padding → its hit area is the inline target filling the lead slot, chevron centred
  test("a group toggle fills its 20 lead slot with a 24 hit area and centres its chevron", async () => {
    const { lead, toggle, chevron } = await page.$eval("#group-lead", (el) => ({
      lead: el.getBoundingClientRect().toJSON() as DOMRect,
      toggle: el.querySelector("button")!.getBoundingClientRect().toJSON() as DOMRect,
      chevron: el.querySelector("svg")!.getBoundingClientRect().toJSON() as DOMRect,
    }));
    assert.ok(Math.abs(toggle.width - lead.width) < 0.5 && Math.abs(lead.width - 20) < 0.5, `toggle ${toggle.width}px in a ${lead.width}px slot`);
    assert.ok(Math.abs(toggle.height - 24) < 0.5, `toggle ${toggle.height}px tall`);
    const offset = (chevron.left + chevron.right) / 2 - (toggle.left + toggle.right) / 2;
    assert.ok(Math.abs(offset) <= 0.5, `chevron centre ${offset}px off the toggle centre`);
  });

  test("a stage section head is a 40 row like the ledger rows", async () => {
    const [section, doc] = await Promise.all(["section", "doc"].map((id) => page.$eval(`#${id}`, (tr) => tr.getBoundingClientRect().height)));
    assert.ok(Math.abs(section - 40) < 0.5, `section row ${section}px`);
    assert.ok(Math.abs(doc - 40) < 0.5, `ledger row ${doc}px`);
  });

  test("a stage section head reads in the house header face at weight 600, its label on a 12 over 4 inset", async () => {
    const head = await page.$eval("#section > th", (th) => {
      const style = getComputedStyle(th);
      const root = getComputedStyle(document.documentElement);
      return { fontSize: style.fontSize, metaSize: root.getPropertyValue("--fs-meta").trim(), weight: style.fontWeight,
        paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, background: style.backgroundColor, textAlign: style.textAlign };
    });
    assert.equal(head.fontSize, head.metaSize);
    assert.equal(head.weight, "600");
    assert.deepEqual([head.paddingTop, head.paddingBottom], ["12px", "4px"]);
    assert.equal(head.textAlign, "left");
    assert.notEqual(head.background, "rgba(0, 0, 0, 0)", "the head keeps the sunken header fill");
  });
});

describe("a group member nests one lead slot under its root on both table modes", () => {
  const groupRows = (mode: string) => `
    <tr class="doc-row is-group-root"><td class="doc-checkbox-cell"></td><td class="title-cell" id="${mode}-root"><div class="doc-title-row"><span class="doc-title-lead"><button type="button" class="doc-group-toggle inline-target" aria-label="Collapse group (2 documents)"><svg class="chevron" width="10" height="10"></svg></button></span><span class="doc-title-main flex flex-auto min-w-0 items-center flex-nowrap">Release plan</span></div></td></tr>
    <tr class="doc-row is-group-member"><td class="doc-checkbox-cell"></td><td class="title-cell" id="${mode}-member"><div class="doc-title-row"><span class="doc-title-lead"><span class="doc-drag-handle">⠿</span></span><span class="doc-title-main flex flex-auto min-w-0 items-center flex-nowrap">Release plan rev 2</span></div></td></tr>`;
  const nestPage = `<!doctype html><html data-theme="dark"><head><style>*, ::before, ::after { box-sizing: border-box; } button { padding: 0; } ${UTILITIES}</style></head><body style="margin: 0;">
    <div style="padding: 48px;"><div class="card">
      <table class="tbl doc-ledger" style="width: 600px;"><tbody>${groupRows("wide")}</tbody></table>
      <table class="tbl tbl--stacked doc-ledger" style="width: 600px;"><tbody>${groupRows("stacked")}</tbody></table>
    </div></div>
  </body></html>`;
  let page: Page;

  before(async () => {
    page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.setContent(nestPage);
    await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
    await page.addStyleTag({ path: resolve(STYLES, "base.css") });
    await page.addStyleTag({ content: SCREEN_CSS });
  });

  after(async () => {
    await page?.close();
  });

  for (const mode of ["wide", "stacked"]) {
    test(`${mode}: the member title starts one lead slot right of the root title, its guide on the root chevron's centre`, async () => {
      const lead = vm.runInContext("DOC_LEAD_SLOT_PX_CD", docsScreen) as number;
      const rootMainLeft = await page.$eval(`#${mode}-root .doc-title-main`, (el) => el.getBoundingClientRect().left);
      const chevron = await page.$eval(`#${mode}-root svg`, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
      const member = await page.$eval(`#${mode}-member`, (td) => {
        const guide = getComputedStyle(td, "::before");
        return { mainLeft: td.querySelector(".doc-title-main")!.getBoundingClientRect().left,
          guideCentre: td.getBoundingClientRect().left + parseFloat(guide.left) + parseFloat(guide.width) / 2 };
      });
      assert.ok(Math.abs(member.mainLeft - rootMainLeft - lead) < 0.5, `member title ${member.mainLeft - rootMainLeft}px right of the root's, lead slot ${lead}px`);
      const chevronCentre = (chevron.left + chevron.right) / 2;
      assert.ok(Math.abs(member.guideCentre - chevronCentre) < 0.5, `guide centre ${member.guideCentre - chevronCentre}px off the root chevron centre`);
    });
  }
});
