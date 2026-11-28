// The house face text-measuring chromium e2e suites lay out in, so macOS and the Linux runner measure one font:
// the Pretendard stylesheet public/index.html links, set with unhinted glyph advances.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type LaunchOptions, type Page } from "playwright";

const INDEX_HTML = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "index.html");

// Linux chromium hints glyph advances to whole pixels → one face sets wider there than on macOS; unhinted, both set the font's own advances
const FONT_ARGS = ["--font-render-hinting=none"];

const HOUSE_FACE_URL = getHouseFaceUrl();

/** A headless chromium that sets text with the font's own advances on every host; `options` adds to the launch, its `args` after the font's. */
export function createBrowser(options: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({ headless: true, ...options, args: [...FONT_ARGS, ...(options.args ?? [])] });
}

/** Links the app's house face into a hand-built page and resolves once every face its laid-out text uses has loaded. */
export async function setHouseFace(page: Page): Promise<void> {
  await page.addStyleTag({ url: HOUSE_FACE_URL });
  // a layout read starts the load of each face the text uses → fonts.ready settles on all of them
  await page.evaluate(async () => {
    void document.body.offsetWidth;
    await document.fonts.ready;
  });
}

function getHouseFaceUrl(): string {
  const href = /<link rel="stylesheet" href="([^"]*pretendard[^"]*)"/i.exec(readFileSync(INDEX_HTML, "utf8"))?.[1];
  if (!href) throw new Error(`no Pretendard stylesheet link in ${INDEX_HTML}`);
  return href;
}
