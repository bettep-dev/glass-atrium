// Registration code: shown once on the Mac, valid 5 minutes and one use, burned by the 5th wrong entry, one opaque refusal.

import test from "node:test";
import assert from "node:assert/strict";

import { REGISTRATION_CODE, RegistrationCodes } from "../src/server/remote/registration-code.js";

const OPENED_AT = Date.parse("2026-11-14T14:20:00.123Z");

function createCodes(clock: { now: number }): RegistrationCodes {
  return new RegistrationCodes({ now: () => clock.now });
}

/** A wrong code of the right shape: the real code with its first symbol swapped for another alphabet symbol. */
function getWrongCode(code: string): string {
  const first = REGISTRATION_CODE.ALPHABET.indexOf(code[0] ?? "");
  const swapped = REGISTRATION_CODE.ALPHABET[(first + 1) % REGISTRATION_CODE.ALPHABET.length];
  return `${swapped}${code.slice(1)}`;
}

test("a code is 8 symbols of a 32-symbol alphabet with no look-alike characters", () => {
  assert.equal(new Set(REGISTRATION_CODE.ALPHABET).size, 32);
  for (const lookAlike of ["0", "O", "1", "I"]) assert.equal(REGISTRATION_CODE.ALPHABET.includes(lookAlike), false, lookAlike);
  const codes = createCodes({ now: OPENED_AT });
  const drawn = Array.from({ length: 200 }, () => codes.open());
  const shape = new RegExp(`^[${REGISTRATION_CODE.ALPHABET}]{8}$`);
  for (const code of drawn) assert.match(code, shape);
  assert.ok(new Set(drawn).size > 190, "draws are random, not repeated");
});

test("the right code registers once inside the window, and a second use is refused", () => {
  const codes = createCodes({ now: OPENED_AT });
  const code = codes.open();
  assert.equal(codes.consume(code), "accepted");
  assert.equal(codes.consume(code), "refused");
});

test("a code typed in lower case or with surrounding spaces is the same code", () => {
  const codes = createCodes({ now: OPENED_AT });
  const code = codes.open();
  assert.equal(codes.consume(`  ${code.toLowerCase()} `), "accepted");
});

test("the window closes 5 minutes after opening", () => {
  const rows = [
    { name: "last millisecond inside the window", elapsedMs: 5 * 60_000 - 1, expected: "accepted" },
    { name: "exactly 5 minutes after opening", elapsedMs: 5 * 60_000, expected: "refused" },
  ] as const;
  for (const row of rows) {
    const clock = { now: OPENED_AT };
    const codes = createCodes(clock);
    const code = codes.open();
    clock.now = OPENED_AT + row.elapsedMs;
    assert.equal(codes.consume(code), row.expected, row.name);
  }
});

test("the 5th wrong entry burns the code, while 4 wrong entries leave it usable", () => {
  const rows = [
    { name: "4 wrong entries", wrong: 4, expected: "accepted" },
    { name: "5 wrong entries", wrong: 5, expected: "refused" },
  ] as const;
  for (const row of rows) {
    const codes = createCodes({ now: OPENED_AT });
    const code = codes.open();
    for (let attempt = 0; attempt < row.wrong; attempt += 1) assert.equal(codes.consume(getWrongCode(code)), "refused");
    assert.equal(codes.consume(code), row.expected, row.name);
  }
});

test("an entry of any length counts as a wrong entry, never an error", () => {
  const codes = createCodes({ now: OPENED_AT });
  const code = codes.open();
  for (const entry of ["", "A", `${code}X`, `${code}${code}`, "x".repeat(4096)]) assert.equal(codes.consume(entry), "refused", JSON.stringify(entry.slice(0, 12)));
  assert.equal(codes.consume(code), "refused", "5 wrong entries burned it");
});

test("with no registration open every entry is refused", () => {
  const codes = createCodes({ now: OPENED_AT });
  assert.equal(codes.consume("23456789"), "refused");
});

test("opening a new registration replaces the open code", () => {
  const codes = createCodes({ now: OPENED_AT });
  const first = codes.open();
  const second = codes.open();
  assert.equal(codes.consume(first === second ? getWrongCode(second) : first), "refused");
  assert.equal(codes.consume(second), "accepted");
});

test("the open code is held as a digest, never as its text", () => {
  const codes = createCodes({ now: OPENED_AT });
  const code = codes.open();
  assert.equal(JSON.stringify(codes).includes(code), false);
  assert.equal(String(Object.values(codes)).includes(code), false);
});
