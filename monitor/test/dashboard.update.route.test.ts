// P3-T3 — POST /api/dashboard/update (single atomic apply) + GET
// /api/dashboard/update-job. Exercises the routes INSIDE registerDashboardRoutes
// (routes/index.ts untouched) against real Postgres, with ALL side effects seamed:
//   - scripts/update.sh          → a mode-aware bash stub (ATRIUM_UPDATE_SCRIPT):
//                                   --preview emits a canned gate-diff, --render-oneshot
//                                   writes a base plist, --headless is NEVER expected.
//   - launchctl                  → a stub that logs its argv (ATRIUM_UPDATE_LAUNCHCTL).
//   - claude binary resolution   → ATRIUM_UPDATE_CLAUDE_BIN (authoritative when set).
//   - confirm gate               → apply injects ATRIUM_UPDATE_CONFIRM_ANSWER=yes into
//                                   the plist env (no-TTY decoupled job); every other
//                                   outcome (up_to_date / single_active / claude_unresolved)
//                                   never touches the plist.
// No real update / launchctl / restart is triggered. update_job rows are isolated
// by a per-suite marker embedded in target_version and scrubbed in after().
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

// Two-file canned --preview stdout in the apply-gate.sh gate_render_diff format
// (`=== <path> ===`, optional new-file marker, unified-diff body, blank line).
const DIFF_A = [
  "=== install.sh ===",
  "--- a/install.sh",
  "+++ b/install.sh",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
  "=== monitor/new-file.txt ===",
  "(new file — no current version)",
  "--- /dev/null",
  "+++ b/monitor/new-file.txt",
  "@@ -0,0 +1 @@",
  "+hello",
  "",
].join("\n");

let app: FastifyInstance;
let stubDir: string;
let stdoutFile: string;
let launchctlLog: string;
let headlessSentinel: string;
let oneshotPlist: string;
let updateStub: string;
let dbReady = false;

