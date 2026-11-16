// Remote-access routes for the glass-atrium CLI: list devices, revoke one or all — reduce-only, no registration.
// Registered by the loopback assembly alone (buildApp) → the remote listener never carries them; the gate stops any browser page.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { isLoopbackHost } from "../host-guard.js";
import { setNoStoreHeader } from "../response-headers.js";
import { DEVICE_PARAMS_SCHEMA, type DeviceActDeps, type DeviceParams, getDeviceList, revokeAll, revokeOne } from "./admin-routes.js";
import { recordEvent } from "./gate.js";
import { WindowLimiter } from "./limits.js";
import { EMPTY_BODY_LIMIT_BYTES, hasBody } from "./request-body.js";

export const REMOTE_CLI_PATH = {
  DEVICES: "/api/remote/cli/devices",
  DEVICE: "/api/remote/cli/devices/:id",
  REVOKE_ALL: "/api/remote/cli/devices/revoke-all",
} as const;

/** A non-safelisted header → a cross-origin page cannot send it without a preflight, which no route here allows. */
export const REMOTE_CLI_HEADER = { NAME: "x-glass-atrium-cli", VALUE: "remote-access" } as const;

export const REMOTE_CLI_LIMITS = {
  REQUESTS: { limit: 30, windowMs: 60_000 },
} as const;

// differs from the page's AUDIT_ACTOR → audit rows tell CLI acts from page acts
export const REMOTE_CLI_ACTOR = "monitor-cli";

export interface RemoteCliDeps extends DeviceActDeps {
  readonly now?: () => number;
}

// any one of these marks a browser request → never the CLI, which sends none of them
const BROWSER_HEADERS = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "origin", "referer", "cookie"] as const;

/** The loopback Host allowlist runs at the root; this scope adds the CLI header, the browser-header ban and the loopback socket. */
export async function registerRemoteCliRoutes(app: FastifyInstance, deps: RemoteCliDeps): Promise<void> {
  await app.register(async (scope) => {
    const limiter = new WindowLimiter(REMOTE_CLI_LIMITS.REQUESTS, deps.now ?? Date.now);
    scope.addHook("onRequest", (request, reply) => refuseUnlessCli(request, reply, limiter));
    scope.addHook("onSend", setNoStoreHeader);
    const act = { deps, actor: REMOTE_CLI_ACTOR };
    const options = { bodyLimit: EMPTY_BODY_LIMIT_BYTES };
    scope.get(REMOTE_CLI_PATH.DEVICES, (request) => listDevices(request, deps));
    scope.delete<{ Params: DeviceParams }>(REMOTE_CLI_PATH.DEVICE, { ...options, schema: DEVICE_PARAMS_SCHEMA }, (request, reply) =>
      revokeOne(request, reply, act),
    );
    scope.post(REMOTE_CLI_PATH.REVOKE_ALL, options, (request) => revokeAll(request, act));
  });
}

async function refuseUnlessCli(request: FastifyRequest, reply: FastifyReply, limiter: WindowLimiter): Promise<FastifyReply | undefined> {
  if (BROWSER_HEADERS.some((name) => request.headers[name] !== undefined)) return reply.code(403).send({ error: "not_cli" });
  if (request.headers[REMOTE_CLI_HEADER.NAME] !== REMOTE_CLI_HEADER.VALUE) return reply.code(403).send({ error: "not_cli" });
  if (!isLoopbackHost(request.socket.remoteAddress ?? "")) return reply.code(403).send({ error: "not_loopback" });
  if (!limiter.hit("all")) return reply.code(429).send({ error: "too_many_requests" });
  if (hasBody(request)) return reply.code(400).send({ error: "body_not_allowed" });
  return undefined;
}

async function listDevices(request: FastifyRequest, deps: RemoteCliDeps): Promise<{ devices: Record<string, string>[] }> {
  const list = await getDeviceList(deps);
  recordEvent(request, deps.audit, { actor: REMOTE_CLI_ACTOR, actionKind: "remote.devices_listed", result: "success" });
  return list;
}
