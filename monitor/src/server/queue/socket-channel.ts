// Socket delivery into a Claude session inbox: NDJSON, the auth line first, then one user frame per connection.
// The connect is the send-time probe → ENOENT / ECONNREFUSED is "refused", which the sweep turns into stale or exited.
// A closed connection never means delivered: a stale session_id is dropped silently by the receiver, only the ack counts.

import { readFile } from "node:fs/promises";
import { type Socket, createConnection } from "node:net";
import path from "node:path";

import { errnoCode } from "../errno.js";

const CONNECT_TIMEOUT_MS = 2_000;
const REFUSED_CODES = new Set(["ENOENT", "ECONNREFUSED"]);
// Messaging tokens are short; a larger file is not a token the hook wrote
const TOKEN_MAX_BYTES = 1_024;
const TOKEN_SHAPE = /^[\x21-\x7e]{1,512}$/;

export type SocketConnector = (socketPath: string) => Socket;

export type ConnectOutcome = { kind: "open"; socket: Socket } | { kind: "refused" } | { kind: "failed"; error: unknown };

export interface UserFrame {
  sessionId: string;
  msgId: string;
  content: string;
}

export const connectUnixSocket: SocketConnector = (socketPath) => createConnection({ path: socketPath });

/** Connects within a time bound; the caller owns the open socket (write or destroy). */
export function openSocket(socketPath: string, connector: SocketConnector): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    const socket = connector(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ kind: "failed", error: new Error(`connect timed out after ${CONNECT_TIMEOUT_MS} ms`) });
    }, CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve({ kind: "open", socket });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve(REFUSED_CODES.has(errnoCode(error) ?? "") ? { kind: "refused" } : { kind: "failed", error });
    });
  });
}

/** Writes the frames and half-closes; rejects on a socket error before the write is flushed. */
export function writeFrames(socket: Socket, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.end(payload, () => resolve());
  });
}

/** Auth line (when a token file exists) then the user frame, one JSON object per line. */
export function buildFrames(frame: UserFrame, token: string | null): string {
  const lines: object[] = [];
  if (token !== null) lines.push({ type: "auth", token });
  lines.push({ type: "user", session_id: frame.sessionId, msg_id: frame.msgId, message: { role: "user", content: frame.content } });
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

/**
 * The session's messaging token from its 0600 file (written by the SessionStart hook), read as untrusted input.
 * @returns null when the file is missing or its content is not a token shape
 */
export async function getSessionToken(tokenDir: string, sessionId: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(tokenDir, sessionId));
    if (raw.byteLength > TOKEN_MAX_BYTES) return null;
    const value = raw.toString("utf8").trim();
    return TOKEN_SHAPE.test(value) ? value : null;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}
