// Remote-access admin routes for the Mac's own page: open a registration code, list devices, revoke one or all.
// Registered by the loopback assembly alone (buildApp) → the remote listener never carries them.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AUDIT_ACTOR } from "../middleware/audit-log.js";
import type { DeviceConnections } from "./connections.js";
import type { DeviceListing } from "./devices.js";
import type { RemoteAuditEvent, RemoteAuditResult } from "./gate.js";
import { WindowLimiter } from "./limits.js";
import type { RegistrationCodes } from "./registration-code.js";

export const REMOTE_ADMIN_PATH = {
  REGISTRATION: "/api/remote/registration",
  DEVICES: "/api/remote/devices",
  DEVICE: "/api/remote/devices/:id",
  REVOKE_ALL: "/api/remote/devices/revoke-all",
} as const;

export const REMOTE_ADMIN_LIMITS = {
  REGISTRATION_OPEN: { limit: 5, windowMs: 60_000 },
} as const;

export interface RemoteAdminDeps {
  /** shared with the remote code POST, which consumes the code */
  readonly codes: Pick<RegistrationCodes, "open">;
  readonly devices: {
    list(): Promise<DeviceListing[]>;
    /** @returns false when the device was unknown or already revoked */
    revoke(id: bigint): Promise<boolean>;
    /** @returns the ids this call revoked */
    revokeAll(): Promise<bigint[]>;
  };
  /** shared with the remote gate → a revoke ends the device's open sockets at once */
  readonly connections: Pick<DeviceConnections, "close">;
  readonly audit: { insertEvent(event: RemoteAuditEvent): Promise<void> };
  readonly now?: () => number;
}

interface DeviceParams {
  readonly id: string;
}

// none of these routes takes input beyond the path id → any body is refused before the handler
const ADMIN_BODY_LIMIT_BYTES = 64;
const DEVICE_PARAMS_SCHEMA = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: "^[1-9][0-9]{0,17}$" } },
  },
} as const;

/** Every route answers only a same-origin page request by fetch metadata; the loopback Host allowlist runs at the root. */
export async function registerRemoteAdminRoutes(app: FastifyInstance, deps: RemoteAdminDeps): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook("onRequest", refuseUnlessMacPage);
    scope.addHook("onSend", async (_request, reply, payload) => {
      reply.header("cache-control", "no-store");
      return payload;
    });
    const openLimiter = new WindowLimiter(REMOTE_ADMIN_LIMITS.REGISTRATION_OPEN, deps.now ?? Date.now);
    const options = { bodyLimit: ADMIN_BODY_LIMIT_BYTES };
    scope.post(REMOTE_ADMIN_PATH.REGISTRATION, options, (request, reply) => openRegistration(request, reply, { deps, openLimiter }));
    scope.get(REMOTE_ADMIN_PATH.DEVICES, () => listDevices(deps));
    scope.delete<{ Params: DeviceParams }>(REMOTE_ADMIN_PATH.DEVICE, { ...options, schema: DEVICE_PARAMS_SCHEMA }, (request, reply) =>
      revokeOne(request, reply, deps),
    );
    scope.post(REMOTE_ADMIN_PATH.REVOKE_ALL, options, (request) => revokeAll(request, deps));
  });
}

// GET included: the root request guard never judges a GET, and a device list is not for a neighbour page
async function refuseUnlessMacPage(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  if (request.headers["sec-fetch-site"] !== "same-origin") return reply.code(403).send({ error: "not_mac_page" });
  if (hasBody(request)) return reply.code(400).send({ error: "body_not_allowed" });
  return undefined;
}

function hasBody(request: FastifyRequest): boolean {
  const length = request.headers["content-length"];
  return request.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
}

async function openRegistration(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { deps: RemoteAdminDeps; openLimiter: WindowLimiter },
): Promise<FastifyReply> {
  if (!input.openLimiter.hit("all")) return reply.code(429).send({ error: "too_many_requests" });
  try {
    // row first → a registration the trail does not show is never opened
    await input.deps.audit.insertEvent(buildAdminEvent(request, "remote.registration_opened", "success"));
  } catch (error) {
    request.log.error({ err: error }, "remote registration not opened: audit row not written");
    return reply.code(503).send({ error: "audit_unavailable" });
  }
  return reply.send({ code: input.deps.codes.open() });
}

async function listDevices(deps: RemoteAdminDeps): Promise<{ devices: Record<string, string>[] }> {
  const devices = await deps.devices.list();
  return {
    devices: devices.map((device) => ({
      id: String(device.id),
      label: device.label,
      createdAt: device.createdAt.toISOString(),
      lastSeenAt: device.lastSeenAt.toISOString(),
    })),
  };
}

async function revokeOne(request: FastifyRequest<{ Params: DeviceParams }>, reply: FastifyReply, deps: RemoteAdminDeps): Promise<FastifyReply> {
  const id = BigInt(request.params.id);
  const isRevoked = await deps.devices.revoke(id);
  if (isRevoked) deps.connections.close(id);
  recordEvent(request, deps, { ...buildAdminEvent(request, "remote.revoke", isRevoked ? "success" : "blocked"), targetId: id });
  return isRevoked ? reply.send({ revoked: 1 }) : reply.code(404).send({ error: "device_not_found" });
}

async function revokeAll(request: FastifyRequest, deps: RemoteAdminDeps): Promise<{ revoked: number }> {
  const revoked = await deps.devices.revokeAll();
  for (const id of revoked) deps.connections.close(id);
  const event = buildAdminEvent(request, "remote.revoke", "success");
  recordEvent(request, deps, { ...event, payload: { method: request.method, route: REMOTE_ADMIN_PATH.REVOKE_ALL, count: revoked.length } });
  return { revoked: revoked.length };
}

function buildAdminEvent(request: FastifyRequest, actionKind: string, result: RemoteAuditResult): RemoteAuditEvent {
  return { actor: AUDIT_ACTOR, actionKind, result, payload: { method: request.method, route: request.routeOptions.url ?? "" } };
}

// after the revoke, fire-and-forget → an audit failure never keeps a device registered
function recordEvent(request: FastifyRequest, deps: RemoteAdminDeps, event: RemoteAuditEvent): void {
  deps.audit.insertEvent(event).catch((error: unknown) => {
    request.log.warn({ err: error, actionKind: event.actionKind }, "remote audit event not recorded");
  });
}
