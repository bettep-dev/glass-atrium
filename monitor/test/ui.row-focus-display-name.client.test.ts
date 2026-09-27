// Row focus (one Tab stop per row set / chip group, arrows inside) and the shared display-name map with hidden empty fields.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ui = await loadScreenModule(resolve(__dirname, "../public/src/ui.jsx"));

type RowAction = { focus?: "row" | "control"; index?: number; activate?: boolean } | undefined;
type RowKeyInput = { key: string; rowIndex: number; rowCount: number; controlIndex: number | null; controlCount: number };
type Component = (props: Record<string, unknown>) => unknown;
const getRovingIndex = ui.getRovingIndex as (key: string, index: number | null, count: number, orientation?: string, start?: string) => number | undefined;
const getRovingTabIndex = ui.getRovingTabIndex as (index: number, activeIndex: number | null, count: number) => number;
const getRowKeyAction = ui.getRowKeyAction as (input: RowKeyInput) => RowAction;
const getRowFocusProps = ui.getRowFocusProps as (opts: Record<string, unknown>) => Record<string, unknown>;
// a top-level const reaches the harness context only through window.UI
const ROW_CONTROL_PROPS = (ui.UI as Record<string, unknown>).ROW_CONTROL_PROPS as Record<string, unknown>;
const getDisplayName = ui.getDisplayName as (kind: string, value: unknown) => string | null;
const hasFieldValue = ui.hasFieldValue as (value: unknown) => boolean;
const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };

const rendered = (name: string, props: Record<string, unknown>): RenderedNode =>
  renderScreen(React.createElement(ui[name] as Component, props)) as RenderedNode;

// fake DOM: a row set whose rows each hold `controls` focusable in-row controls
function buildRows(count: number, controls: number) {
  const focused: unknown[] = [];
  const parent = { querySelectorAll: () => rows };
  const rows = Array.from({ length: count }, () => {
    const row: Record<string, unknown> = { parentElement: parent, focus: () => focused.push(row) };
    const own = Array.from({ length: controls }, () => {
      const control = { focus: () => focused.push(control) };
      return control;
    });
    row.controls = own;
    row.querySelectorAll = () => own;
    return row;
  });
  return { rows, focused };
}

function keyEvent(key: string, row: unknown, target: unknown) {
  const event = { key, currentTarget: row, target, isDefaultPrevented: false, preventDefault: () => { event.isDefaultPrevented = true; } };
  return event;
}

describe("roving index", () => {
  const rows = [
    { name: "ArrowRight moves to the next item", key: "ArrowRight", index: 1, count: 3, orientation: "horizontal", next: 2 },
    { name: "ArrowLeft moves to the previous item", key: "ArrowLeft", index: 1, count: 3, orientation: "horizontal", next: 0 },
    { name: "ArrowRight at the last item stays there", key: "ArrowRight", index: 2, count: 3, orientation: "horizontal", next: 2 },
    { name: "ArrowLeft at the first item stays there", key: "ArrowLeft", index: 0, count: 3, orientation: "horizontal", next: 0 },
    { name: "ArrowDown moves down a vertical set", key: "ArrowDown", index: 0, count: 3, orientation: "vertical", next: 1 },
    { name: "ArrowUp moves up a vertical set", key: "ArrowUp", index: 2, count: 3, orientation: "vertical", next: 1 },
    { name: "Home goes to the first item", key: "Home", index: 2, count: 3, orientation: "vertical", next: 0 },
    { name: "End goes to the last item", key: "End", index: 0, count: 3, orientation: "horizontal", next: 2 },
    { name: "a cross-axis arrow is left to the page", key: "ArrowDown", index: 0, count: 3, orientation: "horizontal", next: undefined },
    { name: "an unrelated key is left to the page", key: "a", index: 0, count: 3, orientation: "vertical", next: undefined },
    { name: "an arrow with no active item starts at the first", key: "ArrowRight", index: null, count: 3, orientation: "horizontal", next: 0 },
    { name: "an arrow with no active item starts at the last when the set starts there", key: "ArrowRight", index: null, count: 3, orientation: "horizontal", start: "last", next: 2 },
    { name: "an empty set handles nothing", key: "Home", index: null, count: 0, orientation: "horizontal", next: undefined },
  ];
  for (const row of rows) {
    test(row.name, () => assert.equal(getRovingIndex(row.key, row.index, row.count, row.orientation, row.start), row.next));
  }
});

