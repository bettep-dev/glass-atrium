// Owner queue receipt listener: the monitor's own cc-socks socket, its start rules, and peer_message_status receipts
// moving a socket delivery to held / expired. Every inbound frame is untrusted.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/queue.receipts.test.ts

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import "dotenv/config";

import type { QueueDeliveryResult, QueueDeliveryRoute, QueueItemStatus } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { type ReceiptListener, startReceiptListener } from "../src/server/queue/receipt-listener.js";
import { lockSession } from "../src/server/queue/registry.js";
import { lockQueueRows, unlockQueueRows } from "./lib/queue-rows-lock.js";
import { deleteDirectory } from "./lib/remove-dir.js";

const MINUTE_MS = 60_000;
const LISTENER_PID = 4242;
const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "queue-rcpt-")));
const trackedSessionIds: string[] = [];
let listener: ReceiptListener | null = null;

before(async () => {
  await lockQueueRows();
  const started = await startReceiptListener({ socketDir: path.join(fixtureRoot, "socks"), pid: LISTENER_PID });
  if (started === null) throw new Error("receipt listener did not start on the fixture dir");
  listener = started;
});

after(async () => {
  await listener?.stop(); // null when the start failed → the row and lock cleanup below still runs
  const prisma = getPrisma();
  await prisma.queueDelivery.deleteMany({ where: { item: { sessionId: { in: trackedSessionIds } } } });
  await prisma.queueItem.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await prisma.queueSession.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await unlockQueueRows();
  await disconnectPrisma();
  deleteDirectory(fixtureRoot);
});

interface DeliverySeed {
  route?: QueueDeliveryRoute;
  result: QueueDeliveryResult;
}

/** One live session, one report item in `status`, and its Delivery rows in insert order; returns the msg ids. */
async function seedItem(status: QueueItemStatus, deliveries: DeliverySeed[]): Promise<{ sessionId: string; itemId: bigint; msgIds: string[] }> {
  const sessionId = randomUUID();
  trackedSessionIds.push(sessionId);
  const prisma = getPrisma();
  await prisma.queueSession.create({
    data: { sessionId, isConfigDirSet: false, profileLabel: "default", cwd: fixtureRoot, pid: process.pid, processStartTime: "Mon Nov  9 10:00:00 2026", state: "live", lastSeenAt: new Date() },
  });
  const item = await prisma.queueItem.create({
    data: { kind: "report", sessionId, title: "Release notes drafted", body: "Draft is in clauded-docs.", isFreeTextAllowed: true, status, answerText: "Ship it.", answeredAt: new Date() },
  });
  const msgIds: string[] = [];
  for (const seed of deliveries) {
    const msgId = randomUUID();
    msgIds.push(msgId);
    const sentAt = new Date();
    await prisma.queueDelivery.create({
      data: { msgId, itemId: item.id, route: seed.route ?? "socket", attempt: 1, result: seed.result, sentAt, ackDeadlineAt: new Date(sentAt.getTime() + 10 * MINUTE_MS) },
    });
  }
  return { sessionId, itemId: item.id, msgIds };
}

function buildReceipt(msgId: string, status: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "control", action: "peer_message_status", status, reason: "no-mode-asserted", from: "uds:/tmp/cc-socks/1.sock", orig_msg_id: msgId, ...extra });
}

function getSocketPath(): string {
  if (listener === null) throw new Error("receipt listener not started");
  return listener.socketPath;
}

/** A listener process killed with SIGKILL → its socket file stays behind with nobody listening. */
async function leaveStaleSocket(socketPath: string): Promise<void> {
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

/** Writes the lines on one connection and resolves once the listener has closed it (after applying every line). */
function sendLines(lines: string[], socketPath: string = getSocketPath()): Promise<void> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
    socket.end(lines.map((line) => `${line}\n`).join(""));
  });
}

async function getState(itemId: bigint): Promise<{ item: QueueItemStatus; deliveries: Array<{ result: QueueDeliveryResult; hasReceipt: boolean }> }> {
  const item = await getPrisma().queueItem.findUniqueOrThrow({ where: { id: itemId }, include: { deliveries: { orderBy: { id: "asc" } } } });
  return { item: item.status, deliveries: item.deliveries.map((delivery) => ({ result: delivery.result, hasReceipt: delivery.receiptAt !== null })) };
}

