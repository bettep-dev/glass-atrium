// Model-config API (spec doc 36166): GET/PUT /api/model-config — the daemon model, per-call budget caps and tier knobs.
// DB (monitor.model_config) = UI SoT; daemon-config.json is the write-through-rendered consumer view.
// PUT /api/model-config/agents writes agent pins: each agent file's own model line is the one SoT, no DB row.

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { type AgentFileList, getAgentFrontmatter, listAgentFiles, loadAgentRegistry } from "../agents/registry.js";
import { getPrisma } from "../db.js";
import { respondDbFailure } from "../db-failure.js";
import { type AuditChangeCarrier, setAuditTarget } from "../middleware/audit-log.js";
import { getMonitorPort } from "../monitor-port.js";
import { type PageOriginCarrier, buildPageOriginHook, getPageOrigins } from "../queue/request-gate.js";
import { type WindowLimit, WindowLimiter, buildWindowLimitHook } from "../remote/limits.js";
import {
  BUDGET_DOMAINS,
  DROPPED_DAEMON_CONFIG_KEYS,
  INHERIT_VALUE,
  MODEL_DOMAINS,
  RENAMED_DAEMON_CONFIG_KEYS,
  TIER_DOMAINS,
  getModelIdPrefix,
  getTierFileValue,
  isPricingKnown,
  loadKnownModelIds,
  normalizeModelId,
  resolveDesiredWithLegacy,
  resolveRenamedKeyCarry,
  validateAgentPinValue,
  validateBudgetValue,
  validateModelValue,
  validateTierValue,
  type BudgetDomainDef,
  type LegacyDesiredResolution,
  type ModelDomainDef,
  type TierDomainDef,
  type TierFileValue,
} from "../model-config-consts.js";
import type {
  AgentPinPutBody,
  AgentPinPutResponse,
  AgentPinResult,
  BudgetDomainStatus,
  DaemonConfigSyncState,
  DomainStatus,
  ModelConfigErrorBody,
  ModelConfigGetResponse,
  ModelConfigPutBody,
  ModelConfigPutResponse,
  SurfaceResult,
  TierDomainStatus,
} from "../types/model-config.js";

// updated_by audit convention — the monitor web server is the sole write origin (mirrors
// middleware/audit-log.ts AUDIT_ACTOR).
const UPDATED_BY = "monitor-web";

// Page-only pin writes, bounded per route (LLM10) → a scripted loop cannot churn the agents folder
export const AGENT_PIN_WRITE_LIMIT: WindowLimit = { limit: 60, windowMs: 60_000 };

const AGENT_PIN_ROUTE = "/api/model-config/agents";

// A new agent file takes the usual mode; an existing one keeps its own across the rename
const NEW_FILE_MODE = 0o644;

// Display label for an absent per-daemon REPL key — the bootstrap exec carries no model
// flag, so the tmux session inherits the settings.json model (D3).
const INHERIT_SETTINGS_LABEL = "inherit (settings.json)";

interface DomainDefByGroup {
  models: ModelDomainDef;
  budgets: BudgetDomainDef;
  tiers: TierDomainDef;
}
type PutGroup = keyof DomainDefByGroup;
interface PutGroupDef<D extends { key: string }> {
  defs: ReadonlyArray<D>;
  unknownKeyReason: string;
  validate: (def: D, value: unknown) => string | null;
}
const PUT_GROUPS: { [G in PutGroup]: PutGroupDef<DomainDefByGroup[G]> } = {
  models: { defs: MODEL_DOMAINS, unknownKeyReason: "unknown domain key", validate: validateModelValue },
  budgets: {
    defs: BUDGET_DOMAINS,
    unknownKeyReason: "unknown budget key",
    validate: (_def, value) => validateBudgetValue(value),
  },
  tiers: { defs: TIER_DOMAINS, unknownKeyReason: "unknown tier key", validate: validateTierValue },
};

// external-surface path resolution (env overrides = test seams)

// GA runtime-state root — the daemon stores live under `${GA_DATA_ROOT:-$HOME/.glass-atrium}/data`
// (twin of the shell/py seam in hooks/ga_paths.py), NOT under ~/.claude. Exported for the
// path-resolution unit test (pure string build — reads no filesystem).
export function getGaDataRoot(): string {
  return process.env.GA_DATA_ROOT ?? path.join(os.homedir(), ".glass-atrium");
}