describe("one Tab stop per set", () => {
  for (const activeIndex of [null, -1, 0, 2, 99]) {
    test(`active ${activeIndex}: exactly one item of four is tabbable and the rest are -1`, () => {
      const stops = [0, 1, 2, 3].map((i) => getRovingTabIndex(i, activeIndex, 4));
      assert.equal(stops.filter((s) => s === 0).length, 1, `stops ${stops}`);
      assert.ok(stops.every((s) => s === 0 || s === -1), `stops ${stops}`);
    });
  }

  test("the active item is the tabbable one", () => assert.equal(getRovingTabIndex(2, 2, 4), 0));

  test("in-row controls are reachable by script but never a Tab stop", () => {
    assert.equal(ROW_CONTROL_PROPS.tabIndex, -1);
    assert.ok("data-row-control" in ROW_CONTROL_PROPS);
  });
});

describe("row key actions", () => {
  const base = { rowIndex: 1, rowCount: 3, controlIndex: null, controlCount: 2 };
  const rows: Array<{ name: string; input: Partial<RowKeyInput> & { key: string }; action: RowAction }> = [
    { name: "ArrowDown on a row focuses the next row", input: { key: "ArrowDown" }, action: { focus: "row", index: 2 } },
    { name: "ArrowUp on a row focuses the previous row", input: { key: "ArrowUp" }, action: { focus: "row", index: 0 } },
    { name: "Home on a row focuses the first row", input: { key: "Home" }, action: { focus: "row", index: 0 } },
    { name: "End on a row focuses the last row", input: { key: "End" }, action: { focus: "row", index: 2 } },
    { name: "Enter on a row activates it", input: { key: "Enter" }, action: { activate: true } },
    { name: "ArrowRight on a row enters its first control", input: { key: "ArrowRight" }, action: { focus: "control", index: 0 } },
    { name: "ArrowRight on a row with no controls is left to the page", input: { key: "ArrowRight", controlCount: 0 }, action: undefined },
    { name: "ArrowRight on a control moves to the next control", input: { key: "ArrowRight", controlIndex: 0 }, action: { focus: "control", index: 1 } },
    { name: "ArrowRight on the last control stays there", input: { key: "ArrowRight", controlIndex: 1 }, action: { focus: "control", index: 1 } },
    { name: "ArrowLeft on the first control returns to its row", input: { key: "ArrowLeft", controlIndex: 0 }, action: { focus: "row", index: 1 } },
    { name: "ArrowLeft on a later control moves back one control", input: { key: "ArrowLeft", controlIndex: 1 }, action: { focus: "control", index: 0 } },
    { name: "Escape on a control returns to its row", input: { key: "Escape", controlIndex: 1 }, action: { focus: "row", index: 1 } },
    { name: "ArrowDown on a control focuses the next row", input: { key: "ArrowDown", controlIndex: 0 }, action: { focus: "row", index: 2 } },
    { name: "Enter on a control is left to the control itself", input: { key: "Enter", controlIndex: 0 }, action: undefined },
    { name: "Tab is never captured", input: { key: "Tab" }, action: undefined },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const action = getRowKeyAction({ ...base, ...row.input });
      // the module runs in its own realm → copy into this realm before a strict structural compare
      assert.deepEqual(action && { ...action }, row.action);
    });
  }
});

