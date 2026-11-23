// Body text atom: agent-written plain text → paragraphs, lists, code, bold and document links as React elements, never HTML.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PROBE_MARKUP_LINES, PROBE_PROPS, PROBE_TAGS } from "./lib/probe-markup.js";
import { collectText, createStatefulReact, findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;
interface ProseList {
  kind: "list";
  depth: number;
  items: Array<{ lists: ProseList[] }>;
}
interface ProseResult {
  blocks: Array<{ kind: string; lineCount?: number }>;
  linkedIds: number[];
}

const ui = await loadScreenModule(UI_SRC);
const UI = ui.UI as Record<string, unknown>;
const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };
const getProseBlocks = UI.getProseBlocks as (text: string, linkedDocIds?: number[]) => ProseResult;

function renderProse(text: string, linkedDocIds: number[] = [], isCompact = false): RenderedNode {
  return renderScreen(React.createElement(UI.ProseText as Component, { text, linkedDocIds, isCompact })) as RenderedNode;
}

// markup inside the atom's root, list keys dropped — a key never reaches the DOM
function innerMarkup(text: string, linkedDocIds: number[] = []): string {
  const html = getHtml(renderProse(text, linkedDocIds)).replace(/ key="[^"]*"/g, "");
  return html.replace(/^<div class="prose-text">/, "").replace(/<\/div>$/, "");
}

const link = (id: string, digits = id) => `<a class="prose-link" href="#clauded-docs?doc=${id}">${digits}</a>`;
const code = (text: string) => `<code class="machine">${text}</code>`;

describe("source text → rendered blocks", () => {
  const rows = [
    { name: "consecutive lines stay one paragraph, broken by line breaks", text: "첫 줄\n둘째 줄", html: "<p>첫 줄<br></br>둘째 줄</p>" },
    { name: "a blank line, or several, starts a new block", text: "a\n\n\nb", html: "<p>a</p><p>b</p>" },
    { name: "a CRLF text breaks lines like an LF text", text: "a\r\nb\r\n\r\nc", html: "<p>a<br></br>b</p><p>c</p>" },
    { name: "dash, star and bullet markers make one unordered list", text: "- one\n* two\n• three", html: "<ul><li>one</li><li>two</li><li>three</li></ul>" },
    { name: "an item indented further than the item above nests under it, to three levels; a deeper indent stays at level three",
      text: "- a\n  - b\n    - c\n          - d\n- e", html: "<ul><li>a<ul><li>b<ul><li>c</li><li>d</li></ul></li></ul></li><li>e</li></ul>" },
    { name: "a shallower item returns to the level its indent matches", text: "- a\n  - b\n    - c\n  - d",
      html: "<ul><li>a<ul><li>b<ul><li>c</li></ul></li><li>d</li></ul></li></ul>" },
    { name: "a switch between bullets and numbers inside a nested level starts a sibling list under the same item",
      text: "- a\n  - b\n  1. c", html: '<ul><li>a<ul><li>b</li></ul><ol><li value="1">c</li></ol></li></ul>' },
    { name: "an indented marker with no item above it stays at the top level", text: "  - a", html: "<ul><li>a</li></ul>" },
    { name: "numbered markers keep the author's number", text: "3. three\n7) seven", html: '<ol><li value="3">three</li><li value="7">seven</li></ol>' },
    { name: "a switch between bullets and numbers starts a new list", text: "- a\n1. b", html: '<ul><li>a</li></ul><ol><li value="1">b</li></ol>' },
    { name: "an indented non-marker line after an item continues that item", text: "- first\n  more", html: "<ul><li>first<br></br>more</li></ul>" },
    { name: "an unindented non-marker line after an item ends the list", text: "- a\nb", html: "<ul><li>a</li></ul><p>b</p>" },
    { name: "one or two hashes make a level-4 heading, three to six a level-5 heading",
      text: "# 제목\n## 요약\n### 세부\n###### 끝\n본문", html: "<h4>제목</h4><h4>요약</h4><h5>세부</h5><h5>끝</h5><p>본문</p>" },
    { name: "a heading takes the inline rules", text: "## **x** `y`", html: `<h4><strong>x</strong> ${code("y")}</h4>` },
    { name: "a seven-hash line is not a heading", text: "####### x", html: "<p>####### x</p>" },
    { name: "a code span renders as a machine string", text: "run `npm test` now", html: `<p>run ${code("npm test")} now</p>` },
    { name: "a double-star run renders in weight 600", text: "**중요** 확인", html: "<p><strong>중요</strong> 확인</p>" },
    { name: "a fenced block is preformatted and its content literal, the info string dropped",
      text: "```ts\nconst a = 1;\n\n**b** 44060\n```\nafter", html: '<pre class="prose-pre">const a = 1;\n\n**b** 44060</pre><p>after</p>' },
    { name: "a fence with no closing line runs to the end of the text", text: "x\n```\n- y\n**z**", html: '<p>x</p><pre class="prose-pre">- y\n**z**</pre>' },
    { name: "a web address, a table line with no delimiter line and HTML tags stay literal",
      text: "https://example.com/a?b=1\n| a | b |\n<img src=x onerror=alert(1)>",
      html: "<p>https://example.com/a?b=1<br></br>| a | b |<br></br>&lt;img src=x onerror=alert(1)></p>" },
    { name: "quote lines make one quote, their markers dropped and the inline rules applied", text: "> 첫 줄\n> **둘째**\n뒤",
      html: "<blockquote>첫 줄<br></br><strong>둘째</strong></blockquote><p>뒤</p>" },
    { name: "a bare quote mark keeps the quote open as an empty line", text: "> a\n>\n> b", html: "<blockquote>a<br></br><br></br>b</blockquote>" },
    { name: "a quote mark not at the line's start stays text", text: "a > b\n>c", html: "<p>a > b<br></br>>c</p>" },
    { name: "three dashes, stars or underscores alone on a line make a rule", text: "a\n---\nb\n ***\n___", html: "<p>a</p><hr></hr><p>b</p><hr></hr><hr></hr>" },
    { name: "a rule line inside a fence stays literal", text: "```\n---\n```", html: '<pre class="prose-pre">---</pre>' },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.equal(innerMarkup(row.text), row.html);
    });
  }
});

