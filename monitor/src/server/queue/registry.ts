// Session registry writes: register (live + replaced rule + marker clear) and deregister (exited + pid-gated marker clear).
// Lock order shared with every queue transaction: registry rows (ascending session id) before any item row.

import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { Prisma, QueuePermissionHint } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { errnoCode } from "../errno.js";
import { QueueEnvironmentError, QueueRequestError } from "./errors.js";
import { getProcessStartTime } from "./process-start-time.js";
import type { DeregisterBody, PERMISSION_HINTS, RegisterBody } from "./schemas.js";

const DEFAULT_PROFILE_LABEL = "default";
// $HOME/.claude or $HOME/.claude-<name>; the label column is varchar(64)
const CONFIG_DIR_NAME = /^\.claude(-[A-Za-z0-9._-]{1,56})?$/;
const CONFINED_SOCKET_PATH = /^(?:\/private)?\/tmp\/cc-socks\/([1-9][0-9]{0,9})\.sock$/;

const PERMISSION_HINT_COLUMN: Record<(typeof PERMISSION_HINTS)[number], QueuePermissionHint> = {
  default: "default",
  acceptEdits: "accept_edits",
  auto: "auto",
  bypassPermissions: "bypass_permissions",
  dontAsk: "dont_ask",
  plan: "plan",
};

export interface LockedSession {
  pid: number;
  state: string;
}

interface SessionFacts {
  cwd: string;
  worktreeRoot: string | null;
  configDir: string | null;
  processStartTime: string;
}

/** pid + `ps` start time: together they name one process across pid reuse. */
interface ProcessIdentity {
  pid: number;
  startTime: string;
}

