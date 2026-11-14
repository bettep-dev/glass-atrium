// Remote listener transport: HTTPS-only server options, socket timeouts and caps, the leaf read and its silent reissue.

import { readFile } from "node:fs/promises";
import type { Server as HttpsServer } from "node:https";
import path from "node:path";

import type { FastifyInstance } from "fastify";

import { REMOTE_LIMITS, attachConnectionCaps } from "./limits.js";

export interface RemoteTls {
  readonly key: Buffer;
  readonly cert: Buffer;
}

/** Leaf files the installer writes under monitor/data/remote-access/ (owner-only); the CA key is never read here. */
export const REMOTE_TLS_FILES = { KEY: "leaf.key", CERT: "leaf.pem" } as const;

const REMOTE_TIMEOUTS = { HEADERS_MS: 10_000, KEEP_ALIVE_MS: 60_000 } as const;

/** Fastify server options for the remote instance: TLS 1.3 only → a plain-HTTP request fails at the handshake. */
export function getRemoteServerOptions(tls: RemoteTls) {
  return {
    https: { key: tls.key, cert: tls.cert, minVersion: "TLSv1.3" as const },
    keepAliveTimeout: REMOTE_TIMEOUTS.KEEP_ALIVE_MS,
  };
}

/** Header timeout and connection caps on the instance's own server; call once, before listen. */
export function setRemoteSocketLimits(app: FastifyInstance): void {
  app.server.headersTimeout = REMOTE_TIMEOUTS.HEADERS_MS;
  attachConnectionCaps(app.server, REMOTE_LIMITS.CONNECTIONS);
}

export async function readRemoteTls(directory: string): Promise<RemoteTls> {
  const [key, cert] = await Promise.all([
    readFile(path.join(directory, REMOTE_TLS_FILES.KEY)),
    readFile(path.join(directory, REMOTE_TLS_FILES.CERT)),
  ]);
  return { key, cert };
}

/** Serves a reissued leaf to every new connection; open connections keep theirs, and the device trusts the CA, so nothing is asked. */
export function setRemoteCertificate(app: FastifyInstance, tls: RemoteTls): void {
  // buildRemoteApp always passes `https` → the instance's server is an https.Server
  (app.server as unknown as HttpsServer).setSecureContext({ key: tls.key, cert: tls.cert, minVersion: "TLSv1.3" });
}
