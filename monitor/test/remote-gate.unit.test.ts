// Remote listener gate: Host, registration, route class, page origin + CSRF, limits, audit-before-handler and headers.
// Runs on a bare Fastify instance through inject → no socket, no TLS, no database.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";

import { registerRemoteGate, type RemoteAuditEntry } from "../src/server/remote/gate.js";
import type { RouteClass } from "../src/server/remote/route-classes.js";
import type { DeviceSummary } from "../src/server/remote/devices.js";
import { CSRF_HEADER, DEVICE_COOKIE, getCsrfToken } from "../src/server/remote/session.js";

const HOST = "owner-mac.local:16146";
const ORIGIN = `https://${HOST}`;
const START = Date.parse("2026-11-14T14:20:00.123Z");

const CLASSES = new Map<string, RouteClass>([
  ["GET /api/health", "page"],
  ["GET /api/framed", "page"],
  ["POST /api/queue/owner/items/:id/answer", "page"],
  ["POST /api/queue/items", "agent"],
  ["POST /api/remote/registration", "remote-admin"],
  ["POST /api/remote/register", "page"],
]);

interface Harness {
  readonly app: FastifyInstance;
  readonly handled: string[];
  readonly audits: { entry: RemoteAuditEntry; result?: string; isHandledFirst: boolean }[];
  readonly devices: Map<string, DeviceSummary>;
  readonly clock: { now: number };
  issueDevice: () => string;
}

async function buildHarness(options: { isAuditDown?: boolean } = {}): Promise<Harness> {
  const app = Fastify();
  const handled: string[] = [];
  const audits: Harness["audits"] = [];
  const devices = new Map<string, DeviceSummary>();
  const clock = { now: START };
  await registerRemoteGate(app, {
    getHosts: () => new Set([HOST, "192.168.0.24:16146"]),
    getPageOrigins: () => new Set([ORIGIN]),
    findDevice: async (presented) => devices.get(presented) ?? null,
    getRouteClass: (method, path) => CLASSES.get(`${method === "HEAD" ? "GET" : method} ${path}`) ?? null,
    preAuthRoutes: new Set(["POST /api/remote/register"]),
    audit: {
      insertIntent: async (entry) => {
        if (options.isAuditDown === true) throw new Error("audit_log unreachable");
        audits.push({ entry, isHandledFirst: handled.length > 0 });
        return BigInt(audits.length);
      },
      setResult: async (id, result) => {
        audits[Number(id) - 1]!.result = result;
      },
    },
    now: () => clock.now,
  });
  const record = (name: string) => async () => {
    handled.push(name);
    return { ok: true };
  };
  app.get("/api/health", record("health"));
  app.post("/api/queue/owner/items/:id/answer", record("answer"));
  app.post("/api/queue/items", record("items"));
  app.post("/api/remote/registration", record("registration"));
  app.post("/api/remote/register", record("register"));
  app.get("/api/framed", async (_request, reply) => {
    reply.header("content-security-policy", "sandbox; frame-ancestors 'self'");
    return { ok: true };
  });
  let issued = 0;
  const issueDevice = () => {
    issued += 1;
    const presented = randomBytes(32).toString("base64url");
    devices.set(presented, { id: BigInt(issued), label: `device ${issued}` });
    return presented;
  };
  return { app, handled, audits, devices, clock, issueDevice };
}

function asDevice(presented: string, extra: Record<string, string> = {}): Record<string, string> {
  return { host: HOST, cookie: `${DEVICE_COOKIE.NAME}=${presented}`, ...extra };
}

function asPageMutation(presented: string): Record<string, string> {
  return asDevice(presented, { "sec-fetch-site": "same-origin", [CSRF_HEADER]: getCsrfToken(presented) });
}

function send(harness: Harness, options: InjectOptions) {
  return harness.app.inject({ remoteAddress: "192.168.0.31", ...options });
}

describe("Host allowlist", () => {
  const hosts = [
    { name: "a rebound page's own name", host: "attacker.example:16146" },
    { name: "the loopback name", host: "127.0.0.1:16146" },
    { name: "the right name on another port", host: "owner-mac.local:16145" },
    { name: "no Host at all", host: "" },
  ];
  for (const row of hosts) {
    test(`refuses ${row.name} before anything else runs`, async () => {
      const harness = await buildHarness();
      const presented = harness.issueDevice();
      const response = await send(harness, { method: "GET", url: "/api/health", headers: asDevice(presented, { host: row.host }) });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json(), { error: "host_not_allowed" });
      assert.deepEqual(harness.handled, []);
    });
  }

  test("admits the bound address as well as the .local name", async () => {
    const harness = await buildHarness();
    const presented = harness.issueDevice();
    const response = await send(harness, { method: "GET", url: "/api/health", headers: asDevice(presented, { host: "192.168.0.24:16146" }) });
    assert.equal(response.statusCode, 200);
  });
});

