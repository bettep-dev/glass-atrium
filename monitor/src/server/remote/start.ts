// Remote access wiring: one fresh remote app per open (a closed Fastify instance cannot listen again), driven by the
// listener controller on a timer. main.ts calls startRemoteAccess once, after the loopback listener is up.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse } from "dotenv";
import type { FastifyBaseLogger } from "fastify";

import type { Prisma } from "../../generated/prisma/client.js";
import { buildRemoteApp } from "../app.js";
import { getPrisma } from "../db.js";
import { buildRemoteAuditWriter } from "../middleware/audit-log.js";
import type { QueueRouteOptions } from "../routes/queue.js";
import {
  type AccessApplyResult,
  type AccessStepOutcome,
  type ConfirmFacts,
  type RemoteAccessActs,
  type SetupFacts,
  type TurnOnResult,
  getWithin,
} from "./admin-routes.js";
import type { DeviceConnections } from "./connections.js";
import { type RemoteListenerOpener, RemoteListenerController, getInterfaceAddress } from "./controller.js";
import { DEVICE, createDevice, findActiveDevice, revokeAllDevices, revokeDevice } from "./devices.js";
import type { RemoteAuditEvent, RemoteGateDeps } from "./gate.js";
import { isLeafDue, readRemoteTls, setRemoteCertificate } from "./listener.js";
import {
  type NetworkIdentity,
  type NetworkLink,
  getListenDecision,
  getLocalHostName,
  getNetworkIdentity,
  getNetworkLink,
  isTrustedNetwork,
} from "./network.js";
import type { RegistrationCodes } from "./registration-code.js";
import { REMOTE_PRE_AUTH_ROUTES, getRouteClass } from "./route-classes.js";
import type { RemoteDeviceDeps, RemoteRegistrationDeps } from "./routes.js";
import { REMOTE_ENV, type RemoteSettings, getRemoteSettings } from "./settings.js";

export interface RemoteOpenerInput {
  readonly port: number;
  readonly gate: Pick<RemoteGateDeps, "findDevice" | "audit" | "connections">;
  readonly registration: RemoteRegistrationDeps;
  readonly device: RemoteDeviceDeps;
  readonly queue?: QueueRouteOptions;
}

// leaf files written by the installer (owner-only directory, git-ignored); fixed → no env or config can point elsewhere
const REMOTE_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "remote-access");
// install root holding the `glass-atrium` CLI → the CLI writes the leaf into this same data dir
const ATRIUM_ROOT = path.resolve(REMOTE_DATA_DIR, "..", "..", "..");
const CLI_CALL = { BASH: "/bin/bash", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TIMEOUT_MS: 30_000 } as const;
// the Mac page's write step: internal, absent from the CLI's dispatch and help
const ACCESS_STEP_FILE = path.join(ATRIUM_ROOT, "scripts", "remote-access-set.sh");
// rendered by the write step from config.toml → the same file the boot read
const RENDERED_ENV_FILE = path.join(ATRIUM_ROOT, "monitor", ".env");
// the public CA certificate only; ca.key beside it is never read by this process
const CA_CERTIFICATE_FILE = "ca.pem";
const NETWORK_CHECK_MS = 10_000;
// differs from the page and CLI actors → a boot-time act is told apart in the audit trail
const BOOT_ACTOR = "monitor-boot";
// "off" once a device turned access off → outlives a restart; the CLI's on writes "on"
const ACCESS_STATE_FILE = "access-state";
const DEVICE_OFF = "off";
/** How long the network a confirm showed stays the one an on or trust may act on → the page keeps it only while its dialog is open. */
export const CONFIRM_TTL_MS = 120_000;

export interface BootAccessDeps {
  readonly revokeAll: () => Promise<bigint[]>;
  readonly connections: Pick<DeviceConnections, "close">;
  readonly audit: { insertEvent(event: RemoteAuditEvent): Promise<void> };
  readonly log: FastifyBaseLogger;
}

