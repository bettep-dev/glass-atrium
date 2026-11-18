// Owner-side reads: the queue list and item detail, each item carrying its session, resume record, deviation,
// sweep skip reason (Item states → Card precedence) and whether Resend is allowed.
// The skip reason is derived from stored rows at read time, by the same rules the sweep in sweep.ts / resume-claim.ts applies.

import {
  Prisma,
  type QueueAnswerRoute,
  type QueueAnswerSignal,
  type QueueDelivery,
  type QueueItem,
  type QueueItemKind,
  type QueueItemStatus,
  type QueueSession,
} from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { ACKABLE, isSessionWaiting } from "./delivery.js";
import { QueueRequestError } from "./errors.js";
import { ITEM_IMAGES_ARGS, type ImageView, getImageViews } from "./images.js";
import { TERMINAL } from "./registry.js";
import { buildResumeInFlightSql } from "./resume-claim.js";
import type { OwnerListQuery, OwnerOrdersQuery, RecentResumesQuery } from "./schemas.js";

/** The item states the count route and the item views flag as deviations. */
export const DEVIATION_STATUSES = ["unacked", "held", "expired", "resume_pending"] as const satisfies readonly QueueItemStatus[];
// Every state an answer leads to; open, seen and withdrawn carry no answer → never "answered outside"
const ANSWERED_STATUSES = new Set<QueueItemStatus>([...ACKABLE, "delivered"]);
export const SESSION_ID_PREFIX_LENGTH = 8;
const RELAY_SIGNAL_WINDOW_MS = 24 * 3_600_000;
// ponytail: refusals past this cap in one page's time span are cut (isRefusalListCut) → upgrade: their own cursor
const REFUSAL_PAGE_MAX = 100;
// The relay refusals the relay module decided: only those audit rows carry a reason
export const RELAY_REFUSAL_FILTER = Prisma.sql`a."target_table" = 'queue-relay' AND a."result_code" = 'blocked' AND a."payload" -> 'change' ->> 'reason' IS NOT NULL`;

export type Deviation = (typeof DEVIATION_STATUSES)[number];

/** A marked row occupying the waiting session's worktree, named on its shared-worktree card. */
export interface MarkedOccupant {
  profileLabel: string;
  cwdTail: string;
  sessionIdPrefix: string;
}

/** First matching sweep skip row by card precedence; `in_flight` carries no card text. */
export type SkipReason =
  | { kind: "marker" }
  | { kind: "resume_used" }
  | { kind: "shared_worktree"; markedOccupants: MarkedOccupant[]; hasUnmarkedOccupant: boolean }
  | { kind: "in_flight" };

/** One naming rule for every owner surface: the registered name, else the start directory's basename. */
export interface SessionName {
  name: string;
  isNameRegistered: boolean;
}

export interface OwnerSessionView extends SessionName {
  id: string;
  sessionIdPrefix: string;
  profileLabel: string;
  cwd: string;
  cwdTail: string;
  /** Present only when CLAUDE_CONFIG_DIR was recorded as set → the marker card's command carries it. */
  configDir: string | null;
  state: string;
  /** A wait poll arrived within the freshness window (delivery.ts → WAIT_FRESH_MS). */
  isWaiting: boolean;
  permissionHint: string | null;
  /** Session marker: an automatic resume spawned and not yet registered; `bgId` from that spawn's resume rows. */
  marker: { setAt: string; bgId: string | null } | null;
}

export interface ResumeRecord {
  sentAt: string;
  attempt: number;
  result: string;
  abortReason: string | null;
  bgId: string | null;
}

/** A page-level resume record: the item it carried and the session it resumed. */
export interface RecentResume extends ResumeRecord {
  item: { id: number; title: string };
  session: { profileLabel: string; cwdTail: string };
}

/** A relay's sender: provenance facts plus the sender-controlled name kept apart from them. */
export interface RelaySender {
  sessionIdPrefix: string;
  profileLabel: string;
  /** The name the sender registered; null when it registered none. */
  selfDeclaredName: string | null;
}

