// Cross-file lock for GET /api/queue/count, which counts every open and deviation item database-wide: node:test runs
// files in parallel, so a neighbour's commit between the count test's two reads would skew its delta.
// Suites committing queue items hold it shared for their whole run (seed through cleanup); the count test alone
// takes it exclusive, on the same connection as its own shared hold → a second exclusive taker would deadlock.
// Own pg connection: a session-scoped advisory lock taken on a pooled Prisma session cannot be released on another.
import "dotenv/config";

import { Client } from "pg";

import { assertTestDatabaseSelected } from "../../src/server/test-db-guard.js";

// Fixed key shared by every participating suite; the value itself is arbitrary
const LOCK_KEY = 771113402;

let holder: Client | null = null;

export async function lockQueueRows(): Promise<void> {
  assertTestDatabaseSelected();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set; the queue rows lock needs its own connection");
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("SELECT pg_advisory_lock_shared($1)", [LOCK_KEY]);
  holder = client;
}

/** Runs `work` once no other suite holds queue items; only between lockQueueRows and unlockQueueRows. */
export async function withQueueRowsExclusive<T>(work: () => Promise<T>): Promise<T> {
  const client = holder;
  if (client === null) throw new Error("withQueueRowsExclusive called without lockQueueRows");
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    return await work();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

export async function unlockQueueRows(): Promise<void> {
  const client = holder;
  holder = null;
  if (client === null) return;
  try {
    await client.query("SELECT pg_advisory_unlock_shared($1)", [LOCK_KEY]);
  } finally {
    await client.end();
  }
}
