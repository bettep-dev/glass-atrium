// Test-run database selection — loaded via `--import` from the `test` npm script, so it
// runs in every node:test worker BEFORE any test file (and therefore before any
// `getPrisma()` call) is evaluated.
//
// Why an entry script rather than "just export DATABASE_URL": exporting the variable
// alone selects the right database but leaves two of the three AC-B0-2 clauses unmet.
// This script adds them —
//   - it FAILS LOUDLY when the test database is unset, instead of falling through to
//     whatever `.env` provides (which is the live store, silently);
//   - it preserves the live connection string under a second name so the isolation
//     probe has something to check the live store WITH.
//
// It changes no connection code: `src/server/db.ts` still reads `DATABASE_URL` and
// nothing else, and dotenv does not overwrite an already-set key, so a value installed
// here survives every test file's `import "dotenv/config"`.

import "dotenv/config";

/** Set by this script from the pre-swap value — the isolation probe's live handle. */
export const LIVE_URL_ENV = "MONITOR_LIVE_DATABASE_URL";

/** The one sanctioned way to point the suite at a database. */
export const TEST_URL_ENV = "MONITOR_TEST_DATABASE_URL";

const HOWTO =
  `Set ${TEST_URL_ENV} to a test-only database before running the suite, e.g.\n` +
  `  createdb -h /tmp glass_atrium_test\n` +
  `  DATABASE_URL="postgresql://$(id -un)@localhost/glass_atrium_test?host=/tmp" npx prisma migrate deploy\n` +
  `  ${TEST_URL_ENV}="postgresql://$(id -un)@localhost/glass_atrium_test?host=/tmp" npm test`;

function fail(reason: string): never {
  // Thrown, not logged-and-continued: a test run that reaches the live store is the
  // failure this guard exists to prevent, so there is no degraded mode to fall back to.
  throw new Error(`[select-test-db] ${reason}\n\n${HOWTO}\n`);
}

const liveUrl = process.env.DATABASE_URL;
const testUrl = process.env[TEST_URL_ENV];

if (typeof testUrl !== "string" || testUrl.length === 0) {
  fail(`${TEST_URL_ENV} is not set — refusing to run the suite against ${liveUrl ? "the live database" : "no database"}.`);
}

if (liveUrl !== undefined && liveUrl === testUrl) {
  // Naming the live store as the test store is the silent live fallback wearing the
  // guard's own clothes — the one bypass a presence check would let through.
  fail(`${TEST_URL_ENV} is identical to the live DATABASE_URL — that is not isolation.`);
}

// Keep the live handle addressable (never printed) so the isolation probe can assert
// the absence of this run's rows THERE while the suite writes HERE.
if (liveUrl !== undefined && liveUrl.length > 0) {
  process.env[LIVE_URL_ENV] = liveUrl;
}

process.env.DATABASE_URL = testUrl;
