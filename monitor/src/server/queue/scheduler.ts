// Queue sweep scheduler: started by main.ts after listen, never by route registration → a test building the app
// or calling registerRoutes on a bare instance starts no timer.

import os from "node:os";
import path from "node:path";

import { logger } from "../logger.js";
import { getProcessStartTime } from "./process-start-time.js";
import { connectUnixSocket } from "./socket-channel.js";
import { type SweepDeps, removeOrphanTokenFiles, runSweepPass } from "./sweep.js";

const SWEEP_INTERVAL_MS = 30_000;

export interface QueueScheduler {
  /** Stops the interval and waits for a pass in progress. */
  stop(): Promise<void>;
}

/** Production deps under `${GA_ROOT:-$HOME/.glass-atrium}`: token files in data/queue/tokens, the CLI in scripts/. */
export function resolveSweepDeps(gaRoot: string = process.env.GA_ROOT || path.join(os.homedir(), ".glass-atrium")): SweepDeps {
  return {
    connector: connectUnixSocket,
    readStartTime: getProcessStartTime,
    // ponytail: socket delivery stays off until the format-drift guard (S3b) passes a scan for the current key → live rows get answers by pull
    isSocketDeliveryOn: () => false,
    now: () => new Date(),
    cliPath: path.join(gaRoot, "scripts", "atrium-queue.sh"),
    tokenDir: path.join(gaRoot, "data", "queue", "tokens"),
  };
}

/** Runs one pass at once (the start sweep), then one per interval; a tick while a pass runs is skipped. */
export function startQueueScheduler(deps: SweepDeps, intervalMs: number = SWEEP_INTERVAL_MS): QueueScheduler {
  let running: Promise<void> | null = null;
  const tick = (): void => {
    if (running !== null) return;
    running = runScheduledPass(deps).finally(() => {
      running = null;
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}

async function runScheduledPass(deps: SweepDeps): Promise<void> {
  try {
    await runSweepPass(deps);
    await removeOrphanTokenFiles(deps);
  } catch (error) {
    logger.error({ err: error }, "queue sweep pass failed — the next interval retries");
  }
}
