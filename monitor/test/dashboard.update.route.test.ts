// POST /api/dashboard/update (single atomic apply) + GET /api/dashboard/update-job.
// Exercises the routes INSIDE registerDashboardRoutes (routes/index.ts untouched)
// against real Postgres, with ALL side effects seamed:
//   - scripts/update.sh          → a mode-aware bash stub (ATRIUM_UPDATE_SCRIPT) that
//                                   logs every argv it receives, serves --render-oneshot,
//                                   and exits 2 loudly on any other flag. --headless is
//                                   never expected from the route.
//   - launchctl                  → a stub that logs its argv (ATRIUM_UPDATE_LAUNCHCTL).
//   - claude binary resolution   → ATRIUM_UPDATE_CLAUDE_BIN (authoritative when set).
// No real update / launchctl / restart is triggered. Route-created rows carry the
// reservation placeholder in target_version, so they are isolated by their id (captured
// from the response or read back) and by a per-suite start instant; the two rows the
// suite inserts by hand carry a per-suite marker.
//
// Runner: npx tsx --test test/dashboard.update.route.test.ts

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerDashboardRoutes } from "../src/server/routes/dashboard.js";

const MARKER = `dashupd-${randomUUID().slice(0, 8)}`;
const VERSION = `9.9.9-${MARKER}`;

// The placeholder the route reserves with (the decoupled job overwrites it).
const PENDING_VERSION = "pending";

let app: FastifyInstance;
let stubDir: string;
let launchctlLog: string;
let updateArgvLog: string;
let headlessSentinel: string;
let oneshotPlist: string;
let updateStub: string;
let dbReady = false;

// Every row this suite creates through the route, so cleanup never keys on a
// placeholder another run could share.
const createdJobIds: bigint[] = [];

