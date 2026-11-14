// Remote listener transport: HTTPS-only server options, socket timeouts and caps, the leaf read and its silent reissue.

import { X509Certificate } from "node:crypto";
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

/** The names a served leaf must carry: the Bonjour name (null when unreadable) and the bound Wi-Fi address. */
export interface LeafNames {
  readonly hostName: string | null;
  readonly address: string;
}

const REMOTE_TIMEOUTS = { HEADERS_MS: 10_000, KEEP_ALIVE_MS: 60_000 } as const;
export const LEAF_REISSUE_AHEAD_MS = 30 * 86_400_000;

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

/** Due for reissue: unparseable, expiring within 30 days, or not naming the current host and address. */
export function isLeafDue(cert: Buffer, names: LeafNames, now: number): boolean {
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(cert);
  } catch {
    return true;
  }
  if (leaf.validToDate.getTime() - now < LEAF_REISSUE_AHEAD_MS) return true;
  if (leaf.checkIP(names.address) === undefined) return true;
  return names.hostName !== null && leaf.checkHost(names.hostName, { subject: "never" }) === undefined;
}

/** Serves a reissued leaf to every new connection; open connections keep theirs, and the device trusts the CA, so nothing is asked. */
export function setRemoteCertificate(app: FastifyInstance, tls: RemoteTls): void {
  // buildRemoteApp always passes `https` → the instance's server is an https.Server
  (app.server as unknown as HttpsServer).setSecureContext({ key: tls.key, cert: tls.cert, minVersion: "TLSv1.3" });
}
