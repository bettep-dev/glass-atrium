// Remote listener gate, registered at the root before any route: Host → limits → registered device → route class →
// page origin + CSRF on mutations → audit row before the handler. Loopback never loads it.

import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { MUTATION_METHODS, getPageOriginSignal } from "../request-guards.js";
import { type AuditChangeCarrier, type AuditTarget, deriveResultCode, extractTargetId } from "../middleware/audit-log.js";
import type { DeviceConnections } from "./connections.js";
import type { DeviceSummary } from "./devices.js";
import { REMOTE_LIMITS, WindowLimiter } from "./limits.js";
import type { RouteClass } from "./route-classes.js";
import { CSRF_HEADER, DEVICE_COOKIE, DEVICE_COOKIE_OPTIONS, isCsrfTokenValid } from "./session.js";

export interface RemoteAuditEntry {
  readonly actor: string;
  readonly method: string;
  readonly route: string;
  /** numeric :id / :rootId of the route → known before the handler; null when the route has none */
  readonly targetId?: bigint | null;
}

export type RemoteAuditResult = "success" | "blocked" | "error";

/** A remote-access event recorded with its outcome in one row (auth failure, denied route, registration, revoke). */
export interface RemoteAuditEvent {
  readonly actor: string;
  readonly actionKind: string;
  readonly result: RemoteAuditResult;
  /** route events carry method + route; boot and count events carry their own numbers — never a credential or source address */
  readonly payload?: Readonly<Record<string, string | number>>;
  /** remote_devices row the event concerns */
  readonly targetId?: bigint;
}

export interface RemoteAuditWriter {
  /** @returns the row id; the row starts as `error` so a crash mid-handler stays recorded as not succeeded */
  insertIntent(entry: RemoteAuditEntry): Promise<bigint>;
  /** target → the handler's curated AuditChangeCarrier value, recorded with the outcome */
  setResult(id: bigint, result: RemoteAuditResult, target?: AuditTarget): Promise<void>;
  insertEvent(event: RemoteAuditEvent): Promise<void>;
}

export interface RemoteGateDeps {
  readonly getHosts: () => ReadonlySet<string>;
  readonly getPageOrigins: () => ReadonlySet<string>;
  readonly findDevice: (presented: string) => Promise<DeviceSummary | null>;
  readonly getRouteClass: (method: string, routePath: string) => RouteClass | null;
  /** `METHOD /path` keys answered without a registered device → route-classes.ts REMOTE_PRE_AUTH_ROUTES */
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
const STATIC_WILDCARD = "/*";
const SIGN_IN_PAGE = "/sign-in.html";
const ACTOR_MAX_LENGTH = 64;
// an unmatched path is caller-chosen → bounded before it reaches the audit payload
const ROUTE_MAX_LENGTH = 256;
// reduce-only closes → they run even when their intent row cannot be written
const REDUCE_ONLY_ROUTES = new Set(["POST /api/remote/off", "POST /api/remote/logout"]);
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
  app.addHook("onResponse", (request, reply) =>
    closeAuditResult(request, reply, {
      audit: deps.audit,
      auditId: ADMITTED.get(request)?.auditId,
      target: (request as FastifyRequest & AuditChangeCarrier).auditChange,
    }),
  );
  app.setErrorHandler(replyOpaqueError);
}

// a status the page names to its reader keeps a fixed code of its own; every other 4xx shares one
const OPAQUE_CLIENT_ERROR_CODES: ReadonlyMap<number, string> = new Map([
  [413, "payload_too_large"],
  [415, "unsupported_media_type"],
]);

// a thrown error's message, code and schema text never reach a remote caller → status + a fixed code
function replyOpaqueError(error: { statusCode?: number }, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const statusCode = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
  if (statusCode === 500) request.log.error({ err: error, method: request.method, route: request.routeOptions.url }, "remote request failed");
  return refuse(reply, statusCode, statusCode === 500 ? "internal_error" : (OPAQUE_CLIENT_ERROR_CODES.get(statusCode) ?? "bad_request"));
}

