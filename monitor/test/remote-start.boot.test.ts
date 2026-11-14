// Remote access state at monitor boot: off cuts every device off, on is recorded with its trusted-network count.
// Every case runs in a transaction that never commits → the test database keeps no device or audit rows.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/remote-start.boot.test.ts

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import pino from "pino";

import type { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { buildRemoteAuditWriter } from "../src/server/middleware/audit-log.js";
import { DeviceConnections } from "../src/server/remote/connections.js";
import { createDevice, listActiveDevices, revokeAllDevices } from "../src/server/remote/devices.js";
import { RegistrationCodes } from "../src/server/remote/registration-code.js";
import { getRemoteSettings } from "../src/server/remote/settings.js";
import { isDeviceOff, putBootAccessState, setDeviceOff, startRemoteAccess } from "../src/server/remote/start.js";
import { deleteDirectory } from "./lib/remove-dir.js";

const MONITOR_PORT = 16145;
const OFF = getRemoteSettings({ ATRIUM_REMOTE_ACCESS: "off", ATRIUM_REMOTE_PORT: "16146", ATRIUM_REMOTE_TRUSTED_NETWORKS: "" }, MONITOR_PORT);
const ON = getRemoteSettings(
  { ATRIUM_REMOTE_ACCESS: "on", ATRIUM_REMOTE_PORT: "16146", ATRIUM_REMOTE_TRUSTED_NETWORKS: "192.168.0.1@a4:2b:b0:11:22:33,10.0.0.1@a4:2b:b0:44:55:66" },
  MONITOR_PORT,
);
const log = pino({ level: "silent" });

class Rollback extends Error {}

after(() => disconnectPrisma());

function runRolledBack(work: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  return assert.rejects(
    getPrisma().$transaction(
      async (tx) => {
        await tx.remoteDevice.deleteMany({});
        await work(tx);
        throw new Rollback();
      },
      { timeout: 20_000 },
    ),
    Rollback,
  );
}

async function addDevices(tx: Prisma.TransactionClient, labels: string[]): Promise<void> {
  for (const label of labels) {
    const creation = await createDevice(tx, label);
    if (creation.outcome !== "created") throw new Error(`device not created: ${creation.outcome}`);
  }
}

async function getBootRows(tx: Prisma.TransactionClient): Promise<unknown[][]> {
  const rows = await tx.auditLog.findMany({ where: { actor: "monitor-boot" }, orderBy: { id: "asc" } });
  return rows.map((row) => [row.actionKind, row.resultCode, row.payload]);
}

describe("booting with remote access off", () => {
  test("revokes every active device, writes one audit row with the count and opens nothing", async () => {
    await runRolledBack(async (tx) => {
      await addDevices(tx, ["Owner iPhone", "Owner iPad"]);
      const controller = await startRemoteAccess({ settings: OFF, connections: new DeviceConnections(), codes: new RegistrationCodes(), log, db: tx });
      assert.deepEqual(
        [controller, await listActiveDevices(tx), await getBootRows(tx)],
        [null, [], [["remote.revoke", "success", { count: 2 }]]],
      );
    });
  });

  test("with no active device writes no row", async () => {
    await runRolledBack(async (tx) => {
      await startRemoteAccess({ settings: OFF, connections: new DeviceConnections(), codes: new RegistrationCodes(), log, db: tx });
      assert.deepEqual(await getBootRows(tx), []);
    });
  });

  test("an audit failure never keeps a device registered or fails the boot", async () => {
    await runRolledBack(async (tx) => {
      await addDevices(tx, ["Owner iPhone"]);
      const audit = { insertEvent: async () => Promise.reject(new Error("audit store unavailable")) };
      await putBootAccessState(OFF, { revokeAll: () => revokeAllDevices(tx), connections: new DeviceConnections(), audit, log });
      assert.deepEqual(await listActiveDevices(tx), []);
    });
  });
});

describe("booting with remote access on", () => {
  test("writes one audit row with the trusted-network count and revokes nothing", async () => {
    await runRolledBack(async (tx) => {
      await addDevices(tx, ["Owner iPhone"]);
      const audit = buildRemoteAuditWriter(tx);
      await putBootAccessState(ON, { revokeAll: () => revokeAllDevices(tx), connections: new DeviceConnections(), audit, log });
      assert.deepEqual(
        [(await listActiveDevices(tx)).map((device) => device.label), await getBootRows(tx)],
        [["Owner iPhone"], [["remote.access_enabled", "success", { trustedNetworkCount: 2 }]]],
      );
    });
  });
});

describe("a device's off across a restart", () => {
  test("boots closed with config on, revoking every device and opening nothing", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "remote-off-"));
    try {
      await setDeviceOff(dataDir);
      await runRolledBack(async (tx) => {
        await addDevices(tx, ["Owner iPhone"]);
        const controller = await startRemoteAccess({ settings: ON, connections: new DeviceConnections(), codes: new RegistrationCodes(), log, db: tx, dataDir });
        assert.deepEqual([controller, await listActiveDevices(tx)], [null, []]);
      });
    } finally {
      deleteDirectory(dataDir);
    }
  });

  test("is read only from the exact off state, so the CLI's on, a missing file or other text keep config in charge", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "remote-off-"));
    const rows = [
      { name: "a device turned access off", content: "off\n", expected: true },
      { name: "the CLI turned access on again", content: "on\n", expected: false },
      { name: "unexpected text", content: "OFF please\n", expected: false },
      { name: "no state file", content: null, expected: false },
    ];
    try {
      for (const row of rows) {
        const rowDir = await mkdtemp(path.join(dataDir, "row-"));
        if (row.content !== null) await writeFile(path.join(rowDir, "access-state"), row.content);
        assert.equal(await isDeviceOff(rowDir), row.expected, row.name);
      }
    } finally {
      deleteDirectory(dataDir);
    }
  });

  test("is written owner-only", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "remote-off-"));
    try {
      await setDeviceOff(dataDir);
      assert.equal((await stat(path.join(dataDir, "access-state"))).mode & 0o777, 0o600);
    } finally {
      deleteDirectory(dataDir);
    }
  });
});
