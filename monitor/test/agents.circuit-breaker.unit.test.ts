// Circuit-breaker state reader — the summary route's suspension source.
// No DB: the reader is pure filesystem over AGENT_CIRCUIT_BREAKER_DIR.
//
// Runner: npx tsx --test test/agents.circuit-breaker.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import {
  loadAgentCircuitBreakerSnapshot,
  resolveCircuitBreakerDir,
  toCircuitBreakerKey,
} from "../src/server/agents/circuit-breaker.js";

async function withStateDir(
  build: (dir: string) => Promise<void>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ga-cb-"));
  const stateDir = path.join(dir, "agent-circuit-breaker");
  await mkdir(stateDir);
  await build(stateDir);
  process.env.AGENT_CIRCUIT_BREAKER_DIR = stateDir;
  return stateDir;
}

test("an existing but empty state dir is a loaded zero, never unavailable", async () => {
  await withStateDir(async () => undefined);

  const snapshot = await loadAgentCircuitBreakerSnapshot(["dev-react", "qa-code-reviewer"]);

  assert.equal(snapshot.summary.source, "loaded");
  assert.equal(snapshot.summary.suspended_count, 0);
  assert.equal(snapshot.summary.streak_count, 0);
  assert.deepEqual(snapshot.summary.alarms, []);
  // Every requested name is still resolved — a zero state, not an absent one.
  assert.equal(snapshot.states.size, 2);
  for (const state of snapshot.states.values()) {
    assert.equal(state.suspended, false);
    assert.equal(state.consecutive_fails, 0);
  }
});

test("suspension and streak are reported per agent, suspended sorted first", async () => {
  await withStateDir(async (dir) => {
    await writeFile(path.join(dir, "dev-react.fails"), "3\n");
    await writeFile(
      path.join(dir, "dev-react.suspended"),
      JSON.stringify({ agent: "dev-react", consecutive_fails: 3, suspended_ts: "2026-09-16T00:00:00Z" }),
    );
    await writeFile(path.join(dir, "qa-debugger.fails"), "2\n");
  });

  const snapshot = await loadAgentCircuitBreakerSnapshot([
    "qa-debugger",
    "dev-react",
    "intel-planner",
  ]);

  assert.equal(snapshot.summary.source, "loaded");
  assert.equal(snapshot.summary.suspended_count, 1);
  assert.equal(snapshot.summary.streak_count, 1);
  assert.deepEqual(
    snapshot.summary.alarms.map((row) => row.agent),
    ["dev-react", "qa-debugger"],
  );
  assert.equal(snapshot.summary.alarms[0].suspended_at, "2026-09-16T00:00:00Z");
  assert.equal(snapshot.states.get("intel-planner")?.consecutive_fails, 0);
});

test("the denominator is the requested registry set, and state is looked up forward from it", async () => {
  await withStateDir(async (dir) => {
    await writeFile(path.join(dir, "ghost-agent.fails"), "5\n");
    await writeFile(path.join(dir, "ghost-agent.suspended"), "{}");
  });

  const snapshot = await loadAgentCircuitBreakerSnapshot(["dev-react", "dev-node", "dev-db"]);

  // A file whose key is not in the registry set is never reconstructed into an agent.
  assert.equal(snapshot.summary.registry_agents, 3);
  assert.equal(snapshot.summary.suspended_count, 0);
  assert.equal(snapshot.states.has("ghost-agent"), false);
});

test("an unreadable state dir is unavailable, and publishes no zeroed states", async () => {
  const stateDir = await withStateDir(async (dir) => {
    await writeFile(path.join(dir, "dev-react.fails"), "1\n");
  });
  await chmod(stateDir, 0o000);

  try {
    const snapshot = await loadAgentCircuitBreakerSnapshot(["dev-react"]);

    assert.equal(snapshot.summary.source, "unavailable");
    assert.equal(snapshot.summary.registry_agents, 1);
    assert.equal(snapshot.states.size, 0);
    assert.deepEqual(snapshot.summary.alarms, []);
  } finally {
    await chmod(stateDir, 0o700);
  }
});

test("the on-disk key keeps exactly the characters the hook writer keeps", () => {
  // Writer: hooks/hook-utils.sh -> hook_path_safe_key() { printf '%s' "$1" | tr -cd 'A-Za-z0-9_-'; }
  const writerKey = (name: string) =>
    [...name].filter((ch) => /[A-Za-z0-9_-]/.test(ch)).join("");

  for (const name of ["dev-react", "glass-atrium/dev react", "dev.react", "a b*c", "에이전트-1"]) {
    assert.equal(toCircuitBreakerKey(name), writerKey(name), `reader mirrors the writer for ${name}`);
  }
});

test("the default state dir tracks the hook writer's GA data root, override first", () => {
  const savedOverride = process.env.AGENT_CIRCUIT_BREAKER_DIR;
  const savedRoot = process.env.GA_DATA_ROOT;
  try {
    delete process.env.AGENT_CIRCUIT_BREAKER_DIR;
    process.env.GA_DATA_ROOT = "/tmp/ga-root-sentinel";
    assert.equal(
      resolveCircuitBreakerDir(),
      path.join("/tmp/ga-root-sentinel", "data", "agent-circuit-breaker"),
    );

    delete process.env.GA_DATA_ROOT;
    assert.equal(
      resolveCircuitBreakerDir(),
      path.join(homedir(), ".glass-atrium", "data", "agent-circuit-breaker"),
    );

    process.env.AGENT_CIRCUIT_BREAKER_DIR = "/tmp/explicit-cb-dir";
    assert.equal(resolveCircuitBreakerDir(), "/tmp/explicit-cb-dir");
  } finally {
    if (savedOverride === undefined) {
      delete process.env.AGENT_CIRCUIT_BREAKER_DIR;
    } else {
      process.env.AGENT_CIRCUIT_BREAKER_DIR = savedOverride;
    }
    if (savedRoot === undefined) {
      delete process.env.GA_DATA_ROOT;
    } else {
      process.env.GA_DATA_ROOT = savedRoot;
    }
  }
});
