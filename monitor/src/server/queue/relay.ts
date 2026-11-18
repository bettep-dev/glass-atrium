// Session relay: one queue item per recipient that a session sends to its peers, delivered with no owner act.
// Every rule a relay must pass is decided here, never in a front end: sender, recipients, envelope token, secret scan,
// caps and hop. A refusal is a returned value, not a throw, so its caller records it before it answers.

import { randomUUID } from "node:crypto";

import type { Prisma } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import type { AuditTarget } from "../middleware/audit-log.js";
import { getComparableText, getStrippedText, hasEnvelopeToken } from "./envelope.js";
import { QueueRequestError } from "./errors.js";
import { assertLinkedDocsExist } from "./items.js";
import { type ListedSessionRow, createCopies, getPeerRows } from "./owner-sessions.js";
import { SESSION_ID_PREFIX_LENGTH, getSessionIdPrefix, getSessionName } from "./owner-views.js";
import { scanText } from "./relay-scan.js";
import { type LockedSessionRow, lockSessions } from "./registry.js";
import type { RelayBody } from "./schemas.js";

export const RELAY = {
  CAP_WINDOW_MS: 3_600_000,
  PER_SENDER: 10,
  PER_PAIR: 5,
  MACHINE: 30,
  HOP_WINDOW_MS: 24 * 3_600_000,
  /** The first hop refused. */
  HOP_LIMIT: 3,
  /** An undelivered relay on a row ended this long lapses (sweep.ts); a replaced row's lapses at once. */
  LAPSE_MS: 3 * 24 * 3_600_000,
  /** The longest id prefix a recipient may name: the id's first two groups → a probe never confirms a full id. */
  RECIPIENT_PREFIX_MAX: 13,
} as const;
// Every relay transaction takes it first → the machine-wide count and the insert never interleave across senders
const RELAY_LOCK_KEY = 771_113_403;

export type RelayRefusalReason =
  | "sender_probe"
  | "sender_not_live"
  | "self"
  | "recipient"
  | "recipient_ambiguous"
  | "token"
  | "secret"
  | "scan_unavailable"
  | "sender_cap"
  | "pair_cap"
  | "machine_cap"
  | "hop";

const REFUSAL: Record<RelayRefusalReason, { statusCode: number; message: string }> = {
  sender_probe: { statusCode: 409, message: "a probe session sends no relay" },
  sender_not_live: { statusCode: 409, message: "the sending session is not live — a replaced or ended id sends no relay" },
  self: { statusCode: 409, message: "a session relays to its peers, never to itself" },
  recipient: { statusCode: 404, message: "every recipient must name one live, listed peer by its id prefix or name" },
  recipient_ambiguous: { statusCode: 409, message: "a recipient names more than one peer — name it by its id prefix" },
  token: { statusCode: 400, message: "relay text may not carry an envelope header" },
  secret: { statusCode: 422, message: "relay text matches a credential pattern" },
  scan_unavailable: { statusCode: 503, message: "the secret scan could not run — relay refused" },
  sender_cap: { statusCode: 429, message: `a session sends at most ${RELAY.PER_SENDER} relay copies per rolling hour` },
  pair_cap: { statusCode: 429, message: `a session reaches one peer at most ${RELAY.PER_PAIR} times per rolling hour` },
  machine_cap: { statusCode: 429, message: `this Mac carries at most ${RELAY.MACHINE} relay copies per rolling hour` },
  hop: { statusCode: 409, message: "this relay would pass the hop bound — wait for the owner's next answer or message" },
};

/** A peer a name or prefix matched: never its full id. */
export interface RecipientCandidate {
  sessionIdPrefix: string;
  name: string;
}

export interface RelayRefusal {
  reason: RelayRefusalReason;
  /** Sessions the recipients resolved to before the refusal; none for a refusal decided on the sender alone. */
  recipientIds: string[];
  /** Recipient inputs that named no single session → recorded as a count, never as the caller's string. */
  unresolvedCount?: number;
  candidates?: RecipientCandidate[];
  /** The scanner's pattern code on a match; null when its reply named none. */
  pattern?: string | null;
}

export interface CreatedRelay {
  sendId: string;
  hop: number;
  copies: Array<{ id: number; sessionIdPrefix: string }>;
}

export type RelayOutcome = { relay: CreatedRelay } | { refusal: RelayRefusal };

interface SenderRow {
  id: string;
  name: string | null;
  cwd: string;
  state: string;
  isProbe: boolean;
}

/**
 * Sends one relay copy per recipient, all or nothing. The secret scan runs before any row lock.
 * @throws QueueRequestError 404 unknown_session · 400 unknown_linked_doc
 */
