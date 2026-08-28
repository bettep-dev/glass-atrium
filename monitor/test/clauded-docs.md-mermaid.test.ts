// A ```mermaid fence in a MARKDOWN document has to end up as a drawn diagram, on
// both surfaces that show one — the viewer and the export.
// Runner: npx tsx --test test/clauded-docs.md-mermaid.test.ts
//
// This path had no test at all, which is why it shipped broken: every existing
// mermaid test feeds an `html` body whose stored markup ALREADY carries
// `pre.mermaid`, so the conversion step that only the md path performs was never
// executed by anything. A document rendered its fence as a code block while the
// whole diagram suite stayed green.
//
// So the md conversion is driven through the REAL function rather than a
// re-implementation of it: injectMdTypographyClassesCD is lifted out of
// clauded-docs.jsx by source slice and evaluated (the technique the sibling
// diagram-container test uses on that file's inline <style>). A copy here would
// pass while the shipped viewer failed — the exact failure being tested for.
//
// Browser: playwright chromium, mermaid + the vendored ELK loader read from disk.
// No network, and no database: renderSelfContainedHtml takes a body, not an id.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { marked } from "marked";
import { chromium, type Browser } from "playwright";

import {
  countMdMermaidFences,
  MD_DIAGRAM_DEGRADED_COMMENT,
  renderSelfContainedHtml,
  wrapPlainInHtmlShell,
} from "../src/server/clauded-docs/html-export.js";
import { resetBrowserForTests } from "../src/server/clauded-docs/browser-pool.js";
import {
  findMdMermaidFences,
  MERMAID_NODE_SELECTOR,
  MERMAID_RENDERED_SVG_SELECTOR,
} from "../src/server/clauded-docs/mermaid-selector.js";
import { evaluateMermaidConfig } from "./lib/mermaid-config-source.js";
import { assertFallbackWarningVisible, createFallbackWatch } from "./lib/mermaid-elk-probe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_ROOT = resolve(HERE, "..");
const VIEWER_SCREEN_PATH = resolve(MONITOR_ROOT, "public/src/screens/clauded-docs.jsx");
const VENDOR_ELK_PATH = resolve(MONITOR_ROOT, "public/assets/vendor/mermaid-layout-elk-0.2.3.min.js");
const DOMPURIFY_BUNDLE_PATH = resolve(MONITOR_ROOT, "node_modules/dompurify/dist/purify.min.js");

/** Server modules that read the diagram-node contract — none may re-declare it. */
const SELECTOR_CONSUMERS = [
  "src/server/clauded-docs/html-export.ts",
  "src/server/clauded-docs/html-validator.ts",
] as const;

// One diagram, one code fence in another language, prose either side. The second
// fence is the branch's boundary: `mermaid` converts, `ts` must stay a code block.
const MD_BODY = [
  "# Delegation gate",
  "",
  "Intro paragraph before the diagram.",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Delegation scope declared] --> B{Reviewer verdict}",
  "  B --> C[Implementation entry]",
  "```",
  "",
  "Tail paragraph after the diagram.",
  "",
  "```ts",
  "const untouched = 1;",
  "```",
  "",
].join("\n");

const MD_BODY_NO_DIAGRAM = "# Plain document\n\nNothing to draw here.\n";

/**
 * The viewer's own md→html class injector, lifted from the source file.
 *
 * Sliced on the column-0 closing brace: every brace inside the function is
 * indented, so the first `\n}` after the declaration is its end. A miss fails
 * loudly here rather than silently returning a truncated function.
 */
function loadInjectMdTypographyClasses(): (html: string) => string {
  const jsx = readFileSync(VIEWER_SCREEN_PATH, "utf8");
  const name = "injectMdTypographyClassesCD";
  const open = jsx.indexOf(`function ${name}(html) {`);
  assert.notEqual(open, -1, `${name} not found in clauded-docs.jsx`);
  const close = jsx.indexOf("\n}\n", open);
  assert.notEqual(close, -1, `${name} has no column-0 closing brace`);
  const source = jsx.slice(open, close + 2);
  return new Function(`${source}\nreturn ${name};`)() as (html: string) => string;
}

