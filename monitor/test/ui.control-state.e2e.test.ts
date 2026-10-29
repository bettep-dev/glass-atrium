// Control-atom state invariance read in a real browser: no state of .btn, a .seg option or .pill--interactive changes its
// border-box, so a selected option never reads as a bigger box than its siblings.
// Runner: npx tsx --test test/ui.control-state.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, CDPSession, Page } from "playwright";
import { chromium } from "playwright";

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
    markup: `<div class="seg"><button type="button" data-atom="seg" aria-pressed="false">30d</button><button type="button" aria-pressed="false">90d</button></div>` },
  { name: "a filter chip", id: "pill",
    markup: `<button type="button" class="pill pill--interactive" data-atom="pill" aria-pressed="false">Open 17</button>` },
] as const;

const PAGE = `<!doctype html><html data-theme="light"><head><style>${PREFLIGHT}</style></head><body style="margin: 0; padding: 24px;">
  <div class="card" style="padding: 16px; flex-direction: row; align-items: flex-start; gap: 8px;">
    ${ATOMS.map((atom) => atom.markup).join("\n    ")}
  </div>
</body></html>`;

interface Box { width: number; height: number }

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

const readBox = (id: string): Promise<Box> =>
  page.$eval(`[data-atom="${id}"]`, (el) => {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });

async function forcePseudo(id: string, classes: readonly string[]): Promise<void> {
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-atom="${id}"]` });
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [...classes] });
}

async function readBoxInState(id: string, state: (typeof STATES)[number]): Promise<Box> {
  if ("pseudo" in state) {
    await forcePseudo(id, state.pseudo);
    try { return await readBox(id); } finally { await forcePseudo(id, []); }
  }
  const [attr, value] = state.attr;
  const previous = await page.$eval(`[data-atom="${id}"]`, (el, name) => el.getAttribute(name), attr);
  await page.$eval(`[data-atom="${id}"]`, (el, [name, next]) => el.setAttribute(name, next), [attr, value] as const);
  try {
    return await readBox(id);
  } finally {
    await page.$eval(`[data-atom="${id}"]`, (el, [name, prior]) => (prior === null ? el.removeAttribute(name) : el.setAttribute(name, prior)),
      [attr, previous] as const);
  }
}

const readStyle = (id: string, prop: string): Promise<string> =>
  page.$eval(`[data-atom="${id}"]`, (el, name) => getComputedStyle(el).getPropertyValue(name), prop);

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
