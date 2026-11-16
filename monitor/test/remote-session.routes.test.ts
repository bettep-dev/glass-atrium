// A registered device's own routes on the remote listener: read its session, log itself out, turn remote access off.
// A remote action only removes the caller's access or everyone's — never selects another device, never restores.
// Device rows live in a transaction that never commits → the test database keeps none.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/remote-session.routes.test.ts

import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";

import "dotenv/config";

import type { FastifyInstance } from "fastify";

import type { Prisma } from "../src/generated/prisma/client.js";
import { buildRemoteApp } from "../src/server/app.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { DeviceConnections } from "../src/server/remote/connections.js";
import { createDevice, findActiveDevice, revokeAllDevices, revokeDevice } from "../src/server/remote/devices.js";
import type { RemoteAuditEvent } from "../src/server/remote/gate.js";
import { REMOTE_PRE_AUTH_ROUTES, getRouteClass } from "../src/server/remote/route-classes.js";
import { CSRF_HEADER, DEVICE_COOKIE, getCsrfToken } from "../src/server/remote/session.js";
import { deleteDirectory } from "./lib/remove-dir.js";
import { createStandInTls } from "./lib/remote-tls.js";

const HOST = "owner-mac.local:16146";
const ORIGIN = `https://${HOST}`;
const PHONE = "192.168.0.31";

class Rollback extends Error {}

let clock = Date.parse("2026-11-14T17:00:00.000Z");
const now = () => clock;
let db: Prisma.TransactionClient = getPrisma();
const events: RemoteAuditEvent[] = [];
const failures = { isAuditDown: false, isRevokeDown: false };
let turnOffCount = 0;
let app: FastifyInstance;
let tlsDir = "";

before(async () => {
  const getHosts = () => new Set([HOST]);
  const getPageOrigins = () => new Set([ORIGIN]);
  const tls = await createStandInTls();
  tlsDir = tls.dir;
  app = await buildRemoteApp({
    tls,
    listener: { kind: "remote", getHosts, getPageOrigins },
    gate: {
      getHosts,
      getPageOrigins,
      findDevice: (presented) => findActiveDevice(db, presented),
      getRouteClass,
      preAuthRoutes: REMOTE_PRE_AUTH_ROUTES,
      connections: new DeviceConnections(),
      audit: {
        insertIntent: async () => 1n,
        setResult: async () => undefined,
        insertEvent: async (event) => {
          if (failures.isAuditDown) throw new Error("audit store unavailable");
          events.push(event);
        },
      },
      now,
    },
    registration: { codes: { consume: () => "refused" }, createDevice: async () => ({ outcome: "cap_reached" }) },
    device: {
      revoke: (id) => revokeDevice(db, id),
      revokeAll: () => (failures.isRevokeDown ? Promise.reject(new Error("device store unavailable")) : revokeAllDevices(db)),
      turnOff: () => {
        turnOffCount += 1;
      },
    },
  });
  await app.ready();
});

beforeEach(() => {
  clock += 60 * 60_000;
  events.length = 0;
  failures.isAuditDown = false;
  failures.isRevokeDown = false;
  turnOffCount = 0;
});

