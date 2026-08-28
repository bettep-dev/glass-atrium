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

import { realpathSync } from "node:fs";

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

// --- DSN identity -----------------------------------------------------------------
//
// Two connection strings select the same physical database when three things agree:
// where the server is reached (a TCP host or a Unix socket DIRECTORY), which port, and
// which database name. Everything else in a DSN — user, password, application_name, the
// order of the query parameters — selects nothing, so it is dropped before comparing.
//
// Declared above the guard rather than below it: the guard runs at module top level and
// these bindings are `const`, so the same code placed underneath would crash in the
// temporal dead zone.

/** Spellings of the loopback interface, all naming one host. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

/** libpq's default when a DSN names no port. */
const DEFAULT_PORT = "5432";

/** Field separator — a space cannot occur in a normalized host, port or database name. */
const IDENTITY_SEP = " ";

function decodeOrRaw(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is not ours to repair — compare it as written.
    return value;
  }
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (trimmed.length === 0) return "";

  if (trimmed.startsWith("/")) {
    // A socket directory, and `/tmp` is a symlink to `/private/tmp` on macOS — the two
    // spellings reach one socket, so resolve before comparing. A path that does not
    // exist cannot be resolved and is compared as written.
    const stripped = trimmed.replace(/\/+$/, "") || "/";
    try {
      return realpathSync(stripped);
    } catch {
      return stripped;
    }
  }

  return LOOPBACK_HOSTS.has(trimmed) ? "localhost" : trimmed;
}

/**
 * The (host, port, database) triple a DSN resolves to, or `null` when the string is not
 * a URL-form postgres DSN this can parse.
 */
function dsnIdentity(dsn: string): string | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") return null;

  // libpq lets the query string override the authority, and a socket-form DSN relies on
  // exactly that: the authority carries a placeholder `localhost` while `?host=/tmp` is
  // what actually selects the server.
  const params = url.searchParams;
  const host = normalizeHost(params.get("host") ?? decodeOrRaw(url.hostname));
  const port = params.get("port") ?? url.port;
  const database = decodeOrRaw(params.get("dbname") ?? url.pathname)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  // No database name selects no database — nothing to compare.
  if (database.length === 0) return null;

  return [host, port.length === 0 ? DEFAULT_PORT : port, database].join(IDENTITY_SEP);
}

/**
 * Whether two connection strings reach the same physical database. Used by the guard
 * below to refuse a test DSN that is merely a re-spelling of the live one.
 *
 * Falls back to the raw string comparison when either side has no parseable identity:
 * the libpq `key=value` form the suite has never used would otherwise be either
 * blanket-refused or blanket-allowed, and neither is honest about what was checked.
 */
export function isSameDatabase(a: string, b: string): boolean {
  if (a === b) return true;

  const left = dsnIdentity(a);
  const right = dsnIdentity(b);
  if (left === null || right === null) return false;

  return left === right;
}

const liveUrl = process.env.DATABASE_URL;
const testUrl = process.env[TEST_URL_ENV];

if (typeof testUrl !== "string" || testUrl.length === 0) {
  fail(`${TEST_URL_ENV} is not set — refusing to run the suite against ${liveUrl ? "the live database" : "no database"}.`);
}

if (liveUrl !== undefined && isSameDatabase(liveUrl, testUrl)) {
  // Naming the live store as the test store is the silent live fallback wearing the
  // guard's own clothes. A raw `===` would catch only the spelling a developer is least
  // likely to produce: every hand-typed variant of one DSN — an appended
  // `application_name`, `127.0.0.1` for `localhost`, a trailing slash, `?host=/private/tmp`
  // for `?host=/tmp` — is textually different and physically identical, so the comparison
  // runs on the resolved identity instead (see `isSameDatabase`).
  fail(`${TEST_URL_ENV} names the same database as the live DATABASE_URL — that is not isolation.`);
}

// Keep the live handle addressable (never printed) so the isolation probe can assert
// the absence of this run's rows THERE while the suite writes HERE.
if (liveUrl !== undefined && liveUrl.length > 0) {
  process.env[LIVE_URL_ENV] = liveUrl;
}

process.env.DATABASE_URL = testUrl;
