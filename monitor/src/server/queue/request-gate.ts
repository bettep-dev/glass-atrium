// Queue request gate: Host allowlist (DNS-rebinding block) on every queue route, then the queue key on session routes.

import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";

import { errnoCode } from "../errno.js";

export const QUEUE_KEY = {
  /** Header carrying the shared queue key; the CLI and hooks read the key from their own 0600 file. */
  HEADER: "x-atrium-queue-key",
  /** Key file name under the secrets directory, written by the owner-run provisioning script. */
  FILE: "queue-key",
} as const;

const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"] as const;

export function buildHostAllowlistHook(port: number): onRequestAsyncHookHandler {
  const allowedHosts = new Set(LOOPBACK_HOSTNAMES.map((hostname) => `${hostname}:${port}`));
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!allowedHosts.has((request.headers.host ?? "").toLowerCase())) {
      return reply.code(403).send({ error: "host_not_allowed" });
    }
  };
}

export function buildQueueKeyHook(secretsDir: string): onRequestAsyncHookHandler {
  const getKeyDigest = createKeyDigestReader(secretsDir);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const keyDigest = await getKeyDigest();
    if (keyDigest === null) return reply.code(503).send({ error: "not_provisioned" });
    if (!isKeyMatch(request.headers[QUEUE_KEY.HEADER], keyDigest)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };
}

// Lazy read on first need; only a successful read is cached → provisioning after start needs no restart
function createKeyDigestReader(secretsDir: string): () => Promise<Buffer | null> {
  let cached: Buffer | null = null;
  return async () => {
    if (cached !== null) return cached;
    try {
      const key = (await readFile(path.join(secretsDir, QUEUE_KEY.FILE), "utf8")).trim();
      if (key === "") return null;
      cached = digest(key);
      return cached;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw new Error("queue key file read failed", { cause: error });
    }
  };
}

// Fixed-length digests → timingSafeEqual never throws on a length mismatch and leaks no length
function isKeyMatch(header: string | string[] | undefined, keyDigest: Buffer): boolean {
  if (typeof header !== "string" || header === "") return false;
  return timingSafeEqual(digest(header), keyDigest);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
