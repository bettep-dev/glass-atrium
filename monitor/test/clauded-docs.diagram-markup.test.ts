// A document's mermaid source is agent-written at runtime; the viewer mounts mermaid's SVG as raw markup
// (clauded-docs.jsx → ViewerBodyCD → getDiagramMarkupCD). What a diagram can put into the page is decided here.
// Browser: playwright chromium, mermaid and DOMPurify read from node_modules, no network.
// Runner: npx tsx --test test/clauded-docs.diagram-markup.test.ts

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { evaluateMermaidConfig } from "./lib/mermaid-config-source.js";
import { loadScreenModule } from "./lib/render-screen.js";

const MONITOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Mounted {
  readonly scripts: number;
  readonly handlers: string[];
  readonly controls: number;
  readonly scriptLinks: number;
  readonly text: string;
  readonly hasSvg: boolean;
}

// one probe per way a label or a click line could carry markup into the page
const PROBES = [
  { name: "a script element in a label", source: 'flowchart LR\n  A["<script>window.ran = 1</script>Start"] --> B[End]', words: "Start" },
  { name: "an event-handler attribute in a label", source: 'flowchart LR\n  A["<img src=x onerror=window.ran=1>Start"] --> B[End]', words: "Start" },
  { name: "a form with a button in a label (inside its foreignObject)", source: "flowchart LR\n  A[\"<form action='https://collector.example/'><input name=q><button>Send</button></form>\"] --> B[End]", words: "Send" },
  { name: "a javascript address on a label link", source: "flowchart LR\n  A[\"<a href='javascript:window.ran=1'>Open</a>\"] --> B[End]", words: "Open" },
  { name: "a javascript address on a click line", source: 'flowchart LR\n  A[Open] --> B[End]\n  click A href "javascript:window.ran=1"', words: "Open" },
];

let browser: Browser;
let page: Page;

before(async () => {
  const mermaidBundle = await readFile(resolve(dirname(fileURLToPath(import.meta.resolve("mermaid/package.json"))), "dist", "mermaid.min.js"), "utf8");
  const dompurifyBundle = await readFile(resolve(MONITOR_ROOT, "node_modules/dompurify/dist/purify.min.js"), "utf8");
  const ui = await loadScreenModule(resolve(MONITOR_ROOT, "public/src/ui.jsx"));
  const viewer = await loadScreenModule(resolve(MONITOR_ROOT, "public/src/screens/clauded-docs.jsx"), { UI: ui.UI });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="host"></div></body></html>');
  await page.addScriptTag({ content: dompurifyBundle });
  await page.addScriptTag({ content: mermaidBundle });
  // the shipped sink and its config, evaluated in the page's global scope
  await page.evaluate(({ config, sink, sanitize }) => {
    const g = globalThis as unknown as Record<string, unknown> & { mermaid: { initialize: (c: unknown) => void } };
    g.mermaid.initialize({ ...config, layout: "dagre" });
    g.UI = { SANITIZE_CONFIG: sanitize };
    g.getDiagramMarkupCD = (0, eval)(`(${sink})`);
  }, { config: evaluateMermaidConfig(), sink: String(viewer.getDiagramMarkupCD), sanitize: (ui.UI as { SANITIZE_CONFIG: unknown }).SANITIZE_CONFIG });
});

after(async () => {
  await browser?.close();
});

/** Renders the source with the shipped mermaid config, mounts the markup as the viewer would, and reads what landed. */
async function mount(source: string, isShipped: boolean): Promise<Mounted> {
  return page.evaluate(async ({ source, isShipped }) => {
    const g = globalThis as unknown as Record<string, unknown> & {
      mermaid: { render: (id: string, src: string) => Promise<{ svg: string }> };
      getDiagramMarkupCD: (svg: string) => string;
    };
    const host = document.getElementById("host") as HTMLElement;
    const { svg } = await g.mermaid.render(`probe-${Date.now()}`, source);
    host.innerHTML = isShipped ? g.getDiagramMarkupCD(svg) : svg;
    const all = Array.from(host.querySelectorAll("*"));
    return {
      scripts: host.querySelectorAll("script").length,
      handlers: all.flatMap((node) => node.getAttributeNames().filter((name) => name.startsWith("on"))),
      controls: host.querySelectorAll("form, input, button, select, textarea").length,
      scriptLinks: all.filter((node) => /^\s*javascript:/i.test(node.getAttribute("href") ?? node.getAttribute("xlink:href") ?? "")).length,
      text: host.textContent ?? "",
      hasSvg: host.querySelector("svg") !== null,
    };
  }, { source, isShipped });
}

describe("a document diagram puts no script, handler, form control or javascript address into the viewer", () => {
  for (const probe of PROBES) {
    test(probe.name, async () => {
      const mounted = await mount(probe.source, true);

      assert.equal(mounted.scripts, 0, "no script element");
      assert.deepEqual(mounted.handlers, [], "no event-handler attribute");
      assert.equal(mounted.controls, 0, "no form control");
      assert.equal(mounted.scriptLinks, 0, "no javascript address");
      assert.ok(mounted.hasSvg && mounted.text.includes(probe.words), "the diagram still draws, its words kept");
    });
  }
});

test("mermaid's own output keeps a label's form controls, which is why the viewer sanitizes it again", async () => {
  const form = PROBES.find((probe) => probe.words === "Send");
  assert.ok(form);

  const mounted = await mount(form.source, false);

  assert.ok(mounted.controls > 0);
});
