// Owner session list and owner message send. A message is one `message` item per target, inserted already answered,
// so the existing delivery (pull or wait claim, ack, deadline, Resend, automatic resume) carries it unchanged.

import { Prisma } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import type { PageOriginSignal } from "../request-guards.js";
import { ACKABLE, isSessionWaiting } from "./delivery.js";
import { QueueRequestError } from "./errors.js";
import { SESSION_ID_PREFIX_LENGTH, type SessionName, getCwdTail, getSessionName } from "./owner-views.js";
import { lockSessions } from "./registry.js";
import { ITEM_TITLE_MAX, type MessageBody, type OwnerSessionsQuery } from "./schemas.js";

const LIST_LIMIT = 200;

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
  /** A replaced row takes no message (the send route refuses it). */
  isSelectable: boolean;
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
}

/** Live and stale rows plus any row owning an item; live first, then newest activity; bounded. */
export async function getOwnerSessions(query: OwnerSessionsQuery): Promise<{ sessions: OwnerSessionRow[]; hasMore: boolean }> {
  const profileFilter = query.profile === undefined ? Prisma.sql`TRUE` : Prisma.sql`s."profile_label" = ${query.profile}`;
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
      count(i."id") FILTER (WHERE i."status"::text IN (${Prisma.join(ACKABLE)}))::int AS "inDelivery"
    FROM "monitor"."queue_sessions" s
    LEFT JOIN "monitor"."queue_items" i ON i."session_id" = s."session_id"
    WHERE ${profileFilter}
    GROUP BY s."session_id"
    HAVING s."state" IN ('live', 'stale') OR count(i."id") > 0
    ORDER BY (s."state" = 'live') DESC, "lastActivityAt" DESC, s."session_id"
    LIMIT ${LIST_LIMIT + 1}`;
  return { sessions: rows.slice(0, LIST_LIMIT).map(toSessionRow), hasMore: rows.length > LIST_LIMIT };
}

/**
 * All or nothing: locks every target's registry row (ascending id, before any item row), then inserts one
 * answered message per target, stamped with the send route and the page-origin signal.
 * @throws QueueRequestError 404 when an id names no session · 409 when a target was replaced
 */
export async function createMessages(body: MessageBody, signal: PageOriginSignal): Promise<{ items: CreatedMessage[] }> {
  const title = getMessageTitle(body.text);
  return getPrisma().$transaction(async (tx) => {
    const locked = await lockSessions(tx, body.sessionIds);
    if (locked.length !== body.sessionIds.length) throw new QueueRequestError(404, "unknown_session", "every target must be a registered session");
    if (!locked.every(isMessageTarget)) throw new QueueRequestError(409, "session_replaced", "a replaced session takes no message");
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
      })),
      select: { id: true, sessionId: true },
    });
    return { items: created.map((item) => ({ id: Number(item.id), sessionId: item.sessionId })) };
  });
}

function toSessionRow(row: SessionListRow): OwnerSessionRow {
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
    isSelectable: isMessageTarget(row),
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
