// Receipt listener: the monitor's own inbox socket in cc-socks, named by its pid → a session that holds or expires a
// socket frame sends peer_message_status back to the frame's `from` address (receipts reach only a pid-named path).
// Every inbound byte is untrusted: line, connection and idle bounds, a Zod parse, and a frame only ever touches
// the socket Delivery row its msg id names. Any same-uid process can connect → a receipt moves display state only.

import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import path from "node:path";

import { z } from "zod";

import type { QueueDeliveryResult, QueueItemStatus } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { errnoCode } from "../errno.js";
import { logger } from "../logger.js";
import { lockSession } from "./registry.js";

const RECEIPT = {
  LINE_MAX_BYTES: 4_096,
  CONNECTION_MAX_BYTES: 64 * 1_024,
  IDLE_TIMEOUT_MS: 30_000,
  MAX_CONNECTIONS: 16,
} as const;
const DEFAULT_SOCKET_DIR = "/tmp/cc-socks";
const NEWLINE = 0x0a;

// Shape read from the 2.1.319 bundle; unknown keys (reason, from, drop_reason) are stripped, never trusted
const receiptFrameSchema = z.object({
  type: z.literal("control"),
  action: z.literal("peer_message_status"),
  status: z.string().max(32),
  status_detail: z.string().max(64).optional(),
  orig_msg_id: z.uuid(),
});

type ReceiptStatus = "held" | "expired";

// Item states: delivering → held on a held receipt, held → expired on an expired receipt; the row records either
const RECEIPT_RULES: Record<ReceiptStatus, { deliveryFrom: QueueDeliveryResult[]; item: { from: QueueItemStatus; to: QueueItemStatus } }> = {
  held: { deliveryFrom: ["sent"], item: { from: "delivering", to: "held" } },
  expired: { deliveryFrom: ["sent", "held"], item: { from: "held", to: "expired" } },
};

export interface ReceiptListenerOptions {
  socketDir?: string;
  pid?: number;
  now?: () => Date;
  /** A connection with no traffic for this long is closed; defaults to RECEIPT.IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
}

export interface ReceiptListener {
  socketPath: string;
  /** The frame's `from` value: `uds:<socket path>`. */
  replyAddress: string;
  /** Closes the socket and its connections, waits for the receipts still being applied, then removes the socket file. */
  stop(): Promise<void>;
}

/**
 * Binds `<socket dir>/<pid>.sock`: the dir is created 0700 when missing, and a stale own socket (a SIGKILLed process
 * held this pid) is replaced.
 * @returns null when the dir is not a private dir of this uid or the own path holds a non-socket → frames carry no `from`
 */
export async function startReceiptListener(options: ReceiptListenerOptions = {}): Promise<ReceiptListener | null> {
  const socketDir = options.socketDir ?? DEFAULT_SOCKET_DIR;
  const socketPath = path.join(socketDir, `${options.pid ?? process.pid}.sock`);
  try {
    const refusal = (await getSocketDirRefusal(socketDir)) ?? (await getSocketPathRefusal(socketPath));
    if (refusal !== null) {
      logger.warn({ socketDir, reason: refusal }, "queue receipt listener off — frames carry no reply address");
      return null;
    }
    await deleteSocketFile(socketPath); // a live process never shares this pid → a socket at the own path is a dead one's leftover
    return await createListener(socketPath, { now: options.now ?? (() => new Date()), idleTimeoutMs: options.idleTimeoutMs ?? RECEIPT.IDLE_TIMEOUT_MS });
  } catch (error) {
    logger.warn({ err: error, socketPath }, "queue receipt listener failed to start — frames carry no reply address");
    return null;
  }
}

/** Applies one receipt to the socket Delivery row it names; the item moves only when that row is its latest. */
export async function putReceipt(msgId: string, status: ReceiptStatus, now: Date): Promise<void> {
  const delivery = await getPrisma().queueDelivery.findUnique({
    where: { msgId },
    select: { id: true, itemId: true, route: true, item: { select: { sessionId: true } } },
  });
  if (delivery === null || delivery.route !== "socket") return;
  const rule = RECEIPT_RULES[status];
  await getPrisma().$transaction(async (tx) => {
    await lockSession(tx, delivery.item.sessionId);
    const marked = await tx.queueDelivery.updateMany({ where: { id: delivery.id, result: { in: rule.deliveryFrom } }, data: { result: status, receiptAt: now } });
    if (marked.count === 0) return;
    const latest = await tx.queueDelivery.findFirst({ where: { itemId: delivery.itemId }, orderBy: { id: "desc" }, select: { id: true } });
    if (latest?.id !== delivery.id) return;
    await tx.queueItem.updateMany({ where: { id: delivery.itemId, status: rule.item.from }, data: { status: rule.item.to } });
  });
}

async function getSocketDirRefusal(socketDir: string): Promise<string | null> {
  try {
    await mkdir(socketDir, { mode: 0o700 });
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
  }
  const stats = await lstat(socketDir);
  if (!stats.isDirectory()) return "socket dir is not a directory";
  if (stats.uid !== process.getuid?.()) return "socket dir is owned by another user";
  if ((stats.mode & 0o077) !== 0) return "socket dir is open to group or others";
  return null;
}

