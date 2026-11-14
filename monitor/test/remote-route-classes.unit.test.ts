// Remote route classes: every live route has exactly one reviewer class, and no class changes without a new sign-off.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/remote-route-classes.unit.test.ts

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type RouteOptions } from "fastify";

import { registerSurface } from "../src/server/app.js";
import { disconnectPrisma } from "../src/server/db.js";
import { registerRemoteAdminRoutes } from "../src/server/remote/admin-routes.js";
import { registerRemoteCliRoutes } from "../src/server/remote/cli-routes.js";
import { DeviceConnections } from "../src/server/remote/connections.js";
import { RegistrationCodes } from "../src/server/remote/registration-code.js";
import { registerRemoteDeviceRoutes } from "../src/server/remote/routes.js";
import {
  REMOTE_PRE_AUTH_ROUTES,
  REVIEWED_ROUTES,
  ROUTE_CLASS_SIGNOFFS,
  getRouteClass,
  getRouteClassDigest,
} from "../src/server/remote/route-classes.js";

after(() => disconnectPrisma());

// the reviewer's signed lines past the first 94 rows, verbatim and in order
// (verdict CIDs 2026-11-14T1640_lan-route-classes_a93f, 2026-11-14T2145_lan-cli-channel_5f0c from row 103,
// 2026-11-15T0140_lan-signin-routes_c18e from row 106)
const FIRST_SIGNED_ROW_COUNT = 94;
const SIGNED_CLI_LINES = [
  "GET /api/remote/cli/devices remote-cli",
  "DELETE /api/remote/cli/devices/:id remote-cli",
  "POST /api/remote/cli/devices/revoke-all remote-cli",
];
const SIGNED_SIGN_IN_LINES = ["GET /sign-in.html remote-pre-auth", "GET /sign-in.js remote-pre-auth", "GET /sign-in.css remote-pre-auth"];
const SIGNED_REMOTE_LINES = [
  "POST /api/remote/registration remote-admin",
  "GET /api/remote/devices remote-admin",
  "DELETE /api/remote/devices/:id remote-admin",
  "POST /api/remote/devices/revoke-all remote-admin",
  "POST /api/remote/register remote-pre-auth",
  "GET /api/remote/session remote-device",
  "POST /api/remote/logout remote-device",
  "POST /api/remote/off remote-device",
  ...SIGNED_CLI_LINES,
  ...SIGNED_SIGN_IN_LINES,
];

// the whole-table re-sign: the five verdicts that changed classes inside the first 94 rows and replaced reasons
const RESIGN_CIDS = [
  "2026-11-15T0140_lan-signin-routes_c18e",
  "2026-11-15T0215_lan-unread-writes_a2f7",
  "2026-11-15T0216_lan-unread-reads_d90b",
  "2026-11-15T0240_lan-unread-reads-b_3fa6",
  "2026-11-15T0241_lan-unread-reads-c_7b29",
];

// class changes the re-sign carries, each a verdict's exact line → a class edited back without a new sign-off fails
const RESIGNED_CLASS_CHANGES = [
  "DELETE /api/agents/:name page",
  "POST /api/clauded-docs/group page",
  "POST /api/clauded-docs/ungroup page",
  "PATCH /api/clauded-docs/group/:rootId/reorder page",
  "POST /api/clauded-docs/html-export page",
  "GET /api/clauded-docs/:id/html-export page",
  "PUT /api/clauded-docs/:id page",
  "DELETE /api/clauded-docs/:id page",
  "PATCH /api/outcomes/:id/close page",
  "POST /api/improvement/:id/approve page",
  "POST /api/improvement/:id/reject page",
];