describe("peer_message_status receipts", () => {
  const rows = [
    { name: "held on a delivering item", item: "delivering" as const, delivery: "sent" as const, frame: { status: "held" }, expected: { item: "held", result: "held", hasReceipt: true } },
    { name: "expired on a held item", item: "held" as const, delivery: "held" as const, frame: { status: "expired" }, expected: { item: "expired", result: "expired", hasReceipt: true } },
    { name: "expired as refused (status_detail)", item: "delivering" as const, delivery: "sent" as const, frame: { status: "expired", status_detail: "refused" }, expected: { item: "delivering", result: "sent", hasReceipt: false } },
    { name: "a schema-only status (delivered)", item: "delivering" as const, delivery: "sent" as const, frame: { status: "delivered" }, expected: { item: "delivering", result: "sent", hasReceipt: false } },
    { name: "held after the ack", item: "delivered" as const, delivery: "acked" as const, frame: { status: "held" }, expected: { item: "delivered", result: "acked", hasReceipt: false } },
    { name: "expired on a delivering item (no held seen)", item: "delivering" as const, delivery: "sent" as const, frame: { status: "expired" }, expected: { item: "delivering", result: "expired", hasReceipt: true } },
  ];
  for (const row of rows) {
    test(`a receipt moves only what the state table allows: ${row.name}`, async () => {
      const { itemId, msgIds } = await seedItem(row.item, [{ result: row.delivery }]);
      const [msgId = ""] = msgIds;
      const { status, ...extra } = row.frame;

      await sendLines([buildReceipt(msgId, status, extra)]);

      const state = await getState(itemId);
      assert.deepEqual({ item: state.item, ...state.deliveries[0] }, row.expected, row.name);
    });
  }

  test("a held receipt for an older delivery records the receipt but leaves the item to its latest delivery", async () => {
    const { itemId, msgIds } = await seedItem("delivering", [{ result: "sent" }, { result: "sent" }]);

    await sendLines([buildReceipt(msgIds[0] ?? "", "held")]);

    assert.deepEqual(await getState(itemId), {
      item: "delivering",
      deliveries: [
        { result: "held", hasReceipt: true },
        { result: "sent", hasReceipt: false },
      ],
    });
  });

  test("a receipt naming a resume delivery or no delivery at all changes nothing", async () => {
    const resume = await seedItem("delivering", [{ route: "resume", result: "sent" }]);

    await sendLines([buildReceipt(resume.msgIds[0] ?? "", "held"), buildReceipt(randomUUID(), "held")]);

    assert.deepEqual(await getState(resume.itemId), { item: "delivering", deliveries: [{ result: "sent", hasReceipt: false }] });
  });

  test("malformed and oversized frames are ignored, and the listener keeps serving", async () => {
    const { itemId, msgIds } = await seedItem("delivering", [{ result: "sent" }]);
    const [msgId = ""] = msgIds;
    const malformed = [
      "not json at all",
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      buildReceipt("not-a-uuid", "held"),
      JSON.stringify({ type: "control", action: "peer_message_status", status: "held" }),
      // valid but for its size: an unknown key the parse would strip
      buildReceipt(msgId, "held", { padding: "x".repeat(10_000) }),
    ];

    await sendLines(malformed);
    const afterMalformed = await getState(itemId);
    await sendLines([buildReceipt(msgId, "held")]);

    assert.deepEqual(afterMalformed, { item: "delivering", deliveries: [{ result: "sent", hasReceipt: false }] });
    assert.equal((await getState(itemId)).item, "held", "a later valid frame still applies");
  });
});

describe("connection bounds", () => {
  test("a line past the per-connection byte cap is not applied, though every line is under the line cap", async () => {
    const { itemId, msgIds } = await seedItem("delivering", [{ result: "sent" }]);
    const filler = buildReceipt(randomUUID(), "held", { padding: "x".repeat(3_500) });
    const fillers = Array.from({ length: Math.ceil((64 * 1_024) / filler.length) + 1 }, () => filler);

    await sendLines([...fillers, buildReceipt(msgIds[0] ?? "", "held")]);

    assert.ok(filler.length < 4_096, "each filler line stays under the line cap");
    assert.deepEqual(await getState(itemId), { item: "delivering", deliveries: [{ result: "sent", hasReceipt: false }] });
  });

  test("the listener ends a connection that stays idle", { timeout: 5_000 }, async () => {
    const started = await startReceiptListener({ socketDir: path.join(fixtureRoot, "idle-socks"), pid: LISTENER_PID, idleTimeoutMs: 50 });
    assert.ok(started !== null);
    try {
      const socket = createConnection({ path: started.socketPath });
      const hasEnded = await new Promise<boolean>((resolve) => {
        let isEnded = false;
        socket.on("end", () => (isEnded = true));
        socket.on("error", () => undefined);
        socket.on("close", () => resolve(isEnded));
      });

      assert.equal(hasEnded, true, "the listener closed its side; the client never wrote or ended");
    } finally {
      await started.stop();
    }
  });
});

