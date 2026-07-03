// P3-T5 — POST /api/improvement/:id/restore: the git-free recovery net wired to
// the agents-bak before-image restore (scripts/update.sh --restore-agents),
// replacing the retired git-revert/commit-sandwich claim in the LLM06 comments.
//
// The route derives the agents-bak cycle-id (<cycle_date>_p<id>) from the applied
// proposal row and shells out to a stubbed update.sh (ATRIUM_UPDATE_SCRIPT seam) —
// no real updater, no real file restore. DB: real Postgres, seeds tagged with a
// per-suite marker and scrubbed in after(); skips gracefully when the DB is down.
//
// Runner: npx tsx --test test/improvement.restore.route.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerImprovementRoutes } from "../src/server/routes/improvement.js";

const SUITE_MARKER = `impr-restore-${randomUUID().slice(0, 8)}`;

let app: FastifyInstance;
let stubDir: string;
let dbReady = false;

// Captured on seed: the applied proposal's id + its derived agents-bak cycle-id,
// and a non-applied (pending) proposal for the not-restorable gate.
let appliedId = 0;
let appliedCycleId = "";
let pendingId = 0;

// Stub argv sink — the update.sh stub writes "$*" here so the wiring test can
// assert the exact --restore-agents <cycle-id> argv the route passed.
let argvFile = "";

// Writes an executable update.sh stub: records its argv to argvFile, emits an
// optional stderr line, then exits `code`. Drives each restore branch with no
// real updater / file restore.
function writeStub(name: string, code: number, stderrLine = ""): string {
  const scriptPath = path.join(stubDir, name);
  const stderrCmd = stderrLine ? `printf '%s\\n' ${JSON.stringify(stderrLine)} >&2\n` : "";
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash\nprintf '%s' "$*" > ${JSON.stringify(argvFile)}\n${stderrCmd}exit ${code}\n`,
    "utf8",
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

before(async () => {
  stubDir = mkdtempSync(path.join(tmpdir(), "improvement-restore-stub-"));
  argvFile = path.join(stubDir, "restore-argv.txt");

  app = Fastify({ logger: false });
  await registerImprovementRoutes(app);
  await app.ready();

  try {
    const prisma = getPrisma();
    // Applied proposal — has a captured before-image → restorable.
    const applied = await prisma.$queryRaw<Array<{ id: string; cd: string }>>`
      INSERT INTO core.autoagent_proposals
        (cycle_date, pattern_label, target_file, target_agent, classification,
         approval_tier, status, source_file, source_file_mtime)
      VALUES
        (CURRENT_DATE,
         ${`${SUITE_MARKER} applied`},
         ${`/__test__/${SUITE_MARKER}-applied.md`},
         ${`${SUITE_MARKER}-agent`},
         'apply'::core."ProposalClassification",
         'user'::core."ApprovalTier",
         'applied'::core."ProposalStatus",
         '/__test__/source.md', 0)
      RETURNING id::text AS id, to_char(cycle_date, 'YYYY-MM-DD') AS cd
    `;
    appliedId = Number(applied[0]!.id);
    appliedCycleId = `${applied[0]!.cd}_p${applied[0]!.id}`;

    // Pending proposal — never applied → no before-image → not restorable.
    const pending = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO core.autoagent_proposals
        (cycle_date, pattern_label, target_file, target_agent, classification,
         approval_tier, status, source_file, source_file_mtime)
      VALUES
        (CURRENT_DATE,
         ${`${SUITE_MARKER} pending`},
         ${`/__test__/${SUITE_MARKER}-pending.md`},
         ${`${SUITE_MARKER}-agent`},
         'apply'::core."ProposalClassification",
         'user'::core."ApprovalTier",
         'pending'::core."ProposalStatus",
         '/__test__/source.md', 0)
      RETURNING id::text AS id
    `;
    pendingId = Number(pending[0]!.id);
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[impr-restore] DB seed failed — DB-dependent tests will skip:", error);
  }
});

