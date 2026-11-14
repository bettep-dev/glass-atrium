// Logger redaction: device cookies, the CSRF header and the registration code never reach a log line.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";

import pino from "pino";

import { LOGGER_OPTIONS } from "../src/server/logger.js";
import { CSRF_HEADER } from "../src/server/remote/session.js";

function getLogLine(entry: Record<string, unknown>): string {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString("utf8"));
      done();
    },
  });
  pino({ ...LOGGER_OPTIONS, level: "info" }, sink).info(entry, "request");
  assert.equal(lines.length, 1);
  return lines[0]!;
}

const shapes: readonly { name: string; build: (value: string) => Record<string, unknown> }[] = [
  { name: "request cookie header", build: (value) => ({ req: { headers: { cookie: `ga_device=${value}` } } }) },
  { name: "bare cookie header", build: (value) => ({ headers: { cookie: `ga_device=${value}` } }) },
  { name: "response set-cookie header", build: (value) => ({ res: { headers: { "set-cookie": `ga_device=${value}; Secure` } } }) },
  { name: "request CSRF header", build: (value) => ({ req: { headers: { [CSRF_HEADER]: value } } }) },
  { name: "bare CSRF header", build: (value) => ({ headers: { [CSRF_HEADER]: value } }) },
  { name: "registration code in a body", build: (value) => ({ body: { code: value, label: "Owner iPad" } }) },
  { name: "registration code in a nested body", build: (value) => ({ req: { body: { code: value } } }) },
];

for (const shape of shapes) {
  test(`redacts the ${shape.name}`, () => {
    const value = randomBytes(12).toString("hex");
    const line = getLogLine(shape.build(value));
    assert.ok(!line.includes(value), `value leaked: ${line}`);
    assert.match(line, /\[REDACTED\]/);
  });
}

test("keeps the fields around a redacted one", () => {
  const line = getLogLine({ body: { code: randomBytes(4).toString("hex"), label: "Owner iPad" } });
  assert.match(line, /"label":"Owner iPad"/);
});
