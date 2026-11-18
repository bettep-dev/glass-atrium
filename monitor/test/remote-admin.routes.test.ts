// Loopback admin routes for remote access: open a registration code, list and revoke devices — the Mac's page only.
// Device rows live in a transaction that never commits → the test database keeps none.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/remote-admin.routes.test.ts

import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { Writable } from "node:stream";
import { promisify } from "node:util";

import "dotenv/config";

import Fastify, { type FastifyBaseLogger, type FastifyInstance, type InjectOptions } from "fastify";
import pino from "pino";

import type { Prisma } from "../src/generated/prisma/client.js";
import { buildApp } from "../src/server/app.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { LOGGER_OPTIONS } from "../src/server/logger.js";
import {
  type AccessApplyOutcome,
  type AccessApplyResult,
  type AccessStepOutcome,
  type ConfirmFacts,
  CA_DOWNLOAD,
  MAC_PAGE_HEADER,
  REMOTE_ADMIN_LIMITS,
  REMOTE_ADMIN_PATH,
  type RemoteAdminDeps,
  type SetupFacts,
  registerRemoteAdminRoutes,
} from "../src/server/remote/admin-routes.js";
import { DeviceConnections } from "../src/server/remote/connections.js";
import { createDevice, findActiveDevice, listActiveDevices, revokeAllDevices, revokeDevice } from "../src/server/remote/devices.js";
import type { RemoteAuditEvent } from "../src/server/remote/gate.js";
import { RegistrationCodes } from "../src/server/remote/registration-code.js";
import { createStandInTls } from "./lib/remote-tls.js";
import { deleteDirectory } from "./lib/remove-dir.js";

const PORT = 16199;
const MAC_PAGE: Record<string, string> = { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin", [MAC_PAGE_HEADER.NAME]: MAC_PAGE_HEADER.VALUE };
const SETUP_FACTS: SetupFacts = {
  enabled: true,
  isOffByDevice: false,
  listenReason: "trusted",
  hasRouter: true,
  isNetworkTrusted: true,
  trustedCount: 1,
  isAnswering: true,
  hostName: "owner-mac.local",
  address: "192.168.0.24",
  port: 16443,
  deviceLimit: 10,
};
// a careless caller's setup value: the router, the interface and the key path beside the facts
const WIDE_SETUP_FACTS = { ...SETUP_FACTS, gateway: "192.168.0.1", hardwareAddress: "a4:2b:b0:11:22:33", interface: "en0", caKeyPath: "/Users/owner/ca.key" };
const CONFIRM_FACTS: ConfirmFacts = { router: "10.20.0.1", link: "wifi", isNetworkTrusted: false };
// a careless caller's confirm value: the router's hardware address and the interface beside the facts
const WIDE_CONFIRM_FACTS = { ...CONFIRM_FACTS, hardwareAddress: "3c:22:fb:9a:01:7e", interface: "en0" };

class Rollback extends Error {}

let clock = Date.parse("2026-11-14T16:40:00.000Z");
const now = () => clock;
let db: Prisma.TransactionClient = getPrisma();
const events: RemoteAuditEvent[] = [];
let isAuditDown = false;
let openedCodes: string[] = [];
// the page's acts as the shell step and the in-process apply answer them; the trail orders acts against audit rows
const access = {
  outcome: "written" as AccessApplyOutcome,
  offOutcome: "written" as AccessStepOutcome,
  isCloseFailing: false,
  hold: Promise.resolve(),
  certificate: null as Buffer | null,
  // the trust the on added in the same act; null → none tried
  onTrust: null as AccessApplyResult | null,
};
const trail: string[] = [];
let ca: Awaited<ReturnType<typeof createStandInTls>>;
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
        trail.push(`row ${event.actionKind}`);
        if (isAuditDown) throw new Error("audit store unavailable");
        events.push(event);
      },
    },
    access: {
      getConfirmFacts: async () => {
        trail.push("read confirm");
        return WIDE_CONFIRM_FACTS;
      },
      turnOn: async () => ({ ...(await runAccessAct("on")), trust: access.onTrust }),
      trust: () => runAccessAct("trust"),
      setOff: async () => {
        trail.push("act off");
        return access.offOutcome;
      },
      close: async () => {
        trail.push("act close");
        if (access.isCloseFailing) throw new Error("listener close failed");
      },
      getSetupFacts: async () => WIDE_SETUP_FACTS,
      readCertificate: async () => access.certificate,
    },
    now,
  };
}

