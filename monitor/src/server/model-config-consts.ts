// Single SoT for model-config validation + pricing_known + per-call budget-cap math (spec doc 36166).
// Consumed by routes/model-config.ts — duplicating any of these sets in a consumer is a defect.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ApplyMode,
  BudgetDomainKey,
  ModelDomainKey,
} from "./types/model-config.js";

// SoT-derived known-model roster (pricing.json, D3)

// env override = test seam; default = the hooks-side pricing SoT the cost stack reads.
function resolvePricingSotPath(): string {
  const override = process.env.PRICING_SOT_PATH;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homedir(), ".glass-atrium", "hooks", "pricing.json");
}

/**
 * Known-model roster derived from the pricing SoT's `models` key set (D3). Read fresh per call, no cache:
 * the SoT self-mutates out-of-band (pricing_loader refresh + operator edits), and a ~1KB read on a
 * low-frequency config GET beats serving a stale roster until restart. Fail-open: an unreadable/malformed
 * SoT logs loudly and degrades THIS call to an empty roster (known_models: [] + pricing_known: false) —
 * a config screen must not hard-crash (500) on a missing file; the next call simply retries.
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

// Explicit reject-list (D2): bare alias words still match FREE_TEXT_MODEL_PATTERN.
// Dropping the accept branch alone would silently 200 them as free-text ids; this guard returns a remediation 400 instead.
export const REJECTED_ALIAS_VALUES: ReadonlySet<string> = new Set(["sonnet", "haiku", "opus"]);

// 'inherit' = no explicit model on the surface (frontmatter/REPL key removed → settings.json model governs).
export const INHERIT_VALUE = "inherit";

// Free-text escape hatch — lowercase alnum + dot/hyphen/bracket, ≤128 (covers variant suffixes like 'claude-fable-5[1m]').
export const FREE_TEXT_MODEL_PATTERN = /^[a-z0-9.\-[\]]{1,128}$/;

// Per-call budget caps stay 2-decimal STRINGS end-to-end (daemon_config.py passes them verbatim to `claude -p --max-budget-usd`).
// A JSON number 0.5 would drift from the validated '0.50' literal and break the CLI cap.
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
  surface:
    | "frontmatter-dev"
    | "frontmatter-research"
    | "frontmatter-meta"
    | "frontmatter-wiki"
    | "daemon-config";
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
    key: "model.meta",
    applyMode: "next-spawn",
    editable: true,
    surface: "frontmatter-meta",
    daemonConfigKey: null,
    allowInherit: true,
  },
  {
    key: "model.wiki",
    applyMode: "next-spawn",
    editable: true,
    surface: "frontmatter-wiki",
    daemonConfigKey: null,
    allowInherit: true,
  },
  {
    key: "model.daemon_cycle_worker",
    applyMode: "next-cycle",
    editable: true,
    surface: "daemon-config",
    daemonConfigKey: "worker_model",
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

// Per-call hard-cap budgets written through to daemon-config.json; both keys read fresh at daemon module-init each launchd cycle (edit applies next cycle, no restart).
// worker cap governs BOTH the autoagent generation AND wiki compile calls (shared key); pre-verify cap governs the autoagent pre-verify call only.
export const BUDGET_DOMAINS: ReadonlyArray<BudgetDomainDef> = [
  {
    key: "budget.worker_max_usd",
    daemonConfigKey: "worker_max_budget_usd",
    applyMode: "next-cycle",
  },
  {
    key: "budget.pre_verify_max_usd",
    daemonConfigKey: "pre_verify_max_budget_usd",
    applyMode: "next-cycle",
  },
];

// Retired daemon-config.json keys, split by WHY the monitor stopped writing them. The split is
// load-bearing, not cosmetic: these two categories cannot share a removal rule, and the former
// single roster (DEPRECATED_DAEMON_CONFIG_KEYS, since split into the two below and no longer
// defined anywhere) conflated them. Deleting a RENAMED key without writing its successor destroys
// the operator's value, because the successor is written only when the DB carries a row under the
// new name — and on an un-migrated DB it does not.
// Merge preserves unknown keys (_comment), so explicit rosters stay the only clean removal path.

// DROPPED — retired outright, no successor key exists anywhere, so nothing can be carried and the
// delete is unconditional (the aggregate-limit pair, replaced by the per-call BUDGET_DOMAINS caps).
export const DROPPED_DAEMON_CONFIG_KEYS: ReadonlyArray<string> = [
  "cost_daily_limit_usd",
  "cost_monthly_limit_usd",
];

/** One pre-rename key pair. `currentConfigKey` is DERIVED from the domain, never restated here. */
export interface RenamedDaemonConfigKey {
  // Pre-rename monitor.model_config row key. Present in the DB until the rename migration runs
  // (20260901000000_rename_haiku_model_config_keys_to_worker), which `scripts/update.sh` does not run.
  legacyDomainKey: string;
  // Pre-rename daemon-config.json key — write-side twin of hooks/daemon_config.py _LEGACY_KEY_ALIASES.
  legacyConfigKey: string;
  // Post-rename monitor.model_config row key; its MODEL_DOMAINS/BUDGET_DOMAINS entry supplies the
  // daemon-config.json key the carried value lands under.
  currentDomainKey: ModelDomainKey | BudgetDomainKey;
}