describe("registration", () => {
  const unauthenticated = [
    { name: "a page read", method: "GET", url: "/api/health" },
    { name: "a page mutation", method: "POST", url: "/api/queue/owner/items/7/answer" },
    { name: "an agent route", method: "POST", url: "/api/queue/items" },
    { name: "a remote-admin route", method: "POST", url: "/api/remote/registration" },
    { name: "an unknown path", method: "GET", url: "/api/unknown" },
    { name: "a static file", method: "GET", url: "/index.html" },
  ] as const;
  for (const row of unauthenticated) {
    test(`refuses ${row.name} without a registered device, with no data`, async () => {
      const harness = await buildHarness();
      for (const cookie of [undefined, `${DEVICE_COOKIE.NAME}=${randomBytes(32).toString("base64url")}`]) {
        const headers = cookie === undefined ? { host: HOST } : { host: HOST, cookie };
        const response = await send(harness, { method: row.method, url: row.url, headers });
        assert.equal(response.statusCode, 401, `cookie ${cookie === undefined ? "absent" : "unknown"}`);
        assert.deepEqual(response.json(), { error: "not_registered" });
      }
      assert.deepEqual(harness.handled, []);
    });
  }

  test("the enumerated pre-auth route answers without a device", async () => {
    const harness = await buildHarness();
    const response = await send(harness, { method: "POST", url: "/api/remote/register", headers: { host: HOST }, payload: {} });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(harness.handled, ["register"]);
  });

  test("a revoked device is refused on its next request", async () => {
    const harness = await buildHarness();
    const presented = harness.issueDevice();
    assert.equal((await send(harness, { method: "GET", url: "/api/health", headers: asDevice(presented) })).statusCode, 200);
    harness.devices.delete(presented);
    assert.equal((await send(harness, { method: "GET", url: "/api/health", headers: asDevice(presented) })).statusCode, 401);
  });
});

describe("route classes", () => {
  const denied = [
    { name: "an agent route", url: "/api/queue/items" },
    { name: "a remote-admin route", url: "/api/remote/registration" },
    { name: "an unclassified path", url: "/api/unknown" },
  ];
  for (const row of denied) {
    test(`a registered device cannot reach ${row.name}`, async () => {
      const harness = await buildHarness();
      const presented = harness.issueDevice();
      const response = await send(harness, { method: "POST", url: row.url, headers: asPageMutation(presented), payload: {} });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json(), { error: "route_not_available" });
      assert.deepEqual(harness.handled, []);
    });
  }
});

describe("mutations from a registered device", () => {
  const rows: readonly { name: string; build: (presented: string) => Record<string, string>; isAdmitted: boolean }[] = [
    { name: "same-origin fetch metadata and the CSRF value", build: (p) => asPageMutation(p), isAdmitted: true },
    { name: "the page's own Origin without fetch metadata", build: (p) => asDevice(p, { origin: ORIGIN, [CSRF_HEADER]: getCsrfToken(p) }), isAdmitted: true },
    { name: "Sec-Fetch-Site none", build: (p) => asDevice(p, { "sec-fetch-site": "none", [CSRF_HEADER]: getCsrfToken(p) }), isAdmitted: false },
    { name: "Sec-Fetch-Site cross-site", build: (p) => asDevice(p, { "sec-fetch-site": "cross-site", [CSRF_HEADER]: getCsrfToken(p) }), isAdmitted: false },
    { name: "neither fetch metadata nor Origin", build: (p) => asDevice(p, { [CSRF_HEADER]: getCsrfToken(p) }), isAdmitted: false },
    { name: "the loopback page's Origin", build: (p) => asDevice(p, { origin: "http://127.0.0.1:16145", [CSRF_HEADER]: getCsrfToken(p) }), isAdmitted: false },
    { name: "no CSRF value", build: (p) => asDevice(p, { "sec-fetch-site": "same-origin" }), isAdmitted: false },
    { name: "another device's CSRF value", build: (p) => asDevice(p, { "sec-fetch-site": "same-origin", [CSRF_HEADER]: getCsrfToken(`${p}x`) }), isAdmitted: false },
  ];
  for (const row of rows) {
    test(`${row.name} → ${row.isAdmitted ? "admitted" : "refused"}`, async () => {
      const harness = await buildHarness();
      const presented = harness.issueDevice();
      const response = await send(harness, { method: "POST", url: "/api/queue/owner/items/7/answer", headers: row.build(presented), payload: {} });
      assert.equal(response.statusCode, row.isAdmitted ? 200 : 403);
      assert.deepEqual(harness.handled, row.isAdmitted ? ["answer"] : []);
    });
  }

  test("writes the audit row before the handler with the device as actor, then its result", async () => {
    const harness = await buildHarness();
    const presented = harness.issueDevice();
    await send(harness, { method: "POST", url: "/api/queue/owner/items/7/answer", headers: asPageMutation(presented), payload: {} });
    assert.equal(harness.audits.length, 1);
    const [audit] = harness.audits;
    assert.equal(audit!.isHandledFirst, false);
    assert.deepEqual(audit!.entry, { actor: "remote:1@192.168.0.31", method: "POST", route: "/api/queue/owner/items/:id/answer" });
    assert.equal(audit!.result, "success");
  });

  test("a mutation whose audit row cannot be written fails with 503 and never runs", async () => {
    const harness = await buildHarness({ isAuditDown: true });
    const presented = harness.issueDevice();
    const response = await send(harness, { method: "POST", url: "/api/queue/owner/items/7/answer", headers: asPageMutation(presented), payload: {} });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: "audit_unavailable" });
    assert.deepEqual(harness.handled, []);
  });

  test("a read writes no audit row", async () => {
    const harness = await buildHarness();
    const presented = harness.issueDevice();
    await send(harness, { method: "GET", url: "/api/health", headers: asDevice(presented) });
    assert.deepEqual(harness.audits, []);
  });
});