export type RelaySenderRow = Pick<QueueSession, "sessionId" | "profileLabel" | "name">;

export const SENDER_ARGS = { select: { sessionId: true, profileLabel: true, name: true } } as const satisfies Prisma.QueueSessionDefaultArgs;

/** The relay that set a hop-1 or hop-2 relay's hop. */
export interface RelayParent {
  id: number;
  sender: RelaySender;
  sentAt: string;
}

/** What a relay entry adds to the owner item view. */
export interface RelayFacts {
  hop: number;
  parent: RelayParent | null;
  sender: RelaySender;
  /** The recipient's first fetch; null → never fetched. */
  fetchedAt: string | null;
  redaction: { at: string; length: number } | null;
  /** Set by the sweep's lapse (sweep.ts → isRelayLapsed). */
  lapsedAt: string | null;
}

/** One relay refusal record: who sent, whom it resolved to, why — the record holds no text. */
export interface RelayRefusalView {
  at: string;
  reason: string;
  senderIdPrefix: string;
  recipientIdPrefixes: string[];
  /** Recipient names that resolved to no single peer; null on a reason that resolves none. */
  unresolvedCount: number | null;
}

export interface RelaySignal {
  /** The last 24 hours: refusals, relays sent at hop 1 or 2, redactions. */
  count: { refused: number; forwarded: number; redacted: number };
  /** Any relay or relay refusal on record, of any age. */
  hasRecord: boolean;
}

/** How the owner's answer was made; its time is the item's `answeredAt`. */
export interface AnswerRecord {
  route: QueueAnswerRoute;
  signal: QueueAnswerSignal;
}

export interface OwnerItemView {
  id: number;
  kind: string;
  title: string;
  body: string;
  linkedDocIds: number[];
  options: Prisma.JsonValue;
  recommendedCode: string | null;
  isFreeTextAllowed: boolean;
  isApprovalClass: boolean;
  status: string;
  queuePosition: number;
  deferCount: number;
  nextAttempt: number;
  answer: { code: string | null; text: string | null };
  askedAt: string;
  answeredAt: string | null;
  deliveredAt: string | null;
  /** Shared by every copy of one owner send; null → not a send, or a message sent before send ids existed. */
  sendId: string | null;
  /** The owner's images on this order or report reply, in the order sent. */
  attachments: ImageView[];
  /** null → never answered, or answered with no record */
  answerRecord: AnswerRecord | null;
  /** Answered, yet no record → written outside the monitor (straight into the database). */
  isAnsweredOutside: boolean;
  session: OwnerSessionView;
  /** Newest first. */
  resumes: ResumeRecord[];
  deviation: Deviation | null;
  skipReason: SkipReason | null;
  canResend: boolean;
  /** null on every kind but a relay. */
  relay: RelayFacts | null;
}

/** A history page; the relay thread adds the refusal records of the page's time span. */
export interface OwnerOrdersPage {
  items: OwnerItemView[];
  nextCursor: string | null;
  refusals?: RelayRefusalView[];
  isRefusalListCut?: boolean;
}

/** Inputs of the Resend rule, shared by the views and the resend transition so page and server agree. */
export interface ResendFacts {
  kind: QueueItemKind;
  status: QueueItemStatus;
  nextAttempt: number;
  isSessionMarked: boolean;
  resumeAttempts: number[];
}

type ItemWithRelations = Prisma.QueueItemGetPayload<{ include: typeof ITEM_RELATIONS }>;

/** One copy of a paged order; `cursor` names its order and is the next page's `before` when it ends a page. */
interface OrderCopyRow {
  id: bigint;
  cursor: string;
}

interface RefusalRow {
  at: Date;
  reason: string;
  senderId: string;
  recipientIds: string[];
  unresolvedCount: number | null;
}

interface SessionFacts {
  sessionId: string;
  worktreeRoot: string | null;
  profileLabel: string;
  cwd: string;
  isMarked: boolean;
  isLiveOrStale: boolean;
  hasResumeInFlight: boolean;
  lastResumeBgId: string | null;
}

