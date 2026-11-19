// Remote-access admin routes for the Mac's own page: open a registration code, list devices, revoke one or all,
// turn access on or off, trust this network, read the setup facts and download the CA certificate.
// Registered by the loopback assembly alone (buildApp) → the remote listener never carries them.

import { X509Certificate } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AUDIT_ACTOR } from "../middleware/audit-log.js";
import { getPageOriginSignal } from "../request-guards.js";
import { getAttachmentDisposition, setNoStoreHeader } from "../response-headers.js";
import type { DeviceConnections } from "./connections.js";
import type { DeviceListing } from "./devices.js";
import { type RemoteAuditEvent, getRoutePayload, recordEvent } from "./gate.js";
import { type WindowLimit, WindowLimiter, buildWindowLimitHook } from "./limits.js";
import type { ListenReason, NetworkLink } from "./network.js";
import type { RegistrationCodes } from "./registration-code.js";
import { EMPTY_BODY_LIMIT_BYTES, hasBody } from "./request-body.js";

export const REMOTE_ADMIN_PATH = {
  REGISTRATION: "/api/remote/registration",
  DEVICES: "/api/remote/devices",
  DEVICE: "/api/remote/devices/:id",
  REVOKE_ALL: "/api/remote/devices/revoke-all",
  ACCESS_ON: "/api/remote/access/on",
  // never POST /api/remote/off → that path is the device's own off, another class
  ACCESS_OFF: "/api/remote/access/off",
  TRUST: "/api/remote/access/trust",
  // read when a turn-on or trust confirm opens → the act then refuses any other network
  CONFIRM_NETWORK: "/api/remote/access/network",
  SETUP: "/api/remote/setup",
  CERTIFICATE: "/api/remote/certificate",
} as const;

/** Set only by the page's own script → a document's form, link ping or image request at a same-origin route never carries it. */
export const MAC_PAGE_HEADER = { NAME: "x-glass-atrium-page", VALUE: "remote-access" } as const;

export const REMOTE_ADMIN_LIMITS = {
  REGISTRATION_OPEN: { limit: 5, windowMs: 60_000 },
  // on and trust together → each runs the shell step
  ACCESS_WIDEN: { limit: 5, windowMs: 60_000 },
  // its own budget → widening acts never use up the off
  ACCESS_OFF: { limit: 10, windowMs: 60_000 },
  // the screen polls it; each read runs the network commands
  SETUP_READ: { limit: 60, windowMs: 60_000 },
  CERTIFICATE_READ: { limit: 10, windowMs: 60_000 },
  // one per opened confirm, its re-read after a refusal included; each runs the network commands
  CONFIRM_READ: { limit: 20, windowMs: 60_000 },
} as const;

/** How long the off and a widening act wait on a store call, the listener close or its reopen → a stalled call counts as failed. */
const WAIT_TIMEOUT_MS = 5_000;

// the whole file one certificate block → the download carries nothing outside the fingerprint shown
const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n-----END CERTIFICATE-----\r?\n?$/;

/** The one file the download serves, under a fixed name and type → never a caller-named file; the page saves it under this name. */
export const CA_DOWNLOAD = { FILE_NAME: "Glass Atrium Local CA.pem", CONTENT_TYPE: "application/x-x509-ca-cert" } as const;

/** What the shell's write step reported. */
export type AccessStepOutcome =
  | "written"
  | "network_unreadable"
  | "keys_not_created"
  | "env_not_rendered"
  | "already_trusted"
  | "network_changed"
  // config.toml's trusted list does not parse → a fault on this Mac, never the network
  | "config_malformed"
  | "write_failed";

/** Refused before any step: no confirm read in force, or the network differs from the one it showed. */
export type ConfirmRefusal = "confirm_stale" | "network_changed";

/**
 * start_failed → the step wrote, this process could not apply it; the next restart does.
 * act_failed → the act threw → what it wrote is unknown until the next restart.
 */
export type AccessApplyOutcome = AccessStepOutcome | "start_failed" | "act_failed" | ConfirmRefusal;

