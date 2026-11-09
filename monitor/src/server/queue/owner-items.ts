// Owner-side item transitions: answer (decision), reply and Seen (report), Later (any open item), Resend.
// Each one is a status-guarded update, so a concurrent transition loses with a conflict instead of overwriting.

import type { Prisma, QueueItem, QueueItemStatus } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { QueueRequestError } from "./errors.js";
import { canResend } from "./owner-views.js";
import { lockSession } from "./registry.js";
import type { AnswerBody, ReplyBody } from "./schemas.js";

const RESENDABLE: QueueItemStatus[] = ["unacked", "expired", "resume_pending"];

export async function putAnswer(id: number, body: AnswerBody): Promise<void> {
  const item = await getOpenItemOrThrow(id, "decision");
  if (body.code !== undefined && !getOptionCodes(item.options).includes(body.code)) {
    throw new QueueRequestError(400, "unknown_option", "the code is not one of this item's options");
  }
  if (body.text !== undefined && !item.isFreeTextAllowed) {
    throw new QueueRequestError(400, "free_text_not_allowed", "this item takes an option code only");
  }
  await putOpenTransition(id, { status: "answered", answerCode: body.code ?? null, answerText: body.text ?? null, answeredAt: new Date() });
}

export async function putReply(id: number, body: ReplyBody): Promise<void> {
  const item = await getOpenItemOrThrow(id, "report");
  if (!item.isFreeTextAllowed) throw new QueueRequestError(400, "free_text_not_allowed", "this report takes no reply");
  await putOpenTransition(id, { status: "answered", answerText: body.text, answeredAt: new Date() });
}

export async function putSeen(id: number): Promise<void> {
  await getOpenItemOrThrow(id, "report");
  await putOpenTransition(id, { status: "seen" });
}

/** Later: a fresh position from the shared sequence (distinct under concurrent writers) + one more deferral. */
export async function putLater(id: number): Promise<void> {
  const moved = await getPrisma().$executeRaw`
    UPDATE "monitor"."queue_items"
    SET "queue_position" = nextval('"monitor"."queue_items_queue_position_seq"'::regclass),
        "defer_count" = "defer_count" + 1,
        "updated_at" = now()
    WHERE "id" = ${BigInt(id)} AND "status" = 'open'`;
  if (moved === 0) await throwNotOpen(id);
}

/**
 * Resend: status and next attempt only — no Delivery row (the next claim inserts it).
 * Locks the session row first (registry → items lock order) so the marker check and the update see one state.
 * @throws QueueRequestError 409 while the session marker is set, or when the item is not resendable
 */
export async function putResend(id: number): Promise<void> {
  const owner = await getPrisma().queueItem.findUnique({ where: { id: BigInt(id) }, select: { sessionId: true } });
  if (owner === null) throw new QueueRequestError(404, "unknown_item", "item not found");
  await getPrisma().$transaction(async (tx) => {
    await lockSession(tx, owner.sessionId);
    const facts = await getResendFacts(tx, id);
    if (facts.isSessionMarked) {
      throw new QueueRequestError(409, "session_marker_set", "the session's automatic resume has not registered yet");
    }
    if (!canResend(facts)) throw new QueueRequestError(409, "not_resendable", `item in state ${facts.status} cannot be resent now`);
    const moved = await tx.queueItem.updateMany({
      where: { id: BigInt(id), status: { in: RESENDABLE }, nextAttempt: facts.nextAttempt },
      data: { status: "answered", nextAttempt: facts.nextAttempt + 1 },
    });
    if (moved.count !== 1) throw new QueueRequestError(409, "not_resendable", "the item moved on");
  });
}

async function getResendFacts(tx: Prisma.TransactionClient, id: number) {
  const item = await tx.queueItem.findUniqueOrThrow({
    where: { id: BigInt(id) },
    select: {
      status: true,
      nextAttempt: true,
      session: { select: { resumeAwaitingRegisterAt: true } },
      deliveries: { where: { route: "resume" }, select: { attempt: true } },
    },
  });
  return {
    status: item.status,
    nextAttempt: item.nextAttempt,
    isSessionMarked: item.session.resumeAwaitingRegisterAt !== null,
    resumeAttempts: item.deliveries.map((delivery) => delivery.attempt),
  };
}

async function getOpenItemOrThrow(id: number, kind: QueueItem["kind"]): Promise<QueueItem> {
  const item = await getPrisma().queueItem.findUnique({ where: { id: BigInt(id) } });
  if (item === null) throw new QueueRequestError(404, "unknown_item", "item not found");
  if (item.kind !== kind) throw new QueueRequestError(409, "wrong_kind", `this action applies to a ${kind}, not a ${item.kind}`);
  if (item.status !== "open") throw new QueueRequestError(409, "not_open", `item in state ${item.status} is no longer open`);
  return item;
}

async function putOpenTransition(id: number, data: Prisma.QueueItemUpdateManyMutationInput): Promise<void> {
  const moved = await getPrisma().queueItem.updateMany({ where: { id: BigInt(id), status: "open" }, data });
  if (moved.count === 0) await throwNotOpen(id);
}

async function throwNotOpen(id: number): Promise<never> {
  const item = await getPrisma().queueItem.findUnique({ where: { id: BigInt(id) }, select: { status: true } });
  if (item === null) throw new QueueRequestError(404, "unknown_item", "item not found");
  throw new QueueRequestError(409, "not_open", `item in state ${item.status} is no longer open`);
}

function getOptionCodes(options: Prisma.JsonValue): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) =>
    option !== null && typeof option === "object" && !Array.isArray(option) && typeof option.code === "string" ? [option.code] : [],
  );
}