export async function createRelay(body: RelayBody, scannerPath: string): Promise<RelayOutcome> {
  const sender = await getSenderOrThrow(body.sessionId);
  if (sender.isProbe) return refuse("sender_probe");
  if (sender.state !== "live") return refuse("sender_not_live");
  const recipients = await resolveRecipients(sender, body.recipients);
  if ("refusal" in recipients) return recipients;
  if (hasEnvelopeToken(body.text)) return refuse("token", recipients.ids);
  // each form on its own line → a match never depends on the scanner's case handling
  const scan = await scanText(scannerPath, [body.text, getStrippedText(body.text), getComparableText(body.text)].join("\n"));
  if (scan.verdict === "match") return { refusal: { reason: "secret", recipientIds: recipients.ids, pattern: scan.pattern } };
  if (scan.verdict === "unavailable") return refuse("scan_unavailable", recipients.ids);
  return getPrisma().$transaction((tx) => insertRelay(tx, body, recipients.ids));
}

/**
 * Status and body a refusal answers with — the reason code, its fixed message, never any caller text — and its audit
 * record: sender, resolved recipients, reason and the unresolved count, never the text.
 */
export function getRefusalResponse(senderId: string, refusal: RelayRefusal): { statusCode: number; body: object; record: AuditTarget } {
  const { statusCode, message } = REFUSAL[refusal.reason];
  const { reason, recipientIds, unresolvedCount } = refusal;
  const record = { reason, senderId, recipientIds, ...(unresolvedCount === undefined ? {} : { unresolvedCount }) };
  return { statusCode, body: { error: `relay_${reason}`, reason: message, ...pickDetails(refusal) }, record };
}

function pickDetails(refusal: RelayRefusal): object {
  if (refusal.candidates !== undefined) return { candidates: refusal.candidates };
  if (refusal.pattern !== undefined) return { pattern: refusal.pattern };
  return {};
}

function refuse(reason: RelayRefusalReason, recipientIds: string[] = []): { refusal: RelayRefusal } {
  return { refusal: { reason, recipientIds } };
}

async function getSenderOrThrow(sessionId: string): Promise<SenderRow> {
  const row = await getPrisma().queueSession.findUnique({ where: { sessionId }, select: { name: true, cwd: true, state: true, isProbe: true } });
  if (row === null) throw new QueueRequestError(404, "unknown_session", "session not registered");
  return { id: sessionId, ...row };
}

// Every input is resolved before any refusal → the record names all the sessions the call did resolve to
async function resolveRecipients(sender: SenderRow, recipients: string[]): Promise<{ ids: string[] } | { refusal: RelayRefusal }> {
  if (recipients.some((recipient) => isNamedBy(sender, recipient))) return refuse("self", [sender.id]);
  const peers = await getPeerRows(sender.id);
  const matches = recipients.map((recipient) => peers.filter((peer) => isNamedBy(peer, recipient)));
  const ids = [...new Set(matches.flatMap((match) => (match.length === 1 ? match.map((peer) => peer.id) : [])))];
  const unresolvedCount = matches.filter((match) => match.length !== 1).length;
  if (matches.some((match) => match.length === 0)) return { refusal: { reason: "recipient", recipientIds: ids, unresolvedCount } };
  const ambiguous = matches.find((match) => match.length > 1);
  if (ambiguous !== undefined) return { refusal: { reason: "recipient_ambiguous", recipientIds: ids, unresolvedCount, candidates: ambiguous.map(toCandidate) } };
  return { ids };
}

// An id prefix as the peers read shows it (or a few characters longer), or the shown name exactly
function isNamedBy(row: Pick<ListedSessionRow, "id" | "name" | "cwd">, recipient: string): boolean {
  const isPrefixLength = recipient.length >= SESSION_ID_PREFIX_LENGTH && recipient.length <= RELAY.RECIPIENT_PREFIX_MAX;
  const isPrefix = isPrefixLength && row.id.startsWith(recipient.toLowerCase());
  return isPrefix || getSessionName(row).name === recipient;
}

function toCandidate(row: ListedSessionRow): RecipientCandidate {
  return { sessionIdPrefix: getSessionIdPrefix(row.id), name: getSessionName(row).name };
}

