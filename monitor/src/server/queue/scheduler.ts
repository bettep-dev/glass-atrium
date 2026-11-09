// Queue sweep scheduler: started by main.ts after listen, never by route registration → a test building the app
// or calling registerRoutes on a bare instance starts no timer.

import os from "node:os";
import path from "node:path";

import { logger } from "../logger.js";
import { createDriftGuard, isSocketDeliveryOn, setSocketDeliveryOn } from "./drift-guard.js";
import { getProcessStartTime } from "./process-start-time.js";
import { deleteLeftoverCaptureDirs, findClaudePath, spawnClaudeLauncher } from "./resume-spawn.js";
import { connectUnixSocket } from "./socket-channel.js";
import { type SweepDeps, deleteOrphanTokenFiles, runSweepPass } from "./sweep.js";

const SWEEP_INTERVAL_MS = 30_000;

export interface QueueScheduler {
  /** Stops the interval and waits for a pass in progress. */
  stop(): Promise<void>;
}

/**
 * Production deps under `${GA_ROOT:-$HOME/.glass-atrium}`: token files in data/queue/tokens, resume captures in
 * data/queue/resume-capture, the CLI in scripts/. No `claude` on PATH → no drift guard, so socket delivery stays off,
 * and automatic resume off (fail closed).
 * @param replyAddress - the receipt listener's address; null → frames carry no `from`
 */
export function getSweepDeps(replyAddress: string | null, gaRoot: string = process.env.GA_ROOT || path.join(os.homedir(), ".glass-atrium")): SweepDeps {
  const claudePath = findClaudePath();
  if (claudePath === null) logger.warn("queue socket delivery and automatic resume off — no executable claude on the monitor PATH");
  return {
    connector: connectUnixSocket,
    readStartTime: getProcessStartTime,
    isSocketDeliveryOn,
    ...(claudePath === null ? {} : { driftGuard: createDriftGuard({ claudePath, now: () => new Date(), setDeliveryOn: setSocketDeliveryOn }) }),
    ...(replyAddress === null ? {} : { replyAddress }),
    now: () => new Date(),
    cliPath: path.join(gaRoot, "scripts", "atrium-queue.sh"),
    tokenDir: path.join(gaRoot, "data", "queue", "tokens"),
    ...(claudePath === null ? {} : { resume: { launcher: spawnClaudeLauncher, claudePath, captureDir: path.join(gaRoot, "data", "queue", "resume-capture") } }),
  };
}

/**
 * Runs one pass at once (the start sweep, after clearing capture dirs a restart left behind), then one per interval;
 * a tick while a pass runs is skipped. Stop ends the capture reads and a drift scan, never the resumed sessions.
 */
export function startQueueScheduler(deps: SweepDeps, intervalMs: number = SWEEP_INTERVAL_MS): QueueScheduler {
  const abort = new AbortController();
  const passDeps = withStopSignal(deps, abort.signal);
  let running: Promise<void> | null = null;
  const tick = (isStart: boolean): void => {
    if (running !== null) return;
    running = runScheduledPass(passDeps, isStart).finally(() => {
      running = null;
    });
  };
  tick(true);
  const timer = setInterval(() => tick(false), intervalMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      abort.abort();
      await running;
    },
  };
}

function withStopSignal(deps: SweepDeps, stopSignal: AbortSignal): SweepDeps {
  const withPassSignal = { ...deps, signal: deps.signal === undefined ? stopSignal : AbortSignal.any([stopSignal, deps.signal]) };
  if (deps.resume === undefined) return withPassSignal;
  const signal = deps.resume.signal === undefined ? stopSignal : AbortSignal.any([stopSignal, deps.resume.signal]);
  return { ...withPassSignal, resume: { ...deps.resume, signal } };
}

async function runScheduledPass(deps: SweepDeps, isStart: boolean): Promise<void> {
  try {
    if (isStart && deps.resume !== undefined) await deleteLeftoverCaptureDirs(deps.resume.captureDir);
    await runSweepPass(deps);
    await deleteOrphanTokenFiles(deps);
  } catch (error) {
    logger.error({ err: error }, "queue sweep pass failed — the next interval retries");
  }
}