export function getDaemonConfigPath(): string {
  return (
    process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH ??
    path.join(getGaDataRoot(), "data", "daemon-config.json")
  );
}

function getAgentsDir(): string {
  return process.env.MODEL_CONFIG_AGENTS_DIR ?? path.join(os.homedir(), ".glass-atrium", "agents");
}

export function getApplyLockPath(): string {
  return (
    process.env.MODEL_CONFIG_APPLY_LOCK_PATH ??
    path.join(getGaDataRoot(), "data", "daemon-reports", ".apply-lock")
  );
}

export async function registerModelConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/model-config", handleGet);
  app.put("/api/model-config", handlePut);
  const apply: ApplyState = { isInFlight: false };
  app.put(
    AGENT_PIN_ROUTE,
    { onRequest: [buildWindowLimitHook(new WindowLimiter(AGENT_PIN_WRITE_LIMIT)), buildPageOriginHook(getPageOrigins(getMonitorPort()))] },
    (request, reply) => handlePutAgents(request, reply, apply),
  );
}

// GET

async function handleGet(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ModelConfigGetResponse | unknown> {
  const start = Date.now();
  try {
    const body = await buildGetResponse();
    request.log.info(
      { route: "/api/model-config", durationMs: Date.now() - start },
      "model-config query complete",
    );
    return body;
  } catch (error) {
    return failWithDb(request, reply, "/api/model-config", error);
  }
}

async function buildGetResponse(): Promise<ModelConfigGetResponse> {
  const prisma = getPrisma();
  const rows = await prisma.modelConfig.findMany();
  // Pre-rename rows are folded in under their successors' names FIRST, so every reader below --
  // the domain rows, the budget rows and the sync state -- sees one desired state and cannot
  // disagree about it. On a migrated DB the resolution is the row map unchanged.
  const resolution = resolveDesiredWithLegacy(
    new Map<string, string>(rows.map((r) => [r.configKey, r.configValue])),
  );
  const desired = resolution.desired;

  const [daemonConfig, knownModelIds, agentList] = await Promise.all([readDaemonConfig(), loadKnownModelIds(), readAgentModels()]);

  const domains: DomainStatus[] = MODEL_DOMAINS.map((def) =>
    buildDomainStatus(def, desired.get(def.key) ?? null, daemonConfig, knownModelIds),
  );

  const budgets: BudgetDomainStatus[] = BUDGET_DOMAINS.map((def) =>
    buildBudgetStatus(def, desired.get(def.key) ?? null, daemonConfig),
  );

  const tiers: TierDomainStatus[] = TIER_DOMAINS.map((def) =>
    buildTierStatus(def, desired.get(def.key) ?? null, daemonConfig),
  );

  return {
    fetched_at: new Date().toISOString(),
    known_models: [...knownModelIds],
    domains,
    budgets,
    tiers,
    daemon_config_sync: computeDaemonConfigSync(resolution, daemonConfig),
    agents: agentList.agents,
    unreadable: agentList.unreadable,
  };
}

/**
 * The agents folder as the Models screen lists it; the registry only sets the `registered` mark.
 * A model value with no id-shaped lead moves its file to `unreadable`.
 */
async function readAgentModels(): Promise<Pick<ModelConfigGetResponse, "agents" | "unreadable">> {
  const [list, registry] = await Promise.all([listAgentFiles(getAgentsDir()), loadAgentRegistry()]);
  const read: Pick<ModelConfigGetResponse, "agents" | "unreadable"> = { agents: [], unreadable: [...list.unreadable] };
  for (const agent of list.agents) {
    const pin = getAgentPin(agent.frontmatter);
    if (pin === undefined) {
      read.unreadable.push({ file: agent.file, reason: "Model line is not a model id" });
    } else {
      read.agents.push({ name: agent.name, file: agent.file, role: agent.role, pin, registered: registry.has(agent.name) });
    }
  }
  read.unreadable.sort((a, b) => (a.file < b.file ? -1 : 1));
  return read;
}

// null → no model line (no pin) · undefined → a model value with no id-shaped lead
function getAgentPin(frontmatter: Record<string, unknown>): string | null | undefined {
  if (!Object.hasOwn(frontmatter, "model")) {
    return null;
  }
  const model = frontmatter.model;
  return typeof model === "string" ? (getModelIdPrefix(model) ?? undefined) : undefined;
}

/**
 * File side read as the daemon loader reads it → a rejected value surfaces with or without a saved row.
 * No row / unreadable file → no drift claim.
 */
function buildTierStatus(
  def: TierDomainDef,
  desired: string | null,
  daemonConfig: Record<string, unknown> | null,
): TierDomainStatus {
  const fileValue = daemonConfig === null ? null : getTierFileValue(def, daemonConfig[def.daemonConfigKey]);
  return {
    domain: def.key,
    desired,
    actual: fileValue?.state === "accepted" ? fileValue.value : null,
    file_error: fileValue?.state === "rejected" ? fileValue.reason : null,
    drift: desired !== null && fileValue !== null && !isTierFileMatch(desired, fileValue),
    apply_mode: def.applyMode,
  };
}

// 'inherit' wants the knob unset, a value wants it in effect verbatim.
function isTierFileMatch(desired: string, fileValue: TierFileValue): boolean {
  if (desired === INHERIT_VALUE) {
    return fileValue.state === "unset";
  }
  return fileValue.state === "accepted" && fileValue.value === desired;
}

// A budget cap drifts when the DB desired value differs from the rendered daemon-config.json
// value. Unknown side (DB unset / file unparseable) → no drift claim (never alarm blindly).
function buildBudgetStatus(
  def: BudgetDomainDef,
  desired: string | null,
  daemonConfig: Record<string, unknown> | null,
): BudgetDomainStatus {
  const raw = daemonConfig?.[def.daemonConfigKey];
  const actual = typeof raw === "string" ? raw : null;
  return {
    domain: def.key,
    desired,
    actual,
    drift: desired !== null && actual !== null && desired !== actual,
    apply_mode: def.applyMode,
  };
}

function buildDomainStatus(
  def: ModelDomainDef,
  desired: string | null,
  daemonConfig: Record<string, unknown> | null,
  knownModelIds: ReadonlySet<string>,
): DomainStatus {
  const raw = daemonConfig?.[def.daemonConfigKey];
  const actual = typeof raw === "string" ? raw : INHERIT_SETTINGS_LABEL;
  return {
    domain: def.key,
    desired,
    actual,
    drift: computeDrift(desired, actual),
    apply_mode: def.applyMode,
    editable: def.editable,
    pricing_known: isPricingKnown(desired, knownModelIds),
  };
}

function computeDrift(desired: string | null, actual: string | null): boolean {
  // Unknown side → no drift claim (never alarm on unreadable surface).
  if (desired === null || actual === null) {
    return false;
  }
  const actualEffective = actual === INHERIT_SETTINGS_LABEL ? INHERIT_VALUE : actual;
  return normalizeModelId(desired) !== normalizeModelId(actualEffective);
}

/**
 * DB desired-state vs rendered daemon-config.json view (D2). A budget key set in the DB
 * but absent from (or differing in) the rendered file is drift — pressing Save re-renders it.
 *
 * Exported for the DB-free unit suite: the state is decidable from a desired-state resolution and
 * a parsed file object, and the integration suite that would otherwise own it needs a live Postgres.
 */
export function computeDaemonConfigSync(
  resolution: LegacyDesiredResolution,
  daemonConfig: Record<string, unknown> | null,
): DaemonConfigSyncState {
  if (daemonConfig === null) {
    return "file-missing";
  }
  // Ranks above pending-migration: a rejected knob stops every daemon cycle, and db-setup does not fix it.
  if (TIER_DOMAINS.some((def) => getTierFileValue(def, daemonConfig[def.daemonConfigKey]).state === "rejected")) {
    return "file-invalid";
  }
  // Reported ahead of any drift comparison, deliberately. On an un-migrated DB the file still
  // carries the pre-rename keys, so every renamed domain reads as drift and the operator is sent
  // to Save when the un-run rename is the root cause. Per-domain drift is not hidden by this —
  // each table row keeps its own chip. Without the branch, the `want === undefined → continue`
  // below returns a vacuous 'ok' over a domain that has no row under the name it just queried.
  if (resolution.legacySourced.size > 0) {
    return "pending-migration";
  }
  const desired = resolution.desired;
  for (const def of MODEL_DOMAINS) {
    const want = desired.get(def.key);
    if (want === undefined) {
      continue;
    }
    const have = daemonConfig[def.daemonConfigKey];
    if (want === INHERIT_VALUE) {
      if (have !== undefined) {
        return "drift";
      }
    } else if (have !== want) {
      return "drift";
    }
  }
  for (const def of TIER_DOMAINS) {
    const want = desired.get(def.key);
    if (want !== undefined && !isTierFileMatch(want, getTierFileValue(def, daemonConfig[def.daemonConfigKey]))) {
      return "drift";
    }
  }
  for (const def of BUDGET_DOMAINS) {
    const want = desired.get(def.key);
    if (want === undefined) {
      continue;
    }
    if (daemonConfig[def.daemonConfigKey] !== want) {
      return "drift";
    }
  }
  return "ok";
}

// PUT

async function handlePut(
  request: FastifyRequest<{ Body: ModelConfigPutBody }>,
  reply: FastifyReply,
): Promise<ModelConfigPutResponse | ModelConfigErrorBody | unknown> {
  const start = Date.now();
  const prisma = getPrisma();

  // validate-all-first: any failure → 400 with zero DB/file writes
  const body = request.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return reply.code(400).send(invalidBody("body", "must be a JSON object"));
  }
  if (body.models === undefined && body.budgets === undefined && body.tiers === undefined) {
    return reply
      .code(400)
      .send(invalidBody("body", "must contain 'models', 'budgets' and/or 'tiers'"));
  }

  const modelChanges = getGroupChanges("models", body.models);
  if (!(modelChanges instanceof Map)) {
    return reply.code(400).send(modelChanges);
  }
  // Per-call caps validate INDEPENDENTLY — no cross-field invariant (each guards a single
  // runaway `claude -p --max-budget-usd` call, not a budget pair).
  const budgetChanges = getGroupChanges("budgets", body.budgets);
  if (!(budgetChanges instanceof Map)) {
    return reply.code(400).send(budgetChanges);
  }
  const tierChanges = getGroupChanges("tiers", body.tiers);
  if (!(tierChanges instanceof Map)) {
    return reply.code(400).send(tierChanges);
  }

  try {
    const currentRows = await prisma.modelConfig.findMany();
    const current = new Map<string, string>(currentRows.map((r) => [r.configKey, r.configValue]));

    // single DB transaction over the changed rows
    const upserts = new Map<string, string>([...modelChanges, ...budgetChanges, ...tierChanges]);
    const changes: Record<string, { old: string | null; new: string }> = {};
    const writes = [];
    for (const [key, value] of upserts) {
      const oldValue = current.get(key) ?? null;
      if (oldValue === value) {
        continue;
      }
      changes[key] = { old: oldValue, new: value };
      writes.push(
        prisma.modelConfig.upsert({
          where: { configKey: key },
          update: { configValue: value, updatedBy: UPDATED_BY },
          create: { configKey: key, configValue: value, updatedBy: UPDATED_BY },
        }),
      );
    }
    if (writes.length > 0) {
      await prisma.$transaction(writes);
    }

    // Single-writer audit (AC-9): the audit-log middleware emits the one row; the
    // handler only attaches the old→new diff for payload enrichment.
    (request as FastifyRequest & AuditChangeCarrier).auditChange = { changes };

    // render side effects — full desired state, so a re-save heals prior drift
    const merged = new Map(current);
    for (const [key, value] of upserts) {
      merged.set(key, value);
    }
    // every PUT key renders into daemon-config.json; no agent file is written here
    const surfaces: SurfaceResult[] = upserts.size > 0 ? [await renderDaemonConfig(merged)] : [];

    const getShape = await buildGetResponse();
    const responseBody: ModelConfigPutResponse = { ...getShape, surfaces };
    request.log.info(
      {
        route: "/api/model-config",
        durationMs: Date.now() - start,
        changedKeys: Object.keys(changes),
      },
      "model-config update complete",
    );
    return responseBody;
  } catch (error) {
    return failWithDb(request, reply, "/api/model-config", error);
  }
}

