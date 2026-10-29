// Learning controls on their DESIGN.md §7.15 tiers, measured in a real browser on the shipped tokens.css, base.css and the screen's
// own style block, rendered from the shipped components: the view toggle, the suggestion board rows and the held-cause fold —
// each keeps one box in every state (§7.16) — and the Instrumentation corpus-growth value row on one baseline.
// Runner: npx tsx --test test/improvement.control-tiers.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, CDPSession, Page } from "playwright";
import { chromium } from "playwright";

import { createReactStub, collectText, findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

type Component = (props: unknown) => unknown;
const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const learningScreen = await loadScreenModule(resolve(HERE, "../public/src/screens/improvement.jsx"), {
  UI: ui.UI,
  React: createReactStub(),
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
const instrumentationScreen = await loadScreenModule(resolve(HERE, "../public/src/screens/improvement-instrumentation.jsx"), {
  UI: ui.UI,
  React: createReactStub(),
  ImprovementShared: learningScreen.ImprovementShared,
});
const getMarkup = (component: string, props: Record<string, unknown>, screen = learningScreen): string =>
  getHtml(renderScreen((screen[component] as Component)(props)) as RenderedNode);
// the screen's style block carries the .fs-* type scale too (TypeScaleStyle renders inside it)
const SCREEN_CSS = findNodes(renderScreen((learningScreen.ScreenImprovement as Component)({})), (n) => n.type === "style")
  .map((n) => collectText(n))
  .join("\n");

// The app loads Tailwind preflight and utilities from its CDN; these are the rules the measured geometry depends on, at their
// shipped values — the board rows and proposal cards lay out on the utilities.
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; font-family: ui-sans-serif, system-ui, sans-serif; }
  svg { display: block; vertical-align: middle; }
  button { font: inherit; line-height: inherit; color: inherit; margin: 0; padding: 0; background-color: transparent; }
  summary { display: list-item; }
  .flex { display: flex; } .inline-flex { display: inline-flex; } .block { display: block; } .flex-wrap { flex-wrap: wrap; }
  .items-center { align-items: center; } .items-baseline { align-items: baseline; } .self-center { align-self: center; }
  .flex-1 { flex: 1 1 0%; } .shrink-0 { flex-shrink: 0; } .min-w-0 { min-width: 0; } .w-full { width: 100%; } .max-w-\\[10rem\\] { max-width: 10rem; }
  .gap-1 { gap: 0.25rem; } .gap-1\\.5 { gap: 0.375rem; } .gap-2 { gap: 0.5rem; } .gap-3 { gap: 0.75rem; } .gap-4 { gap: 1rem; }
  .ml-auto { margin-left: auto; } .mt-1 { margin-top: 0.25rem; } .mt-1\\.5 { margin-top: 0.375rem; }
  .p-0 { padding: 0; } .p-3 { padding: 0.75rem; } .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
  .py-1\\.5 { padding-top: 0.375rem; padding-bottom: 0.375rem; } .px-4 { padding-left: 1rem; padding-right: 1rem; } .pb-4 { padding-bottom: 1rem; }
  .space-y-2 > :not([hidden]) ~ :not([hidden]) { margin-top: 0.5rem; }
  .text-left { text-align: left; } .whitespace-nowrap { white-space: nowrap; } .overflow-hidden { overflow: hidden; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .line-clamp-1, .line-clamp-3 { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; }
  .line-clamp-1 { -webkit-line-clamp: 1; } .line-clamp-3 { -webkit-line-clamp: 3; }
  .font-mono { font-family: ui-monospace, SFMono-Regular, monospace; } .font-medium { font-weight: 500; }
  .uppercase { text-transform: uppercase; } .tracking-wider { letter-spacing: 0.05em; } .rounded-md { border-radius: 0.375rem; }`;

const noop = () => undefined;
const LONG =
  "Move the verification gate ahead of the regex removal so reviewers see the API change before the three matching suite edits, " +
  "then rerun the full suite once the gate lands so the recorded red value and the green value come from one tree";
const getToggle = (view: string) => getMarkup("ViewToggleI", { view, onChange: noop });
const getLane = () =>
  [
    getMarkup("AppliedHistoryRowI", {
      row: { id: 41, pattern_label: LONG, target_agent: "glass-atrium-dev-front", cycle_date: "2026-10-01", rationale: LONG },
      onClick: noop,
    }),
    getMarkup("CompactProposalCardI", { row: { id: 42, rationale: LONG, status: "rejected", cycle_date: "2026-10-02" }, onClick: noop }),
    getMarkup("CompactProposalCardI", { row: { id: 43, rationale: LONG, status: "unadjudicated" }, onClick: noop }),
    getMarkup("ProposalCardI", { row: { id: 44, pattern_label: LONG, rationale: LONG, status: "applied" }, onClick: noop }),
  ].join("");
const HELD_CAUSE = getMarkup("HeldCauseGroupI", { bucket: { cause: "missing-approval", label: "Missing approval" }, rows: [] });
const CORPUS_GROWTH = getMarkup(
  "CorpusGrowthCardI",
  {
    state: {
      status: "ready",
      data: { total_audits: 2, audits: [{ cycle_date: "2026-10-28", word_count: 77003, trend_delta: 120 }, { cycle_date: "2026-10-27", word_count: 76883 }] },
    },
  },
  instrumentationScreen,
);

// the board lane widths the audit measured: 1440 (378) and 820 (226)
const LANE_WIDTHS = [378, 226] as const;
const PAGE = `<!doctype html><html data-theme="dark"><head><style>${PREFLIGHT}</style></head><body style="margin: 0;">
  <div style="padding: 24px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px;">
    <div id="view-operator">${getToggle("operator")}</div>
    <div id="view-instrumentation">${getToggle("instrumentation")}</div>
  </div>
  ${LANE_WIDTHS.map((w) => `<div id="lane-${w}" style="width: ${w}px; padding: 0; display: flex; flex-direction: column; gap: 8px;">${getLane()}</div>`).join("")}
  <div id="held" style="width: 420px; padding: 24px;">${HELD_CAUSE}</div>
  <div id="corpus" style="width: 560px; padding: 24px;">${CORPUS_GROWTH}</div>
</body></html>`;

const TOGGLE_OPTIONS = ["Operator", "Instrumentation"] as const;
const SUMMARY = "#held details > summary";

interface Box { left: number; right: number; top: number; bottom: number; width: number; height: number }

let browser: Browser;
let page: Page;
let cdp: CDPSession;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.setContent(PAGE);
  await page.addStyleTag({ path: resolve(STYLES, "tokens.css") });
  await page.addStyleTag({ path: resolve(STYLES, "base.css") });
  await page.addStyleTag({ content: SCREEN_CSS });
  cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
});

after(async () => {
  await browser?.close();
});

const readBox = (selector: string): Promise<Box> =>
  page.$eval(selector, (el) => {
    const { left, right, top, bottom, width, height } = el.getBoundingClientRect();
    return { left, right, top, bottom, width, height };
  });

const readStyle = (selector: string, prop: string): Promise<string> =>
  page.$eval(selector, (el, name) => getComputedStyle(el).getPropertyValue(name), prop);

async function forcePseudo(selector: string, classes: readonly string[]): Promise<void> {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [...classes] });
}

const PSEUDO_STATES = [["hover"], ["focus-visible"], ["active"]] as const;
const isSameBox = (a: Box, b: Box) => Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01;

// a control's border-box at rest, then under each forced pseudo state — and the box after it, so a grown row cannot push its lane
async function assertBoxHeldAcrossStates(selector: string, follower?: string): Promise<void> {
  const rest = await readBox(selector);
  const restFollower = follower ? await readBox(follower) : null;
  for (const state of PSEUDO_STATES) {
    await forcePseudo(selector, state);
    try {
      const changed = await readBox(selector);
      assert.ok(isSameBox(changed, rest), `${selector} ${state[0]} ${changed.width}x${changed.height} vs resting ${rest.width}x${rest.height}`);
      if (follower && restFollower) {
        const moved = await readBox(follower);
        assert.ok(Math.abs(moved.top - restFollower.top) < 0.01, `${follower} top ${moved.top} under ${state[0]} vs ${restFollower.top}`);
      }
    } finally {
      await forcePseudo(selector, []);
    }
  }
}

const getOption = (view: string, label: string) => `#view-${view} .seg > button:nth-child(${TOGGLE_OPTIONS.indexOf(label as never) + 1})`;

describe("the Learning view toggle keeps one box per option whichever view is pressed", () => {
  for (const label of TOGGLE_OPTIONS) {
    test(`the ${label} option is as wide pressed as unpressed`, async () => {
      const operator = await readBox(getOption("operator", label));
      const instrumentation = await readBox(getOption("instrumentation", label));
      assert.ok(isSameBox(operator, instrumentation), `${label} ${operator.width}x${operator.height} with Operator pressed vs ${instrumentation.width}x${instrumentation.height}`);
      assert.equal(operator.height, 32);
    });
  }
});

// the lane's children in render order: applied row, judged declined row, not-judged row, proposal card
const BOARD_ROWS = [
  ["an applied row", 1],
  ["a declined row", 2],
  ["a not-judged row", 3],
] as const;

describe("a suggestion board row sits on the 32 control tier and keeps it in every state", () => {
  for (const width of LANE_WIDTHS) {
    for (const [name, nth] of BOARD_ROWS) {
      const row = `#lane-${width} > button:nth-child(${nth})`;
      const follower = `#lane-${width} > :nth-child(${nth + 1})`;
      test(`${name} is one 32 line at ${width} wide`, async () => {
        assert.equal((await readBox(row)).height, 32);
      });
      test(`hover, focus-visible and active keep ${name}'s box and its lane at ${width} wide`, () => assertBoxHeldAcrossStates(row, follower));
    }
  }
});

describe("a proposal card keeps its clamped text under hover and focus", () => {
  for (const width of LANE_WIDTHS) {
    test(`hover, focus-visible and active keep the card's box at ${width} wide`, () =>
      assertBoxHeldAcrossStates(`#lane-${width} > .sub-card > button.i-row-card`));
  }
});

describe("the held-cause fold opens on the disclosure atom", () => {
  test("its summary is a 32 disclosure with the chevron as the one open-state cue, turned 90 once open", async () => {
    const closed = await readBox(SUMMARY);
    assert.equal(closed.height, 32);
    assert.notEqual(await readStyle(SUMMARY, "display"), "list-item", "no UA marker");
    const chevron = `${SUMMARY} .disclosure-chevron`;
    assert.equal(await readStyle(chevron, "transform"), "none");
    await page.$eval("#held details", (el) => { (el as HTMLDetailsElement).open = true; });
    try {
      const open = await readBox(SUMMARY);
      assert.ok(isSameBox(open, closed), `open ${open.width}x${open.height} vs closed ${closed.width}x${closed.height}`);
      const turn = await readStyle(chevron, "transform");
      assert.match(turn, /^matrix\(6\.1\d*e-17, 1, -1, 6\.1\d*e-17, 0, 0\)$|^matrix\(0, 1, -1, 0, 0, 0\)$/, `open chevron ${turn}`);
    } finally {
      await page.$eval("#held details", (el) => { (el as HTMLDetailsElement).open = false; });
    }
  });

  test("hover, focus-visible and active keep its box", () => assertBoxHeldAcrossStates(SUMMARY));
});

// the value row's text items, found by their text: the 24 mono figure, its unit, the delta line
const CORPUS_TEXT = { value: "77,003", unit: "words", delta: "▲ +120 words vs previous" } as const;

describe("the corpus-growth value row sets its figure, unit and delta on one baseline", () => {
  // a 0 x 0 inline-block appended to an item sits on that item's baseline, so its bottom is the baseline
  const readTextItem = (text: string) =>
    page.$eval("[data-testid=corpus-growth-card]", (card, wanted) => {
      const el = [...card.querySelectorAll("span")].find((span) => span.textContent?.trim() === wanted);
      if (!el) throw new Error(`no span reads "${wanted}"`);
      const probe = document.createElement("span");
      probe.style.cssText = "display: inline-block; width: 0; height: 0;";
      el.append(probe);
      const baseline = probe.getBoundingClientRect().bottom;
      probe.remove();
      const { left, right } = el.getBoundingClientRect();
      return { baseline, left, right };
    }, text);

  test("the figure, its unit and the delta share one baseline", async () => {
    const value = await readTextItem(CORPUS_TEXT.value);
    for (const name of ["unit", "delta"] as const) {
      const { baseline } = await readTextItem(CORPUS_TEXT[name]);
      assert.ok(Math.abs(baseline - value.baseline) <= 0.5, `${name} baseline ${baseline} vs figure ${value.baseline}`);
    }
  });

  test("the unit sits 4 from its figure, and the delta one group step (12) after the unit", async () => {
    const value = await readTextItem(CORPUS_TEXT.value);
    const unit = await readTextItem(CORPUS_TEXT.unit);
    const delta = await readTextItem(CORPUS_TEXT.delta);
    assert.ok(Math.abs(unit.left - value.right - 4) < 0.01, `figure ↔ unit ${unit.left - value.right}`);
    assert.ok(Math.abs(delta.left - unit.right - 12) < 0.01, `unit ↔ delta ${delta.left - unit.right}`);
  });
});
