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

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { LIVE_URL_ENV, isSameDatabase, isSameServer } from "./lib/select-test-db.js";

// One nonce per run — the marker that must exist HERE and nowhere in the live store.
const RUN_NONCE = `db-isolation-${randomUUID()}`;

let seededId: bigint | null = null;

// Backdated so the probe row cannot occupy a page-1 slot. node:test runs the suite's
// files as concurrent processes against one database, and the doc list is ordered
// newest-first, so a `new Date()` row here would compete for the first page that
// clauded-docs.load-more.e2e.test.ts's seeds assume they own.
//
// The overlap is real under the full suite, not hypothetical: sampling the test database
// during `npm test` puts this row's lifetime inside load-more's seeded window (measured
// at 17.4s into a 27s run whose load-more window spans 11.0s-32.0s). Running the two
// files ALONE hides it — both then start at t=0 and this row is gone ~0.8s before
// load-more seeds — which is why a two-file reproduction is not evidence of safety.
// Ranked against 60 fresh seeds, a `new Date()` row here sorts 1st and takes a page-1
// slot; `new Date(0)` sorts 62nd and takes none.
//
// Nothing about this probe needs a recent timestamp: both assertions below select by
// title, never by position or recency.
const BACKDATED = new Date(0);

before(async () => {
  const created = await getPrisma().claudedDoc.create({
    data: {
      title: RUN_NONCE,
      author: "db-isolation-probe",
      createdAt: BACKDATED,
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

// AC-B0-2 clause 2 — the refusal must compare the DATABASE, not the STRING.
//
// A raw `a === b` refusal is satisfied by any textual difference, so six DSN spellings
// that all resolve to one physical database sail through it with zero isolation. Each
// pair below is a live/test pair a developer can plausibly produce by hand; each one
// must be REFUSED. The cases were written against the raw comparison first and observed
// to fail there — that run is the evidence the guard was actually widened.

// The symlink case owns its fixture rather than borrowing the OS's. `/tmp` is a symlink
// to `/private/tmp` on macOS ONLY: on Linux `/private/tmp` does not exist, so a pair
// written against those two paths asserts nothing there — realpath cannot resolve the
// second spelling, the identities diverge, and the case reds for a reason that has
// nothing to do with the guard. A directory plus a sibling symlink to it reproduces the
// same aliasing on every POSIX system, so the property is now tested wherever the suite
// runs.
const SOCKET_FIXTURE_ROOT = mkdtempSync(join(tmpdir(), "db-isolation-socket-"));
const SOCKET_DIR = join(SOCKET_FIXTURE_ROOT, "socket");
const SOCKET_LINK = join(SOCKET_FIXTURE_ROOT, "socket-alias");

mkdirSync(SOCKET_DIR);
symlinkSync(SOCKET_DIR, SOCKET_LINK, "dir");

after(() => {
  rmSync(SOCKET_FIXTURE_ROOT, { recursive: true, force: true });
});

const SAME_DATABASE_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "an appended non-selecting query parameter",
    "postgresql://bettep@localhost/glass_atrium?host=/tmp",
    "postgresql://bettep@localhost/glass_atrium?host=/tmp&application_name=tests",
  ],
  [
    "localhost spelled as its loopback address",
    "postgresql://bettep@localhost:5432/glass_atrium",
    "postgresql://bettep@127.0.0.1:5432/glass_atrium",
  ],
  [
    "a trailing slash on the database path",
    "postgresql://bettep@localhost/glass_atrium",
    "postgresql://bettep@localhost/glass_atrium/",
  ],
  [
    "an empty password segment",
    "postgresql://bettep@localhost/glass_atrium",
    "postgresql://bettep:@localhost/glass_atrium",
  ],
  [
    "the same socket directory reached through a symlink",
    `postgresql://bettep@localhost/glass_atrium?host=${SOCKET_DIR}`,
    `postgresql://bettep@localhost/glass_atrium?host=${SOCKET_LINK}`,
  ],
  [
    "reordered query parameters",
    "postgresql://bettep@localhost/glass_atrium?host=/tmp&application_name=x",
    "postgresql://bettep@localhost/glass_atrium?application_name=x&host=/tmp",
  ],
];

for (const [label, live, testDsn] of SAME_DATABASE_PAIRS) {
  test(`AC-B0-2(2): refuses ${label} — same database, different spelling`, () => {
    assert.equal(
      isSameDatabase(live, testDsn),
      true,
      `these name one physical database and must be refused:\n  live: ${live}\n  test: ${testDsn}`,
    );
  });
}

// The other half of the contract: a genuinely separate database must still be ALLOWED,
// so the normalization cannot be a blanket `return true` that passes the cases above.

const DISTINCT_DATABASE_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "a different database name",
    "postgresql://bettep@localhost/glass_atrium?host=/tmp",
    "postgresql://bettep@localhost/glass_atrium_test?host=/tmp",
  ],
  [
    "a different socket directory",
    "postgresql://bettep@localhost/glass_atrium?host=/tmp",
    "postgresql://bettep@localhost/glass_atrium?host=/var/run/postgresql",
  ],
  [
    "a different port on the same host",
    "postgresql://bettep@localhost:5432/glass_atrium",
    "postgresql://bettep@localhost:5433/glass_atrium",
  ],
  [
    "a different TCP host",
    "postgresql://bettep@db.internal/glass_atrium",
    "postgresql://bettep@localhost/glass_atrium",
  ],
];

for (const [label, live, testDsn] of DISTINCT_DATABASE_PAIRS) {
  test(`AC-B0-2(2): allows ${label} — genuinely separate databases`, () => {
    assert.equal(
      isSameDatabase(live, testDsn),
      false,
      `these name different databases and must be allowed:\n  live: ${live}\n  test: ${testDsn}`,
    );
  });
}

// An unparseable DSN carries no identity to compare, so the guard falls back to the raw
// string check rather than guessing. Refusing everything unparseable would lock out the
// libpq key=value form the suite has never needed; passing everything would be worse.
test("AC-B0-2(2): an unparseable DSN falls back to the raw string comparison", () => {
  assert.equal(isSameDatabase("host=/tmp dbname=x", "host=/tmp dbname=x"), true);
  assert.equal(isSameDatabase("host=/tmp dbname=x", "host=/tmp dbname=y"), false);
});

// isSameServer gates a write to a second database on the test server, so its refusal
// direction (false) is the safety direction: a blanket `return true` must go red here.
const SERVER_IDENTITY_ROWS: ReadonlyArray<readonly [string, string, string, boolean]> = [
  [
    "another database in the same socket directory is the same server",
    "postgresql://bettep@localhost/glass_atrium_test?host=/tmp",
    "postgresql://bettep@localhost/label_absent?host=/tmp",
    true,
  ],
  [
    "localhost spelled as its loopback address is the same server",
    "postgresql://bettep@localhost:5432/glass_atrium_test",
    "postgresql://bettep@127.0.0.1:5432/label_absent",
    true,
  ],
  [
    "the IPv6 loopback spelling is the same server",
    "postgresql://bettep@[::1]/glass_atrium_test",
    "postgresql://bettep@localhost:5432/label_absent",
    true,
  ],
  [
    "the socket directory reached through a symlink is the same server",
    `postgresql://bettep@localhost/glass_atrium_test?host=${SOCKET_DIR}`,
    `postgresql://bettep@localhost/label_absent?host=${SOCKET_LINK}`,
    true,
  ],
  [
    "another port in the same socket directory is another server",
    "postgresql://bettep@localhost/glass_atrium_test?host=/tmp&port=5432",
    "postgresql://bettep@localhost/label_absent?host=/tmp&port=55999",
    false,
  ],
  [
    "another port on the same TCP host is another server",
    "postgresql://bettep@localhost:5432/glass_atrium_test",
    "postgresql://bettep@localhost:5433/label_absent",
    false,
  ],
  [
    "another socket directory is another server",
    "postgresql://bettep@localhost/glass_atrium_test?host=/tmp",
    "postgresql://bettep@localhost/label_absent?host=/var/run/postgresql",
    false,
  ],
  [
    "a side naming no database is never the same server",
    "postgresql://bettep@localhost/glass_atrium_test?host=/tmp",
    "postgresql://bettep@localhost/?host=/tmp",
    false,
  ],
  [
    "an unparseable side is never the same server, even spelled identically",
    "host=/tmp dbname=x",
    "host=/tmp dbname=x",
    false,
  ],
];

for (const [label, a, b, expected] of SERVER_IDENTITY_ROWS) {
  test(`isSameServer: ${label}`, () => {
    assert.equal(isSameServer(a, b), expected, `\n  a: ${a}\n  b: ${b}`);
  });
}

// The DB client itself refuses a node:test process that select-test-db.ts did not prepare:
// a test file's `import "dotenv/config"` otherwise hands it the live DATABASE_URL. Each row
// runs a child against a throwaway socket that only counts connections, so no row can reach
// a real database, and the child's env carries no inherited database URL.

const MONITOR_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_BIN = join(MONITOR_ROOT, "node_modules", ".bin", "tsx");
const SELECT_TEST_DB = join(MONITOR_ROOT, "test", "lib", "select-test-db.ts");
const SANCTIONED_IMPORT = "--import ./test/lib/select-test-db.ts";

const PROBE_SOURCE = `
import { writeFile } from "node:fs/promises";
const { getPrisma, disconnectPrisma } = await import(${JSON.stringify(
  pathToFileURL(join(MONITOR_ROOT, "src", "server", "db.ts")).href,
)});
let outcome = "connected";
try {
  await getPrisma().$queryRawUnsafe("SELECT 1");
} catch (error) {
  outcome = error instanceof Error ? error.message : String(error);
}
await disconnectPrisma().catch(() => undefined);
await writeFile(process.env.PROBE_OUT ?? "", outcome);
`;

const GUARD_ROOT = mkdtempSync(join(tmpdir(), "db-guard-"));
const PROBE = { testFile: join(GUARD_ROOT, "probe.test.mts"), entry: join(GUARD_ROOT, "probe-entry.mts") };
writeFileSync(PROBE.testFile, PROBE_SOURCE);
writeFileSync(PROBE.entry, PROBE_SOURCE);

after(() => {
  rmSync(GUARD_ROOT, { recursive: true, force: true });
});

// Inherited selection state (this suite's own swapped URL, the live handle, the marker, the
// runner context) would decide the child's outcome for it, so all of it is dropped.
const INHERITED_SELECTION = /DATABASE_URL$|^MONITOR_|^NODE_TEST_CONTEXT$|^NODE_OPTIONS$/;

function getChildEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !INHERITED_SELECTION.test(key)));
  return { ...env, ...extra };
}

