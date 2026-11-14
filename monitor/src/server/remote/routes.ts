// Remote-only device routes, registered on the remote app alone (never on loopback): the pre-auth code POST that turns
// an accepted registration code into a device cookie, and the caller's own session, logout and off.
// A device action only removes the caller's access or everyone's — it never selects another device, never restores.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DeviceConnections } from "./connections.js";
import { DEVICE, type DeviceCreation, type DeviceSummary } from "./devices.js";
import { type RemoteAuditEvent, type RemoteAuditWriter, getAdmittedDevice, getRemoteActor, getSourceAddress } from "./gate.js";
import { REMOTE_LIMITS, WindowLimiter } from "./limits.js";
import type { RegistrationCodes } from "./registration-code.js";
import { DEVICE_COOKIE, DEVICE_COOKIE_OPTIONS, getCsrfToken } from "./session.js";

export const REMOTE_DEVICE_PATH = {
  REGISTER: "/api/remote/register",
  SESSION: "/api/remote/session",
  LOGOUT: "/api/remote/logout",
  OFF: "/api/remote/off",
} as const;

export interface RemoteRegistrationDeps {
  /** shared with the Mac's loopback page, which opens the code */
  readonly codes: Pick<RegistrationCodes, "consume">;
  readonly createDevice: (label: string) => Promise<DeviceCreation>;
}

export interface RemoteDeviceDeps {
  readonly revoke: (id: bigint) => Promise<boolean>;
  readonly revokeAll: () => Promise<bigint[]>;
  /** closes the remote listener and keeps it closed while the process lives */
  readonly turnOff: () => void;
}

export interface RemoteRoutesDeps {
  readonly registration: RemoteRegistrationDeps;
  readonly device: RemoteDeviceDeps;
  readonly connections: Pick<DeviceConnections, "close">;
  readonly audit: Pick<RemoteAuditWriter, "insertEvent">;
  readonly now?: () => number;
}

interface RegisterBody {
  readonly code: string;
  readonly label: string;
}

const REGISTER_ROUTE_OPTIONS = {
  bodyLimit: 1024,
  schema: {
    body: {
      type: "object",
      required: ["code", "label"],
      additionalProperties: false,
      properties: { code: { type: "string", maxLength: 32 }, label: { type: "string", maxLength: 64 } },
    },
  },
} as const;

// off requests whose handler began → a request refused before it (a body, a failed gate) never closes the listener
const OFF_REQUESTS = new WeakSet<FastifyRequest>();

// logout and off take nothing but the gate's admitted device → any body is refused before the handler
const EMPTY_BODY_OPTIONS = { bodyLimit: 64, onRequest: refuseBody } as const;

export async function registerRemoteDeviceRoutes(app: FastifyInstance, deps: RemoteRoutesDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const perAddress = new WindowLimiter(REMOTE_LIMITS.CODE_PER_ADDRESS, now);
  const total = new WindowLimiter(REMOTE_LIMITS.CODE_TOTAL, now);
  app.post<{ Body: RegisterBody }>(REMOTE_DEVICE_PATH.REGISTER, {
    ...REGISTER_ROUTE_OPTIONS,
    // onRequest → counted before the body is read, so an oversize or malformed entry still spends budget
    onRequest: async (request, reply) => {
      const isWithinBudget = perAddress.hit(getSourceAddress(request)) && total.hit("all");
      return isWithinBudget ? undefined : reply.code(429).send({ error: "too_many_requests" });
    },
    handler: (request, reply) => register(request, reply, deps),
  });
  app.get(REMOTE_DEVICE_PATH.SESSION, (request, reply) => readSession(request, reply));
  app.post(REMOTE_DEVICE_PATH.LOGOUT, { ...EMPTY_BODY_OPTIONS, onResponse: (request) => closeCallerSockets(request, deps) }, (request, reply) =>
    logout(request, reply, deps),
  );
  app.post(REMOTE_DEVICE_PATH.OFF, { ...EMPTY_BODY_OPTIONS, onResponse: (request) => finishOff(request, deps) }, (request, reply) =>
    turnOff(request, reply, deps),
  );
}

async function register(request: FastifyRequest<{ Body: RegisterBody }>, reply: FastifyReply, deps: RemoteRoutesDeps): Promise<FastifyReply> {
  const { code, label } = request.body;
  // label checked before the code → a typo in the label never burns the owner's code
  if (!DEVICE.LABEL_PATTERN.test(label)) return reply.code(400).send({ error: "label_invalid" });
  const anonymous = getRemoteActor(null, getSourceAddress(request));
  if (deps.registration.codes.consume(code) === "refused") {
    recordEvent(request, deps, { actor: anonymous, actionKind: "remote.registration_failure", result: "blocked" });
    return reply.code(400).send({ error: "registration_refused" });
  }
  // the code is spent from here on → every outcome below leaves a row
  const created = await deps.registration.createDevice(label).catch((error: unknown) => {
    recordEvent(request, deps, { actor: anonymous, actionKind: "remote.registration_failure", result: "error" });
    throw error;
  });
  if (created.outcome !== "created") {
    recordEvent(request, deps, { actor: anonymous, actionKind: "remote.registration_failure", result: "blocked" });
    return created.outcome === "cap_reached" ? reply.code(409).send({ error: "device_limit_reached" }) : reply.code(400).send({ error: "label_invalid" });
  }
  return issueDevice(request, reply, { deps, created });
}

