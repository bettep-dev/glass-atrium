// Illegal control-character stripper for stored document bodies.
//
// Problem:
//   - HTML/plain bodies POSTed to clauded-docs can carry raw C0 control chars (FF U+000C,
//     VT U+000B, NUL, etc.) from PDF/terminal paste. DOMPurify normalizes HTML but does
//     NOT remove these code points, so they reach disk + DB.
//   - The JSON string grammar (RFC 8259) forbids unescaped U+0000-U+001F; a strict-thin
//     serializer (fast-json-stringify) leaves them raw -> invalid JSON -> every `curl | jq`
//     consumer breaks (orchestrator done-transition `jq -r '.body'`).
//
// Policy -- strip, do NOT escape:
//   - Only TAB (U+0009), LF (U+000A), CR (U+000D) carry rendered meaning; all other C0
//     controls, DEL (U+007F), C1 block (U+0080-U+009F) are meaningless -> stripping preserves
//     render fidelity while making the body valid for strict JSON (mirrors XML 1.0 restricted-char).
//   - Deterministic + idempotent -> safe for content_hash (SHA256) + indexable-text without
//     breaking hash-stability.

// Build the class via String.fromCharCode so the source stays ASCII-only (no
// literal invisible control bytes in the file). Class members:
//   - U+0000..U+0008  : C0 below TAB
//   - U+000B..U+000C  : VT + FF (the two that survived DOMPurify in the wild)
//   - U+000E..U+001F  : C0 above CR
//   - U+007F          : DEL
//   - U+0080..U+009F  : C1 controls
// Excluded (kept): U+0009 TAB, U+000A LF, U+000D CR.
// Shared character class (single SoT) — used to build both regexes below so the
// match set can never drift between the presence test and the actual strip.
const ILLEGAL_CONTROL_CLASS =
  "[" +
  String.fromCharCode(0x00) + "-" + String.fromCharCode(0x08) +
  String.fromCharCode(0x0b) + "-" + String.fromCharCode(0x0c) +
  String.fromCharCode(0x0e) + "-" + String.fromCharCode(0x1f) +
  String.fromCharCode(0x7f) +
  String.fromCharCode(0x80) + "-" + String.fromCharCode(0x9f) +
  "]";

// Global flag → strips ALL occurrences in one `.replace` pass.
const ILLEGAL_CONTROL_CHARS = new RegExp(ILLEGAL_CONTROL_CLASS, "g");

// Non-global twin for the presence pre-test. A separate, stateless regex is
// mandatory: a `g`-flagged regex reused for `.test()` carries `lastIndex`
// across calls and would intermittently miss dirty input on later calls. The
// non-global form has no `lastIndex` state by construction → no reset needed.
const ILLEGAL_CONTROL_CHARS_TEST = new RegExp(ILLEGAL_CONTROL_CLASS);

/**
 * Remove illegal control characters from a stored document body. Keeps the JSON-/HTML-legal
 * whitespace controls (TAB/LF/CR) + every printable code point; removes all other C0 controls,
 * DEL, and the C1 control block.
 *
 * Perf: a global-regex `.replace` scans + allocates on every call regardless of matches. This
 * route is GET-polled, so the strip is gated behind the stateless presence pre-test — a clean
 * body returns the same instance with zero allocation.
 *
 * @param value - raw body string before persistence, or a body read back from disk
 * @returns the body with illegal control chars removed (same instance when none present)
 */
export function stripIllegalControlChars(value: string): string {
  if (value.length === 0) return "";
  if (!ILLEGAL_CONTROL_CHARS_TEST.test(value)) return value;
  return value.replace(ILLEGAL_CONTROL_CHARS, "");
}
