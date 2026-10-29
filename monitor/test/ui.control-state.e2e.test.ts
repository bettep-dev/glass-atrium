// Control-atom state invariance read in a real browser: no state of .btn, a .seg option or .pill--interactive changes its
// border-box, so a selected option never reads as a bigger box than its siblings; a resting toggle's edge reads against its card
// at 3:1 in both themes, so its box is visible before it is selected, and a resting field rests on that same edge, 3:1 on every surface;
// an errored field keeps its error edge under hover; the shipped control row holds them on one 48 line.
// Runner: npx tsx --test test/ui.control-state.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, CDPSession, Page } from "playwright";
import { chromium } from "playwright";

import { type Box, createControlProbe, isSameBox } from "./lib/control-probe.js";
import { contrastRatio, parseColor } from "./lib/wcag-contrast.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

// the Tailwind preflight rules the measured boxes depend on — a button inherits the page font, weight included
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; }
  button { font: inherit; line-height: inherit; color: inherit; margin: 0; padding: 0; }`;

// one toggle per atom on a card, each beside a sibling it must not push; labels are the screens' own
const ATOMS = [
  { name: "a toggle button", id: "btn", markup: `<button type="button" class="btn" data-atom="btn" aria-pressed="false">Normal range</button>` },
  { name: "a small toggle button", id: "btn-sm", markup: `<button type="button" class="btn sm" data-atom="btn-sm" aria-pressed="false">Normal range</button>` },
  { name: "a segmented option", id: "seg",
    markup: `<div class="seg" data-atom="seg-group"><button type="button" data-atom="seg" aria-pressed="false">30d</button><button type="button" aria-pressed="false">90d</button></div>` },
  { name: "a filter chip", id: "pill",
    markup: `<button type="button" class="pill pill--interactive" data-atom="pill" aria-pressed="false">Open 17</button>` },
] as const;

// one field-family control per atom, each with the focus state its own rule keys on: the affix wrapper owns border and focus
const FIELDS = [
  { name: "a text field", id: "input", focus: ["focus-visible"],
    markup: `<input type="text" class="field field--mono" data-field="input" aria-label="Model id" value="claude-opus">` },
  { name: "a select field", id: "select", focus: ["focus-visible"],
    markup: `<select class="field field-select" data-field="select" aria-label="Saved target"><option>Default</option></select>` },
  { name: "an affixed field", id: "affix", focus: ["focus-within"],
    markup: `<span class="field-affix" data-field="affix"><span class="field-affix__sym">$</span><input type="text" class="field field--mono" aria-label="Monthly budget" value="40"></span>` },
  { name: "a search field", id: "search", focus: ["focus-visible"],
    markup: `<input type="search" class="field" data-field="search" placeholder="Search…" aria-label="Search documents">` },
] as const;
// the error lives on the text field itself, and on the affix's wrapper, which owns the affixed field's edge
const ERRORED_FIELDS = [
  { name: "an errored text field", id: "input-error",
    markup: `<input type="text" class="field field--mono is-error" data-field="input-error" aria-label="Custom model id" value="claude-">` },
  { name: "an errored affixed field", id: "affix-error",
    markup: `<span class="field-affix is-error" data-field="affix-error"><span class="field-affix__sym">$</span><input type="text" class="field field--mono" aria-label="Per-call cap" value="-1"></span>` },
] as const;
// the opaque fills a field sits on: a card (elev), the page (surface), a recessed well (sunken)
const SURFACES = ["elev", "surface", "sunken"] as const;

// the toolbar is the shipped control row; a static count pill rides it at the control height
const PAGE = `<!doctype html><html data-theme="light"><head><style>${PREFLIGHT}</style></head><body style="margin: 0; padding: 24px;">
  <div class="card">
    <div class="control-row" data-row="toolbar">
      ${ATOMS.map((atom) => atom.markup).join("\n      ")}
      <span class="pill pill--count pill--ctl-h">17 open</span>
      <button type="button" class="btn" data-atom="btn-plain">Refresh</button>
    </div>
  </div>
  <div class="card" style="width: 240px; margin-top: 24px;">
    <div class="control-row" data-row="wrapped">
      <button type="button" class="btn">Normal range</button>
      <button type="button" class="btn">Refresh</button>
      <span class="pill pill--count pill--ctl-h">17 open</span>
    </div>
  </div>
  ${SURFACES.map((surface) => `<div class="card" data-surface="${surface}"
    style="background: rgb(var(--${surface})); width: 320px; padding: 16px; gap: 8px; margin-top: 24px;">
    ${FIELDS.map((field) => field.markup).join("\n    ")}
  </div>`).join("\n  ")}
  <div class="card" data-card="errored" style="width: 320px; padding: 16px; margin-top: 24px;">
    ${ERRORED_FIELDS.map((field) => field.markup).join("\n    ")}
    <span data-probe="crit" style="color: rgb(var(--crit));">crit</span>
    <span data-probe="faint" style="color: rgb(var(--faint));">faint</span>
    <span data-probe="accent" style="color: rgb(var(--accent));">accent</span>
  </div>
