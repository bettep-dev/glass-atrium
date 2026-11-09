// Format-drift guard: socket delivery stays on only while the installed Claude Code bundle still holds every inbox
// protocol literal the sender relies on. File reads and a streamed scan only → never a `claude` child, never quota.
// Fail closed: the process-wide switch is off until a scan for the current key passes. No canary runs (owner default).

import { type FileHandle, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { QueueBundleResult } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { logger } from "../logger.js";

/** Auth frame · user-frame handler · receipt action · inbound policy setting · socket dir. */
export const BUNDLE_LITERALS = ['"type":"auth"', 'e.type==="user"', "peer_message_status", "crossSessionInbound", "cc-socks"] as const;

const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
const PACKAGE_JSON_MAX_BYTES = 64 * 1024;
const VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
// Untrusted file content: only `version` is read, and only in the shape a drift-check key may hold
const packageJsonSchema = z.object({ version: z.string().regex(VERSION_SHAPE) });

export interface DriftGuardDeps {
  /** The resolved `claude` launcher; its realpath is the scanned binary. */
  claudePath: string;
  now: () => Date;
  setDeliveryOn: (isOn: boolean) => void;
  /** Scan read size; the overlap kept between reads is the longest literal minus one byte. */
  chunkBytes?: number;
}

export interface DriftGuard {
  /**
   * Re-reads the key; a changed key turns delivery off at once, then reuses the stored result or scans. Never throws.
   * @param signal - ends a scan in progress (monitor stop) → delivery stays off, the next check scans again
   */
  check(signal?: AbortSignal): Promise<void>;
}

interface BundleKey {
  binaryRealpath: string;
  binarySize: bigint;
  binaryModifiedAt: Date;
  version: string;
}

let isProcessDeliveryOn = false;

/** The switch every reader shares: the sweep's socket step, the owner views, the count. */
export function isSocketDeliveryOn(): boolean {
  return isProcessDeliveryOn;
}

export function setSocketDeliveryOn(isOn: boolean): void {
  isProcessDeliveryOn = isOn;
}

export function createDriftGuard(deps: DriftGuardDeps): DriftGuard {
  return new BundleDriftGuard(deps);
}

class BundleDriftGuard implements DriftGuard {
  // Key of the last completed check in this run → an equal key keeps the switch as that check left it
  private checkedKey: BundleKey | null = null;
  private hasFailed = false;

  constructor(private readonly deps: DriftGuardDeps) {}

  async check(signal?: AbortSignal): Promise<void> {
    const { claudePath } = this.deps;
    try {
      const key = await getBundleKey(claudePath);
      if (this.checkedKey !== null && isSameKey(key, this.checkedKey)) return;
      this.checkedKey = null;
      this.deps.setDeliveryOn(false);
      const result = (await findStoredResult(key)) ?? (await putScanResult(key, this.deps, signal));
      this.checkedKey = key;
      this.hasFailed = false;
      this.deps.setDeliveryOn(result === "pass");
    } catch (error) {
      this.checkedKey = null;
      this.deps.setDeliveryOn(false);
      if (signal?.aborted) return; // monitor stop ended the scan → not a drift failure; the next start scans again
      // every pass retries → warn on the first failure only, so a lasting one does not flood the log
      logger[this.hasFailed ? "debug" : "warn"]({ err: error, claudePath }, "queue drift check failed — socket delivery off until a scan for the current key passes");
      this.hasFailed = true;
    }
  }
}

// Version from the package.json two levels above the binary's realpath → a file read, never `claude --version`
async function getBundleKey(claudePath: string): Promise<BundleKey> {
  const binaryRealpath = await realpath(claudePath);
  const stats = await stat(binaryRealpath);
  const packageJsonPath = path.join(path.dirname(path.dirname(binaryRealpath)), "package.json");
  return { binaryRealpath, binarySize: BigInt(stats.size), binaryModifiedAt: stats.mtime, version: await getPackageVersion(packageJsonPath) };
}

async function getPackageVersion(packageJsonPath: string): Promise<string> {
  if ((await stat(packageJsonPath)).size > PACKAGE_JSON_MAX_BYTES) throw new Error(`${packageJsonPath} exceeds ${PACKAGE_JSON_MAX_BYTES} bytes`);
  const parsed = packageJsonSchema.safeParse(JSON.parse(await readFile(packageJsonPath, "utf8")));
  if (!parsed.success) throw new Error(`${packageJsonPath} holds no usable version`, { cause: parsed.error });
  return parsed.data.version;
}

function isSameKey(left: BundleKey, right: BundleKey): boolean {
  return (
    left.binaryRealpath === right.binaryRealpath &&
    left.binarySize === right.binarySize &&
    left.binaryModifiedAt.getTime() === right.binaryModifiedAt.getTime() &&
    left.version === right.version
  );
}

/** @returns the stored result when the version's row carries this exact key; null → scan */
async function findStoredResult(key: BundleKey): Promise<QueueBundleResult | null> {
  const row = await getPrisma().queueDriftCheck.findUnique({ where: { version: key.version } });
  if (row === null || !isSameKey(row, key)) return null;
  return row.bundleResult;
}

// One row per version: a changed key for the same version rewrites it; canary stays empty (none configured)
async function putScanResult(key: BundleKey, deps: DriftGuardDeps, signal?: AbortSignal): Promise<QueueBundleResult> {
  const missing = await findMissingLiterals(key.binaryRealpath, deps.chunkBytes ?? SCAN_CHUNK_BYTES, signal);
  const result: QueueBundleResult = missing.length === 0 ? "pass" : "fail";
  if (result === "fail") logger.warn({ version: key.version, missing }, "queue drift check: bundle literals missing — socket delivery off");
  const data = { ...key, bundleResult: result, canaryResult: null, checkedAt: deps.now() };
  await getPrisma().queueDriftCheck.upsert({ where: { version: key.version }, create: data, update: data });
  return result;
}

/** Streams the file in bounded reads, never the whole bundle in memory. @returns the literals not found */
async function findMissingLiterals(filePath: string, chunkBytes: number, signal?: AbortSignal): Promise<string[]> {
  const needles = new Map<string, Buffer>(BUNDLE_LITERALS.map((literal) => [literal, Buffer.from(literal, "utf8")]));
  const handle = await open(filePath, "r");
  try {
    await deleteFoundNeedles(handle, needles, chunkBytes, signal);
  } finally {
    await handle.close();
  }
  return [...needles.keys()];
}

// Each read keeps the previous read's tail (longest literal − 1 bytes) → a literal split across two reads is still found
async function deleteFoundNeedles(handle: FileHandle, needles: Map<string, Buffer>, chunkBytes: number, signal?: AbortSignal): Promise<void> {
  const overlap = Math.max(...[...needles.values()].map((needle) => needle.length)) - 1;
  const buffer = Buffer.alloc(chunkBytes + overlap);
  let carried = 0;
  for (let position = 0; needles.size > 0; ) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, carried, chunkBytes, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    const window = buffer.subarray(0, carried + bytesRead);
    for (const [literal, needle] of needles) if (window.includes(needle)) needles.delete(literal);
    carried = Math.min(overlap, window.length);
    buffer.copy(buffer, 0, window.length - carried, window.length);
  }
}