async function admitRequest(request: FastifyRequest, reply: FastifyReply, deps: RemoteGateDeps, limiters: Limiters): Promise<FastifyReply | undefined> {
  if (!deps.getHosts().has((request.headers.host ?? "").toLowerCase())) return refuse(reply, 403, "host_not_allowed");
  const address = getSourceAddress(request);
  if (limiters.failedSession.isBlocked(address)) return refuse(reply, 429, "too_many_requests");
  const routePath = request.routeOptions.url;
  // HEAD follows its GET, as getRouteClass does → a GET row also answers the HEAD Fastify exposes for it
  const preAuthMethod = request.method === "HEAD" ? "GET" : request.method;
  if (routePath !== undefined && deps.preAuthRoutes.has(`${preAuthMethod} ${routePath}`)) {
    if (!limiters.preAuth.hit(address)) return refuse(reply, 429, "too_many_requests");
    // no device yet → no CSRF value; the page origin alone stands between a neighbour page and the code POST
    const isFromPage = !MUTATION_METHODS.has(request.method) || getPageOriginSignal(request.headers, deps.getPageOrigins()) !== null;
    return isFromPage ? undefined : refuse(reply, 403, "not_page_origin");
  }
  return admitPresentedDevice(request, reply, deps, limiters);
}

async function admitPresentedDevice(request: FastifyRequest, reply: FastifyReply, deps: RemoteGateDeps, limiters: Limiters): Promise<FastifyReply | undefined> {
  const presented = request.cookies[DEVICE_COOKIE.NAME];
  if (presented === undefined || presented.length === 0) return refuseUnregistered(request, reply, deps);
  let device: DeviceSummary | null;
  try {
    device = await deps.findDevice(presented);
  } catch (error) {
    request.log.error({ err: error, method: request.method }, "remote request refused: device lookup failed");
    return refuse(reply, 503, "device_lookup_unavailable");
  }
  const address = getSourceAddress(request);
  if (device === null) {
    // an absent cookie is a first visit, not a failed credential → only a presented, unknown one counts and is audited
    limiters.failedSession.hit(address);
    recordEvent(request, deps.audit, { actor: getRemoteActor(null, address), actionKind: "remote.auth_failure", result: "blocked" }, getRequestedRoute);
    return refuseUnregistered(request, reply, deps);
  }
  return admitDevice(request, reply, { deps, limiters, device, presented });
}

// the bare address an owner types → the sign-in page when its row is signed; any other path gets the 401
function refuseUnregistered(request: FastifyRequest, reply: FastifyReply, deps: RemoteGateDeps): FastifyReply {
  const isRootDocument = (request.method === "GET" || request.method === "HEAD") && request.url === "/";
  if (isRootDocument && deps.preAuthRoutes.has(`GET ${SIGN_IN_PAGE}`)) return reply.code(303).redirect(SIGN_IN_PAGE);
  return refuse(reply, 401, "not_registered");
}

async function admitDevice(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { deps: RemoteGateDeps; limiters: Limiters; device: DeviceSummary; presented: string },
): Promise<FastifyReply | undefined> {
  const { deps, limiters, device, presented } = input;
  const routePath = request.routeOptions.url;
  // an /api/ path no route claims falls through to the static wildcard → never a page file, refused like an unknown route
  const isUnclaimedApi = routePath === STATIC_WILDCARD && request.url.startsWith("/api/");
  const routeClass = routePath === undefined || isUnclaimedApi ? null : deps.getRouteClass(request.method, routePath);
  if (routeClass !== "page" && routeClass !== "remote-device") {
    const event = { actor: getRemoteActor(device, getSourceAddress(request)), actionKind: "remote.route_denied", result: "blocked" } as const;
    recordEvent(request, deps.audit, event, getRequestedRoute);
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
    state.auditId = await audit.insertIntent({ actor, method: request.method, route, targetId: extractTargetId(request) });
  } catch (error) {
    if (REDUCE_ONLY_ROUTES.has(`${request.method} ${route}`)) {
      request.log.warn({ err: error, method: request.method, route }, "remote close runs without its audit intent row");
      return undefined;
    }
    request.log.error({ err: error, method: request.method, route }, "remote mutation refused: audit intent row not written");
    return refuse(reply, 503, "audit_unavailable");
  }
  return undefined;
}

