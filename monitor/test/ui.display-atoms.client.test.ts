// Display atoms: the two empty states, the machine string's two forms, the page header's one-line slots, the pagination bar, the stat row, the stat notes, the card head Status, the low-sample mark and whole day tokens.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;

const ui = await loadScreenModule(UI_SRC);
const React = ui.React as { createElement: (t: unknown, p: unknown, ...c: unknown[]) => unknown };

function render(name: string, props: Record<string, unknown>): RenderedNode {
  return renderScreen(React.createElement(ui[name] as Component, props)) as RenderedNode;
}

const getButtons = (tree: RenderedNode) => findNodes(tree, (n) => n.type === "button");
const getButton = (tree: RenderedNode, name: string) =>
  getButtons(tree).find((n) => n.props["aria-label"] === name || collectText(n).trim() === name) as RenderedNode;
const press = (button: RenderedNode) => (button.props.onClick as (e: unknown) => void)({});

describe("empty state kinds", () => {
  test("a first-use state keeps the caller's message and hint and offers no reset", () => {
    const tree = render("EmptyState", { message: "No runs yet", hint: "the wiki compiles nightly at 04:30" });
    const text = collectText(tree);
    assert.match(text, /No runs yet/);
    assert.match(text, /compiles nightly/);
    assert.equal(getButtons(tree).length, 0);
  });

  test("a no-results state reads the fixed sentence whatever message the caller passed, and its reset calls back", () => {
    const resets: number[] = [];
    const tree = render("EmptyState", { kind: "no-results", message: "Nothing for agent x", onReset: () => resets.push(1) });
    assert.match(collectText(tree), /No records match these filters\./);
    assert.doesNotMatch(collectText(tree), /Nothing for agent x/);
    press(getButton(tree, "Reset filters"));
    assert.equal(resets.length, 1);
  });

  test("a no-results state with no reset handler offers no dead button", () => {
    assert.equal(getButtons(render("EmptyState", { kind: "no-results" })).length, 0);
  });
});

describe("page header slots", () => {
  test("back link, title and status read before the right group, and the primary is the last control", () => {
    const tree = render("PageHeader", {
      title: "Run 42",
      back: React.createElement("a", { href: "#/runs" }, "Runs"),
      status: React.createElement("span", { "data-slot": "status" }, "Done"),
      refresh: React.createElement("button", { type: "button" }, "Refresh"),
      primary: React.createElement("button", { type: "button" }, "Approve"),
    });
    const order = collectText(tree).split(/\s+/).filter(Boolean);
    const at = (word: string) => order.indexOf(word);
    assert.ok(at("Runs") < at("Run") && at("42") < at("Done") && at("Done") < at("Refresh") && at("Refresh") < at("Approve"), order.join(" "));
  });

  test("a header with only a title renders no empty right group", () => {
    assert.equal(findNodes(render("PageHeader", { title: "Runs" }), (n) => String(n.props.className ?? "").includes("page-head-cluster")).length, 0);
  });
});

