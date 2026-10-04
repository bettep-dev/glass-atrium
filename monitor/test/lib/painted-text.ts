// Painted-text probes shared by the chromium e2e suites: the 13px meta floor over drawn text nodes,
// and whether a card header's meta still reads whole once its text paints wider than the local font.
// The in-page functions travel to the browser as source → they may close over nothing but their arguments.

import type { Page } from "playwright";

export const META_FLOOR_PX = 13;
// header text painted 10% wider → twice the Linux-over-macOS chromium widening CI implies (under 5%)
export const TEXT_SCALE = 1.1;

export interface MetaFit {
  text: string;
  needPx: number;
  shownPx: number;
}

/** Visible text nodes below the meta floor, as "<px> <tag.class>: <text>". */
export async function getBelowFloorText(page: Page): Promise<string[]> {
  return page.evaluate((floor) => {
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = (walker.currentNode.textContent ?? "").trim();
      const el = walker.currentNode.parentElement;
      if (!text || !el) continue;
      const style = getComputedStyle(el);
      // clipped rail labels keep their accessible name but draw nothing
      const isDrawn = el.getBoundingClientRect().width > 1 && style.visibility !== "hidden" && el.closest(".sr-only") === null;
      const px = parseFloat(style.fontSize);
      if (isDrawn && px < floor) found.push(`${px}px ${el.tagName.toLowerCase()}.${String(el.className)}: ${text.slice(0, 40)}`);
    }
    return found;
  }, META_FLOOR_PX);
}

// in-page: every text on each meta's header line paints `scale`× as wide → the meta's painted width vs. the width it gets
export function getWidenedMetaFits(subs: Element[], scale: number): MetaFit[] {
  const sizes: [HTMLElement, number][] = [];
  for (const sub of subs) {
    const head = sub.closest(".card-head");
    if (head === null) throw new Error(`"${sub.textContent}" sits outside a card head`);
    const walker = document.createTreeWalker(head, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent && walker.currentNode.textContent?.trim()) sizes.push([parent, Number.parseFloat(getComputedStyle(parent).fontSize)]);
    }
  }
  for (const [el, px] of sizes) el.style.fontSize = `${px * scale}px`;
  return subs.map((sub) => {
    const text = document.createRange();
    text.selectNodeContents(sub);
    return { text: sub.textContent ?? "", needPx: text.getBoundingClientRect().width, shownPx: sub.getBoundingClientRect().width };
  });
}
