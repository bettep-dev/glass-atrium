// Owner-side reads: the queue list and item detail, each item carrying its session, resume record, deviation,
// sweep skip reason (Item states → Card precedence) and whether Resend is allowed.
// The skip reason is derived from stored rows at read time, by the same rules the sweep in sweep.ts / resume-claim.ts applies.

import {
  Prisma,
  type QueueAnswerRoute,
  type QueueAnswerSignal,
  type QueueDelivery,
  type QueueItem,
  type QueueItemStatus,
  type QueueSession,
} from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { ACKABLE, isSessionWaiting } from "./delivery.js";
import { QueueRequestError } from "./errors.js";
import { buildResumeInFlightSql } from "./resume-claim.js";
import type { OwnerListQuery, RecentResumesQuery } from "./schemas.js";

const TERMINAL: QueueItemStatus[] = ["delivered", "seen", "withdrawn"];
/** The item states the count route and the item views flag as deviations. */
export const DEVIATION_STATUSES = ["unacked", "held", "expired", "resume_pending"] as const satisfies readonly QueueItemStatus[];
// Every state an answer leads to; open, seen and withdrawn carry no answer → never "answered outside"
const ANSWERED_STATUSES = new Set<QueueItemStatus>([...ACKABLE, "delivered"]);
export const SESSION_ID_PREFIX_LENGTH = 8;

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
  | { kind: "approval" }
  | { kind: "resume_used" }
  | { kind: "shared_worktree"; markedOccupants: MarkedOccupant[]; hasUnmarkedOccupant: boolean }
  | { kind: "in_flight" };

export interface OwnerSessionView {
  id: string;
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
}

/** Inputs of the Resend rule, shared by the views and the resend transition so page and server agree. */
export interface ResendFacts {
  status: QueueItemStatus;
  nextAttempt: number;
  isSessionMarked: boolean;
  resumeAttempts: number[];
}

type ItemWithRelations = QueueItem & { session: QueueSession; deliveries: QueueDelivery[] };

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

/** Resend: unacked · expired, or resume-pending once its attempt's automatic resume is used; never while marked. */
export function canResend(facts: ResendFacts): boolean {
  if (facts.isSessionMarked) return false;
  if (facts.status === "unacked" || facts.status === "expired") return true;
  return facts.status === "resume_pending" && facts.resumeAttempts.includes(facts.nextAttempt);
}

export async function getOwnerItems(query: OwnerListQuery): Promise<{ items: OwnerItemView[]; nextCursor: number | null }> {
  const rows = await getPrisma().queueItem.findMany({
    where: {
      status: { notIn: TERMINAL },
      ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
      ...(query.profile === undefined ? {} : { session: { profileLabel: query.profile } }),
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

export async function getOwnerItemOrThrow(id: number): Promise<OwnerItemView> {
  const item = await getPrisma().queueItem.findUnique({ where: { id: BigInt(id) }, include: ITEM_RELATIONS });
  if (item === null) throw new QueueRequestError(404, "unknown_item", "item not found");
  const [view] = await buildViews([item]);
  if (view === undefined) throw new Error(`item ${id} view not built`);
  return view;
}

const ITEM_RELATIONS = {
  session: true,
  deliveries: { where: { route: "resume" }, orderBy: { id: "desc" } },
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
    ...getAnswerRecordView(item),
    session: toSessionView(item.session, factsById.get(item.sessionId)?.lastResumeBgId ?? null),
    resumes,
    deviation: getDeviation(item.status),
    skipReason: item.status === "resume_pending" ? getSkipReason(item, factsById) : null,
    canResend: canResend({ status: item.status, nextAttempt: item.nextAttempt, isSessionMarked, resumeAttempts: resumes.map((resume) => resume.attempt) }),
  };
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
  if (item.isApprovalClass) return { kind: "approval" };
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
  return { profileLabel: facts.profileLabel, cwdTail: getCwdTail(facts.cwd), sessionIdPrefix: facts.sessionId.slice(0, SESSION_ID_PREFIX_LENGTH) };
}

export function getCwdTail(cwd: string): string {
  return getCwdSegments(cwd).slice(-2).join("/");
}

// cwd is an absolute realpath (queue_sessions_cwd_check) → "/" alone has no segment, shown as itself
export function getCwdBasename(cwd: string): string {
  return getCwdSegments(cwd).at(-1) ?? cwd;
}

function getCwdSegments(cwd: string): string[] {
  return cwd.split("/").filter((segment) => segment !== "");
}