// PUT agents — per-agent pins

interface ApplyState {
  isInFlight: boolean;
}

// Exactly a name list with the pins the page showed, and one model → no key can steer a write elsewhere (C3)
const agentPinBodySchema = z
  .object({
    model: z.string().min(1).max(128),
    agents: z
      .array(z.object({ name: z.string().min(1).max(128), expected_pin: z.string().max(128).nullable() }).strict())
      .min(1)
      .refine((agents) => new Set(agents.map((agent) => agent.name)).size === agents.length, "must not name an agent twice"),
  })
  .strict();

async function handlePutAgents(request: FastifyRequest, reply: FastifyReply, apply: ApplyState): Promise<unknown> {
  const parsed = agentPinBodySchema.safeParse(request.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return reply.code(400).send(invalidBody(issue?.path.join(".") || "body", issue?.message ?? "invalid body"));
  }
  if (apply.isInFlight) {
    return reply.code(409).send(refusal("apply_in_progress", "another agent model apply is running — retry when it ends"));
  }
  apply.isInFlight = true;
  try {
    return await applyAgentPins(request, reply, parsed.data);
  } finally {
    apply.isInFlight = false;
  }
}

/** Each check refuses the whole request before any file is opened; then one result per named agent. */
async function applyAgentPins(request: FastifyRequest, reply: FastifyReply, body: AgentPinPutBody): Promise<unknown> {
  const modelRefusal = await getModelRefusal(body.model);
  if (modelRefusal !== null) {
    return reply.code(modelRefusal.error === "invalid_body" ? 400 : 503).send(modelRefusal);
  }
  const list = await getAgentFileListOrNull(request);
  if (list === null) {
    return reply.code(503).send(refusal("agent_list_unavailable", "the agents folder could not be listed — nothing was written"));
  }
  if (body.agents.length > list.agents.length + list.unreadable.length) {
    return reply.code(400).send(invalidBody("agents", "must not name more agents than the agents folder holds"));
  }
  if (await pathExists(getApplyLockPath())) {
    return reply.code(409).send(refusal("daemon_apply_in_progress", "daemon-apply lock present (.apply-lock) — retry after the apply cycle finishes"));
  }
  return putAgentPins(request, body, list);
}