async function insertRelay(tx: Prisma.TransactionClient, body: RelayBody, recipientIds: string[]): Promise<RelayOutcome> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RELAY_LOCK_KEY})`;
  const lockRefusal = getLockedRefusal(await lockSessions(tx, [body.sessionId, ...recipientIds]), body.sessionId);
  if (lockRefusal !== null) return refuse(lockRefusal, recipientIds);
  const capRefusal = await getCapRefusal(tx, body.sessionId, recipientIds);
  if (capRefusal !== null) return refuse(capRefusal, recipientIds);
  const parent = await findHopParent(tx, body.sessionId);
  const hop = parent === null ? 0 : parent.hop + 1;
  if (hop >= RELAY.HOP_LIMIT) return refuse("hop", recipientIds);
  await assertLinkedDocsExist(tx, body.linkedDocIds);
  const sendId = randomUUID();
  const fields = { kind: "relay", fromSessionId: body.sessionId, relayHop: hop, relayParentId: parent?.id ?? null, linkedDocIds: body.linkedDocIds.map(BigInt) } as const;
  const copies = await createCopies(tx, { sessionIds: recipientIds, text: body.text, sendId }, fields);
  return { relay: { sendId, hop, copies: copies.map((copy) => ({ id: copy.id, sessionIdPrefix: getSessionIdPrefix(copy.sessionId) })) } };
}

// Re-read under the row locks: the sender or a recipient may have ended, been replaced or turned probe since resolution
function getLockedRefusal(locked: LockedSessionRow[], senderId: string): RelayRefusalReason | null {
  const sender = locked.find((row) => row.sessionId === senderId);
  if (sender?.isProbe === true) return "sender_probe";
  if (sender?.state !== "live") return "sender_not_live";
  return locked.every((row) => row.state === "live" && !row.isProbe) ? null : "recipient";
}

async function getCapRefusal(tx: Prisma.TransactionClient, senderId: string, recipientIds: string[]): Promise<RelayRefusalReason | null> {
  const windowStart = new Date(Date.now() - RELAY.CAP_WINDOW_MS);
  const [count] = await tx.$queryRaw<Array<{ sender: number; pair: number; machine: number }>>`
    SELECT
      (SELECT count(*) FROM "monitor"."queue_items" i
        WHERE i."kind"::text = 'relay' AND i."from_session_id" = ${senderId}::uuid AND i."asked_at" >= ${windowStart})::int AS "sender",
      (SELECT COALESCE(max(p."copies"), 0) FROM (
        SELECT count(*) AS "copies" FROM "monitor"."queue_items" i
        WHERE i."kind"::text = 'relay' AND i."from_session_id" = ${senderId}::uuid AND i."session_id" = ANY(${recipientIds}::uuid[])
          AND i."asked_at" >= ${windowStart}
        GROUP BY i."session_id") p)::int AS "pair",
      (SELECT count(*) FROM "monitor"."queue_items" i WHERE i."kind"::text = 'relay' AND i."asked_at" >= ${windowStart})::int AS "machine"`;
  if ((count?.sender ?? 0) + recipientIds.length > RELAY.PER_SENDER) return "sender_cap";
  if ((count?.pair ?? 0) + 1 > RELAY.PER_PAIR) return "pair_cap";
  if ((count?.machine ?? 0) + recipientIds.length > RELAY.MACHINE) return "machine_cap";
  return null;
}

/**
 * The highest-hop relay the sender claimed (a Delivery row) or fetched within the hop window, counted only after the
 * newest owner item it acked first; null when none → hop 0.
 */
async function findHopParent(tx: Prisma.TransactionClient, senderId: string): Promise<{ id: bigint; hop: number } | null> {
  const windowStart = new Date(Date.now() - RELAY.HOP_WINDOW_MS);
  const rows = await tx.$queryRaw<Array<{ id: bigint; hop: number }>>`
    WITH "reset" AS (
      SELECT max("delivered_at") AS "at" FROM "monitor"."queue_items"
      WHERE "session_id" = ${senderId}::uuid AND "kind"::text <> 'relay'
    ), "received" AS (
      SELECT r."id", r."relay_hop" AS "hop",
        GREATEST(r."relay_fetched_at", (SELECT max(d."sent_at") FROM "monitor"."queue_deliveries" d WHERE d."item_id" = r."id")) AS "at"
      FROM "monitor"."queue_items" r
      WHERE r."session_id" = ${senderId}::uuid AND r."kind"::text = 'relay'
    )
    SELECT "received"."id", "received"."hop"::int AS "hop" FROM "received" CROSS JOIN "reset"
    WHERE "received"."at" >= ${windowStart} AND ("reset"."at" IS NULL OR "received"."at" > "reset"."at")
    ORDER BY "received"."hop" DESC, "received"."at" DESC, "received"."id" DESC
    LIMIT 1`;
  return rows[0] ?? null;
}