async function runAccessAct(act: string): Promise<{ outcome: AccessApplyOutcome; trustedCount: number }> {
  trail.push(`act ${act}`);
  await access.hold;
  return { outcome: access.outcome, trustedCount: 2 };
}

before(async () => {
  ca = await createStandInTls({ isCa: true });
  app = await buildApp(PORT, { admin: buildAdminDeps() });
  await app.ready();
});

// a fresh limiter window per case → no case inherits another's open budget
beforeEach(() => {
  clock += 60 * 60_000;
  events.length = 0;
  openedCodes = [];
  isAuditDown = false;
  trail.length = 0;
  Object.assign(access, { outcome: "written", offOutcome: "written", isCloseFailing: false, hold: Promise.resolve(), certificate: ca.cert, onTrust: null });
});

after(async () => {
  await app.close();
  await disconnectPrisma();
  deleteDirectory(ca.dir);
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
  { name: "turn on", method: "POST", getUrl: () => REMOTE_ADMIN_PATH.ACCESS_ON },
  { name: "turn off", method: "POST", getUrl: () => REMOTE_ADMIN_PATH.ACCESS_OFF },
  { name: "trust this network", method: "POST", getUrl: () => REMOTE_ADMIN_PATH.TRUST },
  { name: "read the network to confirm", method: "GET", getUrl: () => REMOTE_ADMIN_PATH.CONFIRM_NETWORK },
  { name: "read the setup facts", method: "GET", getUrl: () => REMOTE_ADMIN_PATH.SETUP },
  { name: "download the certificate", method: "GET", getUrl: () => REMOTE_ADMIN_PATH.CERTIFICATE },
];

/** The Mac page's own request with one header replaced, or dropped when no value is given. */
function getMacPageHeaders(name: string, value?: string): Record<string, string> {
  const { [name]: _replaced, ...rest } = MAC_PAGE;
  return value === undefined ? rest : { ...rest, [name]: value };
}

// what a document's markup can send at a same-origin route: fetch metadata yes, a script-set header never
const DOCUMENT_ORIGIN = { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${PORT}` };
const MARKUP_REQUESTS: { name: string; method: "GET" | "POST"; headers: Record<string, string>; payload?: string }[] = [
  {
    name: "an empty form post",
    method: "POST",
    headers: { ...DOCUMENT_ORIGIN, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "content-type": "application/x-www-form-urlencoded" },
    payload: "",
  },
  {
    name: "an empty text/plain form post",
    method: "POST",
    headers: { ...DOCUMENT_ORIGIN, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "content-type": "text/plain" },
    payload: "",
  },
  {
    name: "a link ping",
    method: "POST",
    headers: {
      ...DOCUMENT_ORIGIN,
      "sec-fetch-mode": "no-cors",
      "sec-fetch-dest": "empty",
      "content-type": "text/ping",
      "ping-from": `http://127.0.0.1:${PORT}/#clauded-docs`,
      "ping-to": "https://example.com/setup",
    },
    payload: "PING",
  },
  {
    name: "an image request",
    method: "GET",
    headers: { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image", accept: "image/avif,image/webp,*/*" },
  },
];

describe("every admin route", () => {
  test("refuses with 403 unless the request is the page's script, same-origin by fetch metadata at a loopback Host, and changes nothing", async () => {
    const refusals: { name: string; headers: Record<string, string> }[] = [
      { name: "no fetch metadata", headers: getMacPageHeaders("sec-fetch-site") },
      { name: "fetch metadata none", headers: getMacPageHeaders("sec-fetch-site", "none") },
      { name: "same-site", headers: getMacPageHeaders("sec-fetch-site", "same-site") },
      { name: "cross-site", headers: getMacPageHeaders("sec-fetch-site", "cross-site") },
      { name: "same-origin at a rebound Host", headers: getMacPageHeaders("host", `owner-mac.local:${PORT}`) },
      { name: "same-origin at the loopback name on another port", headers: getMacPageHeaders("host", "localhost:16145") },
      { name: "no page header", headers: getMacPageHeaders(MAC_PAGE_HEADER.NAME) },
      { name: "the page header with another value", headers: getMacPageHeaders(MAC_PAGE_HEADER.NAME, "1") },
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
      assert.deepEqual([openedCodes, trail, (await listActiveDevices(db)).map((entry) => entry.id)], [[], [], [device.id]]);
    });
  });

  test("refuses what a document's markup can send — a form post, a link ping, an image request — and no act answers a GET", async () => {
    await runRolledBack(async () => {
      const device = await addDevice("Owner iPhone");
      for (const route of ROUTES) {
        for (const markup of MARKUP_REQUESTS) {
          const response = await callAdmin({ method: markup.method, url: route.getUrl(device.id), headers: markup.headers, payload: markup.payload });
          // no route of the markup's method at this path → the router's 404; one there → the page gate's 403
          const expected = markup.method === route.method ? 403 : 404;
          assert.equal(response.statusCode, expected, `${route.name} / ${markup.name}: ${response.statusCode} ${response.body}`);
        }
      }
      assert.deepEqual([openedCodes, trail, (await listActiveDevices(db)).map((entry) => entry.id)], [[], [], [device.id]]);
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
      assert.deepEqual([openedCodes, trail, (await listActiveDevices(db)).map((entry) => entry.id)], [[], [], [device.id]]);
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

const WIDENING_ACTS = [
  { name: "turning on", url: REMOTE_ADMIN_PATH.ACCESS_ON, act: "act on", actionKind: "remote.access_enabled", body: { outcome: "written", trust: null } },
  { name: "trusting this network", url: REMOTE_ADMIN_PATH.TRUST, act: "act trust", actionKind: "remote.network_trusted", body: { outcome: "written" } },
];

describe("an act that widens access", () => {
  for (const row of WIDENING_ACTS) {
    test(`${row.name} writes its request row first, then acts, then records the outcome with the trusted-network count`, async () => {
      const response = await callAdmin({ method: "POST", url: row.url });
      assert.deepEqual([response.statusCode, JSON.parse(response.body)], [200, row.body]);
      assert.deepEqual(trail, ["row remote.access_requested", row.act, `row ${row.actionKind}`]);
      assert.deepEqual(
        events.map((event) => [event.actor, event.result, event.payload]),
        [
          ["monitor-web", "success", { method: "POST", route: row.url, pageOrigin: "fetch_metadata" }],
          ["monitor-web", "success", { method: "POST", route: row.url, outcome: "written", trustedNetworkCount: 2 }],
        ],
      );
    });

    test(`${row.name} does nothing when its request row cannot be written`, async () => {
      isAuditDown = true;
      const response = await callAdmin({ method: "POST", url: row.url });
      assert.deepEqual([response.statusCode, JSON.parse(response.body), trail], [503, { error: "audit_unavailable" }, ["row remote.access_requested"]]);
    });
  }

  test("answers each outcome the step and the apply reported with its own status and records it as not succeeded", async () => {
    const rows: { outcome: AccessApplyOutcome; status: number }[] = [
      { outcome: "already_trusted", status: 409 },
      { outcome: "network_unreadable", status: 409 },
      { outcome: "keys_not_created", status: 500 },
      { outcome: "env_not_rendered", status: 500 },
      { outcome: "config_malformed", status: 500 },
      { outcome: "write_failed", status: 500 },
      { outcome: "start_failed", status: 500 },
      { outcome: "confirm_stale", status: 409 },
      { outcome: "network_changed", status: 409 },
    ];
    for (const row of rows) {
      events.length = 0;
      clock += 60 * 60_000;
      access.outcome = row.outcome;
      const response = await callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.ACCESS_ON });
      assert.deepEqual([response.statusCode, JSON.parse(response.body)], [row.status, { error: row.outcome }], row.outcome);
      assert.deepEqual(events.map((event) => event.result), ["success", "error"], row.outcome);
    }
  });

  test("turning on a network not yet trusted records the on, then the trust of the network shown, each with its own outcome", async () => {
    access.onTrust = { outcome: "network_changed", trustedCount: null };
    const response = await callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.ACCESS_ON });
    assert.deepEqual([response.statusCode, JSON.parse(response.body)], [200, { outcome: "written", trust: "network_changed" }]);
    assert.deepEqual(trail, ["row remote.access_requested", "act on", "row remote.access_enabled", "row remote.network_trusted"]);
    assert.deepEqual(
      events.slice(1).map((event) => [event.result, event.payload?.outcome]),
      [
        ["success", "written"],
        ["error", "network_changed"],
      ],
    );
  });

  test("turning on and trusting share one rate limit, and past it nothing more runs", async () => {
    for (let index = 0; index < REMOTE_ADMIN_LIMITS.ACCESS_WIDEN.limit; index += 1) {
      const url = index % 2 === 0 ? REMOTE_ADMIN_PATH.ACCESS_ON : REMOTE_ADMIN_PATH.TRUST;
      assert.equal((await callAdmin({ method: "POST", url })).statusCode, 200);
    }
    trail.length = 0;
    const limited = await callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.TRUST });
    assert.deepEqual([limited.statusCode, trail], [429, []]);
  });

  test("a second widening act while one runs is refused with 409, so two config writes never interleave", async () => {
    let release = () => undefined as void;
    access.hold = new Promise((resolve) => {
      release = resolve;
    });
    const first = callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.ACCESS_ON });
    await new Promise((resolve) => setImmediate(resolve));
    const second = await callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.TRUST });
    release();
    assert.deepEqual([second.statusCode, (await first).statusCode, trail.filter((entry) => entry.startsWith("act"))], [409, 200, ["act on"]]);
  });
});

describe("turning access off from the Mac page", () => {
  test("persists the off, revokes every device through revoke-all and closes the listener, in that order", async () => {
    await runRolledBack(async () => {
      const device = await addDevice("Owner iPhone");
      const socket = await trackOpenSocket(device.id);
      const response = await callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.ACCESS_OFF });
      assert.deepEqual([response.statusCode, JSON.parse(response.body)], [200, { revoked: 1 }]);
      assert.deepEqual(trail, ["row remote.access_requested", "act off", "row remote.revoke", "act close", "row remote.access_disabled"]);
      assert.deepEqual([socket.destroyed, await findActiveDevice(db, device.presented)], [true, null]);
    });
  });

  test("runs every step when its audit row cannot be written or another step fails, and names the failed steps", async () => {
    await runRolledBack(async () => {
      const device = await addDevice("Owner iPhone");
      isAuditDown = true;
      access.offOutcome = "write_failed";
      access.isCloseFailing = true;
      const response = await callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.ACCESS_OFF });
      assert.deepEqual([response.statusCode, JSON.parse(response.body)], [500, { error: "off_incomplete", failed: ["persist", "close"], revoked: 1 }]);
      assert.deepEqual([trail.filter((entry) => entry.startsWith("act")), await findActiveDevice(db, device.presented)], [["act off", "act close"], null]);
    });
  });

  test("waits for a widening act in flight instead of refusing, so an off is never lost", async () => {
    let release = () => undefined as void;
    access.hold = new Promise((resolve) => {
      release = resolve;
    });
    const on = callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.ACCESS_ON });
    await new Promise((resolve) => setImmediate(resolve));
    const off = callAdmin({ method: "POST", url: REMOTE_ADMIN_PATH.ACCESS_OFF });
    release();
    assert.deepEqual([(await on).statusCode, (await off).statusCode], [200, 200]);
    assert.deepEqual(trail.filter((entry) => entry.startsWith("act")), ["act on", "act off", "act close"]);
  });

  describe("when a store stalls instead of failing", () => {
    const WAIT_TIMEOUT_MS = 20;
    const getStalled = () => new Promise<never>(() => undefined);

    /** Admin routes whose audit store, and optionally device store, never answer; every other dep as above. */
    async function buildStalledApp(isRevokeStalled: boolean): Promise<FastifyInstance> {
      const deps = buildAdminDeps();
      const stalled = Fastify();
      await registerRemoteAdminRoutes(stalled, {
        ...deps,
        devices: { ...deps.devices, revokeAll: () => (isRevokeStalled ? getStalled() : Promise.resolve([])) },
        audit: {
          insertEvent: (event) => {
            trail.push(`row ${event.actionKind}`);
            return getStalled();
          },
        },
        waitTimeoutMs: WAIT_TIMEOUT_MS,
      });
      return stalled;
    }

    test("the off gives up on its request row and the revoke within the bound, still persists and closes, and names the revoke as failed", { timeout: 5_000 }, async () => {
      const stalled = await buildStalledApp(true);
      try {
        const response = await stalled.inject({ method: "POST", url: REMOTE_ADMIN_PATH.ACCESS_OFF, headers: MAC_PAGE });
        assert.deepEqual([response.statusCode, JSON.parse(response.body)], [500, { error: "off_incomplete", failed: ["revoke"], revoked: 0 }]);
        assert.deepEqual(trail.filter((entry) => entry.startsWith("act")), ["act off", "act close"]);
      } finally {
        await stalled.close();
      }
    });

    test("a widening act whose request row stalls answers audit_unavailable within the bound, so an off queued behind it runs", { timeout: 5_000 }, async () => {
      const stalled = await buildStalledApp(false);
      try {
        const on = stalled.inject({ method: "POST", url: REMOTE_ADMIN_PATH.ACCESS_ON, headers: MAC_PAGE });
        await new Promise((resolve) => setImmediate(resolve));
        const off = await stalled.inject({ method: "POST", url: REMOTE_ADMIN_PATH.ACCESS_OFF, headers: MAC_PAGE });
        assert.deepEqual([(await on).statusCode, JSON.parse((await on).body), off.statusCode], [503, { error: "audit_unavailable" }, 200]);
        assert.deepEqual(trail.filter((entry) => entry.startsWith("act")), ["act off", "act close"]);
      } finally {
        await stalled.close();
      }
    });
  });
});

