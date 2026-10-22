// The toast a 2xx approve/reject answer raises in public/src/screens/improvement.jsx: an approve
// whose apply record was not written warns with the route's reason; every other 2xx reports success.
// The toast itself is the shared .doc-toast shell, its tone carried by the leading glyph alone.
//
// Runner: npx tsx --test test/improvement.approve-toast.client.unit.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPROVEMENT_SRC = resolve(__dirname, "../public/src/screens/improvement.jsx");

interface Toast {
  tone: string;
  message: string;
}

interface RecordedElement {
  type: unknown;
  props: Record<string, unknown>;
}

interface ToastSandbox {
  getSuccessToastI: (action: string, id: number, body: unknown) => Toast;
  ToastI: (props: Toast) => RecordedElement;
  React: { createElement: unknown };
  window: { UI: { TONE_GLYPH: Record<string, string> } };
}

const sandbox = await buildScreenSandbox<ToastSandbox>(IMPROVEMENT_SRC);

const RECORD_REASON = "apply record not written (cause=insert_failed) — the JSONL applied row holds it";

const rows = [
  { name: "a direct approve reports success", action: "approve", body: { id: 7, status: "applied" }, tone: "ok" },
  {
    name: "a regenerated approve reports success",
    action: "approve",
    body: { id: 7, status: "applied", regenerated: true },
    tone: "ok",
  },
  {
    name: "a reject reports success",
    action: "reject",
    body: { id: 7, status: "rejected", reviewed_at: "2026-10-02T00:00:00.000Z" },
    tone: "ok",
  },
  {
    name: "an approve whose apply record is missing warns",
    action: "approve",
    body: { id: 7, status: "applied", record_missing: true, reason: RECORD_REASON },
    tone: "warn",
  },
];

for (const row of rows) {
  test(`2xx toast: ${row.name}`, () => {
    const toast = sandbox.getSuccessToastI(row.action, 7, row.body);
    assert.strictEqual(toast.tone, row.tone);
    assert.match(toast.message, /#7\b/, "the toast names the suggestion");
  });
}

test("2xx toast: the record-missing warning carries the route's reason, not the plain success text", () => {
  const toast = sandbox.getSuccessToastI("approve", 7, {
    id: 7,
    status: "applied",
    record_missing: true,
    reason: RECORD_REASON,
  });
  assert.ok(toast.message.includes(RECORD_REASON), "the cause and the record's location reach the operator");
  assert.doesNotMatch(toast.message, /approved and applied/, "a missing record is never reported as a plain success");
});

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

function getChildren(node: RecordedElement): unknown[] {
  return ([] as unknown[]).concat(node.props.children);
}

describe("a toast is the shared doc-toast shell whose tone rides on its leading glyph", () => {
  sandbox.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
    type,
    props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
  });
  for (const tone of ["ok", "warn", "crit", "info"]) {
    test(`${tone} toast`, () => {
      const toast = sandbox.ToastI({ tone, message: "Suggestion #7 rejected" });
      const classes = String(toast.props.className ?? "").split(/\s+/);
      assert.ok(classes.includes("doc-toast") && classes.includes(tone), `root classes: ${classes.join(" ")}`);
      assert.equal(toast.props.style, undefined, "a screen-local shell, shadow or z-index beside the shared toast");
      const [glyph, message] = getChildren(toast);
      assert.ok(isElement(glyph), "the toast leads with its glyph");
      assert.match(String(glyph.props.className), /\bdoc-toast-glyph\b/);
      assert.equal(glyph.props["aria-hidden"], "true");
      assert.deepEqual(getChildren(glyph), [sandbox.window.UI.TONE_GLYPH[tone]]);
      assert.equal(message, "Suggestion #7 rejected", "the message reads in the shell's neutral ink");
    });
  }
});
