// Remote listener lifecycle: open only while the trusted-network decision holds, bound to the Wi-Fi interface's own
// address; close on any change of network or address; hand a reissued leaf to the open listener without reopening.

import type { NetworkInterfaceInfo } from "node:os";

import type { FastifyBaseLogger } from "fastify";

import type { LeafNames, RemoteTls } from "./listener.js";
import { type ListenReason, type NetworkIdentity, type TrustedNetwork, getListenDecision } from "./network.js";

export interface RemoteListenerHandle {
  close(): Promise<void>;
  setTls(tls: RemoteTls): void;
}

/** Binds exactly the given address, never all interfaces; admits the host name beside it when not null. */
export type RemoteListenerOpener = (address: string, hostName: string | null, tls: RemoteTls) => Promise<RemoteListenerHandle>;

export interface RemoteControllerDeps {
  readonly settings: { readonly enabled: boolean; readonly trusted: readonly TrustedNetwork[] };
  readonly readIdentity: () => Promise<NetworkIdentity | null>;
  /** `<name>.local`; null when unreadable */
  readonly readHostName: () => Promise<string | null>;
  /** IPv4 address of the named interface; null when it has none */
  readonly getAddress: (networkInterface: string) => string | null;
  readonly readTls: () => Promise<RemoteTls>;
  readonly isLeafDue: (cert: Buffer, names: LeafNames) => boolean;
  /** Writes a new leaf for the current names next to the old one; rejects when it could not. */
  readonly reissueLeaf: () => Promise<void>;
  readonly open: RemoteListenerOpener;
  readonly getNow?: () => number;
  readonly log?: Pick<FastifyBaseLogger, "info" | "warn">;
}

interface Target extends LeafNames {
  /** network identity + address + host name → any change means close, then reopen if still allowed */
  readonly key: string;
}

// a reissue that failed, or left the leaf still due, waits this long unless the network or the name changes
const REISSUE_RETRY_MS = 3_600_000;

interface OpenListener {
  readonly handle: RemoteListenerHandle;
  readonly key: string;
  cert: Buffer;
}

type ListenTarget = { readonly target: Target } | { readonly reason: ListenReason | "leaf_unreadable" | "check_failed" };

export class RemoteListenerController {
  #current: OpenListener | null = null;
  #isTurnedOff = false;
  #queue: Promise<void> = Promise.resolve();
  #reissueAttempt: { readonly key: string; readonly at: number } | null = null;
  #watch: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RemoteControllerDeps) {}

  /** true once a device's off has run in this process; a restart reads the persisted off instead */
  get isTurnedOff(): boolean {
    return this.#isTurnedOff;
  }

  get isOpen(): boolean {
    return this.#current !== null;
  }

  /** A check every interval until turned off or stopped → a replaced controller leaves no timer behind. */
  watch(intervalMs: number): void {
    this.#watch ??= setInterval(() => void this.sync(), intervalMs).unref();
  }

  /** One network check; checks run one at a time and never reject → safe to call from a timer. */
  sync(): Promise<void> {
    return this.#enqueue(() => this.#sync());
  }

  /** A device's off: closes now and every later check in this process stays closed. */
  turnOff(): Promise<void> {
    this.#isTurnedOff = true;
    this.#stopWatch();
    return this.#enqueue(() => this.#close("turned_off"));
  }

  stop(): Promise<void> {
    this.#stopWatch();
    return this.#enqueue(() => this.#close("stopped"));
  }

  #stopWatch(): void {
    if (this.#watch !== null) clearInterval(this.#watch);
    this.#watch = null;
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(work);
    return this.#queue;
  }

  async #sync(): Promise<void> {
    if (this.#isTurnedOff) return;
    try {
      const found = await this.#getTarget();
      if (!("target" in found)) return await this.#close(found.reason);
      const tls = await this.#getTls(found.target);
      if (tls === null) return await this.#close("leaf_unreadable");
      if (this.#current?.key === found.target.key) return this.#refreshTls(this.#current, tls);
      await this.#close("network_changed");
      await this.#open(found.target, tls);
    } catch (error) {
      this.deps.log?.warn({ err: error }, "remote listener check failed — closing");
      await this.#close("check_failed");
    }
  }

  async #getTarget(): Promise<ListenTarget> {
    const [identity, hostName] = await Promise.all([this.deps.readIdentity(), this.deps.readHostName()]);
    const address = identity === null ? null : this.deps.getAddress(identity.interface);
    const decision = getListenDecision({ ...this.deps.settings, identity, address });
    if (!decision.open || identity === null || address === null) return { reason: decision.reason };
    return { target: { address, hostName, key: `${identity.gateway}|${identity.hardwareAddress}|${address}|${hostName ?? ""}` } };
  }

  /** The leaf on disk, reissued first when it is due for the target's names; a failed reissue keeps the current leaf. */
  async #getTls(target: Target): Promise<RemoteTls | null> {
    const tls = await this.deps.readTls().catch(() => null);
    if (tls === null || !this.deps.isLeafDue(tls.cert, target) || this.#isReissueWaiting(target.key)) return tls;
    this.#reissueAttempt = { key: target.key, at: this.#getNow() };
    try {
      await this.deps.reissueLeaf();
    } catch (error) {
      this.deps.log?.warn({ err: error }, "remote leaf reissue failed — the current leaf stays");
      return tls;
    }
    return this.deps.readTls().catch(() => tls);
  }

  #isReissueWaiting(key: string): boolean {
    const attempt = this.#reissueAttempt;
    return attempt !== null && attempt.key === key && this.#getNow() - attempt.at < REISSUE_RETRY_MS;
  }

  #getNow(): number {
    return this.deps.getNow?.() ?? Date.now();
  }

  async #open(target: Target, tls: RemoteTls): Promise<void> {
    try {
      this.#current = { handle: await this.deps.open(target.address, target.hostName, tls), key: target.key, cert: tls.cert };
      this.deps.log?.info({ address: target.address }, "remote listener open");
    } catch (error) {
      // the next check retries → a transient bind failure never needs a restart
      this.deps.log?.warn({ err: error, address: target.address }, "remote listener open failed — stays closed");
    }
  }

  #refreshTls(current: OpenListener, tls: RemoteTls): void {
    if (current.cert.equals(tls.cert)) return;
    current.handle.setTls(tls);
    current.cert = tls.cert;
    this.deps.log?.info("remote listener leaf reissued");
  }

  async #close(reason: string): Promise<void> {
    const current = this.#current;
    if (current === null) return;
    this.#current = null;
    try {
      await current.handle.close();
    } catch (error) {
      this.deps.log?.warn({ err: error, reason }, "remote listener close failed");
      return;
    }
    this.deps.log?.info({ reason }, "remote listener closed");
  }
}

/** First non-internal IPv4 address of the named interface → the one address the remote listener binds. */
export function getInterfaceAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, networkInterface: string): string | null {
  const entry = interfaces[networkInterface]?.find((info) => info.family === "IPv4" && !info.internal);
  return entry?.address ?? null;
}