/**
 * The viewer's own DOMPurify config, lifted from the source file.
 *
 * Same slice technique and same reason as the injector above: a copy of the
 * config here would let the test pass while the shipped sanitizer stripped the
 * container. Sliced on the column-0 `};`.
 */
function loadDompurifyConfig(): Record<string, unknown> {
  const jsx = readFileSync(VIEWER_SCREEN_PATH, "utf8");
  const open = jsx.indexOf("const DOMPURIFY_CONFIG_CD = {");
  assert.notEqual(open, -1, "DOMPURIFY_CONFIG_CD not found in clauded-docs.jsx");
  const close = jsx.indexOf("\n};\n", open);
  assert.notEqual(close, -1, "DOMPURIFY_CONFIG_CD has no column-0 closing brace");
  const source = jsx.slice(open, close + 3);
  return new Function(`${source}\nreturn DOMPURIFY_CONFIG_CD;`)() as Record<string, unknown>;
}

let injectorCache: ((html: string) => string) | null = null;

/** The shipped injector, loaded once — the parity table calls it per row. */
function viewerInjector(): (html: string) => string {
  if (injectorCache === null) injectorCache = loadInjectMdTypographyClasses();
  return injectorCache;
}

/**
 * What the VIEWER draws for a body — marked's own answer, run through the shipped
 * injector. This is the oracle the server grammar is measured against.
 */
function clientDiagramCount(body: string): number {
  const rawHtml = marked.parse(body, { gfm: true, breaks: false }) as string;
  const converted = viewerInjector()(rawHtml);
  return (converted.match(/class="mermaid doc-diagram-body"/g) ?? []).length;
}

/** What the EXPORT draws for the same body — the server's re-implemented grammar. */
function serverDiagramCount(body: string): number {
  const routed = countMdMermaidFences(body);
  // The route and the splice have to be one answer, or the export sends a body to
  // chromium and then hands it nothing to draw — the shape that produced a 503.
  assert.equal(
    routed,
    findMdMermaidFences(body).length,
    "the export's routing count and its fence list disagree",
  );
  return routed;
}

/** Runs the md body through marked exactly as renderMarkdownCD does, then the real injector. */
function convertMdBody(body: string): string {
  const rawHtml = marked.parse(body, { gfm: true, breaks: false }) as string;
  // The contract the conversion branch is written against. The shipped viewer loads
  // marked@13 from a CDN and this process resolves the installed copy, so pinning the
  // shape here is what makes the version gap visible: a marked whose fence output stopped
  // being `<pre><code class="language-xxx">` fails on this line, naming the cause, instead
  // of surfacing later as a mystery zero-node render.
  assert.match(rawHtml, /<pre><code class="language-mermaid">/);
  return viewerInjector()(rawHtml);
}

interface ViewerRender {
  containerCount: number;
  svgCount: number;
  renderError: string | null;
  fallbackWarnings: string[];
}

let browser: Browser;
let mermaidBundle: string;
let vendorElkBundle: string;
let dompurifyBundle: string;

before(async () => {
  browser = await chromium.launch({ headless: true });
  const pkgPath = fileURLToPath(import.meta.resolve("mermaid/package.json"));
  mermaidBundle = await readFile(resolve(dirname(pkgPath), "dist", "mermaid.min.js"), "utf8");
  vendorElkBundle = await readFile(VENDOR_ELK_PATH, "utf8");
  dompurifyBundle = await readFile(DOMPURIFY_BUNDLE_PATH, "utf8");
});

after(async () => {
  await browser.close();
  await resetBrowserForTests();
});

/**
 * Mounts converted md in the viewer's body container and runs ViewerBodyCD's own
 * render loop over it.
 *
 * Sources come from each node's textContent, exactly as the effect reads them — that
 * is the half of the fix a shape-only assertion cannot reach. marked escapes the fence
 * body (`--&gt;`), and the source is only recoverable because the browser decodes those
 * entities on parse; a conversion that decoded them early would re-parse as markup and
 * arrive here as a broken diagram.
 */