before(async () => {
  stubDir = mkdtempSync(path.join(tmpdir(), "dashboard-update-stub-"));
  launchctlLog = path.join(stubDir, "launchctl.log");
  updateArgvLog = path.join(stubDir, "update-argv.log");
  headlessSentinel = path.join(stubDir, "headless-called");
  oneshotPlist = path.join(stubDir, "com.glass-atrium.update-oneshot.plist");

  // Mode-aware update.sh stub. Reads STUB_* env inherited from the test process, and
  // records each argv so a probe can assert which flags the route actually invoked.
  updateStub = path.join(stubDir, "update.sh");
  writeFileSync(
    updateStub,
    `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "\${STUB_UPDATE_ARGV_LOG}"
case "$1" in
  --render-oneshot)
    out="\${ATRIUM_UPDATE_ONESHOT_PLIST}"
    mkdir -p "$(dirname "\${out}")"
    cat > "\${out}" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.glass-atrium.update-oneshot</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>/tmp</string>
		<key>PATH</key>
		<string>/usr/bin:/bin</string>
	</dict>
</dict>
</plist>
PLIST
    printf '%s\\n' "\${out}"
    exit 0
    ;;
  --headless)
    printf 'called' > "\${STUB_HEADLESS_SENTINEL:-/dev/null}"
    exit 0
    ;;
  *)
    printf 'update.sh stub: unsupported flag %s\\n' "$1" >&2
    exit 2
    ;;
esac
`,
    "utf8",
  );
  chmodSync(updateStub, 0o755);

  // launchctl stub — append each invocation's argv; exit STUB_LAUNCHCTL_EXIT.
  const launchctlStub = path.join(stubDir, "launchctl");
  writeFileSync(
    launchctlStub,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(launchctlLog)}\nexit "\${STUB_LAUNCHCTL_EXIT:-0}"\n`,
    "utf8",
  );
  chmodSync(launchctlStub, 0o755);

  process.env.ATRIUM_UPDATE_SCRIPT = updateStub;
  process.env.ATRIUM_UPDATE_LAUNCHCTL = launchctlStub;
  process.env.ATRIUM_UPDATE_ONESHOT_PLIST = oneshotPlist;
  process.env.STUB_HEADLESS_SENTINEL = headlessSentinel;
  process.env.STUB_LAUNCHCTL_LOG = launchctlLog;
  process.env.STUB_UPDATE_ARGV_LOG = updateArgvLog;

  app = Fastify({ logger: false });
  await registerDashboardRoutes(app);
  await app.ready();

  try {
    // Probe the table exists (P3-T1 migrate deploy) + DB reachable.
    await getPrisma().updateJob.count();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[dashboard-update] DB unavailable — DB-dependent tests will skip:", error);
  }
});

after(async () => {
  for (const key of [
    "ATRIUM_UPDATE_SCRIPT",
    "ATRIUM_UPDATE_LAUNCHCTL",
    "ATRIUM_UPDATE_ONESHOT_PLIST",
    "ATRIUM_UPDATE_CLAUDE_BIN",
    "STUB_HEADLESS_SENTINEL",
    "STUB_LAUNCHCTL_LOG",
    "STUB_LAUNCHCTL_EXIT",
    "STUB_UPDATE_ARGV_LOG",
    "ATRIUM_UPDATE_STALE_MS",
  ]) {
    delete process.env[key];
  }
  if (dbReady) {
    try {
      await scrubJobs();
    } catch (error) {
      console.error("[dashboard-update cleanup] DB scrub failed:", error);
    }
  }
  try {
    await app.close();
  } catch {
    // best-effort
  }
  await disconnectPrisma();
  if (stubDir) {
    rmSync(stubDir, { recursive: true, force: true });
  }
});

// Drop this suite's rows: the hand-inserted marker rows plus every id the suite
// captured. A row this suite never touched is never matched.
async function scrubJobs(): Promise<void> {
  await getPrisma().updateJob.deleteMany({
    where: { OR: [{ targetVersion: { contains: MARKER } }, { id: { in: createdJobIds } }] },
  });
  createdJobIds.length = 0;
}

beforeEach(async () => {
  process.env.STUB_LAUNCHCTL_EXIT = "0";
  process.env.ATRIUM_UPDATE_CLAUDE_BIN = updateStub; // resolvable executable default
  delete process.env.ATRIUM_UPDATE_STALE_MS;
  rmSync(headlessSentinel, { force: true });
  rmSync(launchctlLog, { force: true });
  rmSync(updateArgvLog, { force: true });
  if (dbReady) {
    await scrubJobs();
  }
});

// A foreign (non-suite) in-progress row would trip the table-wide single-active
// index and confound the DB tests — detect it so those tests skip rather than fail.
async function foreignInProgress(): Promise<boolean> {
  const rows = await getPrisma().$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM core.update_job
    WHERE status = 'in-progress'::core."UpdateJobStatus"
  `;
  const mine = new Set(createdJobIds.map((id) => id.toString()));
  return rows.some((row) => !mine.has(row.id));
}

// Rows the route reserved after `since`. The reservation carries the placeholder
// version, so the instant is what scopes the read to this test; each id found is
// registered for cleanup.
async function reservedRows(since: Date): Promise<Array<{ id: string; status: string }>> {
  const rows = await getPrisma().$queryRaw<Array<{ id: string; status: string }>>`
    SELECT id::text AS id, status::text AS status FROM core.update_job
    WHERE target_version = ${PENDING_VERSION} AND started_at >= ${since}
    ORDER BY id
  `;
  for (const row of rows) {
    createdJobIds.push(BigInt(row.id));
  }
  return rows;
}

async function apply(): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/dashboard/update",
    payload: { mode: "apply" },
  });
  const body = res.json() as Record<string, unknown>;
  if (typeof body.job_id === "number") {
    createdJobIds.push(BigInt(body.job_id));
  }
  return { statusCode: res.statusCode, body };
}

// ---------------------------------------------------------------------------
// Structural: both routes are registered INSIDE registerDashboardRoutes (the test
// registers only that registrar — routes/index.ts barrel is never invoked).
// ---------------------------------------------------------------------------
test("routes registered inside registerDashboardRoutes (not 404)", async () => {
  const post = await app.inject({ method: "POST", url: "/api/dashboard/update", payload: {} });
  assert.notStrictEqual(post.statusCode, 404, "POST /api/dashboard/update is registered");
  const get = await app.inject({ method: "GET", url: "/api/dashboard/update-job" });
  assert.notStrictEqual(get.statusCode, 404, "GET /api/dashboard/update-job is registered");
});

// ---------------------------------------------------------------------------
// Manual body validation (NO Zod) — 400 invalid_body. Only mode:'apply' is valid;
// the two-step modes are rejected at the boundary.
// ---------------------------------------------------------------------------
test("validation: non-object body → 400 invalid_body(field=body)", async () => {
  const res = await app.inject({ method: "POST", url: "/api/dashboard/update", payload: [] });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.json(), { error: "invalid_body", field: "body", reason: "must be a JSON object" });
});

