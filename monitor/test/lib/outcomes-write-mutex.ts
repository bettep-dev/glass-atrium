// Cross-file mutex for the suites that seed core.outcomes rows on canonical
// attribution_source values.
//
// Why a lock rather than distinct seed names: attribution_source is a closed CHECK
// vocabulary, and /channel-liveness aggregates the whole table by that column, so a
// suite cannot pick a channel name no sibling suite also seeds. A silence assertion
// is therefore only meaningful while no other writer is inserting on the same names —
// which is a scheduling property, not a naming one. node:test runs files in parallel,
// so participating suites hold this lock for their whole run (seed through cleanup).
//
// The lock lives on its own pg connection: a Prisma pool hands out arbitrary sessions,
// and a session-scoped advisory lock taken on one of them cannot be released on
// another. A crashed suite drops its connection, which releases the lock.
import "dotenv/config";

import { Client } from "pg";

// Fixed key shared by every participating suite; the value itself is arbitrary.
const LOCK_KEY = 771113401;

let holder: Client | null = null;

export async function acquireOutcomesWriteLock(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set; the outcomes write mutex needs its own connection");
  }
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  holder = client;
}

export async function releaseOutcomesWriteLock(): Promise<void> {
  const client = holder;
  holder = null;
  if (!client) return;
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  } finally {
    await client.end();
  }
}