describe("pagination", () => {
  const rows = [
    { name: "first page", page: 0, pageSize: 20, total: 1284, range: "1–20 of 1,284" },
    { name: "middle page", page: 3, pageSize: 20, total: 1284, range: "61–80 of 1,284" },
    { name: "short last page ends at the total", page: 64, pageSize: 20, total: 1284, range: "1,281–1,284 of 1,284" },
    { name: "a page past the end after the total shrank reads the last page", page: 70, pageSize: 20, total: 1284, range: "1,281–1,284 of 1,284" },
  ];
  for (const row of rows) {
    test(`the range covers exactly the page's rows: ${row.name}`, () => {
      const tree = render("Pagination", { page: row.page, pageSize: row.pageSize, total: row.total, onPageChange: () => {} });
      assert.match(collectText(tree), new RegExp(row.range));
    });
  }

  test("Previous and Next step one page, and each is inert yet focusable at its end", () => {
    const calls: number[] = [];
    const onPageChange = (next: number) => calls.push(next);
    const first = render("Pagination", { page: 0, pageSize: 20, total: 50, onPageChange });
    const last = render("Pagination", { page: 2, pageSize: 20, total: 50, onPageChange });
    press(getButton(first, "Previous page"));
    press(getButton(last, "Next page"));
    press(getButton(first, "Next page"));
    press(getButton(last, "Previous page"));
    assert.deepEqual(calls, [1, 1]);
    assert.equal(getButton(first, "Previous page").props["aria-disabled"], "true");
    assert.equal(getButton(last, "Next page").props["aria-disabled"], "true");
    assert.equal(getButton(first, "Previous page").props.disabled, undefined);
  });

  test("a page past the end steps from the last page: Next is inert and Previous lands one before it", () => {
    const calls: number[] = [];
    const past = render("Pagination", { page: 70, pageSize: 20, total: 50, onPageChange: (next: number) => calls.push(next) });
    press(getButton(past, "Next page"));
    press(getButton(past, "Previous page"));
    assert.deepEqual(calls, [1]);
    assert.equal(getButton(past, "Next page").props["aria-disabled"], "true");
  });

  test("the current page is marked for assistive tech with its number", () => {
    const current = findNodes(render("Pagination", { page: 3, pageSize: 20, total: 1284, onPageChange: () => {} }), (n) => n.props["aria-current"] === "page");
    assert.equal(current.length, 1);
    assert.match(collectText(current[0]), /Page\s*4\s*of 65/);
  });

  test("an empty result renders no pagination", () => {
    const tree = render("Pagination", { page: 0, pageSize: 20, total: 0, onPageChange: () => {} });
    assert.equal(findNodes(tree, (n) => n.type === "nav" || n.type === "button").length, 0);
  });
});

