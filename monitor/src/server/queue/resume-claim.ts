// Automatic resume claim: one READ COMMITTED transaction per exited session that moves every eligible
// resume-pending item into one spawn and sets the session marker, plus the pre-spawn re-read and its guarded aborts.
// Lock order: the per-worktree advisory lock, then the registry row, then item rows (registry.ts lock order).

import { randomUUID } from "node:crypto";

import { Prisma, type QueueDeliveryAbortReason, type QueueItemKind } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { logger } from "../logger.js";
import type { EnvelopeItem } from "./envelope.js";
import { findWorktreeRoot, lockSession } from "./registry.js";

const RESUME = {
  // A resume boots a whole session before its first tool call → a wider window than the socket route
  ACK_WINDOW_MS: 30 * 60_000,
  BATCH_LIMIT: 200,
  // A waiting claim queues on the worktree lock inside its transaction → above the 5 s interactive default
  TX_TIMEOUT_MS: 15_000,
  LOCK_KEY_PREFIX: "atrium-queue-worktree:",
} as const;

/** One spawn's worth of claimed items; `markedAt` guards every later marker clear to this claim's own marker. */
export interface ResumeClaim {
  sessionId: string;
  cwd: string;
  configDir: string | null;
  markedAt: Date;
  items: EnvelopeItem[];
}

/** Test seam: runs inside the claim transaction after its writes, before the commit. */
export interface ClaimHooks {
  afterClaimRead?: () => Promise<void>;
}

export type RereadOutcome = "spawn" | QueueDeliveryAbortReason;

interface ResumeCandidate {
  id: bigint;
  kind: QueueItemKind;
  nextAttempt: number;
}

type RawReader = Pick<Prisma.TransactionClient, "$queryRaw">;

// An item of the session in delivering whose newest Delivery row took the resume route
const inFlightOf = (sessionIdColumn: Prisma.Sql): Prisma.Sql => Prisma.sql`EXISTS (
  SELECT 1 FROM "monitor"."queue_items" i
  WHERE i."session_id" = ${sessionIdColumn} AND i."status" = 'delivering'
    AND (SELECT d."route"::text FROM "monitor"."queue_deliveries" d WHERE d."item_id" = i."id" ORDER BY d."id" DESC LIMIT 1) = 'resume')`;

/**
 * Root refresh at the start of a pass for every row the occupancy test can count (live, stale, marked, resume in
 * flight). Each is its own single-row update with no worktree lock → no new lock-order edge.
 */
export async function refreshWorktreeRoots(scopeWhere: { sessionId?: { in: string[] } }): Promise<void> {
  const rows = await getPrisma().queueSession.findMany({
    where: {
      ...scopeWhere,
      OR: [
        { state: { in: ["live", "stale"] } },
        { resumeAwaitingRegisterAt: { not: null } },
        { items: { some: { status: "delivering", deliveries: { some: { route: "resume" } } } } },
      ],
    },
    select: { sessionId: true, cwd: true, worktreeRoot: true },
    take: RESUME.BATCH_LIMIT,
  });
  const results = await Promise.allSettled(rows.map((row) => putWorktreeRoot(row)));
  for (const result of results) if (result.status === "rejected") logger.warn({ err: result.reason }, "queue worktree root refresh failed — root kept until the next pass");
}

/**
 * Claims every eligible resume-pending item of one exited session for one spawn; null when nothing is eligible.
 * Isolation pinned to READ COMMITTED, the worktree lock its own statement before the occupancy read → a claim that
 * waited on the lock reads the marker the previous claim committed.
 */
export async function claimResume(sessionId: string, now: Date, hooks: ClaimHooks = {}): Promise<ResumeClaim | null> {
  const target = await getPrisma().queueSession.findUnique({ where: { sessionId }, select: { cwd: true, configDir: true, isConfigDirSet: true } });
  if (target === null) return null;
  const root = await findWorktreeRoot(target.cwd);
  const configDir = target.isConfigDirSet ? target.configDir : null;
  return getPrisma().$transaction(
    async (tx) => {
      if (root !== null) await lockWorktree(tx, root);
      if ((await lockSession(tx, sessionId))?.state !== "exited") return null;
      await tx.queueSession.update({ where: { sessionId }, data: { worktreeRoot: root } });
      const items = await putClaimedItems(tx, sessionId, await findEligibleItems(tx, sessionId, root), now);
      await hooks.afterClaimRead?.();
      return items.length === 0 ? null : { sessionId, cwd: target.cwd, configDir, markedAt: now, items };
    },
    { isolationLevel: "ReadCommitted", timeout: RESUME.TX_TIMEOUT_MS },
  );
}

/** After the claim commits, right before the spawn: a returned session or a new worktree occupant stops it. */
export async function getRereadOutcome(claim: ResumeClaim): Promise<RereadOutcome> {
  const row = await getPrisma().queueSession.findUnique({ where: { sessionId: claim.sessionId }, select: { state: true, worktreeRoot: true } });
  if (row?.state !== "exited") return "session_returned";
  if (row.worktreeRoot !== null && (await isWorktreeOccupied(getPrisma(), claim.sessionId, row.worktreeRoot))) return "shared_worktree";
  return "spawn";
}

/**
 * - session returned → items back to answered (the next sweep delivers over the socket)
 * - shared worktree → items back to resume-pending; the aborted row uses the attempt (no re-claim loop)
 */