before(async () => {
  stubDir = mkdtempSync(path.join(tmpdir(), "dashboard-update-stub-"));
  stdoutFile = path.join(stubDir, "preview-stdout.txt");
  launchctlLog = path.join(stubDir, "launchctl.log");
  headlessSentinel = path.join(stubDir, "headless-called");
  oneshotPlist = path.join(stubDir, "com.glass-atrium.update-oneshot.plist");

  // Mode-aware update.sh stub. Reads STUB_* env inherited from the test process.
  updateStub = path.join(stubDir, "update.sh");
  writeFileSync(
    updateStub,
    `#!/usr/bin/env bash
set -u
case "$1" in
  --preview)
    if [[ -n "\${STUB_PREVIEW_STDOUT_FILE:-}" && -f "\${STUB_PREVIEW_STDOUT_FILE}" ]]; then
      cat "\${STUB_PREVIEW_STDOUT_FILE}"
    fi
    printf 'preview: dry-run diff for release version %s\\n' "\${STUB_PREVIEW_VERSION:-0.0.0}" >&2
    exit "\${STUB_PREVIEW_EXIT:-0}"
    ;;
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

  writeFileSync(stdoutFile, DIFF_A, "utf8");

  process.env.ATRIUM_UPDATE_SCRIPT = updateStub;
  process.env.ATRIUM_UPDATE_LAUNCHCTL = launchctlStub;
  process.env.ATRIUM_UPDATE_ONESHOT_PLIST = oneshotPlist;
  process.env.STUB_PREVIEW_STDOUT_FILE = stdoutFile;
  process.env.STUB_PREVIEW_VERSION = VERSION;
  process.env.STUB_HEADLESS_SENTINEL = headlessSentinel;
  process.env.STUB_LAUNCHCTL_LOG = launchctlLog;

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
    "STUB_PREVIEW_STDOUT_FILE",
    "STUB_PREVIEW_VERSION",
    "STUB_PREVIEW_EXIT",
    "STUB_HEADLESS_SENTINEL",
    "STUB_LAUNCHCTL_LOG",
    "STUB_LAUNCHCTL_EXIT",
    "ATRIUM_UPDATE_STALE_MS",
  ]) {
    delete process.env[key];
  }
  if (dbReady) {
    try {
      await getPrisma().$executeRaw`
        DELETE FROM core.update_job WHERE target_version LIKE ${`%${MARKER}%`}
      `;
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

// Reset the marker rows + the mutable env/stub state to defaults before each test.
async function resetJobs(): Promise<void> {
  await getPrisma().$executeRaw`
    DELETE FROM core.update_job WHERE target_version LIKE ${`%${MARKER}%`}
  `;
}

beforeEach(() => {
  process.env.STUB_PREVIEW_EXIT = "0";
  process.env.STUB_LAUNCHCTL_EXIT = "0";
  process.env.STUB_PREVIEW_STDOUT_FILE = stdoutFile;
  process.env.ATRIUM_UPDATE_CLAUDE_BIN = updateStub; // resolvable executable default
  delete process.env.ATRIUM_UPDATE_STALE_MS;
  writeFileSync(stdoutFile, DIFF_A, "utf8");
  rmSync(headlessSentinel, { force: true });
  rmSync(launchctlLog, { force: true });
});

// A foreign (non-marker) in-progress row would trip the table-wide single-active
// index and confound the DB tests — detect it so those tests skip rather than fail.
async function foreignInProgress(): Promise<boolean> {
  const rows = await getPrisma().$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM core.update_job
    WHERE status = 'in-progress'::core."UpdateJobStatus" AND target_version NOT LIKE ${`%${MARKER}%`}
  `;
  return Number(rows[0]!.n) > 0;
}

async function apply(): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/dashboard/update",
    payload: { mode: "apply" },
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
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
// the removed 2-step modes ('preview' / 'commit') are now rejected at the boundary.
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

test("validation: removed mode 'preview' → 400 invalid_body(field=mode)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/dashboard/update",
    payload: { mode: "preview" },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual((res.json() as { field: string }).field, "mode");
});

test("validation: removed mode 'commit' → 400 invalid_body(field=mode)", async () => {
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
// route returns immediately; update.sh --headless is NEVER run by the route, and
// the job id + no-TTY confirm answer are injected into the one-shot plist env so
// the decoupled job adopts the reserved row.
// ---------------------------------------------------------------------------
test("apply enqueued: 200 enqueued, row reserved, launchd bootstrap, NO --headless, job id + confirm in plist", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");
  await resetJobs();

  const { statusCode, body } = await apply();
  assert.strictEqual(statusCode, 200);
  assert.strictEqual(body.mode, "apply");
  assert.strictEqual(body.status, "enqueued");
  assert.strictEqual(body.target_version, VERSION);
  assert.strictEqual(typeof body.job_id, "number");

  const jobId = body.job_id as number;

  // The reserved row is in-progress and carries the record nonce (bound to
  // {version + per-file hash}) — stored as a forensic record, not a gate.
  const rows = await getPrisma().$queryRaw<Array<{ preview_nonce: string | null; status: string }>>`
    SELECT preview_nonce, status::text AS status FROM core.update_job
    WHERE id = ${BigInt(jobId)}
  `;
  assert.strictEqual(rows[0]!.status, "in-progress");
  assert.match(rows[0]!.preview_nonce as string, /^[0-9a-f]{64}$/);

  // The route enqueued via launchctl bootstrap (decoupled) — it did NOT run the
  // long apply itself (update.sh --headless is never invoked by the route).
  assert.ok(!existsSync(headlessSentinel), "update.sh --headless MUST NOT be run by the route");
  const launchctlCalls = readFileSync(launchctlLog, "utf8");
  assert.match(launchctlCalls, /bootstrap gui\/\d+ /, "launchctl bootstrap invoked");

  // The one-shot plist carries the injected job id so the decoupled job adopts the row.
  const plist = readFileSync(oneshotPlist, "utf8");
  assert.match(plist, /<key>ATRIUM_UPDATE_JOB_ID<\/key>\s*<string>\d+<\/string>/);
  assert.match(plist, new RegExp(`<string>${jobId}</string>`));

  // The decoupled job has no TTY: without the explicit web-confirm answer,
  // apply-gate.sh gate_read_answer fail-closed-declines and every web apply dies
  // at the confirm gate. The apply-enqueue path (and ONLY it) injects yes.
  assert.match(
    plist,
    /<key>ATRIUM_UPDATE_CONFIRM_ANSWER<\/key>\s*<string>yes<\/string>/,
    "apply-path plist must carry ATRIUM_UPDATE_CONFIRM_ANSWER=yes for the no-TTY confirm gate",
  );
});

// apply with no changed files → up_to_date, reserves NOTHING and never touches the
// plist (fail-closed: only the enqueue path injects the confirm answer).
test("apply up_to_date: no diffs → 200 up_to_date + no row + plist untouched", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");
  await resetJobs();
  writeFileSync(stdoutFile, "", "utf8"); // empty preview

  // Seed a base plist so the "no confirm answer injected" assertion is non-vacuous.
  const basePlist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    "\t\t<key>HOME</key>",
    "\t\t<string>/tmp</string>",
    "\t</dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  writeFileSync(oneshotPlist, basePlist, "utf8");

  const { statusCode, body } = await apply();
  assert.strictEqual(statusCode, 200);
  assert.deepStrictEqual(body, { mode: "apply", status: "up_to_date" });

  const rows = await getPrisma().$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM core.update_job WHERE target_version LIKE ${`%${MARKER}%`}
  `;
  assert.strictEqual(Number(rows[0]!.n), 0, "no row reserved on up_to_date");

  assert.ok(!existsSync(launchctlLog), "no launchctl enqueue on up_to_date");
  const plist = readFileSync(oneshotPlist, "utf8");
  assert.ok(
    !plist.includes("ATRIUM_UPDATE_CONFIRM_ANSWER"),
    "up_to_date must not inject the confirm answer (fail-closed outside the enqueue path)",
  );
  assert.strictEqual(plist, basePlist, "up_to_date leaves the one-shot plist byte-identical");
});

// ---------------------------------------------------------------------------
// Single-active: the 2nd concurrent apply trips the partial UNIQUE INDEX (no
// INSERT...WHERE NOT EXISTS) → 409 single_active, exactly ONE in-progress row.
// ---------------------------------------------------------------------------
test("single-active: 2nd apply → 409 single_active (partial-unique, no row churn)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");
  await resetJobs();

  const first = await apply();
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(first.body.status, "enqueued");

  const second = await apply();
  assert.strictEqual(second.statusCode, 409);
  assert.strictEqual((second.body as { error: string }).error, "single_active");

  const rows = await getPrisma().$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM core.update_job
    WHERE status = 'in-progress'::core."UpdateJobStatus" AND target_version LIKE ${`%${MARKER}%`}
  `;
  assert.strictEqual(Number(rows[0]!.n), 1, "exactly one in-progress row (2nd INSERT rejected)");
});

// ---------------------------------------------------------------------------
// Stale sweep: a stale in-progress row is WHERE-guard-flipped to failed so a new
// apply can reserve; a FRESH in-progress row is never swept.
// ---------------------------------------------------------------------------
test("stale sweep: stale in-progress flipped to failed, new apply reserves", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");
  await resetJobs();

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
  await resetJobs();

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
// apply preview loud-fail: update.sh --preview non-zero → 500 preview_failed, no
// row reserved, no enqueue.
// ---------------------------------------------------------------------------
test("apply: preview CLI failure → 500 preview_failed + no row + no enqueue", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");
  await resetJobs();
  process.env.STUB_PREVIEW_EXIT = "1";

  const { statusCode, body } = await apply();
  assert.strictEqual(statusCode, 500);
  assert.strictEqual((body as { error: string }).error, "preview_failed");

  const rows = await getPrisma().$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM core.update_job WHERE target_version LIKE ${`%${MARKER}%`}
  `;
  assert.strictEqual(Number(rows[0]!.n), 0, "no row reserved on preview failure");
  assert.ok(!existsSync(launchctlLog), "no launchctl enqueue on preview failure");
});

// ---------------------------------------------------------------------------
// apply claude precondition: an unresolvable claude → loud-fail BEFORE reserving,
// so no row is created and no enqueue is attempted.
// ---------------------------------------------------------------------------
test("apply: claude unresolvable → 500 claude_unresolved + no row + no enqueue", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");
  await resetJobs();
  process.env.ATRIUM_UPDATE_CLAUDE_BIN = path.join(stubDir, "no-such-claude");

  const { statusCode, body } = await apply();
  assert.strictEqual(statusCode, 500);
  assert.strictEqual((body as { error: string }).error, "claude_unresolved");
  assert.ok(!existsSync(launchctlLog), "no launchctl enqueue on claude precondition fail");

  const rows = await getPrisma().$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM core.update_job WHERE target_version LIKE ${`%${MARKER}%`}
  `;
  assert.strictEqual(Number(rows[0]!.n), 0, "no row reserved when claude precondition fails");
});

// ---------------------------------------------------------------------------
// apply enqueue failure: launchctl bootstrap non-zero → 500 enqueue_failed and the
// reserved row is marked failed (frees the single-active slot).
// ---------------------------------------------------------------------------
test("apply: launchctl bootstrap failure → 500 enqueue_failed + row failed", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");
  await resetJobs();
  process.env.STUB_LAUNCHCTL_EXIT = "1";

  const { statusCode, body } = await apply();
  assert.strictEqual(statusCode, 500);
  assert.strictEqual((body as { error: string }).error, "enqueue_failed");

  const rows = await getPrisma().$queryRaw<Array<{ status: string }>>`
    SELECT status::text AS status FROM core.update_job WHERE target_version LIKE ${`%${MARKER}%`}
  `;
  assert.strictEqual(rows.length, 1, "the reserved row exists");
  assert.strictEqual(rows[0]!.status, "failed", "enqueue-failed row marked failed");
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/update-job — latest job row projection (UNCHANGED contract).
// ---------------------------------------------------------------------------
test("status GET: exposes status + heartbeat + failure_reason of the latest job", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  if (await foreignInProgress()) return t.skip("foreign in-progress row present");
  await resetJobs();

  const enqueued = await apply();
  assert.strictEqual(enqueued.statusCode, 200);
  const jobId = enqueued.body.job_id as number;

  const res = await app.inject({ method: "GET", url: "/api/dashboard/update-job" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.strictEqual(body.status, "in-progress");
  assert.strictEqual(body.id, jobId);
  assert.strictEqual(body.target_version, VERSION);
  assert.strictEqual(typeof body.started_at, "string");
  assert.strictEqual(typeof body.heartbeat_at, "string");
  assert.strictEqual(body.failure_reason, null);
});