after(async () => {
  delete process.env.ATRIUM_UPDATE_SCRIPT;
  if (dbReady) {
    try {
      const prisma = getPrisma();
      await prisma.$executeRaw`
        DELETE FROM core.autoagent_proposals WHERE pattern_label LIKE ${`%${SUITE_MARKER}%`}
      `;
    } catch (error) {
      console.error("[impr-restore cleanup] DB scrub failed:", error);
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

// The core wiring proof: an applied proposal's restore invokes update.sh
// --restore-agents with the row-derived <cycle_date>_p<id>, and 200 { restored }.
test("POST restore: applied proposal → 200 { status:'restored' } + argv carries --restore-agents <cycle-id>", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  rmSync(argvFile, { force: true });
  process.env.ATRIUM_UPDATE_SCRIPT = writeStub("restore-ok.sh", 0);

  const res = await app.inject({ method: "POST", url: `/api/improvement/${appliedId}/restore` });

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), {
    id: appliedId,
    status: "restored",
    cycle_id: appliedCycleId,
  });
  // The route actually shelled out (not comment-only) with the derived cycle-id.
  assert.ok(existsSync(argvFile), "update.sh stub was invoked");
  assert.strictEqual(readFileSync(argvFile, "utf8"), `--restore-agents ${appliedCycleId}`);
});

// exit 10 = no agents-bak snapshot (pruned past retention / never landed) OR a
// per-file write failure → 422 restore_failed.
test("POST restore: update.sh exit 10 → 422 { status:'restore_failed' }", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  process.env.ATRIUM_UPDATE_SCRIPT = writeStub(
    "restore-missing.sh",
    10,
    `no agents-bak snapshot for cycle-id '${appliedCycleId}'`,
  );

  const res = await app.inject({ method: "POST", url: `/api/improvement/${appliedId}/restore` });

  assert.strictEqual(res.statusCode, 422);
  const body = res.json() as { status: string; id: number; reason: string };
  assert.strictEqual(body.status, "restore_failed");
  assert.strictEqual(body.id, appliedId);
  assert.match(body.reason, /before-image/);
});

// Non-applied proposal has no before-image → 409 not_restorable, and the route
// MUST short-circuit before invoking update.sh (gate precedes the exec).
test("POST restore: pending proposal → 409 { status:'not_restorable' } (no exec)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  rmSync(argvFile, { force: true });
  process.env.ATRIUM_UPDATE_SCRIPT = writeStub("restore-should-not-run.sh", 0);

  const res = await app.inject({ method: "POST", url: `/api/improvement/${pendingId}/restore` });

  assert.strictEqual(res.statusCode, 409);
  const body = res.json() as { status: string; id: number };
  assert.strictEqual(body.status, "not_restorable");
  assert.strictEqual(body.id, pendingId);
  assert.ok(!existsSync(argvFile), "update.sh must NOT be invoked for a non-applied proposal");
});

// Unknown proposal id → 404 not_found (0 rows), no exec.
test("POST restore: unknown id → 404 { status:'not_found' }", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  rmSync(argvFile, { force: true });
  process.env.ATRIUM_UPDATE_SCRIPT = writeStub("restore-should-not-run-2.sh", 0);

  const res = await app.inject({ method: "POST", url: "/api/improvement/999999999999/restore" });

  assert.strictEqual(res.statusCode, 404);
  const body = res.json() as { status: string };
  assert.strictEqual(body.status, "not_found");
  assert.ok(!existsSync(argvFile), "update.sh must NOT be invoked for an unknown id");
});

// Infra-class exit (e.g. lock held / missing python3) → 500 restore_error.
test("POST restore: update.sh infra exit 3 → 500 { status:'restore_error' }", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  process.env.ATRIUM_UPDATE_SCRIPT = writeStub("restore-infra.sh", 3, "psql: not found");

  const res = await app.inject({ method: "POST", url: `/api/improvement/${appliedId}/restore` });

  assert.strictEqual(res.statusCode, 500);
  const body = res.json() as { status: string; reason: string };
  assert.strictEqual(body.status, "restore_error");
  assert.match(body.reason, /exited 3/);
});

// Non-integer id is rejected before any DB / exec — runs even when the DB is down.
test("POST restore: non-integer id → 400 { status:'invalid_param' }", async () => {
  const res = await app.inject({ method: "POST", url: "/api/improvement/abc/restore" });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.json(), { status: "invalid_param", param: "id" });
});
