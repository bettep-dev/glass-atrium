// Remote-only device routes, registered on the remote app alone (never on loopback, so no reviewer route class applies).
// The code POST is the one pre-auth mutation: it turns an accepted registration code into a device cookie.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { DEVICE, type DeviceCreation } from "./devices.js";
import { type RemoteAuditEvent, type RemoteAuditWriter, getRemoteActor, getSourceAddress } from "./gate.js";
import { REMOTE_LIMITS, WindowLimiter } from "./limits.js";
import type { RegistrationCodes } from "./registration-code.js";
import { DEVICE_COOKIE, DEVICE_COOKIE_OPTIONS } from "./session.js";

const REGISTER_PATH = "/api/remote/register";

/** `METHOD /path` keys the gate answers without a registered device; the sign-in page and its assets join with S4. */
export const REMOTE_PRE_AUTH_ROUTES: ReadonlySet<string> = new Set([`POST ${REGISTER_PATH}`]);

export interface RemoteRegistrationDeps {
  /** shared with the Mac's loopback page, which opens the code */
  readonly codes: Pick<RegistrationCodes, "consume">;
  readonly createDevice: (label: string) => Promise<DeviceCreation>;
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

export async function registerRemoteDeviceRoutes(
  app: FastifyInstance,
  deps: RemoteRegistrationDeps & { readonly audit: Pick<RemoteAuditWriter, "insertEvent">; readonly now?: () => number },
): Promise<void> {
  const now = deps.now ?? Date.now;
  const perAddress = new WindowLimiter(REMOTE_LIMITS.CODE_PER_ADDRESS, now);
  const total = new WindowLimiter(REMOTE_LIMITS.CODE_TOTAL, now);
  app.post<{ Body: RegisterBody }>(REGISTER_PATH, {
    ...REGISTER_ROUTE_OPTIONS,
    // onRequest → counted before the body is read, so an oversize or malformed entry still spends budget
    onRequest: async (request, reply) => {
      const isWithinBudget = perAddress.hit(getSourceAddress(request)) && total.hit("all");
      return isWithinBudget ? undefined : reply.code(429).send({ error: "too_many_requests" });
    },
    handler: (request, reply) => register(request, reply, deps),
  });
}

async function register(
  request: FastifyRequest<{ Body: RegisterBody }>,
  reply: FastifyReply,
  deps: RemoteRegistrationDeps & { readonly audit: Pick<RemoteAuditWriter, "insertEvent"> },
): Promise<FastifyReply> {
  const { code, label } = request.body;
  // label checked before the code → a typo in the label never burns the owner's code
  if (!DEVICE.LABEL_PATTERN.test(label)) return reply.code(400).send({ error: "label_invalid" });
  const address = getSourceAddress(request);
  if (deps.codes.consume(code) === "refused") {
    recordEvent(request, deps.audit, { actor: getRemoteActor(null, address), actionKind: "remote.registration_failure", result: "blocked" });
    return reply.code(400).send({ error: "registration_refused" });
  }
  const created = await deps.createDevice(label);
  if (created.outcome === "cap_reached") return reply.code(409).send({ error: "device_limit_reached" });
  if (created.outcome === "label_invalid") return reply.code(400).send({ error: "label_invalid" });
  const { device } = created;
  recordEvent(request, deps.audit, {
    actor: getRemoteActor(device, address),
    actionKind: "remote.registration_success",
    result: "success",
    targetId: device.id,
  });
  reply.setCookie(DEVICE_COOKIE.NAME, created.token, DEVICE_COOKIE_OPTIONS);
  return reply.code(201).send({ device: { id: String(device.id), label: device.label } });
}

// fire-and-forget → the owner's registration never fails on the audit write; never carries the code or the cookie
function recordEvent(request: FastifyRequest, audit: Pick<RemoteAuditWriter, "insertEvent">, event: Omit<RemoteAuditEvent, "payload">): void {
  audit.insertEvent({ ...event, payload: { method: request.method, route: REGISTER_PATH } }).catch((error: unknown) => {
    request.log.warn({ err: error, actionKind: event.actionKind }, "remote audit event not recorded");
  });
}
