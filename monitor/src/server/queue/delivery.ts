// Session-side delivery transitions: pull claim (`pending` and the CLI's `wait` polls), ack (first valid ack wins),
// withdraw (never an owner message), and the in-memory waiting fact a wait poll refreshes.
// Each transaction locks the caller's registry row before touching item rows (registry.ts lock order).

import { randomUUID } from "node:crypto";

import type { Prisma, QueueItemKind, QueueItemStatus } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { QueueRequestError } from "./errors.js";
import { type LockedSession, lockSession } from "./registry.js";

const PULL = {
  // The session fetches then acks right after a pull → a missed window means the process died mid-turn
  ACK_WINDOW_MS: 10 * 60_000,
  // Bounded claim per call; the CLI pulls again while items remain
  BATCH_LIMIT: 20,
} as const;
// Two of the queue CLI's wait poll intervals (scripts/atrium-queue.sh → WAIT_POLL_S); a test binds the two
export const WAIT_FRESH_MS = 10_000;

/** An answer or message in flight: answered and not yet acked (the owner session list counts these too). */
export const ACKABLE: QueueItemStatus[] = ["answered", "delivering", "unacked", "held", "expired", "resume_pending"];
// Every non-terminal state except delivering → the session retries once it has acked or the item moved on
const WITHDRAWABLE: QueueItemStatus[] = ["open", "answered", "unacked", "held", "expired", "resume_pending"];

/** One claimed item: its id and the msg id of the pull Delivery row the session acks with. */
export interface PullClaim {
  id: { item: number; msg: string };
}

export type AckResult = "first" | "already_handled";

/** A wait poll names the Claude process it waits for → its claim needs the row live for that process. */
export interface WaitPoll {
  pid: number;
}

// session id → last accepted wait poll; in memory only → a running wait repopulates it within one poll after a restart
const lastWaitPollAt = new Map<string, number>();

/**
 * Claims the caller's own answered items (route pull), one Delivery row per claimed item.
 * @param wait - present for a wait poll: refused with 409 unless the row is live for its pid; accepted → the session is waiting
 */
export async function claimPendingItems(sessionId: string, wait?: WaitPoll): Promise<PullClaim[]> {
  const claims = await getPrisma().$transaction(async (tx) => {
    const session = await lockOwnSession(tx, sessionId);
    if (wait !== undefined) assertLiveFor(session, wait.pid);
    const answered = await tx.queueItem.findMany({
      where: { sessionId, status: "answered" },
      orderBy: { queuePosition: "asc" },
      take: PULL.BATCH_LIMIT,
      select: { id: true, nextAttempt: true },
    });
    const claims: PullClaim[] = [];
    for (const item of answered) {
      const claim = await claimOne(tx, item.id, item.nextAttempt);
      if (claim !== null) claims.push(claim);
    }
    return claims;
  });
  if (wait !== undefined) putWaitPoll(sessionId, Date.now());
  return claims;
}

/** True while the session's last accepted wait poll is younger than WAIT_FRESH_MS. */
export function isSessionWaiting(sessionId: string, now: Date = new Date()): boolean {
  const polledAt = lastWaitPollAt.get(sessionId);
  return polledAt !== undefined && now.getTime() - polledAt < WAIT_FRESH_MS;
}

/**
 * Acks one delivery. Valid only for a msg id of a Delivery row of this item, named by the owning session.
 * @returns "first" for the ack that moves the item to delivered; "already_handled" for every later one
 */
export async function ackItem(itemId: number, sessionId: string, msgId: string): Promise<AckResult> {
  return getPrisma().$transaction(async (tx) => {
    await lockOwnSession(tx, sessionId);
    await assertOwnItem(tx, itemId, sessionId);
    const delivery = await tx.queueDelivery.findFirst({ where: { msgId, itemId: BigInt(itemId) }, select: { id: true, result: true } });
    if (delivery === null) throw new QueueRequestError(404, "unknown_msg_id", "msg id belongs to no delivery of this item");
    const now = new Date();
    const moved = await tx.queueItem.updateMany({
      where: { id: BigInt(itemId), status: { in: ACKABLE } },
      data: { status: "delivered", deliveredAt: now },
    });
    if (moved.count === 0) return "already_handled";
    // an aborted resume row keeps its result → the abort-reason CHECK pairs reason with aborted
    if (delivery.result !== "aborted") {
      await tx.queueDelivery.update({ where: { id: delivery.id }, data: { result: "acked", receiptAt: now } });
    }
    return "first";
  });
}

export async function withdrawItem(itemId: number, sessionId: string): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    await lockOwnSession(tx, sessionId);
    const { status, kind } = await assertOwnItem(tx, itemId, sessionId);
    if (kind === "message") throw new QueueRequestError(409, "not_withdrawable", "an owner message cannot be withdrawn by its session");
    const moved = await tx.queueItem.updateMany({
      where: { id: BigInt(itemId), status: { in: WITHDRAWABLE } },
      data: { status: "withdrawn" },
    });
    if (moved.count === 0) throw new QueueRequestError(409, "not_withdrawable", `item in state ${status} cannot be withdrawn`);
  });
}

// Lapsed entries dropped on each write → the map holds only sessions polled within the window
function putWaitPoll(sessionId: string, nowMs: number): void {
  for (const [id, polledAt] of lastWaitPollAt) if (nowMs - polledAt >= WAIT_FRESH_MS) lastWaitPollAt.delete(id);
  lastWaitPollAt.set(sessionId, nowMs);
}

async function claimOne(tx: Prisma.TransactionClient, itemId: bigint, attempt: number): Promise<PullClaim | null> {
  const moved = await tx.queueItem.updateMany({ where: { id: itemId, status: "answered" }, data: { status: "delivering" } });
  if (moved.count !== 1) return null;
  const msgId = randomUUID();
  const sentAt = new Date();
  await tx.queueDelivery.create({
    data: { msgId, itemId, route: "pull", attempt, result: "sent", sentAt, ackDeadlineAt: new Date(sentAt.getTime() + PULL.ACK_WINDOW_MS) },
  });
  return { id: { item: Number(itemId), msg: msgId } };
}

async function lockOwnSession(tx: Prisma.TransactionClient, sessionId: string): Promise<LockedSession> {
  const session = await lockSession(tx, sessionId);
  if (session === null) throw new QueueRequestError(404, "unknown_session", "session not registered");
  return session;
}

// An ended, replaced or re-registered row → this wait's conversation no longer owns the session's answers
function assertLiveFor(session: LockedSession, pid: number): void {
  if (session.state !== "live" || session.pid !== pid) {
    throw new QueueRequestError(409, "session_not_live", "the session is not live for this process — stop waiting");
  }
}

async function assertOwnItem(
  tx: Prisma.TransactionClient,
  itemId: number,
  sessionId: string,
): Promise<{ status: QueueItemStatus; kind: QueueItemKind }> {
  const item = await tx.queueItem.findFirst({ where: { id: BigInt(itemId), sessionId }, select: { status: true, kind: true } });
  if (item === null) throw new QueueRequestError(404, "unknown_item", "item not found for this session");
  return item;
}
