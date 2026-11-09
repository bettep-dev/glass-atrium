// Queue items, session side: post, get by id (owning session only), and the count-only badge numbers.

import type { Prisma, QueueItem } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { QueueRequestError } from "./errors.js";
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
}

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

export async function getItem(id: number, sessionId: string): Promise<QueueItemView> {
  const item = await getPrisma().queueItem.findFirst({ where: { id: BigInt(id), sessionId } });
  // another session's item answers the same as a missing one → no existence leak
  if (item === null) throw new QueueRequestError(404, "unknown_item", "item not found for this session");
  return toItemView(item);
}

/**
 * Deviations: unacked · held · expired · resume-pending, plus answered items derived from their session row:
 * stale with a socket → "session not reachable"; live with no socket → "delivery off — session alive".
 */
export async function getCount(): Promise<QueueCount> {
  const [row] = await getPrisma().$queryRaw<Array<{ awaiting: bigint; deviations: bigint; oldest_age_seconds: number | null }>>`
    SELECT
      count(*) FILTER (WHERE i."status" = 'open') AS "awaiting",
      count(*) FILTER (
        WHERE i."status" IN ('unacked', 'held', 'expired', 'resume_pending')
           OR (i."status" = 'answered' AND (s."state" = 'stale' OR (s."state" = 'live' AND s."socket_path" IS NULL)))
      ) AS "deviations",
      floor(extract(epoch FROM now() - min(i."asked_at") FILTER (WHERE i."status" = 'open')))::int AS "oldest_age_seconds"
    FROM "monitor"."queue_items" i
    JOIN "monitor"."queue_sessions" s ON s."session_id" = i."session_id"
    WHERE i."status" NOT IN ('delivered', 'seen', 'withdrawn')`;
  return { awaiting: Number(row?.awaiting ?? 0), deviations: Number(row?.deviations ?? 0), oldestAgeSeconds: row?.oldest_age_seconds ?? null };
}

async function assertLinkedDocsExist(tx: Prisma.TransactionClient, linkedDocIds: number[]): Promise<void> {
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

function toItemView(item: QueueItem): QueueItemView {
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
