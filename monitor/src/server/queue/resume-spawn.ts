// Automatic resume spawn: argument-vector `claude --resume <uuid> --bg <payload>` under the allowlist env, its stdout a
// per-spawn 0600 file, never a pipe → a monitor restart never ends the session through a closed read end.
// The bg id read is bounded in size and time and never awaited by the claim or the sweep.

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { type FileHandle, chmod, mkdir, mkdtemp, open, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { errnoCode } from "../errno.js";
import { logger } from "../logger.js";
import { buildClaudeChildEnv } from "./child-env.js";
import { type ClaimHooks, type ResumeClaim, putBgId } from "./resume-claim.js";

const CAPTURE = {
  FILE_NAME: "stdout",
  DIR_PREFIX: "spawn-",
  SIZE_CAP_BYTES: 256,
  TIME_BOUND_MS: 30_000,
  POLL_MS: 100,
} as const;
// Leading letter or digit → the marker card pastes it into `claude logs <id>`, where `-h` would read as an option
const BG_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const SESSION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LaunchRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The capture file, the child's whole stdout; the monitor closes its own copy right after the launch. */
  stdoutFd: number;
}

export interface Launch {
  /** False when no process started (spawn error). */
  started: Promise<boolean>;
  /** Resolves once the launcher process is gone; its exit stands for the end of its output. */
  exited: Promise<void>;
}

export type ClaudeLauncher = (request: LaunchRequest) => Launch;

export interface ResumeDeps {
  launcher: ClaudeLauncher;
  /** Absolute `claude` path resolved once at start. */
  claudePath: string;
  /** Fixed 0700 directory under the data root holding one fresh 0700 directory per spawn. */
  captureDir: string;
  /** Aborted on scheduler stop → capture reads end; the launched sessions keep running. */
  signal?: AbortSignal;
  /** Receives each capture's promise; the pass itself never awaits it. */
  onCapture?: (capture: Promise<void>) => void;
  /** Test seams; `beforeReread` runs between the claim commit and the pre-spawn re-read. */
  hooks?: ClaimHooks & { beforeReread?: () => Promise<void> };
}

export const spawnClaudeLauncher: ClaudeLauncher = (request) => {
  const child = spawn(request.command, request.args, { cwd: request.cwd, env: request.env, stdio: ["ignore", request.stdoutFd, "ignore"], detached: true });
  child.unref();
  const started = new Promise<boolean>((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", (error) => {
      logger.warn({ err: error, cwd: request.cwd }, "queue resume launcher failed to start — no process");
      resolve(false);
    });
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  return { started, exited };
};

/** Argv for one resume; a non-UUID session id is refused, so it can never read as an option. */
export function buildResumeArgs(sessionId: string, payload: string): string[] {
  if (!SESSION_ID_SHAPE.test(sessionId)) throw new TypeError(`resume refused: session id ${JSON.stringify(sessionId)} is not a lowercase UUID`);
  return ["--resume", sessionId, "--bg", payload];
}

/**
 * Spawns one resume and starts its bg id capture without awaiting the read.
 * @returns false when no process started (a failure before the launch included)
 */
export async function startResumeSpawn(claim: ResumeClaim, payload: string, deps: ResumeDeps, now: () => Date): Promise<boolean> {
  let capture: { filePath: string; launch: Launch };
  try {
    capture = await launchWithCapture(claim, payload, deps);
  } catch (error) {
    logger.error({ err: error, sessionId: claim.sessionId }, "queue resume spawn failed before launch — no process");
    return false;
  }
  if (!(await capture.launch.started)) {
    await removeCaptureDir(path.dirname(capture.filePath));
    return false;
  }
  deps.onCapture?.(storeBgId(claim, capture.filePath, capture.launch.exited, deps.signal, now));
  return true;
}

/** Start sweep: removes per-spawn directories a restart left behind; an entry holding anything else stays, logged. */
export async function removeLeftoverCaptureDirs(captureDir: string): Promise<void> {
  const names = await readdir(captureDir).catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  });
  await Promise.all(names.map((name) => removeCaptureDir(path.join(captureDir, name))));
}

