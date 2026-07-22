// Model-config API (spec doc 36166): GET/PUT /api/model-config — per-domain model
// assignment + per-call budget hard caps. DB (monitor.model_config) = UI SoT;
// daemon-config.json is the write-through-rendered consumer view; agent frontmatter is the
// harness-consumed surface for dev/research pins.

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { loadAgentRegistry } from "../agents/registry.js";
import { getPrisma } from "../db.js";
import { respondDbFailure } from "../db-failure.js";
import type { AuditChangeCarrier } from "../middleware/audit-log.js";
import {
  BUDGET_DOMAINS,
  DEPRECATED_DAEMON_CONFIG_KEYS,
  INHERIT_VALUE,
  MODEL_DOMAINS,
  isPricingKnown,
  loadKnownModelIds,
  normalizeModelId,
  validateBudgetValue,
  validateModelValue,
  type BudgetDomainDef,
  type ModelDomainDef,
} from "../model-config-consts.js";
import type {
  BudgetDomainKey,
  BudgetDomainStatus,
  DaemonConfigSyncState,
  DomainFileModel,
  DomainStatus,
  ModelConfigErrorBody,
  ModelConfigGetResponse,
  ModelConfigPutBody,
  ModelConfigPutResponse,
  ModelDomainKey,
  SurfaceFileResult,
  SurfaceResult,
} from "../types/model-config.js";

// updated_by audit convention — the monitor web server is the sole write origin (mirrors
// middleware/audit-log.ts AUDIT_ACTOR).
const UPDATED_BY = "monitor-web";

const RESEARCH_AGENT_FILE = "glass-atrium-intel-researcher.md";
const META_AGENT_FILE = "glass-atrium-meta-agent.md";
const WIKI_AGENT_FILE = "glass-atrium-wiki-curator.md";
const DEV_AGENT_FILE_PATTERN = /^glass-atrium-dev-[a-z0-9-]+\.md$/;

// Display label for an absent per-daemon REPL key — the bootstrap exec carries no model
// flag, so the tmux session inherits the settings.json model (D3).
const INHERIT_SETTINGS_LABEL = "inherit (settings.json)";

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
  const desired = new Map<string, string>(rows.map((r) => [r.configKey, r.configValue]));

  const [daemonConfig, devFiles, researchModel, metaModel, wikiModel, knownModelIds] =
    await Promise.all([
      readDaemonConfig(),
      readDevAgentModels(),
      readFrontmatterModel(path.join(getAgentsDir(), RESEARCH_AGENT_FILE), undefined),
      readFrontmatterModel(path.join(getAgentsDir(), META_AGENT_FILE), undefined),
      readFrontmatterModel(path.join(getAgentsDir(), WIKI_AGENT_FILE), undefined),
      loadKnownModelIds(),
    ]);
  const surfaces: ActualSurfaces = {
    daemonConfig,
    devFiles,
    researchModel,
    metaModel,
    wikiModel,
    knownModelIds,
  };

  const domains: DomainStatus[] = MODEL_DOMAINS.map((def) =>
    buildDomainStatus(def, desired.get(def.key) ?? null, surfaces),
  );

  const budgets: BudgetDomainStatus[] = BUDGET_DOMAINS.map((def) =>
    buildBudgetStatus(def, desired.get(def.key) ?? null, daemonConfig),
  );

  return {
    fetched_at: new Date().toISOString(),
    known_models: [...knownModelIds],
    domains,
    budgets,
    daemon_config_sync: computeDaemonConfigSync(desired, daemonConfig),
  };
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

// One read-once snapshot per GET — every file-derived input rides here, never as a
// loose positional arg.
interface ActualSurfaces {
  daemonConfig: Record<string, unknown> | null;
  devFiles: DomainFileModel[];
  researchModel: string | null | undefined; // undefined = unparseable/unreadable
  metaModel: string | null | undefined;
  wikiModel: string | null | undefined;
  knownModelIds: ReadonlySet<string>;
}