/** Resend: unacked · expired, or resume-pending once its attempt's automatic resume is used; never while marked, never a relay. */
export function canResend(facts: ResendFacts): boolean {
  if (facts.isSessionMarked || facts.kind === "relay") return false;
  if (facts.status === "unacked" || facts.status === "expired") return true;
  return facts.status === "resume_pending" && facts.resumeAttempts.includes(facts.nextAttempt);
}

export async function getOwnerItems(query: OwnerListQuery): Promise<{ items: OwnerItemView[]; nextCursor: number | null }> {
  const rows = await getPrisma().queueItem.findMany({
    where: {
      status: { notIn: TERMINAL },
      // the list draws every row as the owner's own item → a relay, another session's message, is read in the relay history only
      kind: { not: "relay" },
      ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
      session: { isProbe: false, ...(query.profile === undefined ? {} : { profileLabel: query.profile }) },
      ...(query.after === undefined ? {} : { queuePosition: { gt: BigInt(query.after) } }),
    },
    orderBy: { queuePosition: "asc" },
    take: query.limit + 1,
    include: ITEM_RELATIONS,
  });
  const page = rows.slice(0, query.limit);
  const items = await buildViews(page);
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > query.limit && last !== undefined ? Number(last.queuePosition) : null };
}

/**
 * A history thread, newest first, paged by order: the owner's orders (message items and reports carrying an owner reply)
 * or relays, in every status. Every copy of a paged order is on that page, the copies to sessions the filter
 * leaves out included. Items come order by order, the copies of one order in id order.
 */
export async function getOwnerOrders(query: OwnerOrdersQuery): Promise<OwnerOrdersPage> {
  const rows = await getOrderCopyRows(query);
  const cursors = [...new Set(rows.map((row) => row.cursor))];
  const paged = new Set(cursors.slice(0, query.limit));
  const pageRows = rows.filter((row) => paged.has(row.cursor));
  const found = await getPrisma().queueItem.findMany({ where: { id: { in: pageRows.map((row) => row.id) } }, include: ITEM_RELATIONS });
  const itemById = new Map(found.map((item) => [item.id, item]));
  const items = await buildViews(pageRows.flatMap((row) => itemById.get(row.id) ?? []));
  const nextCursor = cursors.length > query.limit ? (cursors[query.limit - 1] ?? null) : null;
  if (query.kind === "order") return { items, nextCursor };
  return { items, nextCursor, ...(await getRefusalPage(query, nextCursor)) };
}

/**
 * Newest resume Delivery rows across every item, terminal ones included → a resume stays visible after its item is delivered.
 * Id order = claim order: a resume row's sent time is set by the claim that inserts it.
 */
export async function getRecentResumes(query: RecentResumesQuery): Promise<{ resumes: RecentResume[] }> {
  const rows = await getPrisma().queueDelivery.findMany({
    where: { route: "resume" },
    orderBy: { id: "desc" },
    take: query.limit,
    include: { item: { select: { id: true, title: true, session: { select: { profileLabel: true, cwd: true } } } } },
  });
  return {
    resumes: rows.map(({ item, ...delivery }) => ({
      ...toResumeRecord(delivery),
      item: { id: Number(item.id), title: item.title },
      session: { profileLabel: item.session.profileLabel, cwdTail: getCwdTail(item.session.cwd) },
    })),
  };
}

/**
 * The relay signal the page raises: the last 24 hours' relay refusals the relay module decided (only those rows carry a
 * reason), relays sent at hop 1 or more, and redactions, each counted; plus whether any relay or refusal is on record.
 */