describe("document references", () => {
  const rows = [
    { name: "a declared id links, and a Hangul particle may follow it", text: "모니터 44060을 보세요", ids: [44060], html: `<p>모니터 ${link("44060")}을 보세요</p>` },
    { name: "a hash before a declared id leaves the digits linked", text: "#44060", ids: [44060], html: `<p>#${link("44060")}</p>` },
    { name: "a declared id touching a digit or a Latin letter stays text", text: "440601 v44060 44060b 144060", ids: [44060], html: "<p>440601 v44060 44060b 144060</p>" },
    { name: "an undeclared number stays text", text: "see 44060", ids: [], html: "<p>see 44060</p>" },
    { name: "the addressed forms link without a declaration, the id re-serialized as an integer",
      text: "clauded-docs/120 · clauded-docs?doc=007", ids: [], html: `<p>clauded-docs/${link("120")} · clauded-docs?doc=${link("7", "007")}</p>` },
    { name: "an addressed form after a Latin letter, with ten digits or a digit after stays text",
      text: "xclauded-docs/12 clauded-docs/1234567890", ids: [], html: "<p>xclauded-docs/12 clauded-docs/1234567890</p>" },
    { name: "a keyword followed by a number stays text", text: "monitor 16145 · 문서 120건", ids: [], html: "<p>monitor 16145 · 문서 120건</p>" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.equal(innerMarkup(row.text, row.ids), row.html);
    });
  }
});

