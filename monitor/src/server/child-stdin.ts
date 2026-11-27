import type { ChildProcess } from "node:child_process";

import { logger } from "./logger.js";

/**
 * Ends the child's stdin with `input`; undefined input leaves stdin as spawned.
 * Child gone before the write lands → EPIPE on stdin; unheard, it is an uncaughtException that exits the monitor → a debug line instead.
 * @param log - the caller's own fields and message for that debug line
 */
export function putChildStdin(child: ChildProcess, input: string | undefined, log: { fields: Record<string, unknown>; message: string }): void {
  child.stdin?.on("error", (error) => {
    logger.debug({ err: error, ...log.fields }, log.message);
  });
  if (input !== undefined) child.stdin?.end(input);
}