test("validation: unknown mode → 400 invalid_body(field=mode)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/dashboard/update",
    payload: { mode: "nope" },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual((res.json() as { field: string }).field, "mode");
});

test("validation: two-step mode 'preview' → 400 invalid_body(field=mode)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/dashboard/update",
    payload: { mode: "preview" },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual((res.json() as { field: string }).field, "mode");
});

test("validation: two-step mode 'commit' → 400 invalid_body(field=mode)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/dashboard/update",
    payload: { mode: "commit", confirm: "a".repeat(64) },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual((res.json() as { field: string }).field, "mode");
});

// ---------------------------------------------------------------------------
// apply → enqueued: reserve the row AND enqueue the DECOUPLED job atomically. The
// route returns immediately; update.sh --headless is NEVER run by the route, and the
// job id is written into the one-shot plist env so the decoupled job adopts the row.
// ---------------------------------------------------------------------------
test("apply enqueued: 200 enqueued, row reserved, launchd bootstrap, NO --headless, job id in plist", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");

  const { statusCode, body } = await apply();
  assert.strictEqual(statusCode, 200);
  assert.strictEqual(body.mode, "apply");
  assert.strictEqual(body.status, "enqueued");
  assert.strictEqual(body.target_version, PENDING_VERSION);
  assert.strictEqual(typeof body.job_id, "number");

  const jobId = body.job_id as number;

  const rows = await getPrisma().$queryRaw<Array<{ status: string; target_version: string }>>`
    SELECT status::text AS status, target_version FROM core.update_job
    WHERE id = ${BigInt(jobId)}
  `;
  assert.strictEqual(rows[0]!.status, "in-progress");
  assert.strictEqual(rows[0]!.target_version, PENDING_VERSION);

  // The route enqueued via launchctl bootstrap (decoupled) — it did NOT run the
  // long apply itself (update.sh --headless is never invoked by the route).
  assert.ok(!existsSync(headlessSentinel), "update.sh --headless MUST NOT be run by the route");
  const launchctlCalls = readFileSync(launchctlLog, "utf8");
  assert.match(launchctlCalls, /bootstrap gui\/\d+ /, "launchctl bootstrap invoked");

  // The one-shot plist carries the injected job id so the decoupled job adopts the row.
  const plist = readFileSync(oneshotPlist, "utf8");
  assert.match(plist, /<key>ATRIUM_UPDATE_JOB_ID<\/key>\s*<string>\d+<\/string>/);
  assert.match(plist, new RegExp(`<string>${jobId}</string>`));
});

// The stub exits 2 on any flag it does not serve, so an apply that reached a removed
// flag would fail the call. Assert the argv log directly as well: the whole updater
// contract the route drives is one --render-oneshot.
test("apply enqueued: the route invokes update.sh with --render-oneshot and nothing else", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");

  const { statusCode } = await apply();
  assert.strictEqual(statusCode, 200, "apply succeeds against a stub that rejects unserved flags");

  const argv = readFileSync(updateArgvLog, "utf8").trim().split("\n");
  assert.deepStrictEqual(argv, ["--render-oneshot"], "one updater invocation, --render-oneshot");
});

// ---------------------------------------------------------------------------
// Single-active: the 2nd concurrent apply trips the partial UNIQUE INDEX (no
// INSERT...WHERE NOT EXISTS) → 409 single_active, exactly ONE in-progress row.
// ---------------------------------------------------------------------------
test("single-active: 2nd apply → 409 single_active (partial-unique, no row churn)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");
  const since = new Date();

  const first = await apply();
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(first.body.status, "enqueued");

  const second = await apply();
  assert.strictEqual(second.statusCode, 409);
  assert.strictEqual((second.body as { error: string }).error, "single_active");

  const rows = await reservedRows(since);
  const inProgress = rows.filter((row) => row.status === "in-progress");
  assert.strictEqual(inProgress.length, 1, "exactly one in-progress row (2nd INSERT rejected)");
});

