// What the wiki screen renders from note-written text: the broken-link and link-fix lists print their records as text.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { PROBE_MARKUP_LINES, PROBE_PROPS, PROBE_TAGS } from "./lib/probe-markup.js";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

type Component = (props: Record<string, unknown>) => unknown;

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../public/src");

const ui = (await loadScreenModule(resolve(SRC, "ui.jsx"))).UI;
const wiki = await loadScreenModule(resolve(SRC, "screens/wiki.jsx"), { UI: ui });
const React = wiki.React as { createElement: (type: unknown, props: unknown) => unknown };

test("a broken-link record shows markup from a note as its tags and words, never as a control, a request attribute or a style element", () => {
  const payload = PROBE_MARKUP_LINES.map((line, index) => ({ source: `notes/probe-${index}.md`, link: line }));
  const tree = renderScreen(React.createElement(wiki.BacklogExplorer as Component, { label: "Broken links", count: payload.length, payload })) as RenderedNode;
  const reached = findNodes(tree, (node) => PROBE_TAGS.has(node.type) || PROBE_PROPS.some((prop) => node.props[prop] !== undefined));
  const text = collectText(tree);

  assert.deepEqual(reached.map((node) => node.type), []);
  for (const tag of ["<form action=", "<button formaction=", "<a href=", "<div style=", "<style>"]) assert.ok(text.includes(tag), tag);
});
