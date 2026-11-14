// Registered remote devices table (monitor.remote_devices) guards, run by execution against the migrated test database.
// Every case runs in a transaction that never commits → the test database keeps no device rows.

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import "dotenv/config";

import { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";

/** Thrown last inside a case's transaction → the transaction rolls back and nothing persists. */
class Rollback extends Error {}

after(async () => {
  await disconnectPrisma();
});

function runRolledBack(work: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<void> {
  return getPrisma().$transaction(async (tx) => {
    await work(tx);
    throw new Rollback();
  });
}

/** SHA-256 of a fresh 256-bit device token — the stored form; the token itself never reaches the table. */
function buildTokenHash(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash("sha256").update(randomBytes(32)).digest());
}

function buildDevice(): Prisma.RemoteDeviceCreateInput {
  return { label: "Owner iPhone 15", tokenHash: buildTokenHash() };
}

describe("monitor.remote_devices token hash", () => {
  test("a second device with a token hash already registered is rejected", async () => {
    await assert.rejects(
      runRolledBack(async (tx) => {
        const first = buildDevice();
        await tx.remoteDevice.create({ data: first });
        await tx.remoteDevice.create({ data: { label: "Owner iPad", tokenHash: first.tokenHash } });
      }),
      (error) => {
        assert.ok(error instanceof Prisma.PrismaClientKnownRequestError, `expected a Prisma request error, got ${String(error)}`);
        assert.equal(error.code, "P2002");
        assert.match(JSON.stringify(error.meta), /remote_devices_token_hash_key/);
        return true;
      },
    );
  });

  // a SHA-256 digest is 32 bytes → its hex text (64) or a truncated digest is not a hash this table stores
  const lengths: readonly { name: string; tokenHash: Uint8Array<ArrayBuffer>; isAccepted: boolean }[] = [
    { name: "accepts a 32-byte SHA-256 digest", tokenHash: buildTokenHash(), isAccepted: true },
    { name: "rejects a digest one byte short", tokenHash: buildTokenHash().slice(0, 31), isAccepted: false },
    {
      name: "rejects the hex text of a digest stored as bytes",
      tokenHash: new TextEncoder().encode(Buffer.from(buildTokenHash()).toString("hex")),
      isAccepted: false,
    },
  ];

  for (const row of lengths) {
    test(row.name, async () => {
      const work = runRolledBack((tx) => tx.remoteDevice.create({ data: { ...buildDevice(), tokenHash: row.tokenHash } }));
      if (row.isAccepted) await assert.rejects(work, Rollback);
      else await assert.rejects(work, /remote_devices_token_hash_check/);
    });
  }
});

describe("monitor.remote_devices label", () => {
  const labels: readonly { name: string; label: string; isAccepted: boolean }[] = [
    { name: "accepts a label at the 32-character cap", label: "l".repeat(32), isAccepted: true },
    { name: "rejects a label past 32 characters", label: "l".repeat(33), isAccepted: false },
  ];

  for (const row of labels) {
    test(row.name, async () => {
      const work = runRolledBack((tx) => tx.remoteDevice.create({ data: { ...buildDevice(), label: row.label } }));
      if (row.isAccepted) await assert.rejects(work, Rollback);
      else await assert.rejects(work, /value too long|too long for the column/);
    });
  }
});

describe("monitor.remote_devices registration defaults", () => {
  test("a newly registered device is active and last seen at its registration time", async () => {
    await assert.rejects(
      runRolledBack(async (tx) => {
        const device = await tx.remoteDevice.create({
          data: buildDevice(),
          select: { createdAt: true, lastSeenAt: true, revokedAt: true },
        });
        assert.equal(device.revokedAt, null);
        assert.equal(device.lastSeenAt.getTime(), device.createdAt.getTime());
      }),
      Rollback,
    );
  });
});

describe("monitor.remote_devices reversal", () => {
  // The migration's reversal note is a plain DROP TABLE → it stays valid only while no other relation depends on this one.
  test("dropping the table without cascade removes it and its token index", async () => {
    await assert.rejects(
      runRolledBack(async (tx) => {
        await tx.$executeRaw`DROP TABLE "monitor"."remote_devices"`;
        const [left] = await tx.$queryRaw<Array<{ table: string | null; index: string | null }>>`
          SELECT to_regclass('"monitor"."remote_devices"')::text AS "table",
                 to_regclass('"monitor"."remote_devices_token_hash_key"')::text AS "index"`;
        assert.deepEqual(left, { table: null, index: null });
      }),
      Rollback,
    );
  });
});
