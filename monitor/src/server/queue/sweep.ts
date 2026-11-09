// Database-driven sweep pass: the worktree root refresh, the stale / exited rule on live and stale rows, the automatic
// resume of exited sessions, overdue and exited-row item moves, then socket delivery of answered items.
// No delivery window lives in a process timer → a restart loses nothing.
// Every transaction touching items locks the registry row first (registry.ts lock order).

import { randomUUID } from "node:crypto";
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { Prisma, QueueItemKind, QueueItemStatus, QueueSessionState } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { errnoCode } from "../errno.js";
import { logger } from "../logger.js";
import { buildEnvelope, buildResumePayload } from "./envelope.js";
import { lockSession } from "./registry.js";
import { type ResumeClaim, claimResume, findClaimableSessionIds, getRereadOutcome, putSpawnAborted, putSpawnFailed, putWorktreeRoots } from "./resume-claim.js";
import { type ResumeDeps, SESSION_ID_SHAPE, startResumeSpawn } from "./resume-spawn.js";
import { type SocketConnector, buildFrames, getSessionToken, openSocket, writeFrames } from "./socket-channel.js";

const SWEEP = {
  BATCH_LIMIT: 200,
  // A busy session reads the frame between tool calls → a long call may pass this; a late ack still delivers
  SOCKET_ACK_WINDOW_MS: 10 * 60_000,
  // A hook writes the token file just before its register → an unknown id younger than this may be mid-register
  TOKEN_GRACE_MS: 10 * 60_000,
} as const;
const EXITED_MOVABLE: QueueItemStatus[] = ["answered", "unacked", "held", "expired"];

export interface SweepDeps {
  connector: SocketConnector;
  readStartTime: (pid: number) => Promise<string | null>;
  /** False while the format-drift guard has not passed a scan for the current Claude Code key (fail closed). */
  isSocketDeliveryOn: () => boolean;
  now: () => Date;
  /** Absolute queue CLI literal printed in every envelope — the one the settings allow rule names. */
  cliPath: string;
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
  socketPath: string | null;
  state: QueueSessionState;
}

interface SettleItem {
  id: bigint;
  status: QueueItemStatus;
  deliveries: Array<{ route: string; ackDeadlineAt: Date }>;
}

interface AnsweredItem {
  id: bigint;
  kind: QueueItemKind;
  nextAttempt: number;
  session: SessionProbeRow;
}

/** Resume claims run before the settle step → an item turned resume-pending in this pass resumes on the next one. */
export async function runSweepPass(deps: SweepDeps): Promise<void> {
  await putWorktreeRoots(getScopeWhere(deps));
  await putSessionStates(deps);
  await resumeExitedSessions(deps);
  await settleItems(deps);
  await deliverAnsweredItems(deps);
}

/** Removes token files of exited or unknown sessions once older than the grace period; other names stay, logged. */
export async function deleteOrphanTokenFiles(deps: SweepDeps): Promise<void> {
  const names = await getDirectoryNames(deps.tokenDir);
  const strayCount = names.filter((name) => !SESSION_ID_SHAPE.test(name)).length;
  if (strayCount > 0) logger.warn({ tokenDir: deps.tokenDir, strayCount }, "queue token dir holds non-session entries — left in place");
  const scoped = names.filter((name) => SESSION_ID_SHAPE.test(name) && (deps.scope?.sessionIds.includes(name) ?? true));
  const rows = await getPrisma().queueSession.findMany({ where: { sessionId: { in: scoped } }, select: { sessionId: true, state: true } });
  const stateById = new Map(rows.map((row) => [row.sessionId, row.state]));
  const orphans = scoped.filter((name) => (stateById.get(name) ?? "exited") === "exited");
  await Promise.all(orphans.map((name) => deleteIfOld(path.join(deps.tokenDir, name), deps.now())));
}

function getScopeWhere(deps: SweepDeps): { sessionId?: { in: string[] } } {
  return deps.scope === undefined ? {} : { sessionId: { in: deps.scope.sessionIds } };
}

async function putSessionStates(deps: SweepDeps): Promise<void> {
  const rows = await getPrisma().queueSession.findMany({
    where: { ...getScopeWhere(deps), state: { in: ["live", "stale"] } },
    select: { sessionId: true, pid: true, processStartTime: true, socketPath: true, state: true },
    // ponytail: unordered, 200 per pass → past 200 live/stale rows some go unprobed; add a lastProbedAt order if one machine ever runs that many
    take: SWEEP.BATCH_LIMIT,
  });
  await Promise.all(rows.map((row) => putProbedState(row, deps)));
}

// stale → probe again; live → a cheap start-time read, and a socket probe only once the process looks gone
async function putProbedState(row: SessionProbeRow, deps: SweepDeps): Promise<void> {
  if (row.state === "stale" && row.socketPath !== null) {
    const outcome = await probeSocket(row.socketPath, deps.connector);
    if (outcome === "open") await putSessionState(row, "live");
    if (outcome === "refused") await applyRefusedRule(row, deps);
    return;
  }
  if ((await deps.readStartTime(row.pid)) === row.processStartTime) return;
  const outcome = row.socketPath === null ? "refused" : await probeSocket(row.socketPath, deps.connector);
  if (outcome === "refused") await putSessionState(row, "exited");
}

async function probeSocket(socketPath: string, connector: SocketConnector): Promise<"open" | "refused" | "failed"> {
  const outcome = await openSocket(socketPath, connector);
  if (outcome.kind === "open") outcome.socket.destroy();
  if (outcome.kind === "failed") logger.warn({ err: outcome.error, socketPath }, "queue socket probe failed — row state unchanged");
  return outcome.kind;
}

