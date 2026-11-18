// What a task record's agent-written markdown body keeps once the drawer has rendered it.
// The render chain is the shipped one: marked → DOMPurify with the shared viewer config → the drawer's HTML.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";

import { loadScreenModule } from "./lib/render-screen.js";

// jsdom ships no types → the one constructor used here, typed by hand
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as { JSDOM: new (html: string) => { window: { document: Document } } };

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../public/src");

// markup aimed at the Mac-only routes, a click-sending link, and styles that paint outside the drawer
const BODY = [
  "# Result",
  "",
  "Done.",
  "",
  '<form action="/api/remote/devices/revoke-all" method="post"><input type="hidden" name="all" value="1"><button type="submit">Revoke all devices</button></form>',
  "",
  '<button formaction="/api/remote/registration" formmethod="post">Register</button> <select name="d"><option>Pixel</option></select> <textarea name="n">note</textarea>',
  "",
  'See the <a href="https://example.com/setup" ping="/api/remote/devices/revoke-all">setup guide</a>.',
  "",
  '<div style="position:fixed;inset:0;z-index:9999">Session expired — sign in again</div>',
  "",
  "<style>body { position: fixed; }</style>",
].join("\n");

const ui = (await loadScreenModule(resolve(SRC, "ui.jsx"))).UI;
const outcomes = await loadScreenModule(resolve(SRC, "screens/outcomes.jsx"), { UI: ui, marked, DOMPurify });
const sanitizeMarkdownToHtml = outcomes.sanitizeMarkdownToHtmlO as (markdown: string) => string | null;

function renderBody(): Document {
  const html = sanitizeMarkdownToHtml(BODY);
  assert.ok(html !== null, "the chain rendered HTML");
  const { document } = new JSDOM("").window;
  document.body.innerHTML = html;
  return document;
}

test("a record body keeps no element that submits or holds a submitted value", () => {
  const document = renderBody();

  assert.deepEqual([...document.querySelectorAll("form, input, button, select, textarea")].map((node) => node.tagName), []);
});

test("a record body keeps no attribute that sends a request on a click", () => {
  const document = renderBody();

  assert.deepEqual([...document.querySelectorAll("[ping], [formaction]")].map((node) => node.outerHTML), []);
  assert.equal(document.querySelector("a")?.getAttribute("href"), "https://example.com/setup", "the link itself stays");
});

test("a record body keeps no style that can paint outside the drawer", () => {
  const document = renderBody();

  assert.deepEqual([...document.querySelectorAll("style, [style]")].map((node) => node.outerHTML), []);
});

test("a record body keeps the words of what it drops", () => {
  const text = renderBody().body.textContent ?? "";

  for (const word of ["Result", "Revoke all devices", "setup guide", "Session expired — sign in again"]) assert.ok(text.includes(word), word);
});