// C4: an empty roster vouches for nothing → refused, never fail-open
async function getModelRefusal(model: string): Promise<ModelConfigErrorBody | null> {
  const knownModelIds = await loadKnownModelIds();
  if (knownModelIds.size === 0) {
    return refusal("model_roster_unavailable", "the pricing roster is unreadable — no model can be checked");
  }
  const reason = validateAgentPinValue(model, knownModelIds);
  return reason === null ? null : invalidBody("model", reason);
}

async function putAgentPins(request: FastifyRequest, body: AgentPinPutBody, list: AgentFileList): Promise<AgentPinPutResponse> {
  const realDir = await fs.realpath(getAgentsDir());
  const pinNew = body.model === INHERIT_VALUE ? null : body.model;
  const results: AgentPinResult[] = [];
  const audited: Array<{ name: string; old: string | null; new: string | null; status: AgentPinResult["status"] }> = [];
  for (const entry of body.agents) {
    const write = await putAgentPin(list, { realDir, name: entry.name, expectedPin: entry.expected_pin }, body.model);
    results.push(write.result);
    audited.push({ name: entry.name, old: write.old, new: pinNew, status: write.result.status });
  }
  setAuditTarget(request, { signal: (request as FastifyRequest & PageOriginCarrier).pageOriginSignal ?? null, agents: audited });
  request.log.info({ route: AGENT_PIN_ROUTE, statuses: results.map((result) => result.status) }, "agent model apply complete");
  return { results, ...(await readAgentModels()) };
}

