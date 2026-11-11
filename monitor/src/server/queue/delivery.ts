// Session-side delivery transitions: pull claim (`pending`), ack (first valid ack wins), withdraw.
// Each transaction locks the caller's registry row before touching item rows (registry.ts lock order).

import { randomUUID } from "node:crypto";

import type { Prisma, QueueItemStatus } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { QueueRequestError } from "./errors.js";
import { lockSession } from "./registry.js";

const PULL = {
  // The session fetches then acks right after a pull → a missed window means the process died mid-turn
  ACK_WINDOW_MS: 10 * 60_000,
  // Bounded claim per call; the CLI pulls again while items remain
  BATCH_LIMIT: 20,
} as const;

const ACKABLE: QueueItemStatus[] = ["answered", "delivering", "unacked", "held", "expired", "resume_pending"];
// Every non-terminal state except delivering → the session retries once it has acked or the item moved on
const WITHDRAWABLE: QueueItemStatus[] = ["open", "answered", "unacked", "held", "expired", "resume_pending"];

/** One claimed item: its id and the msg id of the pull Delivery row the session acks with. */
export interface PullClaim {
  id: { item: number; msg: string };
}

export type AckResult = "first" | "already_handled";

/** Claims the caller's own answered items (route pull), one Delivery row per claimed item. */
export async function claimPendingItems(sessionId: string): Promise<PullClaim[]> {
  return getPrisma().$transaction(async (tx) => {
    await lockOwnSession(tx, sessionId);
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
    const status = await assertOwnItem(tx, itemId, sessionId);
    const moved = await tx.queueItem.updateMany({
      where: { id: BigInt(itemId), status: { in: WITHDRAWABLE } },
      data: { status: "withdrawn" },
    });
    if (moved.count === 0) throw new QueueRequestError(409, "not_withdrawable", `item in state ${status} cannot be withdrawn`);
  });
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

async function lockOwnSession(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
  if ((await lockSession(tx, sessionId)) === null) {
    throw new QueueRequestError(404, "unknown_session", "session not registered");
  }
}

async function assertOwnItem(tx: Prisma.TransactionClient, itemId: number, sessionId: string): Promise<QueueItemStatus> {
  const item = await tx.queueItem.findFirst({ where: { id: BigInt(itemId), sessionId }, select: { status: true } });
  if (item === null) throw new QueueRequestError(404, "unknown_item", "item not found for this session");
  return item.status;
}
