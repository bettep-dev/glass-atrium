// Remote listener transport: HTTPS-only server options, socket timeouts and caps, the leaf read and its silent reissue.

import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server as HttpsServer } from "node:https";
import type { Socket } from "node:net";
import path from "node:path";

import type { ConnectionError, FastifyError, FastifyInstance, FastifyReply } from "fastify";

import { logger } from "../logger.js";
import { REMOTE_LIMITS, type RefusalLog, attachConnectionCaps } from "./limits.js";

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

/** The one answer to a request refused before any gate hook — no framework code, no echoed path. */
const FRAMEWORK_REFUSAL_BODY = JSON.stringify({ error: "bad_request" });

/**
 * Fastify server options for the remote instance: TLS 1.3 only → a plain-HTTP request fails at the handshake.
 * A request the parser or the router rejects never reaches the gate → it gets the fixed refusal body.
 * A TLS or parser error reaches `logRefusal`, the instance's one refusal log.
 */
export function getRemoteServerOptions(tls: RemoteTls, logRefusal: RefusalLog) {
  return {
    https: { key: tls.key, cert: tls.cert, minVersion: "TLSv1.3" as const },
    keepAliveTimeout: REMOTE_TIMEOUTS.KEEP_ALIVE_MS,
    frameworkErrors: refuseUnroutable,
    clientErrorHandler: (error: ConnectionError, socket: Socket) => refuseUnparsed(error, socket, logRefusal),
  };
}

// undecodable URL (router) → no route matched, so no gate hook runs
function refuseUnroutable(error: FastifyError, _request: unknown, reply: FastifyReply): void {
  logger.debug({ code: error.code }, "remote request refused before routing");
  void reply.code(400).type("application/json").send(FRAMEWORK_REFUSAL_BODY);
}

// TLS or HTTP parser rejection → there is no request object; the raw socket is answered, then closed
function refuseUnparsed(error: ConnectionError, socket: Socket, logRefusal: RefusalLog): void {
  if (error.code === "ECONNRESET") return;
  // code only → the error object carries the client's raw bytes
  logRefusal({ reason: "client_error", code: error.code, address: socket.remoteAddress ?? "" });
  // a TLS error arrives on a socket Node has already destroyed → logged, nothing left to answer
  if (socket.destroyed) return;
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(FRAMEWORK_REFUSAL_BODY)}\r\nConnection: close\r\n\r\n${FRAMEWORK_REFUSAL_BODY}`,
    );
  }
  socket.destroy();
}

/** Header timeout and connection caps on the instance's own server; call once, before listen. */
export function setRemoteSocketLimits(app: FastifyInstance, logRefusal: RefusalLog): void {
  app.server.headersTimeout = REMOTE_TIMEOUTS.HEADERS_MS;
  attachConnectionCaps(app.server, REMOTE_LIMITS.CONNECTIONS, logRefusal);
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