async function getAgentFileListOrNull(request: FastifyRequest): Promise<AgentFileList | null> {
  try {
    return await listAgentFiles(getAgentsDir());
  } catch (error) {
    request.log.warn({ err: error, route: AGENT_PIN_ROUTE }, "agent model apply refused: agents folder not listed");
    return null;
  }
}

function refusal(error: "apply_in_progress" | "model_roster_unavailable" | "agent_list_unavailable" | "daemon_apply_in_progress", reason: string): ModelConfigErrorBody {
  return { error, reason };
}

// agent model line writer

/** One write target: a name from the request, matched against the server's own list, and the pin the page showed. */
interface AgentPinTarget {
  realDir: string;
  name: string;
  expectedPin: string | null;
}

/** A result plus the pin read from the file before the write; null when no file was read. */
interface AgentPinWrite {
  result: AgentPinResult;
  old: string | null;
}

// The request name selects a listed entry; only the listed base name reaches a path (C1)
async function putAgentPin(list: AgentFileList, target: AgentPinTarget, desired: string): Promise<AgentPinWrite> {
  const agent = list.agents.find((listed) => listed.name === target.name);
  if (agent !== undefined) {
    return writeFrontmatterModel(path.join(getAgentsDir(), agent.file), target, desired);
  }
  const unreadable = list.unreadable.find((listed) => listed.file === `${target.name}.md`);
  return unreadable === undefined
    ? { result: { name: target.name, status: "gone" }, old: null }
    : { result: { name: target.name, status: "refused", reason: unreadable.reason }, old: null };
}

