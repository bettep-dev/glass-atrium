// Shared KPI value atom: one type scale for headline figures, tone on the glyph only.
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

test("a KPI hint renders at the scale its caller names, and at the meta floor when none is named", () => {
  const rows = [
    { name: "no scale named", props: {}, scale: "fs-meta" },
    { name: "body scale named", props: { hintClassName: "fs-body" }, scale: "fs-body" },
  ];
  for (const row of rows) {
    const tree = render("KPI", { label: "Applied", value: "3", hint: "of 12 cycles", ...row.props });
    const hints = findNodes(tree, (n) => /\bkpi-hint\b/.test(String(n.props.className ?? "")));
    assert.equal(hints.length, 1, `${row.name}: one hint node`);
    const classes = String(hints[0].props.className).split(/\s+/);
    assert.ok(classes.includes(row.scale), `${row.name}: hint carries ${row.scale}`);
    assert.equal(classes.filter((c) => /^fs-/.test(c)).length, 1, `${row.name}: exactly one type scale`);
    assert.equal(collectText(hints[0]).trim(), "of 12 cycles");
  }
});

// One KPI anatomy (design spec amendment (c)): rows in a fixed order, every state in the same rows.
const classOf = (n: RenderedNode) => String(n.props.className ?? "");
const hasClass = (n: RenderedNode, name: string) => classOf(n).split(/\s+/).includes(name);
const ROW_CLASSES = ["kpi-head", "kpi-main", "kpi-delta-row", "kpi-hint", "kpi-foot"];

function rowOrder(tree: RenderedNode): string[] {
  return findNodes(tree, (n) => ROW_CLASSES.some((name) => hasClass(n, name)))
    .map((n) => ROW_CLASSES.find((name) => hasClass(n, name)) as string);
}

test("the value row always precedes the delta, the hint and the foot, whatever order the caller passes them in", () => {
  const tree = render("KPI", { hint: "of 12 cycles", foot: "Open", delta: 4.2, value: "3", label: "Applied" });
  assert.deepEqual(rowOrder(tree), ROW_CLASSES);
  const text = collectText(tree);
  assert.ok(text.indexOf("3") < text.indexOf("of 12 cycles"), "the figure reads before its hint");
});

test("loading, error and empty keep the label and hint rows; loading holds the value row with a strut, the others show a faint dash", () => {
  const states = [
    { state: "loading", hasStrut: true, dash: false },
    { state: "error", hasStrut: false, dash: true },
    { state: "empty", hasStrut: false, dash: true },
  ];
  for (const row of states) {
    const tree = render("KPI", { label: "Spend", value: "0", hint: "Not loaded", state: row.state, loadingLabel: "spend" });
    assert.deepEqual(rowOrder(tree), ["kpi-head", "kpi-main", "kpi-hint"], `${row.state}: same rows`);
    const struts = findNodes(tree, (n) => n.type === "span" && classOf(n) === "kpi-value");
    assert.equal(struts.length, row.hasStrut ? 1 : 0, `${row.state}: strut`);
    assert.equal(findNodes(tree, (n) => n.type === "LoadingPlaceholder").length, row.hasStrut ? 1 : 0, `${row.state}: placeholder`);
    const values = findNodes(tree, (n) => n.type === "div" && hasKpiScale(n));
    if (row.dash) {
      assert.equal(collectText(values[0]).trim(), "0", `${row.state}: an authored value is kept`);
      assert.ok(hasClass(values[0], "text-faint"), `${row.state}: the unknown value is faint`);
      const bare = render("KPI", { label: "Spend", state: row.state });
      assert.equal(collectText(findNodes(bare, (n) => n.type === "div" && hasKpiScale(n))[0]).trim(), "—", `${row.state}: no value → the dash, never 0`);
    }
    const root = findNodes(tree, (n) => hasClass(n, "kpi"))[0];
    assert.equal(root.props["aria-busy"], row.state === "loading" ? "true" : undefined, `${row.state}: busy only while loading`);
  }
});

test("a tile is a button only when it is clickable, otherwise a group named by its label row", () => {
  const clickable = findNodes(render("KPI", { label: "Spend", value: "4", onClick: () => {} }), (n) => hasClass(n, "kpi"))[0];
  assert.equal(clickable.type, "button");
  assert.equal(clickable.props.type, "button");
  const tree = render("KPI", { id: "t1", label: "Spend", value: "4" });
  const group = findNodes(tree, (n) => hasClass(n, "kpi"))[0];
  assert.equal(group.type, "div");
  assert.equal(group.props.role, "group");
  const [head] = findNodes(tree, (n) => hasClass(n, "kpi-head"));
  assert.equal(group.props["aria-labelledby"], head.props.id, "the group is labelled by its label row");
});

test("the aside window tag sits beside the label, outside it, and the ⓘ sits apart from the value row", () => {
  const tree = render("KPI", { label: "Task results", aside: "(7 d)", info: "INFO", value: "40", labelClassName: "uppercase" });
  const [head] = findNodes(tree, (n) => hasClass(n, "kpi-head"));
  const [label] = findNodes(head, (n) => hasClass(n, "kpi-label-text"));
  const [aside] = findNodes(head, (n) => hasClass(n, "kpi-aside"));
  assert.equal(collectText(aside), "(7 d)");
  assert.equal(findNodes(label, (n) => hasClass(n, "kpi-aside")).length, 0, "the aside is not inside the label");
  assert.equal(label.props.title, "Task results", "a text label keeps its full text in the title for its ellipsis");
  const [info] = findNodes(tree, (n) => hasClass(n, "kpi-info"));
  assert.equal(collectText(info), "INFO");
  const [main] = findNodes(tree, (n) => hasClass(n, "kpi-main"));
  assert.equal(findNodes(main, (n) => hasClass(n, "kpi-info")).length, 0, "the ⓘ never sits in the value row");
  assert.ok(hasClass(findNodes(tree, (n) => hasClass(n, "kpi"))[0], "kpi--info"), "the root reserves the ⓘ's room");
});

test("a KPI hint keeps the face its caller names, and the mono face when none is named", () => {
  const faint = findNodes(render("KPI", { label: "A", value: "1", hint: "h" }), (n) => hasClass(n, "kpi-hint"))[0];
  assert.ok(hasClass(faint, "font-mono"), classOf(faint));
  const named = findNodes(render("KPI", { label: "A", value: "1", hint: "h", hintFace: "text-dim" }), (n) => hasClass(n, "kpi-hint"))[0];
  assert.ok(!hasClass(named, "font-mono") && hasClass(named, "text-dim"), classOf(named));
});
