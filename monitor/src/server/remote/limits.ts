// In-house limits for the remote listener: fixed per-key request windows and the connection caps (no new dependency).

import type { Server, Socket } from "node:net";

export interface WindowLimit {
  readonly limit: number;
  readonly windowMs: number;
  /** Set → reaching the limit blocks the key this long, past the end of its window. */
  readonly blockMs?: number;
}

export const REMOTE_LIMITS = {
  PRE_AUTH: { limit: 60, windowMs: 60_000 },
  CODE_PER_ADDRESS: { limit: 3, windowMs: 60_000 },
  CODE_TOTAL: { limit: 10, windowMs: 60_000 },
  FAILED_SESSION: { limit: 20, windowMs: 10 * 60_000, blockMs: 15 * 60_000 },
  DEVICE_REQUESTS: { limit: 600, windowMs: 60_000 },
  DEVICE_MUTATIONS: { limit: 60, windowMs: 60_000 },
  CONNECTIONS: { total: 32, perAddress: 8 },
} as const;

// keys are LAN addresses and device ids → small sets; past this, expired entries are swept on the next hit
const SWEEP_THRESHOLD = 1_024;

interface KeyWindow {
  start: number;
  count: number;
  blockedUntil: number;
}

export class WindowLimiter {
  readonly #windows = new Map<string, KeyWindow>();

  constructor(
    private readonly config: WindowLimit,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit for the key. @returns false when this hit is past the limit or the key is blocked */
  hit(key: string): boolean {
    const now = this.now();
    if (this.#windows.size > SWEEP_THRESHOLD) this.#deleteExpired(now);
    const window = this.#getWindow(key, now);
    window.count += 1;
    if (this.config.blockMs !== undefined && window.count >= this.config.limit) window.blockedUntil = now + this.config.blockMs;
    return window.count <= this.config.limit && window.blockedUntil <= now;
  }

  /** Reads the block state without counting a hit. */
  isBlocked(key: string): boolean {
    const now = this.now();
    const window = this.#windows.get(key);
    if (window === undefined) return false;
    return window.blockedUntil > now || (now - window.start < this.config.windowMs && window.count >= this.config.limit);
  }

  #getWindow(key: string, now: number): KeyWindow {
    const current = this.#windows.get(key);
    if (current !== undefined && now - current.start < this.config.windowMs) return current;
    const fresh = { start: now, count: 0, blockedUntil: current?.blockedUntil ?? 0 };
    this.#windows.set(key, fresh);
    return fresh;
  }

  #deleteExpired(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.config.windowMs && window.blockedUntil <= now) this.#windows.delete(key);
    }
  }
}

/** Closes any connection past the total or per-address cap as soon as it is accepted. */
export function attachConnectionCaps(server: Server, caps: { readonly total: number; readonly perAddress: number }): void {
  const perAddress = new Map<string, number>();
  let total = 0;
  // prepended → runs before the server's own handler (TLS handshake, HTTP parser) sees the socket
  server.prependListener("connection", (socket: Socket) => {
    const address = socket.remoteAddress ?? "";
    const addressCount = perAddress.get(address) ?? 0;
    if (total >= caps.total || addressCount >= caps.perAddress) {
      socket.destroy();
      return;
    }
    total += 1;
    perAddress.set(address, addressCount + 1);
    socket.once("close", () => {
      total -= 1;
      const remaining = (perAddress.get(address) ?? 1) - 1;
      if (remaining === 0) perAddress.delete(address);
      else perAddress.set(address, remaining);
    });
  });
}
