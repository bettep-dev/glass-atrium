// The toast a 2xx approve/reject answer raises in public/src/screens/improvement.jsx: an approve
// whose apply record was not written warns with the route's reason; every other 2xx reports success.
//
// Runner: npx tsx --test test/improvement.approve-toast.client.unit.test.ts

import test from "node:test";
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

interface ToastSandbox {
  getSuccessToastI: (action: string, id: number, body: unknown) => Toast;
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