async function renderInViewer(convertedHtml: string): Promise<ViewerRender> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  // Attached before the first render — the fallback warning is emitted mid-render.
  const fallback = createFallbackWatch(page);
  await page.route("**/*", (route) => route.abort());
  try {
    await page.setContent(
      '<!doctype html><html lang="ko"><head><meta charset="utf-8"></head>' +
        `<body><div class="doc-body-isolation">${convertedHtml}</div></body></html>`,
      { waitUntil: "domcontentloaded" },
    );
    await page.addScriptTag({ content: mermaidBundle });
    await page.addScriptTag({ content: vendorElkBundle });
    // Precondition for the zero-warning claim below — above WARN mermaid silences its
    // own fallback log, and an empty warning list would then prove nothing.
    await page.evaluate((config) => {
      const g = globalThis as unknown as {
        mermaid: { registerLayoutLoaders: (l: unknown) => void; initialize: (c: unknown) => void };
        mermaidLayoutElk?: { default?: unknown };
      };
      g.mermaid.registerLayoutLoaders(g.mermaidLayoutElk?.default ?? []);
      g.mermaid.initialize(config);
    }, evaluateMermaidConfig());
    await assertFallbackWarningVisible(page);

    const renderError = await page.evaluate(async (selector) => {
      const g = globalThis as unknown as {
        mermaid: { render: (id: string, src: string) => Promise<{ svg: string }> };
        document: {
          querySelectorAll: (sel: string) => ArrayLike<{ innerHTML: string; textContent: string }>;
        };
      };
      const nodes = Array.from(g.document.querySelectorAll(selector));
      try {
        for (let i = 0; i < nodes.length; i += 1) {
          const { svg } = await g.mermaid.render(`cd-md-mermaid-${i}`, nodes[i].textContent);
          nodes[i].innerHTML = svg;
        }
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "mermaid render threw";
      }
    }, MERMAID_NODE_SELECTOR);

    const counts = await page.evaluate((selectors) => {
      const g = globalThis as unknown as {
        document: { querySelectorAll: (sel: string) => ArrayLike<unknown> };
      };
      return {
        containerCount: g.document.querySelectorAll(selectors.node).length,
        svgCount: g.document.querySelectorAll(selectors.svg).length,
      };
    }, { node: MERMAID_NODE_SELECTOR, svg: MERMAID_RENDERED_SVG_SELECTOR });

    return { ...counts, renderError, fallbackWarnings: [...fallback.messages] };
  } finally {
    await page.close();
    await context.close();
  }
}

test("the viewer's selector copy matches the server constant byte for byte", () => {
  const jsx = readFileSync(VIEWER_SCREEN_PATH, "utf8");
  const declaration = /const MERMAID_NODE_SELECTOR_CD = "([^"]*)";/.exec(jsx);
  assert.notEqual(declaration, null, "clauded-docs.jsx declares no MERMAID_NODE_SELECTOR_CD");
  assert.equal(
    (declaration as RegExpExecArray)[1],
    MERMAID_NODE_SELECTOR,
    "the viewer's selector copy has drifted from mermaid-selector.ts — a document would " +
      "then validate, export and still show a code block, with nothing red anywhere",
  );
});

test("no module re-declares the diagram-node selector literal", () => {
  const literal = `"${MERMAID_NODE_SELECTOR}"`;
  for (const relative of SELECTOR_CONSUMERS) {
    const source = readFileSync(resolve(MONITOR_ROOT, relative), "utf8");
    assert.equal(
      source.includes(literal),
      false,
      `${relative} carries its own copy of the selector instead of importing it`,
    );
  }
  const jsx = readFileSync(VIEWER_SCREEN_PATH, "utf8");
  assert.equal(
    (jsx.match(new RegExp(literal, "g")) ?? []).length,
    1,
    "clauded-docs.jsx should hold the selector literal once — in its SYNC-pinned constant",
  );
});