/** Locks one registry row for the transaction; null when the session id is unknown. */
export async function lockSession(tx: Prisma.TransactionClient, sessionId: string): Promise<LockedSession | null> {
  const rows = await tx.$queryRaw<LockedSession[]>`
    SELECT "pid", "state"::text AS "state" FROM "monitor"."queue_sessions" WHERE "session_id" = ${sessionId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/** Nearest directory (the cwd itself or an ancestor) holding a `.git` entry; null outside every worktree. */
export async function findWorktreeRoot(cwd: string): Promise<string | null> {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (await hasGitEntry(dir)) return dir;
    if (dir === path.dirname(dir)) return null;
  }
}

/**
 * Registers a session live: marks a same-process row under another id replaced, clears the session marker
 * and returns the session's resume-pending items to answered.
 * @returns the count of answered items now waiting for this session (the SessionStart pointer line)
 */
export async function registerSession(body: RegisterBody, homeDir: string): Promise<{ answeredWaiting: number }> {
  const facts = await getSessionFactsOrThrow(body, homeDir);
  const identity: ProcessIdentity = { pid: body.pid, startTime: facts.processStartTime };
  return getPrisma().$transaction(async (tx) => {
    const replacedIds = await findReplacedSessionIds(tx, body.sessionId, identity);
    await lockSessions(tx, [body.sessionId, ...replacedIds]);
    await putLiveSession(tx, body, facts);
    await markReplaced(tx, replacedIds, identity);
    await tx.queueItem.updateMany({ where: { sessionId: body.sessionId, status: "resume_pending" }, data: { status: "answered" } });
    return { answeredWaiting: await tx.queueItem.count({ where: { sessionId: body.sessionId, status: "answered" } }) };
  });
}

/**
 * Deregisters a session (SessionEnd). Only a pid other than the stored one clears the session marker:
 * under the marker the row still stores the old, dead process's pid.
 */
export async function deregisterSession(body: DeregisterBody): Promise<void> {
  const callerPid = getDeregisterPid(body);
  await getPrisma().$transaction(async (tx) => {
    const session = await lockSession(tx, body.sessionId);
    if (session === null) throw new QueueRequestError(404, "unknown_session", "session not registered");
    const data = buildDeregisterUpdate(session, callerPid);
    if (Object.keys(data).length > 0) await tx.queueSession.update({ where: { sessionId: body.sessionId }, data });
  });
}

/**
 * - another process's pid → marker cleared; on a live or stale row the state stays (that process's end proves nothing here)
 * - stored pid or no pid → a live or stale row ends; an exited row keeps its reason
 */
function buildDeregisterUpdate(session: LockedSession, callerPid: number | null): Prisma.QueueSessionUpdateInput {
  const isOtherProcess = callerPid !== null && callerPid !== session.pid;
  if (isOtherProcess) return { resumeAwaitingRegisterAt: null };
  if (session.state === "exited") return {};
  return { state: "exited", exitReason: "ended" };
}

function getDeregisterPid(body: DeregisterBody): number | null {
  if (body.pid !== undefined) return body.pid;
  if (body.socketPath === undefined) return null;
  const match = CONFINED_SOCKET_PATH.exec(body.socketPath);
  if (match === null) throw new QueueRequestError(400, "invalid_socket_path", "socket path is not a cc-socks/<pid>.sock path");
  return Number(match[1]);
}

async function getSessionFactsOrThrow(body: RegisterBody, homeDir: string): Promise<SessionFacts> {
  if (body.socketPath !== undefined && !isConfinedSocketPath(body.socketPath, body.pid)) {
    throw new QueueRequestError(400, "invalid_socket_path", "socket path must be cc-socks/<registered pid>.sock under /tmp");
  }
  const cwd = await getExistingDirectoryOrThrow(body.cwd, "cwd");
  const [worktreeRoot, configDir, processStartTime] = await Promise.all([
    findWorktreeRoot(cwd),
    body.configDir === undefined ? null : getConfigDirOrThrow(body.configDir, homeDir),
    getProcessStartTime(body.pid),
  ]);
  if (processStartTime === null) throw new QueueRequestError(400, "invalid_pid", "pid names no running process");
  return { cwd, worktreeRoot, configDir, processStartTime };
}

function isConfinedSocketPath(socketPath: string, pid: number): boolean {
  return CONFINED_SOCKET_PATH.exec(socketPath)?.[1] === String(pid);
}

async function getConfigDirOrThrow(configDir: string, homeDir: string): Promise<string> {
  const [resolved, home] = await Promise.all([getExistingDirectoryOrThrow(configDir, "configDir"), getRealHomeOrThrow(homeDir)]);
  if (path.dirname(resolved) !== home || !CONFIG_DIR_NAME.test(path.basename(resolved))) {
    throw new QueueRequestError(400, "invalid_config_dir", "config dir must resolve to $HOME/.claude or $HOME/.claude-<name>");
  }
  return resolved;
}

async function getRealHomeOrThrow(homeDir: string): Promise<string> {
  try {
    return await realpath(homeDir);
  } catch (error) {
    throw new QueueEnvironmentError("home dir resolve failed", { cause: error });
  }
}

async function getExistingDirectoryOrThrow(candidate: string, field: string): Promise<string> {
  try {
    const resolved = await realpath(candidate);
    if ((await stat(resolved)).isDirectory()) return resolved;
  } catch (error) {
    if (!isMissingPath(error)) throw new QueueEnvironmentError(`${field} resolve failed`, { cause: error });
  }
  throw new QueueRequestError(400, `invalid_${field}`, `${field} must be an existing directory`);
}

async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    await lstat(path.join(dir, ".git"));
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw new QueueEnvironmentError("worktree root lookup failed", { cause: error });
  }
}

function isMissingPath(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

async function findReplacedSessionIds(tx: Prisma.TransactionClient, sessionId: string, identity: ProcessIdentity): Promise<string[]> {
  const rows = await tx.queueSession.findMany({
    where: { pid: identity.pid, processStartTime: identity.startTime, sessionId: { not: sessionId }, state: { not: "exited" } },
    select: { sessionId: true },
  });
  return rows.map((row) => row.sessionId);
}

async function lockSessions(tx: Prisma.TransactionClient, sessionIds: string[]): Promise<void> {
  await tx.$queryRaw`
    SELECT "session_id" FROM "monitor"."queue_sessions"
    WHERE "session_id" = ANY(${sessionIds}::uuid[]) ORDER BY "session_id" FOR UPDATE`;
}

async function putLiveSession(tx: Prisma.TransactionClient, body: RegisterBody, facts: SessionFacts): Promise<void> {
  const row = {
    isConfigDirSet: facts.configDir !== null,
    configDir: facts.configDir,
    profileLabel: facts.configDir === null ? DEFAULT_PROFILE_LABEL : path.basename(facts.configDir),
    cwd: facts.cwd,
    worktreeRoot: facts.worktreeRoot,
    pid: body.pid,
    processStartTime: facts.processStartTime,
    socketPath: body.socketPath ?? null,
    permissionHint: body.permissionHint === undefined ? null : PERMISSION_HINT_COLUMN[body.permissionHint],
    launchHint: body.launchHint ?? null,
    state: "live" as const,
    exitReason: null,
    lastSeenAt: new Date(),
    resumeAwaitingRegisterAt: null,
  };
  await tx.queueSession.upsert({ where: { sessionId: body.sessionId }, create: { sessionId: body.sessionId, ...row }, update: row });
}

// Re-checked under the lock: the pre-lock read may be stale
async function markReplaced(tx: Prisma.TransactionClient, sessionIds: string[], identity: ProcessIdentity): Promise<void> {
  if (sessionIds.length === 0) return;
  await tx.queueSession.updateMany({
    where: { sessionId: { in: sessionIds }, pid: identity.pid, processStartTime: identity.startTime, state: { not: "exited" } },
    data: { state: "exited", exitReason: "replaced" },
  });
}