/**
 * Set or remove ONLY the `model:` line of one agent file; 'inherit' removes it.
 * - The realpath must sit directly in the agents folder; the file must hold at most one model line and the pin the page showed.
 * - Whole text minus the model line must stay byte-identical, and the file is re-read just before the rename.
 * - A file already holding the value is never rewritten.
 */
async function writeFrontmatterModel(linkPath: string, target: AgentPinTarget, desired: string): Promise<AgentPinWrite> {
  const source = await readAgentPinSource(linkPath, target);
  if ("result" in source) {
    return source;
  }
  const done = (status: AgentPinResult["status"], reason?: string): AgentPinWrite => ({
    result: reason === undefined ? { name: target.name, status } : { name: target.name, status, reason },
    old: source.pin,
  });
  if (source.pin !== target.expectedPin) {
    return done("changed_since_load");
  }
  const newText = getTextWithModel(source.text, desired);
  if (newText === source.text) {
    return done("unchanged");
  }
  if (getTextWithoutModel(newText) !== getTextWithoutModel(source.text)) {
    return done("refused", "The write would change more than the model line");
  }
  const status = await putAgentText(source, newText);
  return status === "refused" ? done(status, "The file could not be written") : done(status);
}

async function putAgentText(source: AgentPinSource, newText: string): Promise<"applied" | "changed_since_load" | "refused"> {
  try {
    await atomicWrite(source.resolved, newText, source.text);
    return "applied";
  } catch (error) {
    return error instanceof FileChangedError ? "changed_since_load" : "refused";
  }
}

interface AgentPinSource {
  resolved: string;
  text: string;
  pin: string | null;
}

async function readAgentPinSource(linkPath: string, target: AgentPinTarget): Promise<AgentPinSource | AgentPinWrite> {
  const refused = (reason: string): AgentPinWrite => ({ result: { name: target.name, status: "refused", reason }, old: null });
  const read = await readContainedFile(linkPath, target.realDir);
  if (read === "gone") {
    return { result: { name: target.name, status: "gone" }, old: null };
  }
  if (read === "outside") {
    return refused("File is outside the agents folder");
  }
  const { resolved, text } = read;
  const fm = locateFrontmatter(text);
  if (fm === null) {
    return refused("No frontmatter block");
  }
  if (getModelLineIndexes(text.slice(fm.start, fm.end).split("\n")).length > 1) {
    return refused("More than one model line");
  }
  const frontmatter = getAgentFrontmatter(text);
  if (frontmatter === null) {
    return refused("Frontmatter could not be parsed");
  }
  const pin = getAgentPin(frontmatter);
  return pin === undefined ? refused("Model line is not a model id") : { resolved, text, pin };
}

// C1 at write time: the realpath is re-checked, so a link swapped in after the listing never leads out of the folder
async function readContainedFile(linkPath: string, realDir: string): Promise<{ resolved: string; text: string } | "gone" | "outside"> {
  try {
    const resolved = await fs.realpath(linkPath);
    if (path.dirname(resolved) !== realDir) {
      return "outside";
    }
    return { resolved, text: await fs.readFile(resolved, "utf8") };
  } catch {
    return "gone";
  }
}

