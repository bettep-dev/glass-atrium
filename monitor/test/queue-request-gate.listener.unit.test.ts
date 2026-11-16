// Queue request gate per listener: the accepting instance decides the Host set and page origins, never a header,
// so the loopback set does not widen and no request on the remote instance is judged loopback.

import test from "node:test";
import assert from "node:assert/strict";

import Fastify, { type FastifyInstance } from "fastify";

import {
  buildHostAllowlistHook,
  buildPageOriginHook,
  getPageOrigins,
  setListenerContext,
} from "../src/server/queue/request-gate.js";

const MONITOR_PORT = 16145;
const REMOTE = { HOST: "bettepui-macmini.local:16146", ADDRESS: "192.168.45.94:16146" } as const;

/** A queue-shaped child plugin wired exactly as routes/queue.ts and routes/queue-owner.ts wire the gate. */
async function buildApp(kind: "loopback" | "remote"): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  if (kind === "remote") {
    setListenerContext(app, {
      kind: "remote",
      getHosts: () => new Set([REMOTE.HOST, REMOTE.ADDRESS]),
      getPageOrigins: () => new Set([`https://${REMOTE.HOST}`, `https://${REMOTE.ADDRESS}`]),
    });
  }
  await app.register(async (queue) => {
    queue.addHook("onRequest", buildHostAllowlistHook(MONITOR_PORT));
    await queue.register(async (owner) => {
      owner.addHook("onRequest", buildPageOriginHook(getPageOrigins(MONITOR_PORT)));
      owner.post("/api/queue/owner/items/:id/answer", async () => ({ ok: true }));
    });
  });
  await app.ready();
  return app;
}

async function postAnswer(app: FastifyInstance, headers: Record<string, string>): Promise<{ status: number; error?: string }> {
  const response = await app.inject({ method: "POST", url: "/api/queue/owner/items/7/answer", headers, payload: {} });
  const body = response.json<{ error?: string }>();
  return { status: response.statusCode, ...(body.error === undefined ? {} : { error: body.error }) };
}

test("the loopback instance keeps exactly the loopback names at the monitor port", async () => {
  const app = await buildApp("loopback");
  try {
    const rows = [
      { name: "127.0.0.1", host: `127.0.0.1:${MONITOR_PORT}`, expected: { status: 200 } },
      { name: "localhost", host: `localhost:${MONITOR_PORT}`, expected: { status: 200 } },
      { name: "[::1]", host: `[::1]:${MONITOR_PORT}`, expected: { status: 200 } },
      { name: "remote .local name", host: REMOTE.HOST, expected: { status: 403, error: "host_not_allowed" } },
      { name: "remote address", host: REMOTE.ADDRESS, expected: { status: 403, error: "host_not_allowed" } },
    ];
    for (const row of rows) {
      assert.deepEqual(await postAnswer(app, { host: row.host, "sec-fetch-site": "same-origin" }), row.expected, row.name);
    }
  } finally {
    await app.close();
  }
});

test("the remote instance admits only its own hosts, never a loopback Host header", async () => {
  const app = await buildApp("remote");
  try {
    const rows = [
      { name: "remote .local name", host: REMOTE.HOST, expected: { status: 200 } },
      { name: "remote address", host: REMOTE.ADDRESS, expected: { status: 200 } },
      { name: "loopback Host sent to the remote instance", host: `127.0.0.1:${MONITOR_PORT}`, expected: { status: 403, error: "host_not_allowed" } },
      { name: "remote name at the monitor port", host: `bettepui-macmini.local:${MONITOR_PORT}`, expected: { status: 403, error: "host_not_allowed" } },
    ];
    for (const row of rows) {
      assert.deepEqual(await postAnswer(app, { host: row.host, "sec-fetch-site": "same-origin" }), row.expected, row.name);
    }
  } finally {
    await app.close();
  }
});

test("the remote instance's page origins are its own https origins, not the loopback ones", async () => {
  const app = await buildApp("remote");
  try {
    const rows = [
      { name: "remote https origin", origin: `https://${REMOTE.HOST}`, expected: { status: 200 } },
      { name: "loopback http origin", origin: `http://127.0.0.1:${MONITOR_PORT}`, expected: { status: 403, error: "not_page_origin" } },
      { name: "remote name over http", origin: `http://${REMOTE.HOST}`, expected: { status: 403, error: "not_page_origin" } },
    ];
    for (const row of rows) assert.deepEqual(await postAnswer(app, { host: REMOTE.HOST, origin: row.origin }), row.expected, row.name);
  } finally {
    await app.close();
  }
});
