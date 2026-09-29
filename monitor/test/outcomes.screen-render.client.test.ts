// Element-tree behaviour tests for the Task results screen's failure surfaces: a shared outage keeps
// one working Retry, and the record drawer's body failure reads as plain copy with the raw answer behind Details.
//
// Runner: npx tsx --test test/outcomes.screen-render.client.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  collectText,
  createReactStub,
  findNodes,
  loadScreenModule,
  renderScreen,
  type RenderedNode,
} from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const OUTCOMES_SRC = resolve(__dirname, "../public/src/screens/outcomes.jsx");

const SERVER_ERROR = "HTTP 500 Internal Server Error — relation core.outcomes does not exist";

type Component = (props: Record<string, unknown>) => unknown;
type SetterCall = { initial: unknown; next: unknown };

interface ScreenHarness {
  tree: RenderedNode;
  setterCalls: SetterCall[];
}

const ui = await loadScreenModule(UI_SRC);
const UI = ui.UI as { INITIAL_REGION_STATE: Record<string, unknown> };

// the first `failedRegionCount` region states start failed with one shared cause; every setter call is recorded
function buildReactStub(failedRegionCount: number, setterCalls: SetterCall[]): Record<string, unknown> {
  const base = createReactStub();
  let failedSoFar = 0;
  const useState = (initial: unknown) => {
    const isRegion = initial === UI.INITIAL_REGION_STATE && failedSoFar < failedRegionCount;
    if (isRegion) failedSoFar += 1;
    const value = isRegion
      ? { ...UI.INITIAL_REGION_STATE, status: "error", busy: false, error: SERVER_ERROR }
      : typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [value, (next: unknown) => { setterCalls.push({ initial, next }); }];
  };
  return { ...base, useState };
}

async function renderOutcomesScreen(failedRegionCount: number): Promise<ScreenHarness> {
  const setterCalls: SetterCall[] = [];
  const React = buildReactStub(failedRegionCount, setterCalls);
  const mod = await loadScreenModule(OUTCOMES_SRC, {
    UI: ui.UI,
    React,
    location: { hash: "" },
    URLSearchParams,
  });
  const create = React.createElement as (t: unknown, p: unknown) => unknown;
  const tree = renderScreen(create(mod.ScreenOutcomes as Component, {})) as RenderedNode;
  return { tree, setterCalls };
}

function getVisibleText(node: RenderedNode | string): string {
  if (typeof node === "string") return node;
  if (node.type === "details") return "";
  return node.children.map(getVisibleText).join(" ");
}

function getRetryButtons(tree: RenderedNode): RenderedNode[] {
  return findNodes(tree, (n) => n.type === "button" && collectText(n).trim() === "Retry");
}

test("a shared outage shows one Retry, and pressing it re-reads the page", async () => {
  const { tree, setterCalls } = await renderOutcomesScreen(2);

  const banners = findNodes(tree, (n) => n.type === "PageErrorBanner");
  const retries = getRetryButtons(tree);
  assert.equal(banners.length, 1, "two regions failing with one cause share one banner");
  assert.equal(retries.length, 1, "one outage carries exactly one Retry");
  assert.equal(findNodes(banners[0], (n) => n === retries[0]).length, 1, "the one Retry is the banner's");

  const onClick = retries[0].props.onClick;
  assert.equal(typeof onClick, "function", "the banner's Retry is wired to a handler");
  setterCalls.length = 0;
  (onClick as () => void)();

  const refreshes = setterCalls.filter((call) => call.initial === 0 && typeof call.next === "function");
  assert.equal(refreshes.length, 1, "Retry advances the refresh tick once");
  assert.equal((refreshes[0].next as (t: number) => number)(0), 1);
});

test("a failed record body reads as a plain sentence, with the raw answer only behind Details", async () => {
  const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
  const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
  const detailState = { status: "error", data: null, error: SERVER_ERROR };

  const tree = renderScreen(create(mod.DetailBody as Component, { detailState, markdown: "" })) as RenderedNode;
  const visible = getVisibleText(tree);
  const details = findNodes(tree, (n) => n.type === "details");

  assert.match(visible, /Couldn't load the record body\./);
  assert.doesNotMatch(visible, /HTTP|500|—/, "no raw status or response text outside Details");
  assert.equal(details.length, 1);
  assert.match(collectText(details[0]), /HTTP 500 Internal Server Error/);
});
