// Element-tree behaviour tests for the Documents screen header and stage pill,
// exercised through test/lib/render-screen.ts — no DOM, no react-dom, no DB.
//
// Runner: npx tsx --test test/clauded-docs.screen-render.client.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createReactStub,
  findNodes,
  loadScreenModule,
  renderScreen,
} from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_SRC = resolve(__dirname, "../public/src/screens/clauded-docs.jsx");

// Formatters tag their input so a test can tell which one the screen called.
const UI_SCALARS: Record<string, unknown> = {
  formatInt: (n: number) => String(n),
  formatKstTime: (iso: string) => `time(${iso})`,
  formatKstDateTime: (iso: string) => `datetime(${iso})`,
};

function uiStub(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name in UI_SCALARS
          ? UI_SCALARS[name]
          : Object.defineProperty(
              (props: Record<string, unknown>) => ({
                __element: true,
                type: "ui-atom",
                props: { ...props, atom: name },
              }),
              "name",
              { value: name },
            ),
      has: () => true,
    },
  );
}

type Component = (props: unknown) => unknown;

async function loadDocsScreen(): Promise<Record<string, unknown>> {
  return loadScreenModule(DOCS_SRC, { UI: uiStub(), React: createReactStub() });
}

function cssRuleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `CSS rule ${selector} must exist`);
  return match[1];
}

test("the terminal stage pill carries the ok tone on border and glyph, never on its label text", () => {
  const source = readFileSync(DOCS_SRC, "utf8");
  const terminalPill = cssRuleBody(source, ".doc-stage-pill.is-terminal");
  const glyph = cssRuleBody(source, ".doc-stage-glyph.is-terminal");

  assert.doesNotMatch(terminalPill, /(^|[;\s])color\s*:/, "terminal pill must not recolor its text");
  assert.match(terminalPill, /border-color\s*:\s*rgb\(var\(--ok\)/);
  assert.match(glyph, /(^|[;\s])color\s*:\s*rgb\(var\(--ok\)\)/);
});

test("a done pill renders its check glyph inside the ok-toned glyph slot and its label outside it", async () => {
  const screen = await loadDocsScreen();
  const tree = renderScreen((screen.DocStagePillCD as Component)({ docStatus: "done" }));

  const glyphSlots = findNodes(tree, (node) => node.props.className === "doc-stage-glyph is-terminal");
  assert.equal(glyphSlots.length, 1);
  const icons = findNodes(glyphSlots[0], (node) => node.props.atom === "Icon");
  assert.equal(icons.length, 1);
  assert.equal(icons[0].props.name, "check");

  const labels = findNodes(tree, (node) => node.props.className === "doc-stage-label");
  assert.equal(labels.length, 1);
  assert.equal(findNodes(glyphSlots[0], (node) => node === labels[0]).length, 0);
});

test("the header line always leads with the one-word screen name, stamped with a time-only as-of", async () => {
  const screen = await loadDocsScreen();
  const asOfSub = screen.asOfSubCD as (asOf: string | null, status: string) => string;
  const iso = "2026-09-24T12:34:00.000Z";

  assert.equal(asOfSub(iso, "ready"), `Documents · as of time(${iso})`);
  for (const status of ["loading", "error"]) {
    assert.ok(asOfSub(null, status).startsWith("Documents · "), `status ${status}`);
  }
});