function buildDomainStatus(
  def: ModelDomainDef,
  desired: string | null,
  surfaces: ActualSurfaces,
): DomainStatus {
  let actual: string | null;
  let files: DomainFileModel[] | undefined;

  switch (def.surface) {
    case "frontmatter-dev": {
      files = surfaces.devFiles;
      const states = files.map((f) => f.model ?? INHERIT_VALUE);
      const uniq = new Set(states);
      actual = files.length === 0 ? null : uniq.size === 1 ? states[0] : "mixed";
      break;
    }
    case "frontmatter-research":
      actual = surfaces.researchModel === undefined ? null : (surfaces.researchModel ?? INHERIT_VALUE);
      break;
    case "frontmatter-meta":
      actual = surfaces.metaModel === undefined ? null : (surfaces.metaModel ?? INHERIT_VALUE);
      break;
    case "frontmatter-wiki":
      actual = surfaces.wikiModel === undefined ? null : (surfaces.wikiModel ?? INHERIT_VALUE);
      break;
    case "daemon-config": {
      const raw = surfaces.daemonConfig?.[def.daemonConfigKey ?? ""];
      actual = typeof raw === "string" ? raw : INHERIT_SETTINGS_LABEL;
      break;
    }
  }

  const status: DomainStatus = {
    domain: def.key,
    desired,
    actual,
    drift: computeDrift(desired, actual),
    apply_mode: def.applyMode,
    editable: def.editable,
    pricing_known: isPricingKnown(desired, surfaces.knownModelIds),
  };
  if (files !== undefined) {
    status.files = files;
  }
  return status;
}

function computeDrift(desired: string | null, actual: string | null): boolean {
  // Unknown side → no drift claim (never alarm on unreadable surface).
  if (desired === null || actual === null) {
    return false;
  }
  if (actual === "mixed") {
    return true;
  }
  const actualEffective = actual === INHERIT_SETTINGS_LABEL ? INHERIT_VALUE : actual;
  return normalizeModelId(desired) !== normalizeModelId(actualEffective);
}

/**
 * DB desired-state vs rendered daemon-config.json view (D2). A budget key set in the DB
 * but absent from (or differing in) the rendered file is drift — pressing Save re-renders it.
 */
