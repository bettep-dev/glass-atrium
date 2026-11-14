// Loopback admin routes for remote access: open a registration code, list and revoke devices — the Mac's page only.
// Device rows live in a transaction that never commits → the test database keeps none.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/remote-admin.routes.test.ts

import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { Writable } from "node:stream";

import "dotenv/config";

import Fastify, { type FastifyBaseLogger, type FastifyInstance, type InjectOptions } from "fastify";
import pino from "pino";

import type { Prisma } from "../src/generated/prisma/client.js";
import { buildApp } from "../src/server/app.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { LOGGER_OPTIONS } from "../src/server/logger.js";
import { REMOTE_ADMIN_LIMITS, REMOTE_ADMIN_PATH, type RemoteAdminDeps, registerRemoteAdminRoutes } from "../src/server/remote/admin-routes.js";
import { DeviceConnections } from "../src/server/remote/connections.js";
import { createDevice, findActiveDevice, listActiveDevices, revokeAllDevices, revokeDevice } from "../src/server/remote/devices.js";
import type { RemoteAuditEvent } from "../src/server/remote/gate.js";
import { RegistrationCodes } from "../src/server/remote/registration-code.js";

const PORT = 16199;
const MAC_PAGE = { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" };

class Rollback extends Error {}

let clock = Date.parse("2026-11-14T16:40:00.000Z");
const now = () => clock;
let db: Prisma.TransactionClient = getPrisma();
const events: RemoteAuditEvent[] = [];
let isAuditDown = false;
let openedCodes: string[] = [];
const connections = new DeviceConnections();
let app: FastifyInstance;

function buildAdminDeps(): RemoteAdminDeps {
  const codes = new RegistrationCodes({ now });
  return {
    codes: {
      open: () => {
        const code = codes.open();
        openedCodes.push(code);
        return code;
      },
    },
    devices: { list: () => listActiveDevices(db), revoke: (id) => revokeDevice(db, id), revokeAll: () => revokeAllDevices(db) },
    connections,
    audit: {
      insertEvent: async (event) => {
        if (isAuditDown) throw new Error("audit store unavailable");
        events.push(event);
      },
    },
    now,
  };
}

before(async () => {
  app = await buildApp(PORT, { admin: buildAdminDeps() });
  await app.ready();
});

// a fresh limiter window per case → no case inherits another's open budget
beforeEach(() => {
  clock += 60 * 60_000;
  events.length = 0;
  openedCodes = [];
  isAuditDown = false;
});

after(async () => {
  await app.close();
  await disconnectPrisma();
});

function runRolledBack(work: () => Promise<void>): Promise<void> {
  return assert.rejects(
    getPrisma().$transaction(
      async (tx) => {
        await tx.remoteDevice.deleteMany({});
        db = tx;
        try {
          await work();
        } finally {
          db = getPrisma();
        }
        throw new Rollback();
      },
      { timeout: 20_000 },
    ),
    Rollback,
  );
}

async function addDevice(label: string): Promise<{ id: bigint; presented: string }> {
  const creation = await createDevice(db, label);
  if (creation.outcome !== "created") throw new Error(`device not created: ${creation.outcome}`);
  return { id: creation.device.id, presented: creation.token };
}

/** A real socket the remote gate would have tracked for the device → a revoke must destroy it. */
async function trackOpenSocket(deviceId: bigint): Promise<net.Socket> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stand-in server has no port");
  const accepted = once(server, "connection");
  const client = net.connect(address.port, "127.0.0.1");
  const [socket] = (await accepted) as [net.Socket];
  connections.track(deviceId, socket);
  client.on("error", () => undefined);
  socket.once("close", () => {
    client.destroy();
    server.close();
  });
  return socket;
}

function callAdmin(request: { method: InjectOptions["method"]; url: string; headers?: Record<string, string>; payload?: string }) {
  return app.inject({ method: request.method, url: request.url, headers: request.headers ?? MAC_PAGE, ...(request.payload === undefined ? {} : { payload: request.payload }) });
}

const ROUTES: { name: string; method: InjectOptions["method"]; getUrl: (id: bigint) => string }[] = [
  { name: "open registration", method: "POST", getUrl: () => REMOTE_ADMIN_PATH.REGISTRATION },
  { name: "list devices", method: "GET", getUrl: () => REMOTE_ADMIN_PATH.DEVICES },
  { name: "revoke one", method: "DELETE", getUrl: (id) => `${REMOTE_ADMIN_PATH.DEVICES}/${id}` },
  { name: "revoke all", method: "POST", getUrl: () => REMOTE_ADMIN_PATH.REVOKE_ALL },
];

