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

import { renderSelfContainedHtml } from "../src/server/clauded-docs/html-export.js";
import { resetBrowserForTests } from "../src/server/clauded-docs/browser-pool.js";
import {
  MERMAID_NODE_SELECTOR,
  MERMAID_RENDERED_SVG_SELECTOR,
} from "../src/server/clauded-docs/mermaid-selector.js";
import { evaluateMermaidConfig } from "./lib/mermaid-config-source.js";
import { assertFallbackWarningVisible, createFallbackWatch } from "./lib/mermaid-elk-probe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_ROOT = resolve(HERE, "..");
const VIEWER_SCREEN_PATH = resolve(MONITOR_ROOT, "public/src/screens/clauded-docs.jsx");
const VENDOR_ELK_PATH = resolve(MONITOR_ROOT, "public/assets/vendor/mermaid-layout-elk-0.2.3.min.js");

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

/** Runs the md body through marked exactly as renderMarkdownCD does, then the real injector. */
function convertMdBody(body: string): string {
  const rawHtml = marked.parse(body, { gfm: true, breaks: false }) as string;
  // The contract the conversion branch is written against. The shipped viewer loads
  // marked@13 from a CDN and this process resolves the installed copy, so pinning the
  // shape here is what makes the version gap visible: a marked whose fence output stopped
  // being `<pre><code class="language-xxx">` fails on this line, naming the cause, instead
  // of surfacing later as a mystery zero-node render.
  assert.match(rawHtml, /<pre><code class="language-mermaid">/);
  return loadInjectMdTypographyClasses()(rawHtml);
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

before(async () => {
  browser = await chromium.launch({ headless: true });
  const pkgPath = fileURLToPath(import.meta.resolve("mermaid/package.json"));
  mermaidBundle = await readFile(resolve(dirname(pkgPath), "dist", "mermaid.min.js"), "utf8");
  vendorElkBundle = await readFile(VENDOR_ELK_PATH, "utf8");
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