async function getSocketPathRefusal(socketPath: string): Promise<string | null> {
  try {
    return (await lstat(socketPath)).isSocket() ? null : "a non-socket entry holds the own socket path";
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function deleteSocketFile(socketPath: string): Promise<void> {
  try {
    await unlink(socketPath);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

interface ConnectionOptions {
  now: () => Date;
  idleTimeoutMs: number;
  /** Every receipt apply still running, across connections → stop waits for them before the DB client goes. */
  applies: Set<Promise<void>>;
}

async function createListener(socketPath: string, options: Omit<ConnectionOptions, "applies">): Promise<ReceiptListener> {
  const sockets = new Set<Socket>();
  const connectionOptions: ConnectionOptions = { ...options, applies: new Set() };
  // half-open → the peer's end does not close our side before its lines are applied
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleConnection(socket, connectionOptions);
  });
  server.maxConnections = RECEIPT.MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // an accept failure (EMFILE) after listen → logged; an unhandled server error would end the monitor
  server.on("error", (error) => logger.warn({ err: error, socketPath }, "queue receipt listener error — receipts may be missed"));
  await chmod(socketPath, 0o600);
  return { socketPath, replyAddress: `uds:${socketPath}`, stop: () => stopListener(server, sockets, connectionOptions.applies, socketPath) };
}

async function stopListener(server: Server, sockets: Set<Socket>, applies: Set<Promise<void>>, socketPath: string): Promise<void> {
  const closed = new Promise((resolve) => server.close(resolve));
  for (const socket of sockets) socket.destroy();
  await closed;
  await Promise.allSettled(applies);
  await deleteSocketFile(socketPath);
}

// Lines apply in arrival order; the connection closes once every line it carried is applied
function handleConnection(socket: Socket, options: ConnectionOptions): void {
  let applying = Promise.resolve();
  const splitter = new LineSplitter(
    (line) => (applying = createTrackedApply(applying, line, options)),
    (reason) => {
      logger.warn({ reason }, "queue receipt connection dropped");
      socket.destroy();
    },
  );
  socket.setTimeout(options.idleTimeoutMs, () => socket.destroy());
  socket.on("error", (error) => logger.debug({ err: error }, "queue receipt connection error"));
  socket.on("data", (chunk: Buffer) => splitter.push(chunk));
  socket.on("end", () => {
    splitter.flush();
    void applying.then(() => socket.end());
  });
}

/** Chains one line's apply after the connection's earlier lines and tracks it until it settles. @returns the new chain tail */
function createTrackedApply(previous: Promise<void>, line: string, options: ConnectionOptions): Promise<void> {
  const tracked = previous.then(() => putReceiptLine(line, options.now));
  const untrack = (): boolean => options.applies.delete(tracked);
  options.applies.add(tracked);
  void tracked.then(untrack, untrack);
  return tracked;
}

/** NDJSON splitter with the line and connection caps; a breach stops all further lines. */
class LineSplitter {
  private pending = Buffer.alloc(0);
  private total = 0;
  private isStopped = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: (reason: string) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.isStopped) return;
    this.total += chunk.length;
    if (this.total > RECEIPT.CONNECTION_MAX_BYTES) return this.stop("connection over the size cap");
    this.pending = Buffer.concat([this.pending, chunk]);
    for (let index = this.pending.indexOf(NEWLINE); index !== -1 && !this.isStopped; index = this.pending.indexOf(NEWLINE)) {
      const line = this.pending.subarray(0, index);
      this.pending = this.pending.subarray(index + 1);
      if (line.length > RECEIPT.LINE_MAX_BYTES) return this.stop("line over the size cap");
      this.onLine(line.toString("utf8"));
    }
    if (this.pending.length > RECEIPT.LINE_MAX_BYTES) this.stop("line over the size cap");
  }

  /** The last line when the peer ended without a trailing newline. */
  flush(): void {
    if (!this.isStopped && this.pending.length > 0) this.onLine(this.pending.toString("utf8"));
    this.pending = Buffer.alloc(0);
  }

  private stop(reason: string): void {
    this.isStopped = true;
    this.onOverflow(reason);
  }
}

// Untrusted input: a parse failure or an inapplicable status is dropped, never logged with its content
async function putReceiptLine(line: string, now: () => Date): Promise<void> {
  const frame = receiptFrameSchema.safeParse(getParsedJson(line));
  if (!frame.success) {
    logger.debug("queue receipt frame ignored — not a peer_message_status frame");
    return;
  }
  const status = getReceiptStatus(frame.data.status, frame.data.status_detail);
  if (status === null) return;
  try {
    await putReceipt(frame.data.orig_msg_id, status, now());
  } catch (error) {
    logger.warn({ err: error, msgId: frame.data.orig_msg_id, status }, "queue receipt not applied — the ack or the deadline still settles the item");
  }
}

function getParsedJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Expired with status_detail refused is the receiver's refusal, not a dialog expiry → no state of its own here
function getReceiptStatus(status: string, statusDetail: string | undefined): ReceiptStatus | null {
  if (status === "held") return "held";
  if (status === "expired" && statusDetail !== "refused") return "expired";
  return null;
}