export async function putSpawnAborted(claim: ResumeClaim, reason: QueueDeliveryAbortReason): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    await lockSession(tx, claim.sessionId);
    await tx.queueItem.updateMany({
      where: { id: { in: claim.items.map((item) => BigInt(item.id)) }, status: "delivering" },
      data: { status: reason === "session_returned" ? "answered" : "resume_pending" },
    });
    await tx.queueDelivery.updateMany({ where: { msgId: { in: getMsgIds(claim) }, result: "sent" }, data: { result: "aborted", abortReason: reason } });
    await clearOwnMarker(tx, claim);
  });
}

/** No process started → the rows record the failure and the marker clears; the attempt stays used. */
export async function putSpawnFailed(claim: ResumeClaim): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    await lockSession(tx, claim.sessionId);
    await tx.queueDelivery.updateMany({ where: { msgId: { in: getMsgIds(claim) }, result: "sent" }, data: { result: "failed" } });
    await clearOwnMarker(tx, claim);
  });
}

/** The captured bg id onto every resume row of the spawn. */
export async function putBgId(claim: ResumeClaim, bgId: string): Promise<void> {
  await getPrisma().queueDelivery.updateMany({ where: { msgId: { in: getMsgIds(claim) }, route: "resume", bgId: null }, data: { bgId } });
}

// Guarded on the read cwd → a register that moved the row meanwhile keeps its own root
async function putWorktreeRoot(row: { sessionId: string; cwd: string; worktreeRoot: string | null }): Promise<void> {
  const root = await findWorktreeRoot(row.cwd);
  if (root === row.worktreeRoot) return;
  await getPrisma().queueSession.updateMany({ where: { sessionId: row.sessionId, cwd: row.cwd }, data: { worktreeRoot: root } });
}

async function lockWorktree(tx: Prisma.TransactionClient, root: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${RESUME.LOCK_KEY_PREFIX + root}, 0))`;
}

// Session-wide gates first (marker, resume in flight, occupied worktree), then the per-item ones
async function findEligibleItems(tx: Prisma.TransactionClient, sessionId: string, root: string | null): Promise<ResumeCandidate[]> {
  const session = await tx.queueSession.findUniqueOrThrow({ where: { sessionId }, select: { resumeAwaitingRegisterAt: true } });
  if (session.resumeAwaitingRegisterAt !== null || (await hasResumeInFlight(tx, sessionId))) return [];
  if (root !== null && (await isWorktreeOccupied(tx, sessionId, root))) return [];
  const items = await tx.queueItem.findMany({
    where: { sessionId, status: "resume_pending", isApprovalClass: false },
    orderBy: { queuePosition: "asc" },
    take: RESUME.BATCH_LIMIT,
    select: { id: true, kind: true, nextAttempt: true, deliveries: { where: { route: "resume" }, select: { attempt: true } } },
  });
  return items.filter((item) => !item.deliveries.some((delivery) => delivery.attempt === item.nextAttempt));
}

async function hasResumeInFlight(tx: Prisma.TransactionClient, sessionId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ isInFlight: boolean }>>`SELECT ${inFlightOf(Prisma.sql`${sessionId}::uuid`)} AS "isInFlight"`;
  return rows[0]?.isInFlight === true;
}

// Another row on the same root that is live, stale, marked, or has a resume in flight
async function isWorktreeOccupied(reader: RawReader, sessionId: string, root: string): Promise<boolean> {
  const rows = await reader.$queryRaw<Array<{ isOccupied: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "monitor"."queue_sessions" s
      WHERE s."session_id" <> ${sessionId}::uuid AND s."worktree_root" = ${root}
        AND (s."state" IN ('live', 'stale') OR s."resume_awaiting_register_at" IS NOT NULL OR ${inFlightOf(Prisma.sql`s."session_id"`)})
    ) AS "isOccupied"`;
  return rows[0]?.isOccupied === true;
}

// Guarded on status + attempt; one resume row per item and attempt (the partial unique index backs it)
async function putClaimedItems(tx: Prisma.TransactionClient, sessionId: string, items: ResumeCandidate[], now: Date): Promise<EnvelopeItem[]> {
  const claimed: EnvelopeItem[] = [];
  const ackDeadlineAt = new Date(now.getTime() + RESUME.ACK_WINDOW_MS);
  for (const item of items) {
    const moved = await tx.queueItem.updateMany({ where: { id: item.id, status: "resume_pending", nextAttempt: item.nextAttempt }, data: { status: "delivering" } });
    if (moved.count !== 1) continue;
    const msgId = randomUUID();
    await tx.queueDelivery.create({ data: { msgId, itemId: item.id, route: "resume", attempt: item.nextAttempt, result: "sent", sentAt: now, ackDeadlineAt } });
    claimed.push({ id: Number(item.id), kind: item.kind, msgId });
  }
  if (claimed.length > 0) await tx.queueSession.update({ where: { sessionId }, data: { resumeAwaitingRegisterAt: now } });
  return claimed;
}

async function clearOwnMarker(tx: Prisma.TransactionClient, claim: ResumeClaim): Promise<void> {
  await tx.queueSession.updateMany({ where: { sessionId: claim.sessionId, resumeAwaitingRegisterAt: claim.markedAt }, data: { resumeAwaitingRegisterAt: null } });
}

function getMsgIds(claim: ResumeClaim): string[] {
  return claim.items.map((item) => item.msgId);
}
