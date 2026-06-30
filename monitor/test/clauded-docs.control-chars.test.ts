// Unit tests for clauded-docs/control-chars (illegal C0/C1 control stripping).
// Runner: node:test (built-in, zero-dep) — invoked via tsx so TS sources load
// without a compile step. Run with: npx tsx --test test/clauded-docs.control-chars.test.ts
//
// Why this exists:
//   - Stored HTML bodies can carry raw C0 control chars (form-feed \x0c, vertical
//     tab \x0b, etc.) that DOMPurify does NOT remove → consumers reading the
//     stored bytes (or any fast-json-stringify serializer) emit invalid strict
//     JSON, breaking a `curl … | jq -r '.body'` recipe.
//   - Contract: strip every C0 control except \t \n \r, plus DEL + C1 controls,
//     at the write boundary (and re-clean on read for pre-existing rows).
//
// Coverage:
//   - \x0c / \x0b removed; \t \n \r preserved.
//   - full C0 sweep + DEL + C1 sweep.
//   - regular text + multibyte (Korean) untouched.
//   - idempotency (clean input → unchanged) + determinism.
//   - JSON round-trip safety: stripped output is JSON.parse-able after stringify.

import test from "node:test";
import assert from "node:assert/strict";

import { stripIllegalControlChars } from "../src/server/clauded-docs/control-chars.js";

test("stripIllegalControlChars: removes form-feed (\\x0c) and vertical-tab (\\x0b)", () => {
  const input = "before\x0c\x0bafter";
  assert.equal(stripIllegalControlChars(input), "beforeafter");
});

test("stripIllegalControlChars: preserves the JSON-legal whitespace \\t \\n \\r", () => {
  const input = "a\tb\nc\rd";
  assert.equal(stripIllegalControlChars(input), "a\tb\nc\rd");
});

test("stripIllegalControlChars: removes the full C0 control range except \\t \\n \\r", () => {
  // Build U+0000..U+001F, expect only 0x09/0x0a/0x0d to survive.
  const all = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join("");
  const out = stripIllegalControlChars(all);
  assert.equal(out, "\t\n\r");
});

test("stripIllegalControlChars: removes DEL (\\x7f) and C1 controls (\\x80–\\x9f)", () => {
  const input = "x\x7fy\x85z\x9fw";
  assert.equal(stripIllegalControlChars(input), "xyzw");
});

test("stripIllegalControlChars: leaves regular ASCII + Korean text untouched", () => {
  const input = "<p>본문 텍스트 — normal HTML 123</p>";
  assert.equal(stripIllegalControlChars(input), input);
});

test("stripIllegalControlChars: empty string → empty string", () => {
  assert.equal(stripIllegalControlChars(""), "");
});

test("stripIllegalControlChars: idempotent — already-clean input is unchanged", () => {
  const clean = "no control chars here\nbut newlines\tand tabs are fine";
  assert.equal(stripIllegalControlChars(clean), clean);
  // second pass identical (determinism + idempotency)
  assert.equal(stripIllegalControlChars(stripIllegalControlChars(clean)), clean);
});

test("stripIllegalControlChars: output is strict-JSON round-trippable after stringify", () => {
  const dirty = "<!doctype html>\x0c<html>\x0b<body>x\x00y</body></html>";
  const cleaned = stripIllegalControlChars(dirty);
  // No illegal control bytes survive.
  for (const ch of cleaned) {
    const code = ch.charCodeAt(0);
    const legal = code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20;
    assert.ok(legal, `unexpected control char U+${code.toString(16)} survived`);
  }
  // Stringify → parse round-trip must succeed and preserve the cleaned body.
  const wire = JSON.stringify({ body: cleaned });
  const parsed = JSON.parse(wire) as { body: string };
  assert.equal(parsed.body, cleaned);
});