describe("inline precedence", () => {
  const rows = [
    { name: "a code span is opaque: no bold and no link inside it", text: "`**44060** clauded-docs/9`", ids: [44060], html: `<p>${code("**44060** clauded-docs/9")}</p>` },
    { name: "a bold run may hold code spans and links", text: "**see `x` and 44060**", ids: [44060], html: `<p><strong>see ${code("x")} and ${link("44060")}</strong></p>` },
    { name: "a double star with no partner is literal text", text: "**open 44060", ids: [44060], html: `<p>**open ${link("44060")}</p>` },
    { name: "a single unmatched backtick is literal text", text: "a ` b **c**", ids: [], html: "<p>a ` b <strong>c</strong></p>" },
    { name: "a bold run never crosses a line break", text: "**a\nb**", ids: [], html: "<p>**a<br></br>b**</p>" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.equal(innerMarkup(row.text, row.ids), row.html);
    });
  }
});

const getFenceText = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
const getFence = (count: number) => `\`\`\`\n${getFenceText(count)}\n\`\`\``;

function renderFence(count: number, canFoldCode: boolean, module = UI, react = React): RenderedNode {
  return renderScreen(react.createElement(module.ProseText as Component, { text: getFence(count), canFoldCode })) as RenderedNode;
}

describe("a long fenced block folds only where the caller turns the fold on", () => {
  const rows = [
    { name: "with the fold off, a fence over 20 lines shows every line and no disclosure", count: 21, canFoldCode: false, shown: 21, labels: [] },
    { name: "with the fold on, a fence of 20 lines shows whole with no disclosure", count: 20, canFoldCode: true, shown: 20, labels: [] },
    { name: "with the fold on, a fence over 20 lines shows its first 20 under a disclosure naming every line",
      count: 84, canFoldCode: true, shown: 20, labels: ["Show all 84 lines"] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = renderFence(row.count, row.canFoldCode);
      const [pre] = findNodes(tree, (node) => node.type === "pre");
      const labels = findNodes(tree, (node) => node.type === "summary").map((node) => collectText(node).trim());
      assert.equal(collectText(pre), getFenceText(row.shown));
      assert.deepEqual(labels, row.labels);
    });
  }

  test("opening the disclosure shows every line of the fence", async () => {
    const { react, resetCursor } = createStatefulReact();
    const stateful = await loadScreenModule(UI_SRC, { React: react });
    const render = () => {
      resetCursor();
      return renderFence(21, true, stateful.UI as Record<string, unknown>, react as typeof React);
    };
    const [details] = findNodes(render(), (node) => node.type === "details");
    (details.props.onToggle as (event: unknown) => void)({ currentTarget: { open: true } });
    const [pre] = findNodes(render(), (node) => node.type === "pre");
    assert.equal(collectText(pre), getFenceText(21));
  });

  test("the parser counts a fence's lines, an empty fence as none", () => {
    assert.deepEqual(Array.from(getProseBlocks(`${getFence(21)}\n\`\`\`\n\`\`\``).blocks, (block) => block.lineCount), [21, 0]);
  });
});

function getListDepths(lists: ProseList[], depth = 1): Array<{ field: number; nesting: number }> {
  return lists.flatMap((list) => [{ field: list.depth, nesting: depth }, ...Array.from(list.items).flatMap((item) => getListDepths(Array.from(item.lists), depth + 1))]);
}

function getRenderedListDepth(node: RenderedNode | string): number {
  if (typeof node === "string") return 0;
  const inner = Math.max(0, ...node.children.map(getRenderedListDepth));
  return inner + (node.type === "ul" || node.type === "ol" ? 1 : 0);
}

