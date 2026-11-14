// Remote listener gate, registered at the root before any route: Host → limits → registered device → route class →
// page origin + CSRF on mutations → audit row before the handler. Loopback never loads it.

import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { MUTATION_METHODS, getPageOriginSignal } from "../request-guards.js";
import { deriveResultCode } from "../middleware/audit-log.js";
import type { DeviceConnections } from "./connections.js";
import type { DeviceSummary } from "./devices.js";
import { REMOTE_LIMITS, WindowLimiter } from "./limits.js";
import type { RouteClass } from "./route-classes.js";
import { CSRF_HEADER, DEVICE_COOKIE, DEVICE_COOKIE_OPTIONS, isCsrfTokenValid } from "./session.js";

export interface RemoteAuditEntry {
  readonly actor: string;
  readonly method: string;
  readonly route: string;
}

export type RemoteAuditResult = "success" | "blocked" | "error";

/** A remote-access event recorded with its outcome in one row (auth failure, denied route, registration, revoke). */
export interface RemoteAuditEvent {
  readonly actor: string;
  readonly actionKind: string;
  readonly result: RemoteAuditResult;
  readonly payload?: { readonly method: string; readonly route: string; readonly count?: number };
  /** remote_devices row the event concerns */
  readonly targetId?: bigint;
}

export interface RemoteAuditWriter {
  /** @returns the row id; the row starts as `error` so a crash mid-handler stays recorded as not succeeded */
  insertIntent(entry: RemoteAuditEntry): Promise<bigint>;
  setResult(id: bigint, result: RemoteAuditResult): Promise<void>;
  insertEvent(event: RemoteAuditEvent): Promise<void>;
}

export interface RemoteGateDeps {
  readonly getHosts: () => ReadonlySet<string>;
  readonly getPageOrigins: () => ReadonlySet<string>;
  readonly findDevice: (presented: string) => Promise<DeviceSummary | null>;
  readonly getRouteClass: (method: string, routePath: string) => RouteClass | null;
  /** `METHOD /path` keys answered without a registered device (sign-in page, its assets, the code POST) */
  readonly preAuthRoutes: ReadonlySet<string>;
  readonly audit: RemoteAuditWriter;
  /** shared with the loopback revoke routes → a cut-off device loses its open sockets at once */
  readonly connections: DeviceConnections;
  readonly now?: () => number;
}

interface Limiters {
  readonly preAuth: WindowLimiter;
  readonly failedSession: WindowLimiter;
  readonly deviceRequests: WindowLimiter;
  readonly deviceMutations: WindowLimiter;
}

interface DeviceState {
  readonly device: DeviceSummary;
  auditId?: bigint;
}

const HSTS = "max-age=604800";
const ACTOR_MAX_LENGTH = 64;
// an unmatched path is caller-chosen → bounded before it reaches the audit payload
const ROUTE_MAX_LENGTH = 256;
// request → admitted device; a WeakMap, not a decoration → nothing outside this module can mark a request registered
const ADMITTED = new WeakMap<FastifyRequest, DeviceState>();

export async function registerRemoteGate(app: FastifyInstance, deps: RemoteGateDeps): Promise<void> {
  await app.register(fastifyCookie);
  const now = deps.now ?? Date.now;
  const limiters: Limiters = {
    preAuth: new WindowLimiter(REMOTE_LIMITS.PRE_AUTH, now),
    failedSession: new WindowLimiter(REMOTE_LIMITS.FAILED_SESSION, now),
    deviceRequests: new WindowLimiter(REMOTE_LIMITS.DEVICE_REQUESTS, now),
    deviceMutations: new WindowLimiter(REMOTE_LIMITS.DEVICE_MUTATIONS, now),
  };
  app.addHook("onRequest", (request, reply) => admitRequest(request, reply, deps, limiters));
  app.addHook("preHandler", (request, reply) => writeAuditIntent(request, reply, deps.audit));
  app.addHook("onSend", async (request, reply, payload) => {
    setRemoteHeaders(request, reply);
    return payload;
  });
  app.addHook("onResponse", (request, reply) => recordAuditResult(request, reply, deps.audit));
}

async function admitRequest(request: FastifyRequest, reply: FastifyReply, deps: RemoteGateDeps, limiters: Limiters): Promise<FastifyReply | undefined> {
  if (!deps.getHosts().has((request.headers.host ?? "").toLowerCase())) return refuse(reply, 403, "host_not_allowed");
  const address = getSourceAddress(request);
  if (limiters.failedSession.isBlocked(address)) return refuse(reply, 429, "too_many_requests");
  const routePath = request.routeOptions.url;
  if (routePath !== undefined && deps.preAuthRoutes.has(`${request.method} ${routePath}`)) {
    if (!limiters.preAuth.hit(address)) return refuse(reply, 429, "too_many_requests");
    // no device yet → no CSRF value; the page origin alone stands between a neighbour page and the code POST
    const isFromPage = !MUTATION_METHODS.has(request.method) || getPageOriginSignal(request.headers, deps.getPageOrigins()) !== null;
    return isFromPage ? undefined : refuse(reply, 403, "not_page_origin");
  }
  const presented = request.cookies[DEVICE_COOKIE.NAME];
  const device = presented === undefined || presented.length === 0 ? null : await deps.findDevice(presented);
  if (presented === undefined || device === null) {
    limiters.failedSession.hit(address);
    // an absent cookie is a first visit, not a failed credential → only a presented, unknown one is audited
    if (presented !== undefined && presented.length > 0) recordEvent(request, deps.audit, { actor: getRemoteActor(null, address), actionKind: "remote.auth_failure" });
    return refuse(reply, 401, "not_registered");
  }
  return admitDevice(request, reply, { deps, limiters, device, presented });
}

