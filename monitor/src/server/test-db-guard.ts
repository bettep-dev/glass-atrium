// Refuses a DB connection from a node:test process that test/lib/select-test-db.ts did not
// prepare — a test file's `import "dotenv/config"` otherwise hands the client the live DATABASE_URL.
// Dependency-free so select-test-db.ts can import the marker name without loading the Prisma client.

/** "1" once test/lib/select-test-db.ts has pointed DATABASE_URL at the test database; spawned children inherit it. */
export const TEST_DB_SELECTED_ENV = "MONITOR_TEST_DB_SELECTED";

const SANCTIONED_RUN =
  "MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/<file>.test.ts";

const TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/;

// runner worker (NODE_TEST_CONTEXT) · in-process run (--test-isolation=none) · test file run directly
function isTestProcess(): boolean {
  return (
    process.env.NODE_TEST_CONTEXT !== undefined ||
    process.execArgv.includes("--test") ||
    TEST_FILE_PATTERN.test(process.argv[1] ?? "")
  );
}

/**
 * No-op outside node:test, so the server path never reaches the refusal.
 * @throws Error in a node:test process without the select-test-db marker, naming the sanctioned run form.
 */
export function assertTestDatabaseSelected(): void {
  if (!isTestProcess() || process.env[TEST_DB_SELECTED_ENV] === "1") {
    return;
  }
  throw new Error(
    "[test-db-guard] refusing to connect: this node:test process did not load test/lib/select-test-db.ts, " +
      "so DATABASE_URL may name the live database. " +
      `Run it as \`${SANCTIONED_RUN}\` or through \`npm test\`.`,
  );
}
