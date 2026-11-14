// Remote app assembly: the production surface behind the remote gate, with the instance's own Host set and origins.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/remote-app.assembly.test.ts

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import type { FastifyInstance } from "fastify";

import { buildRemoteApp } from "../src/server/app.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import type { DeviceSummary } from "../src/server/remote/devices.js";
import { REVIEWED_ROUTES, getRouteClass } from "../src/server/remote/route-classes.js";
import { CSRF_HEADER, DEVICE_COOKIE, getCsrfToken } from "../src/server/remote/session.js";
import { deleteDirectory } from "./lib/remove-dir.js";
import { lockQueueRows, unlockQueueRows } from "./lib/queue-rows-lock.js";

const HOST = "owner-mac.local:16146";
const ORIGIN = `https://${HOST}`;
const PHONE = "192.168.0.31";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "remote-app-"));
const trackedSessionIds: string[] = [];
const devices = new Map<string, DeviceSummary>();
let app: FastifyInstance;

before(async () => {
  await lockQueueRows();
  const getHosts = () => new Set([HOST]);
  const getPageOrigins = () => new Set([ORIGIN]);
  app = await buildRemoteApp({
    listener: { kind: "remote", getHosts, getPageOrigins },
    gate: {
      getHosts,
      getPageOrigins,
      findDevice: async (presented) => devices.get(presented) ?? null,
      getRouteClass,
      preAuthRoutes: new Set(),
      audit: { insertIntent: async () => 1n, setResult: async () => undefined, insertEvent: async () => undefined },
    },
    queue: {
      port: 16145,
      homeDir: path.join(fixtureRoot, "home"),
      cliPath: "/opt/atrium-test/scripts/atrium-queue.sh",
      imageDir: path.join(fixtureRoot, "images"),
    },
  });
  await app.ready();
});

after(async () => {
  await app.close();
  const prisma = getPrisma();
  await prisma.queueDelivery.deleteMany({ where: { item: { sessionId: { in: trackedSessionIds } } } });
  await prisma.queueItem.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await prisma.queueSession.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await unlockQueueRows();
  await disconnectPrisma();
  deleteDirectory(fixtureRoot);
});

function issueDevice(): string {
  const presented = randomBytes(32).toString("base64url");
  devices.set(presented, { id: BigInt(devices.size + 1), label: "Owner phone" });
  return presented;
}

async function seedDecision(): Promise<bigint> {
  const sessionId = randomUUID();
  trackedSessionIds.push(sessionId);
  await getPrisma().queueSession.create({
    data: {
      sessionId,
      isConfigDirSet: false,
      profileLabel: "default",
      cwd: "/Users/owner/Desktop/git/glass-atrium/monitor",
      worktreeRoot: `/Users/owner/Desktop/git/wt-${sessionId.slice(0, 8)}`,
      processStartTime: "Mon Nov  9 08:01:12 2026",
      socketPath: null,
      state: "live",
      lastSeenAt: new Date(),
      pid: 700_000 + Math.floor(Math.random() * 100_000),
    },
  });
  const options = [
    { code: "R1", label: "Keep the index", pros: "fast reads", cons: "slower writes" },
    { code: "R2", label: "Drop the index", pros: "fast writes", cons: "slow reads" },
  ];
  const item = await getPrisma().queueItem.create({
    data: { kind: "decision", sessionId, title: "Index choice", body: "Pick one.", isFreeTextAllowed: true, options, recommendedCode: "R1" },
  });
  return item.id;
}

describe("the surface behind the gate", () => {
  test("every classified route and an unknown path refuse an unregistered request with no data", async () => {
    const probes = [
      ...REVIEWED_ROUTES.map((entry) => entry.route.replace(/:[^/]+/g, "1").replace(/\/\*$/, "/index.html")),
      "GET /api/unknown",
      "POST /api/unknown",
      "GET /no-such-file.js",
    ];
    const answered = [];
    for (const [index, probe] of probes.entries()) {
      const [method, url] = probe.split(" ") as [string, string];
      // one source address per probe → the failed-session limit (its own test) never answers in place of the gate
      const remoteAddress = `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`;
      const response = await app.inject({ method: method as "GET", url, remoteAddress, headers: { host: HOST }, payload: method === "GET" ? undefined : {} });
      if (response.statusCode !== 401 || response.body !== JSON.stringify({ error: "not_registered" })) answered.push(`${probe} → ${response.statusCode}`);
    }
    assert.deepEqual(answered, []);
  });

  test("a mutation body over 96 KiB is refused before the handler", async () => {
    const presented = issueDevice();
    const response = await app.inject({
      method: "POST",
      url: `/api/queue/owner/items/${await seedDecision()}/answer`,
      remoteAddress: PHONE,
      headers: { host: HOST, cookie: `${DEVICE_COOKIE.NAME}=${presented}`, "sec-fetch-site": "same-origin", [CSRF_HEADER]: getCsrfToken(presented) },
      payload: { code: "R1", text: "x".repeat(96 * 1024) },
    });
    assert.equal(response.statusCode, 413);
  });
});

describe("queue answers from a registered device", () => {
  test("a registered device answers a queue item at the remote Host, by fetch metadata or by the remote page Origin", async () => {
    const rows = [
      { name: "fetch metadata", headers: { "sec-fetch-site": "same-origin" } },
      { name: "remote page Origin only", headers: { origin: ORIGIN } },
    ];
    for (const row of rows) {
      const presented = issueDevice();
      const itemId = await seedDecision();
      const response = await app.inject({
        method: "POST",
        url: `/api/queue/owner/items/${itemId}/answer`,
        remoteAddress: PHONE,
        headers: { host: HOST, cookie: `${DEVICE_COOKIE.NAME}=${presented}`, [CSRF_HEADER]: getCsrfToken(presented), ...row.headers },
        payload: { code: "R1" },
      });
      assert.equal(response.statusCode, 200, `${row.name}: ${response.body}`);
      assert.equal((await getPrisma().queueItem.findUniqueOrThrow({ where: { id: itemId } })).status, "answered", row.name);
    }
  });
});
