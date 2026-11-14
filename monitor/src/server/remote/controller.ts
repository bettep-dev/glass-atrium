// Remote listener lifecycle: open only while the trusted-network decision holds, bound to the Wi-Fi interface's own
// address; close on any change of network or address; hand a reissued leaf to the open listener without reopening.

import type { NetworkInterfaceInfo } from "node:os";

import type { FastifyBaseLogger } from "fastify";

import type { RemoteTls } from "./listener.js";
import { type ListenReason, type NetworkIdentity, type TrustedNetwork, getListenDecision } from "./network.js";

export interface RemoteListenerHandle {
  close(): Promise<void>;
  setTls(tls: RemoteTls): void;
}

export interface RemoteControllerDeps {
  readonly settings: { readonly enabled: boolean; readonly trusted: readonly TrustedNetwork[] };
  readonly readIdentity: () => Promise<NetworkIdentity | null>;
  /** IPv4 address of the named interface; null when it has none */
  readonly getAddress: (networkInterface: string) => string | null;
  readonly readTls: () => Promise<RemoteTls>;
  /** Binds exactly the given address, never all interfaces. */
  readonly open: (address: string, tls: RemoteTls) => Promise<RemoteListenerHandle>;
  readonly log?: Pick<FastifyBaseLogger, "info" | "warn">;
}

interface Target {
  readonly address: string;
  /** network identity + address → any change of either means close, then reopen if still allowed */
  readonly key: string;
}

interface OpenListener {
  readonly handle: RemoteListenerHandle;
  readonly key: string;
  cert: Buffer;
}

type ListenTarget = { readonly target: Target } | { readonly reason: ListenReason | "leaf_unreadable" | "check_failed" };

export class RemoteListenerController {
  #current: OpenListener | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RemoteControllerDeps) {}

  /** One network check; checks run one at a time and never reject → safe to call from a timer. */
  sync(): Promise<void> {
    return this.#enqueue(() => this.#sync());
  }

  stop(): Promise<void> {
    return this.#enqueue(() => this.#close("stopped"));
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(work);
    return this.#queue;
  }

  async #sync(): Promise<void> {
    try {
      const found = await this.#getTarget();
      if (!("target" in found)) return await this.#close(found.reason);
      const tls = await this.deps.readTls().catch(() => null);
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
    const identity = await this.deps.readIdentity();
    const address = identity === null ? null : this.deps.getAddress(identity.interface);
    const decision = getListenDecision({ ...this.deps.settings, identity, address });
    if (!decision.open || identity === null || address === null) return { reason: decision.reason };
    return { target: { address, key: `${identity.gateway}|${identity.hardwareAddress}|${address}` } };
  }

  async #open(target: Target, tls: RemoteTls): Promise<void> {
    try {
      this.#current = { handle: await this.deps.open(target.address, tls), key: target.key, cert: tls.cert };
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
