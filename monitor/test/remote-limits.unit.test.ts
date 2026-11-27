// Remote listener limits: per-key request windows, the failed-session block, and the connection caps.

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { connect, createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";

import { logger } from "../src/server/logger.js";
import { REMOTE_LIMITS, WindowLimiter, attachConnectionCaps, buildRefusalLog } from "../src/server/remote/limits.js";

const START = Date.parse("2026-11-14T14:20:00.123Z");

test("the fixed limits are the plan's values", () => {
  assert.deepEqual(
    {
      preAuth: [REMOTE_LIMITS.PRE_AUTH.limit, REMOTE_LIMITS.PRE_AUTH.windowMs],
      codePerAddress: [REMOTE_LIMITS.CODE_PER_ADDRESS.limit, REMOTE_LIMITS.CODE_PER_ADDRESS.windowMs],
      codeTotal: [REMOTE_LIMITS.CODE_TOTAL.limit, REMOTE_LIMITS.CODE_TOTAL.windowMs],
      failedSession: [REMOTE_LIMITS.FAILED_SESSION.limit, REMOTE_LIMITS.FAILED_SESSION.windowMs, REMOTE_LIMITS.FAILED_SESSION.blockMs],
      deviceRequests: [REMOTE_LIMITS.DEVICE_REQUESTS.limit, REMOTE_LIMITS.DEVICE_REQUESTS.windowMs],
      deviceMutations: [REMOTE_LIMITS.DEVICE_MUTATIONS.limit, REMOTE_LIMITS.DEVICE_MUTATIONS.windowMs],
      connections: [REMOTE_LIMITS.CONNECTIONS.total, REMOTE_LIMITS.CONNECTIONS.perAddress],
    },
    {
      preAuth: [60, 60_000],
      codePerAddress: [3, 60_000],
      codeTotal: [10, 60_000],
      failedSession: [20, 10 * 60_000, 15 * 60_000],
      deviceRequests: [600, 60_000],
      deviceMutations: [60, 60_000],
      connections: [32, 8],
    },
  );
});

test("a key is allowed up to its limit inside one window and refused after it", () => {
  const limiter = new WindowLimiter({ limit: 3, windowMs: 60_000 }, () => START);
  const results = Array.from({ length: 4 }, () => limiter.hit("192.168.1.20"));
  assert.deepEqual(results, [true, true, true, false]);
});

test("keys are counted apart, so one address's burst does not refuse another", () => {
  const limiter = new WindowLimiter({ limit: 1, windowMs: 60_000 }, () => START);
  assert.equal(limiter.hit("192.168.1.20"), true);
  assert.equal(limiter.hit("192.168.1.20"), false);
  assert.equal(limiter.hit("192.168.1.21"), true);
});

test("a new window starts the count again", () => {
  const clock = { now: START };
  const limiter = new WindowLimiter({ limit: 1, windowMs: 60_000 }, () => clock.now);
  limiter.hit("192.168.1.20");
  clock.now = START + 60_000;
  assert.equal(limiter.hit("192.168.1.20"), true);
});

test("reaching a blocking limit blocks the key for the block time, past the end of the window", () => {
  const clock = { now: START };
  const limiter = new WindowLimiter({ limit: 2, windowMs: 10_000, blockMs: 60_000 }, () => clock.now);
  limiter.hit("192.168.1.20");
  assert.equal(limiter.isBlocked("192.168.1.20"), false, "one failure below the limit");
  limiter.hit("192.168.1.20");
  const rows = [
    { name: "right after the limit", at: START, expected: true },
    { name: "after the window but inside the block", at: START + 59_999, expected: true },
    { name: "when the block ends", at: START + 60_000, expected: false },
  ];
  for (const row of rows) {
    clock.now = row.at;
    assert.equal(limiter.isBlocked("192.168.1.20"), row.expected, row.name);
  }
});

test("isBlocked does not count a hit", () => {
  const limiter = new WindowLimiter({ limit: 1, windowMs: 60_000 }, () => START);
  for (let index = 0; index < 5; index += 1) limiter.isBlocked("192.168.1.20");
  assert.equal(limiter.hit("192.168.1.20"), true);
});

async function startCappedServer(caps: { total: number; perAddress: number }): Promise<Server> {
  const server = createServer((socket) => socket.write("ok"));
  attachConnectionCaps(server, caps, buildRefusalLog());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

/** Opens a socket; resolves true when the server keeps it (writes "ok"), false when it is closed unanswered. */
async function isConnectionKept(server: Server, sockets: Socket[]): Promise<boolean> {
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const socket = connect(address.port, "127.0.0.1");
  sockets.push(socket);
  return new Promise((resolve) => {
    socket.once("data", () => resolve(true));
    socket.once("close", () => resolve(false));
  });
}

test("a connection past the per-address or the total cap is closed, and a freed slot is reusable", async () => {
  const rows = [
    { name: "per-address cap", caps: { total: 10, perAddress: 2 } },
    { name: "total cap", caps: { total: 2, perAddress: 10 } },
  ];
  for (const row of rows) {
    const server = await startCappedServer(row.caps);
    const sockets: Socket[] = [];
    try {
      const kept = [await isConnectionKept(server, sockets), await isConnectionKept(server, sockets), await isConnectionKept(server, sockets)];
      assert.deepEqual(kept, [true, true, false], row.name);
      const first = sockets[0];
      assert.ok(first);
      first.destroy();
      await once(first, "close");
      // the server sees the close a tick after the client
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await isConnectionKept(server, sockets), true, `${row.name}: freed slot`);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  }
});

/** Fields of every info line that records a refused connection. */
function getRefusals(calls: ReadonlyArray<{ arguments: unknown[] }>): Record<string, unknown>[] {
  return calls
    .map((call) => call.arguments[0])
    .filter((fields): fields is Record<string, unknown> => typeof fields === "object" && fields !== null && "reason" in fields);
}

test("a connection refused at the cap leaves one info line with the cap reason and the peer address", async () => {
  const server = await startCappedServer({ total: 10, perAddress: 1 });
  const sockets: Socket[] = [];
  const info = mock.method(logger, "info", () => undefined);
  try {
    assert.equal(await isConnectionKept(server, sockets), true);
    assert.equal(await isConnectionKept(server, sockets), false);
  } finally {
    info.mock.restore();
    for (const socket of sockets) socket.destroy();
    server.close();
  }
  assert.deepEqual(getRefusals(info.mock.calls), [{ reason: "connection_cap", address: "127.0.0.1" }]);
});

test("a burst of refusals from one address logs at most the per-address bound in a window, and another address still logs", () => {
  const logRefusal = buildRefusalLog(() => START);
  const info = mock.method(logger, "info", () => undefined);
  try {
    for (let index = 0; index < REMOTE_LIMITS.REFUSAL_LOG.limit + 5; index += 1) logRefusal({ reason: "connection_cap", address: "192.168.1.20" });
    logRefusal({ reason: "client_error", code: "ERR_SSL_HTTP_REQUEST", address: "192.168.1.21" });
  } finally {
    info.mock.restore();
  }
  const addresses = getRefusals(info.mock.calls).map((fields) => fields.address);
  assert.deepEqual(addresses, [...Array<string>(REMOTE_LIMITS.REFUSAL_LOG.limit).fill("192.168.1.20"), "192.168.1.21"]);
});
