// Circuit-breaker state reader for the agents summary route. The hook side
// (track-outcome.sh) owns the files; this module only reads them, forward from
// registry names — the on-disk key is a lossy transform of the agent name, so a
// directory listing can never be reversed back into names.

import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  AgentCircuitBreakerItem,
  AgentCircuitBreakerSummary,
} from "../types/agents.js";

export interface AgentCircuitBreakerSnapshot {
  states: Map<string, AgentCircuitBreakerItem>;
  summary: AgentCircuitBreakerSummary;
}

// Env override keeps the suite off the operator's live dir — same precedent as
// AGENT_REGISTRY_PATH in ./registry.ts.
export function resolveCircuitBreakerDir(): string {
  const override = process.env.AGENT_CIRCUIT_BREAKER_DIR;
  if (override && override.trim() !== "") {
    return override;
  }
  return path.join(homedir(), ".claude", "data", "agent-circuit-breaker");
}

// Mirrors the hook's hook_path_safe_key transform: anything outside the
// filename-safe class collapses to '_'.
export function toCircuitBreakerKey(agent: string): string {
  return agent.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function loadAgentCircuitBreakerSnapshot(
  agentNames: readonly string[],
): Promise<AgentCircuitBreakerSnapshot> {
  const dir = resolveCircuitBreakerDir();
  const states = new Map<string, AgentCircuitBreakerItem>();
  const alarms: AgentCircuitBreakerSummary["alarms"] = [];

  const dirState = await probeStateDir(dir);
  if (dirState === "unavailable") {
    return {
      states,
      summary: {
        source: "unavailable",
        registry_agents: agentNames.length,
        suspended_count: 0,
        streak_count: 0,
        alarms: [],
      },
    };
  }

  for (const agent of agentNames) {
    const item = await readAgentState(dir, agent);
    if (item === null) {
      return {
        states: new Map(),
        summary: {
          source: "unavailable",
          registry_agents: agentNames.length,
          suspended_count: 0,
          streak_count: 0,
          alarms: [],
        },
      };
    }

    states.set(agent, item);
    if (item.suspended || item.consecutive_fails > 0) {
      alarms.push({ agent, ...item });
    }
  }

  // Suspended first, then the longest streak — the alarm lane renders this order.
  alarms.sort(
    (a, b) =>
      Number(b.suspended) - Number(a.suspended) ||
      b.consecutive_fails - a.consecutive_fails ||
      a.agent.localeCompare(b.agent),
  );

  return {
    states,
    summary: {
      source: "loaded",
      registry_agents: agentNames.length,
      suspended_count: alarms.filter((row) => row.suspended).length,
      streak_count: alarms.filter((row) => !row.suspended).length,
      alarms,
    },
  };
}

// Absent dir = no fail was ever recorded (the hook creates it lazily) → a real
// zero. Present but unreadable = unavailable, never a zero.
async function probeStateDir(dir: string): Promise<"loaded" | "unavailable"> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      return "unavailable";
    }
  } catch (error) {
    return isMissing(error) ? "loaded" : "unavailable";
  }

  try {
    await access(dir, constants.R_OK | constants.X_OK);
  } catch {
    return "unavailable";
  }
  return "loaded";
}

// null = the state could not be read (distinct from a zeroed state).
async function readAgentState(
  dir: string,
  agent: string,
): Promise<AgentCircuitBreakerItem | null> {
  const key = toCircuitBreakerKey(agent);
  const fails = await readStateFile(path.join(dir, `${key}.fails`));
  if (fails === null) {
    return null;
  }
  const suspendedAt = await readStateFile(path.join(dir, `${key}.suspended`));
  if (suspendedAt === null) {
    return null;
  }

  const parsed = Number.parseInt(fails.trim(), 10);
  return {
    suspended: suspendedAt !== "",
    consecutive_fails: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
    suspended_at: suspendedAt === "" ? null : parseSuspendedAt(suspendedAt),
  };
}

// "" = file absent (a zero) · null = unreadable.
async function readStateFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    return isMissing(error) ? "" : null;
  }
}

// The marker body is the hook's JSON record; an unparseable body still proves
// suspension, so the timestamp degrades to null rather than the state.
function parseSuspendedAt(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && "suspended_ts" in parsed) {
      const ts = (parsed as { suspended_ts: unknown }).suspended_ts;
      return typeof ts === "string" && ts !== "" ? ts : null;
    }
  } catch {
    return null;
  }
  return null;
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: string }).code === "ENOENT"
  );
}
