// AC-B0-2 clause 1 — proves the suite's RESOLVED connection target is not the live store.
//
// The obvious form of this check (live row COUNT before == after) cannot go red: every
// seeding suite already deletes its own rows in after(), so the counts match whether or
// not the run touched the live database. This asserts the stronger, falsifiable thing —
// while THIS run is creating a nonce-marked row through the app's own client, the live
// store contains no row carrying that nonce.
//
// How it fails if isolation breaks: with DATABASE_URL resolved to the live store, the
// row below lands there and the live query finds it. Verified by deliberately pointing
// MONITOR_TEST_DATABASE_URL at the live database — the run goes red here.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import pg from "pg";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { LIVE_URL_ENV } from "./lib/select-test-db.js";

// One nonce per run — the marker that must exist HERE and nowhere in the live store.
const RUN_NONCE = `db-isolation-${randomUUID()}`;

let seededId: bigint | null = null;

before(async () => {
  const created = await getPrisma().claudedDoc.create({
    data: {
      title: RUN_NONCE,
      author: "db-isolation-probe",
      createdAt: new Date(),
      contentHash: "0".repeat(64),
      htmlPath: `/dev/null/${RUN_NONCE}.html`,
      indexableText: RUN_NONCE,
    },
    select: { id: true },
  });
  seededId = created.id;
});

after(async () => {
  if (seededId !== null) {
    await getPrisma().claudedDoc.delete({ where: { id: seededId } });
  }
  // The client keeps a warm pool (min: 1, idleTimeoutMillis: 0), so without this the
  // worker process never exits — and `--test-timeout=0` means it hangs rather than fails.
  await disconnectPrisma();
});

test("AC-B0-2(1): the suite's resolved database holds this run's nonce row", async () => {
  const rows = await getPrisma().claudedDoc.count({ where: { title: RUN_NONCE } });
  assert.equal(rows, 1, "the run must have written its nonce row to the database it resolved");
});

test("AC-B0-2(1): the LIVE store holds no row from this run", async (t) => {
  const liveUrl = process.env[LIVE_URL_ENV];
  if (liveUrl === undefined || liveUrl.length === 0) {
    // No live connection string was present to preserve, so there is no live store to
    // check. Skipped rather than passed: a green here would claim a proof never made.
    t.skip(`${LIVE_URL_ENV} is unset — no live store to compare against`);
    return;
  }

  const pool = new pg.Pool({ connectionString: liveUrl, connectionTimeoutMillis: 5000, max: 1 });
  try {
    const live = await pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM monitor.documents WHERE title = $1",
      [RUN_NONCE],
    );
    assert.equal(
      live.rows[0]?.n,
      "0",
      "this run's nonce reached the live store — the suite is not isolated from it",
    );
  } finally {
    await pool.end();
  }
});