describe("row focus props drive DOM focus", () => {
  test("across a row set exactly one row is a Tab stop, and rows are marked for lookup", () => {
    const props = [0, 1, 2].map((index) => getRowFocusProps({ index, activeIndex: 1, count: 3 }));
    assert.deepEqual(props.map((p) => p.tabIndex), [-1, 0, -1]);
    assert.ok(props.every((p) => "data-roving-row" in p));
  });

  test("ArrowDown focuses the next row element and reports it active", () => {
    const { rows, focused } = buildRows(3, 0);
    const active: number[] = [];
    const props = getRowFocusProps({ index: 0, activeIndex: 0, count: 3, onActiveChange: (i: number) => active.push(i) });
    const event = keyEvent("ArrowDown", rows[0], rows[0]);
    (props.onKeyDown as (e: unknown) => void)(event);
    assert.equal(focused[0], rows[1]);
    assert.deepEqual(active, [1]);
    assert.ok(event.isDefaultPrevented, "arrow does not scroll the page");
  });

  test("ArrowRight from a control focuses the row's next control", () => {
    const { rows, focused } = buildRows(2, 2);
    const controls = rows[0].controls as unknown[];
    const props = getRowFocusProps({ index: 0, activeIndex: 0, count: 2 });
    (props.onKeyDown as (e: unknown) => void)(keyEvent("ArrowRight", rows[0], controls[0]));
    assert.equal(focused[0], controls[1]);
  });

  test("Enter on the row calls onActivate with its index", () => {
    const { rows } = buildRows(3, 0);
    const activated: number[] = [];
    const props = getRowFocusProps({ index: 2, activeIndex: 2, count: 3, onActivate: (i: number) => activated.push(i) });
    (props.onKeyDown as (e: unknown) => void)(keyEvent("Enter", rows[2], rows[2]));
    assert.deepEqual(activated, [2]);
  });

  test("an unhandled key leaves the event and focus alone", () => {
    const { rows, focused } = buildRows(3, 0);
    const event = keyEvent("Tab", rows[0], rows[0]);
    (getRowFocusProps({ index: 0, activeIndex: 0, count: 3 }).onKeyDown as (e: unknown) => void)(event);
    assert.equal(focused.length, 0);
    assert.equal(event.isDefaultPrevented, false);
  });

  test("focus landing anywhere in a row makes that row the Tab stop", () => {
    const active: number[] = [];
    (getRowFocusProps({ index: 2, activeIndex: 0, count: 3, onActiveChange: (i: number) => active.push(i) }).onFocus as () => void)();
    assert.deepEqual(active, [2]);
  });
});

describe("chip group", () => {
  const chips = [
    { key: "all", label: "All", isPressed: true },
    { key: "fail", label: "Failed", isPressed: false },
    { key: "done", label: "Done", isPressed: false },
  ];

  test("is a named toolbar of toggle buttons with a single Tab stop", () => {
    const tree = rendered("ChipGroup", { label: "Result filter", chips, onToggle: () => undefined });
    const [toolbar] = findNodes(tree, (n) => n.props.role === "toolbar");
    const buttons = findNodes(tree, (n) => n.type === "button");
    assert.equal(toolbar.props["aria-label"], "Result filter");
    assert.deepEqual(buttons.map((b) => b.props["aria-pressed"]), [true, false, false]);
    assert.equal(buttons.filter((b) => b.props.tabIndex === 0).length, 1);
    assert.equal(collectText(tree).replace(/\s+/g, ""), "AllFailedDone");
  });

  test("ArrowRight moves focus to the next chip", () => {
    const focused: unknown[] = [];
    const buttons = [0, 1, 2].map(() => {
      const b = { focus: () => focused.push(b) };
      return b;
    });
    const tree = rendered("ChipGroup", { label: "Result filter", chips, onToggle: () => undefined });
    const [toolbar] = findNodes(tree, (n) => n.props.role === "toolbar");
    const event = keyEvent("ArrowRight", { querySelectorAll: () => buttons }, buttons[0]);
    (toolbar.props.onKeyDown as (e: unknown) => void)(event);
    assert.equal(focused[0], buttons[1]);
  });
});