function issueDevice(request: FastifyRequest, reply: FastifyReply, input: { deps: RemoteRoutesDeps; created: Extract<DeviceCreation, { outcome: "created" }> }): FastifyReply {
  const { device } = input.created;
  recordEvent(request, input.deps, {
    actor: getRemoteActor(device, getSourceAddress(request)),
    actionKind: "remote.registration_success",
    result: "success",
    targetId: device.id,
  });
  reply.setCookie(DEVICE_COOKIE.NAME, input.created.token, DEVICE_COOKIE_OPTIONS);
  return reply.code(201).send({ device: { id: String(device.id), label: device.label } });
}

async function readSession(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return reply.code(403).send({ error: "not_page_origin" });
  const device = getAdmittedDeviceOrThrow(request);
  const presented = request.cookies[DEVICE_COOKIE.NAME] ?? "";
  return reply.send({ csrf: getCsrfToken(presented), device: { id: String(device.id), label: device.label } });
}

async function logout(request: FastifyRequest, reply: FastifyReply, deps: RemoteRoutesDeps): Promise<FastifyReply> {
  const device = getAdmittedDeviceOrThrow(request);
  const isRevoked = await deps.device.revoke(device.id);
  recordEvent(request, deps, { actor: getActor(request, device), actionKind: "remote.revoke", result: isRevoked ? "success" : "blocked", targetId: device.id });
  // replaces the gate's re-send in the reply's cookie map → the one Set-Cookie expires the device cookie
  reply.clearCookie(DEVICE_COOKIE.NAME, DEVICE_COOKIE_OPTIONS);
  return reply.send({ loggedOut: true });
}

async function turnOff(request: FastifyRequest, reply: FastifyReply, deps: RemoteRoutesDeps): Promise<FastifyReply> {
  const device = getAdmittedDeviceOrThrow(request);
  OFF_REQUESTS.add(request);
  reply.clearCookie(DEVICE_COOKIE.NAME, DEVICE_COOKIE_OPTIONS);
  try {
    const revoked = await deps.device.revokeAll();
    for (const id of revoked) if (id !== device.id) deps.connections.close(id);
  } catch (error) {
    request.log.error({ err: error }, "remote off: device revoke failed — listener closes anyway");
    recordEvent(request, deps, { actor: getActor(request, device), actionKind: "remote.off", result: "error", targetId: device.id });
    return reply.code(500).send({ error: "revoke_failed" });
  }
  recordEvent(request, deps, { actor: getActor(request, device), actionKind: "remote.off", result: "success", targetId: device.id });
  return reply.send({ remoteAccess: "closed" });
}

// after the response → the caller's own socket outlives the reply that tells it so
async function closeCallerSockets(request: FastifyRequest, deps: RemoteRoutesDeps): Promise<void> {
  const device = getAdmittedDevice(request);
  if (device !== null) deps.connections.close(device.id);
}

// onResponse runs on every outcome once the handler began, an errored revoke included; listener first → nothing can keep it open
async function finishOff(request: FastifyRequest, deps: RemoteRoutesDeps): Promise<void> {
  if (!OFF_REQUESTS.has(request)) return;
  deps.device.turnOff();
  await closeCallerSockets(request, deps);
}

async function refuseBody(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const length = request.headers["content-length"];
  const hasBody = request.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
  return hasBody ? reply.code(400).send({ error: "body_not_allowed" }) : undefined;
}

// the gate admits every request these handlers see → a missing device is a wiring fault, never a client state
function getAdmittedDeviceOrThrow(request: FastifyRequest): DeviceSummary {
  const device = getAdmittedDevice(request);
  if (device === null) throw new Error(`remote route reached without an admitted device: ${request.routeOptions.url ?? ""}`);
  return device;
}

function getActor(request: FastifyRequest, device: DeviceSummary): string {
  return getRemoteActor(device, getSourceAddress(request));
}

// fire-and-forget → the owner's action never fails on the audit write; never carries the code or the cookie
function recordEvent(request: FastifyRequest, deps: Pick<RemoteRoutesDeps, "audit">, event: Omit<RemoteAuditEvent, "payload">): void {
  deps.audit.insertEvent({ ...event, payload: { method: request.method, route: request.routeOptions.url ?? "" } }).catch((error: unknown) => {
    request.log.warn({ err: error, actionKind: event.actionKind }, "remote audit event not recorded");
  });
}