/** The boot input without its settings → the switch opens with the settings each act wrote. */
export interface RemoteAccessInput {
  readonly connections: DeviceConnections;
  readonly codes: RegistrationCodes;
  readonly log: FastifyBaseLogger;
  readonly db?: Prisma.TransactionClient;
  /** leaf and access-state directory; tests pass a temporary one, production the fixed data dir */
  readonly dataDir?: string;
}

/** @returns an opener taking the bound address and the `<name>.local` name (null → only the numeric address is admitted) */
export function buildRemoteOpener(input: RemoteOpenerInput): RemoteListenerOpener {
  return async (address, hostName, tls) => {
    const hosts: ReadonlySet<string> = new Set([address, ...(hostName === null ? [] : [hostName])].map((name) => `${name}:${input.port}`));
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
export async function startRemoteAccess(input: RemoteAccessInput & { readonly settings: RemoteSettings }): Promise<RemoteListenerController | null> {
  const settings = await getEffectiveSettings(input.settings, () => isDeviceOff(input.dataDir ?? REMOTE_DATA_DIR));
  const getDb = () => input.db ?? getPrisma();
  await putBootAccessState(settings, {
    revokeAll: () => revokeAllDevices(getDb()),
    connections: input.connections,
    audit: buildRemoteAuditWriter(getDb()),
    log: input.log,
  });
  return settings.enabled ? openRemoteAccess(settings, input) : null;
}

// a device's off holds over config on until an on writes access-state again
async function getEffectiveSettings(settings: RemoteSettings, isOff: () => Promise<boolean> | boolean): Promise<RemoteSettings> {
  return settings.enabled && (await isOff()) ? { ...settings, enabled: false } : settings;
}

/** The network watch for settings that are on: the first check runs before this resolves. */
async function openRemoteAccess(settings: RemoteSettings, input: RemoteAccessInput): Promise<RemoteListenerController> {
  const dataDir = input.dataDir ?? REMOTE_DATA_DIR;
  const getDb = () => input.db ?? getPrisma();
  const open = buildRemoteOpener({
    port: settings.port,
    gate: { findDevice: (presented) => findActiveDevice(getDb(), presented), audit: buildRemoteAuditWriter(getDb()), connections: input.connections },
    registration: { codes: input.codes, createDevice: (label) => createDevice(getDb(), label) },
    device: {
      revoke: (id) => revokeDevice(getDb(), id),
      revokeAll: () => revokeAllDevices(getDb()),
      // the opener is built before the controller it serves → bound late, set before any listener opens
      turnOff: () => {
        void controller.turnOff();
        setDeviceOff(dataDir).catch((error: unknown) => input.log.error({ err: error }, "remote off not persisted: the listener reopens at the next restart"));
      },
    },
  });
  const controller: RemoteListenerController = new RemoteListenerController({
    settings,
    readIdentity: () => getNetworkIdentity(),
    readHostName: () => getLocalHostName(),
    getAddress: (networkInterface) => getInterfaceAddress(networkInterfaces(), networkInterface),
    readTls: () => readRemoteTls(dataDir),
    isLeafDue: (cert, names) => isLeafDue(cert, names, Date.now()),
    reissueLeaf,
    open,
    log: input.log,
  });
  await controller.sync();
  controller.watch(NETWORK_CHECK_MS);
  return controller;
}

export type SwitchedController = Pick<RemoteListenerController, "isOpen" | "turnOff" | "stop">;

export interface AccessSwitchDeps {
  /** the boot path → its own audit row and device-off rule */
  readonly boot: (settings: RemoteSettings) => Promise<SwitchedController | null>;
  readonly runStep: (step: AccessStep) => Promise<AccessStepOutcome>;
  /** the settings the step rendered */
  readonly readSettings: () => Promise<RemoteSettings>;
  readonly open: (settings: RemoteSettings) => Promise<SwitchedController>;
  readonly isDeviceOff: () => Promise<boolean>;
  readonly setDeviceOff: () => Promise<void>;
  readonly readIdentity: () => Promise<NetworkIdentity | null>;
  readonly readLink: (networkInterface: string) => Promise<NetworkLink>;
  readonly readHostName: () => Promise<string | null>;
  readonly getAddress: (networkInterface: string) => string | null;
  readonly readCertificate: () => Promise<Buffer | null>;
  readonly log: Pick<FastifyBaseLogger, "error">;
  readonly now: () => number;
  /** bound on the old listener's close and the new one's open inside an act; tests pass a short one */
  readonly waitTimeoutMs?: number;
}

/** One write step: on and off alone; trust names the network the confirm showed → the step refuses any other it reads. */
export type AccessStep = { readonly act: "on" | "off" } | { readonly act: "trust"; readonly shown: NetworkIdentity };

/**
 * The feature's state in this process: boot, then the Mac page's acts. The shell step writes; the switch re-reads what it
 * wrote and reopens. A write it cannot apply leaves the listener closed, and the next restart applies it.
 */
export class RemoteAccessSwitch implements RemoteAccessActs {
  #controller: SwitchedController | null = null;
  #settings: RemoteSettings;
  #shown: { readonly identity: NetworkIdentity; readonly at: number } | null = null;
  // overlapping reads share one run of the network commands; no result outlives its read → never stale after an act
  #pendingSetup: Promise<SetupFacts> | null = null;

  constructor(
    private readonly deps: AccessSwitchDeps,
    settings: RemoteSettings,
  ) {
    this.#settings = settings;
  }

  async boot(): Promise<void> {
    this.#controller = await this.deps.boot(this.#settings);
  }

  async getConfirmFacts(): Promise<ConfirmFacts> {
    const identity = await this.deps.readIdentity();
    this.#shown = identity === null ? null : { identity, at: this.deps.now() };
    if (identity === null) return { router: null, link: "unknown", isNetworkTrusted: false };
    const link = await this.deps.readLink(identity.interface);
    return { router: identity.gateway, link, isNetworkTrusted: isTrustedNetwork(this.#settings.trusted, identity) };
  }

  async turnOn(): Promise<TurnOnResult> {
    const shown = this.#takeShown();
    if (shown === null) return { outcome: "confirm_stale", trustedCount: null, trust: null };
    const refusal = await this.#getChange(shown);
    if (refusal !== null) return { outcome: refusal, trustedCount: null, trust: null };
    const on = await this.#write({ act: "on" });
    if (on.outcome !== "written" || isTrustedNetwork(this.#settings.trusted, shown)) return { ...on, trust: null };
    return { ...on, trust: await this.#trustShown(shown) };
  }

  trust(): Promise<AccessApplyResult> {
    const shown = this.#takeShown();
    return shown === null ? Promise.resolve({ outcome: "confirm_stale", trustedCount: null }) : this.#trustShown(shown);
  }

  /** an off step that did not write leaves the device-off marker → config may still say on, a restart stays off */
  async setOff(): Promise<AccessStepOutcome> {
    const outcome = await this.deps.runStep({ act: "off" });
    if (outcome === "written") {
      this.#settings = { ...this.#settings, enabled: false };
      return outcome;
    }
    await this.deps.setDeviceOff().catch((error: unknown) => {
      this.deps.log.error({ err: error, outcome }, "remote access off: neither the off step nor the device-off marker was written; a restart reopens");
    });
    return outcome;
  }

  async close(): Promise<void> {
    const controller = this.#controller;
    this.#controller = null;
    await controller?.turnOff();
  }

  async stop(): Promise<void> {
    await this.#controller?.stop();
  }

  readCertificate(): Promise<Buffer | null> {
    return this.deps.readCertificate();
  }

  getSetupFacts(): Promise<SetupFacts> {
    this.#pendingSetup ??= this.#readSetupFacts().finally(() => {
      this.#pendingSetup = null;
    });
    return this.#pendingSetup;
  }

  async #readSetupFacts(): Promise<SetupFacts> {
    const [identity, hostName, isOffByDevice] = await Promise.all([this.deps.readIdentity(), this.deps.readHostName(), this.deps.isDeviceOff()]);
    const settings = await getEffectiveSettings(this.#settings, () => isOffByDevice);
    const address = identity === null ? null : this.deps.getAddress(identity.interface);
    return {
      enabled: settings.enabled,
      isOffByDevice,
      listenReason: getListenDecision({ ...settings, identity, address }).reason,
      hasRouter: identity !== null,
      isNetworkTrusted: identity !== null && isTrustedNetwork(settings.trusted, identity),
      trustedCount: settings.trusted.length,
      isAnswering: this.#controller?.isOpen ?? false,
      hostName,
      address,
      port: settings.port,
      deviceLimit: DEVICE.MAX_ACTIVE,
    };
  }

  // one read serves one act → a second act needs a fresh confirm
  #takeShown(): NetworkIdentity | null {
    const shown = this.#shown;
    this.#shown = null;
    return shown !== null && this.deps.now() - shown.at <= CONFIRM_TTL_MS ? shown.identity : null;
  }

  // refused here before any step; the step's own read refuses a change after this one
  async #getChange(shown: NetworkIdentity): Promise<"network_changed" | null> {
    const current = await this.deps.readIdentity();
    return current !== null && current.interface === shown.interface && isTrustedNetwork([shown], current) ? null : "network_changed";
  }

  async #trustShown(shown: NetworkIdentity): Promise<AccessApplyResult> {
    const refusal = await this.#getChange(shown);
    return refusal === null ? this.#write({ act: "trust", shown }) : { outcome: refusal, trustedCount: null };
  }

  async #write(step: AccessStep & { readonly act: "on" | "trust" }): Promise<AccessApplyResult> {
    const outcome = await this.deps.runStep(step);
    return outcome === "written" ? this.#apply(step.act) : { outcome, trustedCount: null };
  }

  // close and open each bounded → an off queued behind this act never waits on a stalled listener
  async #apply(act: "on" | "trust"): Promise<AccessApplyResult> {
    try {
      await getWithin(this.close(), this.deps);
      const settings = await this.deps.readSettings();
      this.#settings = settings;
      if (act === "on" && !settings.enabled) throw new Error("remote access settings still off after the on step");
      if ((await getEffectiveSettings(settings, this.deps.isDeviceOff)).enabled) this.#controller = await this.#openWithin(settings);
      return { outcome: "written", trustedCount: settings.trusted.length };
    } catch (error) {
      this.deps.log.error({ err: error, act }, "remote access written but not applied: the listener stays closed until the next restart");
      await getWithin(this.close(), this.deps).catch(() => undefined);
      return { outcome: "start_failed", trustedCount: null };
    }
  }

  // an open past the bound → the listener it opens later is closed at once, never left unowned
  async #openWithin(settings: RemoteSettings): Promise<SwitchedController> {
    const opening = this.deps.open(settings);
    try {
      return await getWithin(opening, this.deps);
    } catch (error) {
      opening.then((late) => late.turnOff(), () => undefined).catch((lateError: unknown) => this.deps.log.error({ err: lateError }, "remote access: a listener opened past its bound did not close"));
      throw error;
    }
  }
}

