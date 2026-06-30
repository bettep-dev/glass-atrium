// Single SoT for model-config validation + pricing_known + per-call budget-cap math
// (spec doc 36166). Consumed by routes/model-config.ts (GET/PUT validation + render) —
// duplicating any of these sets in a consumer is a defect.

import type {
  ApplyMode,
  BudgetDomainKey,
  ModelDomainKey,
} from "./types/model-config.js";

// Validated concrete ids — must stay in lockstep with hooks/cost-tracker.sh PRICING rows
// (all four verified present); a new id without a PRICING row meters at the opus fallback rate.
export const KNOWN_MODEL_IDS: ReadonlySet<string> = new Set([
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);

// Harness shorthand aliases — valid ONLY on frontmatter domains (dev/research); the
// daemon REPL model lands verbatim in a `claude --model <value>` exec, concrete ids only.
export const FRONTMATTER_MODEL_ALIASES: ReadonlySet<string> = new Set(["sonnet", "haiku", "opus"]);

// 'inherit' = no explicit model on the surface (frontmatter line removed / REPL key removed
// → settings.json model governs).
export const INHERIT_VALUE = "inherit";

// Free-text escape hatch — lowercase alnum + dot/hyphen/bracket, ≤128 (covers variant
// suffixes like 'claude-fable-5[1m]').
export const FREE_TEXT_MODEL_PATTERN = /^[a-z0-9.\-[\]]{1,128}$/;

// Per-call budget caps are positive 2-decimal STRINGS end-to-end — daemon_config.py
// passes them verbatim to `claude -p --max-budget-usd <value>`, so a JSON number 0.5
// would drift from the validated '0.50' literal and break the CLI cap.
export const BUDGET_VALUE_PATTERN = /^\d+\.\d{2}$/;

// Max integer digits before the decimal — a per-call cap above this band is a fat-finger,
// and an over-cap value (e.g. 1e20) makes parseFloat finite so bound checks silently break.
export const BUDGET_MAX_INTEGER_DIGITS = 2;

// Per-call cap bounds (USD). Floor: below ~0.05 the CLI exits 1 immediately (daemon_config.py
// note). Ceiling: a single background call should never be authorized past $50.
export const BUDGET_MIN_USD = 0.05;
export const BUDGET_MAX_USD = 50.0;

export interface ModelDomainDef {
  key: ModelDomainKey;
  applyMode: ApplyMode;
  // false = no enforced write surface (orchestrator: DB-only desired + manual how-to panel).
  editable: boolean;
  surface: "settings" | "frontmatter-dev" | "frontmatter-research" | "daemon-config";
  // daemon-config.json key this domain renders to (write-through target), null otherwise.
  daemonConfigKey: string | null;
  allowAliases: boolean;
  allowInherit: boolean;
}

// D3 domain→consumable matrix. Order = GET response render order.
export const MODEL_DOMAINS: ReadonlyArray<ModelDomainDef> = [
  {
    key: "model.orchestrator",
    applyMode: "session-restart-manual",
    editable: false,
    surface: "settings",
    daemonConfigKey: null,
    allowAliases: false,
    allowInherit: false,
  },
  {
    key: "model.dev",
    applyMode: "next-spawn",
    editable: true,
    surface: "frontmatter-dev",
    daemonConfigKey: null,
    allowAliases: true,
    allowInherit: true,
  },
  {
    key: "model.research",
    applyMode: "next-spawn",
    editable: true,
    surface: "frontmatter-research",
    daemonConfigKey: null,
    allowAliases: true,
    allowInherit: true,
  },
  {
    key: "model.daemon_cycle_haiku",
    applyMode: "next-cycle",
    editable: true,
    surface: "daemon-config",
    daemonConfigKey: "haiku_model",
    allowAliases: false,
    allowInherit: false,
  },
];

export interface BudgetDomainDef {
  key: BudgetDomainKey;
  // daemon-config.json key this budget renders to (the value daemon_config.py reads and
  // passes verbatim to `claude -p --max-budget-usd`).
  daemonConfigKey: string;
  applyMode: ApplyMode;
}

// Per-call hard-cap budgets the monitor write-throughs to daemon-config.json. Both keys are
// read fresh at daemon module-init each launchd cycle → an edit applies next cycle, no restart.
// haiku cap governs BOTH the autoagent generation call AND the wiki compile call (shared key);
// pre-verify cap governs the autoagent pre-verify call only.
export const BUDGET_DOMAINS: ReadonlyArray<BudgetDomainDef> = [
  {
    key: "budget.haiku_max_usd",
    daemonConfigKey: "haiku_max_budget_usd",
    applyMode: "next-cycle",
  },
  {
    key: "budget.pre_verify_max_usd",
    daemonConfigKey: "pre_verify_max_budget_usd",
    applyMode: "next-cycle",
  },
];

// daemon-config.json keys the monitor once write-throughed but no longer manages — the
// aggregate-limit pair the budget rework dropped in favor of per-call BUDGET_DOMAINS caps.
// renderDaemonConfig deletes these so a single PUT self-heals a live file still carrying them
// (the merge semantics preserve unknown external keys like _comment, so an explicit
// deprecation list is the only clean removal path). Append future deprecations here.
export const DEPRECATED_DAEMON_CONFIG_KEYS: ReadonlyArray<string> = [
  "cost_daily_limit_usd",
  "cost_monthly_limit_usd",
];

/**
 * Strip the trailing variant suffix for drift comparison only —
 * 'claude-fable-5[1m]' == 'claude-fable-5' (cost-tracker normalize_model_key rule).
 * Stored/rendered values are never rewritten with the normalized form.
 */
export function normalizeModelId(value: string): string {
  return value.trim().replace(/\[[^\]]*\]$/, "");
}