describe("output bounds", () => {
  test("list depth never exceeds three, in the block tree and in the render", () => {
    const text = Array.from({ length: 12 }, (_, level) => `${" ".repeat(level * 2)}${level % 2 ? "1." : "-"} level ${level + 1}`).join("\n");
    const lists = Array.from(getProseBlocks(text).blocks).filter((block) => block.kind === "list") as unknown as ProseList[]; // list blocks carry depth and items
    const depths = getListDepths(lists);
    assert.deepEqual(depths.filter((depth) => depth.field !== depth.nesting), []);
    assert.equal(Math.max(...depths.map((depth) => depth.nesting)), 3);
    assert.equal(getRenderedListDepth(renderProse(text)), 3);
  });

  test("a quote holds inline nodes only, whatever block syntax its lines carry", () => {
    const lines = ["# h", "- x", "1. y", "```", "---", "> z", "| a |"];
    const text = lines.map((line) => `> ${line}`).join("\n");
    const [quote] = findNodes(renderProse(text), (node) => node.type === "blockquote");
    assert.deepEqual(Array.from(getProseBlocks(text).blocks, (block) => block.kind), ["quote"]);
    assert.deepEqual(findNodes(quote, (node) => node !== quote && /^[a-z]/.test(node.type) && node.type !== "br").map((node) => node.type), []);
    assert.equal(getHtml(quote), `<blockquote>${lines.join("<br></br>")}</blockquote>`);
  });

  test("inline nesting stops at bold over a code span or a link", () => {
    const tree = renderProse("**a `b` 44060 **c** `**d**` clauded-docs/7** **`e` **f****", [44060]);
    const strongs = findNodes(tree, (node) => node.type === "strong");
    assert.ok(strongs.length > 0);
    assert.deepEqual(strongs.flatMap((strong) => findNodes(strong, (node) => node !== strong && node.type === "strong")), []);
    assert.deepEqual(findNodes(tree, (node) => (node.type === "code" || node.type === "a") && node.children.some((child) => typeof child !== "string")), []);
  });
});

test("the parser returns exactly the declared ids its text turned into links, once each, in either form", () => {
  const text = "44060 then clauded-docs/44071, again 44060, `44072` in code, 44073 undeclared";
  assert.deepEqual(getProseBlocks(text, [44060, 44071, 44072, 44074]).linkedIds, [44060, 44071]);
});

test("no part of hostile text reaches an href or an HTML sink — the one href is the document route and an integer", () => {
  const text = [
    'clauded-docs/1"><script>alert(1)</script>',
    "javascript:alert(1) [x](javascript:alert(1)) <a href=\"https://evil.example\">44060</a>",
    "clauded-docs?doc=12&x=<b>y</b> clauded-docs/000000009",
  ].join("\n");
  const tree = renderProse(text, [44060]);
  const hrefs = findNodes(tree, (node) => node.props.href !== undefined).map((node) => node.props.href);
  const htmlSinks = findNodes(tree, (node) => node.props.dangerouslySetInnerHTML !== undefined);
  assert.deepEqual(hrefs, ["#clauded-docs?doc=1", "#clauded-docs?doc=44060", "#clauded-docs?doc=12", "#clauded-docs?doc=9"]);
  assert.equal(htmlSinks.length, 0);
});

test("markup in the text shows as its literal tags and words, never as a control, a request attribute or a style element", () => {
  const tree = renderProse(PROBE_MARKUP_LINES.join("\n"));
  const reached = findNodes(tree, (node) => PROBE_TAGS.has(node.type) || PROBE_PROPS.some((prop) => node.props[prop] !== undefined));
  const text = collectText(tree);

  assert.deepEqual(reached.map((node) => node.type), []);
  for (const line of PROBE_MARKUP_LINES) assert.ok(text.includes(line), line);
});

test("the root carries the prose class and its compact modifier, never the fs-body class whose later line height would win", () => {
  for (const isCompact of [false, true]) {
    const [root] = findNodes(renderProse("a", [], isCompact), (node) => node.type === "div");
    const classes = String(root.props.className).split(" ");
    assert.ok(classes.includes("prose-text"), classes.join(" "));
    assert.equal(classes.includes("prose-text--compact"), isCompact);
    assert.ok(!classes.includes("fs-body"), classes.join(" "));
  }
});

test("an empty or missing text renders an empty atom, never a stray paragraph", () => {
  for (const text of ["", "\n\n", undefined]) {
    assert.equal(innerMarkup(text as string), "", JSON.stringify(text));
  }
});
