// What a managed document's markup keeps once the viewer has rendered it, and where its styles can paint.
// The render chain is the shipped one: marked (md) → DOMPurify with the viewer's config → DOMParser → element tree.
//
// Runner: npx tsx --test test/clauded-docs.viewer-markup.client.test.ts

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";
import React from "react";
import { chromium, type Browser } from "playwright";
import { collectText, createReactStub, findNodes, loadScreenModule, renderScreen } from "./lib/render-screen.js";

// jsdom (the DOM isomorphic-dompurify runs on) and react-dom ship no types → the one call each used here, typed by hand
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as { JSDOM: new (html: string) => { window: { DOMParser: unknown } } };
const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (element: React.ReactElement) => string };

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_SRC = resolve(__dirname, "../public/src/screens/clauded-docs.jsx");
const SCOPE = "doc-body-isolation";

// every element that submits, or holds a value a submit would carry
const FORM_CONTROL_TAGS = new Set(["form", "input", "button", "select", "textarea"]);
// attributes that send a request on a click with no script
const REQUEST_ATTRS = new Set(["ping", "formaction"]);

// markup aimed at the Mac-only routes — each piece issues a same-origin request on one click
const REQUEST_MARKUP = [
  '<form action="/api/remote/devices/revoke-all" method="post"><input type="hidden" name="all" value="1"><button type="submit">Revoke all devices</button></form>',
  '<button form="register" formaction="/api/remote/registration" formmethod="post">Register this device</button>',
  '<select name="device"><option>Pixel 8</option></select>',
  '<textarea name="note">Pairing note</textarea>',
].join("\n");
const PING_LINK = '<a href="https://example.com/setup" ping="/api/remote/devices/revoke-all">Setup guide</a>';

type Rendered = { className: string; style: unknown; children: unknown[] } | null;
type Viewer = {
  renderMarkdownCD: (body: string, scope: string, title: string) => Rendered;
  htmlToReactCD: (body: string, scope: string) => Rendered;
};

const { SANITIZE_CONFIG } = (await loadScreenModule(resolve(__dirname, "../public/src/ui.jsx"))).UI as { SANITIZE_CONFIG: unknown };

// what the screen reads at load: the shipped sanitizer config, UI atoms (each a recording element) and the group-expand store
function getScreenGlobals(): Record<string, unknown> {
  const atom = (name: string) => (props: Record<string, unknown>) => ({ __element: true, type: "ui-atom", props: { ...props, atom: name } });
  const UI = new Proxy({}, { get: (_t, name: string) => (name === "SANITIZE_CONFIG" ? SANITIZE_CONFIG : atom(name)), has: () => true });
  const items = new Map<string, string>();
  const localStorage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
  return { UI, localStorage };
}

async function loadViewer(react: Record<string, unknown>): Promise<Viewer> {
  const { window } = new JSDOM("");
  const screen = await loadScreenModule(DOCS_SRC, {
    ...getScreenGlobals(),
    React: react,
    DOMPurify,
    DOMParser: window.DOMParser,
    marked,
  });
  return screen as unknown as Viewer;
}

const bodies = [
  {
    name: "an md body, which is stored raw and reaches the viewer unsanitized",
    render: (viewer: Viewer) =>
      viewer.renderMarkdownCD(`# Pairing\n\nRead this first.\n\n${REQUEST_MARKUP}\n\nSee the ${PING_LINK}.\n`, SCOPE, "Notes"),
  },
  {
    name: "an html body, rendered by the viewer's own config without the server list",
    render: (viewer: Viewer) =>
      viewer.htmlToReactCD(`<!doctype html><html><body><h1>Pairing</h1><p>Read this first.</p>${REQUEST_MARKUP}<p>See the ${PING_LINK}.</p></body></html>`, SCOPE),
  },
];

describe("document markup keeps no element or attribute that can issue a request, while its reading content stays", () => {
  for (const body of bodies) {
    test(body.name, async () => {
      const react = createReactStub();
      const rendered = body.render(await loadViewer(react));
      assert.ok(rendered, "the body rendered");
      const createElement = react.createElement as (type: string, props: null, ...children: unknown[]) => unknown;
      const tree = renderScreen(createElement("div", null, ...rendered.children));
      assert.ok(tree && typeof tree !== "string");
      const elements = findNodes(tree, () => true);

      const survivors = {
        tags: elements.map((n) => n.type).filter((type) => FORM_CONTROL_TAGS.has(type)),
        attrs: elements.flatMap((n) => Object.keys(n.props).filter((key) => REQUEST_ATTRS.has(key.toLowerCase()))),
      };
      assert.deepEqual(survivors, { tags: [], attrs: [] }, "no form control and no request attribute survives");

      const link = elements.find((n) => n.type === "a");
      assert.equal(link?.props.href, "https://example.com/setup", "the link keeps its target");
      assert.match(collectText(tree), /Read this first\.[\s\S]*Setup guide/, "the reading text stays");
    });
  }
});

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

