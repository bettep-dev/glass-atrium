// Process start time, server-read: the one source register and the probe compare, so a client value is never trusted.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { QueueEnvironmentError } from "./errors.js";

const execFileAsync = promisify(execFile);

const PS = {
  // `lstart` follows TZ → a fixed env keeps register and a later probe in one zone across monitor restarts
  ENV: { TZ: "UTC", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  TIMEOUT_MS: 2_000,
} as const;

/**
 * Raw `ps -o lstart=` string for a pid, compared as a string and never parsed.
 * @returns null when no process holds the pid (ps exits non-zero or prints nothing)
 */
export async function getProcessStartTime(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      env: PS.ENV,
      timeout: PS.TIMEOUT_MS,
    });
    const startTime = stdout.trim();
    return startTime === "" ? null : startTime;
  } catch (error) {
    if (isNoSuchProcess(error)) return null;
    throw new QueueEnvironmentError(`ps start-time read failed for pid ${pid}`, { cause: error });
  }
}

// ps exits 1 for an unknown pid; a spawn failure or timeout carries no numeric exit code
function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 1;
}
