// Body text atom: agent-written plain text → paragraphs, lists, code, bold and document links as React elements, never HTML.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PROBE_MARKUP_LINES, PROBE_PROPS, PROBE_TAGS } from "./lib/probe-markup.js";
import { collectText, createStatefulReact, findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const QUEUE_SRC = resolve(__dirname, "../public/src/screens/queue.jsx");

type Component = (props: Record<string, unknown>) => unknown;
interface ProseList {
  kind: "list";
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

// markup inside the atom's root, list keys and the per-block direction dropped — a key never reaches the DOM, and
// "each block and each table cell isolates its direction" asserts the direction on its own
function innerMarkup(text: string, linkedDocIds: number[] = []): string {
  const html = getHtml(renderProse(text, linkedDocIds)).replace(/ key="[^"]*"/g, "").replace(/ dir="auto"/g, "");
  return html.replace(/^<div class="prose-text">/, "").replace(/<\/div>$/, "");
}

const link = (id: string, digits = id) => `<a class="prose-link" href="#clauded-docs?doc=${id}">${digits}</a>`;
const code = (text: string) => `<code class="machine">${text}</code>`;
const ALIGN_CLASS: Record<string, string> = { start: "", center: ' class="prose-cell--center"', end: ' class="prose-cell--end"' };
const th = (html: string, align = "start") => `<th scope="col"${ALIGN_CLASS[align]}>${html}</th>`;
const td = (html: string, align = "start") => `<td${ALIGN_CLASS[align]}>${html}</td>`;
const table = (head: string, rows: string[]) => '<div class="prose-table-frame" tabIndex="0" role="region" aria-label="Table, scrolls sideways">' +
  `<table class="prose-table"><thead><tr>${head}</tr></thead><tbody>${rows.map((row) => `<tr>${row}</tr>`).join("")}</tbody></table></div>`;
const getTableLine = (count: number, cell: (index: number) => string) => `| ${Array.from({ length: count }, (_, index) => cell(index)).join(" | ")} |`;
const getTableText = (count: number) => `${getTableLine(count, (index) => `c${index + 1}`)}\n${getTableLine(count, () => "---")}\n| 1 |`;
const getTextContent = (node: RenderedNode | string): string => (typeof node === "string" ? node : node.children.map(getTextContent).join(""));

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

describe("a table — a header line with a delimiter line under it, then its body lines", () => {
  const rows = [
    { name: "each column takes its delimiter cell's alignment: centre, end, anything else start", ids: [],
      text: "| a | b | c |\n|---|:--:|--:|\n| 1 | 2 | 3 |",
      html: table(th("a") + th("b", "center") + th("c", "end"), [td("1") + td("2", "center") + td("3", "end")]) },
    { name: "a row with fewer cells than the header ends in empty cells", ids: [], text: "| a | b | c |\n|---|---|---|\n| 1 |",
      html: table(th("a") + th("b") + th("c"), [td("1") + td("") + td("")]) },
    { name: "a row with more cells than the header joins its extra text into its last cell", ids: [], text: "| a | b |\n|---|---|\n| 1 | 2 | 3 | 4 |",
      html: table(th("a") + th("b"), [td("1") + td("2 | 3 | 4")]) },
    { name: "a cell takes the inline rules; a bar inside a code span or escaped stays in its cell", ids: [44060],
      text: "| x | y |\n|---|---|\n| `a|b` | **c** 44060 \\| d |", html: table(th("x") + th("y"), [td(code("a|b")) + td(`<strong>c</strong> ${link("44060")} | d`)]) },
    { name: "the outer bars are optional", ids: [], text: "a | b\n--|--\n1 | 2", html: table(th("a") + th("b"), [td("1") + td("2")]) },
    { name: "a table starts under an open paragraph and ends at a line with no bar", ids: [], text: "before\n| a |\n|---|\n| 1 |\nafter",
      html: `<p>before</p>${table(th("a"), [td("1")])}<p>after</p>` },
    { name: "a blank line ends a table", ids: [], text: "| a |\n|---|\n\n| 1 |", html: `${table(th("a"), [])}<p>| 1 |</p>` },
    { name: "a header of more than 12 cells makes no table: its lines stay paragraph text, as typed", ids: [], text: getTableText(13),
      html: `<p>${getTableText(13).split("\n").join("<br></br>")}</p>` },
    { name: "a delimiter line whose cell count differs from the header's makes no table", ids: [], text: "| a | b |\n|---|",
      html: "<p>| a | b |<br></br>|---|</p>" },
    { name: "a line of dashes with no bar under a line stays a rule", ids: [], text: "a\n---", html: "<p>a</p><hr></hr>" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.equal(innerMarkup(row.text, row.ids), row.html);
    });
  }

  test("a 12-column header makes a table whose short row pads to exactly 12 cells", () => {
    const tree = renderProse(getTableText(12));
    const [bodyRow] = findNodes(findNodes(tree, (node) => node.type === "tbody")[0] ?? null, (node) => node.type === "tr");
    assert.equal(findNodes(tree, (node) => node.type === "th").length, 12);
    assert.deepEqual(bodyRow.children.map((cell) => (cell as RenderedNode).type), Array(12).fill("td"));
  });
});

describe("one container, prose classes and an isolated direction", () => {
  const ALL_KINDS = "# h\n### h5\npara\n- a\n  1. b\n> q\n---\n```\nx\n```\n| a | b |\n|:-:|--:|\n| `c` | 44060 |";
  const DIRECTED = ["p", "h4", "h5", "blockquote", "pre", "ul", "ol", "li", "th", "td"];

  test("every element the text renders takes prose classes only, the machine string aside", () => {
    const tree = renderProse(ALL_KINDS, [44060]);
    const [root] = findNodes(tree, (node) => node.type === "div");
    const words = findNodes(tree, (node) => node !== root && node.props.className !== undefined).flatMap((node) => String(node.props.className).split(" "));
    assert.ok(words.includes("prose-table"), words.join(" "));
    assert.deepEqual(words.filter((word) => !word.startsWith("prose-") && word !== "machine"), []);
  });

  test("each block and each table cell isolates its direction", () => {
    const tree = renderProse(ALL_KINDS);
    const blocks = findNodes(tree, (node) => DIRECTED.includes(node.type));
    assert.deepEqual([...new Set(blocks.map((node) => node.type))].sort(), [...DIRECTED].sort());
    assert.deepEqual(blocks.filter((node) => node.props.dir !== "auto").map((node) => node.type), []);
  });
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

function getListDepths(lists: ProseList[], depth = 1): number[] {
  return lists.flatMap((list) => [depth, ...Array.from(list.items).flatMap((item) => getListDepths(Array.from(item.lists), depth + 1))]);
}

function getRenderedListDepth(node: RenderedNode | string): number {
  if (typeof node === "string") return 0;
  const inner = Math.max(0, ...node.children.map(getRenderedListDepth));
  return inner + (node.type === "ul" || node.type === "ol" ? 1 : 0);
}

// spec §5 → A long body: one parse per change of the string and its declared ids, shared by the text and its Documents line
describe("parse once", () => {
  const text = "See clauded-docs/44106 and\n\n| a | b |\n|---|---|\n| 1 | 2 |";

  test("an equal text with an equal id list, a fresh array, returns the result already parsed", () => {
    assert.equal(getProseBlocks(text, [44106, 7]), getProseBlocks(text, [44106, 7]));
  });

  test("a changed text or id list is parsed again", () => {
    const first = getProseBlocks(text, [44106]);
    assert.deepEqual([getProseBlocks(`${text} `, [44106]) === first, getProseBlocks(text, [7]) === first], [false, false]);
  });
});

describe("output bounds", () => {
  test("list depth never exceeds three, in the block tree and in the render", () => {
    const text = Array.from({ length: 12 }, (_, level) => `${" ".repeat(level * 2)}${level % 2 ? "1." : "-"} level ${level + 1}`).join("\n");
    const lists = Array.from(getProseBlocks(text).blocks).filter((block) => block.kind === "list") as unknown as ProseList[]; // list blocks carry their items' nested lists
    assert.equal(Math.max(...getListDepths(lists)), 3);
    assert.equal(getRenderedListDepth(renderProse(text)), 3);
  });

  test("a quote holds inline nodes only, whatever block syntax its lines carry", () => {
    const lines = ["# h", "- x", "1. y", "```", "---", "> z", "| a |", "|---|"];
    const text = lines.map((line) => `> ${line}`).join("\n");
    const [quote] = findNodes(renderProse(text), (node) => node.type === "blockquote");
    assert.deepEqual(Array.from(getProseBlocks(text).blocks, (block) => block.kind), ["quote"]);
    assert.deepEqual(findNodes(quote, (node) => node !== quote && /^[a-z]/.test(node.type) && node.type !== "br").map((node) => node.type), []);
    assert.equal(getHtml(quote), `<blockquote dir="auto">${lines.join("<br></br>")}</blockquote>`);
  });

  // densest output: a 2-character body line `|\n` under a 12-column header → one row + 12 padded cells = 6.5 nodes a character
  const NODES_PER_CHAR = 7;
  const NODE_HEADROOM = 100;
  const TEXT_MAX = 20_000;
  const TABLE_HEAD = `${getTableLine(12, () => "a")}\n${getTableLine(12, () => "-")}\n`;
  const WORST_CASES = [
    { kind: "paragraph", unit: "1 " },
    { kind: "heading", unit: "# 1\n" },
    { kind: "list", unit: "- 1\n  - 1\n    - 1\n" },
    { kind: "quote", unit: ">\n" },
    { kind: "rule", unit: "---\n" },
    { kind: "code", unit: "```\n```\n" },
    { kind: "table", unit: "|\n", head: TABLE_HEAD },
  ];
  const countNodes = (node: RenderedNode | string): number =>
    typeof node === "string" ? 1 : node.children.reduce<number>((sum, child) => sum + countNodes(child), /^[a-z]/.test(node.type) ? 1 : 0);

  for (const row of WORST_CASES) {
    test(`a ${TEXT_MAX}-character worst case of a ${row.kind} renders under the linear node bound`, () => {
      const text = `${row.head ?? ""}${row.unit.repeat(TEXT_MAX)}`.slice(0, TEXT_MAX);
      const kinds = new Set(Array.from(getProseBlocks(text, [1]).blocks, (block) => block.kind));
      assert.deepEqual([...kinds], [row.kind]);
      assert.ok(countNodes(renderProse(text, [1])) <= NODES_PER_CHAR * text.length + NODE_HEADROOM);
    });
  }

  test("inline nesting stops at bold over a code span or a link", () => {
    const tree = renderProse("**a `b` 44060 **c** `**d**` clauded-docs/7** **`e` **f****", [44060]);
    const strongs = findNodes(tree, (node) => node.type === "strong");
    assert.ok(strongs.length > 0);
    assert.deepEqual(strongs.flatMap((strong) => findNodes(strong, (node) => node !== strong && node.type === "strong")), []);
    assert.deepEqual(findNodes(tree, (node) => (node.type === "code" || node.type === "a") && node.children.some((child) => typeof child !== "string")), []);
  });
});

describe("link and image syntax shows as text", () => {
  const rows = [
    { name: "a link's label stays plain text and its target shows whole after it", text: "[가이드](https://example.com/a?b=1) 참고", ids: [],
      html: "<p>가이드 (https://example.com/a?b=1) 참고</p>" },
    { name: "an image's mark is dropped and its target shown, never an image", text: "![logo](https://example.com/x.png)", ids: [],
      html: "<p>logo (https://example.com/x.png)</p>" },
    { name: "a document address in a target links its digit run alone", text: "[spec](clauded-docs/44060)", ids: [],
      html: `<p>spec (clauded-docs/${link("44060")})</p>` },
    { name: "a declared id in a label stays text", text: "[44060](a)", ids: [44060], html: "<p>44060 (a)</p>" },
    { name: "an empty label shows the target alone", text: "[](t)", ids: [], html: "<p>(t)</p>" },
    { name: "brackets with no target, or a target never closed, stay literal", text: "[a] (b) ![c](d", ids: [], html: "<p>[a] (b) ![c](d</p>" },
    { name: "link syntax inside a code span stays literal", text: "`[a](b)`", ids: [], html: `<p>${code("[a](b)")}</p>` },
    { name: "a bold run may hold link syntax", text: "**[a](b)**", ids: [], html: "<p><strong>a (b)</strong></p>" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.equal(innerMarkup(row.text, row.ids), row.html);
    });
  }
});

describe("hostile markup renders as text nodes only", () => {
  const rows = [
    { name: "an img tag with an onerror attribute", text: "<img src=x onerror=alert(1)>", shown: "<img src=x onerror=alert(1)>" },
    { name: "an anchor tag", text: '<a href="https://evil.example">setup</a>', shown: '<a href="https://evil.example">setup</a>' },
    { name: "a javascript link", text: "[click](javascript:alert(1))", shown: "click (javascript:alert(1))" },
    { name: "an image link to a web address", text: "![pixel](https://evil.example/p.png)", shown: "pixel (https://evil.example/p.png)" },
    { name: "a bare web address", text: "https://evil.example/a?b=1", shown: "https://evil.example/a?b=1" },
    { name: "an HTML entity", text: "&lt;b&gt; &amp; &#x3C;script&#x3E;", shown: "&lt;b&gt; &amp; &#x3C;script&#x3E;" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = renderProse(row.text);
      const [paragraph] = findNodes(tree, (node) => node.type === "p");
      assert.deepEqual(findNodes(tree, (node) => /^[a-z]/.test(node.type) && node.type !== "div" && node.type !== "p").map((node) => node.type), []);
      assert.equal(getTextContent(paragraph), row.shown);
    });
  }

  test("the queue page and the ui module set no HTML from a string and parse none", () => {
    for (const src of [UI_SRC, QUEUE_SRC]) {
      const source = readFileSync(src, "utf8");
      for (const sink of ["dangerouslySetInnerHTML", "innerHTML", "DOMParser"]) assert.ok(!source.includes(sink), `${src}: ${sink}`);
    }
  });
});

describe("the only link is the document route, in every element that renders text", () => {
  const LINE = "[guide](https://evil.example) ![pic](https://evil.example/p.png) [doc](clauded-docs/44060)";
  const rows = [
    { name: "a paragraph", text: LINE, element: "p", hrefs: ["#clauded-docs?doc=44060"] },
    { name: "a level-4 heading", text: `## ${LINE}`, element: "h4", hrefs: ["#clauded-docs?doc=44060"] },
    { name: "a level-5 heading", text: `### ${LINE}`, element: "h5", hrefs: ["#clauded-docs?doc=44060"] },
    { name: "a level-3 list item", text: `- a\n  - b\n    - ${LINE}`, element: "li", hrefs: ["#clauded-docs?doc=44060"] },
    { name: "a quote", text: `> ${LINE}`, element: "blockquote", hrefs: ["#clauded-docs?doc=44060"] },
    { name: "a table cell", text: `| x |\n|---|\n| ${LINE} |`, element: "td", hrefs: ["#clauded-docs?doc=44060"] },
    { name: "a fenced block", text: `\`\`\`\n${LINE}\n\`\`\``, element: "pre", hrefs: [] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = renderProse(row.text);
      const holders = findNodes(tree, (node) => node.type === row.element);
      const links = findNodes(holders.at(-1) ?? null, (node) => node.props.href !== undefined);
      assert.deepEqual(links.map((node) => node.props.href), row.hrefs);
      assert.deepEqual(links.map(getTextContent), row.hrefs.map(() => "44060"));
      assert.deepEqual(findNodes(tree, (node) => node.type === "img" || node.props.src !== undefined || node.props.srcSet !== undefined), []);
      assert.deepEqual(findNodes(tree, (node) => node.props.href !== undefined).length, row.hrefs.length);
    });
  }
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
