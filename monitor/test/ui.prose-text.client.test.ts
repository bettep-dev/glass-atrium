// Body text atom: agent-written plain text → paragraphs, lists, code, bold and document links as React elements, never HTML.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;
interface ProseResult {
  blocks: unknown[];
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
    { name: "a marker indented two or more spaces nests one level, deeper levels render at level two",
      text: "- a\n  - b\n      - c\n- d", html: "<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>" },
    { name: "an indented marker with no item above it stays at the top level", text: "  - a", html: "<ul><li>a</li></ul>" },
    { name: "numbered markers keep the author's number", text: "3. three\n7) seven", html: '<ol><li value="3">three</li><li value="7">seven</li></ol>' },
    { name: "a switch between bullets and numbers starts a new list", text: "- a\n1. b", html: '<ul><li>a</li></ul><ol><li value="1">b</li></ol>' },
    { name: "an indented non-marker line after an item continues that item", text: "- first\n  more", html: "<ul><li>first<br></br>more</li></ul>" },
    { name: "an unindented non-marker line after an item ends the list", text: "- a\nb", html: "<ul><li>a</li></ul><p>b</p>" },
    { name: "a heading marker gives one paragraph in weight 600, never a larger size", text: "## 요약\n본문", html: "<p><strong>요약</strong></p><p>본문</p>" },
    { name: "a seven-hash line is not a heading", text: "####### x", html: "<p>####### x</p>" },
    { name: "a code span renders as a machine string", text: "run `npm test` now", html: `<p>run ${code("npm test")} now</p>` },
    { name: "a double-star run renders in weight 600", text: "**중요** 확인", html: "<p><strong>중요</strong> 확인</p>" },
    { name: "a fenced block is preformatted and its content literal, the info string dropped",
      text: "```ts\nconst a = 1;\n\n**b** 44060\n```\nafter", html: '<pre class="prose-pre">const a = 1;\n\n**b** 44060</pre><p>after</p>' },
    { name: "a fence with no closing line runs to the end of the text", text: "x\n```\n- y\n**z**", html: '<p>x</p><pre class="prose-pre">- y\n**z**</pre>' },
    { name: "a web address, a table, a quote mark and HTML tags stay literal",
      text: "https://example.com/a?b=1\n| a | b |\n> quote\n<img src=x onerror=alert(1)>",
      html: "<p>https://example.com/a?b=1<br></br>| a | b |<br></br>> quote<br></br>&lt;img src=x onerror=alert(1)></p>" },
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
