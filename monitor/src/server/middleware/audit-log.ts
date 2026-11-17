// Audit-log middleware: fire-and-forget monitor.audit_log INSERT for every mutating /api/* response.
// Registered in app.ts (buildApp) after registerRoutes(), before main.ts calls app.listen(); covers the ROUTE_RESOURCE routes.
// Safety bar: INSERT is not awaited (zero added latency); a failed/slow audit must NEVER block/delay/fail the mutation.
// Hook failure = silent log only. Scope: mutating methods (POST/PUT/PATCH/DELETE) on covered routes only (reads/other routes ignored).
// Exception: a handler whose row is itself the record (insertAudit) awaits it, and the hook then skips that response.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Prisma } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import type { RemoteAuditWriter } from "../remote/gate.js";
// Shared with the request gate — this hook must observe exactly the set the gate judges.
import { MUTATION_METHODS } from "../request-guards.js";

// Single audit actor — the monitor web server is the sole write-action origin.
export const AUDIT_ACTOR = "monitor-web";

// VarChar64 defensive cap on action_kind — resource+verb never reaches it, but a malformed/oversized route key must not throw a length error into the path.
const ACTION_KIND_MAX = 64;

// Covered mutation routes → resource label (route key = Fastify routeOptions.url, :id/:rootId preserved).
// Hand-maintained superset: a new mutation route unregistered here goes silently un-audited.
// The coverage-drift guard test introspects the production route barrel, so it fails when a
// registered mutating route is in neither this map nor the test's NON_AUDITED_MUTATIONS allowlist
// — the allowlist is the sanctioned way to declare a mutation route deliberately un-audited.
export const ROUTE_RESOURCE: ReadonlyMap<string, string> = new Map([
  ["/api/clauded-docs", "clauded-docs"],
  ["/api/clauded-docs/:id", "clauded-docs"],
  ["/api/clauded-docs/group", "clauded-docs-group"],
  ["/api/clauded-docs/ungroup", "clauded-docs-group"],
  ["/api/clauded-docs/group/:rootId/reorder", "clauded-docs-group"],
  ["/api/clauded-docs/:id/move-group", "clauded-docs-group"],
  ["/api/improvement/:id/approve", "improvement"],
  ["/api/improvement/:id/reject", "improvement"],
  ["/api/improvement/:id/restore", "improvement"],
  ["/api/model-config", "model-config"],
  // Registry mutation — the agent roster is the exact class the audit log exists for.
  // target_id stays null (:name is not numeric); the handler attaches the name via AuditChangeCarrier.
  ["/api/agents/:name", "agents"],
  // Self-update control plane — applies a release to the live install (irreversible, host-wide).
  ["/api/dashboard/update", "self-update"],
  // Owner queue: every owner decision on an item; the body (answer text) is never recorded.
  ["/api/queue/owner/items/:id/answer", "queue-item"],
  ["/api/queue/owner/items/:id/later", "queue-item"],
  ["/api/queue/owner/items/:id/seen", "queue-item"],
  ["/api/queue/owner/items/:id/reply", "queue-item"],
  ["/api/queue/owner/items/:id/resend", "queue-item"],
  // Owner message send: one row per send; the handler attaches the created item ids, never the text.
  ["/api/queue/owner/messages/send", "queue-message"],
  // Session relay: kept out of the archive rotation by its resource (scripts/_pg_archive_rotate.py → RELAY_RESOURCE)
  ["/api/queue/relay", "queue-relay"],
  // Owner redaction of a relay's text: the row names the relay (target id) and the page-origin signal that admitted it
  ["/api/queue/owner/items/:id/redact", "queue-relay"],
]);

/** Curated identifiers of what a mutation acted on (ids, names, changed field names) → never a body or credential value. */
export type AuditTarget = Readonly<Record<string, unknown>>;

// Single-writer enrichment seam: a handler may attach a curated old→new diff or target — never the raw request body (PII/secret guard).
// Loopback: the middleware merges it as `change` for covered routes and stays the ONLY audit-row writer for the route
// (model-config AC-9: exactly 1 row per PUT). Remote: the gate records it as the row's `target` with the outcome, every route.
export interface AuditChangeCarrier {
  auditChange?: AuditTarget;
  /** Set by insertAudit → the onResponse hook writes no second row for the response. */
  isAuditWritten?: boolean;
}

export function setAuditTarget(request: FastifyRequest, target: AuditTarget): void {
  (request as FastifyRequest & AuditChangeCarrier).auditChange = target;
}

