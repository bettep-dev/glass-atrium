// Remote device registration: the one pre-auth mutation, turning an accepted code into a device cookie.
// Every case runs in a transaction that never commits → the test database keeps no device rows.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/remote-registration.route.test.ts

import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import "dotenv/config";

import type { FastifyInstance } from "fastify";

import type { Prisma } from "../src/generated/prisma/client.js";
import { buildRemoteApp } from "../src/server/app.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { DeviceConnections } from "../src/server/remote/connections.js";
import { DEVICE, createDevice, findActiveDevice } from "../src/server/remote/devices.js";
import type { RemoteAuditEvent } from "../src/server/remote/gate.js";
import { REGISTRATION_CODE, RegistrationCodes } from "../src/server/remote/registration-code.js";
import { REMOTE_PRE_AUTH_ROUTES, getRouteClass } from "../src/server/remote/route-classes.js";
import { DEVICE_COOKIE } from "../src/server/remote/session.js";
import { deleteDirectory } from "./lib/remove-dir.js";
import { createStandInTls } from "./lib/remote-tls.js";

const HOST = "owner-mac.local:16146";
const ORIGIN = `https://${HOST}`;
const PHONE = "192.168.0.31";
const LABEL = "Owner iPhone 15";
const PAGE_HEADERS = { host: HOST, "sec-fetch-site": "same-origin" };
// a well-formed code no open registration holds (the open one is random)
const UNISSUED_CODE = "23456789";

class Rollback extends Error {}

let clock = Date.parse("2026-11-14T06:00:00.000Z");
const now = () => clock;
let codes = new RegistrationCodes({ now });
let db: Prisma.TransactionClient = getPrisma();
let isStoreDown = false;
const events: RemoteAuditEvent[] = [];
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
          events.push(event);
        },
      },
      now,
    },
    registration: {
      codes: { consume: (entry) => codes.consume(entry) },
      createDevice: (label) => (isStoreDown ? Promise.reject(new Error("device store unavailable")) : createDevice(db, label)),
    },
    device: { revoke: async () => false, revokeAll: async () => [], turnOff: () => undefined },
  });
  await app.ready();
});

