// Agent lifecycle command runner: a child that exits without reading its stdin never takes the monitor down with it.

import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { logger } from "../src/server/logger.js";
import { runCli } from "../src/server/routes/agents.js";

/** Exits at once, reads no stdin → the child is gone before the parent's stdin write lands. */
const NON_READING_BINARY = "/usr/bin/true";

/** Above the 64 KiB pipe buffer → the write cannot complete before the child exits, so EPIPE is certain, not a race. */
const UNREAD_INPUT = "x".repeat(1 << 20);

const cwd = mkdtempSync(path.join(tmpdir(), "agents-runner-"));

before(() => {
  process.env.AGENT_LIFECYCLE_PYTHON = NON_READING_BINARY;
  process.env.AGENT_LIFECYCLE_CWD = cwd;
});

after(() => {
  delete process.env.AGENT_LIFECYCLE_PYTHON;
  delete process.env.AGENT_LIFECYCLE_CWD;
  rmdirSync(cwd);
});

/** Runs `body`, then one more timer turn for a late stream error; @returns every uncaught exception and unhandled rejection seen. */
async function getProcessFaults(body: () => Promise<void>): Promise<unknown[]> {
  const faults: unknown[] = [];
  const onFault = (fault: unknown): void => void faults.push(fault);
  process.on("uncaughtException", onFault);
  process.on("unhandledRejection", onFault);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.off("uncaughtException", onFault);
    process.off("unhandledRejection", onFault);
  }
  return faults;
}

test("an input the child never reads raises no process fault, and the exit code still decides the result", async () => {
  const codes: number[] = [];
  const faults = await getProcessFaults(async () => {
    codes.push((await runCli([], { timeoutMs: 5_000, stdin: UNREAD_INPUT })).code);
  });
  assert.deepEqual({ faults, codes }, { faults: [], codes: [0] });
});

test("an unread stdin write is logged at debug with the command it went to", async () => {
  const args = ["-m", "agent_lifecycle", "delete", "--mode", "preview"];
  const debug = mock.method(logger, "debug", () => undefined);
  try {
    await runCli(args, { timeoutMs: 5_000, stdin: UNREAD_INPUT });
  } finally {
    debug.mock.restore();
  }
  const logged = debug.mock.calls.map((call) => call.arguments[0] as { file?: string; args?: string[]; err?: { code?: string } });
  assert.deepEqual(logged.map((entry) => [entry.file, entry.args, entry.err?.code]), [[NON_READING_BINARY, args, "EPIPE"]]);
});