interface ProbeRun {
  connections: number;
  outcome: string;
  stderr: string;
}

/** Runs the probe through tsx with `args`, its DATABASE_URL a socket that accepts and drops. */
async function runProbe(args: readonly string[], selectsTestDb: boolean): Promise<ProbeRun> {
  const dir = mkdtempSync(join(GUARD_ROOT, "s"));
  const port = 55431;
  const url = `postgresql://probe@localhost/throwaway?host=${dir}&port=${port}`;
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  server.listen(join(dir, `.s.PGSQL.${port}`));
  await once(server, "listening");

  const out = join(dir, "outcome.txt");
  const urlEnv = { [selectsTestDb ? "MONITOR_TEST_DATABASE_URL" : "DATABASE_URL"]: url };
  const child = spawn(TSX_BIN, args, {
    cwd: GUARD_ROOT,
    env: getChildEnv({ ...urlEnv, PROBE_OUT: out }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await once(child, "exit");
  server.close();
  return { connections, outcome: await readFile(out, "utf8").catch(() => ""), stderr };
}

const RUN_FORM_ROWS: ReadonlyArray<{
  name: string;
  args: readonly string[];
  selectsTestDb: boolean;
  isRefused: boolean;
}> = [
  {
    name: "a standalone --test run is refused",
    args: ["--test", PROBE.testFile],
    selectsTestDb: false,
    isRefused: true,
  },
  {
    name: "a --test run with process isolation off is refused",
    args: ["--test", "--test-isolation=none", PROBE.testFile],
    selectsTestDb: false,
    isRefused: true,
  },
  { name: "a test file run directly is refused", args: [PROBE.testFile], selectsTestDb: false, isRefused: true },
  {
    name: "the sanctioned --import select-test-db run connects",
    args: ["--import", SELECT_TEST_DB, "--test", PROBE.testFile],
    selectsTestDb: true,
    isRefused: false,
  },
  { name: "a non-test entry (the server path) connects", args: [PROBE.entry], selectsTestDb: false, isRefused: false },
];

describe("the DB client under node:test connects only after select-test-db.ts", () => {
  for (const row of RUN_FORM_ROWS) {
    test(row.name, { timeout: 60_000 }, async () => {
      const run = await runProbe(row.args, row.selectsTestDb);
      const detail = `\n  outcome: ${run.outcome}\n  stderr: ${run.stderr}`;
      assert.equal(run.connections > 0, !row.isRefused, `connections: ${run.connections}${detail}`);
      assert.equal(run.outcome.includes(SANCTIONED_IMPORT), row.isRefused, `refusal names the run form${detail}`);
    });
  }
});
