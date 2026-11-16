// Remote-access admin routes for the Mac's own page: open a registration code, list devices, revoke one or all.
// Registered by the loopback assembly alone (buildApp) → the remote listener never carries them.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AUDIT_ACTOR } from "../middleware/audit-log.js";
import { setNoStoreHeader } from "../response-headers.js";
import type { DeviceConnections } from "./connections.js";
import type { DeviceListing } from "./devices.js";
import { type RemoteAuditEvent, getRoutePayload, recordEvent } from "./gate.js";
import { WindowLimiter } from "./limits.js";
import type { TrustedNetwork } from "./network.js";
import type { RegistrationCodes } from "./registration-code.js";
import { EMPTY_BODY_LIMIT_BYTES, hasBody } from "./request-body.js";

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
  /** the Mac page's view of the feature: on in this process, and the networks it opens on */
  readonly getAccess: () => RemoteAccessState;
  readonly now?: () => number;
}

export interface RemoteAccessState {
  readonly enabled: boolean;
  readonly trusted: readonly TrustedNetwork[];
}

/** The acts the Mac page and the CLI share → one code path per act (revoke → close sockets → audit). */
export type DeviceActDeps = Pick<RemoteAdminDeps, "devices" | "connections" | "audit">;

export interface DeviceParams {
  readonly id: string;
}

export const DEVICE_PARAMS_SCHEMA = {
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
    scope.addHook("onSend", setNoStoreHeader);
    const openLimiter = new WindowLimiter(REMOTE_ADMIN_LIMITS.REGISTRATION_OPEN, deps.now ?? Date.now);
    const options = { bodyLimit: EMPTY_BODY_LIMIT_BYTES };
    scope.post(REMOTE_ADMIN_PATH.REGISTRATION, options, (request, reply) => openRegistration(request, reply, { deps, openLimiter }));
    scope.get(REMOTE_ADMIN_PATH.DEVICES, async () => ({ ...(await getDeviceList(deps)), access: getAccessView(deps.getAccess()) }));
    scope.delete<{ Params: DeviceParams }>(REMOTE_ADMIN_PATH.DEVICE, { ...options, schema: DEVICE_PARAMS_SCHEMA }, (request, reply) =>
      revokeOne(request, reply, { deps, actor: AUDIT_ACTOR }),
    );
    scope.post(REMOTE_ADMIN_PATH.REVOKE_ALL, options, (request) => revokeAll(request, { deps, actor: AUDIT_ACTOR }));
  });
}

// GET included: the root request guard never judges a GET, and a device list is not for a neighbour page
async function refuseUnlessMacPage(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  if (request.headers["sec-fetch-site"] !== "same-origin") return reply.code(403).send({ error: "not_mac_page" });
  if (hasBody(request)) return reply.code(400).send({ error: "body_not_allowed" });
  return undefined;
}

async function openRegistration(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { deps: RemoteAdminDeps; openLimiter: WindowLimiter },
): Promise<FastifyReply> {
  if (!input.openLimiter.hit("all")) return reply.code(429).send({ error: "too_many_requests" });
  try {
    // row first → a registration the trail does not show is never opened
    await input.deps.audit.insertEvent({ actor: AUDIT_ACTOR, actionKind: "remote.registration_opened", result: "success", payload: getRoutePayload(request) });
  } catch (error) {
    request.log.error({ err: error }, "remote registration not opened: audit row not written");
    return reply.code(503).send({ error: "audit_unavailable" });
  }
  return reply.send({ code: input.deps.codes.open() });
}

export async function getDeviceList(deps: Pick<RemoteAdminDeps, "devices">): Promise<{ devices: Record<string, string>[] }> {
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

/** Field by field, as the signed row names them → a wider value from the caller (port, paths, interface) never reaches the page. */
function getAccessView(access: RemoteAccessState): RemoteAccessState {
  return {
    enabled: access.enabled,
    trusted: access.trusted.map((network) => ({ gateway: network.gateway, hardwareAddress: network.hardwareAddress })),
  };
}

interface DeviceAct {
  readonly deps: DeviceActDeps;
  /** names the channel in the audit row → page and CLI revokes stay distinguishable */
  readonly actor: string;
}

export async function revokeOne(request: FastifyRequest<{ Params: DeviceParams }>, reply: FastifyReply, act: DeviceAct): Promise<FastifyReply> {
  const id = BigInt(request.params.id);
  const isRevoked = await act.deps.devices.revoke(id);
  if (isRevoked) act.deps.connections.close(id);
  recordEvent(request, act.deps.audit, { actor: act.actor, actionKind: "remote.revoke", result: isRevoked ? "success" : "blocked", targetId: id });
  return isRevoked ? reply.send({ revoked: 1 }) : reply.code(404).send({ error: "device_not_found" });
}

export async function revokeAll(request: FastifyRequest, act: DeviceAct): Promise<{ revoked: number }> {
  const revoked = await act.deps.devices.revokeAll();
  for (const id of revoked) act.deps.connections.close(id);
  recordEvent(request, act.deps.audit, { actor: act.actor, actionKind: "remote.revoke", result: "success", payload: { count: revoked.length } });
  return { revoked: revoked.length };
}
