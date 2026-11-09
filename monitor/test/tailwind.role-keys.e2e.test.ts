// Role-keyed markup laid out by tokens.css + the shared role-key shim lands on the role values
// (plan 43942 S1 role table); the page gutter narrows on a 640px-or-narrower viewport.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { getRoleKeyCss } from "./lib/role-keys.js";

const STYLES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "styles");

const ROWS = [
  { name: "p-page pads every side with the page gutter", cls: "p-page", prop: "padding-bottom", px: "24px" },
  { name: "px-card-pad pads the inline sides with the card padding", cls: "px-card-pad", prop: "padding-right", px: "16px" },
  { name: "gap-header sets the header gap", cls: "gap-header", prop: "row-gap", px: "16px" },
  { name: "gap-x-control-group sets the gap between control groups", cls: "gap-x-control-group", prop: "column-gap", px: "16px" },
  { name: "gap-y-label-inline sets the inline label gap", cls: "gap-y-label-inline", prop: "row-gap", px: "4px" },
  { name: "mt-group-above opens a titled group", cls: "mt-group-above", prop: "margin-top", px: "32px" },
  { name: "mb-group-below closes a group heading", cls: "mb-group-below", prop: "margin-bottom", px: "12px" },
  { name: "my-section spaces card rows", cls: "my-section", prop: "margin-top", px: "16px" },
  { name: "ml-list spaces list items", cls: "ml-list", prop: "margin-left", px: "8px" },
];

const PAGE = `<!doctype html><html><body>
  ${ROWS.map((row, i) => `<div id="row-${i}" class="${row.cls}" style="display: flex;"></div>`).join("\n  ")}
  <div id="stack" class="space-y-stack"><p>a</p><p>b</p></div>
</body></html>`;

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setContent(PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ content: "p { margin: 0; }" });
  await page.addStyleTag({ content: getRoleKeyCss() });
});

after(async () => {
  await browser?.close();
});

const readStyle = (selector: string, prop: string): Promise<string> =>
  page.$eval(selector, (el, name) => getComputedStyle(el).getPropertyValue(name), prop);

describe("a role key lands on its role value", () => {
  ROWS.forEach((row, i) => {
    test(row.name, async () => {
      assert.equal(await readStyle(`#row-${i}`, row.prop), row.px);
    });
  });

  test("space-y-stack spaces the second child, never the first", async () => {
    assert.deepEqual(
      [await readStyle("#stack > p:first-child", "margin-top"), await readStyle("#stack > p:last-child", "margin-top")],
      ["0px", "4px"],
    );
  });
});

describe("the page gutter follows the viewport", () => {
  for (const { width, px } of [{ width: 641, px: "24px" }, { width: 640, px: "16px" }]) {
    test(`p-page is ${px} at a ${width}px viewport`, async () => {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await readStyle("#row-0", "padding-left"), px);
    });
  }
});
