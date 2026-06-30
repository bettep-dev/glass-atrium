// Shared DB-failure taxonomy for route catch blocks — replaces the per-route
// blanket 503 `database_unavailable` mapping. Client-input faults (SQLSTATE
// class 22/23, e.g. bigint overflow / FK violation) → 400 with reason at WARN;
// availability faults and unknowns stay 503 at ERROR with the SQLSTATE +
// classification in the structured log (real outages no longer masked).

import type { FastifyReply, FastifyRequest } from "fastify";

export type DbFailureKind = "input" | "outage" | "unknown";

export interface DbFailureClassification {
  kind: DbFailureKind;
  sqlState: string | null;
  // Short single-line pg message — safe for a 400 body (no SQL text / stack).
  reason: string;
}

export type DbFailureBody =
  | { error: "invalid_input"; reason: string }
  | { error: "database_unavailable" };

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
// Class 22 = data exception · 23 = integrity violation → client-supplied value fault.
const INPUT_SQLSTATE_CLASSES: ReadonlySet<string> = new Set(["22", "23"]);
// Class 08 = connection exception · 53 = insufficient resources · 57 = operator intervention.
const OUTAGE_SQLSTATE_CLASSES: ReadonlySet<string> = new Set(["08", "53", "57"]);
// Syscall-level connect failures (no SQLSTATE on the wire).
const OUTAGE_SYSCALL_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
]);
const REASON_MAX_LENGTH = 200;
const CAUSE_CHAIN_LIMIT = 5;
const GENERIC_REASON = "input value rejected by database";

interface SqlStateHit {
  sqlState: string;
  message: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

// Prisma 7 driver-adapter errors (P2010) carry the pg SQLSTATE at
// meta.driverAdapterError.cause.originalCode (+ originalMessage / kind) —
// shape verified against @prisma/adapter-pg 7.8.
function extractAdapterCause(error: unknown): Record<string, unknown> | null {
  const meta = asRecord(asRecord(error)?.meta);
  const driverAdapterError = asRecord(meta?.driverAdapterError);
  return asRecord(driverAdapterError?.cause);
}

function isSqlState(code: unknown): code is string {
  // Prisma's own codes (P20xx) also match the 5-char shape — exclude the P
  // prefix (no standard SQLSTATE class starts with P).
  return typeof code === "string" && SQLSTATE_PATTERN.test(code) && !code.startsWith("P");
}

function findSqlState(error: unknown): SqlStateHit | null {
  const adapterCause = extractAdapterCause(error);
  if (adapterCause !== null && isSqlState(adapterCause.originalCode)) {
    return {
      sqlState: adapterCause.originalCode,
      message:
        typeof adapterCause.originalMessage === "string" ? adapterCause.originalMessage : null,
    };
  }
  // Raw pg DatabaseError path — `code` on the error or its cause chain.
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_CHAIN_LIMIT; depth++) {
    const record = asRecord(current);
    if (record === null) break;
    if (isSqlState(record.code)) {
      return {
        sqlState: record.code,
        message: typeof record.message === "string" ? record.message : null,
      };
    }
    current = record.cause;
  }
  return null;
}

function hasOutageSignal(error: unknown): boolean {
  const adapterCause = extractAdapterCause(error);
  if (adapterCause !== null && adapterCause.kind === "DatabaseNotReachable") return true;
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_CHAIN_LIMIT; depth++) {
    const record = asRecord(current);
    if (record === null) break;
    if (record.name === "PrismaClientInitializationError") return true;
    if (typeof record.code === "string" && OUTAGE_SYSCALL_CODES.has(record.code)) return true;
    current = record.cause;
  }
  return false;
}

function truncateReason(message: string | null): string {
  if (message === null || message.trim().length === 0) return GENERIC_REASON;
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > REASON_MAX_LENGTH
    ? `${oneLine.slice(0, REASON_MAX_LENGTH - 1)}…`
    : oneLine;
}

export function classifyDbFailure(error: unknown): DbFailureClassification {
  const hit = findSqlState(error);
  if (hit !== null) {
    const sqlClass = hit.sqlState.slice(0, 2);
    const reason = truncateReason(hit.message);
    if (INPUT_SQLSTATE_CLASSES.has(sqlClass)) {
      return { kind: "input", sqlState: hit.sqlState, reason };
    }
    if (OUTAGE_SQLSTATE_CLASSES.has(sqlClass)) {
      return { kind: "outage", sqlState: hit.sqlState, reason };
    }
    return { kind: "unknown", sqlState: hit.sqlState, reason };
  }
  if (hasOutageSignal(error)) {
    return { kind: "outage", sqlState: null, reason: GENERIC_REASON };
  }
  return { kind: "unknown", sqlState: null, reason: GENERIC_REASON };
}

/**
 * Route catch-block responder — the per-route `failWithDb` helpers delegate here.
 * input → 400 `invalid_input` (WARN) · outage/unknown → 503 `database_unavailable`
 * (ERROR, SQLSTATE + kind in the log so a code bug is distinguishable from an outage).
 */
export function respondDbFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  error: unknown,
  logMessage: string,
): DbFailureBody {
  const classification = classifyDbFailure(error);
  const logFields = {
    err: error,
    route,
    sqlstate: classification.sqlState,
    db_failure_kind: classification.kind,
  };
  if (classification.kind === "input") {
    request.log.warn(logFields, logMessage);
    reply.code(400);
    return { error: "invalid_input", reason: classification.reason };
  }
  request.log.error(logFields, logMessage);
  reply.code(503);
  return { error: "database_unavailable" };
}
