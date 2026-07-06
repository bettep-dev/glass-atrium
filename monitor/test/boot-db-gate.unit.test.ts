// boot-db-gate.unit.test.ts — STEP 6 structural invariants for the monitor boot DB gate.
//
// DB-free + dependency-free: reads db.ts + main.ts SOURCE TEXT (no app import → no @prisma / pg /
// live DB), so it runs without a database or a generated prisma client — the two invariants it pins
// are source-level ordering/config facts, not runtime behaviour, so a structural check is the honest
// mechanical test here (a behavioural test would need a DB + a bound port).
//   1. db.ts POOL_WARM_CONFIG bounds the pg connect (connectionTimeoutMillis:5000). Unset(0) = pg
//      default = UNBOUNDED connect = the step-12 boot hang against a still-booting cluster.
//   2. main.ts runs assertSessionTimezoneIsUtc() (the DB assertion) + prewarmPool BEFORE app.listen(),
//      so a DB-unavailable boot exits(1) → launchd respawn instead of binding :7842 on an unusable DB.
//
// Run via: npx tsx --test test/boot-db-gate.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const dbSrc = readFileSync(resolve(HERE, "../src/server/db.ts"), "utf8");
const mainSrc = readFileSync(resolve(HERE, "../src/server/main.ts"), "utf8");

test("db.ts: POOL_WARM_CONFIG bounds the pg connect with connectionTimeoutMillis 5000", () => {
  const cfg = dbSrc.match(/const POOL_WARM_CONFIG = \{[\s\S]*?\} as const;/);
  assert.ok(cfg, "POOL_WARM_CONFIG object literal not found");
  assert.match(
    cfg[0],
    /connectionTimeoutMillis:\s*5000/,
    "connect must be bounded at 5000ms — an unset (0) default is an unbounded connect (the boot hang)",
  );
});

test("main.ts: the DB assertion runs BEFORE app.listen (DB gate precedes the port bind)", () => {
  const assertIdx = mainSrc.indexOf("await assertSessionTimezoneIsUtc()");
  const listenIdx = mainSrc.indexOf("await app.listen(");
  assert.ok(assertIdx >= 0, "assertSessionTimezoneIsUtc() call not found in main.ts");
  assert.ok(listenIdx >= 0, "app.listen() call not found in main.ts");
  assert.ok(
    assertIdx < listenIdx,
    "the DB assertion must precede app.listen() so a DB-down boot exits before binding :7842",
  );
});

test("main.ts: prewarmPool also runs BEFORE app.listen (DB assertion + prewarm = the pre-listen gate)", () => {
  const prewarmIdx = mainSrc.indexOf("await prewarmPool(app)");
  const listenIdx = mainSrc.indexOf("await app.listen(");
  assert.ok(prewarmIdx >= 0, "prewarmPool(app) call not found in main.ts");
  assert.ok(listenIdx >= 0, "app.listen() call not found in main.ts");
  assert.ok(prewarmIdx < listenIdx, "prewarm must precede app.listen()");
});

test("main.ts: a failed DB assertion is fatal (process.exit(1) → launchd respawn, not a wedge)", () => {
  // the assertion sits in a try/catch whose catch exits the process, so a DB-down boot cannot
  // silently continue past the gate.
  assert.match(
    mainSrc,
    /assertSessionTimezoneIsUtc\(\)[\s\S]*?catch \(error\)[\s\S]*?process\.exit\(1\)/,
    "the DB assertion must be fatal on failure (process.exit(1))",
  );
});