/** The production switch: the fixed write step, the rendered env file and the fixed data dir. */
export function buildRemoteAccessSwitch(input: RemoteAccessInput & { readonly settings: RemoteSettings; readonly monitorPort: number }): RemoteAccessSwitch {
  const dataDir = input.dataDir ?? REMOTE_DATA_DIR;
  return new RemoteAccessSwitch(
    {
      boot: (settings) => startRemoteAccess({ ...input, settings }),
      runStep: (step) => runAccessStep(step),
      readSettings: () => readRenderedSettings(input.monitorPort),
      open: (settings) => openRemoteAccess(settings, input),
      isDeviceOff: () => isDeviceOff(dataDir),
      setDeviceOff: () => setDeviceOff(dataDir),
      readIdentity: () => getNetworkIdentity(),
      readLink: (networkInterface) => getNetworkLink(networkInterface),
      readHostName: () => getLocalHostName(),
      getAddress: (networkInterface) => getInterfaceAddress(networkInterfaces(), networkInterface),
      readCertificate: () => readCaCertificate(dataDir),
      log: input.log,
      now: Date.now,
    },
    input.settings,
  );
}

const ACCESS_STEP_OUTCOME: ReadonlyMap<number, AccessStepOutcome> = new Map([
  [0, "written"],
  [6, "network_unreadable"],
  [7, "keys_not_created"],
  [8, "env_not_rendered"],
  [9, "already_trusted"],
  [10, "network_changed"],
  [11, "config_malformed"],
]);

