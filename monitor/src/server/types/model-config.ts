// Response/request shapes for /api/model-config (spec doc 36166). The GET shape is the
// frozen contract for the "Models & budgets" screen (T3) — field renames are breaking.

export type ApplyMode =
  | "next-spawn"
  | "next-cycle"
  | "tmux-restart"
  | "immediate";

export type ModelDomainKey =
  | "model.dev"
  | "model.research"
  | "model.meta"
  | "model.wiki"
  | "model.daemon_cycle_haiku";

export type BudgetDomainKey = "budget.haiku_max_usd" | "budget.pre_verify_max_usd";

// DB desired-state vs rendered daemon-config.json consumer view (D2 write-through).
export type DaemonConfigSyncState = "ok" | "drift" | "file-missing";

export interface DomainFileModel {
  file: string;
  // null = no `model:` frontmatter line (harness inherits settings.json at spawn).
  model: string | null;
}

export interface DomainStatus {
  domain: ModelDomainKey;
  desired: string | null;
  // 'mixed' (dev, per-file detail in `files`) and the 'inherit (settings.json)'
  // label (absent daemon-config key) are display values, not raw surface bytes.
  actual: string | null;
  // Compared after variant-suffix normalization ('claude-fable-5[1m]' == 'claude-fable-5').
  drift: boolean;
  apply_mode: ApplyMode;
  editable: boolean;
  pricing_known: boolean;
  // Dev only — per-file actuals so a 'mixed' state stays diagnosable.
  files?: DomainFileModel[];
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

export interface ModelConfigGetResponse {
  fetched_at: string;
  // SoT-derived roster (pricing.json `models` keys) — the client's dropdown source.
  // [] when the SoT is unreadable (D3 fail-open; GET still 200s).
  known_models: string[];
  domains: DomainStatus[];
  budgets: BudgetDomainStatus[];
  daemon_config_sync: DaemonConfigSyncState;
}

export interface SurfaceFileResult {
  file: string;
  status: "ok" | "skipped" | "failed";
  reason?: string;
}

export interface SurfaceResult {
  surface:
    | "daemon-config.json"
    | "frontmatter-dev"
    | "frontmatter-research"
    | "frontmatter-meta"
    | "frontmatter-wiki";
  status: "ok" | "skipped" | "failed";
  reason?: string;
  files?: SurfaceFileResult[];
}

export interface ModelConfigPutResponse extends ModelConfigGetResponse {
  surfaces: SurfaceResult[];
}

export interface ModelConfigPutBody {
  models?: Partial<Record<ModelDomainKey, string>>;
  budgets?: Partial<Record<BudgetDomainKey, string>>;
}

export type ModelConfigErrorBody =
  | { error: "invalid_body"; field: string; reason: string }
  // daemon-apply stash window guard (D4 amended: filesystem .apply-lock dir, fail-open when absent).
  | { error: "daemon_apply_in_progress"; reason: string };
