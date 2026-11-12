// Queue sweep scheduler: started by main.ts after listen, never by route registration → a test building the app
// or calling registerRoutes on a bare instance starts no timer.

import os from "node:os";
import path from "node:path";

import { logger } from "../logger.js";
import { getQueueCliPath } from "./envelope.js";
import { getQueueImageDir } from "./images.js";
import { getProcessStartTime } from "./process-start-time.js";
import { deleteLeftoverCaptureDirs, findClaudePath, spawnClaudeLauncher } from "./resume-spawn.js";
import { type SweepDeps, deleteTokenFiles, deleteUnusedImages, runSweepPass } from "./sweep.js";

const SWEEP_INTERVAL_MS = 30_000;

export interface QueueScheduler {
  /** Stops the interval and waits for a pass in progress. */
  stop(): Promise<void>;
}

/**
 * Production deps under `${GA_ROOT:-$HOME/.glass-atrium}`: token files in data/queue/tokens, resume captures in
 * data/queue/resume-capture, owner images in data/queue/images, the CLI in scripts/. No `claude` on PATH → automatic resume off (fail closed).
 */
export function getSweepDeps(gaRoot: string = process.env.GA_ROOT || path.join(os.homedir(), ".glass-atrium")): SweepDeps {
  const claudePath = findClaudePath();
  if (claudePath === null) logger.warn("queue automatic resume off — no executable claude on the monitor PATH");
  return {
    readStartTime: getProcessStartTime,
    now: () => new Date(),
    cliPath: getQueueCliPath(gaRoot),
    tokenDir: path.join(gaRoot, "data", "queue", "tokens"),
    imageDir: getQueueImageDir(gaRoot),
    ...(claudePath === null ? {} : { resume: { launcher: spawnClaudeLauncher, claudePath, captureDir: path.join(gaRoot, "data", "queue", "resume-capture") } }),
  };
}

/**
 * Runs one pass at once (the start sweep, after clearing capture dirs a restart left behind), then one per interval;
 * a tick while a pass runs is skipped. Stop ends the capture reads, never the resumed sessions.
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
  if (deps.resume === undefined) return deps;
  const signal = deps.resume.signal === undefined ? stopSignal : AbortSignal.any([stopSignal, deps.resume.signal]);
  return { ...deps, resume: { ...deps.resume, signal } };
}

async function runScheduledPass(deps: SweepDeps, isStart: boolean): Promise<void> {
  try {
    if (isStart && deps.resume !== undefined) await deleteLeftoverCaptureDirs(deps.resume.captureDir);
    await runSweepPass(deps);
    await deleteTokenFiles(deps);
    await deleteUnusedImages(deps);
  } catch (error) {
    logger.error({ err: error }, "queue sweep pass failed — the next interval retries");
  }
}
