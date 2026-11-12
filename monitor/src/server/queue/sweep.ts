// Database-driven sweep pass: the worktree root refresh, the stale / exited rule on live and stale rows, the automatic
// resume of exited sessions, then overdue and exited-row item moves. An answered item waits for its session's pull.
// No delivery window lives in a process timer → a restart loses nothing.
// Every transaction touching items locks the registry row first (registry.ts lock order).

import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

import type { Prisma, QueueItemStatus, QueueSessionState } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { errnoCode } from "../errno.js";
import { logger } from "../logger.js";
import { buildResumePayload } from "./envelope.js";
import { lockSession } from "./registry.js";
import { type ResumeClaim, claimResume, findClaimableSessionIds, getRereadOutcome, putSpawnAborted, putSpawnFailed, putWorktreeRoots } from "./resume-claim.js";
import { type ResumeDeps, SESSION_ID_SHAPE, startResumeSpawn } from "./resume-spawn.js";

const BATCH_LIMIT = 200;
const EXITED_MOVABLE: QueueItemStatus[] = ["answered", "unacked", "held", "expired"];
// Waiting on an ack deadline: a claim in flight, or a socket-era held receipt nothing else moves on a live row
const ACK_WAITING: QueueItemStatus[] = ["delivering", "held"];

export interface SweepDeps {
  readStartTime: (pid: number) => Promise<string | null>;
  now: () => Date;
  /** Absolute queue CLI literal printed in every resume envelope — the one the settings allow rule names. */
  cliPath: string;
  /** Socket-era messaging token copies, drained every pass. */
  tokenDir: string;
  /** Limits the pass to these sessions (isolation on a shared test database); absent → every session. */
  scope?: { sessionIds: string[] };
  /** Absent → no automatic resume (no `claude` found at start). */
  resume?: ResumeDeps;
}

interface SessionProbeRow {
  sessionId: string;
  pid: number;
  processStartTime: string;
  state: QueueSessionState;
}

interface SettleItem {
  id: bigint;
  status: QueueItemStatus;
  deliveries: Array<{ route: string; ackDeadlineAt: Date }>;
}

/** Resume claims run before the settle step → an item turned resume-pending in this pass resumes on the next one. */
export async function runSweepPass(deps: SweepDeps): Promise<void> {
  await putWorktreeRoots(getScopeWhere(deps));
  await putSessionStates(deps);
  await resumeExitedSessions(deps);
  await settleItems(deps);
}

/** Removes every session token file (nothing reads them any more), contents never read; other names stay, logged. */
export async function deleteTokenFiles(deps: SweepDeps): Promise<void> {
  const names = await getDirectoryNames(deps.tokenDir);
  const strayCount = names.filter((name) => !SESSION_ID_SHAPE.test(name)).length;
  if (strayCount > 0) logger.warn({ tokenDir: deps.tokenDir, strayCount }, "queue token dir holds non-session entries — left in place");
  const scoped = names.filter((name) => SESSION_ID_SHAPE.test(name) && (deps.scope?.sessionIds.includes(name) ?? true));
  await Promise.all(scoped.map((name) => deleteFile(path.join(deps.tokenDir, name))));
}

function getScopeWhere(deps: SweepDeps): { sessionId?: { in: string[] } } {
  return deps.scope === undefined ? {} : { sessionId: { in: deps.scope.sessionIds } };
}

async function putSessionStates(deps: SweepDeps): Promise<void> {
  const rows = await getPrisma().queueSession.findMany({
    where: { ...getScopeWhere(deps), state: { in: ["live", "stale"] } },
    select: { sessionId: true, pid: true, processStartTime: true, state: true },
    // ponytail: unordered, 200 per pass → past 200 live/stale rows some go unprobed; add a lastProbedAt order if one machine ever runs that many
    take: BATCH_LIMIT,
  });
  await Promise.all(rows.map((row) => putProbedState(row, deps)));
}

