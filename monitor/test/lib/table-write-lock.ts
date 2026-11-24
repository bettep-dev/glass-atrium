// Cross-file mutex for suites that assert a count over a whole shared table while sibling suites seed it.
//
// Why a lock rather than distinct seed names: the route under test aggregates every row, so a sibling's
// seed or cleanup between a suite's reads skews its count whatever the seed is named. node:test runs files
// in parallel, so each participating suite holds its table's lock for its whole run (seed through cleanup).
//   - outcomes: attribution_source is a closed CHECK vocabulary that /channel-liveness aggregates by
//   - learning-log: /improvement/learning-log reads the pending and parked totals ungated
//
// The lock lives on its own pg connection: a Prisma pool hands out arbitrary sessions, and a session-scoped
// advisory lock taken on one of them cannot be released on another. A crashed suite drops its connection,
// which releases the lock.
import "dotenv/config";

import { Client } from "pg";

import { assertTestDatabaseSelected } from "../../src/server/test-db-guard.js";

// Fixed keys shared by every participating suite; the values are arbitrary, and 771113402 is queue-rows-lock's
const LOCK_KEYS = {
  outcomes: 771113401,
  "learning-log": 771113403,
} as const;

type LockedTable = keyof typeof LOCK_KEYS;

const holders = new Map<LockedTable, Client>();

export async function lockTableWrites(table: LockedTable): Promise<void> {
  assertTestDatabaseSelected();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(`DATABASE_URL is not set; the ${table} write lock needs its own connection`);
  }
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEYS[table]]);
  holders.set(table, client);
}

export async function unlockTableWrites(table: LockedTable): Promise<void> {
  const client = holders.get(table);
  holders.delete(table);
  if (!client) return;
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEYS[table]]);
  } finally {
    await client.end();
  }
}
