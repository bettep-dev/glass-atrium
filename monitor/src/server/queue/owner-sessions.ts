// Owner session list and owner message send. A message is one `message` item per target, inserted already answered,
// so the existing delivery (pull or wait claim, ack, deadline, Resend, automatic resume) carries it unchanged.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import { Prisma } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { errnoCode } from "../errno.js";
import type { PageOriginSignal } from "../request-guards.js";
import { ACKABLE, isSessionWaiting } from "./delivery.js";
import { QueueRequestError } from "./errors.js";
import { putItemImages } from "./images.js";
import { SESSION_ID_PREFIX_LENGTH, type SessionName, getCwdTail, getSessionName } from "./owner-views.js";
import { lockSessions } from "./registry.js";
import { ITEM_TITLE_MAX, type MessageBody, type OwnerSessionsQuery, SESSION_LIST_LIMIT } from "./schemas.js";

export interface OwnerSessionRow extends SessionName {
  id: string;
  sessionIdPrefix: string;
  profileLabel: string;
  cwd: string;
  cwdTail: string;
  state: string;
  exitReason: string | null;
  /** A wait poll arrived within the freshness window (delivery.ts → WAIT_FRESH_MS). */
  isWaiting: boolean;
  /** Newest of the last register / probe and the last item asked. */
  lastActivityAt: string;
  /** awaiting = open items; inDelivery = answered items not yet acked */
  count: { awaiting: number; inDelivery: number };
  /** Session marker: an automatic resume spawned and not yet registered. */
  markerSetAt: string | null;
  /** A replaced or probe row takes no message (the send route refuses it). */
  isSelectable: boolean;
  /** A probe row, or an item-less row whose transcript file does not exist yet; listed only with the include-hidden option. */
  isHidden: boolean;
}

/** The relay-facing projection of a session-list row: never the full session id (C17). */
export interface PeerSessionRow extends SessionName {
  sessionIdPrefix: string;
  profileLabel: string;
  cwdTail: string;
  state: string;
  isWaiting: boolean;
}

export interface CreatedMessage {
  id: number;
  sessionId: string;
}

interface SessionListRow {
  id: string;
  name: string | null;
  profileLabel: string;
  cwd: string;
  state: string;
  exitReason: string | null;
  markerSetAt: Date | null;
  lastActivityAt: Date;
  awaiting: number;
  inDelivery: number;
  itemCount: number;
  isProbe: boolean;
  transcriptPath: string | null;
}

interface ListedSessionRow extends SessionListRow {
  isHidden: boolean;
}

/** Live and stale rows plus any row owning an item; live first, then newest activity; bounded; hidden rows only on request. */
export async function getOwnerSessions(query: OwnerSessionsQuery): Promise<{ sessions: OwnerSessionRow[]; hasMore: boolean }> {
  const profileFilter = query.profile === undefined ? Prisma.sql`TRUE` : Prisma.sql`s."profile_label" = ${query.profile}`;
  const rows = await findSessionRows(profileFilter);
  const listed = rows.filter((row) => query.includeHidden || !row.isHidden);
  // ponytail: hidden rows still take window slots → a full window lists fewer; a paged read when the list outgrows it
  return { sessions: listed.slice(0, SESSION_LIST_LIMIT).map(toSessionRow), hasMore: rows.length > SESSION_LIST_LIMIT };
}

/**
 * The sessions a relay may reach: live, listed, never the caller — the session-list read with a narrower projection.
 * @throws QueueRequestError 404 when the caller names no registered session
 */
export async function getPeerSessions(callerId: string): Promise<{ peers: PeerSessionRow[] }> {
  const caller = await getPrisma().queueSession.findUnique({ where: { sessionId: callerId }, select: { sessionId: true } });
  if (caller === null) throw new QueueRequestError(404, "unknown_session", "session not registered");
  const rows = await findSessionRows(Prisma.sql`s."state" = 'live' AND s."session_id" <> ${callerId}::uuid`);
  return { peers: rows.filter((row) => !row.isHidden).slice(0, SESSION_LIST_LIMIT).map(toPeerRow) };
}