export interface AccessApplyResult {
  readonly outcome: AccessApplyOutcome;
  /** trusted networks after the apply; null when nothing was applied */
  readonly trustedCount: number | null;
}

export interface TurnOnResult extends AccessApplyResult {
  /** the trust of the network shown, in the same act; null when none was tried (the on did not write, or the network was trusted) */
  readonly trust: AccessApplyResult | null;
}

/** What a turn-on or trust confirm shows: the router the act would trust, never its hardware address. */
export interface ConfirmFacts {
  /** null when no router was read → no confirm opens */
  readonly router: string | null;
  readonly link: NetworkLink;
  readonly isNetworkTrusted: boolean;
}

export interface SetupFacts {
  /** on in config and not turned off by a device */
  readonly enabled: boolean;
  readonly isOffByDevice: boolean;
  readonly listenReason: ListenReason;
  readonly hasRouter: boolean;
  readonly isNetworkTrusted: boolean;
  readonly trustedCount: number;
  /** the remote listener is open in this process */
  readonly isAnswering: boolean;
  /** `<name>.local`; null when unreadable */
  readonly hostName: string | null;
  /** the Wi-Fi interface's address; null when unreadable */
  readonly address: string | null;
  readonly port: number;
  readonly deviceLimit: number;
}

/** The Mac page's on, off and trust: the shell step writes, this process applies. */
export interface RemoteAccessActs {
  /** remembers the network it read → the next on or trust acts on that network or refuses */
  getConfirmFacts(): Promise<ConfirmFacts>;
  /** on, then the trust of the network shown when it is not trusted yet */
  turnOn(): Promise<TurnOnResult>;
  trust(): Promise<AccessApplyResult>;
  /** persists the off only → the route revokes and closes */
  setOff(): Promise<AccessStepOutcome>;
  /** closes the listener; stays closed until the next on */
  close(): Promise<void>;
  getSetupFacts(): Promise<SetupFacts>;
  /** the CA certificate file's bytes; null when none was created */
  readCertificate(): Promise<Buffer | null>;
}

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
  readonly access: RemoteAccessActs;
  readonly now?: () => number;
  /** tests pass a short one; WAIT_TIMEOUT_MS otherwise */
  readonly waitTimeoutMs?: number;
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

/** Every route answers only the page's own script, same-origin by fetch metadata; the loopback Host allowlist runs at the root. */
export async function registerRemoteAdminRoutes(app: FastifyInstance, deps: RemoteAdminDeps): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook("onRequest", refuseUnlessMacPage);
    scope.addHook("onSend", setNoStoreHeader);
    const options = { bodyLimit: EMPTY_BODY_LIMIT_BYTES };
    const openOptions = { ...options, preHandler: buildLimitHook(REMOTE_ADMIN_LIMITS.REGISTRATION_OPEN, deps) };
    scope.post(REMOTE_ADMIN_PATH.REGISTRATION, openOptions, (request, reply) => openRegistration(request, reply, deps));
    scope.get(REMOTE_ADMIN_PATH.DEVICES, () => getDeviceList(deps));
    scope.delete<{ Params: DeviceParams }>(REMOTE_ADMIN_PATH.DEVICE, { ...options, schema: DEVICE_PARAMS_SCHEMA }, (request, reply) =>
      revokeOne(request, reply, { deps, actor: AUDIT_ACTOR }),
    );
    scope.post(REMOTE_ADMIN_PATH.REVOKE_ALL, options, (request) => revokeAll(request, { deps, actor: AUDIT_ACTOR }));
    registerAccessRoutes(scope, deps);
  });
}

