// Importable app assembly: loading it (and building an app from it) starts no server, no timer and never exits.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/app-assembly.unit.test.ts
// Building the app registers the routes, and the clauded-docs registrar probes pg_bigm → the pool is closed in after().

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { disconnectPrisma } from "../src/server/db.js";

const LISTENING_RESOURCES = new Set(["TCPServerWrap", "PipeServerWrap"]);

after(() => disconnectPrisma());

function countResources(kinds: ReadonlySet<string>): number {
  return process.getActiveResourcesInfo().filter((kind) => kinds.has(kind)).length;
}

test("importing the assembly and building an app binds no port, starts no timer and does not exit", async (t) => {
  const exitCalls: unknown[] = [];
  t.mock.method(process, "exit", (code?: unknown) => {
    exitCalls.push(code);
    throw new Error("process.exit called by the assembly");
  });
  const before = { servers: countResources(LISTENING_RESOURCES), timers: countResources(new Set(["Timeout"])) };
  const { buildApp } = await import("../src/server/app.js");
  const app = await buildApp();
  try {
    await app.ready();
    assert.deepEqual(exitCalls, []);
    assert.equal(app.server.listening, false, "no listen");
    assert.equal(countResources(LISTENING_RESOURCES), before.servers, "no listening socket");
    assert.equal(countResources(new Set(["Timeout"])), before.timers, "no timer started");
  } finally {
    await app.close();
  }
});

test("the shell and its assets are served with framing denied, so no other page can frame the owner actions", async () => {
  const { buildApp } = await import("../src/server/app.js");
  const app = await buildApp();
  try {
    for (const url of ["/", "/index.html", "/styles/base.css"]) {
      const response = await app.inject({ method: "GET", url, headers: { host: "127.0.0.1:16145" } });
      assert.equal(response.statusCode, 200, url);
      assert.equal(response.headers["content-security-policy"], "frame-ancestors 'none'", url);
      assert.equal(response.headers["x-frame-options"], "DENY", url);
    }
  } finally {
    await app.close();
  }
});

test("every loopback route refuses a Host outside the loopback names at the monitor port", async () => {
  const { buildApp } = await import("../src/server/app.js");
  const app = await buildApp();
  const rows = [
    { name: "static shell, rebound name", url: "/", host: "attacker.example:16145", refused: true },
    { name: "api route, injected default Host", url: "/api/health/architecture-budget", host: "localhost:80", refused: true },
    { name: "api route, tunnel name at the right port", url: "/api/health/architecture-budget", host: "tunnel.example:16145", refused: true },
    { name: "static shell, loopback name", url: "/", host: "127.0.0.1:16145", refused: false },
    { name: "api route, localhost name", url: "/api/health/architecture-budget", host: "localhost:16145", refused: false },
  ];
  try {
    for (const row of rows) {
      const response = await app.inject({ method: "GET", url: row.url, headers: { host: row.host } });
      assert.equal(response.statusCode === 403 && response.json().error === "host_not_allowed", row.refused, row.name);
    }
  } finally {
    await app.close();
  }
});

test("the boot pre-warm reaches its hot routes through the Host allowlist", async () => {
  const { buildApp, warmHotRoutes } = await import("../src/server/app.js");
  const app = await buildApp();
  try {
    assert.deepEqual(await warmHotRoutes(app, 16145), []);
  } finally {
    await app.close();
  }
});

test("the boot pre-warm names every hot route that did not answer 2xx", async () => {
  const { warmHotRoutes } = await import("../src/server/app.js");
  const { default: Fastify } = await import("fastify");
  const app = Fastify();
  try {
    assert.deepEqual(await warmHotRoutes(app, 16145), ["/api/improvement", "/api/clauded-docs"]);
  } finally {
    await app.close();
  }
});
