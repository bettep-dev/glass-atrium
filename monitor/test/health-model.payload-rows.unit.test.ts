// Unit tests for the P18 daemon_run_payload keyed/labeled row logic in
// public/src/data/health-model.js (humanizePayloadKey / formatPayloadValue / toPayloadRows).
// Runner: npx tsx --test test/health-model.payload-rows.unit.test.ts
//
// health-model.js is a browser module registering window.HealthModel. It reads
// window.UI at call time, so a minimal stub is injected before import (mirrors
// health-model.unit.test.ts). These helpers are UI-independent; the stub only
// satisfies module load. Covers the raw write-only jsonb → labeled-row transform.

import test from "node:test";
import assert from "node:assert/strict";

interface PayloadRow {
  key: string;
  label: string;
  text: string;
  complex: boolean;
}
interface HealthModelApi {
  humanizePayloadKey: (key: unknown) => string;
  formatPayloadValue: (value: unknown) => { text: string; complex: boolean };
  toPayloadRows: (payload: unknown) => PayloadRow[];
}
interface StubWindow {
  UI: Record<string, unknown>;
  HealthModel?: HealthModelApi;
}

const stubWindow: StubWindow = { UI: {} };
(globalThis as { window?: StubWindow }).window = stubWindow;

await import("../public/src/data/health-model.js");
const HealthModel = stubWindow.HealthModel;
assert.ok(HealthModel, "health-model.js must register window.HealthModel");

test("humanizePayloadKey: snake/kebab/camel → spaced, first-cap", () => {
  assert.equal(HealthModel!.humanizePayloadKey("cycle_total_7d"), "Cycle total 7d");
  assert.equal(HealthModel!.humanizePayloadKey("patches-apply-count"), "Patches apply count");
  assert.equal(HealthModel!.humanizePayloadKey("compiledTotal"), "Compiled Total");
  assert.equal(HealthModel!.humanizePayloadKey("status"), "Status");
});

test("humanizePayloadKey: empty / nullish → em dash", () => {
  assert.equal(HealthModel!.humanizePayloadKey(""), "—");
  assert.equal(HealthModel!.humanizePayloadKey("   "), "—");
  assert.equal(HealthModel!.humanizePayloadKey(null), "—");
  assert.equal(HealthModel!.humanizePayloadKey(undefined), "—");
});

test("formatPayloadValue: primitives inline, non-complex", () => {
  assert.deepEqual(HealthModel!.formatPayloadValue("done"), { text: "done", complex: false });
  assert.deepEqual(HealthModel!.formatPayloadValue(42), { text: "42", complex: false });
  assert.deepEqual(HealthModel!.formatPayloadValue(0), { text: "0", complex: false });
  assert.deepEqual(HealthModel!.formatPayloadValue(false), { text: "false", complex: false });
});

test("formatPayloadValue: null/undefined → em dash", () => {
  assert.deepEqual(HealthModel!.formatPayloadValue(null), { text: "—", complex: false });
  assert.deepEqual(HealthModel!.formatPayloadValue(undefined), { text: "—", complex: false });
});

test("formatPayloadValue: object/array → compact JSON, complex", () => {
  assert.deepEqual(HealthModel!.formatPayloadValue({ a: 1 }), { text: '{"a":1}', complex: true });
  assert.deepEqual(HealthModel!.formatPayloadValue([1, 2]), { text: "[1,2]", complex: true });
});

test("formatPayloadValue: unserializable (circular) → safe fallback", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.deepEqual(HealthModel!.formatPayloadValue(circular), {
    text: "[unreadable data]",
    complex: true,
  });
});

test("toPayloadRows: object → labeled rows preserving key order", () => {
  const rows = HealthModel!.toPayloadRows({ cycle_total_7d: 3, status: "ok" });
  assert.deepEqual(rows, [
    { key: "cycle_total_7d", label: "Cycle total 7d", text: "3", complex: false },
    { key: "status", label: "Status", text: "ok", complex: false },
  ]);
});

test("toPayloadRows: non-object / array / null → empty array", () => {
  assert.deepEqual(HealthModel!.toPayloadRows(null), []);
  assert.deepEqual(HealthModel!.toPayloadRows(undefined), []);
  assert.deepEqual(HealthModel!.toPayloadRows([1, 2, 3]), []);
  assert.deepEqual(HealthModel!.toPayloadRows("string"), []);
  assert.deepEqual(HealthModel!.toPayloadRows({}), []);
});