</body></html>`;

// each state is applied to the one measured element and undone after reading; hover and focus-visible are forced through CDP,
// so neither depends on pointer position or on how a focus call decides keyboard modality
const STATES = [
  { name: "hover", pseudo: ["hover"] },
  { name: "focus-visible", pseudo: ["focus-visible"] },
  { name: "pressed", attr: ["aria-pressed", "true"] },
  { name: "disabled", attr: ["disabled", ""] },
] as const;

let browser: Browser;
let page: Page;
let cdp: CDPSession;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1024, height: 600 } });
  await page.emulateMedia({ reducedMotion: "reduce" }); // base.css drops its colour transitions → a computed colour is read settled
  await page.setContent(PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
  cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
});

after(async () => {
  await browser?.close();
});

const probe = createControlProbe(() => page, () => cdp);
const getAtomSelector = (id: string) => `[data-atom="${id}"]`;
const readBox = (id: string): Promise<Box> => probe.readBox(getAtomSelector(id));
const forcePseudo = (id: string, classes: readonly string[]) => probe.forcePseudo(getAtomSelector(id), classes);
const readStyle = (id: string, prop: string) => probe.readStyle(getAtomSelector(id), prop);

async function readBoxInState(id: string, state: (typeof STATES)[number]): Promise<Box> {
  if ("pseudo" in state) {
    await forcePseudo(id, state.pseudo);
    try { return await readBox(id); } finally { await forcePseudo(id, []); }
  }
  const [attr, value] = state.attr;
  const selector = getAtomSelector(id);
  const previous = await page.$eval(selector, (el, name) => el.getAttribute(name), attr);
  await page.$eval(selector, (el, [name, next]) => el.setAttribute(name, next), [attr, value] as const);
  try {
    return await readBox(id);
  } finally {
    await page.$eval(selector, (el, [name, prior]) => (prior === null ? el.removeAttribute(name) : el.setAttribute(name, prior)),
      [attr, previous] as const);
  }
}

describe("precondition: a forced state reaches the cascade", () => {
  test("forced hover repaints a button's fill", async () => {
    const rest = await readStyle("btn", "background-color");
    await forcePseudo("btn", ["hover"]);
    try { assert.notEqual(await readStyle("btn", "background-color"), rest); } finally { await forcePseudo("btn", []); }
  });

  test("forced focus-visible draws the focus outline", async () => {
    await forcePseudo("btn", ["focus-visible"]);
    try { assert.notEqual(await readStyle("btn", "outline-style"), "none"); } finally { await forcePseudo("btn", []); }
  });
});

for (const atom of ATOMS) {
  describe(`${atom.name} keeps its border-box in every state`, () => {
    for (const state of STATES) {
      test(`${state.name} matches the resting box`, async () => {
        const rest = await readBox(atom.id);
        const changed = await readBoxInState(atom.id, state);
        assert.ok(Math.abs(changed.width - rest.width) < 0.01, `${atom.id} ${state.name} width ${changed.width} vs resting ${rest.width}`);
        assert.ok(Math.abs(changed.height - rest.height) < 0.01, `${atom.id} ${state.name} height ${changed.height} vs resting ${rest.height}`);
      });
    }
  });
}

describe("a control row is one 48 line: every item centred on it, 12 between items", () => {
  const readToolbar = () =>
    page.$eval('[data-row="toolbar"]', (row) => ({
      row: row.getBoundingClientRect().toJSON() as DOMRect,
      items: [...row.children].map((el) => el.getBoundingClientRect().toJSON() as DOMRect),
    }));

  test("the row is 48 and holds every item on one line", async () => {
    const { row, items } = await readToolbar();
    assert.equal(row.height, 48);
    assert.ok(items.every((item) => Math.abs(item.top - items[0].top) < 16), "every item sits on the first line");
  });

  test("every item centres on the row's centre line, the static pill at the control height", async () => {
    const { row, items } = await readToolbar();
    const centre = row.top + row.height / 2;
    for (const [i, item] of items.entries()) {
      assert.ok(Math.abs(item.top + item.height / 2 - centre) <= 0.5, `item ${i} centre ${item.top + item.height / 2} vs row centre ${centre}`);
      assert.equal(item.height, 32, `item ${i} height`);
    }
  });

  test("adjacent items — each a group of one here — sit the 12 between-groups step apart", async () => {
    const { items } = await readToolbar();
    for (let i = 1; i < items.length; i += 1) assert.equal(items[i].left - items[i - 1].right, 12, `gap before item ${i}`);
  });

  test("a row wrapped onto more lines keeps the one-line 8 inset above its first line and below its last", async () => {
    const { row, items } = await page.$eval('[data-row="wrapped"]', (el) => ({
      row: el.getBoundingClientRect().toJSON() as DOMRect,
      items: [...el.children].map((child) => child.getBoundingClientRect().toJSON() as DOMRect),
    }));
    assert.ok(items.some((item) => item.top > items[0].bottom), "precondition: the narrow row wraps");
    assert.equal(Math.min(...items.map((item) => item.top)) - row.top, 8, "inset above the first line");
    assert.equal(row.bottom - Math.max(...items.map((item) => item.bottom)), 8, "inset below the last line");
  });
});

// the edge each toggle rests on: a bordered atom's border, the .seg group's shadow ring
const RESTING_EDGES = [
  { name: "a toggle button's border", id: "btn", prop: "border-top-color" },
  { name: "a small toggle button's border", id: "btn-sm", prop: "border-top-color" },
  { name: "a filter chip's border", id: "pill", prop: "border-top-color" },
  { name: "a segmented group's ring", id: "seg-group", prop: "box-shadow" },
] as const;
const THEMES = ["light", "dark"] as const;
const UI_CONTRAST = 3;

const readCardFill = (): Promise<string> =>
  page.$eval(".card", (el) => getComputedStyle(el).backgroundColor);

// box-shadow computes as `rgb(…) 0px 0px 0px 1px` → its colour alone
const getEdgeColor = (value: string): string => {
  const color = value.match(/rgba?\([^)]*\)/)?.[0];
  assert.ok(color, `"${value}" carries no rgb() colour`);
  return color;
};

async function withTheme<T>(theme: (typeof THEMES)[number], read: () => Promise<T>): Promise<T> {
  await page.evaluate((next) => { document.documentElement.dataset.theme = next; }, theme);
  try { return await read(); } finally { await page.evaluate(() => { document.documentElement.dataset.theme = "light"; }); }
}

describe("a resting toggle draws an edge that reads against its card at 3:1", () => {
  for (const edge of RESTING_EDGES) {
    for (const theme of THEMES) {
      test(`${edge.name} in ${theme}`, async () => {
        const [color, fill] = await withTheme(theme, async () => [getEdgeColor(await readStyle(edge.id, edge.prop)), await readCardFill()]);
        const ratio = contrastRatio(parseColor(color), parseColor(fill));
        assert.ok(ratio >= UI_CONTRAST, `${theme} ${edge.id} edge ${color} on card ${fill} = ${ratio.toFixed(2)}:1 < ${UI_CONTRAST}:1`);
      });
    }
  }
});

test("a toggle button's hover edge is the plain button's hover edge, so the resting edge never outranks hover", async () => {
  const readHoverEdge = async (id: string): Promise<string> => {
    await forcePseudo(id, ["hover"]);
    try { return await readStyle(id, "border-top-color"); } finally { await forcePseudo(id, []); }
  };
  assert.equal(await readHoverEdge("btn"), await readHoverEdge("btn-plain"));
});

const getFieldSelector = (surface: (typeof SURFACES)[number], id: string) => `[data-surface="${surface}"] [data-field="${id}"]`;

describe("a resting field-family control draws an edge that reads against the surface it sits on at 3:1", () => {
  for (const field of FIELDS) {
    for (const theme of THEMES) {
      for (const surface of SURFACES) {
        test(`${field.name} on ${surface} in ${theme}`, async () => {
          const [color, fill] = await withTheme(theme, () => Promise.all([
            probe.readStyle(getFieldSelector(surface, field.id), "border-top-color"),
            probe.readStyle(`[data-surface="${surface}"]`, "background-color"),
          ]));
          const ratio = contrastRatio(parseColor(color), parseColor(fill));
          assert.ok(ratio >= UI_CONTRAST, `${theme} ${field.id} edge ${color} on ${surface} ${fill} = ${ratio.toFixed(2)}:1 < ${UI_CONTRAST}:1`);
        });
      }
    }
  }
});

// one resting edge for toggles and fields → an edge that merely clears 3:1 (--dim, --ink) is still the wrong edge
describe("a resting field-family control draws the toggle's resting edge", () => {
  for (const field of FIELDS) {
    test(`${field.name} rests on a toggle button's edge in both themes`, async () => {
      for (const theme of THEMES) {
        const [fieldEdge, toggleEdge] = await withTheme(theme, () => Promise.all([
          probe.readStyle(getFieldSelector("elev", field.id), "border-top-color"),
          readStyle("btn", "border-top-color"),
        ]));
        assert.equal(fieldEdge, toggleEdge, `${theme} ${field.id} resting edge vs the resting toggle edge`);
      }
    });
  }
});

