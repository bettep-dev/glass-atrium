// Element-tree behaviour tests for the Dashboard lane and tiles: the alarm lane as a live
// region, drill links as real anchors, tile headings and the value scale. Exercises the
// shipped JSX through test/lib/render-screen.ts.
//
// Runner: npx tsx --test test/dashboard.screen-render.client.test.ts

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
const DASH_SRC = resolve(__dirname, "../public/src/screens/dashboard.jsx");

// window.UI stub — every atom resolves to a transparent host element.
function uiStub(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name === "TONE_ICON"
          ? new Proxy({}, { get: () => "dot" })
          : Object.defineProperty(
              (props: Record<string, unknown>) => ({
                __element: true,
                type: "ui-atom",
                props: { ...props, atom: name },
              }),
              "name",
              { value: name },
            ),
      has: () => true,
    },
  );
}

type Component = (props: unknown) => unknown;
interface ScreenModule {
  React: { createElement: (t: unknown, p: unknown) => unknown };
  [name: string]: unknown;
}

const mod = (await loadScreenModule(DASH_SRC, { UI: uiStub(), React: createReactStub() })) as ScreenModule;

function render(name: string, props: Record<string, unknown>): RenderedNode {
  return renderScreen(mod.React.createElement(mod[name] as Component, props)) as RenderedNode;
}
function classOf(node: RenderedNode): string {
  return String(node.props.className ?? "");
}

const HARNESS_ALARM = {
  id: "harness", tone: "crit", title: "1 harness part is down", detail: "autoagent",
  target: "architecture", targetLabel: "System map",
};
const READY_TILE = {
  id: "outcomes", label: "Task results", window: "7 d", status: "ready", tone: "neutral",
  value: "40", hint: "40 outcomes", target: "outcomes", targetLabel: "Task results",
};

test("the alarm lane is a polite live region that exists before any alarm arrives", () => {
  for (const alarms of [[], [HARNESS_ALARM]]) {
    const lane = render("AlarmLane", { alarms, onNav: () => {} });
    const regions = findNodes(lane, (n) => n.props["aria-live"] === "polite");
    assert.equal(regions.length, 1, `one polite region with ${alarms.length} alarms`);
    assert.equal(regions[0].props["aria-label"], "Alarms");
    const rows = findNodes(regions[0], (n) => n.props.role === "listitem");
    assert.equal(rows.length, alarms.length, "every alarm row sits inside the region");
  }
});

test("every drill is an anchor to its screen's hash; a plain click routes in-app, a modified one is left to the browser", () => {
  const trees = [
    render("AlarmLane", { alarms: [HARNESS_ALARM], onNav: (t: string) => navs.push(t) }),
    render("StatusTile", { tile: READY_TILE, onNav: (t: string) => navs.push(t), onRetry: () => {} }),
  ];
  const navs: string[] = [];
  for (const [tree, target] of [[trees[0], "architecture"], [trees[1], "outcomes"]] as const) {
    const anchors = findNodes(tree, (n) => n.type === "a");
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].props.href, `#${target}`);
    assert.equal(findNodes(tree, (n) => n.type === "button").length, 0, "no drill stays a button");

    const onClick = anchors[0].props.onClick as (e: unknown) => void;
    let prevented = 0;
    const event = (extra: Record<string, unknown>) => ({ button: 0, preventDefault: () => { prevented += 1; }, ...extra });
    navs.length = 0;
    onClick(event({}));
    assert.deepEqual(navs, [target]);
    assert.equal(prevented, 1);
    for (const extra of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      onClick(event(extra));
    }
    assert.deepEqual(navs, [target], "modified clicks open the href natively");
    assert.equal(prevented, 1);
  }
});

test("a tile heads with an h2 whose window keeps its own case, and leads with the KPI-scale value", () => {
  const tree = render("StatusTile", { tile: READY_TILE, onNav: () => {}, onRetry: () => {} });
  const headings = findNodes(tree, (n) => n.type === "h2");
  assert.equal(headings.length, 1);
  const windowSpan = findNodes(headings[0], (n) => classOf(n).includes("normal-case"));
  assert.equal(windowSpan.length, 1, "the window escapes the label's uppercase");
  assert.equal(collectText(windowSpan[0]).replace(/\s+/g, ""), "(7d)");
  const value = findNodes(tree, (n) => classOf(n).includes("kpi-value"));
  assert.equal(value.length, 1, "the value uses the Cost page's KPI scale");
  assert.equal(collectText(value[0]), "40");
});
