// Remote route classes: every live route has exactly one reviewer class, and no class changes without a new sign-off.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/remote-route-classes.unit.test.ts

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";

import Fastify, { type RouteOptions } from "fastify";

import { registerSurface } from "../src/server/app.js";
import { disconnectPrisma } from "../src/server/db.js";
import { registerRemoteAdminRoutes } from "../src/server/remote/admin-routes.js";
import { DeviceConnections } from "../src/server/remote/connections.js";
import { RegistrationCodes } from "../src/server/remote/registration-code.js";
import {
  REVIEWED_ROUTES,
  ROUTE_CLASS_SIGNOFFS,
  getRouteClass,
  getRouteClassDigest,
} from "../src/server/remote/route-classes.js";

after(() => disconnectPrisma());

// the reviewer's signed lines past the first 94 rows, verbatim and in order (verdict CID 2026-11-14T1640_lan-route-classes_a93f)
const FIRST_SIGNED_ROW_COUNT = 94;
const SIGNED_REMOTE_LINES = [
  "POST /api/remote/registration remote-admin",
  "GET /api/remote/devices remote-admin",
  "DELETE /api/remote/devices/:id remote-admin",
  "POST /api/remote/devices/revoke-all remote-admin",
  "POST /api/remote/register remote-pre-auth",
  "GET /api/remote/session remote-device",
  "POST /api/remote/logout remote-device",
  "POST /api/remote/off remote-device",
];

/** Every `METHOD path` the production surface registers, HEAD included as Fastify exposes it. */
async function collectLiveRoutes(): Promise<Set<string>> {
  const app = Fastify({ logger: false });
  const routes = new Set<string>();
  app.addHook("onRoute", (route: RouteOptions): void => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.add(`${String(method).toUpperCase()} ${route.url}`);
  });
  try {
    await registerSurface(app);
    await registerRemoteAdminRoutes(app, {
      codes: new RegistrationCodes(),
      devices: { list: async () => [], revoke: async () => false, revokeAll: async () => [] },
      connections: new DeviceConnections(),
      audit: { insertEvent: async () => undefined },
    });
    await app.ready();
  } finally {
    await app.close();
  }
  return routes;
}

test("every live route, HEAD included, has a reviewer class", async () => {
  const live = await collectLiveRoutes();
  const unclassified = [...live].filter((key) => {
    const [method, ...path] = key.split(" ");
    return getRouteClass(method ?? "", path.join(" ")) === null;
  });
  assert.deepEqual(unclassified, [], "classify these routes in remote/route-classes.ts with a reviewer sign-off");
});

test("every classified route is still registered, so a removed route leaves no stale class", async () => {
  const live = await collectLiveRoutes();
  const stale = REVIEWED_ROUTES.map((entry) => entry.route).filter((route) => !live.has(route));
  assert.deepEqual(stale, []);
});

describe("reviewer sign-offs", () => {
  test("each sign-off digest matches the rows it covers, so an unsigned class change fails", () => {
    const rows = ROUTE_CLASS_SIGNOFFS.map((signoff) => [signoff.cid, getRouteClassDigest(REVIEWED_ROUTES.slice(0, signoff.rowCount))]);
    assert.deepEqual(rows, ROUTE_CLASS_SIGNOFFS.map((signoff) => [signoff.cid, signoff.sha256]));
  });

  test("the first sign-off keeps its 94 rows and the latest covers the whole table", () => {
    assert.deepEqual(
      [ROUTE_CLASS_SIGNOFFS[0]?.rowCount, ROUTE_CLASS_SIGNOFFS.at(-1)?.rowCount],
      [FIRST_SIGNED_ROW_COUNT, REVIEWED_ROUTES.length],
    );
  });

  test("every row past the first 94 is the reviewer's signed line at its place, under the reviewer's own verdict CID", () => {
    const added = REVIEWED_ROUTES.slice(FIRST_SIGNED_ROW_COUNT).map((entry) => `${entry.route} ${entry.cls}`);
    assert.deepEqual(added, SIGNED_REMOTE_LINES.slice(0, added.length));
    const latest = ROUTE_CLASS_SIGNOFFS.at(-1);
    assert.deepEqual(
      { reviewer: latest?.reviewer, stream: latest?.stream, cid: latest?.cid },
      { reviewer: "glass-atrium-sec-guard", stream: "S3", cid: "2026-11-14T1640_lan-route-classes_a93f" },
    );
  });
});

test("each route has exactly one class entry", () => {
  const routes = REVIEWED_ROUTES.map((entry) => entry.route);
  assert.equal(new Set(routes).size, routes.length);
});

test("an unknown route has no class and HEAD reads its GET class", () => {
  const rows = [
    { name: "unknown path", method: "GET", path: "/api/not-a-route", expected: null },
    { name: "known path under another method", method: "POST", path: "/api/health", expected: null },
    { name: "HEAD of a page GET", method: "HEAD", path: "/api/health", expected: "page" },
    { name: "HEAD of an agent GET", method: "HEAD", path: "/api/dashboard/daemon-status", expected: "agent" },
    { name: "agent mutation", method: "POST", path: "/api/queue/items", expected: "agent" },
    { name: "loopback admin route", method: "DELETE", path: "/api/remote/devices/:id", expected: "remote-admin" },
  ] as const;
  for (const row of rows) assert.equal(getRouteClass(row.method, row.path), row.expected, row.name);
});
