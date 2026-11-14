// Remote route classes: every live route has exactly one reviewer class, and no class changes without a new sign-off.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/remote-route-classes.unit.test.ts

import test, { after } from "node:test";
import assert from "node:assert/strict";

import Fastify, { type RouteOptions } from "fastify";

import { registerSurface } from "../src/server/app.js";
import { disconnectPrisma } from "../src/server/db.js";
import {
  REVIEWED_ROUTES,
  ROUTE_CLASS_SIGNOFF,
  getRouteClass,
  getRouteClassDigest,
} from "../src/server/remote/route-classes.js";

after(() => disconnectPrisma());

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

test("the reviewer sign-off digest matches the classes, so an unsigned class change fails", () => {
  assert.equal(getRouteClassDigest(REVIEWED_ROUTES), ROUTE_CLASS_SIGNOFF.sha256);
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
  ] as const;
  for (const row of rows) assert.equal(getRouteClass(row.method, row.path), row.expected, row.name);
});
