// Loopback remote-cli routes: the glass-atrium CLI lists devices and revokes one or all — no browser page can reach them.
// Device rows live in a transaction that never commits → the test database keeps none.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/remote-cli.routes.test.ts

import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";

import "dotenv/config";

import type { FastifyInstance, InjectOptions } from "fastify";

import type { Prisma } from "../src/generated/prisma/client.js";
import { buildApp } from "../src/server/app.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { REMOTE_ADMIN_PATH, type RemoteAdminDeps } from "../src/server/remote/admin-routes.js";
import { REMOTE_CLI_LIMITS, REMOTE_CLI_PATH } from "../src/server/remote/cli-routes.js";
import { DeviceConnections } from "../src/server/remote/connections.js";
import { createDevice, findActiveDevice, listActiveDevices, revokeAllDevices, revokeDevice } from "../src/server/remote/devices.js";
import type { RemoteAuditEvent } from "../src/server/remote/gate.js";
import { RegistrationCodes } from "../src/server/remote/registration-code.js";

const PORT = 16198;
// the contract the shell CLI sends (lib/ga-remote.sh → GA_REMOTE_CLI_HEADER)
const CLI = { host: `127.0.0.1:${PORT}`, "x-glass-atrium-cli": "remote-access" };

class Rollback extends Error {}

let clock = Date.parse("2026-11-14T21:45:00.000Z");
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
    getAccess: () => ({ enabled: true, trusted: [] }),
    now,
  };
}

before(async () => {
  app = await buildApp(PORT, { admin: buildAdminDeps() });
  await app.ready();
});

// a fresh limiter window per case → no case inherits another's request budget
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

function callCli(request: { method: InjectOptions["method"]; url: string; headers?: Record<string, string>; payload?: string; remoteAddress?: string }) {
  return app.inject({
    method: request.method,
    url: request.url,
    headers: request.headers ?? CLI,
    ...(request.payload === undefined ? {} : { payload: request.payload }),
    ...(request.remoteAddress === undefined ? {} : { remoteAddress: request.remoteAddress }),
  });
}

const ROUTES: { name: string; method: InjectOptions["method"]; getUrl: (id: bigint) => string }[] = [
  { name: "list devices", method: "GET", getUrl: () => REMOTE_CLI_PATH.DEVICES },
  { name: "revoke one", method: "DELETE", getUrl: (id) => `${REMOTE_CLI_PATH.DEVICES}/${id}` },
  { name: "revoke all", method: "POST", getUrl: () => REMOTE_CLI_PATH.REVOKE_ALL },
];