/**
 * The write step for one act: fixed binary, fixed argv positions, no shell string, nothing from a request.
 * - trust: the network this process read for the confirm → interface, gateway, hardware address
 * @returns write_failed for any exit the step does not name, a timeout included
 */
export async function runAccessStep(step: AccessStep, run: { file?: string; timeoutMs?: number } = {}): Promise<AccessStepOutcome> {
  const args = step.act === "trust" ? [step.act, step.shown.interface, step.shown.gateway, step.shown.hardwareAddress] : [step.act];
  try {
    await promisify(execFile)(CLI_CALL.BASH, [run.file ?? ACCESS_STEP_FILE, ...args], { env: getCliEnv(), timeout: run.timeoutMs ?? CLI_CALL.TIMEOUT_MS });
    return "written";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return (typeof code === "number" ? ACCESS_STEP_OUTCOME.get(code) : undefined) ?? "write_failed";
  }
}

// only the remote keys → nothing else in the file enters these settings
async function readRenderedSettings(monitorPort: number): Promise<RemoteSettings> {
  const rendered = parse(await readFile(RENDERED_ENV_FILE));
  const remote = Object.fromEntries(Object.values(REMOTE_ENV).map((key) => [key, rendered[key]]));
  return getRemoteSettings(remote, monitorPort);
}

