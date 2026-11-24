// What the wiki screen renders from note-written text: the broken-link and link-fix lists print their records as text.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { PROBE_MARKUP_LINES, PROBE_PROPS, PROBE_TAGS } from "./lib/probe-markup.js";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

type Component = (props: Record<string, unknown>) => unknown;

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../public/src");

const ui = (await loadScreenModule(resolve(SRC, "ui.jsx"))).UI as Record<string, unknown>;
// React hands a lone child over as itself, the stub always as an array → the Table's row function only runs unwrapped
const Table = (props: Record<string, unknown>) => {
  const { children } = props;
  return (ui.Table as Component)(Array.isArray(children) && children.length === 1 ? { ...props, children: children[0] } : props);
};
const wiki = await loadScreenModule(resolve(SRC, "screens/wiki.jsx"), { UI: { ...ui, Table } });
const React = wiki.React as { createElement: (type: unknown, props: unknown) => unknown };

// both lists come from scripts/wiki_deadlinks.py → DeadlinkRecord; every string field can hold note-written markup
const records = PROBE_MARKUP_LINES.map((line) => ({ source_slug: line, broken_link: line, link_target: line, fix_status: "dry-run-no-match" }));
const folds = [
  { name: "a broken-link record", backlog: { deadlink_dryrun: records } },
  { name: "an applied link-fix record", backlog: { deadlink_fixes: records } },
];

for (const fold of folds) {
  test(`${fold.name} shows markup from a note as its tags and words, never as a control, a request attribute or a style element`, () => {
    const backlogState = { status: "ready", error: null, data: { backlog: { run_date: "2026-09-24", ...fold.backlog } } };
    const tree = renderScreen(React.createElement(wiki.WikiMaintenanceSection as Component, { backlogState, onRetry: () => {} })) as RenderedNode;
    const reached = findNodes(tree, (node) => PROBE_TAGS.has(node.type) || PROBE_PROPS.some((prop) => node.props[prop] !== undefined));
    const text = collectText(tree);

    assert.deepEqual(reached.map((node) => node.type), []);
    for (const tag of ["<form action=", "<button formaction=", "<a href=", "<div style=", "<style>"]) assert.ok(text.includes(tag), tag);
  });
}
