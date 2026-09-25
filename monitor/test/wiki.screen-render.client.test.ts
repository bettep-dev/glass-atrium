// Element-tree behaviour tests for the Wiki screen: disclosure affordance and the
// notes-per-day bars' labels. Exercises the shipped JSX through test/lib/render-screen.ts.
//
// Runner: npx tsx --test test/wiki.screen-render.client.test.ts

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
const WIKI_SRC = resolve(__dirname, "../public/src/screens/wiki.jsx");

// window.UI stub — every atom resolves to a transparent host element.
function uiStub(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name === "TONE_ICON"
          ? new Proxy({}, { get: () => "dot" })
          : name === "formatInt"
          ? (n: number) => String(n)
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

async function loadWikiScreen(): Promise<ScreenModule> {
  return (await loadScreenModule(WIKI_SRC, { UI: uiStub(), React: createReactStub() })) as ScreenModule;
}

function classOf(node: RenderedNode): string {
  return String(node.props.className ?? "");
}

test("every disclosure leads its summary with a chevron the screen's own style turns on open", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.ScreenWiki as Component, {}));

  const disclosures = findNodes(tree, (n) => n.type === "details");
  assert.ok(disclosures.length > 0, "the loading screen still renders its run-history disclosure");
  for (const details of disclosures) {
    assert.ok(classOf(details).includes("w-disclosure"), "the details carries the class the screen style targets");
    const summary = details.children[0] as RenderedNode;
    assert.equal(summary.type, "summary");
    const chevron = summary.children[0] as RenderedNode;
    assert.ok(classOf(chevron).includes("w-chevron"), "the chevron is the summary's first child");
    assert.equal(chevron.props["aria-hidden"], "true", "the chevron is decoration — the details reports its own state");
  }

  const style = collectText(findNodes(tree, (n) => n.type === "style")[0]);
  assert.match(style, /\.w-disclosure > summary::-webkit-details-marker\s*\{\s*display:\s*none/);
  assert.match(style, /\.w-disclosure\[open\] > summary \.w-chevron\s*\{\s*transform:\s*rotate\(90deg\)/);
});

test("the notes-per-day bars name their date range and their peak value with its date", async () => {
  const mod = await loadWikiScreen();
  const SparseTrendW = mod.SparseTrendW as Component;

  const dates = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];
  for (const [series, peakDate, peak] of [
    [[1, 2, 9, 3, 4], "2026-09-03", "9"],
    [[7, 1, 2, 3, 0], "2026-09-01", "7"],
  ] as const) {
    const tree = renderScreen(
      mod.React.createElement(SparseTrendW, { label: "Notes per day", series, dates, w: 10, h: 44, tone: "accent" }),
    );
    const figure = findNodes(tree, (n) => n.props.role === "img");
    assert.equal(figure.length, 1, "the bars sit inside one labelled image");
    const label = String(figure[0].props["aria-label"]);
    for (const part of [dates[0], dates[dates.length - 1], `peak ${peak} on ${peakDate}`]) {
      assert.ok(label.includes(part), `aria label names ${part}: ${label}`);
    }
    const visible = collectText(tree);
    assert.ok(visible.includes(dates[0]) && visible.includes(dates[dates.length - 1]), "the axis shows both end dates");
    assert.ok(visible.includes(`peak ${peak} on ${peakDate}`), "the visible caption carries the peak value and date");
  }
});