export async function getRelaySignal(): Promise<RelaySignal> {
  const since = new Date(Date.now() - RELAY_SIGNAL_WINDOW_MS);
  const [row] = await getPrisma().$queryRaw<Array<RelaySignal["count"] & { hasRecord: boolean }>>`
    SELECT
      (SELECT count(*)::int FROM "monitor"."audit_log" a WHERE ${RELAY_REFUSAL_FILTER} AND a."event_ts" >= ${since}) AS "refused",
      (SELECT count(*)::int FROM "monitor"."queue_items" i WHERE i."kind"::text = 'relay' AND i."relay_hop" >= 1 AND i."asked_at" >= ${since}) AS "forwarded",
      (SELECT count(*)::int FROM "monitor"."queue_items" i WHERE i."relay_redacted_at" >= ${since}) AS "redacted",
      (EXISTS (SELECT 1 FROM "monitor"."queue_items" i WHERE i."kind"::text = 'relay')
        OR EXISTS (SELECT 1 FROM "monitor"."audit_log" a WHERE ${RELAY_REFUSAL_FILTER})) AS "hasRecord"`;
  return { count: { refused: row?.refused ?? 0, forwarded: row?.forwarded ?? 0, redacted: row?.redacted ?? 0 }, hasRecord: row?.hasRecord ?? false };
}

export async function getOwnerItemOrThrow(id: number): Promise<OwnerItemView> {
  const item = await getPrisma().queueItem.findUnique({ where: { id: BigInt(id) }, include: ITEM_RELATIONS });
  if (item === null) throw new QueueRequestError(404, "unknown_item", "item not found");
  const [view] = await buildViews([item]);
  if (view === undefined) throw new Error(`item ${id} view not built`);
  return view;
}

/**
 * The refusal records of a relay history page's time span: before the page's cursor, and from its last order's time
 * on unless it is the last page → each record lands on exactly one page. Either end in the session filter.
 */
async function getRefusalPage(query: OwnerOrdersQuery, nextCursor: string | null): Promise<Pick<OwnerOrdersPage, "refusals" | "isRefusalListCut">> {
  const at = getEpochMicrosSql(Prisma.sql`a."event_ts"`);
  const sinceAt = nextCursor === null ? null : BigInt(nextCursor.split(":")[0] ?? "");
  const rows = await getPrisma().$queryRaw<RefusalRow[]>`
    SELECT a."event_ts" AS "at", c ->> 'reason' AS "reason", c ->> 'senderId' AS "senderId",
      ARRAY(SELECT jsonb_array_elements_text(c -> 'recipientIds')) AS "recipientIds", (c ->> 'unresolvedCount')::int AS "unresolvedCount"
    FROM "monitor"."audit_log" a CROSS JOIN LATERAL (SELECT a."payload" -> 'change' AS c) change
    WHERE ${RELAY_REFUSAL_FILTER}
      AND ${query.before === undefined ? Prisma.sql`TRUE` : Prisma.sql`${at} < ${query.before.at}::bigint`}
      AND ${sinceAt === null ? Prisma.sql`TRUE` : Prisma.sql`${at} >= ${sinceAt}::bigint`}
      AND ${query.sessionIds === undefined ? Prisma.sql`TRUE` : Prisma.sql`(c ->> 'senderId' = ANY(${query.sessionIds}::text[])
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(c -> 'recipientIds') r WHERE r = ANY(${query.sessionIds}::text[])))`}
    ORDER BY a."event_ts" DESC, a."id" DESC LIMIT ${REFUSAL_PAGE_MAX + 1}`;
  return { refusals: rows.slice(0, REFUSAL_PAGE_MAX).map(toRefusalView), isRefusalListCut: rows.length > REFUSAL_PAGE_MAX };
}

function toRefusalView(row: RefusalRow): RelayRefusalView {
  return { at: row.at.toISOString(), reason: row.reason, senderIdPrefix: getSessionIdPrefix(row.senderId), recipientIdPrefixes: row.recipientIds.map(getSessionIdPrefix), unresolvedCount: row.unresolvedCount };
}

