// Importable app assembly: loading it (and building an app from it) starts no server, no timer and never exits.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/app-assembly.unit.test.ts
// Building the app registers the routes, and the clauded-docs registrar probes pg_bigm → the pool is closed in after().

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { disconnectPrisma } from "../src/server/db.js";
import { deleteDirectory } from "./lib/remove-dir.js";

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
  const secretsDir = mkdtempSync(path.join(tmpdir(), "app-assembly-"));
  const { buildApp } = await import("../src/server/app.js");
  const app = await buildApp({ secretsDir });
  try {
    await app.ready();
    assert.deepEqual(exitCalls, []);
    assert.equal(app.server.listening, false, "no listen");
    assert.equal(countResources(LISTENING_RESOURCES), before.servers, "no listening socket");
    assert.equal(countResources(new Set(["Timeout"])), before.timers, "no timer started");
  } finally {
    await app.close();
    deleteDirectory(secretsDir);
  }
});

test("the shell and its assets are served with framing denied, so no other page can frame the owner actions", async () => {
  const secretsDir = mkdtempSync(path.join(tmpdir(), "app-assembly-"));
  const { buildApp } = await import("../src/server/app.js");
  const app = await buildApp({ secretsDir });
  try {
    for (const url of ["/", "/index.html", "/styles/base.css"]) {
      const response = await app.inject({ method: "GET", url, headers: { host: "127.0.0.1:16145" } });
      assert.equal(response.statusCode, 200, url);
      assert.equal(response.headers["content-security-policy"], "frame-ancestors 'none'", url);
      assert.equal(response.headers["x-frame-options"], "DENY", url);
    }
  } finally {
    await app.close();
    deleteDirectory(secretsDir);
  }
});