// HTTP method → coarse verb. The route's literal suffix (e.g. 'approve', 'move-group') is a
// more specific verb when present and takes precedence (see deriveActionKind).
const METHOD_VERB: Readonly<Record<string, string>> = {
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
};

type AuditResultCode = "success" | "blocked" | "error";

/** A response's status, and the result it records when the status alone does not decide it (a 503 refusal is blocked). */
export interface AuditOutcome {
  statusCode: number;
  resultCode?: AuditResultCode;
}

interface AuditSnapshot {
  actionKind: string;
  resultCode: AuditResultCode;
  targetTable: string;
  targetId: bigint | null;
  payload: Record<string, unknown> | null;
}

/**
 * Extract the Fastify v5 route key (pattern URL with :id segments preserved).
 * Returns null when route matching failed — an unmatched route is not audited
 * (audit cardinality stays bounded to the known mutation routes).
 */
function extractRouteKey(request: FastifyRequest): string | null {
  const routeUrl = request.routeOptions?.url;
  return typeof routeUrl === "string" && routeUrl.length > 0 ? routeUrl : null;
}

/**
 * Map an HTTP status to the AuditResultCode enum.
 *   2xx → success · 4xx → blocked (validation / not-found / forbidden) · 5xx → error.
 *   1xx/3xx fall through to success (no mutation rejection occurred).
 */
export function deriveResultCode(statusCode: number): AuditResultCode {
  if (statusCode >= 500) {
    return "error";
  }
  if (statusCode >= 400) {
    return "blocked";
  }
  return "success";
}

/**
 * Derive action_kind as '<resource>.<verb>'.
 * The route's trailing literal segment (approve / reject / ungroup / move-group / reorder)
 * is a more meaningful verb than the bare HTTP method, so it wins when the last path segment
 * is a non-parameter literal; otherwise the method verb (create/update/delete) is used.
 */
function deriveActionKind(routeKey: string, method: string, resource: string): string {
  const segments = routeKey.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? "";
  // A literal trailing segment (not a :param, not the resource root) is the specific verb.
  // Root check compares against the entry's resource label — a collection-root route (/api/model-config) falls through to the method verb.
  const literalVerb =
    last.length > 0 && !last.startsWith(":") && last !== resource ? last : null;
  const verb = literalVerb ?? METHOD_VERB[method] ?? method.toLowerCase();
  const kind = `${resource}.${verb}`;
  return kind.length > ACTION_KIND_MAX ? kind.slice(0, ACTION_KIND_MAX) : kind;
}

/**
 * Extract the numeric target id from route params (:id or :rootId), when present.
 * Returns null on absence or non-numeric value — target_id is a nullable column.
 */
export function extractTargetId(request: FastifyRequest): bigint | null {
  const params = request.params as Record<string, unknown> | undefined;
  if (!params) {
    return null;
  }
  const raw = params.id ?? params.rootId;
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null;
  }
  const asString = String(raw);
  // BigInt() throws on non-integer text — guard with a digit check first (silent on miss).
  if (!/^\d+$/.test(asString)) {
    return null;
  }
  try {
    return BigInt(asString);
  } catch {
    return null;
  }
}

/**
 * Build a minimal, PII-free payload — only structural identifiers (method, matched route key, status).
 * The request body is NOT included (document content / user data = PII + secrets risk). A handler-attached
 * AuditChangeCarrier diff (curated, never the raw body) merges under `change`.
 */
function buildPayload(
  method: string,
  routeKey: string,
  statusCode: number,
  change: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = { method, route: routeKey, status_code: statusCode };
  return change === undefined ? base : { ...base, change };
}

/**
 * Register the audit-log hook. Called by app.ts (buildApp) after registerRoutes(), before main.ts calls app.listen().
 * onResponse (post-send, zero latency) → skip non-mutating/uncovered routes and responses insertAudit recorded → fire-and-forget INSERT
 * (not awaited) → INSERT failure = silent log + swallow (the mutation already completed).
 */
export function registerAuditLogHook(app: FastifyInstance): void {
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const snapshot = getAuditSnapshot(request, { statusCode: reply.statusCode });
      if (snapshot === null || (request as FastifyRequest & AuditChangeCarrier).isAuditWritten === true) {
        return;
      }
      // Fire-and-forget — not awaited; void marks the intentionally floating promise.
      void writeAuditRow(getPrisma(), snapshot).catch((error: unknown) => {
        // Silent — the response was already sent, so no user impact.
        app.log.warn({ err: error, actionKind: snapshot.actionKind }, "audit-log middleware: INSERT failed (continuing in degraded mode)");
      });
    } catch (error) {
      // Must not affect response handling — silent log.
      app.log.warn(
        { err: error, url: request.url },
        "audit-log middleware: snapshot capture failed",
      );
    }
  });
}