// past every limiter window and block → no case inherits another's budget
beforeEach(() => {
  clock += 60 * 60_000;
  codes = new RegistrationCodes({ now });
  events.length = 0;
  isStoreDown = false;
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

function postRegistration(body: Record<string, unknown>, options: { remoteAddress?: string; headers?: Record<string, string> } = {}) {
  return app.inject({
    method: "POST",
    url: "/api/remote/register",
    remoteAddress: options.remoteAddress ?? PHONE,
    headers: options.headers ?? PAGE_HEADERS,
    payload: body,
  });
}

function getEventRows() {
  return events.map((event) => [event.actionKind, event.result, event.actor]);
}

describe("an accepted code", () => {
  test("issues a host-only device cookie that then admits a page request", async () => {
    await runRolledBack(async () => {
      const response = await postRegistration({ code: codes.open(), label: LABEL });
      assert.equal(response.statusCode, 201, response.body);
      const [cookie] = response.cookies;
      assert.ok(cookie, "Set-Cookie expected");
      assert.deepEqual(
        { name: cookie.name, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, path: cookie.path, maxAge: cookie.maxAge },
        { name: DEVICE_COOKIE.NAME, httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: DEVICE_COOKIE.MAX_AGE_S },
      );
      const device = await findActiveDevice(db, cookie.value);
      assert.ok(device, "the cookie value names a stored device");
      assert.deepEqual(JSON.parse(response.body), { device: { id: String(device.id), label: LABEL } });
      assert.deepEqual(events.map((event) => [event.actionKind, event.result, event.actor, event.targetId]), [
        ["remote.registration_success", "success", `remote:${device.id}@${PHONE}`, device.id],
      ]);
      const page = await app.inject({ method: "GET", url: "/index.html", remoteAddress: PHONE, headers: { host: HOST, cookie: `${DEVICE_COOKIE.NAME}=${cookie.value}` } });
      assert.equal(page.statusCode, 200);
    });
  });

  test("past the active-device cap issues no cookie and audits the spent code as a refused registration", async () => {
    await runRolledBack(async () => {
      for (let index = 0; index < DEVICE.MAX_ACTIVE; index += 1) await createDevice(db, `Device ${index}`);
      const response = await postRegistration({ code: codes.open(), label: LABEL });
      assert.deepEqual([response.statusCode, JSON.parse(response.body)], [409, { error: "device_limit_reached" }]);
      assert.equal(response.headers["set-cookie"], undefined);
      assert.deepEqual(getEventRows(), [["remote.registration_failure", "blocked", `remote:-@${PHONE}`]]);
    });
  });

  test("a device store failure issues no cookie and audits the spent code as an errored registration", async () => {
    isStoreDown = true;
    const response = await postRegistration({ code: codes.open(), label: LABEL });
    assert.deepEqual([response.statusCode, response.headers["set-cookie"]], [500, undefined]);
    assert.deepEqual(getEventRows(), [["remote.registration_failure", "error", `remote:-@${PHONE}`]]);
  });
});

describe("a refused code", () => {
  test("wrong, reused, expired and unopened codes all get the one opaque error, no cookie and a failure audit row", async () => {
    const rows = [
      { name: "wrong code", remoteAddress: "192.168.0.41", getEntry: async () => (codes.open(), UNISSUED_CODE) },
      {
        name: "reused code",
        remoteAddress: "192.168.0.42",
        getEntry: async () => {
          const code = codes.open();
          assert.equal((await postRegistration({ code, label: LABEL }, { remoteAddress: "192.168.0.52" })).statusCode, 201);
          return code;
        },
      },
      {
        name: "expired code",
        remoteAddress: "192.168.0.43",
        getEntry: async () => {
          const code = codes.open();
          clock += REGISTRATION_CODE.WINDOW_MS;
          return code;
        },
      },
      { name: "no registration open", remoteAddress: "192.168.0.44", getEntry: async () => UNISSUED_CODE },
    ];
    await runRolledBack(async () => {
      for (const row of rows) {
        codes = new RegistrationCodes({ now });
        const entry = await row.getEntry();
        events.length = 0;
        const response = await postRegistration({ code: entry, label: LABEL }, { remoteAddress: row.remoteAddress });
        assert.deepEqual([response.statusCode, response.body], [400, JSON.stringify({ error: "registration_refused" })], row.name);
        assert.equal(response.headers["set-cookie"], undefined, row.name);
        assert.deepEqual(getEventRows(), [["remote.registration_failure", "blocked", `remote:-@${row.remoteAddress}`]], row.name);
        assert.ok(!JSON.stringify(events, (_key, value: unknown) => (typeof value === "bigint" ? String(value) : value)).includes(entry), row.name);
      }
    });
  });
});

describe("a request refused before the code check", () => {
  test("never spends the code, so the same code is accepted next", async () => {
    const rows: { name: string; status: number; body: Record<string, unknown>; headers: Record<string, string> }[] = [
      { name: "label outside the allowed set", status: 400, body: { label: "<b>phone</b>" }, headers: PAGE_HEADERS },
      { name: "body over 1 KiB", status: 413, body: { label: LABEL, padding: "x".repeat(1_100) }, headers: PAGE_HEADERS },
      { name: "cross-site fetch metadata", status: 403, body: { label: LABEL }, headers: { host: HOST, "sec-fetch-site": "cross-site" } },
      { name: "no fetch metadata and no Origin", status: 403, body: { label: LABEL }, headers: { host: HOST } },
      { name: "foreign Origin only", status: 403, body: { label: LABEL }, headers: { host: HOST, origin: "https://evil.example" } },
    ];
    await runRolledBack(async () => {
      for (const [index, row] of rows.entries()) {
        // a fresh limiter minute per row → only the refusal under test can answer
        clock += 61_000;
        codes = new RegistrationCodes({ now });
        const code = codes.open();
        const remoteAddress = `192.168.1.${index + 1}`;
        const refused = await postRegistration({ code, ...row.body }, { remoteAddress, headers: row.headers });
        assert.equal(refused.statusCode, row.status, `${row.name}: ${refused.body}`);
        const accepted = await postRegistration({ code, label: LABEL }, { remoteAddress });
        assert.equal(accepted.statusCode, 201, `${row.name}: ${accepted.body}`);
      }
    });
  });
});

describe("code entry limits", () => {
  test("an entry past the per-address or total budget gets 429 even with the right code, and spends nothing", async () => {
    const rows = [
      { name: "per address", spentAddresses: ["192.168.2.1", "192.168.2.1", "192.168.2.1"], finalAddress: "192.168.2.1" },
      { name: "in total", spentAddresses: Array.from({ length: 10 }, (_value, index) => `192.168.3.${index + 1}`), finalAddress: "192.168.3.99" },
    ];
    await runRolledBack(async () => {
      for (const row of rows) {
        clock += 60 * 60_000;
        codes = new RegistrationCodes({ now });
        for (const remoteAddress of row.spentAddresses) await postRegistration({ code: UNISSUED_CODE, label: LABEL }, { remoteAddress });
        const code = codes.open();
        const limited = await postRegistration({ code, label: LABEL }, { remoteAddress: row.finalAddress });
        assert.deepEqual([limited.statusCode, JSON.parse(limited.body)], [429, { error: "too_many_requests" }], row.name);
        clock += 61_000;
        const accepted = await postRegistration({ code, label: LABEL }, { remoteAddress: row.finalAddress });
        assert.equal(accepted.statusCode, 201, `${row.name}: ${accepted.body}`);
      }
    });
  });
});
