// Owner sessions: random 256-bit ids held in server memory only → a monitor restart or logout ends them,
// and no signing secret exists that a session could read to mint a cookie.

import { createHash, randomBytes } from "node:crypto";

export const OWNER_COOKIE = {
  NAME: "atrium_queue_owner",
  /** Cookie Path → the browser sends it only to /api/queue/* */
  PATH: "/api/queue",
  MAX_AGE_SECONDS: 7 * 24 * 60 * 60,
  /** Single-owner loopback page; the cap only bounds memory against repeated logins */
  MAX_SESSIONS: 16,
} as const;

const TTL_MS = OWNER_COOKIE.MAX_AGE_SECONDS * 1000;

export class OwnerSessionStore {
  // id digest → expiry; Map keeps insertion order → the first key is the oldest session
  private readonly expiryByDigest = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** @returns the raw session id for the cookie; only its digest is kept */
  create(): string {
    this.deleteExpired();
    while (this.expiryByDigest.size >= OWNER_COOKIE.MAX_SESSIONS) {
      const oldest = this.expiryByDigest.keys().next();
      if (oldest.done) break;
      this.expiryByDigest.delete(oldest.value);
    }
    const id = randomBytes(32).toString("base64url");
    this.expiryByDigest.set(digest(id), this.now() + TTL_MS);
    return id;
  }

  /** Sliding expiry: a live id gets a fresh TTL. @returns false for an unknown or expired id */
  renew(id: string): boolean {
    if (!this.isLive(id)) return false;
    this.expiryByDigest.set(digest(id), this.now() + TTL_MS);
    return true;
  }

  /** Liveness only, expiry left in place → a passive sign-in probe never keeps a session alive. */
  isLive(id: string): boolean {
    const key = digest(id);
    const expiresAt = this.expiryByDigest.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt > this.now()) return true;
    this.expiryByDigest.delete(key);
    return false;
  }

  delete(id: string): void {
    this.expiryByDigest.delete(digest(id));
  }

  private deleteExpired(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.expiryByDigest) {
      if (expiresAt <= now) this.expiryByDigest.delete(key);
    }
  }
}

function digest(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("base64url");
}