// each state edge is pinned to its own token, read off a probe → an edge that merely differs from rest (--dim, --ink) still fails
describe("a field-family control's hover lifts its edge to --faint and focus paints it --accent, never resizing the box", () => {
  for (const field of FIELDS) {
    for (const state of [{ name: "hover", pseudo: ["hover"], token: "faint" }, { name: "focus", pseudo: field.focus, token: "accent" }] as const) {
      test(`${field.name} under ${state.name}`, async () => {
        const selector = getFieldSelector("elev", field.id);
        const rest = await probe.readBox(selector);
        for (const theme of THEMES) {
          const [restEdge, tokenColor, stateEdge, stateBox] = await withTheme(theme, async () => {
            const edge = await probe.readStyle(selector, "border-top-color");
            const color = await probe.readStyle(`[data-probe="${state.token}"]`, "color");
            await probe.forcePseudo(selector, state.pseudo);
            try { return [edge, color, await probe.readStyle(selector, "border-top-color"), await probe.readBox(selector)] as const; }
            finally { await probe.forcePseudo(selector, []); }
          });
          assert.equal(stateEdge, tokenColor, `${theme} ${field.id} ${state.name} edge vs --${state.token}`);
          assert.notEqual(stateEdge, restEdge, `${theme} ${field.id} ${state.name} edge equals the resting edge`);
          assert.ok(isSameBox(stateBox, rest), `${theme} ${field.id} ${state.name} ${stateBox.width}x${stateBox.height} vs resting ${rest.width}x${rest.height}`);
        }
      });
    }
  }
});

// error outranks hover → the pointer never hides an errored control's --crit edge, nor resizes its box
describe("an errored field-family control keeps its error edge under hover", () => {
  for (const field of ERRORED_FIELDS) {
    test(`${field.name} stays on --crit in both themes`, async () => {
      const selector = `[data-field="${field.id}"]`;
      const rest = await probe.readBox(selector);
      for (const theme of THEMES) {
        const [crit, hoverEdge, hoverBox] = await withTheme(theme, async () => {
          const critColor = await probe.readStyle('[data-probe="crit"]', "color");
          await probe.forcePseudo(selector, ["hover"]);
          try { return [critColor, await probe.readStyle(selector, "border-top-color"), await probe.readBox(selector)] as const; }
          finally { await probe.forcePseudo(selector, []); }
        });
        assert.equal(hoverEdge, crit, `${theme} ${field.id} hover edge vs --crit`);
        assert.ok(isSameBox(hoverBox, rest), `${theme} ${field.id} hover ${hoverBox.width}x${hoverBox.height} vs resting ${rest.width}x${rest.height}`);
      }
    });
  }
});