async function admitDevice(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { deps: RemoteGateDeps; limiters: Limiters; device: DeviceSummary; presented: string },
): Promise<FastifyReply | undefined> {
  const { deps, limiters, device, presented } = input;
  const routePath = request.routeOptions.url;
  if (routePath === undefined || deps.getRouteClass(request.method, routePath) !== "page") {
    recordEvent(request, deps.audit, { actor: getRemoteActor(device, getSourceAddress(request)), actionKind: "remote.route_denied" });
    return refuse(reply, 403, "route_not_available");
  }
  const deviceKey = String(device.id);
  if (!limiters.deviceRequests.hit(deviceKey)) return refuse(reply, 429, "too_many_requests");
  if (MUTATION_METHODS.has(request.method)) {
    if (!limiters.deviceMutations.hit(deviceKey)) return refuse(reply, 429, "too_many_requests");
    const csrf = request.headers[CSRF_HEADER];
    const isFromPage = getPageOriginSignal(request.headers, deps.getPageOrigins()) !== null;
    if (!isFromPage || !isCsrfTokenValid(presented, Array.isArray(csrf) ? csrf[0] : csrf)) return refuse(reply, 403, "not_page_origin");
  }
  ADMITTED.set(request, { device });
  deps.connections.track(device.id, request.socket);
  // re-sent on every admitted request → the browser's 400-day clock restarts on use
  reply.setCookie(DEVICE_COOKIE.NAME, presented, DEVICE_COOKIE_OPTIONS);
  return undefined;
}

async function writeAuditIntent(request: FastifyRequest, reply: FastifyReply, audit: RemoteAuditWriter): Promise<FastifyReply | undefined> {
  const state = ADMITTED.get(request);
  if (state === undefined || !MUTATION_METHODS.has(request.method)) return undefined;
  const route = request.routeOptions.url ?? "";
  try {
    const actor = getRemoteActor(state.device, getSourceAddress(request));
    state.auditId = await audit.insertIntent({ actor, method: request.method, route });
  } catch (error) {
    request.log.error({ err: error, method: request.method, route }, "remote mutation refused: audit intent row not written");
    return refuse(reply, 503, "audit_unavailable");
  }
  return undefined;
}

async function recordAuditResult(request: FastifyRequest, reply: FastifyReply, audit: RemoteAuditWriter): Promise<void> {
  const auditId = ADMITTED.get(request)?.auditId;
  if (auditId === undefined) return;
  try {
    await audit.setResult(auditId, deriveResultCode(reply.statusCode));
  } catch (error) {
    // intent row stays `error` → the trail never over-reports a success
    request.log.warn({ err: error, auditId: String(auditId) }, "remote audit result not recorded");
  }
}

// fire-and-forget → a refusal is never delayed or turned into a 500 by the audit write
function recordEvent(request: FastifyRequest, audit: RemoteAuditWriter, event: { actor: string; actionKind: string }): void {
  const payload = { method: request.method, route: (request.routeOptions.url ?? request.url.split("?")[0] ?? "").slice(0, ROUTE_MAX_LENGTH) };
  audit.insertEvent({ ...event, result: "blocked", payload }).catch((error: unknown) => {
    request.log.warn({ err: error, actionKind: event.actionKind }, "remote audit event not recorded");
  });
}

/** `remote:<device id | ->@<source address>` → fits audit_log.actor (64) for an IPv4 source. */
export function getRemoteActor(device: DeviceSummary | null, address: string): string {
  return `remote:${device === null ? "-" : String(device.id)}@${address}`.slice(0, ACTOR_MAX_LENGTH);
}

function setRemoteHeaders(request: FastifyRequest, reply: FastifyReply): void {
  reply.header("strict-transport-security", HSTS);
  // a handler's own CSP (document sandbox, static frame denial) is kept as set
  if (!reply.hasHeader("content-security-policy")) {
    reply.header("content-security-policy", "frame-ancestors 'none'");
    reply.header("x-frame-options", "DENY");
  }
  if (request.url.startsWith("/api/")) reply.header("cache-control", "no-store");
}

// returned from the async hook → Fastify stops the chain at this reply
function refuse(reply: FastifyReply, statusCode: number, error: string): FastifyReply {
  return reply.code(statusCode).send({ error });
}

/** Socket address only → no forwarded header can name the source. */
export function getSourceAddress(request: FastifyRequest): string {
  return request.socket.remoteAddress ?? "";
}