describe("every cli route", () => {
  test("refuses with 403 a browser header, a missing or wrong cli header, a non-loopback Host or socket, and changes nothing", async () => {
    const refusals: { name: string; headers?: Record<string, string>; remoteAddress?: string }[] = [
      { name: "Sec-Fetch-Site", headers: { ...CLI, "sec-fetch-site": "none" } },
      { name: "Sec-Fetch-Mode", headers: { ...CLI, "sec-fetch-mode": "cors" } },
      { name: "Sec-Fetch-Dest", headers: { ...CLI, "sec-fetch-dest": "empty" } },
      { name: "Origin", headers: { ...CLI, origin: `http://127.0.0.1:${PORT}` } },
      { name: "Referer", headers: { ...CLI, referer: `http://127.0.0.1:${PORT}/` } },
      { name: "Cookie", headers: { ...CLI, cookie: "theme=dark" } },
      { name: "no cli header", headers: { host: CLI.host } },
      { name: "a wrong cli header value", headers: { ...CLI, "x-glass-atrium-cli": "remote-access-x" } },
      { name: "a rebound Host", headers: { ...CLI, host: `owner-mac.local:${PORT}` } },
      { name: "the loopback name on another port", headers: { ...CLI, host: "localhost:16145" } },
      { name: "a non-loopback socket", remoteAddress: "192.168.0.31" },
    ];
    await runRolledBack(async () => {
      const device = await addDevice("Owner iPhone");
      for (const route of ROUTES) {
        for (const refusal of refusals) {
          const response = await callCli({ method: route.method, url: route.getUrl(device.id), ...refusal });
          assert.equal(response.statusCode, 403, `${route.name} / ${refusal.name}: ${response.body}`);
          assert.ok(!("devices" in JSON.parse(response.body)), `${route.name} / ${refusal.name}`);
        }
      }
      assert.deepEqual([events, (await listActiveDevices(db)).map((entry) => entry.id)], [[], [device.id]]);
    });
  });

  test("answers the cli with no-store and no CORS header, and OPTIONS gets no allowing answer", async () => {
    await runRolledBack(async () => {
      const device = await addDevice("Owner iPhone");
      for (const route of ROUTES) {
        const url = route.getUrl(device.id);
        const response = await callCli({ method: route.method, url });
        assert.equal(response.statusCode, 200, `${route.name}: ${response.body}`);
        const preflight = await callCli({
          method: "OPTIONS",
          url,
          headers: { ...CLI, origin: "http://evil.example", "access-control-request-method": route.method ?? "GET" },
        });
        const allowing = Object.keys({ ...response.headers, ...preflight.headers }).filter((name) => name.startsWith("access-control-"));
        assert.deepEqual([response.headers["cache-control"], allowing, preflight.statusCode >= 400], ["no-store", [], true], route.name);
      }
    });
  });

  test("refuses a request body, so no request value reaches the action", async () => {
    await runRolledBack(async () => {
      const device = await addDevice("Owner iPhone");
      for (const route of ROUTES.filter((entry) => entry.method !== "GET")) {
        const response = await callCli({
          method: route.method,
          url: route.getUrl(device.id),
          headers: { ...CLI, "content-type": "application/json" },
          payload: JSON.stringify({ id: "1" }),
        });
        assert.equal(response.statusCode, 400, `${route.name}: ${response.body}`);
      }
      assert.deepEqual((await listActiveDevices(db)).map((entry) => entry.id), [device.id]);
    });
  });

  test("past the per-minute limit across the three routes is refused with 429", async () => {
    await runRolledBack(async () => {
      for (let index = 0; index < REMOTE_CLI_LIMITS.REQUESTS.limit; index += 1) {
        const route = ROUTES[index % 2 === 0 ? 0 : 2];
        assert.equal((await callCli({ method: route?.method, url: route?.getUrl(0n) ?? "" })).statusCode, 200);
      }
      const limited = await callCli({ method: "GET", url: REMOTE_CLI_PATH.DEVICES });
      assert.deepEqual([limited.statusCode, JSON.parse(limited.body)], [429, { error: "too_many_requests" }]);
    });
  });
});

test("the cli header never admits a remote-admin route", async () => {
  await runRolledBack(async () => {
    const device = await addDevice("Owner iPhone");
    const adminRoutes = [
      { method: "POST", url: REMOTE_ADMIN_PATH.REGISTRATION },
      { method: "GET", url: REMOTE_ADMIN_PATH.DEVICES },
      { method: "DELETE", url: `${REMOTE_ADMIN_PATH.DEVICES}/${device.id}` },
      { method: "POST", url: REMOTE_ADMIN_PATH.REVOKE_ALL },
    ] as const;
    for (const route of adminRoutes) {
      const response = await callCli({ method: route.method, url: route.url });
      assert.equal(response.statusCode, 403, `${route.method} ${route.url}: ${response.body}`);
    }
    assert.deepEqual([openedCodes, (await listActiveDevices(db)).map((entry) => entry.id)], [[], [device.id]]);
  });
});