// The start time alone decides: a match is the same process (a stale row returns to live), a mismatch or no process ends it
async function putProbedState(row: SessionProbeRow, deps: SweepDeps): Promise<void> {
  const isSameProcess = (await deps.readStartTime(row.pid)) === row.processStartTime;
  await putSessionState(row, isSameProcess ? "live" : "exited");
}

// Guarded on the read pid + state → a register that committed meanwhile wins
async function putSessionState(row: SessionProbeRow, state: "live" | "exited"): Promise<void> {
  if (state === row.state) return;
  const data: Prisma.QueueSessionUpdateManyMutationInput = state === "exited" ? { state, exitReason: "dead" } : { state, exitReason: null, lastSeenAt: new Date() };
  await getPrisma().queueSession.updateMany({ where: { sessionId: row.sessionId, pid: row.pid, state: row.state }, data });
}

async function resumeExitedSessions(deps: SweepDeps): Promise<void> {
  const resume = deps.resume;
  if (resume === undefined) return;
  for (const sessionId of await findClaimableSessionIds(deps.scope)) {
    // a claim that lost a race rolls back and spawns nothing; the next pass re-checks the session
    await resumeSession(sessionId, resume, deps).catch((error: unknown) => logger.warn({ err: error, sessionId }, "queue resume claim rolled back — no spawn"));
  }
}

// One spawn per session; the pre-spawn re-read stops it when the session returned or the worktree gained an occupant
async function resumeSession(sessionId: string, resume: ResumeDeps, deps: SweepDeps): Promise<void> {
  const claim = await claimResume(sessionId, deps.now(), resume.hooks);
  if (claim === null) return;
  await resume.hooks?.beforeReread?.();
  const outcome = await getRereadOutcome(claim);
  if (outcome !== "spawn") {
    await putSpawnAborted(claim, outcome);
    return;
  }
  await spawnClaimed(claim, resume, deps);
}

async function spawnClaimed(claim: ResumeClaim, resume: ResumeDeps, deps: SweepDeps): Promise<void> {
  const isStarted = await startResumeSpawn(claim, buildResumePayload(claim.items, deps.cliPath), resume, deps.now);
  if (!isStarted) await putSpawnFailed(claim);
}

async function settleItems(deps: SweepDeps): Promise<void> {
  const candidates = await getPrisma().queueItem.findMany({
    where: { ...getScopeWhere(deps), OR: [{ status: { in: ACK_WAITING } }, { status: { in: EXITED_MOVABLE }, session: { state: "exited" } }] },
    select: { sessionId: true },
    distinct: ["sessionId"],
    take: BATCH_LIMIT,
  });
  for (const { sessionId } of candidates) await settleSessionItems(sessionId, deps.now());
}

async function settleSessionItems(sessionId: string, now: Date): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    const session = await lockSession(tx, sessionId);
    if (session === null) return;
    const items: SettleItem[] = await tx.queueItem.findMany({
      where: { sessionId, status: { in: ["delivering", ...EXITED_MOVABLE] } },
      select: { id: true, status: true, deliveries: { orderBy: { id: "desc" }, take: 1, select: { route: true, ackDeadlineAt: true } } },
    });
    for (const item of items) {
      const target = getSettledStatus(item, session.state === "exited", now);
      if (target !== null) await tx.queueItem.updateMany({ where: { id: item.id, status: item.status }, data: { status: target } });
    }
  });
}

/**
 * - delivering or held past its latest deadline on a live or stale row → unacked (Resend open, a late ack still delivers)
 * - delivering on an exited row → resume-pending, except a resume delivery before its deadline (its attempt is in flight)
 * - answered · unacked · held · expired on an exited row → resume-pending
 */
function getSettledStatus(item: SettleItem, isExited: boolean, now: Date): QueueItemStatus | null {
  const latest = item.deliveries[0];
  const isPastDeadline = latest === undefined || latest.ackDeadlineAt <= now;
  if (isExited) return item.status === "delivering" && !isPastDeadline && latest?.route === "resume" ? null : "resume_pending";
  return ACK_WAITING.includes(item.status) && isPastDeadline ? "unacked" : null;
}

async function getDirectoryNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function deleteFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}
