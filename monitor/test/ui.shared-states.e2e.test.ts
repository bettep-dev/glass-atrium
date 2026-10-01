// Shared interaction states base.css draws, read in a real browser: the focus ring and the open disclosure chevron.
// Runner: npx tsx --test test/ui.shared-states.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { loadScreenModule } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const putCardFocus = ui.putCardFocus as (id: string) => void;

// the probe resolves the ring tokens exactly as the shared rule should, so the focused element is compared against it
const STATES_PAGE = `<!doctype html><html data-theme="light"><body style="margin: 0; padding: 24px;">
  <button type="button" id="retry">Retry</button>
  <section id="card">card</section>
  <section id="plain" tabindex="-1">plain card</section>
  <span id="probe" style="outline: var(--focus-ring-width) solid rgb(var(--focus-ring)); outline-offset: var(--focus-ring-offset);"></span>
  <details id="files"><summary>3 files<svg class="chevron" width="12" height="12" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg></summary><div>list</div></details>
</body></html>`;

interface RingReading { style: string; width: string; color: string; offset: string; boxShadow: string }

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(STATES_PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
  await page.addScriptTag({ content: `window.putCardFocus = ${putCardFocus.toString()};` });
});

after(async () => {
  await browser?.close();
});

async function readRing(selector: string): Promise<RingReading> {
  return page.$eval(selector, (el) => {
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, offset: style.outlineOffset, boxShadow: style.boxShadow };
  });
}

// a mouse press on an already keyboard-focused button keeps its :focus-visible state, so the focus is dropped first
async function pressRetryWithMouse(): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.click("#retry");
}

async function readProbeRing(): Promise<Omit<RingReading, "boxShadow">> {
  const { style, width, color, offset } = await readRing("#probe");
  return { style, width, color, offset };
}

describe("the shared focus ring in a real browser", () => {
  test("keyboard focus draws the focus-ring tokens as an offset outline, never a box-shadow", async () => {
    await page.keyboard.press("Tab");
    const { boxShadow, ...ring } = await readRing("#retry");

    assert.deepEqual(ring, await readProbeRing());
    assert.equal(boxShadow, "none", "a box-shadow would overwrite rings drawn with box-shadow");
  });

  test("a plain programmatic focus after a mouse press draws no ring", async () => {
    await pressRetryWithMouse();
    await page.$eval("#plain", (el) => (el as HTMLElement).focus());

    assert.equal((await readRing("#plain")).style, "none");
  });

  test("a card focus handoff after a mouse press draws the same ring until the card blurs", async () => {
    await pressRetryWithMouse();
    await page.evaluate(() => (window as unknown as { putCardFocus: (id: string) => void }).putCardFocus("card"));
    const { boxShadow, ...ring } = await readRing("#card");

    assert.deepEqual(ring, await readProbeRing());
    assert.equal(boxShadow, "none");

    await page.click("#retry");
    assert.equal((await readRing("#card")).style, "none", "the handoff ring leaves with the focus");
  });
});

describe("the shared disclosure chevron in a real browser", () => {
  test("the chevron turns over only while its disclosure is open", async () => {
    const readTransform = () => page.$eval("#files .chevron", (el) => getComputedStyle(el).transform);
    const closed = await readTransform();
    await page.$eval("#files", (el) => { (el as HTMLDetailsElement).open = true; });
    const opened = await readTransform();

    assert.equal(closed, "none");
    // rotate(180deg) → matrix(-1, 0, 0, -1, 0, 0), up to float noise
    const [a, b, c, d] = opened.replace(/^matrix\(|\)$/g, "").split(",").map(Number);
    assert.ok(Math.abs(a + 1) < 1e-6 && Math.abs(d + 1) < 1e-6 && Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6, `open transform ${opened}`);
  });
});
