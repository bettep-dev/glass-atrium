// boot-db-gate.runtime.test.ts — RUNTIME proof that db.ts's connectionTimeoutMillis:5000
// actually BOUNDS a pg connect (STEP 6). The sibling boot-db-gate.unit.test.ts pins the config
// value + main.ts ordering STRUCTURALLY (source text); this file EXECUTES the load-bearing pg-layer
// behaviour the config controls: a connect that would otherwise hang forever is thrown within the
// ceiling. It exercises the SAME pg library db.ts's @prisma/adapter-pg wraps, driven with the exact
// timeout VALUE parsed out of db.ts (so the test cannot drift from the fix). It does NOT import
// db.ts itself — that needs the generated prisma client (src/generated/prisma/), which is absent in
// this checkout and whose generation/installation is out of scope for a read-only unit run.
//
// Run via: tsx --test test/boot-db-gate.runtime.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { unlinkSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const dbSrc = readFileSync(resolve(HERE, "../src/server/db.ts"), "utf8");

// The timeout the runtime tests drive is READ FROM db.ts, tying this proof to the shipped value.
const CONNECT_TIMEOUT_MS = (() => {
  const m = dbSrc.match(/connectionTimeoutMillis:\s*(\d+)/);
  assert.ok(m, "connectionTimeoutMillis not found in db.ts");
  return Number(m[1]);
})();

test("db.ts config value: connectionTimeoutMillis is a bounded positive (5000), not unset/0", () => {
  assert.equal(CONNECT_TIMEOUT_MS, 5000, "the fix pins a 5s ceiling; 0/unset = unbounded connect");
});

test("pg connect to a NONEXISTENT /tmp socket rejects fast (well within the ceiling), never hangs", async () => {
  const port = 59431; // /tmp/.s.PGSQL.59431 — no such socket file exists
  const sock = `/tmp/.s.PGSQL.${port}`;
  if (existsSync(sock)) unlinkSync(sock);
  const pool = new pg.Pool({
    host: "/tmp",
    port,
    database: "postgres",
    user: "nobody",
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  const t0 = Date.now();
  let rejected = false;
  try {
    await pool.query("SELECT 1");
  } catch {
    rejected = true;
  }
  const elapsed = Date.now() - t0;
  await pool.end().catch(() => {});
  assert.ok(rejected, "a missing socket must reject, not resolve");
  assert.ok(
    elapsed < CONNECT_TIMEOUT_MS,
    `ENOENT should reject fast (${elapsed}ms), well under the ${CONNECT_TIMEOUT_MS}ms ceiling`,
  );
});

test("pg connect to a STALLED socket (accepts, never speaks) is BOUNDED by the ceiling (no infinite hang)", { timeout: 20000 }, async () => {
  const port = 59432;
  const sockPath = `/tmp/.s.PGSQL.${port}`;
  if (existsSync(sockPath)) unlinkSync(sockPath);
  // a unix-socket server that ACCEPTS the connection then never sends a byte — the exact wedge an
  // unbounded connect would hang on forever (a still-booting cluster that has bound the socket but
  // is not yet answering the startup handshake). Track accepted sockets so cleanup can destroy them
  // (server.close alone waits on the still-open stalled connection and would itself hang).
  const accepted: net.Socket[] = [];
  const server = net.createServer((s) => {
    accepted.push(s); // hold the connection open; send nothing
  });
  await new Promise<void>((res) => server.listen(sockPath, res));

  const pool = new pg.Pool({
    host: "/tmp",
    port,
    database: "postgres",
    user: "nobody",
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  const t0 = Date.now();
  let err: Error | null = null;
  try {
    await pool.query("SELECT 1");
  } catch (e) {
    err = e as Error;
  }
  const elapsed = Date.now() - t0;
  await pool.end().catch(() => {});
  for (const s of accepted) s.destroy();
  server.close();
  if (existsSync(sockPath)) unlinkSync(sockPath);

  assert.ok(err, "the stalled connect must reject (timeout), not resolve or hang");
  // BOUNDED: rejects at ~ceiling, not immediately (proves the timeout is what cut it) and not
  // unboundedly (the whole point of the fix). Generous window to absorb CI jitter.
  assert.ok(
    elapsed >= CONNECT_TIMEOUT_MS - 1500 && elapsed <= CONNECT_TIMEOUT_MS + 4000,
    `stalled connect must be bounded by ~${CONNECT_TIMEOUT_MS}ms (got ${elapsed}ms) — not 0, not ∞`,
  );
});