describe("every admin route", () => {
  test("refuses with 403 unless the request is same-origin by fetch metadata at a loopback Host, and changes nothing", async () => {
    const refusals: { name: string; headers: Record<string, string> }[] = [
      { name: "no fetch metadata", headers: { host: `127.0.0.1:${PORT}` } },
      { name: "fetch metadata none", headers: { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "none" } },
      { name: "same-site", headers: { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "same-site" } },
      { name: "cross-site", headers: { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "cross-site" } },
      { name: "same-origin at a rebound Host", headers: { host: `owner-mac.local:${PORT}`, "sec-fetch-site": "same-origin" } },
      { name: "same-origin at the loopback name on another port", headers: { host: "localhost:16145", "sec-fetch-site": "same-origin" } },
    ];
    await runRolledBack(async () => {
      const device = await addDevice("Owner iPhone");
      for (const route of ROUTES) {
        for (const refusal of refusals) {
          const response = await callAdmin({ method: route.method, url: route.getUrl(device.id), headers: refusal.headers });
          assert.equal(response.statusCode, 403, `${route.name} / ${refusal.name}: ${response.body}`);
          assert.ok(!("code" in JSON.parse(response.body)), `${route.name} / ${refusal.name}`);
        }
      }
      assert.deepEqual([openedCodes, events, (await listActiveDevices(db)).map((entry) => entry.id)], [[], [], [device.id]]);
    });
  });

  test("answers the Mac's page with no-store and no CORS header", async () => {
    await runRolledBack(async () => {
      const device = await addDevice("Owner iPhone");
      for (const route of ROUTES) {
        const response = await callAdmin({ method: route.method, url: route.getUrl(device.id) });
        assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${route.name}: ${response.body}`);
        assert.deepEqual(
          [response.headers["cache-control"], response.headers["access-control-allow-origin"]],
          ["no-store", undefined],
          route.name,
        );
      }
    });
  });

  test("refuses a request body, so no request value reaches the action", async () => {
    await runRolledBack(async () => {
      const device = await addDevice("Owner iPhone");
      for (const route of ROUTES.filter((entry) => entry.method !== "GET")) {
        const response = await callAdmin({
          method: route.method,
          url: route.getUrl(device.id),
          headers: { ...MAC_PAGE, "content-type": "application/json" },
          payload: JSON.stringify({ id: "1" }),
        });
        assert.equal(response.statusCode, 400, `${route.name}: ${response.body}`);
      }
      assert.deepEqual([openedCodes, (await listActiveDevices(db)).map((entry) => entry.id)], [[], [device.id]]);
    });
  });
});

describe("opening a registration", () => {
  test("returns the code only in the response body, after its audit row", async () => {
    const response = await callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.REGISTRATION });
    assert.equal(response.statusCode, 200, response.body);
    const [code] = openedCodes;
    assert.ok(code !== undefined, "a code was opened");
    assert.equal(JSON.parse(response.body).code, code);
    assert.deepEqual(events.map((event) => [event.actor, event.actionKind, event.result]), [["monitor-web", "remote.registration_opened", "success"]]);
    assert.ok(!JSON.stringify(events).includes(code), "the audit row never carries the code");
  });

  test("opens no code when its audit row cannot be written", async () => {
    isAuditDown = true;
    const response = await callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.REGISTRATION });
    assert.deepEqual([response.statusCode, JSON.parse(response.body), openedCodes], [503, { error: "audit_unavailable" }, []]);
  });

  test("past the open-rate limit is refused with 429 and opens nothing more", async () => {
    for (let index = 0; index < REMOTE_ADMIN_LIMITS.REGISTRATION_OPEN.limit; index += 1) {
      assert.equal((await callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.REGISTRATION })).statusCode, 200);
    }
    const limited = await callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.REGISTRATION });
    assert.deepEqual([limited.statusCode, openedCodes.length], [429, REMOTE_ADMIN_LIMITS.REGISTRATION_OPEN.limit]);
  });

  test("never writes the code to the request log", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString("utf8"));
        done();
      },
    });
    const captured: FastifyBaseLogger = pino({ ...LOGGER_OPTIONS, level: "trace" }, sink);
    const logged = Fastify({ loggerInstance: captured });
    await registerRemoteAdminRoutes(logged, buildAdminDeps());
    try {
      const response = await logged.inject({ method: "POST", url: REMOTE_ADMIN_PATH.REGISTRATION, headers: MAC_PAGE });
      const [code] = openedCodes;
      assert.ok(response.statusCode === 200 && code !== undefined, response.body);
      assert.ok(lines.length > 0, "the request was logged");
      assert.ok(!lines.join("").includes(code));
    } finally {
      await logged.close();
    }
  });
});

describe("listing devices", () => {
  test("returns only id, label, created and last-seen of active devices", async () => {
    await runRolledBack(async () => {
      const kept = await addDevice("Owner iPhone");
      const revoked = await addDevice("Old iPad");
      await revokeDevice(db, revoked.id);
      const response = await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.DEVICES });
      const { devices } = JSON.parse(response.body) as { devices: Record<string, unknown>[] };
      assert.deepEqual(devices.map((entry) => [entry.id, entry.label, Object.keys(entry).sort()]), [
        [String(kept.id), "Owner iPhone", ["createdAt", "id", "label", "lastSeenAt"]],
      ]);
    });
  });
});

describe("revoking one device", () => {
  test("closes its open sockets, stops its cookie admitting, leaves other devices and audits the revoke", async () => {
    await runRolledBack(async () => {
      const target = await addDevice("Lost iPhone");
      const other = await addDevice("Owner iPad");
      const socket = await trackOpenSocket(target.id);
      const response = await callAdmin({ method: "DELETE", url: `${REMOTE_ADMIN_PATH.DEVICES}/${target.id}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(
        [socket.destroyed, await findActiveDevice(db, target.presented), (await findActiveDevice(db, other.presented))?.id],
        [true, null, other.id],
      );
      assert.deepEqual(events.map((event) => [event.actor, event.actionKind, event.result, event.targetId]), [["monitor-web", "remote.revoke", "success", target.id]]);
    });
  });

  test("an unknown or already revoked id gets the one device_not_found", async () => {
    await runRolledBack(async () => {
      const revoked = await addDevice("Old iPad");
      await revokeDevice(db, revoked.id);
      for (const id of [revoked.id, revoked.id + 1000n]) {
        const response = await callAdmin({ method: "DELETE", url: `${REMOTE_ADMIN_PATH.DEVICES}/${id}` });
        assert.deepEqual([response.statusCode, response.body], [404, JSON.stringify({ error: "device_not_found" })], String(id));
      }
    });
  });

  test("an id that is not a decimal device id is refused before the store", async () => {
    for (const id of ["abc", "0", "-1", "1e3", "99999999999999999999"]) {
      const response = await callAdmin({ method: "DELETE", url: `${REMOTE_ADMIN_PATH.DEVICES}/${id}` });
      assert.equal(response.statusCode, 400, id);
    }
  });

  test("an audit failure never blocks the revoke", async () => {
    await runRolledBack(async () => {
      const target = await addDevice("Lost iPhone");
      isAuditDown = true;
      const response = await callAdmin({ method: "DELETE", url: `${REMOTE_ADMIN_PATH.DEVICES}/${target.id}` });
      assert.deepEqual([response.statusCode, await findActiveDevice(db, target.presented)], [200, null]);
    });
  });
});

describe("revoking every device", () => {
  test("closes every device's sockets, stops every cookie and audits the count without device ids", async () => {
    await runRolledBack(async () => {
      const first = await addDevice("Owner iPhone");
      const second = await addDevice("Owner iPad");
      const sockets = [await trackOpenSocket(first.id), await trackOpenSocket(second.id)];
      const response = await callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.REVOKE_ALL });
      assert.deepEqual([response.statusCode, JSON.parse(response.body)], [200, { revoked: 2 }]);
      assert.deepEqual(
        [sockets.map((socket) => socket.destroyed), await findActiveDevice(db, first.presented), await findActiveDevice(db, second.presented)],
        [[true, true], null, null],
      );
      assert.deepEqual(events.map((event) => [event.actionKind, event.result, event.targetId, event.payload?.count]), [["remote.revoke", "success", undefined, 2]]);
    });
  });
});