describe("rate limits", () => {
  test("an address with 20 failed session checks gets 429 for 15 minutes, even with a valid device", async () => {
    const harness = await buildHarness();
    const presented = harness.issueDevice();
    for (let index = 0; index < 20; index += 1) {
      await send(harness, { method: "GET", url: "/api/health", headers: { host: HOST } });
    }
    assert.equal((await send(harness, { method: "GET", url: "/api/health", headers: asDevice(presented) })).statusCode, 429);
    harness.clock.now += 15 * 60_000 + 1;
    assert.equal((await send(harness, { method: "GET", url: "/api/health", headers: asDevice(presented) })).statusCode, 200);
  });

  test("the 61st pre-auth request from one address in a minute gets 429", async () => {
    const harness = await buildHarness();
    const statuses = [];
    for (let index = 0; index < 61; index += 1) {
      statuses.push((await send(harness, { method: "POST", url: "/api/remote/register", headers: { host: HOST }, payload: {} })).statusCode);
    }
    assert.deepEqual([statuses[59], statuses[60]], [200, 429]);
  });

  test("a device past 60 mutations a minute gets 429, and its reads still pass", async () => {
    const harness = await buildHarness();
    const presented = harness.issueDevice();
    const statuses = [];
    for (let index = 0; index < 61; index += 1) {
      const response = await send(harness, { method: "POST", url: "/api/queue/owner/items/7/answer", headers: asPageMutation(presented), payload: {} });
      statuses.push(response.statusCode);
    }
    assert.deepEqual([statuses[59], statuses[60]], [200, 429]);
    assert.equal((await send(harness, { method: "GET", url: "/api/health", headers: asDevice(presented) })).statusCode, 200);
  });

  test("a device past 600 requests a minute gets 429", async () => {
    const harness = await buildHarness();
    const presented = harness.issueDevice();
    let last = 0;
    for (let index = 0; index < 601; index += 1) {
      last = (await send(harness, { method: "GET", url: "/api/health", headers: asDevice(presented) })).statusCode;
    }
    assert.equal(last, 429);
  });
});

describe("response headers", () => {
  test("every response, a refusal included, carries HSTS without subdomains and the frame denial", async () => {
    const harness = await buildHarness();
    for (const headers of [{ host: HOST }, asDevice(harness.issueDevice())]) {
      const response = await send(harness, { method: "GET", url: "/api/health", headers });
      assert.equal(response.headers["strict-transport-security"], "max-age=604800");
      assert.equal(response.headers["x-frame-options"], "DENY");
      assert.equal(response.headers["content-security-policy"], "frame-ancestors 'none'");
      assert.equal(response.headers["cache-control"], "no-store");
    }
  });

  test("a handler's own CSP is kept", async () => {
    const harness = await buildHarness();
    const response = await send(harness, { method: "GET", url: "/api/framed", headers: asDevice(harness.issueDevice()) });
    assert.equal(response.headers["content-security-policy"], "sandbox; frame-ancestors 'self'");
  });

  test("a registered device's cookie is re-sent with its flags and 400-day lifetime", async () => {
    const harness = await buildHarness();
    const presented = harness.issueDevice();
    const response = await send(harness, { method: "GET", url: "/api/health", headers: asDevice(presented) });
    const cookie = response.cookies.find((entry) => entry.name === DEVICE_COOKIE.NAME);
    assert.deepEqual(
      { value: cookie?.value, maxAge: cookie?.maxAge, path: cookie?.path, httpOnly: cookie?.httpOnly, secure: cookie?.secure, sameSite: cookie?.sameSite, domain: cookie?.domain },
      { value: presented, maxAge: 400 * 24 * 60 * 60, path: "/", httpOnly: true, secure: true, sameSite: "Strict", domain: undefined },
    );
  });
});