/** Every `METHOD path` the loopback and remote assemblies register, HEAD included as Fastify exposes it. */
async function collectLiveRoutes(): Promise<Set<string>> {
  const app = Fastify({ logger: false });
  const routes = new Set<string>();
  app.addHook("onRoute", (route: RouteOptions): void => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.add(`${String(method).toUpperCase()} ${route.url}`);
  });
  try {
    await registerSurface(app);
    const devices = { list: async () => [], revoke: async () => false, revokeAll: async () => [] };
    const audit = { insertEvent: async () => undefined };
    await registerRemoteAdminRoutes(app, {
      codes: new RegistrationCodes(),
      devices,
      connections: new DeviceConnections(),
      audit,
      getAccess: () => ({ enabled: false, trusted: [] }),
    });
    await registerRemoteCliRoutes(app, { devices, connections: new DeviceConnections(), audit });
    await registerRemoteDeviceRoutes(app, {
      preAuthRoutes: REMOTE_PRE_AUTH_ROUTES,
      registration: { codes: new RegistrationCodes(), createDevice: async () => ({ outcome: "cap_reached" }) },
      device: { revoke: async () => false, revokeAll: async () => [], turnOff: () => undefined },
      connections: new DeviceConnections(),
      audit: { insertIntent: async () => 1n, setResult: async () => undefined, insertEvent: async () => undefined },
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
  test("the latest sign-off covers the whole live table and its digest matches, so an unsigned class change fails", () => {
    const latest = ROUTE_CLASS_SIGNOFFS.at(-1);
    assert.deepEqual(
      { rowCount: latest?.rowCount, sha256: latest?.sha256, supersededBy: latest?.supersededBy },
      { rowCount: REVIEWED_ROUTES.length, sha256: getRouteClassDigest(REVIEWED_ROUTES), supersededBy: undefined },
    );
  });

  test("the latest sign-off names the reviewer and the five verdict CIDs of the whole-table re-sign", () => {
    const latest = ROUTE_CLASS_SIGNOFFS.at(-1);
    assert.deepEqual({ reviewer: latest?.reviewer, cids: latest?.cids }, { reviewer: "glass-atrium-sec-guard", cids: RESIGN_CIDS });
  });

  test("every earlier sign-off is kept as history, marked superseded by the re-sign, with its row count and old digest", () => {
    assert.deepEqual(
      ROUTE_CLASS_SIGNOFFS.slice(0, -1).map((signoff) => [signoff.cids, signoff.rowCount, signoff.sha256, signoff.supersededBy]),
      [
        [["2026-11-14T1420_lan-build_c5b9"], 94, "b76036b059ce1c7e0e5f860d94c8afcc678e1b98b8212d21854a7a72d24179fc", RESIGN_CIDS[0]],
        [["2026-11-14T1640_lan-route-classes_a93f"], 102, "3d234a90e3476fabcf110784cedbfbc535753e1bde142da98578bc95dbcfc61a", RESIGN_CIDS[0]],
        [["2026-11-14T2145_lan-cli-channel_5f0c"], 105, "7801ce43f3335b0f6fe0aad59b39425b951fe49ad60116cb601f5dc66ccc9e32", RESIGN_CIDS[0]],
      ],
    );
  });

  test("every row past the first 94 is the reviewer's signed line at its place", () => {
    const added = REVIEWED_ROUTES.slice(FIRST_SIGNED_ROW_COUNT).map((entry) => `${entry.route} ${entry.cls}`);
    assert.deepEqual(added, SIGNED_REMOTE_LINES);
  });

  test("the re-sign's class changes are in the table as signed", () => {
    const lines = new Set(REVIEWED_ROUTES.map((entry) => `${entry.route} ${entry.cls}`));
    assert.deepEqual(RESIGNED_CLASS_CHANGES.filter((line) => !lines.has(line)), []);
  });
});

test("the pre-auth set is exactly the three sign-in files and the code POST (signin verdict condition 6)", () => {
  assert.deepEqual([...REMOTE_PRE_AUTH_ROUTES].sort(), ["GET /sign-in.css", "GET /sign-in.html", "GET /sign-in.js", "POST /api/remote/register"]);
});

test("the remote-cli class holds exactly the three signed lines, so a fourth cli route fails", () => {
  const cli = REVIEWED_ROUTES.filter((entry) => entry.cls === "remote-cli").map((entry) => `${entry.route} ${entry.cls}`);
  assert.deepEqual(cli, SIGNED_CLI_LINES);
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

const PUBLIC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
// a base the page appends a computed sub-path to (queue.jsx → sendOwnerRequestQ) → covered when a class sits under it
const PAGE_API_BASES = new Set(["/api/queue/owner"]);
const API_LITERAL = /(["'`])(\/api\/[^"'`]*?)\1/g;

/** Every `/api/` path literal in the page sources, query dropped and `${…}` segments read as a route parameter. */
async function collectPageApiPaths(): Promise<Set<string>> {
  const entries = await readdir(path.join(PUBLIC_ROOT, "src"), { recursive: true });
  const files = [...entries.filter((entry) => /\.jsx?$/.test(entry)).map((entry) => path.join("src", entry)), "sign-in.js"];
  const sources = await Promise.all(files.map((file) => readFile(path.join(PUBLIC_ROOT, file), "utf8")));
  const paths = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(API_LITERAL)) {
      const pathPart = (match[2] ?? "").split("?")[0] ?? "";
      paths.add(pathPart.replace(/\$\{[^}]*\}/g, ":param"));
    }
  }
  return paths;
}

function isClassedPath(pagePath: string, classedPaths: readonly string[]): boolean {
  if (PAGE_API_BASES.has(pagePath)) return classedPaths.some((route) => route.startsWith(`${pagePath}/`));
  const segments = pagePath.split("/");
  return classedPaths.some((route) => {
    const routeSegments = route.split("/");
    return routeSegments.length === segments.length && routeSegments.every((part, index) => part === segments[index] || part.startsWith(":") || segments[index] === ":param");
  });
}

test("every API path the page calls has a route class, so a new page call cannot fail unseen on a phone", async () => {
  const classedPaths = REVIEWED_ROUTES.map((entry) => entry.route.split(" ")[1] ?? "");
  const pagePaths = await collectPageApiPaths();
  const unclassed = [...pagePaths].filter((pagePath) => !isClassedPath(pagePath, classedPaths));
  assert.ok(pagePaths.size > 50, `page API literals found: ${pagePaths.size}`);
  assert.deepEqual(unclassed, [], "classify these page calls in remote/route-classes.ts with a reviewer sign-off");
});