async function findSessionRows(filter: Prisma.Sql): Promise<ListedSessionRow[]> {
  const rows = await getPrisma().$queryRaw<SessionListRow[]>`
    SELECT
      s."session_id"::text AS "id",
      s."name",
      s."profile_label" AS "profileLabel",
      s."cwd",
      s."state"::text AS "state",
      s."exit_reason"::text AS "exitReason",
      s."resume_awaiting_register_at" AS "markerSetAt",
      GREATEST(s."last_seen_at", max(i."asked_at")) AS "lastActivityAt",
      count(i."id") FILTER (WHERE i."status" = 'open')::int AS "awaiting",
      count(i."id") FILTER (WHERE i."status"::text IN (${Prisma.join(ACKABLE)}))::int AS "inDelivery",
      count(i."id")::int AS "itemCount",
      s."is_probe" AS "isProbe",
      s."transcript_path" AS "transcriptPath"
    FROM "monitor"."queue_sessions" s
    LEFT JOIN "monitor"."queue_items" i ON i."session_id" = s."session_id"
    WHERE ${filter}
    GROUP BY s."session_id"
    HAVING s."state" IN ('live', 'stale') OR count(i."id") > 0
    ORDER BY (s."state" = 'live') DESC, "lastActivityAt" DESC, s."session_id"
    LIMIT ${SESSION_LIST_LIMIT + 1}`;
  return Promise.all(rows.map(async (row) => ({ ...row, isHidden: await isHiddenSession(row) })));
}

// Unused: no item yet and a stored transcript path naming no file; a row with no stored path stays listed
async function isHiddenSession(row: SessionListRow): Promise<boolean> {
  if (row.isProbe) return true;
  if (row.itemCount > 0 || row.transcriptPath === null) return false;
  return !(await hasFile(row.transcriptPath));
}

// Any error but a missing path → listed: hiding is the exception, never the failure mode
async function hasFile(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/**
 * All or nothing: locks every target's registry row (ascending id, before any item row), then inserts one
 * answered message per target, stamped with the send route, the page-origin signal and one send id shared by every copy;
 * every copy links the same images.
 * @throws QueueRequestError 404 when an id names no session · 409 when a target was replaced or an image cannot be taken
 */
export async function createMessages(body: MessageBody, signal: PageOriginSignal): Promise<{ sendId: string; items: CreatedMessage[] }> {
  const title = getMessageTitle(body.text);
  const sendId = randomUUID();
  return getPrisma().$transaction(async (tx) => {
    const locked = await lockSessions(tx, body.sessionIds);
    if (locked.length !== body.sessionIds.length) throw new QueueRequestError(404, "unknown_session", "every target must be a registered session");
    if (!locked.every(isMessageTarget)) throw new QueueRequestError(409, "session_replaced", "a replaced session takes no message");
    if (locked.some((row) => row.isProbe)) throw new QueueRequestError(409, "session_probe", "a probe session takes no message");
    const answeredAt = new Date();
    const created = await tx.queueItem.createManyAndReturn({
      data: body.sessionIds.map((sessionId) => ({
        kind: "message" as const,
        sessionId,
        title,
        body: body.text,
        isFreeTextAllowed: false,
        status: "answered" as const,
        answeredAt,
        answerRoute: "message" as const,
        answerSignal: signal,
        sendId,
      })),
      select: { id: true, sessionId: true },
    });
    await putItemImages(tx, created.map((item) => item.id), body.attachmentIds);
    return { sendId, items: created.map((item) => ({ id: Number(item.id), sessionId: item.sessionId })) };
  });
}

function toSessionRow(row: ListedSessionRow): OwnerSessionRow {
  return {
    id: row.id,
    sessionIdPrefix: row.id.slice(0, SESSION_ID_PREFIX_LENGTH),
    ...getSessionName(row),
    profileLabel: row.profileLabel,
    cwd: row.cwd,
    cwdTail: getCwdTail(row.cwd),
    state: row.state,
    exitReason: row.exitReason,
    isWaiting: isSessionWaiting(row.id),
    lastActivityAt: row.lastActivityAt.toISOString(),
    count: { awaiting: row.awaiting, inDelivery: row.inDelivery },
    markerSetAt: row.markerSetAt?.toISOString() ?? null,
    isSelectable: isMessageTarget(row) && !row.isProbe,
    isHidden: row.isHidden,
  };
}

function toPeerRow(row: ListedSessionRow): PeerSessionRow {
  return {
    sessionIdPrefix: row.id.slice(0, SESSION_ID_PREFIX_LENGTH),
    ...getSessionName(row),
    profileLabel: row.profileLabel,
    cwdTail: getCwdTail(row.cwd),
    state: row.state,
    isWaiting: isSessionWaiting(row.id),
  };
}

// replaced → its process registered again under another session id, which takes the message instead
function isMessageTarget(row: { exitReason: string | null }): boolean {
  return row.exitReason !== "replaced";
}

// The send schema guarantees a non-blank text → some line survives the trim; cut by code point, never mid-surrogate
function getMessageTitle(text: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? text.trim();
  return Array.from(firstLine).slice(0, ITEM_TITLE_MAX).join("");
}