describe("listing devices", () => {
  test("returns only id, label, created and last-seen of active devices and records one listing row as the cli", async () => {
    await runRolledBack(async () => {
      const kept = await addDevice("Owner iPhone");
      const revoked = await addDevice("Old iPad");
      await revokeDevice(db, revoked.id);
      const response = await callCli({ method: "GET", url: REMOTE_CLI_PATH.DEVICES });
      const body = JSON.parse(response.body) as { devices: Record<string, unknown>[] };
      assert.deepEqual([Object.keys(body), body.devices.map((entry) => [entry.id, entry.label, Object.keys(entry).sort()])], [
        ["devices"],
        [[String(kept.id), "Owner iPhone", ["createdAt", "id", "label", "lastSeenAt"]]],
      ]);
      assert.deepEqual(events.map((event) => [event.actor, event.actionKind, event.result]), [["monitor-cli", "remote.devices_listed", "success"]]);
    });
  });

  test("an audit failure never blocks the listing", async () => {
    isAuditDown = true;
    const response = await callCli({ method: "GET", url: REMOTE_CLI_PATH.DEVICES });
    assert.equal(response.statusCode, 200, response.body);
  });
});

describe("revoking one device", () => {
  test("closes its open sockets, stops its cookie admitting, leaves other devices and audits the revoke as the cli", async () => {
    await runRolledBack(async () => {
      const target = await addDevice("Lost iPhone");
      const other = await addDevice("Owner iPad");
      const socket = await trackOpenSocket(target.id);
      const response = await callCli({ method: "DELETE", url: `${REMOTE_CLI_PATH.DEVICES}/${target.id}` });
      assert.deepEqual([response.statusCode, JSON.parse(response.body)], [200, { revoked: 1 }]);
      assert.deepEqual(
        [socket.destroyed, await findActiveDevice(db, target.presented), (await findActiveDevice(db, other.presented))?.id],
        [true, null, other.id],
      );
      assert.deepEqual(events.map((event) => [event.actor, event.actionKind, event.result, event.targetId]), [["monitor-cli", "remote.revoke", "success", target.id]]);
    });
  });

  test("an unknown or already revoked id gets the one device_not_found", async () => {
    await runRolledBack(async () => {
      const revoked = await addDevice("Old iPad");
      await revokeDevice(db, revoked.id);
      for (const id of [revoked.id, revoked.id + 1000n]) {
        const response = await callCli({ method: "DELETE", url: `${REMOTE_CLI_PATH.DEVICES}/${id}` });
        assert.deepEqual([response.statusCode, response.body], [404, JSON.stringify({ error: "device_not_found" })], String(id));
      }
    });
  });

  test("an id that is not a bounded decimal device id is refused before the store", async () => {
    for (const id of ["abc", "0", "-1", "1e3", "07", "99999999999999999999"]) {
      const response = await callCli({ method: "DELETE", url: `${REMOTE_CLI_PATH.DEVICES}/${id}` });
      assert.equal(response.statusCode, 400, id);
    }
  });

  test("an audit failure never blocks the revoke", async () => {
    await runRolledBack(async () => {
      const target = await addDevice("Lost iPhone");
      isAuditDown = true;
      const response = await callCli({ method: "DELETE", url: `${REMOTE_CLI_PATH.DEVICES}/${target.id}` });
      assert.deepEqual([response.statusCode, await findActiveDevice(db, target.presented)], [200, null]);
    });
  });
});

describe("revoking every device", () => {
  test("closes every device's sockets, stops every cookie and returns and audits the count only", async () => {
    await runRolledBack(async () => {
      const first = await addDevice("Owner iPhone");
      const second = await addDevice("Owner iPad");
      const sockets = [await trackOpenSocket(first.id), await trackOpenSocket(second.id)];
      const response = await callCli({ method: "POST", url: REMOTE_CLI_PATH.REVOKE_ALL });
      assert.deepEqual([response.statusCode, JSON.parse(response.body)], [200, { revoked: 2 }]);
      assert.deepEqual(
        [sockets.map((socket) => socket.destroyed), await findActiveDevice(db, first.presented), await findActiveDevice(db, second.presented)],
        [[true, true], null, null],
      );
      assert.deepEqual(
        events.map((event) => [event.actor, event.actionKind, event.result, event.targetId, event.payload?.count]),
        [["monitor-cli", "remote.revoke", "success", undefined, 2]],
      );
    });
  });
});