// RENAMED — the same operator decision under a new name. The renderer carries the value forward
// FIRST and only then drops the legacy key, so one Save is a lossless migration of the file even
// while the DB rename is still pending. The daemon read paths (daemon_config.py
// _LEGACY_KEY_ALIASES, atrium_resolve_worker_model) still READ the legacy names, and go quiet once
// that Save lands. Dropping an entry from this list would strand the old key in the file forever,
// warning on every daemon start.
export const RENAMED_DAEMON_CONFIG_KEYS: ReadonlyArray<RenamedDaemonConfigKey> = [
  {
    legacyDomainKey: "model.daemon_cycle_haiku",
    legacyConfigKey: "haiku_model",
    currentDomainKey: "model.daemon_cycle_worker",
  },
  {
    legacyDomainKey: "budget.haiku_max_usd",
    legacyConfigKey: "haiku_max_budget_usd",
    currentDomainKey: "budget.worker_max_usd",
  },
];

// Substring, deliberately: the API-style ids ('claude-3-5-haiku-20241022', 'claude-3-5-haiku-latest')
// carry the family name in the MIDDLE and FREE_TEXT_MODEL_PATTERN accepts them, so a prefix test would
// rename the key and leave the loop on the retired model. Twin of the migration's LIKE '%haiku%'.
const RETIRED_WORKER_MODEL_MARKER = "haiku";

// Replacement for a retired worker-model id, on both carry paths. Parity with the SQL migration's
// rewrite target and hooks/daemon_config.py _FALLBACK['worker_model'].
export const RETIRED_WORKER_MODEL_REPLACEMENT = "claude-sonnet-5";

/** True when the id names the retired worker-model family, under any vendor id shape. */
export function isRetiredWorkerModelId(value: string): boolean {
  return normalizeModelId(value).toLowerCase().includes(RETIRED_WORKER_MODEL_MARKER);
}

/** What the renderer should do with one legacy key on this render. */
export type RenamedKeyCarry =
  | { action: "carry"; configKey: string; value: string }
  | { action: "drop" }
  | { action: "keep"; reason: string };

/** daemon-config.json key a domain renders to, or null when no domain owns it. */
function currentConfigKeyOf(domainKey: string): string | null {
  const model = MODEL_DOMAINS.find((d) => d.key === domainKey);
  if (model !== undefined) {
    return model.daemonConfigKey;
  }
  return BUDGET_DOMAINS.find((d) => d.key === domainKey)?.daemonConfigKey ?? null;
}

/**
 * Decide one legacy key's fate against the desired state and the partially-rendered file object.
 * Pure — returns an instruction, never mutates.
 *
 * `drop`  the successor's value is already settled (a DB row exists under the new name, or the file
 *         already carries it), so the legacy key is pure residue.
 * `carry` the successor is unset and a legacy value exists — write it under the new name, then drop
 *         the legacy key. Source precedence is DB row over file value: monitor.model_config is the
 *         UI SoT, so a legacy row outranks a file that may have drifted from it.
 * `keep`  a legacy value exists but fails the same validator the write path applies. Carrying it
 *         would launder an unusable value into the current key name and deleting it would destroy
 *         the evidence, so it stays put and the caller reports it (Precondition Loud-Fail).
 *
 * MODEL values follow the SQL migration's VALUE POLICY: a retired-family id is REWRITTEN (carrying
 * it forward would rename the key while leaving the loop on the retired model — the one outcome the
 * rename exists to prevent), anything else moves verbatim. BUDGET values always move verbatim: a
 * per-call cap is a spending decision that belongs to the operator, and a rename must not move it.
 */
export function resolveRenamedKeyCarry(
  def: RenamedDaemonConfigKey,
  desired: ReadonlyMap<string, string>,
  rendered: Readonly<Record<string, unknown>>,
): RenamedKeyCarry {
  const currentConfigKey = currentConfigKeyOf(def.currentDomainKey);
  if (currentConfigKey === null) {
    return { action: "keep", reason: `no daemon-config.json key renders '${def.currentDomainKey}'` };
  }
  // desired.has() and not a value read: a row set to 'inherit' means the operator asked for the key
  // to be ABSENT, and carrying the legacy value would resurrect what they just removed.
  if (desired.has(def.currentDomainKey) || rendered[currentConfigKey] !== undefined) {
    return { action: "drop" };
  }
  const fileValue = rendered[def.legacyConfigKey];
  const source =
    desired.get(def.legacyDomainKey) ?? (typeof fileValue === "string" ? fileValue : undefined);
  if (source === undefined) {
    return { action: "drop" };
  }

  const modelDef = MODEL_DOMAINS.find((d) => d.key === def.currentDomainKey);
  if (modelDef !== undefined) {
    const carried = isRetiredWorkerModelId(source) ? RETIRED_WORKER_MODEL_REPLACEMENT : source;
    const reason = validateModelValue(modelDef, carried);
    return reason === null
      ? { action: "carry", configKey: currentConfigKey, value: carried }
      : { action: "keep", reason: `legacy model value is not writable (${reason})` };
  }
  const reason = validateBudgetValue(source);
  return reason === null
    ? { action: "carry", configKey: currentConfigKey, value: source }
    : { action: "keep", reason: `legacy budget value is not writable (${reason})` };
}

/**
 * Strip the trailing variant suffix for drift comparison only —
 * 'claude-fable-5[1m]' == 'claude-fable-5' (cost-tracker normalize_model_key rule).
 * Stored/rendered values are never rewritten with the normalized form.
 */
export function normalizeModelId(value: string): string {
  return value.trim().replace(/\[[^\]]*\]$/, "");
}

/**
 * pricing_known: the pricing SoT carries a row for the value (after normalization), or the value inherits
 * the settings model. Anything else (bare aliases included) → false — metered at the conservative fallback
 * rate (advisory warning in UI). Caller supplies the SoT roster so this stays a sync pure predicate.
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
 * Validation reason for a per-call budget-cap value, or null when valid. Each cap is validated
 * INDEPENDENTLY — no cross-field invariant (single-call caps have no daily≤monthly-style pairing).
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
