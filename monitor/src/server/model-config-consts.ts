// Single SoT for model-config validation + pricing_known + per-call budget-cap math
// (spec doc 36166). Consumed by routes/model-config.ts (GET/PUT validation + render) —
// duplicating any of these sets in a consumer is a defect.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ApplyMode,
  BudgetDomainKey,
  ModelDomainKey,
} from "./types/model-config.js";

// ----- SoT-derived known-model roster (pricing.json, D3) ---------------------------

// env override = test seam; default = the hooks-side pricing SoT the cost stack reads.
function resolvePricingSotPath(): string {
  const override = process.env.PRICING_SOT_PATH;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homedir(), ".glass-atrium", "hooks", "pricing.json");
}

/**
 * Known-model roster derived from the pricing SoT's `models` key set — the former
 * hardcoded KNOWN_MODEL_IDS mirror is deleted, so no lockstep copy survives (D3).
 * Read fresh per call, no cache: the SoT self-mutates out-of-band (pricing_loader F3
 * refresh + operator edits), and the sibling GET surfaces (settings.json /
 * daemon-config.json / frontmatter) are already read uncached per request — a ~1KB
 * read on a low-frequency config GET is cheaper than serving a stale roster until
 * restart. Fail-open: an unreadable/malformed SoT logs loudly and degrades THIS call
 * to an empty roster — known_models: [] + pricing_known: false — a config screen must
 * not hard-crash (500) on a missing committed file; the next call simply retries.
 */
export async function loadKnownModelIds(): Promise<ReadonlySet<string>> {
  const sotPath = resolvePricingSotPath();
  try {
    const parsed: unknown = JSON.parse(await readFile(sotPath, "utf8"));
    const models = (parsed as { models?: unknown }).models;
    if (models === null || typeof models !== "object" || Array.isArray(models)) {
      throw new Error("SoT carries no 'models' object");
    }
    return new Set(Object.keys(models));
  } catch (error) {
    process.stderr.write(
      `[model-config] pricing SoT unreadable (${sotPath}) — known-model roster degrades to []: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return new Set();
  }
}

// Legacy harness shorthand aliases — REMOVED as accepted values. Kept only as an
// explicit reject-list (D2): the bare words still match FREE_TEXT_MODEL_PATTERN, so
// dropping the accept branch alone would silently 200 them as free-text ids; this
// guard turns them into a remediation 400 instead.
export const REJECTED_ALIAS_VALUES: ReadonlySet<string> = new Set(["sonnet", "haiku", "opus"]);

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
  // false = no enforced write surface.
  editable: boolean;
  surface: "frontmatter-dev" | "frontmatter-research" | "daemon-config";
  // daemon-config.json key this domain renders to (write-through target), null otherwise.
  daemonConfigKey: string | null;
  allowInherit: boolean;
}

// D3 domain→consumable matrix. Order = GET response render order.
export const MODEL_DOMAINS: ReadonlyArray<ModelDomainDef> = [
  {
    key: "model.dev",
    applyMode: "next-spawn",
    editable: true,
    surface: "frontmatter-dev",
    daemonConfigKey: null,
    allowInherit: true,
  },
  {
    key: "model.research",
    applyMode: "next-spawn",
    editable: true,
    surface: "frontmatter-research",
    daemonConfigKey: null,
    allowInherit: true,
  },
  {
    key: "model.daemon_cycle_haiku",
    applyMode: "next-cycle",
    editable: true,
    surface: "daemon-config",
    daemonConfigKey: "haiku_model",
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
 * pricing_known: the pricing SoT carries a row for the value (after normalization),
 * or the value inherits the settings model. Anything else — bare aliases included,
 * the alias resolution branch is removed — → false (metered at the conservative
 * fallback rate — advisory warning in UI). Caller supplies the SoT roster
 * (loadKnownModelIds) so this stays a sync pure predicate.
 */
export function isPricingKnown(value: string | null, knownModelIds: ReadonlySet<string>): boolean {
  if (value === null) {
    return false;
  }
  if (value === INHERIT_VALUE) {
    return true;
  }
  return knownModelIds.has(normalizeModelId(value));
}

/**
 * Validation reason for a model value on a domain, or null when valid. Deliberately
 * roster-independent: any concrete id passing FREE_TEXT_MODEL_PATTERN is accepted —
 * SoT membership drives pricing_known/known_models display, never write validation.
 */
export function validateModelValue(def: ModelDomainDef, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return "must be a non-empty string";
  }
  if (value === INHERIT_VALUE) {
    return def.allowInherit ? null : `'${INHERIT_VALUE}' is not valid for this domain`;
  }
  // D2: checked BEFORE the free-text pattern — the bare words would otherwise match it.
  if (REJECTED_ALIAS_VALUES.has(value)) {
    return "bare aliases removed — use a concrete id, e.g. claude-sonnet-5";
  }
  if (!FREE_TEXT_MODEL_PATTERN.test(value)) {
    return "must be a concrete model id — lowercase alnum/dot/hyphen/bracket (max 128)";
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