// Refused alone is no proof of death (a full listen backlog refuses too) → the pid and its start time decide
async function applyRefusedRule(row: SessionProbeRow, deps: SweepDeps): Promise<void> {
  const startTime = await deps.readStartTime(row.pid);
  await putSessionState(row, startTime === row.processStartTime ? "stale" : "exited");
}

// Guarded on the read pid + state → a register that committed meanwhile wins
async function putSessionState(row: SessionProbeRow, state: QueueSessionState): Promise<void> {
  if (state === row.state) return;
  const data: Prisma.QueueSessionUpdateManyMutationInput =
    state === "exited" ? { state, exitReason: "dead" } : { state, exitReason: null, ...(state === "live" ? { lastSeenAt: new Date() } : {}) };
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
    where: { ...getScopeWhere(deps), OR: [{ status: "delivering" }, { status: { in: EXITED_MOVABLE }, session: { state: "exited" } }] },
    select: { sessionId: true },
    distinct: ["sessionId"],
    take: SWEEP.BATCH_LIMIT,
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
 * - delivering past its deadline → unacked, or resume-pending on an exited row (a resume row: its attempt is used)
 * - delivering before its deadline on an exited row → resume-pending, except the resume route (exempt until the deadline)
 * - answered · unacked · held · expired on an exited row → resume-pending
 */
function getSettledStatus(item: SettleItem, isExited: boolean, now: Date): QueueItemStatus | null {
  if (item.status !== "delivering") return isExited ? "resume_pending" : null;
  const latest = item.deliveries[0];
  if (latest === undefined || latest.ackDeadlineAt <= now) return isExited ? "resume_pending" : "unacked";
  return isExited && latest.route !== "resume" ? "resume_pending" : null;
}

async function deliverAnsweredItems(deps: SweepDeps): Promise<void> {
  if (!deps.isSocketDeliveryOn()) return;
  const items: AnsweredItem[] = await getPrisma().queueItem.findMany({
    where: { ...getScopeWhere(deps), status: "answered", session: { state: "live", socketPath: { not: null } } },
    orderBy: { queuePosition: "asc" },
    take: SWEEP.BATCH_LIMIT,
    select: { id: true, kind: true, nextAttempt: true, session: { select: { sessionId: true, pid: true, processStartTime: true, socketPath: true, state: true } } },
  });
  const refusedSessionIds = new Set<string>();
  for (const item of items) {
    if (refusedSessionIds.has(item.session.sessionId)) continue;
    if ((await deliverOverSocket(item, deps)) === "refused") refusedSessionIds.add(item.session.sessionId);
  }
}

// Connect (the send-time probe) → claim commit → write; a crash between commit and write ends in unacked by the deadline
async function deliverOverSocket(item: AnsweredItem, deps: SweepDeps): Promise<"sent" | "refused" | "skipped"> {
  const token = await getSessionToken(deps.tokenDir, item.session.sessionId);
  const outcome = await openSocket(item.session.socketPath ?? "", deps.connector);
  if (outcome.kind === "refused") {
    await applyRefusedRule(item.session, deps);
    return "refused";
  }
  if (outcome.kind === "failed") {
    logger.warn({ err: outcome.error, itemId: Number(item.id) }, "queue socket connect failed — item stays answered for the next sweep");
    return "skipped";
  }
  const msgId = await claimSocketDelivery(item, deps.now());
  if (msgId === null) {
    outcome.socket.destroy();
    return "skipped";
  }
  await writeClaimedFrame(outcome.socket, item, msgId, token, deps.cliPath);
  return "sent";
}

/** @returns the new Delivery row's msg id; null when the row is no longer this live process or another pass claimed first */
async function claimSocketDelivery(item: AnsweredItem, now: Date): Promise<string | null> {
  return getPrisma().$transaction(async (tx) => {
    const session = await lockSession(tx, item.session.sessionId);
    if (session?.state !== "live" || session.pid !== item.session.pid) return null;
    const moved = await tx.queueItem.updateMany({ where: { id: item.id, status: "answered" }, data: { status: "delivering" } });
    if (moved.count !== 1) return null;
    const msgId = randomUUID();
    const ackDeadlineAt = new Date(now.getTime() + SWEEP.SOCKET_ACK_WINDOW_MS);
    await tx.queueDelivery.create({ data: { msgId, itemId: item.id, route: "socket", attempt: item.nextAttempt, result: "sent", sentAt: now, ackDeadlineAt } });
    return msgId;
  });
}

async function writeClaimedFrame(socket: import("node:net").Socket, item: AnsweredItem, msgId: string, token: string | null, cliPath: string): Promise<void> {
  const content = buildEnvelope({ id: Number(item.id), kind: item.kind, msgId }, cliPath);
  try {
    await writeFrames(socket, buildFrames({ sessionId: item.session.sessionId, msgId, content }, token));
  } catch (error) {
    // the item stays delivering → its deadline moves it to unacked, the owner resends
    await getPrisma().queueDelivery.updateMany({ where: { msgId, result: "sent" }, data: { result: "dead_socket" } });
    logger.warn({ err: error, itemId: Number(item.id) }, "queue frame write failed after claim — delivery marked dead_socket");
  }
}

async function getDirectoryNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function deleteIfOld(filePath: string, now: Date): Promise<void> {
  try {
    if (now.getTime() - (await stat(filePath)).mtimeMs < SWEEP.TOKEN_GRACE_MS) return;
    await unlink(filePath);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}