test("an md mermaid fence becomes a diagram container, not a code block", () => {
  const converted = convertMdBody(MD_BODY);

  assert.equal(
    (converted.match(/class="mermaid doc-diagram-body"/g) ?? []).length,
    1,
    "the fence did not become a diagram container",
  );
  assert.equal(
    converted.includes("language-mermaid"),
    false,
    "the fence is still a code block — the render effect will find nothing to draw",
  );
  // Boundary: the branch converts mermaid fences and nothing else.
  assert.match(converted, /language-ts/);
  // The source survives as text, still escaped — the browser decodes it on parse.
  assert.match(converted, /A\[Delegation scope declared\] --&gt; B\{Reviewer verdict\}/);
});

test("the converted md body renders one diagram with no layout fallback", async () => {
  const result = await renderInViewer(convertMdBody(MD_BODY));

  assert.equal(result.renderError, null, `mermaid render failed: ${String(result.renderError)}`);
  assert.equal(result.containerCount, 1, "expected exactly one diagram container");
  assert.equal(result.svgCount, 1, "the diagram container holds no rendered <svg>");
  assert.deepEqual(result.fallbackWarnings, [], "mermaid fell back to an unregistered layout");
});

test("exporting an md document draws its fence and still ships zero scripts", async () => {
  const html = await renderSelfContainedHtml(MD_BODY, "md");

  assert.ok((html.match(/<svg/g) ?? []).length >= 1, "the export carries no rendered <svg>");
  assert.equal(html.includes("```mermaid"), false, "the fence shipped as literal text");
  assert.equal(/<script/i.test(html), false, "the export must stay script-free");
});