/** @returns null when no CA was created yet */
async function readCaCertificate(dataDir: string): Promise<Buffer | null> {
  return readFile(path.join(dataDir, CA_CERTIFICATE_FILE)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}

/**
 * `glass-atrium remote reissue`: the CLI holds the CA key and signs the leaf for the names it reads itself.
 * Fixed binary and argv, no shell string, nothing from a request; key content never reaches this process's output.
 */
async function reissueLeaf(): Promise<void> {
  await promisify(execFile)(CLI_CALL.BASH, [path.join(ATRIUM_ROOT, "glass-atrium"), "remote", "reissue"], {
    env: getCliEnv(),
    timeout: CLI_CALL.TIMEOUT_MS,
  });
}

function getCliEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME === undefined ? {} : { HOME: process.env.HOME };
  return { PATH: CLI_CALL.PATH, LC_ALL: "C", GA_ROOT: ATRIUM_ROOT, ...home };
}

/** true only for the exact off a device wrote; a missing or unreadable file leaves config in charge */
export async function isDeviceOff(dataDir: string): Promise<boolean> {
  const state = await readFile(path.join(dataDir, ACCESS_STATE_FILE), "utf8").catch(() => "");
  return state.trim() === DEVICE_OFF;
}

export async function setDeviceOff(dataDir: string): Promise<void> {
  await writeFile(path.join(dataDir, ACCESS_STATE_FILE), `${DEVICE_OFF}\n`, { mode: 0o600 });
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