after(async () => {
  await app.close();
  await disconnectPrisma();
  deleteDirectory(tlsDir);
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

function asDevice(presented: string, extra: Record<string, string> = {}): Record<string, string> {
  return { host: HOST, cookie: `${DEVICE_COOKIE.NAME}=${presented}`, ...extra };
}

function asPageMutation(presented: string): Record<string, string> {
  return asDevice(presented, { "sec-fetch-site": "same-origin", [CSRF_HEADER]: getCsrfToken(presented) });
}

function getEventRows() {
  return events.map((event) => [event.actor, event.actionKind, event.result, event.targetId]);
}

// onResponse runs after inject resolves → bounded turns of the event loop, never a wall-clock sleep
async function waitForTurnOff(): Promise<void> {
  for (let turn = 0; turn < 100 && turnOffCount === 0; turn += 1) await nextTurn();
}

function getSetCookies(header: string | string[] | number | undefined): string[] {
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [String(header)];
}

describe("reading the session", () => {
  test("returns the CSRF value and the caller's own id and label only, with no-store and no CORS header", async () => {
    await runRolledBack(async () => {
      await addDevice("Owner iPad");
      const caller = await addDevice("Owner iPhone");
      const response = await app.inject({ method: "GET", url: "/api/remote/session", remoteAddress: PHONE, headers: asDevice(caller.presented) });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(JSON.parse(response.body), { csrf: getCsrfToken(caller.presented), device: { id: String(caller.id), label: "Owner iPhone" } });
      assert.deepEqual([response.headers["cache-control"], response.headers["access-control-allow-origin"]], ["no-store", undefined]);
    });
  });

  test("is refused when fetch metadata names anything but same-origin", async () => {
    await runRolledBack(async () => {
      const caller = await addDevice("Owner iPhone");
      for (const site of ["cross-site", "same-site", "none"]) {
        const response = await app.inject({ method: "GET", url: "/api/remote/session", remoteAddress: PHONE, headers: asDevice(caller.presented, { "sec-fetch-site": site }) });
        assert.deepEqual([response.statusCode, response.body.includes("csrf")], [403, false], site);
      }
    });
  });
});

describe("logging out", () => {
  test("revokes only the caller, whatever id the path query names, and audits the caller's own revoke", async () => {
    await runRolledBack(async () => {
      const other = await addDevice("Owner iPad");
      const caller = await addDevice("Owner iPhone");
      const response = await app.inject({ method: "POST", url: `/api/remote/logout?id=${other.id}`, remoteAddress: PHONE, headers: asPageMutation(caller.presented) });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual([await findActiveDevice(db, caller.presented), (await findActiveDevice(db, other.presented))?.id], [null, other.id]);
      assert.deepEqual(getEventRows(), [[`remote:${caller.id}@${PHONE}`, "remote.revoke", "success", caller.id]]);
    });
  });

  test("a body naming another device is refused and changes nothing", async () => {
    await runRolledBack(async () => {
      const other = await addDevice("Owner iPad");
      const caller = await addDevice("Owner iPhone");
      const response = await app.inject({
        method: "POST",
        url: "/api/remote/logout",
        remoteAddress: PHONE,
        headers: { ...asPageMutation(caller.presented), "content-type": "application/json" },
        payload: JSON.stringify({ id: String(other.id) }),
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.deepEqual([(await findActiveDevice(db, caller.presented))?.id, (await findActiveDevice(db, other.presented))?.id], [caller.id, other.id]);
    });
  });

  test("answers with exactly one Set-Cookie, which expires the device cookie", async () => {
    await runRolledBack(async () => {
      const caller = await addDevice("Owner iPhone");
      const response = await app.inject({ method: "POST", url: "/api/remote/logout", remoteAddress: PHONE, headers: asPageMutation(caller.presented) });
      const cookies = getSetCookies(response.headers["set-cookie"]);
      assert.equal(cookies.length, 1, cookies.join(" | "));
      assert.match(cookies[0] ?? "", new RegExp(`^${DEVICE_COOKIE.NAME}=;.*Max-Age=0`));
    });
  });
});

describe("turning remote access off", () => {
  test("revokes every device, the caller included, closes the listener and audits the caller's off", async () => {
    await runRolledBack(async () => {
      const other = await addDevice("Owner iPad");
      const caller = await addDevice("Owner iPhone");
      const response = await app.inject({ method: "POST", url: "/api/remote/off", remoteAddress: PHONE, headers: asPageMutation(caller.presented) });
      await waitForTurnOff();
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual([await findActiveDevice(db, caller.presented), await findActiveDevice(db, other.presented), turnOffCount], [null, null, 1]);
      assert.deepEqual(getEventRows(), [[`remote:${caller.id}@${PHONE}`, "remote.off", "success", caller.id]]);
      assert.doesNotMatch(response.body, /Owner|restart|config/);
    });
  });

  test("closes the listener even when the device revoke or the audit write fails", async () => {
    const rows = [
      { name: "revoke fails", failure: "isRevokeDown" },
      { name: "audit write fails", failure: "isAuditDown" },
    ] as const;
    await runRolledBack(async () => {
      for (const row of rows) {
        const caller = await addDevice(`Phone ${row.failure}`);
        turnOffCount = 0;
        failures.isAuditDown = false;
        failures.isRevokeDown = false;
        failures[row.failure] = true;
        await app.inject({ method: "POST", url: "/api/remote/off", remoteAddress: PHONE, headers: asPageMutation(caller.presented) });
        await waitForTurnOff();
        assert.equal(turnOffCount, 1, row.name);
      }
    });
  });

  test("takes no body, so no request value reaches the action", async () => {
    await runRolledBack(async () => {
      const caller = await addDevice("Owner iPhone");
      const response = await app.inject({
        method: "POST",
        url: "/api/remote/off",
        remoteAddress: PHONE,
        headers: { ...asPageMutation(caller.presented), "content-type": "application/json" },
        payload: JSON.stringify({ enabled: true }),
      });
      await nextTurn();
      assert.deepEqual([response.statusCode, turnOffCount, (await findActiveDevice(db, caller.presented))?.id], [400, 0, caller.id]);
    });
  });
});

describe("the Mac-only admin paths on the remote listener", () => {
  test("refuse a registered device with no data and a route_denied row", async () => {
    const paths = [
      { method: "POST", url: "/api/remote/registration" },
      { method: "GET", url: "/api/remote/devices" },
      { method: "DELETE", url: "/api/remote/devices/1" },
      { method: "POST", url: "/api/remote/devices/revoke-all" },
    ] as const;
    await runRolledBack(async () => {
      const caller = await addDevice("Owner iPhone");
      for (const path of paths) {
        events.length = 0;
        const response = await app.inject({ method: path.method, url: path.url, remoteAddress: PHONE, headers: asPageMutation(caller.presented) });
        await nextTurn();
        assert.deepEqual([response.statusCode, JSON.parse(response.body)], [403, { error: "route_not_available" }], path.url);
        assert.deepEqual(events.map((event) => event.actionKind), ["remote.route_denied"], path.url);
      }
    });
  });
});
