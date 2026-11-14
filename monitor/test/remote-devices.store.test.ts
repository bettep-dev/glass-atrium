// Registered remote device store: issue, look up, revoke and cap, run against the migrated test database.
// Every case runs in a transaction that never commits → the test database keeps no device rows.

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import "dotenv/config";

import type { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import {
  DEVICE,
  createDevice,
  findActiveDevice,
  listActiveDevices,
  revokeAllDevices,
  revokeDevice,
} from "../src/server/remote/devices.js";

class Rollback extends Error {}

after(async () => {
  await disconnectPrisma();
});

function runRolledBack(work: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  return assert.rejects(
    getPrisma().$transaction(async (tx) => {
      await tx.remoteDevice.deleteMany({});
      await work(tx);
      throw new Rollback();
    }),
    Rollback,
  );
}

async function createOrFail(tx: Prisma.TransactionClient, label: string) {
  const created = await createDevice(tx, label);
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") throw new Error("unreachable");
  return created;
}

describe("issuing a device", () => {
  test("the issued value finds its device, and only its SHA-256 digest is stored", async () => {
    await runRolledBack(async (tx) => {
      const created = await createOrFail(tx, "Owner iPhone 15");
      const row = await tx.remoteDevice.findUniqueOrThrow({ where: { id: created.device.id } });
      assert.deepEqual(Buffer.from(row.tokenHash), createHash("sha256").update(created.token, "utf8").digest());
      assert.equal(Buffer.from(created.token, "base64url").length, 32);
      assert.equal((await findActiveDevice(tx, created.token))?.id, created.device.id);
    });
  });

  test("two issues never share a value", async () => {
    await runRolledBack(async (tx) => {
      const first = await createOrFail(tx, "Owner iPhone 15");
      const second = await createOrFail(tx, "Owner iPad");
      assert.notEqual(first.token, second.token);
      assert.equal((await findActiveDevice(tx, second.token))?.id, second.device.id);
    });
  });

  const labels: readonly { name: string; label: string; isAccepted: boolean }[] = [
    { name: "letters, digits, space, hyphen, underscore and period", label: "Owner_iPad-2.5 Pro", isAccepted: true },
    { name: "non-Latin letters", label: "아이폰 15", isAccepted: true },
    { name: "exactly 32 characters", label: "a".repeat(32), isAccepted: true },
    { name: "an empty label", label: "", isAccepted: false },
    { name: "33 characters", label: "a".repeat(33), isAccepted: false },
    { name: "markup characters", label: "<b>phone</b>", isAccepted: false },
    { name: "a quote", label: "Owner's phone", isAccepted: false },
    { name: "a newline", label: "phone\nadmin", isAccepted: false },
  ];
  for (const row of labels) {
    test(`label: ${row.name} → ${row.isAccepted ? "accepted" : "refused"}`, async () => {
      await runRolledBack(async (tx) => {
        const created = await createDevice(tx, row.label);
        assert.equal(created.outcome, row.isAccepted ? "created" : "label_invalid");
        assert.equal(await tx.remoteDevice.count(), row.isAccepted ? 1 : 0);
      });
    });
  }

  test("the device beyond the cap is refused until one is revoked", async () => {
    await runRolledBack(async (tx) => {
      const devices = [];
      for (let index = 0; index < DEVICE.MAX_ACTIVE; index += 1) devices.push(await createOrFail(tx, `device ${index}`));
      assert.deepEqual(await createDevice(tx, "one too many"), { outcome: "cap_reached" });
      assert.equal(await revokeDevice(tx, devices[0]!.device.id), true);
      assert.equal((await createDevice(tx, "after a revoke")).outcome, "created");
    });
  });
});

describe("looking up a device", () => {
  test("an unknown value finds nothing", async () => {
    await runRolledBack(async (tx) => {
      await createOrFail(tx, "Owner iPhone 15");
      assert.equal(await findActiveDevice(tx, Buffer.alloc(32, 7).toString("base64url")), null);
      assert.equal(await findActiveDevice(tx, ""), null);
    });
  });

  test("a revoked device is no longer found, and revoking it again reports nothing revoked", async () => {
    await runRolledBack(async (tx) => {
      const created = await createOrFail(tx, "Owner iPhone 15");
      assert.equal(await revokeDevice(tx, created.device.id), true);
      assert.equal(await findActiveDevice(tx, created.token), null);
      assert.equal(await revokeDevice(tx, created.device.id), false);
    });
  });

  test("a lookup moves the device's last-seen time forward", async () => {
    await runRolledBack(async (tx) => {
      const created = await createOrFail(tx, "Owner iPhone 15");
      const past = new Date("2026-11-01T09:30:00.250Z");
      await tx.remoteDevice.update({ where: { id: created.device.id }, data: { lastSeenAt: past } });
      await findActiveDevice(tx, created.token);
      const row = await tx.remoteDevice.findUniqueOrThrow({ where: { id: created.device.id } });
      assert.ok(row.lastSeenAt > past, `last seen stayed at ${row.lastSeenAt.toISOString()}`);
    });
  });
});

describe("revoking every device", () => {
  test("returns exactly the ids it revoked and leaves no active device", async () => {
    await runRolledBack(async (tx) => {
      const first = await createOrFail(tx, "Owner iPhone 15");
      const second = await createOrFail(tx, "Owner iPad");
      await revokeDevice(tx, first.device.id);
      assert.deepEqual(await revokeAllDevices(tx), [second.device.id]);
      assert.deepEqual(await listActiveDevices(tx), []);
      assert.equal(await findActiveDevice(tx, second.token), null);
    });
  });
});

describe("listing devices", () => {
  test("lists active devices oldest first with label and times, never a stored digest", async () => {
    await runRolledBack(async (tx) => {
      const first = await createOrFail(tx, "Owner iPhone 15");
      const second = await createOrFail(tx, "Owner iPad");
      const revoked = await createOrFail(tx, "Old phone");
      await revokeDevice(tx, revoked.device.id);
      const listed = await listActiveDevices(tx);
      assert.deepEqual(
        listed.map((device) => [device.id, device.label]),
        [
          [first.device.id, "Owner iPhone 15"],
          [second.device.id, "Owner iPad"],
        ],
      );
      assert.deepEqual(Object.keys(listed[0]!).sort(), ["createdAt", "id", "label", "lastSeenAt"]);
    });
  });
});
