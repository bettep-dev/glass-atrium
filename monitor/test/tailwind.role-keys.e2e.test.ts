// Role-keyed markup computes to the tokens.css role values, and the page gutter narrows to 16px at 640px or below.

import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { getRoleKeyCss } from "./lib/role-keys.js";

const STYLES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "styles");

const PADDING_SIDES = ["padding-top", "padding-right", "padding-bottom", "padding-left"];

const ROWS = [
  { name: "p-page pads every side with the page gutter", cls: "p-page", props: PADDING_SIDES, px: "24px" },
  { name: "px-card-pad pads the inline sides with the card padding", cls: "px-card-pad", props: ["padding-right", "padding-left"], px: "16px" },
  { name: "gap-header sets the header gap", cls: "gap-header", props: ["row-gap"], px: "16px" },
  { name: "gap-x-control-group sets the gap between control groups", cls: "gap-x-control-group", props: ["column-gap"], px: "16px" },
  { name: "gap-y-label-inline sets the inline label gap", cls: "gap-y-label-inline", props: ["row-gap"], px: "4px" },
  { name: "mt-group-above opens a titled group", cls: "mt-group-above", props: ["margin-top"], px: "32px" },
  { name: "mb-group-below closes a group heading", cls: "mb-group-below", props: ["margin-bottom"], px: "12px" },
  { name: "my-section spaces card rows above and below", cls: "my-section", props: ["margin-top", "margin-bottom"], px: "16px" },
  { name: "ml-list spaces list items", cls: "ml-list", props: ["margin-left"], px: "8px" },
];
const DESKTOP = { width: 1440, height: 900 };

const PAGE = `<!doctype html><html><body>
  ${ROWS.map((row, i) => `<div id="row-${i}" class="${row.cls}" style="display: flex;"></div>`).join("\n  ")}
  <div id="stack" class="space-y-stack"><p>a</p><p>b</p></div>
</body></html>`;

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP });
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

const readStyles = (selector: string, props: string[]): Promise<string[]> =>
  Promise.all(props.map((prop) => readStyle(selector, prop)));

describe("a role key lands on its role value", () => {
  beforeEach(async () => {
    await page.setViewportSize(DESKTOP);
  });

  ROWS.forEach((row, i) => {
    test(row.name, async () => {
      assert.deepEqual(await readStyles(`#row-${i}`, row.props), row.props.map(() => row.px));
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
    test(`p-page pads every side ${px} at a ${width}px viewport`, async () => {
      await page.setViewportSize({ width, height: DESKTOP.height });
      assert.deepEqual(await readStyles("#row-0", PADDING_SIDES), PADDING_SIDES.map(() => px));
    });
  }
});
