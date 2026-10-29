// System map controls on their DESIGN.md §7.15 tiers, measured in a real browser on the shipped tokens.css, base.css and the screen's
// own style block, rendered from the shipped components: the zoom cluster on the canvas, the hook chain's event fold and the node
// drawer's recent-runs toggle — each keeps one box in every state (§7.16).
// Runner: npx tsx --test test/architecture.control-tiers.e2e.test.ts — needs an installed chromium; no network, no app server.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, CDPSession, Page } from "playwright";
import { chromium } from "playwright";

import { createReactStub, collectText, findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";
import { type Box, QUARTER_TURN, createControlProbe, isSameBox } from "./lib/control-probe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "public", "styles");

type Component = (props: unknown) => unknown;
const stubReact = createReactStub();
const stubUseState = stubReact.useState as (initial: unknown) => unknown;
// the canvas draws its controls only once mermaid has rendered → its render state starts ready, every other state stays initial
const isRenderState = (initial: unknown) => typeof initial === "object" && initial !== null && "svgHtml" in initial;
const ui = await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"));
const archScreen = await loadScreenModule(resolve(HERE, "../public/src/screens/architecture.jsx"), {
  UI: ui.UI,
  React: {
    ...stubReact,
    useState: (initial: unknown) =>
      isRenderState(initial) ? [{ status: "ready", error: null, svgHtml: "<svg></svg>" }, () => undefined] : stubUseState(initial),
  },
});
const getMarkup = (component: string, props: Record<string, unknown>): string =>
  getHtml(renderScreen((archScreen[component] as Component)(props)) as RenderedNode);
const SCREEN_CSS = findNodes(renderScreen((archScreen.ScreenArchitecture as Component)({})), (n) => n.type === "style")
  .map((n) => collectText(n))
  .join("\n");

const CANVAS = getMarkup("MermaidCanvas", {
  diagramId: "map", source: "flowchart TB", diagramTitle: "System map", nodeByLabel: new Map(), ringToneByNodeId: new Map(),
  unverifiedNodeIds: new Set(), healthPending: false, zoneRingPlan: [], attentionCountByNodeId: new Map(), onSelectNode: () => undefined,
});
const HOOK_CHAIN = getMarkup("HookChainDetail", {
  state: {
    status: "ready",
    data: {
      source_path: "/s/settings.json", source_mtime: null,
      events: [{ event: "PreToolUse", groups: [{ matcher: "Bash", hooks: [{ command: "/h/a.sh", type: "command", timeout: 5 }] }] }],
    },
  },
});

// a daemon part in the node drawer: another daemon drilled → its recent runs closed · this daemon drilled → open
const DAEMON = "learning-aggregator";
const getPartHealth = (payloadDaemon: string | null) =>
  getMarkup("NodePartHealth", {
    nodeId: "daemons",
    partRows: [{ id: "learning", kind: "daemon", name: "Learning aggregator", daemonName: DAEMON, nodeIds: ["daemons"], tone: null, lastRunAt: null }],
    daemons: [], payloadDaemon, onSelectDaemon: () => undefined, payloadState: { status: "loading" }, hookState: null, hookFailState: null,
  });

// The app loads Tailwind preflight and utilities from its CDN and .fs-meta from ui.jsx; these are the rules the measured
// geometry depends on, at their shipped values.
const PREFLIGHT = `*, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  html { line-height: 1.5; font-family: ui-sans-serif, system-ui, sans-serif; }
  svg { display: block; vertical-align: middle; }
  button { font: inherit; line-height: inherit; color: inherit; margin: 0; padding: 0; background-color: transparent; }
  summary { display: list-item; }
  .font-mono { font-family: ui-monospace, SFMono-Regular, monospace; }
  .fs-meta { font-size: var(--fs-meta); line-height: 1.4; } .rotate-90 { transform: rotate(90deg); }`;

// reference atoms the System map controls must match
const REFERENCES = `<button id="ref-btn-icon" type="button" class="btn icon"><svg width="14" height="14"></svg></button>
  <button id="ref-btn-sm" type="button" class="btn sm">Reset</button>
  <button id="ref-disclosure" type="button" class="group disclosure fs-meta"><span>Runs</span></button>`;
const PAGE = `<!doctype html><html data-theme="dark"><head><style>${PREFLIGHT}</style></head><body style="margin: 0;">
  <div id="refs" style="padding: 24px; display: flex; gap: 8px;">${REFERENCES}</div>
  <div style="width: 900px; height: 520px; padding: 24px; display: flex; flex-direction: column;">${CANVAS}</div>
  <div style="width: 420px; padding: 24px;">${HOOK_CHAIN}</div>
  <div id="runs-closed" style="width: 420px; padding: 24px;">${getPartHealth(null)}</div>
  <div id="runs-open" style="width: 420px; padding: 24px;">${getPartHealth(DAEMON)}</div>
</body></html>`;

const CLUSTER = ".arch-zoom-controls";
const ZOOM_IN = `${CLUSTER} button[aria-label="Zoom in"]`;
const ZOOM_OUT = `${CLUSTER} button[aria-label="Zoom out"]`;
const RESET = `${CLUSTER} button[aria-label="Reset diagram view"]`;
const SUMMARY = ".arch-hook-event > details > summary";
const RUNS_TOGGLE = (state: "closed" | "open") => `#runs-${state} .arch-part-drill`;

let browser: Browser;
let page: Page;
let cdp: CDPSession;
const { readBox, readStyle, assertBoxHeldAcrossStates, assertFoldOnOneBox } = createControlProbe(() => page, () => cdp);

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

const centreOf = (box: Pick<Box, "top" | "bottom">) => (box.top + box.bottom) / 2;
const BUTTON_CHROME = ["border-top-width", "border-top-color", "border-top-left-radius", "background-color"] as const;
const PADDING = ["padding-top", "padding-right", "padding-bottom", "padding-left"] as const;

describe("the System map zoom controls sit on the .btn tiers", () => {
  for (const [name, selector] of [["zoom in", ZOOM_IN], ["zoom out", ZOOM_OUT]] as const) {
    test(`${name} is a 32 x 32 icon button with the .btn.icon padding and chrome`, async () => {
      const box = await readBox(selector);
      assert.equal(box.width, 32, `width ${box.width}`);
      assert.equal(box.height, 32, `height ${box.height}`);
      for (const prop of [...PADDING, ...BUTTON_CHROME]) assert.equal(await readStyle(selector, prop), await readStyle("#ref-btn-icon", prop), prop);
    });
  }

  test("Reset is a 32 small button with the .btn.sm padding, type and chrome, its icon and label on one centre line", async () => {
    assert.equal((await readBox(RESET)).height, 32, "one line at the control height");
    for (const prop of [...PADDING, ...BUTTON_CHROME, "font-family", "font-size", "font-weight", "line-height"]) {
      assert.equal(await readStyle(RESET, prop), await readStyle("#ref-btn-sm", prop), prop);
    }
    const { icon, label } = await page.$eval(RESET, (button) => {
      const range = document.createRange();
      range.selectNodeContents([...button.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)!);
      return { icon: button.querySelector("svg")!.getBoundingClientRect().toJSON() as DOMRect, label: range.getBoundingClientRect().toJSON() as DOMRect };
    });
    assert.ok(Math.abs(centreOf(icon) - centreOf(label)) <= 0.5, `icon centre ${centreOf(icon)} vs label ${centreOf(label)}`);
  });

  test("every control ends on the cluster's right edge", async () => {
    const cluster = await readBox(CLUSTER);
    for (const selector of [ZOOM_IN, ZOOM_OUT, RESET]) {
      const { right } = await readBox(selector);
      assert.ok(Math.abs(right - cluster.right) < 0.01, `${selector} ends at ${right}, the cluster at ${cluster.right}`);
    }
  });

  for (const [name, selector] of [["zoom in", ZOOM_IN], ["zoom out", ZOOM_OUT], ["Reset", RESET]] as const) {
    test(`hover, focus-visible and active keep the ${name} box`, () => assertBoxHeldAcrossStates(selector));
  }
});

describe("the hook chain's event fold opens on the disclosure atom", () => {
  test("its summary is a 32 disclosure with the chevron as the one open-state cue, turned 90 once open", () => assertFoldOnOneBox(".arch-hook-event > details", SUMMARY));

  test("hover, focus-visible and active keep its box", () => assertBoxHeldAcrossStates(SUMMARY));
});

describe("the node drawer's recent-runs toggle opens on the disclosure atom", () => {
  test("closed and open it keeps one 32 box, the chevron turned 90 only once open", async () => {
    const closed = await readBox(RUNS_TOGGLE("closed"));
    const open = await readBox(RUNS_TOGGLE("open"));
    assert.ok(isSameBox(open, closed), `open ${open.width}x${open.height} vs closed ${closed.width}x${closed.height}`);
    assert.equal(closed.height, 32);
    assert.equal(await readStyle(`${RUNS_TOGGLE("closed")} .disclosure-chevron`, "transform"), "none");
    assert.match(await readStyle(`${RUNS_TOGGLE("open")} .disclosure-chevron`, "transform"), QUARTER_TURN);
  });

  test("it draws the disclosure atom's edge, fill, corner, padding, type and ink", async () => {
    for (const prop of [...BUTTON_CHROME, ...PADDING, "font-size", "font-weight", "color"]) {
      assert.equal(await readStyle(RUNS_TOGGLE("closed"), prop), await readStyle("#ref-disclosure", prop), prop);
    }
  });

  test("hover, focus-visible and active keep its box", () => assertBoxHeldAcrossStates(RUNS_TOGGLE("closed")));
});
