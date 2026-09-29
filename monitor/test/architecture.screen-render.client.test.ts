// Element-tree behaviour tests for the System map screen, run on the shipped JSX through test/lib/render-screen.ts.
//
// Runner: npx tsx --test test/architecture.screen-render.client.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createReactStub, findNodes, loadScreenModule, renderScreen } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH_SRC = resolve(__dirname, "../public/src/screens/architecture.jsx");
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const realUi = ((await loadScreenModule(UI_SRC)) as { UI: Record<string, unknown> }).UI;

type Component = (props: unknown) => unknown;

// window.UI stub — components resolve to transparent host elements; state helpers and constants stay real.
function uiStub(overrides: Record<string, unknown>): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name in overrides) return overrides[name];
        if (!/^[A-Z][a-z]/.test(name) && name in realUi) return realUi[name];
        return Object.defineProperty(
          (props: Record<string, unknown>) => ({ __element: true, type: "ui-atom", props: { ...props, atom: name } }),
          "name",
          { value: name },
        );
      },
      has: () => true,
    },
  );
}

test("the page alert shows its Retry in flight and hands focus to the verdict, which outlives recovery", async () => {
  const initial = realUi.INITIAL_REGION_STATE as Record<string, unknown>;
  const retrying = { ...initial, status: "error", data: null, error: "HTTP 503 Service Unavailable — down", busy: true };
  const mod = (await loadScreenModule(ARCH_SRC, {
    UI: uiStub({ INITIAL_REGION_STATE: retrying }),
    React: createReactStub(),
  })) as { React: { createElement: (t: unknown, p: unknown) => unknown }; ScreenArchitecture: Component };

  const tree = renderScreen(mod.React.createElement(mod.ScreenArchitecture, {}));
  const banners = findNodes(tree, (n) => n.props.atom === "PageErrorBanner");
  assert.equal(banners.length, 1, "every read failing on one cause lifts to one page alert");
  assert.equal(banners[0].props.isBusy, true, "a Retry in flight marks the alert busy");
  // host nodes only — a stubbed atom also appears as its component node
  const targets = findNodes(tree, (n) => /^[a-z]/.test(n.type) && n.props.id === banners[0].props.focusTargetId);
  assert.equal(targets.length, 1, `focus target ${String(banners[0].props.focusTargetId)} is one rendered element`);
  assert.notEqual(targets[0].props.atom, "PageErrorBanner", "focus lands outside the alert that unmounts on recovery");
});