function registerAccessRoutes(scope: FastifyInstance, deps: RemoteAdminDeps): void {
  const route = { deps, queue: new ActQueue() };
  const options = { bodyLimit: EMPTY_BODY_LIMIT_BYTES };
  // one hook for on and trust → one shared budget
  const widenOptions = { ...options, preHandler: buildLimitHook(REMOTE_ADMIN_LIMITS.ACCESS_WIDEN, deps) };
  scope.post(REMOTE_ADMIN_PATH.ACCESS_ON, widenOptions, (request, reply) => widenAccess(request, reply, { ...route, act: "on" }));
  scope.post(REMOTE_ADMIN_PATH.TRUST, widenOptions, (request, reply) => widenAccess(request, reply, { ...route, act: "trust" }));
  scope.post(REMOTE_ADMIN_PATH.ACCESS_OFF, { ...options, preHandler: buildLimitHook(REMOTE_ADMIN_LIMITS.ACCESS_OFF, deps) }, (request, reply) =>
    turnOffAccess(request, reply, route),
  );
  scope.get(REMOTE_ADMIN_PATH.CONFIRM_NETWORK, { preHandler: buildLimitHook(REMOTE_ADMIN_LIMITS.CONFIRM_READ, deps) }, (_request, reply) =>
    getConfirmNetwork(reply, deps),
  );
  scope.get(REMOTE_ADMIN_PATH.SETUP, { preHandler: buildLimitHook(REMOTE_ADMIN_LIMITS.SETUP_READ, deps) }, (request, reply) => getSetup(request, reply, deps));
  scope.get(REMOTE_ADMIN_PATH.CERTIFICATE, { preHandler: buildLimitHook(REMOTE_ADMIN_LIMITS.CERTIFICATE_READ, deps) }, (request, reply) =>
    getCertificateFile(request, reply, deps),
  );
}

function buildLimitHook(limit: WindowLimit, deps: Pick<RemoteAdminDeps, "now">): ReturnType<typeof buildWindowLimitHook> {
  return buildWindowLimitHook(new WindowLimiter(limit, deps.now ?? Date.now));
}

// GET included: the root request guard never judges a GET, and a device list is not for a neighbour page or a document's image
async function refuseUnlessMacPage(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  if (request.headers["sec-fetch-site"] !== "same-origin") return reply.code(403).send({ error: "not_mac_page" });
  if (request.headers[MAC_PAGE_HEADER.NAME] !== MAC_PAGE_HEADER.VALUE) return reply.code(403).send({ error: "not_mac_page" });
  if (hasBody(request)) return reply.code(400).send({ error: "body_not_allowed" });
  return undefined;
}