// Caller has checked the frontmatter block and at most one model line
function getTextWithModel(text: string, desired: string): string {
  const fm = locateFrontmatter(text) as { start: number; end: number };
  const lines = text.slice(fm.start, fm.end).split("\n");
  const idx = getModelLineIndexes(lines)[0] ?? -1;
  if (desired === INHERIT_VALUE) {
    if (idx >= 0) {
      lines.splice(idx, 1);
    }
  } else if (idx >= 0) {
    lines[idx] = `model: ${desired}`;
  } else {
    lines.push(`model: ${desired}`);
  }
  return text.slice(0, fm.start) + lines.join("\n") + text.slice(fm.end);
}

function getTextWithoutModel(text: string): string {
  const fm = locateFrontmatter(text);
  if (fm === null) {
    return text;
  }
  const lines = text.slice(fm.start, fm.end).split("\n").filter((line) => !MODEL_LINE.test(line));
  return text.slice(0, fm.start) + lines.join("\n") + text.slice(fm.end);
}

// Top-level key only — an indented `model:` belongs to a nested map
const MODEL_LINE = /^model:/;

function getModelLineIndexes(lines: readonly string[]): number[] {
  return lines.flatMap((line, index) => (MODEL_LINE.test(line) ? [index] : []));
}

/**
 * Frontmatter block boundaries: requires a leading '---\n' and a '\n---\n' closer.
 * Returns [start, end) indices of the inner block (delimiters excluded), or null.
 */
function locateFrontmatter(text: string): { start: number; end: number } | null {
  if (!text.startsWith("---\n")) {
    return null;
  }
  const close = text.indexOf("\n---\n", 3);
  if (close === -1) {
    return null;
  }
  return { start: 4, end: close };
}

// surface readers