describe("stat row", () => {
  const getTerms = (tree: RenderedNode) => findNodes(tree, (n) => n.type === "dt").map((n) => collectText(n).trim());
  const getValues = (tree: RenderedNode) => findNodes(tree, (n) => n.type === "dd" && /\bstat-value\b/.test(String(n.props.className)));

  test("each stat pairs its label term with its value and unit, in the caller's order", () => {
    const tree = render("StatRow", { stats: [
      { label: "Spend", value: "$41.20", context: "last 7 days" },
      { label: "Runs", value: "1,284" },
      { label: "Median run", value: "38", unit: "s" },
    ] });
    assert.equal(findNodes(tree, (n) => n.type === "dl").length, 1);
    assert.deepEqual(getTerms(tree), ["Spend", "Runs", "Median run"]);
    assert.deepEqual(getValues(tree).map((n) => collectText(n).replace(/\s+/g, "")), ["$41.20", "1,284", "38s"]);
  });

  test("a context line renders only for the stat that has one", () => {
    const tree = render("StatRow", { stats: [{ label: "Spend", value: "$41.20", context: "last 7 days" }, { label: "Runs", value: "1,284" }] });
    const contexts = findNodes(tree, (n) => n.type === "dd" && /\bstat-context\b/.test(String(n.props.className)));
    assert.deepEqual(contexts.map((n) => collectText(n)), ["last 7 days"]);
  });

  test("only a stat with a drill-down target makes its value a link to that target", () => {
    const tree = render("StatRow", { stats: [{ label: "Failed", value: "3", href: "#/outcomes?result=fail" }, { label: "Runs", value: "1,284" }] });
    const links = findNodes(tree, (n) => n.type === "a");
    assert.equal(links.length, 1);
    assert.equal(links[0].props.href, "#/outcomes?result=fail");
    assert.match(collectText(links[0]), /^3/);
    assert.equal(findNodes(tree, (n) => n.type === "button").length, 0);
  });

  // one loading look on every stat row: the value says what it waits for in regular weight, the context line holds its height
  test("a loading stat draws the shared placeholder named for its label, regular weight, and links nowhere until it lands", () => {
    const tree = render("StatRow", { stats: [{ label: "Spend today", isLoading: true, value: "$41.20", href: "#/cost", context: "up 4%" }] });
    const value = getValues(tree)[0];
    const [placeholder] = findNodes(value, (n) => n.props.role === "status");
    assert.equal(collectText(placeholder).trim(), "Loading spend today\u2026");
    assert.match(String(placeholder.props.className), /\bfont-normal\b/, "the figure's 600 is not the placeholder's");
    assert.equal(findNodes(tree, (n) => n.type === "a").length, 0);
    assert.doesNotMatch(collectText(tree), /\$41\.20|up 4%/, "a value it has not read stays unsaid");
    const [context] = findNodes(tree, (n) => n.type === "dd" && /\bstat-context\b/.test(String(n.props.className)));
    assert.equal(collectText(context).trim(), "", "the context line is reserved, empty");
    assert.equal(findNodes(context, (n) => n.props["aria-hidden"] === "true").length, 1, "the reserved line is hidden from assistive tech");
  });

  test("the tone glyph is the alarm row's glyph, hidden from assistive tech, its word read before what follows", () => {
    const [alarmGlyph] = findNodes(render("AlarmRow", { tone: "crit", title: "2 of 7 agents down" }), (n) => n.type === "svg");
    const rows = [
      { name: "the tone's severity word by default", props: { tone: "crit" }, word: `${(ui.UI as { ALERT_SEVERITY_WORD: Record<string, string> }).ALERT_SEVERITY_WORD.crit}:` },
      { name: "a caller's own word", props: { tone: "warn", label: "Running hot" }, word: "Running hot:" },
    ];
    for (const row of rows) {
      const tree = render("ToneGlyph", row.props);
      const [glyph] = findNodes(tree, (n) => n.type === "svg");
      const hidden = findNodes(tree, (n) => n.props["aria-hidden"] === "true");
      assert.equal(glyph.props.width, alarmGlyph.props.width, `${row.name}: the alarm row's glyph size`);
      assert.ok(hidden.length === 1 && findNodes(hidden[0], (n) => n === glyph).length === 1, `${row.name}: the glyph is hidden`);
      assert.equal(collectText(tree).trim(), row.word, row.name);
    }
  });

  test("a card head's Status leads with the tone glyph, its severity word read before the words", () => {
    const [toneGlyph] = findNodes(render("ToneGlyph", { tone: "warn" }), (n) => n.type === "svg");
    const tree = render("HeadStatus", { tone: "warn", children: "2 awaiting" });
    const [status] = findNodes(tree, (n) => n.props["data-role"] === "head-status");
    const [glyph] = findNodes(status, (n) => n.type === "svg");
    const severityWord = (ui.UI as { ALERT_SEVERITY_WORD: Record<string, string> }).ALERT_SEVERITY_WORD.warn;
    assert.equal(glyph.props.width, toneGlyph.props.width, "the alarm-size tone glyph");
    assert.equal(collectText(status).replace(/\s+/g, " ").trim(), `${severityWord}: 2 awaiting`);
  });

  const valueRows = [
    { name: "zero is a real value", value: 0, text: "0" },
    { name: "null reads None", value: null, text: "None" },
    { name: "a missing value reads None", value: undefined, text: "None" },
  ];
  for (const row of valueRows) {
    test(`an absent value reads None, a present one as given: ${row.name}`, () => {
      const tree = render("StatRow", { stats: [{ label: "Runs", value: row.value }] });
      assert.equal(collectText(getValues(tree)[0]).trim(), row.text);
    });
  }
});

describe("stat notes", () => {
  test("each stat's note is one paragraph led by its label in ink, in the caller's order", () => {
    const tree = render("StatNotes", { stats: [
      { key: "compiled", label: "Compiled last cycle", info: "13 saved originals are waiting and the last cycle compiled none." },
      { label: "Library notes", info: "The library snapshot is from 20 Nov." },
    ] });
    const notes = findNodes(tree, (n) => n.type === "p");
    const leads = notes.map((n) => n.children[0] as RenderedNode);
    assert.deepEqual(leads.map((n) => collectText(n)), ["Compiled last cycle", "Library notes"]);
    assert.ok(leads.every((n) => /\btext-ink\b/.test(String(n.props.className))), "the label is in ink");
    assert.deepEqual(notes.map((n) => collectText(n).replace(/\s+/g, " ")), [
      "Compiled last cycle — 13 saved originals are waiting and the last cycle compiled none.",
      "Library notes — The library snapshot is from 20 Nov.",
    ]);
  });
});

