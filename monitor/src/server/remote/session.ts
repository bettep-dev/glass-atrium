// Remote device session: the device cookie and the per-device CSRF value the page echoes on every mutation.

export const CSRF_HEADER = "x-csrf-token";

export const DEVICE_COOKIE = {
  // __Host- → browser enforces Secure, Path=/ and no Domain (host-only)
  NAME: "__Host-ga_device",
  // 400 days = the browser maximum; re-sent on use so it never lapses
  MAX_AGE_S: 400 * 24 * 60 * 60,
} as const;