// The history threads: which items, the order time, and the fold key of an item with no send id
const HISTORY_THREADS = {
  order: {
    items: Prisma.sql`i."answered_at" IS NOT NULL AND (i."kind" = 'message' OR (i."kind" = 'report' AND i."answer_text" IS NOT NULL))`,
    time: Prisma.sql`i."answered_at"`,
    // a message sent before send ids: one transaction stamped its copies' answered_at and body alike
    unsentKey: Prisma.sql`CASE WHEN i."kind" = 'message' THEN concat('m:', t."at", ':', md5(i."body")) ELSE concat('i:', i."id") END`,
  },
  relay: {
    items: Prisma.sql`i."kind" = 'relay'`,
    time: Prisma.sql`i."asked_at"`,
    unsentKey: Prisma.sql`concat('i:', i."id")`,
  },
} as const satisfies Record<OwnerOrdersQuery["kind"], Record<"items" | "time" | "unsentKey", Prisma.Sql>>;

/**
 * Copies of the page's orders plus one order past it, newest order first.
 * Fold key: the send id, else the thread's key for an unsent item. Order time = its newest copy's thread time; ties
 * broken by its lowest copy id. The session filter matches either end: recipient, or a relay's sender.
 */
async function getOrderCopyRows(query: OwnerOrdersQuery): Promise<OrderCopyRow[]> {
  const thread = HISTORY_THREADS[query.kind];
  const sessionFilter =
    query.sessionIds === undefined
      ? Prisma.sql`TRUE`
      : Prisma.sql`bool_or(c."session_id" = ANY(${query.sessionIds}::uuid[]) OR c."from_session_id" = ANY(${query.sessionIds}::uuid[]))`;
  const cursorFilter =
    query.before === undefined ? Prisma.sql`TRUE` : Prisma.sql`(o."at", o."first_id") < (${query.before.at}::bigint, ${query.before.id}::bigint)`;
  return getPrisma().$queryRaw<OrderCopyRow[]>`
    WITH copies AS (
      SELECT i."id", i."session_id", i."from_session_id", t."at", COALESCE(i."send_id"::text, ${thread.unsentKey}) AS "order_key"
      FROM "monitor"."queue_items" i
      CROSS JOIN LATERAL (SELECT ${getEpochMicrosSql(thread.time)} AS "at") t
      WHERE ${thread.items}
    ),
    orders AS (
      SELECT c."order_key", max(c."at") AS "at", min(c."id") AS "first_id" FROM copies c GROUP BY c."order_key" HAVING ${sessionFilter}
    ),
    page AS (
      SELECT o.* FROM orders o WHERE ${cursorFilter} ORDER BY o."at" DESC, o."first_id" DESC LIMIT ${query.limit + 1}
    )
    SELECT c."id", concat(p."at", ':', p."first_id") AS "cursor"
    FROM page p JOIN copies c ON c."order_key" = p."order_key"
    ORDER BY p."at" DESC, p."first_id" DESC, c."id"`;
}