// the screen's own style block, as the screen renders it
async function getScreenCss(): Promise<string> {
  const screen = await loadScreenModule(DOCS_SRC, getScreenGlobals());
  const tree = renderScreen((screen.ScreenClaudedDocs as (p: unknown) => unknown)({}));
  assert.ok(tree && typeof tree !== "string");
  return findNodes(tree, (n) => n.type === "style").map((n) => collectText(n)).join("\n");
}

const overlays = [
  {
    name: "an inline fixed overlay",
    html: '<body><p>Body text.</p><div style="position: fixed; inset: 0; z-index: 2147483647; background: rgb(9 9 11)">Remote access fingerprint 4F:2A</div></body>',
  },
  {
    name: "a style block that fixes an element over the viewport",
    html: "<body><style>.cover { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 2147483647; background: rgb(9 9 11); }</style><p>Body text.</p><div class=\"cover\">Remote access fingerprint 4F:2A</div></body>",
  },
  {
    name: "an inline overlay pulled out of the body by negative offsets",
    html: '<body><p>Body text.</p><div style="position: absolute; top: -400px; left: -400px; width: 3000px; height: 3000px; z-index: 2147483647; background: rgb(9 9 11)">Remote access fingerprint 4F:2A</div></body>',
  },
];

// the viewer's frame: a 120px head, then a 680px body cell beside a 300px meta rail
async function setViewerPage(page: Awaited<ReturnType<Browser["newPage"]>>, css: string, markup: string): Promise<void> {
  await page.route("**/*", (route) => route.abort());
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body style="margin:0">` +
      '<div id="chrome" style="height:120px">Viewer header</div>' +
      '<div style="display:flex;height:680px"><div class="doc-fs-body-wrap" style="flex:1"><div class="doc-fs-body-inner">' +
      markup +
      '</div></div><div id="rail" style="width:300px">Meta rail</div></div></body></html>',
  );
}

describe("a document's styles paint only inside the viewer's body cell, never over the chrome around it", () => {
  for (const overlay of overlays) {
    test(overlay.name, async () => {
      const viewer = await loadViewer(React as unknown as Record<string, unknown>);
      const rendered = viewer.htmlToReactCD(overlay.html, SCOPE);
      assert.ok(rendered, "the body rendered");
      const markup = renderToStaticMarkup(React.createElement("div", { className: `${SCOPE} ${rendered.className}` }, ...(rendered.children as React.ReactNode[])));
      const css = await getScreenCss();
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      try {
        await setViewerPage(page, css, markup);
        // string form → the page runs it as written (no transpiler helpers it lacks)
        const hits = await page.evaluate(`(() => {
          const hit = {};
          for (const id of ["chrome", "rail"]) {
            const box = document.getElementById(id).getBoundingClientRect();
            const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            hit[id] = el?.id || \`document: \${el?.textContent?.trim().slice(0, 40)}\`;
          }
          return hit;
        })()`);
        assert.deepEqual(hits, { chrome: "chrome", rail: "rail" }, "the chrome is what a click outside the body reaches");
      } finally {
        await page.close();
      }
    });
  }
});

test("a document longer than the body cell scrolls its last line into view", async () => {
  const viewer = await loadViewer(React as unknown as Record<string, unknown>);
  const paragraphs = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of the incident write-up.`).join("\n\n");
  const rendered = viewer.renderMarkdownCD(`# Incident review\n\n${paragraphs}\n\nEnd of document.\n`, SCOPE, "Incident review");
  assert.ok(rendered, "the body rendered");
  const markup = renderToStaticMarkup(React.createElement("div", { className: `${SCOPE} ${rendered.className}` }, ...(rendered.children as React.ReactNode[])));
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await setViewerPage(page, await getScreenCss(), markup);
    // string form → the page runs it as written (no transpiler helpers it lacks)
    const reach = await page.evaluate(`(() => {
      const wrap = document.querySelector(".doc-fs-body-wrap");
      wrap.scrollTop = wrap.scrollHeight;
      const last = Array.from(wrap.querySelectorAll("p")).at(-1).getBoundingClientRect();
      const cell = wrap.getBoundingClientRect();
      return { isLastInCell: last.top >= cell.top && last.bottom <= cell.bottom, text: document.elementFromPoint(last.left + 4, last.top + last.height / 2)?.textContent?.trim() };
    })()`);
    assert.deepEqual(reach, { isLastInCell: true, text: "End of document." });
  } finally {
    await page.close();
  }
});