describe("display names", () => {
  const rows = [
    { name: "a full model id reads as family and version", kind: "model", value: "claude-opus-5-5", label: "Opus 5.5" },
    { name: "a dated model id drops its date", kind: "model", value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    { name: "a major-only model id keeps its major", kind: "model", value: "claude-opus-5", label: "Opus 5" },
    { name: "a short model alias reads the same as its full id", kind: "model", value: "opus-5", label: "Opus 5" },
    { name: "a dotted short alias reads the same as its full id", kind: "model", value: "opus-4.7", label: "Opus 4.7" },
    { name: "a bare family alias is capitalised", kind: "model", value: "sonnet", label: "Sonnet" },
    { name: "an unknown model id is shown as given", kind: "model", value: "gpt-4o", label: "gpt-4o" },
    { name: "an edge type reads as words", kind: "edge", value: "control_flow", label: "Control flow" },
    { name: "a known edge type keeps its phrasing", kind: "edge", value: "escalates_to", label: "Escalates to" },
    { name: "an unknown edge type is still turned into words", kind: "edge", value: "spawns_worker", label: "Spawns worker" },
    { name: "a kebab pattern key reads as a sentence", kind: "pattern", value: "editable-region-arbiter-resolved", label: "Editable region arbiter resolved" },
    { name: "an unknown kind passes the trimmed value through", kind: "other", value: "  keep_me ", label: "keep_me" },
  ];
  for (const row of rows) {
    test(row.name, () => assert.equal(getDisplayName(row.kind, row.value), row.label));
  }

  test("every spelling of one model lands on one display name", () => {
    const names = new Set(["claude-opus-5", "opus-5", "claude-opus-5-20260101"].map((v) => getDisplayName("model", v)));
    assert.equal(names.size, 1, [...names].join(" | "));
  });

  for (const kind of ["model", "edge", "pattern"]) {
    test(`${kind}: an empty or placeholder value has no display name, so the field is hidden`, () => {
      for (const value of [null, undefined, "", "  ", "—", "unknown", "N/A"]) {
        assert.equal(getDisplayName(kind, value), null, `value ${JSON.stringify(value)}`);
      }
    });
  }
});

describe("empty fields are hidden", () => {
  const rows = [
    { name: "null is empty", value: null, has: false },
    { name: "whitespace is empty", value: "   ", has: false },
    { name: "a dash placeholder is empty", value: "—", has: false },
    { name: "'unknown' in any case is empty", value: "Unknown", has: false },
    { name: "NaN is empty", value: Number.NaN, has: false },
    { name: "zero is a value", value: 0, has: true },
    { name: "false is a value", value: false, has: true },
    { name: "text is a value", value: "hooks/track-outcome.sh", has: true },
  ];
  for (const row of rows) {
    test(row.name, () => assert.equal(hasFieldValue(row.value), row.has));
  }

  test("a detail field with a value shows its label and value", () => {
    const text = collectText(rendered("DetailField", { label: "File path", value: "hooks/a.sh" }));
    assert.ok(text.includes("File path") && text.includes("hooks/a.sh"), text);
  });

  test("a detail field label sits on the meta type step, never below the meta floor", () => {
    const tree = rendered("DetailField", { label: "File path", value: "hooks/a.sh" });
    const [label] = findNodes(tree, (n) => n.type === "div" && collectText(n) === "File path");
    assert.ok(label, "the label renders");
    const classes = String(label.props.className).split(/\s+/);
    assert.ok(classes.includes("fs-meta"), String(label.props.className));
    assert.ok(!classes.includes("fs-micro"), String(label.props.className));
  });

  test("a detail field with a placeholder value renders nothing", () => {
    assert.equal(collectText(rendered("DetailField", { label: "Last action", value: "unknown" })), "");
  });
});
