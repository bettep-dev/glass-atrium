// Queue items, session side: post, get by id (owning session only), the source facts of a pull claim, and the count-only badge numbers.

import { Prisma, type QueueItem, type QueueItemKind } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import type { PullClaim } from "./delivery.js";
import { QueueRequestError } from "./errors.js";
import { ITEM_IMAGES_ARGS, type SessionImageView, getSessionImageViews } from "./images.js";
import { DEVIATION_STATUSES, NOT_PROBE_ITEM_FILTER, type RelaySender, type RelaySenderRow, SENDER_ARGS, toRelaySender } from "./owner-views.js";
import { lockSession } from "./registry.js";
import { SECRET_REQUEST_LIMIT, secretRequests } from "./scan-approvals.js";
import type { PostItemBody, SecretApprovalBody } from "./schemas.js";

const APPROVE_LABEL = "Approve this write once";

/** A secret-approval item's two option codes; the owner's answer with one of them approves or declines the linked request. */
export const SECRET_APPROVAL_CODE = { APPROVE: "R1", DECLINE: "R2" } as const;

/** A secret-approval item's fixed text → the owner judges the hook's own capture, shown beside it, never a session's words. */
const SECRET_APPROVAL_ITEM = {
  title: "Secret-scan refusal: approve one write?",
  body:
    `${APPROVE_LABEL} (${SECRET_APPROVAL_CODE.APPROVE}) lets the write this request names pass the secret-scan hook once: the same lines, file, rule and session, ` +
    `within ${SECRET_REQUEST_LIMIT.APPROVED_MS / 60_000} minutes of the answer. ` +
    `Decline (${SECRET_APPROVAL_CODE.DECLINE}) when a line holds a real password or key: the session then writes an environment-variable reference instead.`,
  options: [
    { code: SECRET_APPROVAL_CODE.APPROVE, label: APPROVE_LABEL, pros: "The refused write lands as written.", cons: "A real secret in a line would be written to the file." },
    { code: SECRET_APPROVAL_CODE.DECLINE, label: "Decline", pros: "Nothing is written and the request is dropped.", cons: "The session rewrites the line, e.g. as an environment-variable reference." },
  ],
  recommendedCode: SECRET_APPROVAL_CODE.DECLINE,
};

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
  /** The owner's images on this order, reply or answer, each a local file the session reads. */
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
    if (body.kind === "secret-approval") await assertSecretRequestLinkable(tx, body);
    else await assertLinkedDocsExist(tx, body.linkedDocIds);
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
    WHERE "status" NOT IN ('delivered', 'seen', 'withdrawn') AND "kind"::text <> 'relay'
      AND ${NOT_PROBE_ITEM_FILTER}`;
  return { awaiting: Number(row?.awaiting ?? 0), deviations: Number(row?.deviations ?? 0), oldestAgeSeconds: row?.oldest_age_seconds ?? null };
}

export async function assertLinkedDocsExist(tx: Prisma.TransactionClient, linkedDocIds: number[]): Promise<void> {
  if (linkedDocIds.length === 0) return;
  const [row] = await tx.$queryRaw<Array<{ found: number }>>`
    SELECT count(*)::int AS "found" FROM "monitor"."documents" WHERE "id" = ANY(${linkedDocIds.map(BigInt)}::bigint[])`;
  if (row?.found !== linkedDocIds.length) throw new QueueRequestError(400, "unknown_linked_doc", "every linked doc id must exist");
}

/** Pending, this session's, unlinked; the caller's session lock serializes its posts → no racing link between read and insert. */
async function assertSecretRequestLinkable(tx: Prisma.TransactionClient, body: SecretApprovalBody): Promise<void> {
  const request = secretRequests.find(body.requestId);
  // another session's request answers the same as a missing one → no existence leak; Postgres uuid ignores letter case
  if (request === null || request.sessionId.toLowerCase() !== body.sessionId.toLowerCase()) {
    throw new QueueRequestError(404, "unknown_secret_request", "scan approval request not found for this session");
  }
  if (request.state !== "pending") throw new QueueRequestError(409, "secret_request_not_pending", "scan approval request is already approved");
  const linked = await tx.queueItem.findUnique({ where: { secretRequestId: body.requestId }, select: { id: true } });
  if (linked !== null) throw new QueueRequestError(409, "secret_request_linked", "scan approval request already has its item");
}

function buildItemRow(body: PostItemBody): Prisma.QueueItemUncheckedCreateInput {
  if (body.kind === "secret-approval") {
    return { ...SECRET_APPROVAL_ITEM, kind: "decision", sessionId: body.sessionId, isFreeTextAllowed: false, isApprovalClass: true, secretRequestId: body.requestId };
  }
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