function computeDaemonConfigSync(
  desired: Map<string, string>,
  daemonConfig: Record<string, unknown> | null,
): DaemonConfigSyncState {
  if (daemonConfig === null) {
    return "file-missing";
  }
  for (const def of MODEL_DOMAINS) {
    if (def.daemonConfigKey === null) {
      continue;
    }
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
  const models = body.models;
  const budgets = body.budgets;
  if (models === undefined && budgets === undefined) {
    return reply.code(400).send(invalidBody("body", "must contain 'models' and/or 'budgets'"));
  }

  const modelChanges = new Map<ModelDomainKey, string>();
  if (models !== undefined) {
    if (models === null || typeof models !== "object" || Array.isArray(models)) {
      return reply.code(400).send(invalidBody("models", "must be an object"));
    }
    for (const [key, value] of Object.entries(models)) {
      const def = MODEL_DOMAINS.find((d) => d.key === key);
      if (def === undefined) {
        return reply.code(400).send(invalidBody(`models.${key}`, "unknown domain key"));
      }
      const reason = validateModelValue(def, value);
      if (reason !== null) {
        return reply.code(400).send(invalidBody(`models.${key}`, reason));
      }
      modelChanges.set(def.key, value as string);
    }
  }

  // Per-call caps validate INDEPENDENTLY — no cross-field invariant (each guards a single
  // runaway `claude -p --max-budget-usd` call, not a budget pair).
  const budgetChanges = new Map<BudgetDomainKey, string>();
  if (budgets !== undefined) {
    if (budgets === null || typeof budgets !== "object" || Array.isArray(budgets)) {
      return reply.code(400).send(invalidBody("budgets", "must be an object"));
    }
    for (const [key, value] of Object.entries(budgets)) {
      const def = BUDGET_DOMAINS.find((d) => d.key === key);
      if (def === undefined) {
        return reply.code(400).send(invalidBody(`budgets.${key}`, "unknown budget key"));
      }
      const reason = validateBudgetValue(value);
      if (reason !== null) {
        return reply.code(400).send(invalidBody(`budgets.${key}`, reason));
      }
      budgetChanges.set(def.key, value as string);
    }
  }

  try {
    const currentRows = await prisma.modelConfig.findMany();
    const current = new Map<string, string>(currentRows.map((r) => [r.configKey, r.configValue]));

    // daemon-apply stash-window guard (D4 amended): the real lock is the filesystem dir
    // ~/.glass-atrium/data/daemon-reports/.apply-lock — fail-open when absent.
    const touchesFrontmatter =
      modelChanges.has("model.dev") ||
      modelChanges.has("model.research") ||
      modelChanges.has("model.meta") ||
      modelChanges.has("model.wiki");
    if (touchesFrontmatter && (await pathExists(getApplyLockPath()))) {
      return reply.code(409).send({
        error: "daemon_apply_in_progress",
        reason: "daemon-apply lock present (.apply-lock) — retry after the apply cycle finishes",
      } satisfies ModelConfigErrorBody);
    }

    // single DB transaction over the changed rows
    const upserts = new Map<string, string>([...modelChanges, ...budgetChanges]);
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
    const surfaces: SurfaceResult[] = [];
    const touchesDaemonConfig =
      [...upserts.keys()].some(
        (k) =>
          BUDGET_DOMAINS.some((d) => d.key === k) ||
          MODEL_DOMAINS.some((d) => d.key === k && d.daemonConfigKey !== null),
      );
    if (touchesDaemonConfig) {
      surfaces.push(await renderDaemonConfig(merged));
    }
    if (modelChanges.has("model.dev")) {
      surfaces.push(await renderDevFrontmatter(modelChanges.get("model.dev") as string));
    }
    if (modelChanges.has("model.research")) {
      surfaces.push(await renderResearchFrontmatter(modelChanges.get("model.research") as string));
    }
    if (modelChanges.has("model.meta")) {
      surfaces.push(await renderMetaFrontmatter(modelChanges.get("model.meta") as string));
    }
    if (modelChanges.has("model.wiki")) {
      surfaces.push(await renderWikiFrontmatter(modelChanges.get("model.wiki") as string));
    }

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

async function listDevAgentFiles(): Promise<string[]> {
  let onDisk: string[];
  try {
    const entries = await fs.readdir(getAgentsDir());
    onDisk = entries.filter((name) => DEV_AGENT_FILE_PATTERN.test(name)).sort();
  } catch {
    return [];
  }
  // Intersect the on-disk glass-atrium-dev-*.md set with the canonical registry's
  // glass-atrium-dev-* keys so a
  // de-registered/archived glass-atrium-dev-*.md file no longer surfaces in the model table (nor
  // receives a frontmatter write). Fail-open: an empty/corrupt registry (size 0)
  // skips the intersection and returns the full on-disk set — mirrors the SQL gates'
  // fail-open contract so a registry read failure never blanks the dev table.
  const registry = await loadAgentRegistry();
  if (registry.size === 0) {
    return onDisk;
  }
  const registeredDevKeys = new Set(
    [...registry.keys()].filter((key) => key.startsWith("glass-atrium-dev-")),
  );
  return onDisk.filter((name) => registeredDevKeys.has(name.replace(/\.md$/, "")));
}

async function readDevAgentModels(): Promise<DomainFileModel[]> {
  const names = await listDevAgentFiles();
  return Promise.all(
    names.map(async (name) => ({
      file: name,
      model: await readFrontmatterModel(path.join(getAgentsDir(), name), null),
    })),
  );
}

/**
 * Read one agent file's `model:` frontmatter value; `missing` is the caller-chosen
 * sentinel for an unreadable file or absent `---` block. Research passes `undefined` to
 * keep an unreadable surface distinct from a present-but-model-less block (extractModelLine's
 * null → drift-safe INHERIT in buildDomainStatus); the dev per-file surface passes `null`,
 * conflating both.
 */
async function readFrontmatterModel<T extends null | undefined>(
  filePath: string,
  missing: T,
): Promise<string | null | T> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const fm = locateFrontmatter(text);
    if (fm === null) {
      return missing;
    }
    return extractModelLine(text.slice(fm.start, fm.end));
  } catch {
    return missing;
  }
}

// frontmatter writer

async function renderDevFrontmatter(desired: string): Promise<SurfaceResult> {
  const names = await listDevAgentFiles();
  if (names.length === 0) {
    return { surface: "frontmatter-dev", status: "failed", reason: "no dev-*.md agent files found" };
  }
  const files: SurfaceFileResult[] = [];
  for (const name of names) {
    files.push(await writeFrontmatterModel(path.join(getAgentsDir(), name), desired));
  }
  return { surface: "frontmatter-dev", status: aggregateFileStatus(files), files };
}

async function renderResearchFrontmatter(desired: string): Promise<SurfaceResult> {
  const result = await writeFrontmatterModel(path.join(getAgentsDir(), RESEARCH_AGENT_FILE), desired);
  return { surface: "frontmatter-research", status: result.status, reason: result.reason, files: [result] };
}

async function renderMetaFrontmatter(desired: string): Promise<SurfaceResult> {
  const result = await writeFrontmatterModel(path.join(getAgentsDir(), META_AGENT_FILE), desired);
  return { surface: "frontmatter-meta", status: result.status, reason: result.reason, files: [result] };
}

async function renderWikiFrontmatter(desired: string): Promise<SurfaceResult> {
  const result = await writeFrontmatterModel(path.join(getAgentsDir(), WIKI_AGENT_FILE), desired);
  return { surface: "frontmatter-wiki", status: result.status, reason: result.reason, files: [result] };
}

function aggregateFileStatus(files: SurfaceFileResult[]): "ok" | "skipped" | "failed" {
  if (files.some((f) => f.status === "failed")) {
    return "failed";
  }
  if (files.some((f) => f.status === "skipped")) {
    return "skipped";
  }
  return "ok";
}

/**
 * Upsert ONLY the `model:` line in one agent file's frontmatter; 'inherit' removes it.
 * The target path is realpath-resolved BEFORE the temp+rename so a ~/.glass-atrium/agents
 * entry consumed in place resolves to the GA-tracked file — the write lands inside the
 * RESOLVED directory. Already-satisfied files are never
 * rewritten (alias values + bytes preserved). Unparseable frontmatter → skipped + surfaced.
 */
async function writeFrontmatterModel(linkPath: string, desired: string): Promise<SurfaceFileResult> {
  const file = path.basename(linkPath);
  let resolved: string;
  try {
    resolved = await fs.realpath(linkPath);
  } catch {
    return { file, status: "failed", reason: "path not resolvable (missing file or dangling symlink)" };
  }
  let text: string;
  try {
    text = await fs.readFile(resolved, "utf8");
  } catch {
    return { file, status: "failed", reason: "unreadable" };
  }
  const fm = locateFrontmatter(text);
  if (fm === null) {
    return { file, status: "skipped", reason: "unparseable frontmatter (missing --- delimiters)" };
  }
  const lines = text.slice(fm.start, fm.end).split("\n");
  const idx = lines.findIndex((line) => /^model:/.test(line));

  if (desired === INHERIT_VALUE) {
    if (idx === -1) {
      return { file, status: "ok" };
    }
    lines.splice(idx, 1);
  } else {
    const modelLine = `model: ${desired}`;
    if (idx >= 0) {
      if (lines[idx] === modelLine) {
        return { file, status: "ok" };
      }
      lines[idx] = modelLine;
    } else {
      lines.push(modelLine);
    }
  }

  const newText = text.slice(0, fm.start) + lines.join("\n") + text.slice(fm.end);
  try {
    await atomicWrite(resolved, newText);
  } catch {
    return { file, status: "failed", reason: "write failed" };
  }
  return { file, status: "ok" };
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

function extractModelLine(block: string): string | null {
  const match = /^model:[ \t]*(.+?)[ \t]*$/m.exec(block);
  return match === null ? null : match[1];
}

// daemon-config.json render engine

/**
 * Write-through render of the full daemon-consumed desired state. Unknown keys
 * (incl. _comment) preserved; per-call budget caps stay STRINGS (trailing zeros survive);
 * 'inherit' removes the per-daemon REPL key. Missing file → created; unparseable
 * file → failed (never clobbered).
 */
async function renderDaemonConfig(desired: Map<string, string>): Promise<SurfaceResult> {
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

  for (const def of MODEL_DOMAINS) {
    if (def.daemonConfigKey === null) {
      continue;
    }
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
  // Scoped to the explicit deprecation list — unknown external keys (_comment, conditional
  // REPL keys) stay preserved by the merge; only keys the monitor once owned are removed.
  for (const key of DEPRECATED_DAEMON_CONFIG_KEYS) {
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

/** Temp file + rename inside the target's own directory (atomic on the same volume). */
async function atomicWrite(resolvedPath: string, content: string): Promise<void> {
  const dir = path.dirname(resolvedPath);
  const tmp = path.join(dir, `.${path.basename(resolvedPath)}.tmp-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, content, "utf8");
  try {
    await fs.rename(tmp, resolvedPath);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
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

function failWithDb(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  error: unknown,
): unknown {
  return respondDbFailure(request, reply, route, error, "model-config query failed");
}
