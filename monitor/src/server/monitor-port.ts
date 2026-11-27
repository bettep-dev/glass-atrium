// Monitor listen port — one resolution shared by main.ts (validation + bind) and the queue Host allowlist.
// SoT = config.toml [ports].monitor, rendered as ATRIUM_MONITOR_PORT at deploy (render-monitor-env.sh); PORT = generic fallback

const DEFAULT_MONITOR_PORT = 16145;

/** Raw resolved port; main.ts rejects a non-integer or out-of-range value before listen. */
export function getMonitorPort(): number {
  return Number(process.env.ATRIUM_MONITOR_PORT ?? process.env.PORT ?? DEFAULT_MONITOR_PORT);
}