/**
 * Awaited row for a response its handler records itself (a relay refusal, a redaction), in place of the hook's.
 * @param outcome - the status the handler is about to answer with
 * @param db - a transaction client → the row commits or rolls back with the handler's own write
 * @throws on an uncovered route or a failed INSERT; the hook writes no row for this response either way
 */
export async function insertAudit(request: FastifyRequest, outcome: AuditOutcome, db: Prisma.TransactionClient = getPrisma()): Promise<void> {
  const snapshot = getAuditSnapshot(request, outcome);
  if (snapshot === null) {
    throw new Error(`audit-log: ${request.method} ${request.routeOptions.url} is no audited mutation route`);
  }
  (request as FastifyRequest & AuditChangeCarrier).isAuditWritten = true;
  await writeAuditRow(db, snapshot);
}

/** Row a mutating covered route's response records; null for a read, an unmatched or an uncovered route. */
function getAuditSnapshot(request: FastifyRequest, { statusCode, resultCode }: AuditOutcome): AuditSnapshot | null {
  const method = request.method.toUpperCase();
  const routeKey = extractRouteKey(request);
  const resource = routeKey === null ? undefined : ROUTE_RESOURCE.get(routeKey);
  if (!MUTATION_METHODS.has(method) || routeKey === null || resource === undefined) {
    return null;
  }
  return {
    actionKind: deriveActionKind(routeKey, method, resource),
    resultCode: resultCode ?? deriveResultCode(statusCode),
    targetTable: resource,
    targetId: extractTargetId(request),
    payload: buildPayload(method, routeKey, statusCode, (request as FastifyRequest & AuditChangeCarrier).auditChange),
  };
}

/** Server-side NOW() for event_ts (avoids adapter-pg Date serialization). */
async function writeAuditRow(db: Prisma.TransactionClient, snapshot: AuditSnapshot): Promise<void> {
  const payloadJson = snapshot.payload === null ? null : JSON.stringify(snapshot.payload);
  await db.$executeRaw`
    INSERT INTO monitor.audit_log
      (event_ts, actor, action_kind, target_table, target_id, payload, result_code)
    VALUES (
      NOW(),
      ${AUDIT_ACTOR},
      ${snapshot.actionKind},
      ${snapshot.targetTable},
      ${snapshot.targetId},
      ${payloadJson}::jsonb,
      ${snapshot.resultCode}::monitor."AuditResultCode"
    )
  `;
}

/**
 * Remote listener audit rows, awaited by the remote gate before the handler (unlike the loopback hook above).
 * Intent row inserted as `error` → a crash mid-handler stays recorded as not succeeded; the result follows.
 */
export function buildRemoteAuditWriter(db: Prisma.TransactionClient = getPrisma()): RemoteAuditWriter {
  return {
    insertIntent: async ({ actor, method, route, targetId }) => {
      const row = await db.auditLog.create({
        data: {
          eventTs: new Date(),
          actor,
          actionKind: "remote.mutation",
          targetTable: ROUTE_RESOURCE.get(route) ?? null,
          targetId: targetId ?? null,
          payload: { method, route },
          resultCode: "error",
        },
        select: { id: true },
      });
      return row.id;
    },
    setResult: async (id, result, target) => {
      if (target === undefined) {
        await db.auditLog.update({ where: { id }, data: { resultCode: result } });
        return;
      }
      // one statement → the target lands with the outcome, beside the intent's method and route
      await db.$executeRaw`
        UPDATE monitor.audit_log
        SET result_code = ${result}::monitor."AuditResultCode",
            payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('target', ${JSON.stringify(target)}::jsonb)
        WHERE id = ${id}
      `;
    },
    insertEvent: async ({ actor, actionKind, result, payload, targetId }) => {
      await db.auditLog.create({
        data: {
          eventTs: new Date(),
          actor,
          actionKind,
          targetTable: targetId === undefined ? null : "remote_devices",
          targetId: targetId ?? null,
          payload: payload === undefined ? undefined : { ...payload },
          resultCode: result,
        },
      });
    },
  };
}
