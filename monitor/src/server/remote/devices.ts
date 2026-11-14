// Registered remote devices: issue a device's cookie value, look it up per request, revoke.
// No server-side expiry and no rotation → a device stays registered until revoked (owner decision, queue item 186).

import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "../../generated/prisma/client.js";

export const DEVICE = {
  // plan 44077 conditions table, "Device cap" row (simplified: 10)
  MAX_ACTIVE: 10,
  // letters (any script), digits, space, hyphen, underscore, period → no markup or quote can reach the page
  LABEL_PATTERN: /^[\p{L}\p{N} ._-]{1,32}$/u,
  // 256 bits from the system CSPRNG
  TOKEN_BYTES: 32,
} as const;

type DeviceDb = Prisma.TransactionClient;

export interface DeviceSummary {
  readonly id: bigint;
  readonly label: string;
}

export interface DeviceListing extends DeviceSummary {
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

/** `token` is returned once, for the Set-Cookie only — never log or store it. */
export type DeviceCreation =
  | { readonly outcome: "created"; readonly device: DeviceSummary; readonly token: string }
  | { readonly outcome: "label_invalid" }
  | { readonly outcome: "cap_reached" };

/**
 * Registers a device after an accepted registration code, usable at once — no Mac confirmation step:
 * plan 44077 "Registration" → "The owner's act" (entering a code shown only on the Mac's own page is the owner's act;
 * the new device appears in the Mac's devices list).
 * Cap check and insert are two statements → the single-use code keeps registrations from racing past the cap.
 */
export async function createDevice(db: DeviceDb, label: string): Promise<DeviceCreation> {
  if (!DEVICE.LABEL_PATTERN.test(label)) return { outcome: "label_invalid" };
  if ((await db.remoteDevice.count({ where: { revokedAt: null } })) >= DEVICE.MAX_ACTIVE) {
    return { outcome: "cap_reached" };
  }
  const issued = randomBytes(DEVICE.TOKEN_BYTES).toString("base64url");
  const device = await db.remoteDevice.create({
    data: { label, tokenHash: getTokenHash(issued) },
    select: { id: true, label: true },
  });
  return { outcome: "created", device, token: issued };
}

/** Active device holding this cookie value, its last-seen time moved to now; revocation is read fresh every call. */
export async function findActiveDevice(db: DeviceDb, presented: string): Promise<DeviceSummary | null> {
  if (presented.length === 0) return null;
  const [device] = await db.remoteDevice.updateManyAndReturn({
    where: { tokenHash: getTokenHash(presented), revokedAt: null },
    data: { lastSeenAt: new Date() },
    select: { id: true, label: true },
  });
  return device ?? null;
}

/** @returns false when the device was unknown or already revoked */
export async function revokeDevice(db: DeviceDb, id: bigint): Promise<boolean> {
  const { count } = await db.remoteDevice.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
  return count > 0;
}

/** @returns the ids revoked by this call → the caller closes their open connections */
export async function revokeAllDevices(db: DeviceDb): Promise<bigint[]> {
  const revoked = await db.remoteDevice.updateManyAndReturn({
    where: { revokedAt: null },
    data: { revokedAt: new Date() },
    select: { id: true },
  });
  return revoked.map((device) => device.id).sort((left, right) => (left < right ? -1 : 1));
}

export function listActiveDevices(db: DeviceDb): Promise<DeviceListing[]> {
  return db.remoteDevice.findMany({
    where: { revokedAt: null },
    orderBy: { id: "asc" },
    select: { id: true, label: true, createdAt: true, lastSeenAt: true },
  });
}

/** SHA-256 → a fast hash suffices for a 256-bit random value; the stored digest cannot be replayed as a cookie. */
function getTokenHash(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash("sha256").update(value, "utf8").digest());
}