/** The Mac-side value as openssl computes it over the certificate file → independent of the server's own hashing. */
async function getOpensslFingerprint(certPath: string): Promise<string> {
  const { stdout } = await promisify(execFile)("/usr/bin/openssl", ["x509", "-in", certPath, "-noout", "-fingerprint", "-sha256"]);
  return stdout.trim().split("=")[1] ?? "";
}

describe("the setup read", () => {
  test("carries the setup facts field by field and the fingerprint of the certificate the download serves, whatever wider value the caller holds", async () => {
    const response = await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.SETUP });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), { ...SETUP_FACTS, fingerprint: await getOpensslFingerprint(ca.certPath) });
  });

  test("shows no fingerprint before a certificate was created", async () => {
    access.certificate = null;
    const response = await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.SETUP });
    assert.equal(JSON.parse(response.body).fingerprint, null);
  });

  test("past its rate limit is refused with 429", async () => {
    for (let index = 0; index < REMOTE_ADMIN_LIMITS.SETUP_READ.limit; index += 1) {
      assert.equal((await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.SETUP })).statusCode, 200);
    }
    assert.equal((await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.SETUP })).statusCode, 429);
  });
});

describe("the confirm read", () => {
  test("carries the router, the link kind and whether the network is trusted, field by field, whatever wider value the caller holds", async () => {
    const response = await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.CONFIRM_NETWORK });
    assert.deepEqual([response.statusCode, JSON.parse(response.body)], [200, CONFIRM_FACTS]);
  });

  test("past its rate limit is refused with 429 and reads no network", async () => {
    for (let index = 0; index < REMOTE_ADMIN_LIMITS.CONFIRM_READ.limit; index += 1) {
      assert.equal((await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.CONFIRM_NETWORK })).statusCode, 200);
    }
    trail.length = 0;
    const limited = await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.CONFIRM_NETWORK });
    assert.deepEqual([limited.statusCode, trail], [429, []]);
  });
});