/** First absolute PATH entry holding an executable `claude`; null → automatic resume stays off. Init-time only. */
export function findClaudePath(pathEnv: string = process.env.PATH ?? ""): string | null {
  for (const dirPath of pathEnv.split(path.delimiter)) {
    if (!path.isAbsolute(dirPath)) continue;
    const candidate = path.join(dirPath, "claude");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

async function launchWithCapture(claim: ResumeClaim, payload: string, deps: ResumeDeps): Promise<{ filePath: string; launch: Launch }> {
  const args = buildResumeArgs(claim.sessionId, payload);
  const { launcher, claudePath, captureDir } = deps;
  const { filePath, handle } = await createCaptureFile(captureDir);
  try {
    const launch = launcher({ command: claudePath, args, cwd: claim.cwd, env: buildClaudeChildEnv(claim.configDir), stdoutFd: handle.fd });
    return { filePath, launch };
  } finally {
    await handle.close();
  }
}

async function createCaptureFile(captureDir: string): Promise<{ filePath: string; handle: FileHandle }> {
  await mkdir(captureDir, { recursive: true, mode: 0o700 });
  await chmod(captureDir, 0o700);
  const spawnDir = await mkdtemp(path.join(captureDir, CAPTURE.DIR_PREFIX));
  const filePath = path.join(spawnDir, CAPTURE.FILE_NAME);
  return { filePath, handle: await open(filePath, "wx", 0o600) };
}

async function storeBgId(claim: ResumeClaim, filePath: string, exited: Promise<void>, signal: AbortSignal | undefined, now: () => Date): Promise<void> {
  try {
    const line = await readFirstLine(filePath, exited, signal, now);
    if (line !== null && BG_ID_SHAPE.test(line)) await putBgId(claim, line);
  } catch (error) {
    logger.warn({ err: error, sessionId: claim.sessionId }, "queue resume bg id capture failed — field left empty");
  } finally {
    await removeCaptureDir(path.dirname(filePath));
  }
}

// Follows the growing file; stops at a newline, the launcher's exit, the size cap, the time bound or an abort
async function readFirstLine(filePath: string, exited: Promise<void>, signal: AbortSignal | undefined, now: () => Date): Promise<string | null> {
  let hasExited = false;
  void exited.then(() => (hasExited = true));
  const handle = await open(filePath, "r");
  try {
    const deadline = now().getTime() + CAPTURE.TIME_BOUND_MS;
    const buffer = Buffer.alloc(CAPTURE.SIZE_CAP_BYTES + 1);
    let length = 0;
    for (;;) {
      const wasExited = hasExited;
      length += (await handle.read(buffer, length, buffer.length - length, length)).bytesRead;
      const line = getCompleteLine(buffer.subarray(0, length), wasExited);
      if (line !== undefined) return line;
      if (signal?.aborted === true || now().getTime() >= deadline) return null;
      await delay(CAPTURE.POLL_MS);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Only a complete line is kept: newline-ended, or the whole output once the launcher has exited.
 * @returns undefined while more input may still come; null for a size-cap cut
 */
function getCompleteLine(bytes: Buffer, hasExited: boolean): string | null | undefined {
  const newline = bytes.indexOf(0x0a);
  if (newline !== -1) return bytes.subarray(0, newline).toString("utf8");
  if (bytes.length > CAPTURE.SIZE_CAP_BYTES) return null;
  return hasExited ? bytes.toString("utf8") : undefined;
}

// No recursive delete: the one capture file, then the empty directory; anything else stays in place, logged
async function removeCaptureDir(spawnDir: string): Promise<void> {
  try {
    const entries = await readdir(spawnDir);
    if (entries.some((entry) => entry !== CAPTURE.FILE_NAME)) {
      logger.warn({ spawnDir, entryCount: entries.length }, "queue resume capture dir holds other entries — left in place");
      return;
    }
    if (entries.length > 0) await unlink(path.join(spawnDir, CAPTURE.FILE_NAME));
    await rmdir(spawnDir);
  } catch (error) {
    logger.warn({ err: error, spawnDir }, "queue resume capture dir cleanup failed — left in place");
  }
}

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return false;
    throw error;
  }
}
