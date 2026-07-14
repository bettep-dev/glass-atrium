// Shared prod-config alarm seam — escalates an absent-config misconfiguration from a lost
// raw-stderr line to the monitor's structured logger at ERROR level (launchd-captured, greppable).
// Consumed by timezone.ts (ATRIUM_TIMEZONE) + schedule-next-fire.ts (ATRIUM_SCHEDULE_*); a unit
// test injects a capturing sink to assert the alarm fired.

import { logger } from "./logger.js";

export type ConfigAlarmSink = (message: string) => void;

// Default sink bound to a config-var label — logged at ERROR under { config: <label> }.
export function makeConfigAlarm(configLabel: string): ConfigAlarmSink {
  return (message) => {
    logger.error({ config: configLabel }, message);
  };
}

// NODE_ENV=production is set on the monitor launchd job (render-launchd-plists.sh); the DEV-ONLY
// config fallback paths must never silently run under it.
export function isProductionEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === "production";
}
