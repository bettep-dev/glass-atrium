// Shared KPI value atom (plan 39859 P2b): one type scale for headline figures, tone on the glyph only.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;

const ui = await loadScreenModule(UI_SRC);
const React = ui.React as { createElement: (t: unknown, p: unknown, ...c: unknown[]) => unknown };

function render(name: string, props: Record<string, unknown>, ...children: unknown[]): RenderedNode {
  return renderScreen(React.createElement(ui[name] as Component, props, ...children)) as RenderedNode;
}

const hasKpiScale = (n: RenderedNode) => /\bkpi-value\b/.test(String(n.props.className ?? ""));

test("the value atom and the KPI card share one headline scale class", () => {
  const atom = render("KpiValue", {}, "42");
  const card = render("KPI", { label: "Spend", value: "42" });
  for (const tree of [atom, card]) {
    const scaled = findNodes(tree, hasKpiScale);
    assert.equal(scaled.length, 1);
    assert.equal(collectText(scaled[0]).trim(), "42");
  }
});

test("a toned value colours only a decorative glyph — the figure stays in the neutral ink", () => {
  for (const tone of ["ok", "warn", "crit"]) {
    const tree = render("KpiValue", { tone }, "7");
    const toned = findNodes(tree, (n) => /\btext-(ok|warn|crit|info)\b/.test(String(n.props.className ?? "")));
    assert.equal(toned.length, 1, `${tone}: exactly one toned node`);
    assert.equal(toned[0].props["aria-hidden"], "true", "the toned node is the glyph");
    assert.ok(!collectText(toned[0]).includes("7"), "the figure is not inside the toned node");
  }
  const plain = render("KpiValue", {}, "7");
  assert.equal(findNodes(plain, (n) => n.props["aria-hidden"] === "true").length, 0, "no tone, no glyph");
});

test("a unit trails the figure inside the same scaled value", () => {
  const scaled = findNodes(render("KpiValue", { unit: "%" }, "92"), hasKpiScale);
  assert.equal(collectText(scaled[0]).replace(/\s+/g, ""), "92%");
});