/**
 * pricing_known: cost-tracker has a PRICING row for the value (after normalization),
 * or the value resolves through a known family (alias) or the inherited settings model.
 * Free-text ids → false (metered at opus fallback rate — advisory warning in UI).
 */
export function isPricingKnown(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  if (value === INHERIT_VALUE || FRONTMATTER_MODEL_ALIASES.has(value)) {
    return true;
  }
  return KNOWN_MODEL_IDS.has(normalizeModelId(value));
}

/** Validation reason for a model value on a domain, or null when valid. */
export function validateModelValue(def: ModelDomainDef, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return "must be a non-empty string";
  }
  if (value === INHERIT_VALUE) {
    return def.allowInherit ? null : `'${INHERIT_VALUE}' is not valid for this domain`;
  }
  if (FRONTMATTER_MODEL_ALIASES.has(value)) {
    return def.allowAliases ? null : "aliases (sonnet/haiku/opus) are valid only for frontmatter domains";
  }
  if (KNOWN_MODEL_IDS.has(value)) {
    return null;
  }
  if (!FREE_TEXT_MODEL_PATTERN.test(value)) {
    return "must be a known model id, an allowed alias, or lowercase alnum/dot/hyphen/bracket (max 128)";
  }
  return null;
}

/**
 * Validation reason for a per-call budget-cap value, or null when valid. Each cap is
 * validated INDEPENDENTLY — there is no cross-field invariant (the removed daily≤monthly
 * limit-pair semantics has no analogue for independent single-call caps).
 */
export function validateBudgetValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return "must be a string (decimal with exactly 2 fraction digits, e.g. '0.50')";
  }
  if (!BUDGET_VALUE_PATTERN.test(value)) {
    return "must have exactly 2 decimal places (e.g. '0.50')";
  }
  const integerDigits = value.split(".", 1)[0].replace(/^0+(?=\d)/, "");
  if (integerDigits.length > BUDGET_MAX_INTEGER_DIGITS) {
    return `must not exceed ${BUDGET_MAX_INTEGER_DIGITS} integer digits`;
  }
  const parsed = Number.parseFloat(value);
  if (parsed < BUDGET_MIN_USD) {
    return `must be at least '${BUDGET_MIN_USD.toFixed(2)}'`;
  }
  if (parsed > BUDGET_MAX_USD) {
    return `must not exceed '${BUDGET_MAX_USD.toFixed(2)}'`;
  }
  return null;
}
