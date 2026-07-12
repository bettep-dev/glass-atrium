// host-loopback-bind.unit.test.ts — the loopback-only bind invariant (red-team finding #22).
//
// The monitor API is fully unauthenticated, so main.ts must bind a LOOPBACK interface only — a
// non-loopback bind (0.0.0.0 / a LAN or public IP) would expose the whole API. This pins:
//   1. isLoopbackHost() behaviour — 127.0.0.0/8 + ::1 + localhost pass; 0.0.0.0 / :: / LAN reject.
//   2. main.ts wires the guard as a FATAL pre-listen gate (process.exit(1) before app.listen()),
//      mirroring the boot-db-gate structural check — a source-text assertion, since a behavioural
//      bind test would need a live port + DB.
//
// DB-free / dependency-free: imports the pure predicate + reads main.ts SOURCE TEXT — it never
// imports main.ts (which self-executes main()). Runner: npx tsx --test test/host-loopback-bind.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { isLoopbackHost } from "../src/server/host-guard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(resolve(HERE, "../src/server/main.ts"), "utf8");

test("isLoopbackHost: IPv4 127.0.0.0/8 binds normally", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "127.1.2.3", "127.255.255.255"]) {
    assert.strictEqual(isLoopbackHost(host), true, `${host} must be recognized as loopback`);
  }
});

test("isLoopbackHost: IPv6 ::1 (expanded / bracketed / zoned / IPv4-mapped) binds normally", () => {
  for (const host of ["::1", "0:0:0:0:0:0:0:1", "[::1]", "::1%lo0", "::ffff:127.0.0.1"]) {
    assert.strictEqual(isLoopbackHost(host), true, `${host} must be recognized as loopback`);
  }
});

test("isLoopbackHost: the localhost alias binds normally (case-insensitive)", () => {
  assert.strictEqual(isLoopbackHost("localhost"), true);
  assert.strictEqual(isLoopbackHost("LOCALHOST"), true);
});

test("isLoopbackHost: a non-loopback HOST is refused (fail closed)", () => {
  for (const host of [
    "0.0.0.0",
    "::",
    "0:0:0:0:0:0:0:0",
    "::ffff:0.0.0.0",
    "192.168.1.10",
    "10.0.0.5",
    "8.8.8.8",
    "example.com",
    "256.0.0.1",
    "",
    "   ",
  ]) {
    assert.strictEqual(isLoopbackHost(host), false, `${host} is NOT loopback → must be refused`);
  }
});

test("main.ts: the loopback guard is a FATAL pre-listen gate (exit(1) before app.listen)", () => {
  const guardIdx = mainSrc.indexOf("isLoopbackHost(HOST)");
  const listenIdx = mainSrc.indexOf("await app.listen(");
  assert.ok(guardIdx >= 0, "main.ts must validate HOST via isLoopbackHost(HOST)");
  assert.ok(listenIdx >= 0, "app.listen() call not found in main.ts");
  assert.ok(guardIdx < listenIdx, "the loopback guard must precede app.listen() so a bad HOST never binds");
  assert.match(
    mainSrc,
    /if \(!isLoopbackHost\(HOST\)\)[\s\S]*?process\.exit\(1\)/,
    "a non-loopback HOST must be fatal (process.exit(1) → never bind)",
  );
});
