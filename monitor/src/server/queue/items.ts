// Queue items, session side: post, get by id (owning session only), the source facts of a pull claim, and the count-only badge numbers.

import { Prisma, type QueueItem, type QueueItemKind } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import type { PullClaim } from "./delivery.js";
import { QueueRequestError } from "./errors.js";
import { ITEM_IMAGES_ARGS, type SessionImageView, getSessionImageViews } from "./images.js";
import { DEVIATION_STATUSES, type RelaySender, type RelaySenderRow, SENDER_ARGS, toRelaySender } from "./owner-views.js";
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

type SourceFacts = Pick<QueueItemView, "source" | "sender">;

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

/** A relay's first fetch is stamped → a relay read without a claim still counts toward its reader's hop. */
export async function getItemOrThrow(id: number, sessionId: string, imageDir: string): Promise<QueueItemView> {
  const item = await getPrisma().queueItem.findFirst({
    where: { id: BigInt(id), sessionId },
    include: { images: ITEM_IMAGES_ARGS, fromSession: SENDER_ARGS },
  });
  // another session's item answers the same as a missing one → no existence leak
  if (item === null) throw new QueueRequestError(404, "unknown_item", "item not found for this session");
  if (item.kind === "relay" && item.relayFetchedAt === null) {
    await getPrisma().queueItem.updateMany({ where: { id: item.id, relayFetchedAt: null }, data: { relayFetchedAt: new Date() } });
  }
  return { ...toItemView(item), attachments: getSessionImageViews(imageDir, item.images), ...getSourceFacts(item) };
}

/** A pull claim with the facts that tell a peer's relay from an owner item before the session fetches it. */
export type ClaimView = PullClaim & SourceFacts;

export async function getClaimViews(claims: PullClaim[]): Promise<ClaimView[]> {
  const items = await getPrisma().queueItem.findMany({
    where: { id: { in: claims.map((claim) => BigInt(claim.id.item)) } },
    select: { id: true, kind: true, fromSession: SENDER_ARGS },
  });
  const byId = new Map(items.map((item) => [Number(item.id), item]));
  return claims.map((claim) => {
    const item = byId.get(claim.id.item);
    // claimed rows are never deleted → a miss is a broken invariant, not a caller error
    if (item === undefined) throw new Error(`claimed queue item ${claim.id.item} not found`);
    return { ...claim, ...getSourceFacts(item) };
  });
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

function getSourceFacts(item: { kind: QueueItemKind; fromSession: RelaySenderRow | null }): SourceFacts {
  return { source: item.kind === "relay" ? "peer" : "owner", sender: item.fromSession === null ? null : toRelaySender(item.fromSession) };
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
