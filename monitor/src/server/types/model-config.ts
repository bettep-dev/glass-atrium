// Response/request shapes for /api/model-config (spec doc 36166). The GET shape is the
// frozen contract for the "Models & budgets" screen (T3) — field renames are breaking.

import type { UnreadableAgentFile } from "../agents/registry.js";

export type ApplyMode =
  | "next-spawn"
  | "next-cycle"
  | "tmux-restart"
  | "immediate";

export type ModelDomainKey = "model.daemon_cycle_worker";

export type BudgetDomainKey = "budget.worker_max_usd" | "budget.pre_verify_max_usd";

export type TierDomainKey =
  | "tier.worker_effort"
  | "tier.pre_verify_effort"
  | "tier.worker_max_output_tokens"
  | "tier.pre_verify_max_output_tokens";

// DB desired-state vs rendered daemon-config.json consumer view (D2 write-through).
// 'pending-migration': a renamed domain's value was read from its PRE-rename row because the
// rename migration has not run on this DB, so no comparison against the file can be called
// in-sync yet — the rename is the root cause and `glass-atrium db-setup` is its remedy.
// 'file-invalid': the file holds a tier-knob value the daemon loader rejects → every cycle stops, whatever the DB holds.
export type DaemonConfigSyncState = "ok" | "drift" | "file-missing" | "pending-migration" | "file-invalid";

export interface DomainStatus {
  domain: ModelDomainKey;
  desired: string | null;
  // the 'inherit (settings.json)' label (absent daemon-config key) is a display value, not raw file bytes
  actual: string | null;
  // Compared after variant-suffix normalization ('claude-fable-5[1m]' == 'claude-fable-5').
  drift: boolean;
  apply_mode: ApplyMode;
  editable: boolean;
  pricing_known: boolean;
}

// Per-call hard-cap budgets — the values passed to `claude -p --max-budget-usd`. desired =
// DB SoT; actual = what the rendered daemon-config.json currently carries (drift surfaced).
export interface BudgetDomainStatus {
  domain: BudgetDomainKey;
  desired: string | null;
  actual: string | null;
  drift: boolean;
  apply_mode: ApplyMode;
}

/**
 * Daemon `claude -p` tier knob — the --effort level or CLAUDE_CODE_MAX_OUTPUT_TOKENS.
 * desired 'inherit' = key removed → CLI default.
 * actual = the file value the daemon runs with; null when the key is unset or rejected.
 */
export interface TierDomainStatus {
  domain: TierDomainKey;
  desired: string | null;
  actual: string | null;
  // The daemon loader's reason for rejecting the file value; null when the value is unset or accepted.
  file_error: string | null;
  drift: boolean;
  apply_mode: ApplyMode;
}

export interface ModelConfigGetResponse {
  fetched_at: string;
  // SoT-derived roster (pricing.json `models` keys) — the client's dropdown source.
  // [] when the SoT is unreadable (D3 fail-open; GET still 200s).
  known_models: string[];
  domains: DomainStatus[];
  budgets: BudgetDomainStatus[];
  tiers: TierDomainStatus[];
  daemon_config_sync: DaemonConfigSyncState;
  // One row per agent file of the agents folder, sorted by name; entries failing a read check go to `unreadable`.
  agents: AgentModel[];
  unreadable: UnreadableAgentFile[];
}

/** One agent on the Models screen; `file` is the base name, never a path. */
export interface AgentModel {
  name: string;
  file: string;
  // registry.ts → toRoleLine; null when the description is absent or empty
  role: string | null;
  // `model:` value cut to the model id pattern; null = no model line (no pin)
  pin: string | null;
  // false → no agent-registry.json entry for the name
  registered: boolean;
}

export interface SurfaceResult {
  surface: "daemon-config.json";
  status: "ok" | "skipped" | "failed";
  reason?: string;
}

export interface ModelConfigPutResponse extends ModelConfigGetResponse {
  surfaces: SurfaceResult[];
}

export interface ModelConfigPutBody {
  models?: Partial<Record<ModelDomainKey, string>>;
  budgets?: Partial<Record<BudgetDomainKey, string>>;
  tiers?: Partial<Record<TierDomainKey, string>>;
}

/** PUT /api/model-config/agents: one model for every named agent, each with the pin the page last showed. */
export interface AgentPinPutBody {
  // a known_models id, or 'inherit' → no model line
  model: string;
  agents: Array<{ name: string; expected_pin: string | null }>;
}

/** One named agent's outcome; `reason` only on `refused`. */
export interface AgentPinResult {
  name: string;
  status: "applied" | "unchanged" | "changed_since_load" | "refused" | "gone";
  reason?: string;
}

export interface AgentPinPutResponse extends Pick<ModelConfigGetResponse, "agents" | "unreadable"> {
  results: AgentPinResult[];
}

export type ModelConfigErrorBody =
  | { error: "invalid_body"; field: string; reason: string }
  // daemon-apply stash window guard: the filesystem .apply-lock dir; absent → no apply running
  | { error: "daemon_apply_in_progress"; reason: string }
  | { error: "apply_in_progress" | "model_roster_unavailable" | "agent_list_unavailable"; reason: string };