/** null = missing or unparseable (GET degrades to 'file-missing' / drift-safe nulls). */
async function readDaemonConfig(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(getDaemonConfigPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// daemon-config.json render engine

/**
 * Write-through render of the full daemon-consumed desired state. Unknown keys
 * (incl. _comment) preserved; per-call budget caps stay STRINGS (trailing zeros survive);
 * 'inherit' removes the per-daemon REPL key. Missing file → created; unparseable
 * file → failed (never clobbered).
 *
 * Exported for model-config.render.unit.test.ts, which drives the un-migrated-DB state the
 * DB-backed route suite cannot reach (its fixture seeds the post-rename keys directly).
 */
export async function renderDaemonConfig(desired: Map<string, string>): Promise<SurfaceResult> {
  const cfgPath = getDaemonConfigPath();
  let target = cfgPath;
  let obj: Record<string, unknown>;
  try {
    target = await fs.realpath(cfgPath);
    const parsed: unknown = JSON.parse(await fs.readFile(target, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { surface: "daemon-config.json", status: "failed", reason: "existing file is not a JSON object — not overwritten" };
    }
    obj = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      target = cfgPath;
      obj = {};
    } else {
      return { surface: "daemon-config.json", status: "failed", reason: "unreadable/unparseable — not overwritten" };
    }
  }

  // Tier knobs share the model-domain render — 'inherit' deletes the key → no --effort / no output-cap env.
  for (const def of [...MODEL_DOMAINS, ...TIER_DOMAINS]) {
    const want = desired.get(def.key);
    if (want === undefined) {
      continue;
    }
    if (want === INHERIT_VALUE) {
      delete obj[def.daemonConfigKey];
    } else {
      obj[def.daemonConfigKey] = want;
    }
  }
  for (const def of BUDGET_DOMAINS) {
    const want = desired.get(def.key);
    if (want !== undefined) {
      // Stays a STRING — daemon_config.py passes it verbatim to --max-budget-usd, so a
      // trailing-zero-dropping number ('0.50' → 0.5) would break the CLI cap.
      obj[def.daemonConfigKey] = want;
    }
  }
  // Renamed keys are carried forward BEFORE anything is deleted, so a rename is never a delete
  // without a replacement. This is what keeps an operator's tuned value alive across the window
  // `scripts/update.sh` opens: it ships new server code without running `prisma migrate deploy`,
  // so every existing install runs this renderer against a DB that still holds the pre-rename
  // rows. Without the carry, the loops above write no successor (no row under the new name) while
  // the delete below removes the legacy key, and the daemon silently falls back to its literal.
  for (const def of RENAMED_DAEMON_CONFIG_KEYS) {
    const carry = resolveRenamedKeyCarry(def, desired, obj);
    if (carry.action === "keep") {
      // Loud, per shared-self-improve-hygiene.md Precondition Loud-Fail: the value is neither
      // carried nor destroyed, and the operator is told which key needs a hand.
      process.stderr.write(
        `[model-config] daemon-config.json: legacy key '${def.legacyConfigKey}' KEPT — ${carry.reason}; fix or remove it by hand\n`,
      );
      continue;
    }
    if (carry.action === "carry") {
      obj[carry.configKey] = carry.value;
      process.stderr.write(
        `[model-config] daemon-config.json: carried '${def.legacyConfigKey}' → '${carry.configKey}' (${carry.value}) — the model_config rename migration has not run on this DB; 'npm run db:deploy' completes it\n`,
      );
    }
    delete obj[def.legacyConfigKey];
  }
  // Dropped keys have no successor, so the delete is unconditional. Scoped to the explicit roster —
  // unknown external keys (_comment, conditional REPL keys) stay preserved by the merge; only keys
  // the monitor once owned are removed.
  for (const key of DROPPED_DAEMON_CONFIG_KEYS) {
    delete obj[key];
  }

  try {
    await atomicWrite(target, `${JSON.stringify(obj, null, 2)}\n`);
  } catch {
    return { surface: "daemon-config.json", status: "failed", reason: "write failed" };
  }
  return { surface: "daemon-config.json", status: "ok" };
}

// shared fs/format helpers

/** Raised when the target's bytes moved between the read a write was computed from and the rename. */
class FileChangedError extends Error {
  constructor(resolvedPath: string) {
    super(`file changed since it was read: ${path.basename(resolvedPath)}`);
    this.name = "FileChangedError";
  }
}

/**
 * Temp file + rename inside the target's own directory (atomic on the same volume).
 * - The temp file is created exclusively → a planted file or link at its name fails the write, never redirects it.
 * - The target's mode carries over; a new file takes NEW_FILE_MODE.
 * @param expected - the text the write was computed from → the target is re-read just before the rename
 * @throws FileChangedError when the re-read differs from `expected`
 */
async function atomicWrite(resolvedPath: string, content: string, expected?: string): Promise<void> {
  const tmp = path.join(path.dirname(resolvedPath), `.${path.basename(resolvedPath)}.tmp-${process.pid}-${Date.now()}`);
  const mode = await getFileMode(resolvedPath);
  const handle = await fs.open(tmp, "wx", mode);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    if (expected !== undefined && (await fs.readFile(resolvedPath, "utf8")) !== expected) {
      throw new FileChangedError(resolvedPath);
    }
    await fs.rename(tmp, resolvedPath);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}

async function getFileMode(resolvedPath: string): Promise<number> {
  try {
    return (await fs.stat(resolvedPath)).mode & 0o777;
  } catch {
    return NEW_FILE_MODE;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function invalidBody(field: string, reason: string): ModelConfigErrorBody {
  return { error: "invalid_body", field, reason };
}

/** One PUT group's validated changes, or the 400 body naming its first invalid field. Absent group → no changes. */
function getGroupChanges<G extends PutGroup>(
  group: G,
  raw: unknown,
): Map<DomainDefByGroup[G]["key"], string> | ModelConfigErrorBody {
  const { defs, unknownKeyReason, validate } = PUT_GROUPS[group];
  const changes = new Map<DomainDefByGroup[G]["key"], string>();
  if (raw === undefined) {
    return changes;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidBody(group, "must be an object");
  }
  for (const [key, value] of Object.entries(raw)) {
    const def = defs.find((d) => d.key === key);
    if (def === undefined) {
      return invalidBody(`${group}.${key}`, unknownKeyReason);
    }
    const reason = validate(def, value);
    if (reason !== null) {
      return invalidBody(`${group}.${key}`, reason);
    }
    // validate() returned null → value is a string (every validator rejects non-strings first).
    changes.set(def.key, value as string);
  }
  return changes;
}

function failWithDb(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  error: unknown,
): unknown {
  return respondDbFailure(request, reply, route, error, "model-config query failed");
}
