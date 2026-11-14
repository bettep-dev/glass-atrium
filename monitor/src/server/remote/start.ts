// Remote access wiring: one fresh remote app per open (a closed Fastify instance cannot listen again), driven by the
// listener controller on a timer. main.ts calls startRemoteAccess once, after the loopback listener is up.

import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyBaseLogger } from "fastify";

import { buildRemoteApp } from "../app.js";
import { getPrisma } from "../db.js";
import { buildRemoteAuditWriter } from "../middleware/audit-log.js";
import type { QueueRouteOptions } from "../routes/queue.js";
import type { DeviceConnections } from "./connections.js";
import { type RemoteListenerHandle, RemoteListenerController, getInterfaceAddress } from "./controller.js";
import { createDevice, findActiveDevice, revokeAllDevices, revokeDevice } from "./devices.js";
import type { RemoteGateDeps } from "./gate.js";
import { type RemoteTls, readRemoteTls, setRemoteCertificate } from "./listener.js";
import { getLocalHostName, getNetworkIdentity } from "./network.js";
import type { RegistrationCodes } from "./registration-code.js";
import { REMOTE_PRE_AUTH_ROUTES, getRouteClass } from "./route-classes.js";
import type { RemoteDeviceDeps, RemoteRegistrationDeps } from "./routes.js";
import { getRemoteSettings } from "./settings.js";

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
 * Starts the network watch when remote access is on; off → nothing opens and null is returned.
 * @returns the controller → main.ts stops it on shutdown
 */
export async function startRemoteAccess(input: {
  readonly monitorPort: number;
  readonly connections: DeviceConnections;
  readonly codes: RegistrationCodes;
  readonly log: FastifyBaseLogger;
}): Promise<RemoteListenerController | null> {
  const settings = getRemoteSettings(process.env, input.monitorPort);
  if (!settings.enabled) return null;
  const open = buildRemoteOpener({
    port: settings.port,
    hostName: await getLocalHostName(),
    gate: { findDevice: (presented) => findActiveDevice(getPrisma(), presented), audit: buildRemoteAuditWriter(), connections: input.connections },
    registration: { codes: input.codes, createDevice: (label) => createDevice(getPrisma(), label) },
    device: {
      revoke: (id) => revokeDevice(getPrisma(), id),
      revokeAll: () => revokeAllDevices(getPrisma()),
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