test("a fence-free md export stays on the plain shell path", async () => {
  const html = await renderSelfContainedHtml(MD_BODY_NO_DIAGRAM, "md");

  assert.match(html, /<main># Plain document/);
  assert.equal(/<svg/.test(html), false, "a body with no diagram must not reach the renderer");
  assert.equal(/<script/i.test(html), false);
});

// ---------------------------------------------------------------------------
// Recognizer parity — the guard the previous round of this fix did not have.
//
// The viewer asks marked what a mermaid fence is; the export cannot (marked is
// not a monitor dependency — see the note above findMdMermaidFences) and carries
// its own grammar. Two answers to one question is the exact shape that ships a
// document which validates, exports and then shows a code block. So the two are
// run over ONE table here, and a disagreement is red.
//
// The asymmetry is deliberate and asserted: the export may draw FEWER diagrams
// than the viewer (the fence ships as text, which is what it always did), and
// may NEVER draw more — an over-eager server feeds non-diagram text to mermaid,
// which is how a body that exported 200 started returning 503.
// ---------------------------------------------------------------------------

interface FenceCase {
  name: string;
  body: string;
  /** Diagrams the viewer draws. Measured live from marked — the declaration pins it. */
  client: number;
  /** Diagrams the export draws. Below `client` only where the gap is documented. */
  server: number;
  gap?: string;
}

const FENCE_CASES: readonly FenceCase[] = [
  { name: "plain ```mermaid", body: "# t\n\n```mermaid\ngraph TD\nA-->B\n```\n", client: 1, server: 1 },
  { name: "~~~mermaid tilde fence", body: "# t\n\n~~~mermaid\ngraph TD\nA-->B\n~~~\n", client: 1, server: 1 },
  { name: "four-backtick fence", body: "# t\n\n````mermaid\ngraph TD\nA-->B\n````\n", client: 1, server: 1 },
  {
    name: "info string with a suffix",
    body: '# t\n\n```mermaid title="x"\ngraph TD\nA-->B\n```\n',
    client: 1,
    server: 1,
  },
  {
    name: "blockquote-nested fence",
    body: "# t\n\n> ```mermaid\n> graph TD\n> A-->B\n> ```\n",
    client: 1,
    server: 1,
  },
  {
    name: "two-space list item",
    body: "# t\n\n- item\n\n  ```mermaid\n  graph TD\n  A-->B\n  ```\n",
    client: 1,
    server: 1,
  },
  {
    name: "ordered list item at four spaces",
    body: "1. item\n\n    ```mermaid\n    graph TD\n    A-->B\n    ```\n",
    client: 1,
    server: 1,
  },
  { name: "unclosed fence", body: "# t\n\n```mermaid\ngraph TD\nA-->B\n", client: 1, server: 1 },
  { name: "CRLF body", body: "# t\r\n\r\n```mermaid\r\ngraph TD\r\n```\r\n", client: 1, server: 1 },
  { name: "trailing spaces on both fences", body: "# t\n\n```mermaid   \ngraph TD\n```   \n", client: 1, server: 1 },
  { name: "three-space indent", body: "# t\n\n   ```mermaid\n   graph TD\n   ```\n", client: 1, server: 1 },
  // The two that MUST be zero. A regression on either is the 503.
  {
    name: "fence shown inside an outer fence",
    body: "# How to draw\n\n`````\n```mermaid\nnot a real diagram\n```\n`````\n",
    client: 0,
    server: 0,
  },
  {
    name: "fence inside a four-space indented block",
    body: "# t\n\n    ```mermaid\n    not a real diagram\n    ```\n",
    client: 0,
    server: 0,
  },
  // Case-sensitivity: marked emits `language-MERMAID`, which the viewer's
  // container replacement does not match — so neither surface draws it.
  { name: "uppercase MERMAID info", body: "# t\n\n```MERMAID\ngraph TD\n```\n", client: 0, server: 0 },
  {
    name: "a language that merely starts with mermaid",
    body: "# t\n\n```mermaidjs\ngraph TD\n```\n",
    client: 0,
    server: 0,
  },
];

test("the export's fence grammar agrees with the viewer's parser", () => {
  for (const testCase of FENCE_CASES) {
    const client = clientDiagramCount(testCase.body);
    const server = serverDiagramCount(testCase.body);

    assert.equal(client, testCase.client, `${testCase.name}: marked's answer changed`);
    assert.equal(server, testCase.server, `${testCase.name}: the export's grammar disagrees`);
    // The invariant that outranks every individual row: a false positive feeds
    // non-diagram text to the renderer, a false negative only ships text.
    assert.ok(
      server <= client,
      `${testCase.name}: the export claims ${server} diagram(s) where the viewer draws ` +
        `${client} — an over-eager grammar is what turns a 200 into a 503`,
    );
    if (server < client) assert.ok(testCase.gap, `${testCase.name}: undocumented gap`);
  }
});

test("a fence the viewer only displays never reaches the renderer", () => {
  // The reviewer's reproduction: a document ABOUT mermaid, whose inner fence is
  // literal text inside an outer one. The previous grammar counted it as a diagram.
  const shown = "# How to draw\n\n`````\n```mermaid\nnot a real diagram\n```\n`````\n";

  assert.equal(countMdMermaidFences(shown), 0, "a displayed fence was read as a diagram");
  const shell = wrapPlainInHtmlShell(shown, "md");
  assert.equal(shell.includes('class="mermaid'), false, "a displayed fence became a container");
  assert.match(shell, /```mermaid/, "the fence must survive as the literal text it is");
});

test("a fence in a four-space indented block never reaches the renderer", () => {
  const indented = "# t\n\n    ```mermaid\n    not a real diagram\n    ```\n";

  assert.equal(countMdMermaidFences(indented), 0, "an indented code block was read as a diagram");
  assert.equal(wrapPlainInHtmlShell(indented, "md").includes('class="mermaid'), false);
});

test("the fence spellings the viewer draws all become containers", () => {
  const spellings: ReadonlyArray<[string, string]> = [
    ["tilde", "~~~mermaid\ngraph TD\nA-->B\n~~~\n"],
    ["four backticks", "````mermaid\ngraph TD\nA-->B\n````\n"],
    ["info suffix", '```mermaid title="x"\ngraph TD\nA-->B\n```\n'],
    ["blockquote", "> ```mermaid\n> graph TD\n> A-->B\n> ```\n"],
  ];

  for (const [name, body] of spellings) {
    const shell = wrapPlainInHtmlShell(body, "md");
    assert.equal(
      (shell.match(/class="mermaid doc-diagram-body"/g) ?? []).length,
      1,
      `${name}: the viewer draws this fence and the export shipped it as text`,
    );
    // The blockquote source arrives without its `> ` markers, or mermaid cannot parse it.
    assert.match(shell, /graph TD/);
    assert.equal(shell.includes("&gt; graph"), false, `${name}: quote markers leaked into the source`);
  }
});

test("a tilde fence exports as a drawn diagram", async () => {
  const html = await renderSelfContainedHtml("# t\n\n~~~mermaid\nflowchart LR\n  A --> B\n~~~\n", "md");

  assert.ok((html.match(/<svg/g) ?? []).length >= 1, "the tilde fence shipped without an <svg>");
  assert.equal(/<script/i.test(html), false);
});

test("an unrenderable diagram degrades to the document, never to a 503", async () => {
  // The fence is genuine by every markdown rule, so the grammar is RIGHT to route
  // it — mermaid is what cannot draw it. Before the fallback this threw
  // HtmlExportError stage=mermaid, which the route maps to
  // 503 filesystem_unavailable(html_export_mermaid).
  const body = "# Notes\n\n```mermaid\nnot a real diagram\n```\n";
  assert.equal(countMdMermaidFences(body), 1, "the fixture must reach the renderer to prove anything");

  const html = await renderSelfContainedHtml(body, "md");

  assert.ok(html.includes(MD_DIAGRAM_DEGRADED_COMMENT), "the degradation left no trace in the artifact");
  assert.match(html, /<main>/, "the reader must still get the document");
  assert.match(html, /# Notes/);
  assert.equal(/<script/i.test(html), false, "the degraded shell must stay script-free");
});

test("the diagram container survives the viewer's sanitizer with its source intact", async () => {
  // The viewer does not mount the converted html directly — renderMarkdownCD wraps
  // it and hands it to htmlToReactCD, whose FIRST act is DOMPurify.sanitize with
  // the config below. That is the one layer in the chain that can DELETE the
  // container class or mangle the escaped source, and nothing covered it: the
  // branch could be correct and the viewer still show nothing.
  //
  // RESIDUAL, stated rather than implied: the React.createElement mount after the
  // sanitizer is NOT exercised here. The shipped viewer runs React 18.3.1 from a
  // CDN (public/index.html) and the installed copy is React 19 with no UMD build,
  // so an offline page cannot mount the React that ships — asserting against a
  // different React would be a claim about code no reader runs. The sanitizer is
  // where the risk is; React cannot drop a className off a parsed node.
  const converted = convertMdBody(MD_BODY);
  const config = loadDompurifyConfig();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/*", (route) => route.abort());

  try {
    await page.setContent(
      '<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body></body></html>',
      { waitUntil: "domcontentloaded" },
    );
    await page.addScriptTag({ content: dompurifyBundle });

    const survived = await page.evaluate(
      (input) => {
        const g = globalThis as unknown as {
          DOMPurify: { sanitize: (html: string, cfg: unknown) => string };
          DOMParser: new () => {
            parseFromString: (
              html: string,
              type: string,
            ) => { querySelectorAll: (sel: string) => ArrayLike<Element> };
          };
        };
        // The exact wrapper renderMarkdownCD builds before handing off.
        const wrapped =
          '<body class="bg-zinc-950 text-zinc-300 antialiased"><article>' +
          input.html +
          "</article></body>";
        const sanitized = g.DOMPurify.sanitize(wrapped, input.config);
        const dom = new g.DOMParser().parseFromString(sanitized, "text/html");
        const nodes = Array.from(dom.querySelectorAll(input.selector));
        return {
          count: nodes.length,
          classes: nodes.map((n) => n.getAttribute("class")),
          sources: nodes.map((n) => n.textContent ?? ""),
        };
      },
      { html: converted, config, selector: MERMAID_NODE_SELECTOR },
    );

    assert.equal(survived.count, 1, "the sanitizer removed the diagram container");
    assert.deepEqual(
      survived.classes,
      ["mermaid doc-diagram-body"],
      "the sanitizer stripped the class the render effect selects on",
    );
    // Decoded, because the browser decodes on parse — this is byte-for-byte what
    // mermaid.render receives, and a source mangled here draws nothing.
    assert.match(survived.sources[0], /A\[Delegation scope declared\] --> B\{Reviewer verdict\}/);
  } finally {
    await page.close();
    await context.close();
  }
});