describe("machine string", () => {
  const PATCH = "--- a/ui.jsx\n+++ b/ui.jsx";
  const rows = [
    { name: "an inline string is a code element in the machine face", isBlock: false, tag: "code", classes: ["machine"] },
    { name: "multi-line machine text takes the block form, a pre carrying the block modifier", isBlock: true, tag: "pre", classes: ["machine", "machine--block"] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const [host] = findNodes(render("MachineString", { isBlock: row.isBlock, children: PATCH }), (n) => /^[a-z]/.test(n.type));
      assert.deepEqual({ tag: host.type, classes: String(host.props.className).split(" "), text: collectText(host) }, { tag: row.tag, classes: row.classes, text: PATCH });
    });
  }
});

describe("absent value", () => {
  const rows = [
    { name: "an empty value", kind: "none", text: "None" },
    { name: "an unread value", kind: "not-loaded", text: "Not loaded" },
    { name: "a value whose caller names no kind is not claimed empty", kind: undefined, text: "Not loaded" },
  ];
  for (const row of rows) {
    test(`each kind of nothing has its own words, in faint ink with the cause on hover: ${row.name}`, () => {
      const tree = render("AbsentValue", { kind: row.kind, title: "Outcomes read failed" });
      const span = findNodes(tree, (n) => n.type === "span")[0];
      assert.equal(collectText(span).trim(), row.text);
      assert.match(String(span.props.className), /\btext-faint\b/);
      assert.equal(span.props.title, "Outcomes read failed");
    });
  }
});

describe("LowSampleMark", () => {
  const LOW_N_MIN = (ui.UI as Record<string, unknown>).LOW_N_MIN as number;
  const isLowSample = ui.isLowSample as (n: unknown) => boolean;
  const rows = [
    { name: "one below the threshold", n: LOW_N_MIN - 1, expected: true },
    { name: "an empty sample", n: 0, expected: true },
    { name: "exactly the threshold", n: LOW_N_MIN, expected: false },
    { name: "a missing count", n: undefined, expected: false },
    { name: "a non-numeric count", n: Number.NaN, expected: false },
  ];

  for (const row of rows) {
    test(`${row.name} ${row.expected ? "is" : "is not"} a low sample`, () => {
      assert.equal(isLowSample(row.n), row.expected);
    });
  }

  test("a low sample names its n and a trustworthy one renders nothing", () => {
    const low = renderScreen(React.createElement(ui.LowSampleMark as Component, { n: 12 }));
    const enough = renderScreen(React.createElement(ui.LowSampleMark as Component, { n: LOW_N_MIN }));

    assert.equal(collectText(low).replace(/\s+/g, ""), "(n=12)");
    assert.equal(collectText(enough), "");
  });
});

