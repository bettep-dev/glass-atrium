// Remote access wiring: one fresh remote app per open (a closed Fastify instance cannot listen again), driven by the
// listener controller on a timer. main.ts calls startRemoteAccess once, after the loopback listener is up.

import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyBaseLogger } from "fastify";

import type { Prisma } from "../../generated/prisma/client.js";
import { buildRemoteApp } from "../app.js";
import { getPrisma } from "../db.js";
import { buildRemoteAuditWriter } from "../middleware/audit-log.js";
import type { QueueRouteOptions } from "../routes/queue.js";
import type { DeviceConnections } from "./connections.js";
import { type RemoteListenerHandle, RemoteListenerController, getInterfaceAddress } from "./controller.js";
import { createDevice, findActiveDevice, revokeAllDevices, revokeDevice } from "./devices.js";
import type { RemoteAuditEvent, RemoteGateDeps } from "./gate.js";
import { type RemoteTls, readRemoteTls, setRemoteCertificate } from "./listener.js";
import { getLocalHostName, getNetworkIdentity } from "./network.js";
import type { RegistrationCodes } from "./registration-code.js";
import { REMOTE_PRE_AUTH_ROUTES, getRouteClass } from "./route-classes.js";
import type { RemoteDeviceDeps, RemoteRegistrationDeps } from "./routes.js";
import type { RemoteSettings } from "./settings.js";

export interface RemoteOpenerInput {
  readonly port: number;
  /** `<name>.local`; null → only the numeric address is admitted */
  readonly hostName: string | null;
  readonly gate: Pick<RemoteGateDeps, "findDevice" | "audit" | "connections">;
  readonly registration: RemoteRegistrationDeps;
  readonly device: RemoteDeviceDeps;
  readonly queue?: QueueRouteOptions;
}

// leaf files written by the installer (owner-only directory, git-ignored); fixed → no env or config can point elsewhere
const REMOTE_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "remote-access");
const NETWORK_CHECK_MS = 10_000;
// differs from the page and CLI actors → a boot-time act is told apart in the audit trail
const BOOT_ACTOR = "monitor-boot";

export interface BootAccessDeps {
  readonly revokeAll: () => Promise<bigint[]>;
  readonly connections: Pick<DeviceConnections, "close">;
  readonly audit: { insertEvent(event: RemoteAuditEvent): Promise<void> };
  readonly log: FastifyBaseLogger;
}

export function buildRemoteOpener(input: RemoteOpenerInput): (address: string, tls: RemoteTls) => Promise<RemoteListenerHandle> {
  return async (address, tls) => {
    const hosts: ReadonlySet<string> = new Set([address, ...(input.hostName === null ? [] : [input.hostName])].map((name) => `${name}:${input.port}`));
    const origins: ReadonlySet<string> = new Set([...hosts].map((host) => `https://${host}`));
    const getHosts = () => hosts;
    const getPageOrigins = () => origins;
    const app = await buildRemoteApp({
      tls,
      listener: { kind: "remote", getHosts, getPageOrigins },
      gate: { ...input.gate, getHosts, getPageOrigins, getRouteClass, preAuthRoutes: REMOTE_PRE_AUTH_ROUTES },
      registration: input.registration,
      device: input.device,
      ...(input.queue === undefined ? {} : { queue: input.queue }),
    });
    try {
      await app.listen({ host: address, port: input.port });
    } catch (error) {
      await app.close();
      throw error;
    }
    return { close: () => app.close(), setTls: (next) => setRemoteCertificate(app, next) };
  };
}

/**
 * Records the boot state, then starts the network watch when remote access is on; off → every device is cut off,
 * nothing opens and null is returned.
 * @param input.db - the device and audit store; tests pass a rolled-back transaction, production the shared client
 * @returns the controller → main.ts stops it on shutdown
 */
export async function startRemoteAccess(input: {
  readonly settings: RemoteSettings;
  readonly connections: DeviceConnections;
  readonly codes: RegistrationCodes;
  readonly log: FastifyBaseLogger;
  readonly db?: Prisma.TransactionClient;
}): Promise<RemoteListenerController | null> {
  const { settings } = input;
  const getDb = () => input.db ?? getPrisma();
  await putBootAccessState(settings, {
    revokeAll: () => revokeAllDevices(getDb()),
    connections: input.connections,
    audit: buildRemoteAuditWriter(getDb()),
    log: input.log,
  });
  if (!settings.enabled) return null;
  const open = buildRemoteOpener({
    port: settings.port,
    hostName: await getLocalHostName(),
    gate: { findDevice: (presented) => findActiveDevice(getDb(), presented), audit: buildRemoteAuditWriter(getDb()), connections: input.connections },
    registration: { codes: input.codes, createDevice: (label) => createDevice(getDb(), label) },
    device: {
      revoke: (id) => revokeDevice(getDb(), id),
      revokeAll: () => revokeAllDevices(getDb()),
      // the opener is built before the controller it serves → bound late, set before any listener opens
      turnOff: () => void controller.turnOff(),
    },
  });
  const controller: RemoteListenerController = new RemoteListenerController({
    settings,
    readIdentity: () => getNetworkIdentity(),
    getAddress: (networkInterface) => getInterfaceAddress(networkInterfaces(), networkInterface),
    readTls: () => readRemoteTls(REMOTE_DATA_DIR),
    open,
    log: input.log,
  });
  await controller.sync();
  setInterval(() => void controller.sync(), NETWORK_CHECK_MS).unref();
  return controller;
}

/**
 * Boot record of the feature state; never rejects → a store failure is logged and the boot goes on.
 * Off → every active device is revoked: a CLI off whose revoke never reached the monitor still cuts devices off here.
 * On → one row with the trusted-network count.
 */
export async function putBootAccessState(settings: RemoteSettings, deps: BootAccessDeps): Promise<void> {
  if (settings.enabled) {
    await recordBootEvent(deps, { actionKind: "remote.access_enabled", payload: { trustedNetworkCount: settings.trusted.length } });
    return;
  }
  let revoked: bigint[];
  try {
    revoked = await deps.revokeAll();
  } catch (error) {
    deps.log.error({ err: error }, "remote access off at boot: revoking the registered devices failed");
    return;
  }
  for (const id of revoked) deps.connections.close(id);
  // nothing revoked → no row, so a monitor that never turned the feature on adds none per boot
  if (revoked.length > 0) await recordBootEvent(deps, { actionKind: "remote.revoke", payload: { count: revoked.length } });
}

async function recordBootEvent(deps: BootAccessDeps, event: Pick<RemoteAuditEvent, "actionKind" | "payload">): Promise<void> {
  try {
    await deps.audit.insertEvent({ ...event, actor: BOOT_ACTOR, result: "success" });
  } catch (error) {
    deps.log.warn({ err: error, actionKind: event.actionKind }, "remote access boot event not recorded");
  }
}
