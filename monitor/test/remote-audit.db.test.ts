// Remote mutation audit rows: the intent row starts as not-succeeded and takes the real result afterwards.
// Every case runs in a transaction that never commits → the test database keeps no audit rows.

import test, { after } from "node:test";
import assert from "node:assert/strict";

import "dotenv/config";

import type { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { buildRemoteAuditWriter } from "../src/server/middleware/audit-log.js";

class Rollback extends Error {}

after(async () => {
  await disconnectPrisma();
});

function runRolledBack(work: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  return assert.rejects(
    getPrisma().$transaction(async (tx) => {
      await work(tx);
      throw new Rollback();
    }),
    Rollback,
  );
}

test("an intent row carries the device actor and stays error until its result is set", async () => {
  await runRolledBack(async (tx) => {
    const writer = buildRemoteAuditWriter(tx);
    const id = await writer.insertIntent({ actor: "remote:3@192.168.0.31", method: "POST", route: "/api/queue/owner/items/:id/answer" });
    const intent = await tx.auditLog.findUniqueOrThrow({ where: { id } });
    assert.deepEqual(
      { actor: intent.actor, actionKind: intent.actionKind, resultCode: intent.resultCode, payload: intent.payload },
      { actor: "remote:3@192.168.0.31", actionKind: "remote.mutation", resultCode: "error", payload: { method: "POST", route: "/api/queue/owner/items/:id/answer" } },
    );
    await writer.setResult(id, "success");
    assert.equal((await tx.auditLog.findUniqueOrThrow({ where: { id } })).resultCode, "success");
  });
});

test("a covered route's resource names the target table", async () => {
  await runRolledBack(async (tx) => {
    const writer = buildRemoteAuditWriter(tx);
    const id = await writer.insertIntent({ actor: "remote:3@192.168.0.31", method: "PUT", route: "/api/model-config" });
    assert.equal((await tx.auditLog.findUniqueOrThrow({ where: { id } })).targetTable, "model-config");
  });
});