// R-c: a number + day token never breaks across lines inside its sentence, in each of its three forms — spaced ("30 days",
// "1 day", "3–7 days"), dashed compound ("7-day", "30-day", "3–7-day") and qualified noun ("28 cycle days")
describe("DayTokens", () => {
  const h = React.createElement;
  const Fragment = (ui.React as { Fragment: unknown }).Fragment;
  const isNoWrap = (n: RenderedNode) => /\bwhitespace-nowrap\b/.test(String(n.props.className ?? ""));
  const renderTokens = (sentence: unknown) => renderScreen(h(ui.DayTokens as Component, {}, sentence)) as RenderedNode;
  // the strings as rendered, joined with nothing between them (collectText pads node boundaries)
  const rawText = (n: RenderedNode | string): string => (typeof n === "string" ? n : n.children.map(rawText).join(""));
  const ROWS = [
    { sentence: "12% vs the 30 days before 09-30, cut at this time of day", tokens: ["30 days"] },
    { sentence: "No runs in the last 1 day", tokens: ["1 day"] },
    { sentence: "Window 3–7 days · 1,200 days kept", tokens: ["3–7 days", "1,200 days"] },
    // dashed compound: Chrome breaks after the hyphen, so "7-day" outside a nowrap span splits across lines
    { sentence: "Alarm at 1.25× the 7-day avg/day · a fixed 30-day window · a 3–7-day span", tokens: ["7-day", "30-day", "3–7-day"] },
    // qualified noun: the count, its qualifier and the unit are one token
    { sentence: "Share rejected per day · all 28 cycle days: 3 verified · last 1 cycle day", tokens: ["28 cycle days", "1 cycle day"] },
  ];
  for (const row of ROWS) {
    test(`"${row.sentence}" keeps ${row.tokens.join(" and ")} whole, its text unchanged`, () => {
      const tree = renderTokens(row.sentence);
      assert.deepEqual(findNodes(tree, isNoWrap).map((n) => collectText(n)), row.tokens);
      assert.equal(rawText(tree), row.sentence, "no character enters or leaves the sentence");
    });
  }

  // in a flex row with a gap each top-level part is its own flex item → the sentence must arrive as one inline box
  test("a sentence split around its day tokens renders as one inline span, so a flex parent lays it out as one item", () => {
    for (const row of ROWS) {
      const [box] = renderTokens(row.sentence).children as RenderedNode[]; // the atom's own output, under its component node
      assert.equal(box.type, "span", `"${row.sentence}" is one inline box`);
      assert.equal(box.props.className, undefined, `"${row.sentence}" wrapper adds no style of its own`);
    }
  });

  test("a sentence with no day token, or a non-string child, renders as it came", () => {
    assert.equal(findNodes(renderTokens("Spend is on track."), isNoWrap).length, 0);
    assert.equal(rawText(renderTokens("Spend is on track.")), "Spend is on track.");
    assert.equal(findNodes(renderTokens("A day-over-day change, a day ago"), isNoWrap).length, 0, "a day word with no count is no token");
    const node = h("span", { className: "x" }, "7 days");
    assert.equal(findNodes(renderTokens(node), isNoWrap).length, 0, "an element child is left to its own author");
  });

  test("the shared EmptyState lines keep their day tokens whole", () => {
    const empty = renderScreen(h(ui.EmptyState as Component, { message: "No runs in the last 7 days", hint: "Retried 2 days ago" })) as RenderedNode;
    assert.deepEqual(findNodes(empty, isNoWrap).map((n) => collectText(n)), ["7 days", "2 days"]);
  });

  // the Dashboard spend alert's title literal sat outside the atom, so its "7-day" split across lines
  test("the shared AlertCard title and body keep their day tokens whole", () => {
    const card = renderScreen(h(ui.AlertCard as Component, {
      tone: "warn",
      title: "Spend is running ahead of the 7-day average",
      body: "Today is 1.4× the 30-day mean, held for 2 days",
    })) as RenderedNode;
    const tokensIn = (className: string) => findNodes(card, (n) => String(n.props.className ?? "").split(" ").includes(className))
      .flatMap((part) => findNodes(part, isNoWrap).map((n) => collectText(n)));
    assert.deepEqual(tokensIn("alert-card-title"), ["7-day"]);
    assert.deepEqual(tokensIn("alert-card-body"), ["30-day", "2 days"]);
  });

  // a caller-composed title (the Dashboard alarm's `<>{title} <Badge/></>`) is a Fragment, not a string: the atom steps into it
  test("a Fragment child, nested too, keeps its strings' day tokens whole and its element parts as they came", () => {
    const badge = h("span", { className: "badge" }, "Last known 7 days");
    const tree = renderTokens(h(Fragment, null, "Spend is running ahead of the 7-day average",
      h(Fragment, null, " ", badge), [" over 30 days"]));
    assert.deepEqual(findNodes(tree, isNoWrap).map((n) => collectText(n)), ["7-day", "30 days"]);
    assert.equal(findNodes(tree, (n) => n.props.className === "badge").length, 1, "the element part renders as it came");
    assert.equal(rawText(tree), "Spend is running ahead of the 7-day average Last known 7 days over 30 days", "no character enters or leaves");
  });

  test("an AlertCard title composed as a Fragment with a badge keeps its day token whole", () => {
    const title = h(Fragment, null, "Spend is running ahead of the 7-day average",
      h(Fragment, null, " ", h(ui.Badge as Component, { tone: "neutral" }, "Last known")));
    const card = renderScreen(h(ui.AlertCard as Component, { tone: "warn", title, body: "Today is 1.4× the 30-day mean" })) as RenderedNode;
    const [titleNode] = findNodes(card, (n) => String(n.props.className ?? "").split(" ").includes("alert-card-title"));
    assert.deepEqual(findNodes(titleNode, isNoWrap).map((n) => collectText(n)), ["7-day"]);
    assert.match(collectText(titleNode), /Last known/, "the badge still rides the title");
  });
});
