// Audit-log middleware: auto-insert monitor.audit_log for every mutating /api/* response.
//
// Records every state-mutating request reaching the covered routes (clauded-docs +
// improvement). Registered in main.ts after registerRoutes(), before app.listen().
//
// Core invariants (safety bar):
//   - Zero added response latency — INSERT is fire-and-forget (not awaited).
//   - A failed/slow audit INSERT must NEVER block, delay, or fail the underlying mutation.
//   - Hook failure = silent log only.
//
// Scope:
//   - Only mutating methods (POST/PUT/PATCH/DELETE) — reads never produce an audit row.
//   - Only covered route prefixes (clauded-docs + improvement) — other routes ignored.
//
// Column convention:
//   - actor       = 'monitor-web' (single origin; the monitor web server is the sole actor).
//   - action_kind = '<resource>.<verb>' derived from route+method (e.g. 'clauded-docs.delete').
//   - result_code = success (2xx) | blocked (4xx) | error (5xx) — the AuditResultCode enum.
//   - event_ts    = NOW() server-side literal (avoids adapter-pg Date serialization).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPrisma } from "../db.js";

// Single audit actor — the monitor web server is the sole write-action origin.
const AUDIT_ACTOR = "monitor-web";

// VarChar64 ceiling on the action_kind column — defensive cap (resource+verb never reaches it,
// but a malformed/oversized route key must not throw a length-constraint error into the path).
const ACTION_KIND_MAX = 64;

// Covered mutation routes. Each entry maps a route key (Fastify routeOptions.url, with the
// dynamic :id/:rootId segments preserved) to the resource label used in action_kind.
//
// Hand-maintained — a newly added mutation route must register here or it goes silently
// un-audited. The coverage-drift guard test fails when a registered mutating route is
// missing from this map, so the map MUST stay a superset of audited routes.
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
]);

// Single-writer enrichment seam: a covered handler may attach a curated old→new diff
// (never the raw request body — PII/secret guard stays intact) that this middleware
// merges into the payload. The middleware remains the ONLY audit-row writer for the
// route (model-config AC-9: exactly 1 row per PUT, with the old→new payload).
export interface AuditChangeCarrier {
  auditChange?: Record<string, unknown>;
}

// HTTP method → coarse verb. The route's literal suffix (e.g. 'approve', 'move-group') is a
// more specific verb when present and takes precedence (see deriveActionKind).
const METHOD_VERB: Readonly<Record<string, string>> = {
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
};

const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface AuditSnapshot {
  actionKind: string;
  resultCode: "success" | "blocked" | "error";
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
function deriveResultCode(statusCode: number): "success" | "blocked" | "error" {
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
  // Root check compares against the entry's own resource label (resource-generic) — a
  // collection-root route like /api/model-config must fall through to the method verb.
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
function extractTargetId(request: FastifyRequest): bigint | null {
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
 * Build a minimal, PII-free payload. Only structural identifiers are recorded:
 * the HTTP method, the matched route key, and the status code. The request body
 * is NOT included — it can carry document content / user data (PII + secrets risk).
 * A handler-attached AuditChangeCarrier diff (curated, never the raw body) merges
 * under `change`.
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
 * Register the audit-log hook. Called by main.ts after registerRoutes(), before app.listen().
 *
 * Behavior:
 *   1. onResponse — fires after the response is sent (zero latency impact).
 *   2. Non-mutating methods + unmatched / uncovered routes return immediately.
 *   3. INSERT is fire-and-forget (not awaited) — never blocks or delays the response.
 *   4. INSERT failure = silent log + swallow — the mutation already completed.
 */
export function registerAuditLogHook(app: FastifyInstance): void {
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const method = request.method.toUpperCase();
      if (!MUTATING_METHODS.has(method)) {
        return;
      }
      const routeKey = extractRouteKey(request);
      if (routeKey === null) {
        return;
      }
      const resource = ROUTE_RESOURCE.get(routeKey);
      if (resource === undefined) {
        // Route is a mutation but not in the audited set — skip (bounded cardinality).
        return;
      }

      const statusCode = reply.statusCode;
      const snapshot: AuditSnapshot = {
        actionKind: deriveActionKind(routeKey, method, resource),
        resultCode: deriveResultCode(statusCode),
        targetTable: resource,
        targetId: extractTargetId(request),
        payload: buildPayload(
          method,
          routeKey,
          statusCode,
          (request as FastifyRequest & AuditChangeCarrier).auditChange,
        ),
      };

      // Fire-and-forget — not awaited; void marks the intentionally floating promise.
      void insertAudit(app, snapshot);
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
 * Async INSERT — server-side NOW() for event_ts (avoids adapter-pg Date
 * serialization). On failure, silent log + swallow. Separated so the inner-most
 * try/catch absorbs every throw off the request path.
 */
async function insertAudit(app: FastifyInstance, snapshot: AuditSnapshot): Promise<void> {
  try {
    const prisma = getPrisma();
    const payloadJson = snapshot.payload === null ? null : JSON.stringify(snapshot.payload);
    await prisma.$executeRaw`
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
  } catch (error) {
    // Silent — the response was already sent, so no user impact.
    app.log.warn(
      { err: error, actionKind: snapshot.actionKind },
      "audit-log middleware: INSERT failed (continuing in degraded mode)",
    );
  }
}