describe("listener start and stop", () => {
  test("stop waits for a receipt still being applied", { timeout: 10_000 }, async () => {
    let signalReceived = (): void => undefined;
    const received = new Promise<void>((resolve) => (signalReceived = resolve));
    const now = (): Date => {
      signalReceived();
      return new Date();
    };
    const started = await startReceiptListener({ socketDir: path.join(fixtureRoot, "drain-socks"), pid: LISTENER_PID, now });
    assert.ok(started !== null);
    const { sessionId, itemId, msgIds } = await seedItem("delivering", [{ result: "sent" }]);
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    let signalLocked = (): void => undefined;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    // the test holds the session row lock → the receipt's apply blocks inside its transaction
    const holding = getPrisma().$transaction(
      async (tx) => {
        await lockSession(tx, sessionId);
        signalLocked();
        await released;
      },
      { timeout: 10_000 },
    );
    await locked;
    const sent = sendLines([buildReceipt(msgIds[0] ?? "", "held")], started.socketPath);
    await received;

    const stateAtStop = started.stop().then(() => getState(itemId));
    // a stop that does not wait resolves while the lock is held → its state is read first; the bound only delays a waiting stop
    await Promise.race([stateAtStop, delay(500)]);
    release();
    await holding;

    assert.equal((await stateAtStop).item, "held", "the apply in flight at stop finished before stop resolved");
    await sent;
  });

  test("the socket dir is created 0700 and the reply address names <dir>/<pid>.sock", async () => {
    const socketDir = path.join(fixtureRoot, "fresh-socks");
    const started = await startReceiptListener({ socketDir, pid: LISTENER_PID });
    assert.ok(started !== null);
    await started.stop();

    assert.equal(lstatSync(socketDir).mode & 0o777, 0o700);
    assert.equal(started.replyAddress, `uds:${path.join(socketDir, `${LISTENER_PID}.sock`)}`);
    assert.equal(existsSync(started.socketPath), false, "stop removes the socket file");
  });

  test("a stale own socket left by a killed monitor is replaced", async () => {
    const socketDir = path.join(fixtureRoot, "stale-socks");
    mkdirSync(socketDir, { mode: 0o700 });
    const stalePath = path.join(socketDir, `${LISTENER_PID}.sock`);
    await leaveStaleSocket(stalePath);
    assert.ok(lstatSync(stalePath).isSocket(), "the killed listener left its socket file");

    const started = await startReceiptListener({ socketDir, pid: LISTENER_PID });
    assert.ok(started !== null, "a stale own socket does not stop the start");
    const { itemId, msgIds } = await seedItem("delivering", [{ result: "sent" }]);
    await sendLines([buildReceipt(msgIds[0] ?? "", "held")], started.socketPath);
    await started.stop();

    assert.equal((await getState(itemId)).item, "held");
  });

  const refusedRows = [
    { name: "a socket dir open to group and others", prepare: (dir: string) => { mkdirSync(dir); chmodSync(dir, 0o755); } },
    { name: "a non-socket file at the own socket path", prepare: (dir: string) => { mkdirSync(dir, { mode: 0o700 }); writeFileSync(path.join(dir, `${LISTENER_PID}.sock`), "keep"); } },
  ];
  for (const row of refusedRows) {
    test(`the listener stays off: ${row.name}`, async () => {
      const socketDir = path.join(fixtureRoot, `refused-${randomUUID().slice(0, 8)}`);
      row.prepare(socketDir);

      const started = await startReceiptListener({ socketDir, pid: LISTENER_PID });
      await started?.stop(); // a wrongly started listener would hold the run open

      assert.equal(started, null, row.name);
    });
  }
});
