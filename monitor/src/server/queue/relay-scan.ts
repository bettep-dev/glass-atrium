// Relay text secret check: runs the install's one scanner (scripts/lib/secret-scan.sh) with no shell, no argument, a
// constant environment and the text on stdin only; its exit contract is read fail-closed, so only a clean exit passes.

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

import { logger } from "../logger.js";

const SCAN = {
  TIMEOUT_MS: 2_000,
  STDOUT_CAP_CHARS: 256,
  EXIT_CLEAN: 0,
  EXIT_MATCH: 3,
} as const;
// bash and grep only; C locale → byte-wise matching, so no input reads as an invalid multibyte sequence
const SCAN_ENV = { PATH: "/usr/bin:/bin", LC_ALL: "C" } as const;
const PATTERN_CODE = /^SEC-\d{3}$/;

/** clean → store · match → refuse, naming at most the pattern code · unavailable → refuse (spawn failure, timeout, signal, any other exit). */
export type ScanOutcome = { verdict: "clean" } | { verdict: "match"; pattern: string | null } | { verdict: "unavailable" };

/** The scanner under a GA root, fixed once at route registration. */
export function getSecretScannerPath(gaRoot: string): string {
  return path.join(gaRoot, "scripts", "lib", "secret-scan.sh");
}

/**
 * Scans the text in one scanner run; a scanner past its timeout is killed with its whole process group.
 * @param text - every form the checks read, one per line (raw and normalized)
 */
export function scanText(scannerPath: string, text: string): Promise<ScanOutcome> {
  return new Promise((resolve) => {
    const child = spawn(scannerPath, [], { env: SCAN_ENV, stdio: ["pipe", "pipe", "ignore"], detached: true });
    let stdout = "";
    const timer = setTimeout(() => killGroup(child), SCAN.TIMEOUT_MS);
    // a spawn failure may end in both events → the first outcome stands, a promise ignores a second resolve
    const settle = (outcome: ScanOutcome) => {
      clearTimeout(timer);
      resolve(outcome);
    };
    child.once("error", (error) => {
      logger.warn({ err: error }, "relay secret scanner failed to start — relay refused as scan unavailable");
      settle({ verdict: "unavailable" });
    });
    child.once("close", (code, signal) => settle(getOutcome(code, signal, stdout)));
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < SCAN.STDOUT_CAP_CHARS) stdout += chunk;
    });
    // a scanner that exits before reading → EPIPE here; its exit status alone decides the outcome
    child.stdin?.once("error", (error) => logger.debug({ err: error }, "relay secret scanner closed its input early"));
    child.stdin?.end(text);
  });
}

function getOutcome(code: number | null, signal: NodeJS.Signals | null, stdout: string): ScanOutcome {
  if (code === SCAN.EXIT_CLEAN) return { verdict: "clean" };
  if (code === SCAN.EXIT_MATCH) {
    const pattern = stdout.split("\t")[0] ?? "";
    return { verdict: "match", pattern: PATTERN_CODE.test(pattern) ? pattern : null };
  }
  logger.warn({ code, signal }, "relay secret scanner ended outside its exit contract — relay refused as scan unavailable");
  return { verdict: "unavailable" };
}

// detached → the scanner leads its own group, so its grep or sleep children die with it
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    logger.debug({ err: error, pid: child.pid }, "relay secret scanner group already gone at its timeout");
  }
}