// The history cursor's time unit → one expression for order times and refusal times alike
function getEpochMicrosSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(extract(epoch FROM ${column}) * 1000000)::bigint`;
}

const ITEM_RELATIONS = {
  session: true,
  deliveries: { where: { route: "resume" }, orderBy: { id: "desc" } },
  images: ITEM_IMAGES_ARGS,
  fromSession: SENDER_ARGS,
  relayParent: { select: { id: true, askedAt: true, fromSession: SENDER_ARGS } },
} as const satisfies Prisma.QueueItemInclude;

async function buildViews(items: ItemWithRelations[]): Promise<OwnerItemView[]> {
  const factsById = await getSessionFacts(items);
  return items.map((item) => toView(item, factsById));
}

// One query for every session the page needs: the listed ones plus each one sharing a listed worktree root
async function getSessionFacts(items: ItemWithRelations[]): Promise<Map<string, SessionFacts>> {
  if (items.length === 0) return new Map();
  const sessionIds = [...new Set(items.map((item) => item.sessionId))];
  const roots = [...new Set(items.flatMap((item) => (item.session.worktreeRoot === null ? [] : [item.session.worktreeRoot])))];
  const rows = await getPrisma().$queryRaw<SessionFacts[]>`
    SELECT
      s."session_id"::text AS "sessionId",
      s."worktree_root" AS "worktreeRoot",
      s."profile_label" AS "profileLabel",
      s."cwd",
      s."resume_awaiting_register_at" IS NOT NULL AS "isMarked",
      s."state" IN ('live', 'stale') AS "isLiveOrStale",
      ${buildResumeInFlightSql(Prisma.sql`s."session_id"`)} AS "hasResumeInFlight",
      (
        SELECT d."bg_id" FROM "monitor"."queue_deliveries" d
        JOIN "monitor"."queue_items" i ON i."id" = d."item_id"
        WHERE i."session_id" = s."session_id" AND d."route" = 'resume'
        ORDER BY d."id" DESC LIMIT 1
      ) AS "lastResumeBgId"
    FROM "monitor"."queue_sessions" s
    WHERE s."session_id" = ANY(${sessionIds}::uuid[]) OR s."worktree_root" = ANY(${roots}::text[])`;
  return new Map(rows.map((row) => [row.sessionId, row]));
}

function toView(item: ItemWithRelations, factsById: Map<string, SessionFacts>): OwnerItemView {
  const resumes = item.deliveries.map(toResumeRecord);
  const isSessionMarked = item.session.resumeAwaitingRegisterAt !== null;
  return {
    id: Number(item.id),
    kind: item.kind,
    title: item.title,
    body: item.body,
    linkedDocIds: item.linkedDocIds.map(Number),
    options: item.options,
    recommendedCode: item.recommendedCode,
    isFreeTextAllowed: item.isFreeTextAllowed,
    isApprovalClass: item.isApprovalClass,
    status: item.status,
    queuePosition: Number(item.queuePosition),
    deferCount: item.deferCount,
    nextAttempt: item.nextAttempt,
    answer: { code: item.answerCode, text: item.answerText },
    askedAt: item.askedAt.toISOString(),
    answeredAt: item.answeredAt?.toISOString() ?? null,
    deliveredAt: item.deliveredAt?.toISOString() ?? null,
    sendId: item.sendId,
    attachments: getImageViews(item.images),
    ...getAnswerRecordView(item),
    session: toSessionView(item.session, factsById.get(item.sessionId)?.lastResumeBgId ?? null),
    resumes,
    deviation: item.kind === "relay" ? null : getDeviation(item.status),
    skipReason: item.status === "resume_pending" ? getSkipReason(item, factsById) : null,
    canResend: canResend({ kind: item.kind, status: item.status, nextAttempt: item.nextAttempt, isSessionMarked, resumeAttempts: resumes.map((resume) => resume.attempt) }),
    relay: getRelayFacts(item),
  };
}

// CHECK queue_items_relay_check: sender ⇔ hop ⇔ kind relay → either null means not a relay
function getRelayFacts(item: ItemWithRelations): RelayFacts | null {
  if (item.fromSession === null || item.relayHop === null) return null;
  const { relayRedactedAt: redactedAt, relayRedactedLength: redactedLength } = item;
  return {
    hop: item.relayHop,
    parent: getRelayParent(item.relayParent),
    sender: toRelaySender(item.fromSession),
    fetchedAt: item.relayFetchedAt?.toISOString() ?? null,
    redaction: redactedAt === null || redactedLength === null ? null : { at: redactedAt.toISOString(), length: redactedLength },
    lapsedAt: item.relayClosedAt?.toISOString() ?? null,
  };
}

// A parent is itself a relay → its sender is set (queue_items_relay_check)
function getRelayParent(parent: ItemWithRelations["relayParent"]): RelayParent | null {
  if (parent?.fromSession == null) return null;
  return { id: Number(parent.id), sender: toRelaySender(parent.fromSession), sentAt: parent.askedAt.toISOString() };
}

export function toRelaySender(session: RelaySenderRow): RelaySender {
  return { sessionIdPrefix: getSessionIdPrefix(session.sessionId), profileLabel: session.profileLabel, selfDeclaredName: session.name };
}

// CHECK queue_items_answer_record_check pairs the two columns → one null means both are
function getAnswerRecordView(item: QueueItem): Pick<OwnerItemView, "answerRecord" | "isAnsweredOutside"> {
  if (item.answerRoute !== null && item.answerSignal !== null) {
    return { answerRecord: { route: item.answerRoute, signal: item.answerSignal }, isAnsweredOutside: false };
  }
  return { answerRecord: null, isAnsweredOutside: ANSWERED_STATUSES.has(item.status) };
}

function toSessionView(session: QueueSession, lastResumeBgId: string | null): OwnerSessionView {
  const markedAt = session.resumeAwaitingRegisterAt;
  return {
    id: session.sessionId,
    sessionIdPrefix: getSessionIdPrefix(session.sessionId),
    ...getSessionName(session),
    profileLabel: session.profileLabel,
    cwd: session.cwd,
    cwdTail: getCwdTail(session.cwd),
    configDir: session.isConfigDirSet ? session.configDir : null,
    state: session.state,
    isWaiting: isSessionWaiting(session.sessionId),
    permissionHint: session.permissionHint,
    marker: markedAt === null ? null : { setAt: markedAt.toISOString(), bgId: lastResumeBgId },
  };
}

function toResumeRecord(delivery: QueueDelivery): ResumeRecord {
  return {
    sentAt: delivery.sentAt.toISOString(),
    attempt: delivery.attempt,
    result: delivery.result,
    abortReason: delivery.abortReason,
    bgId: delivery.bgId,
  };
}

function getDeviation(status: QueueItemStatus): Deviation | null {
  return DEVIATION_STATUSES.find((deviation) => deviation === status) ?? null;
}

function getSkipReason(item: ItemWithRelations, factsById: Map<string, SessionFacts>): SkipReason | null {
  if (item.session.resumeAwaitingRegisterAt !== null) return { kind: "marker" };
  if (item.deliveries.some((delivery) => delivery.attempt === item.nextAttempt)) return { kind: "resume_used" };
  const occupants = getOccupants(item.session, factsById);
  if (occupants.length > 0) {
    const marked = occupants.filter((occupant) => occupant.isMarked);
    return {
      kind: "shared_worktree",
      markedOccupants: marked.map(toMarkedOccupant),
      hasUnmarkedOccupant: marked.length < occupants.length,
    };
  }
  return factsById.get(item.sessionId)?.hasResumeInFlight ? { kind: "in_flight" } : null;
}

// Another row on an equal worktree root that is live, stale, marked, or has a resume in flight; no root → no sharing
function getOccupants(session: QueueSession, factsById: Map<string, SessionFacts>): SessionFacts[] {
  if (session.worktreeRoot === null) return [];
  return [...factsById.values()].filter(
    (facts) =>
      facts.sessionId !== session.sessionId &&
      facts.worktreeRoot === session.worktreeRoot &&
      (facts.isLiveOrStale || facts.isMarked || facts.hasResumeInFlight),
  );
}

function toMarkedOccupant(facts: SessionFacts): MarkedOccupant {
  return { profileLabel: facts.profileLabel, cwdTail: getCwdTail(facts.cwd), sessionIdPrefix: getSessionIdPrefix(facts.sessionId) };
}

export function getSessionName(session: { name: string | null; cwd: string }): SessionName {
  return { name: session.name ?? getCwdBasename(session.cwd), isNameRegistered: session.name !== null };
}

/** The short id every surface shows in place of a session's full id. */
export function getSessionIdPrefix(sessionId: string): string {
  return sessionId.slice(0, SESSION_ID_PREFIX_LENGTH);
}

export function getCwdTail(cwd: string): string {
  return getCwdSegments(cwd).slice(-2).join("/");
}

// cwd is an absolute realpath (queue_sessions_cwd_check) → "/" alone has no segment, shown as itself
function getCwdBasename(cwd: string): string {
  return getCwdSegments(cwd).at(-1) ?? cwd;
}

function getCwdSegments(cwd: string): string[] {
  return cwd.split("/").filter((segment) => segment !== "");
}
