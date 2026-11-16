// Remote device session: the device cookie and the per-device CSRF value the page echoes on every mutation.

import { createHash, timingSafeEqual } from "node:crypto";

import type { CookieSerializeOptions } from "@fastify/cookie";

export const CSRF_HEADER = "x-csrf-token";

export const DEVICE_COOKIE = {
  // __Host- → browser enforces Secure, Path=/ and no Domain (host-only)
  NAME: "__Host-ga_device",
  // 400 days = the browser maximum; re-sent on use so it never lapses
  MAX_AGE_S: 400 * 24 * 60 * 60,
} as const;

export const DEVICE_COOKIE_OPTIONS: CookieSerializeOptions = {
  maxAge: DEVICE_COOKIE.MAX_AGE_S,
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "strict",
};

/**
 * Per-device CSRF value, derived from the HttpOnly cookie value → no storage, and no page script on another origin can compute it.
 * The page reads it from its session endpoint and sends it in CSRF_HEADER.
 */
export function getCsrfToken(deviceValue: string): string {
  return getCsrfDigest(deviceValue).toString("base64url");
}

/** Constant-time check of a presented CSRF value against the device's own. */
export function isCsrfTokenValid(deviceValue: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  // equal-length digests → timingSafeEqual never throws
  return timingSafeEqual(createHash("sha256").update(presented, "utf8").digest(), createHash("sha256").update(getCsrfToken(deviceValue), "utf8").digest());
}

function getCsrfDigest(deviceValue: string): Buffer {
  return createHash("sha256").update(`glass-atrium remote csrf\0${deviceValue}`, "utf8").digest();
}