async function openRegistration(request: FastifyRequest, reply: FastifyReply, deps: RemoteAdminDeps): Promise<FastifyReply> {
  try {
    // row first → a registration the trail does not show is never opened
    await deps.audit.insertEvent({ actor: AUDIT_ACTOR, actionKind: "remote.registration_opened", result: "success", payload: getRoutePayload(request) });
  } catch (error) {
    request.log.error({ err: error }, "remote registration not opened: audit row not written");
    return reply.code(503).send({ error: "audit_unavailable" });
  }
  return reply.send({ code: deps.codes.open() });
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

/** One access act at a time, in arrival order → two config writes never interleave. */
class ActQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;

  get isBusy(): boolean {
    return this.#pending > 0;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    this.#pending += 1;
    const result = this.#tail.then(work).finally(() => {
      this.#pending -= 1;
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

interface AccessRoute {
  readonly deps: RemoteAdminDeps;
  readonly queue: ActQueue;
}

const WIDENING_ACT_KIND = { on: "remote.access_enabled", trust: "remote.network_trusted" } as const;
const FAILED_ACT_STATUS: Record<Exclude<AccessApplyOutcome, "written">, number> = {
  already_trusted: 409,
  network_unreadable: 409,
  keys_not_created: 500,
  env_not_rendered: 500,
  config_malformed: 500,
  write_failed: 500,
  start_failed: 500,
  act_failed: 500,
  confirm_stale: 409,
  network_changed: 409,
};

// the on may add a trust of the network shown → its request row names that before any step
const WIDENING_REQUEST_PAYLOAD = { on: { mayTrust: "network_shown" }, trust: {} } as const;
const ACT_FAILED: AccessApplyResult = { outcome: "act_failed", trustedCount: null };

/**
 * On or trust: request row first (no row → no act), one act at a time, then one outcome row per step with the trusted count.
 * An on that also trusted the network shown answers the trust's outcome beside its own; the on stands either way.
 * An act that throws still gets its outcome row → no request row is left without one.
 */
async function widenAccess(request: FastifyRequest, reply: FastifyReply, route: AccessRoute & { act: "on" | "trust" }): Promise<FastifyReply> {
  if (route.queue.isBusy) return reply.code(409).send({ error: "act_in_progress" });
  return route.queue.run(async () => {
    if (!(await putAccessRequest(request, route.deps, WIDENING_REQUEST_PAYLOAD[route.act]))) return reply.code(503).send({ error: "audit_unavailable" });
    try {
      return await runWideningAct(request, reply, route);
    } catch (error) {
      request.log.error({ err: error, act: route.act }, "remote access act threw: state unknown until the next restart");
      putActOutcome(request, route.deps, route.act, ACT_FAILED);
      return sendActOutcome(reply, ACT_FAILED, {});
    }
  });
}

async function runWideningAct(request: FastifyRequest, reply: FastifyReply, route: AccessRoute & { act: "on" | "trust" }): Promise<FastifyReply> {
  if (route.act === "trust") {
    const trust = await route.deps.access.trust();
    putActOutcome(request, route.deps, "trust", trust);
    return sendActOutcome(reply, trust, {});
  }
  const on = await route.deps.access.turnOn();
  putActOutcome(request, route.deps, "on", on);
  if (on.trust !== null) putActOutcome(request, route.deps, "trust", on.trust);
  return sendActOutcome(reply, on, { trust: on.trust?.outcome ?? null });
}

function putActOutcome(request: FastifyRequest, deps: RemoteAdminDeps, act: "on" | "trust", result: AccessApplyResult): void {
  const payload = { outcome: result.outcome, ...(result.trustedCount === null ? {} : { trustedNetworkCount: result.trustedCount }) };
  recordEvent(request, deps.audit, { actor: AUDIT_ACTOR, actionKind: WIDENING_ACT_KIND[act], result: result.outcome === "written" ? "success" : "error", payload });
}

function sendActOutcome(reply: FastifyReply, result: AccessApplyResult, fields: Record<string, unknown>): FastifyReply {
  if (result.outcome !== "written") return reply.code(FAILED_ACT_STATUS[result.outcome]).send({ error: result.outcome });
  return reply.send({ outcome: result.outcome, ...fields });
}

/** @returns false when the row was not written; the page-origin stamp is a record, not a check */
async function putAccessRequest(request: FastifyRequest, deps: RemoteAdminDeps, extra: Readonly<Record<string, string>> = {}): Promise<boolean> {
  const pageOrigin = getPageOriginSignal(request.headers, new Set()) ?? "none";
  const payload = { ...getRoutePayload(request), pageOrigin, ...extra };
  const event: RemoteAuditEvent = { actor: AUDIT_ACTOR, actionKind: "remote.access_requested", result: "success", payload };
  try {
    await getWithin(deps.audit.insertEvent(event), deps);
    return true;
  } catch (error) {
    request.log.error({ err: error }, "remote access act: request row not written");
    return false;
  }
}

/**
 * Reduce-only: runs without its request row and behind an act in flight; persist, revoke, close — each step runs when another fails.
 * Every wait bounded: the store calls and the close by WAIT_TIMEOUT_MS, the persist by its own step timeout.
 */
async function turnOffAccess(request: FastifyRequest, reply: FastifyReply, route: AccessRoute): Promise<FastifyReply> {
  const { failed, revoked } = await route.queue.run(async () => {
    await putAccessRequest(request, route.deps);
    return putAccessOff(request, route.deps);
  });
  const result = failed.length === 0 ? "success" : "error";
  recordEvent(request, route.deps.audit, { actor: AUDIT_ACTOR, actionKind: "remote.access_disabled", result, payload: { count: revoked, failed: failed.join(",") } });
  return failed.length === 0 ? reply.send({ revoked }) : reply.code(500).send({ error: "off_incomplete", failed, revoked });
}

async function putAccessOff(request: FastifyRequest, deps: RemoteAdminDeps): Promise<{ failed: string[]; revoked: number }> {
  const failed: string[] = [];
  const persisted = await deps.access.setOff().catch(() => "write_failed");
  if (persisted !== "written") failed.push("persist");
  let revoked = 0;
  try {
    revoked = (await getWithin(revokeAll(request, { deps, actor: AUDIT_ACTOR }), deps)).revoked;
  } catch (error) {
    request.log.error({ err: error }, "remote access off: revoking the registered devices failed");
    failed.push("revoke");
  }
  await getWithin(deps.access.close(), deps).catch((error: unknown) => {
    request.log.error({ err: error }, "remote access off: the listener did not close");
    failed.push("close");
  });
  return { failed, revoked };
}

/** @returns the work's value; rejects once the wait bound passes, the work left running */
export async function getWithin<T>(work: Promise<T>, deps: Pick<RemoteAdminDeps, "waitTimeoutMs">): Promise<T> {
  const timeoutMs = deps.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Field by field → the router's hardware address and the interface never reach the page. */
async function getConfirmNetwork(reply: FastifyReply, deps: RemoteAdminDeps): Promise<FastifyReply> {
  const facts = await deps.access.getConfirmFacts();
  return reply.send({ router: facts.router, link: facts.link, isNetworkTrusted: facts.isNetworkTrusted });
}

/** Field by field → a wider value from the caller (router, interface, key paths) never reaches the page. */
async function getSetup(request: FastifyRequest, reply: FastifyReply, deps: RemoteAdminDeps): Promise<FastifyReply> {
  const [facts, certificate] = await Promise.all([deps.access.getSetupFacts(), getCertificate(request, deps.access)]);
  return reply.send({
    enabled: facts.enabled,
    isOffByDevice: facts.isOffByDevice,
    listenReason: facts.listenReason,
    hasRouter: facts.hasRouter,
    isNetworkTrusted: facts.isNetworkTrusted,
    trustedCount: facts.trustedCount,
    isAnswering: facts.isAnswering,
    hostName: facts.hostName,
    address: facts.address,
    port: facts.port,
    deviceLimit: facts.deviceLimit,
    fingerprint: certificate?.fingerprint ?? null,
  });
}

async function getCertificateFile(request: FastifyRequest, reply: FastifyReply, deps: RemoteAdminDeps): Promise<FastifyReply> {
  const certificate = await getCertificate(request, deps.access);
  if (certificate === null) return reply.code(404).send({ error: "certificate_unavailable" });
  return reply
    .header("content-type", CA_DOWNLOAD.CONTENT_TYPE)
    .header("content-disposition", getAttachmentDisposition(CA_DOWNLOAD.FILE_NAME))
    .send(certificate.bytes);
}

/**
 * The CA certificate re-encoded from the parsed object and its SHA-256 over that same encoded certificate → the download
 * serves only what the fingerprint covers, never the file's own bytes.
 * @returns null when no file, or anything but exactly one CA certificate: a key, a second block, any other content
 */
async function getCertificate(request: FastifyRequest, access: RemoteAccessActs): Promise<{ bytes: Buffer; fingerprint: string } | null> {
  const bytes = await access.readCertificate();
  const encoded = bytes === null ? undefined : PEM_CERTIFICATE.exec(bytes.toString("latin1"))?.[1];
  if (bytes === null || encoded === undefined) return null;
  const der = Buffer.from(encoded, "base64");
  try {
    const certificate = new X509Certificate(der);
    // raw ≠ the block's bytes → the block held more than the certificate the fingerprint covers
    return certificate.ca && certificate.raw.equals(der) ? { bytes: Buffer.from(certificate.toString()), fingerprint: certificate.fingerprint256 } : null;
  } catch (error) {
    request.log.warn({ err: error }, "remote CA certificate unreadable");
    return null;
  }
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