describe("the certificate download", () => {
  test("serves the one CA file as an attachment with a fixed name and type, its bytes hashing to the fingerprint the setup read shows", async () => {
    const response = await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.CERTIFICATE });
    const setup = JSON.parse((await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.SETUP })).body) as { fingerprint: string };
    assert.deepEqual(
      [response.statusCode, response.headers["content-type"], response.headers["content-disposition"], response.rawPayload.equals(ca.cert)],
      [200, CA_DOWNLOAD.CONTENT_TYPE, `attachment; filename="${CA_DOWNLOAD.FILE_NAME}"`, true],
    );
    assert.equal(setup.fingerprint, await getOpensslFingerprint(ca.certPath));
  });

  test("serves the certificate re-encoded from the parsed object, never the file's own bytes, so the download is what the fingerprint covers", async () => {
    const pem = ca.cert.toString("latin1");
    const unwrapped = pem.replace(/\n(?!-----)/g, "").replace(/-----(?=MII)/, "-----\n").replace(/(?<=[A-Za-z0-9+/=])-----END/, "\n-----END");
    const rows = [
      { name: "CRLF line endings", bytes: Buffer.from(pem.replaceAll("\n", "\r\n"), "latin1") },
      { name: "the base64 on one line", bytes: Buffer.from(unwrapped, "latin1") },
    ];
    for (const row of rows) {
      assert.notDeepEqual(row.bytes, ca.cert, row.name);
      access.certificate = row.bytes;
      const response = await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.CERTIFICATE });
      assert.deepEqual([response.statusCode, response.rawPayload.equals(ca.cert)], [200, true], row.name);
    }
  });

  test("serves nothing, and shows no fingerprint, for a file that is anything but exactly one CA certificate", async () => {
    const leaf = await createStandInTls();
    try {
      // the download sends every byte → content past the one certificate would sit outside the fingerprint shown
      const rows: { name: string; bytes: Buffer | null }[] = [
        { name: "the CA with its private key", bytes: Buffer.concat([ca.cert, ca.key]) },
        { name: "the CA followed by a second certificate", bytes: Buffer.concat([ca.cert, leaf.cert]) },
        { name: "the CA twice", bytes: Buffer.concat([ca.cert, ca.cert]) },
        { name: "the CA followed by text", bytes: Buffer.concat([ca.cert, Buffer.from("trailing note\n")]) },
        { name: "a leaf", bytes: leaf.cert },
        { name: "no certificate", bytes: Buffer.from("not a certificate\n") },
        { name: "no file", bytes: null },
      ];
      for (const row of rows) {
        access.certificate = row.bytes;
        const response = await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.CERTIFICATE });
        assert.deepEqual([response.statusCode, JSON.parse(response.body)], [404, { error: "certificate_unavailable" }], row.name);
        assert.equal(JSON.parse((await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.SETUP })).body).fingerprint, null, row.name);
      }
    } finally {
      deleteDirectory(leaf.dir);
    }
  });

  test("past its rate limit is refused with 429", async () => {
    for (let index = 0; index < REMOTE_ADMIN_LIMITS.CERTIFICATE_READ.limit; index += 1) {
      assert.equal((await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.CERTIFICATE })).statusCode, 200);
    }
    assert.equal((await callAdmin({ method: "GET", url: REMOTE_ADMIN_PATH.CERTIFICATE })).statusCode, 429);
  });
});