/** Closes an intent row with the reply's status; a failed write leaves it `error` → the trail never over-reports a success. */
export async function closeAuditResult(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { audit: Pick<RemoteAuditWriter, "setResult">; auditId: bigint | undefined; target?: AuditTarget },
): Promise<void> {
  if (input.auditId === undefined) return;
  try {
    await input.audit.setResult(input.auditId, deriveResultCode(reply.statusCode), input.target);
  } catch (error) {
    request.log.warn({ err: error, auditId: String(input.auditId) }, "remote audit result not recorded");
  }
}

/** The route an event's payload names → the matched route unless the caller resolves its own. */
export type RouteResolver = (request: FastifyRequest) => string;

const getMatchedRoute: RouteResolver = (request) => request.routeOptions.url ?? "";

/** Method + route → every route event's payload; never a credential or source address. */
export function getRoutePayload(request: FastifyRequest, getRoute: RouteResolver = getMatchedRoute): { method: string; route: string } {
  return { method: request.method, route: getRoute(request) };
}

/**
 * Fire-and-forget remote audit event → a reply is never delayed or turned into a 500 by the audit write.
 * @param event - its payload, when given, adds the event's own numbers beside the method and route
 */
export function recordEvent(
  request: FastifyRequest,
  audit: Pick<RemoteAuditWriter, "insertEvent">,
  event: RemoteAuditEvent,
  getRoute: RouteResolver = getMatchedRoute,
): void {
  audit.insertEvent({ ...event, payload: { ...getRoutePayload(request, getRoute), ...event.payload } }).catch((error: unknown) => {
    request.log.warn({ err: error, actionKind: event.actionKind }, "remote audit event not recorded");
  });
}

// the static wildcard names no path → the asked path, so a refused /api read shows what it tried
function getRequestedRoute(request: FastifyRequest): string {
  const matched = request.routeOptions.url;
  const route = matched === undefined || matched === STATIC_WILDCARD ? (request.url.split("?")[0] ?? "") : matched;
  return route.slice(0, ROUTE_MAX_LENGTH);
}

/** The device the gate admitted this request for; null on loopback, pre-auth and refused requests. */
export function getAdmittedDevice(request: FastifyRequest): DeviceSummary | null {
  return ADMITTED.get(request)?.device ?? null;
}

/** `remote:<device id | ->@<source address>` → fits audit_log.actor (64) for an IPv4 source. */
export function getRemoteActor(device: DeviceSummary | null, address: string): string {
  return `remote:${device === null ? "-" : String(device.id)}@${address}`.slice(0, ACTOR_MAX_LENGTH);
}

function setRemoteHeaders(request: FastifyRequest, reply: FastifyReply): void {
  reply.header("strict-transport-security", HSTS);
  reply.header("x-content-type-options", "nosniff");
  // a handler's own CSP (document sandbox, static frame denial) is kept as set
  if (!reply.hasHeader("content-security-policy")) {
    reply.header("content-security-policy", "frame-ancestors 'none'");
    reply.header("x-frame-options", "DENY");
  }
  // API → never stored; a page file → revalidated each load, so a device never runs a stale shell or sign-in file
  reply.header("cache-control", request.url.startsWith("/api/") ? "no-store" : "no-cache");
}

// returned from the async hook → Fastify stops the chain at this reply
function refuse(reply: FastifyReply, statusCode: number, error: string): FastifyReply {
  return reply.code(statusCode).send({ error });
}

/** Socket address only → no forwarded header can name the source. */
export function getSourceAddress(request: FastifyRequest): string {
  return request.socket.remoteAddress ?? "";
}