// ---------------------------------------------------------------------------
// Stale sweep: a stale in-progress row is WHERE-guard-flipped to failed so a new
// apply can reserve; a FRESH in-progress row is never swept.
// ---------------------------------------------------------------------------
test("stale sweep: stale in-progress flipped to failed, new apply reserves", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");

  const prisma = getPrisma();
  const staleVersion = `stale-${VERSION}`;
  const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO core.update_job (status, started_at, heartbeat_at, target_version)
    VALUES ('in-progress'::core."UpdateJobStatus", now() - interval '2 hours',
            now() - interval '2 hours', ${staleVersion})
    RETURNING id::text AS id
  `;
  const staleId = inserted[0]!.id;

  const { statusCode, body } = await apply();
  assert.strictEqual(statusCode, 200, "new apply reserves after the stale sweep");
  assert.strictEqual(body.status, "enqueued");

  const swept = await prisma.$queryRaw<Array<{ status: string }>>`
    SELECT status::text AS status FROM core.update_job WHERE id = ${BigInt(staleId)}
  `;
  assert.strictEqual(swept[0]!.status, "failed", "stale row WHERE-guard-flipped to failed");
});

test("stale sweep: a FRESH in-progress row is NOT swept (blocks new apply)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");

  const prisma = getPrisma();
  const freshVersion = `fresh-${VERSION}`;
  const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO core.update_job (status, started_at, heartbeat_at, target_version)
    VALUES ('in-progress'::core."UpdateJobStatus", now(), now(), ${freshVersion})
    RETURNING id::text AS id
  `;
  const freshId = inserted[0]!.id;

  const { statusCode, body } = await apply();
  assert.strictEqual(statusCode, 409);
  assert.strictEqual((body as { error: string }).error, "single_active");

  const still = await prisma.$queryRaw<Array<{ status: string }>>`
    SELECT status::text AS status FROM core.update_job WHERE id = ${BigInt(freshId)}
  `;
  assert.strictEqual(still[0]!.status, "in-progress", "fresh heartbeat not clobbered");
});

// ---------------------------------------------------------------------------
// apply claude precondition: an unresolvable claude → loud-fail BEFORE reserving,
// so no row is created and no enqueue is attempted.
// ---------------------------------------------------------------------------
test("apply: claude unresolvable → 500 claude_unresolved + no row + no enqueue", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");
  const since = new Date();
  process.env.ATRIUM_UPDATE_CLAUDE_BIN = path.join(stubDir, "no-such-claude");

  const { statusCode, body } = await apply();
  assert.strictEqual(statusCode, 500);
  assert.strictEqual((body as { error: string }).error, "claude_unresolved");
  assert.ok(!existsSync(launchctlLog), "no launchctl enqueue on claude precondition fail");
  assert.ok(!existsSync(updateArgvLog), "update.sh not invoked when the precondition fails");

  const rows = await reservedRows(since);
  assert.strictEqual(rows.length, 0, "no row reserved when claude precondition fails");
});

// ---------------------------------------------------------------------------
// apply enqueue failure: launchctl bootstrap non-zero → 500 enqueue_failed and the
// reserved row is marked failed (frees the single-active slot).
// ---------------------------------------------------------------------------
test("apply: launchctl bootstrap failure → 500 enqueue_failed + row failed", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");
  const since = new Date();
  process.env.STUB_LAUNCHCTL_EXIT = "1";

  const { statusCode, body } = await apply();
  assert.strictEqual(statusCode, 500);
  assert.strictEqual((body as { error: string }).error, "enqueue_failed");

  const rows = await reservedRows(since);
  assert.strictEqual(rows.length, 1, "the reserved row exists");
  assert.strictEqual(rows[0]!.status, "failed", "enqueue-failed row marked failed");
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/update-job — latest job row projection (UNCHANGED contract).
// ---------------------------------------------------------------------------
test("status GET: exposes status + heartbeat + failure_reason of the latest job", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");

  const enqueued = await apply();
  assert.strictEqual(enqueued.statusCode, 200);
  const jobId = enqueued.body.job_id as number;

  const res = await app.inject({ method: "GET", url: "/api/dashboard/update-job" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.strictEqual(body.status, "in-progress");
  assert.strictEqual(body.id, jobId);
  assert.strictEqual(body.target_version, PENDING_VERSION);
  assert.strictEqual(typeof body.started_at, "string");
  assert.strictEqual(typeof body.heartbeat_at, "string");
  assert.strictEqual(body.failure_reason, null);
});
