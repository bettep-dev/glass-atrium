// Owner-side item transitions: answer (decision), reply and Seen (report), Later (any open item), Resend, relay redaction.
// Each one is a status-guarded update, so a concurrent transition loses with a conflict instead of overwriting.

import type { Prisma, QueueItem, QueueItemStatus } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { logger } from "../logger.js";
import type { PageOriginSignal } from "../request-guards.js";
import { QueueRequestError } from "./errors.js";
import { putItemImages } from "./images.js";
import { SECRET_APPROVAL_CODE } from "./items.js";
import { canResend } from "./owner-views.js";
import { lockSession } from "./registry.js";
import { secretRequests } from "./scan-approvals.js";
import type { AnswerBody, ReplyBody } from "./schemas.js";

const RESENDABLE: QueueItemStatus[] = ["unacked", "expired", "resume_pending"];
/** The one text a redacted relay carries in place of its title and body; no request supplies another. */
export const RELAY_REDACTION_MARKER = "[relay text redacted by the owner]";

/** Answer + its record (route, page-origin signal) in one guarded write; a secret-approval item's answer also decides its request. */
export async function putAnswer(id: number, body: AnswerBody, signal: PageOriginSignal): Promise<void> {
  const item = await getOpenItemOrThrow(id, "decision");
  if (body.code !== undefined && !getOptionCodes(item.options).includes(body.code)) {
    throw new QueueRequestError(400, "unknown_option", "the code is not one of this item's options");
  }
  // images ride on words → refused wherever free text is
  if ((body.text !== undefined || body.attachmentIds.length > 0) && !item.isFreeTextAllowed) {
    throw new QueueRequestError(400, "free_text_not_allowed", "this item takes an option code only");
  }
  if (item.secretRequestId === null) await putAnswerRow(id, body, signal);
  else await putScanApprovalAnswer(id, item.secretRequestId, body, signal);
}

export async function putReply(id: number, body: ReplyBody, signal: PageOriginSignal): Promise<void> {
  const item = await getOpenItemOrThrow(id, "report");
  if (!item.isFreeTextAllowed) throw new QueueRequestError(400, "free_text_not_allowed", "this report takes no reply");
  // one transaction → a reply that loses the open race claims no image
  await getPrisma().$transaction(async (tx) => {
    await putOpenTransition(id, { status: "answered", answerText: body.text, answeredAt: new Date(), answerRoute: "reply", answerSignal: signal }, tx);
    await putItemImages(tx, [BigInt(id)], body.attachmentIds);
  });
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

/**
 * Redaction: a relay's title and body → the fixed marker, stamped with the time and the original body length; first wins.
 * @param record - the awaited audit row, written in the same transaction → no redaction stands without its record
 * @throws QueueRequestError 404 unknown_item · 409 wrong_kind · 409 already_redacted
 */
export async function putRedaction(id: number, record: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    // SET reads the row as it was → the stored length is the original body's, in the unit the relay CHECK counts
    const moved = await tx.$executeRaw`
      UPDATE "monitor"."queue_items"
      SET "relay_redacted_length" = char_length("body"), "relay_redacted_at" = now(),
          "title" = ${RELAY_REDACTION_MARKER}, "body" = ${RELAY_REDACTION_MARKER}, "updated_at" = now()
      WHERE "id" = ${BigInt(id)} AND "kind"::text = 'relay' AND "relay_redacted_at" IS NULL`;
    if (moved === 0) await throwNotRedactable(tx, id);
    await record(tx);
  });
}

/**
 * @param onOpenWrite - runs inside the transaction before the guarded write → its throw records no answer
 */
async function putAnswerRow(id: number, body: AnswerBody, signal: PageOriginSignal, onOpenWrite: () => void = () => {}): Promise<void> {
  // one transaction → no answer stands without its images, and a failed image claim records no answer
  await getPrisma().$transaction(async (tx) => {
    onOpenWrite();
    await putOpenTransition(
      id,
      { status: "answered", answerCode: body.code ?? null, answerText: body.text ?? null, answeredAt: new Date(), answerRoute: "answer", answerSignal: signal },
      tx,
    );
    await putItemImages(tx, [BigInt(id)], body.attachmentIds);
  });
}

/**
 * The owner's answer on a secret-approval item decides its scan-approval request; logs carry ids only.
 * - approve: the request turns approved before the answer's write → a gone or expired request is a 409 and no answer is recorded
 * - an approval whose answer does not commit is removed → never standing without the owner's recorded yes
 * - decline: the request is removed once the answer is recorded
 */
async function putScanApprovalAnswer(id: number, requestId: string, body: AnswerBody, signal: PageOriginSignal): Promise<void> {
  if (body.code !== SECRET_APPROVAL_CODE.APPROVE) {
    await putAnswerRow(id, body, signal);
    secretRequests.delete(requestId);
    logger.info({ itemId: id, requestId }, "scan approval request declined by the owner — removed from the store");
    return;
  }
  let isApproved = false;
  try {
    await putAnswerRow(id, body, signal, () => {
      secretRequests.approve(requestId);
      isApproved = true;
    });
  } catch (error) {
    if (isApproved) secretRequests.delete(requestId);
    throw error;
  }
  logger.info({ itemId: id, requestId }, "scan approval request approved by the owner — lines removed, hashes kept");
}

async function throwNotRedactable(tx: Prisma.TransactionClient, id: number): Promise<never> {
  const item = await tx.queueItem.findUnique({ where: { id: BigInt(id) }, select: { kind: true } });
  if (item === null) throw new QueueRequestError(404, "unknown_item", "item not found");
  if (item.kind !== "relay") throw new QueueRequestError(409, "wrong_kind", `this action applies to a relay, not a ${item.kind}`);
  throw new QueueRequestError(409, "already_redacted", "this relay's text is already redacted");
}

async function getResendFacts(tx: Prisma.TransactionClient, id: number) {
  const item = await tx.queueItem.findUniqueOrThrow({
    where: { id: BigInt(id) },
    select: {
      kind: true,
      status: true,
      nextAttempt: true,
      session: { select: { resumeAwaitingRegisterAt: true } },
      deliveries: { where: { route: "resume" }, select: { attempt: true } },
    },
  });
  return {
    kind: item.kind,
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

async function putOpenTransition(
  id: number,
  data: Prisma.QueueItemUpdateManyMutationInput,
  client: Prisma.TransactionClient = getPrisma(),
): Promise<void> {
  const moved = await client.queueItem.updateMany({ where: { id: BigInt(id), status: "open" }, data });
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
