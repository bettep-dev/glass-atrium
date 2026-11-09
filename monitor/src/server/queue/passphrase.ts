// Owner passphrase check against the scrypt record the owner-run setup script writes (S4 writes the same shape).
// Read lazily on first need; only a successful read is cached → provisioning after start needs no restart.

import { scrypt, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { errnoCode } from "../errno.js";
import { QueueEnvironmentError } from "./errors.js";

export const PASSPHRASE = {
  /** JSON record under the secrets directory: { algorithm, N, r, p, keyLength, salt, hash } (salt/hash base64) */
  FILE: "owner-passphrase.json",
  MAX_LENGTH: 1024,
} as const;

// Cost bounds → a replaced record can neither weaken the hash below N=2^14 nor make one login allocate >1 GiB
const SCRYPT_BOUNDS = { MIN_LOG_N: 14, MAX_LOG_N: 20, MAX_R: 16, MAX_P: 4 } as const;

const base64Bytes = (min: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .transform((value) => Buffer.from(value, "base64"))
    .refine((bytes) => bytes.length >= min, `must decode to at least ${min} bytes`);

const recordSchema = z
  .strictObject({
    algorithm: z.literal("scrypt"),
    N: z.int().refine((n) => Number.isInteger(Math.log2(n)) && n >= 2 ** SCRYPT_BOUNDS.MIN_LOG_N && n <= 2 ** SCRYPT_BOUNDS.MAX_LOG_N, "N must be a power of two in bounds"),
    r: z.int().min(1).max(SCRYPT_BOUNDS.MAX_R),
    p: z.int().min(1).max(SCRYPT_BOUNDS.MAX_P),
    keyLength: z.int().min(32).max(128),
    salt: base64Bytes(16),
    hash: base64Bytes(32),
  })
  .refine((record) => record.hash.length === record.keyLength, { message: "hash length must equal keyLength", path: ["hash"] });

type PassphraseRecord = z.infer<typeof recordSchema>;

export type PassphraseCheck = "match" | "mismatch" | "not_provisioned";

export interface PassphraseVerifier {
  verify(passphrase: string): Promise<PassphraseCheck>;
  isProvisioned(): Promise<boolean>;
}

export function createPassphraseVerifier(secretsDir: string): PassphraseVerifier {
  const getRecord = createRecordReader(path.join(secretsDir, PASSPHRASE.FILE));
  return {
    async verify(passphrase) {
      const record = await getRecord();
      if (record === null) return "not_provisioned";
      const derived = await deriveKey(passphrase, record);
      return timingSafeEqual(derived, record.hash) ? "match" : "mismatch";
    },
    async isProvisioned() {
      return (await getRecord()) !== null;
    },
  };
}

function createRecordReader(file: string): () => Promise<PassphraseRecord | null> {
  let cached: PassphraseRecord | null = null;
  return async () => {
    if (cached !== null) return cached;
    const raw = await readRecordFile(file);
    if (raw === null) return null;
    cached = parseRecord(raw);
    return cached;
  };
}

async function readRecordFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw new QueueEnvironmentError("owner passphrase file read failed", { cause: error });
  }
}

// Field names only in the error → the record's values never reach a log
function parseRecord(raw: string): PassphraseRecord {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new QueueEnvironmentError("owner passphrase file is not JSON", { cause: error });
  }
  const parsed = recordSchema.safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new QueueEnvironmentError(`owner passphrase file is malformed: ${fields}`, { cause: undefined });
  }
  return parsed.data;
}

function deriveKey(passphrase: string, record: PassphraseRecord): Promise<Buffer> {
  // scrypt needs 128·N·r·p bytes; Node's 32 MiB default maxmem would refuse the setup script's N=2^17
  const maxmem = 128 * record.N * record.r * record.p + 1024 * 1024;
  return new Promise((resolve, reject) => {
    scrypt(passphrase, record.salt, record.keyLength, { N: record.N, r: record.r, p: record.p, maxmem }, (error, key) => {
      if (error) reject(new QueueEnvironmentError("owner passphrase derivation failed", { cause: error }));
      else resolve(key);
    });
  });
}
