// Queue items, session side: post, get by id (owning session only), and the count-only badge numbers.

import { Prisma, type QueueItem } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { QueueRequestError } from "./errors.js";
import { ITEM_IMAGES_ARGS, type SessionImageView, getSessionImageViews } from "./images.js";
import { DEVIATION_STATUSES, SESSION_ID_PREFIX_LENGTH } from "./owner-views.js";
import { lockSession } from "./registry.js";
import type { PostItemBody } from "./schemas.js";

export interface QueueItemView {
  id: number;
  kind: string;
  sessionId: string;
  title: string;
  body: string;
  linkedDocIds: number[];
  options: Prisma.JsonValue;
  recommendedCode: string | null;
  isFreeTextAllowed: boolean;
  isApprovalClass: boolean;
  status: string;
  nextAttempt: number;
  /** Owner's answer: the chosen option code and/or free text; both null until answered. */
  answer: { code: string | null; text: string | null };
  askedAt: string;
  answeredAt: string | null;
  deliveredAt: string | null;
  /** The owner's images on this order or reply, each a local file the session reads. */
  attachments: SessionImageView[];
  /** From the stored kind: a relay is a peer session's text, every other item carries the owner's answer or message. */
  source: "owner" | "peer";
  /** A relay's sender: provenance facts plus the sender-controlled name kept apart from them; null on every other kind. */
  sender: RelaySender | null;
}

export interface RelaySender {
  sessionIdPrefix: string;
  profileLabel: string;
  /** The name the sender registered; null when it registered none. */
  selfDeclaredName: string | null;
}

const SENDER_ARGS = { select: { sessionId: true, profileLabel: true, name: true } } as const;

/** Badge numbers only: awaiting-owner items, deviations, and the oldest awaiting item's age. */
export interface QueueCount {
  awaiting: number;
  deviations: number;
  oldestAgeSeconds: number | null;
}

export async function createItem(body: PostItemBody): Promise<{ id: number }> {
  return getPrisma().$transaction(async (tx) => {
    if ((await lockSession(tx, body.sessionId)) === null) {
      throw new QueueRequestError(404, "unknown_session", "session not registered");
    }
    await assertLinkedDocsExist(tx, body.linkedDocIds);
    const item = await tx.queueItem.create({ data: buildItemRow(body) });
    return { id: Number(item.id) };
  });
}

export async function getItemOrThrow(id: number, sessionId: string, imageDir: string): Promise<QueueItemView> {
  const item = await getPrisma().queueItem.findFirst({
    where: { id: BigInt(id), sessionId },
    include: { images: ITEM_IMAGES_ARGS, fromSession: SENDER_ARGS },
  });
  // another session's item answers the same as a missing one → no existence leak
  if (item === null) throw new QueueRequestError(404, "unknown_item", "item not found for this session");
  return {
    ...toItemView(item),
    attachments: getSessionImageViews(imageDir, item.images),
    source: item.kind === "relay" ? "peer" : "owner",
    sender: item.fromSession === null ? null : toRelaySender(item.fromSession),
  };
}

/** An answered item waits for its session's pull → never a deviation. */
export async function getCount(): Promise<QueueCount> {
  const [row] = await getPrisma().$queryRaw<Array<{ awaiting: bigint; deviations: bigint; oldest_age_seconds: number | null }>>`
    SELECT
      count(*) FILTER (WHERE "status" = 'open') AS "awaiting",
      count(*) FILTER (WHERE "status"::text IN (${Prisma.join(DEVIATION_STATUSES)})) AS "deviations",
      floor(extract(epoch FROM now() - min("asked_at") FILTER (WHERE "status" = 'open')))::int AS "oldest_age_seconds"
    FROM "monitor"."queue_items" i
    WHERE "status" NOT IN ('delivered', 'seen', 'withdrawn')
      AND NOT EXISTS (SELECT 1 FROM "monitor"."queue_sessions" s WHERE s."session_id" = i."session_id" AND s."is_probe")`;
  return { awaiting: Number(row?.awaiting ?? 0), deviations: Number(row?.deviations ?? 0), oldestAgeSeconds: row?.oldest_age_seconds ?? null };
}

export async function assertLinkedDocsExist(tx: Prisma.TransactionClient, linkedDocIds: number[]): Promise<void> {
  if (linkedDocIds.length === 0) return;
  const [row] = await tx.$queryRaw<Array<{ found: number }>>`
    SELECT count(*)::int AS "found" FROM "monitor"."documents" WHERE "id" = ANY(${linkedDocIds.map(BigInt)}::bigint[])`;
  if (row?.found !== linkedDocIds.length) throw new QueueRequestError(400, "unknown_linked_doc", "every linked doc id must exist");
}

function buildItemRow(body: PostItemBody): Prisma.QueueItemUncheckedCreateInput {
  const shared = {
    kind: body.kind,
    sessionId: body.sessionId,
    title: body.title,
    body: body.body,
    linkedDocIds: body.linkedDocIds.map(BigInt),
    isFreeTextAllowed: body.isFreeTextAllowed,
  };
  if (body.kind === "report") return shared;
  return { ...shared, options: body.options, recommendedCode: body.recommendedCode, isApprovalClass: body.isApprovalClass };
}

function toRelaySender(session: { sessionId: string; profileLabel: string; name: string | null }): RelaySender {
  return { sessionIdPrefix: session.sessionId.slice(0, SESSION_ID_PREFIX_LENGTH), profileLabel: session.profileLabel, selfDeclaredName: session.name };
}

function toItemView(item: QueueItem): Omit<QueueItemView, "attachments" | "source" | "sender"> {
  return {
    id: Number(item.id),
    kind: item.kind,
    sessionId: item.sessionId,
    title: item.title,
    body: item.body,
    linkedDocIds: item.linkedDocIds.map(Number),
    options: item.options,
    recommendedCode: item.recommendedCode,
    isFreeTextAllowed: item.isFreeTextAllowed,
    isApprovalClass: item.isApprovalClass,
    status: item.status,
    nextAttempt: item.nextAttempt,
    answer: { code: item.answerCode, text: item.answerText },
    askedAt: item.askedAt.toISOString(),
    answeredAt: item.answeredAt?.toISOString() ?? null,
    deliveredAt: item.deliveredAt?.toISOString() ?? null,
  };
}
