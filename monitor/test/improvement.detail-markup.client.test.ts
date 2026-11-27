// What the suggestion drawer renders from agent-written text: the proposal rationale and the pattern example stay text.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { PROBE_MARKUP_LINES, PROBE_PROPS, PROBE_TAGS } from "./lib/probe-markup.js";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

type Component = (props: Record<string, unknown>) => unknown;

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../public/src");
const PROBE = PROBE_MARKUP_LINES.join("\n");

const ui = (await loadScreenModule(resolve(SRC, "ui.jsx"))).UI;
const improvement = await loadScreenModule(resolve(SRC, "screens/improvement.jsx"), { UI: ui });
const React = improvement.React as { createElement: (type: unknown, props: unknown) => unknown };
const buildDetailProps = improvement.buildDetailPropsI as (row: Record<string, unknown>) => Record<string, unknown>;

const rows = [
  { name: "a proposal's rationale", row: { id: 7, status: "pending", target_agent: "glass-atrium-dev-node", rationale: PROBE } },
  { name: "a pattern's example, set in the mono block", row: { kind: "pattern", pattern_signature: "size est overrun", example: PROBE } },
];

for (const { name, row } of rows) {
  test(`${name} shows markup as its literal tags and words, never as a control, a request attribute or a style element`, () => {
    const tree = renderScreen(React.createElement(improvement.DetailBodyI as Component, buildDetailProps(row))) as RenderedNode;
    const reached = findNodes(tree, (node) => PROBE_TAGS.has(node.type) || PROBE_PROPS.some((prop) => node.props[prop] !== undefined));
    const text = collectText(tree);

    assert.deepEqual(reached.map((node) => node.type), []);
    for (const line of PROBE_MARKUP_LINES) assert.ok(text.includes(line), line);
  });
}
