// Telemetry API — 에이전트 activation 분포 (orchestrator selected vs unselected, SoT = core.skill_activations).
// selected=false 행이 false-positive activation baseline.
// POST 바디는 라우트 레이어 allowlist/length/type 검증 (Zod 미사용) · trigger_phrase 500자 cap (PII bound).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "../../generated/prisma/client.js";
import { buildAgentMembershipFilter, loadCanonicalAgentKeys } from "../agents/registry.js";
import { getPrisma } from "../db.js";
import type {
  ActivationFalsePositiveRow,
  ActivationRow,
  ActivationSource,
  CreateActivationResponse,
  ListActivationsQuery,
  ListActivationsResponse,
  TelemetryErrorBody,
} from "../types/telemetry.js";

// allowlists

const ALLOWED_SOURCES: ReadonlySet<ActivationSource> = new Set<ActivationSource>([
  "orchestrator",
  "subagent",
  "hook",
  "manual",
]);

// Time window — 1-90 range (same as outcomes / agents).
const DAYS_MIN = 1;
const DAYS_MAX = 90;
const DAYS_DEFAULT = 7;

// Pagination caps.
const LIST_LIMIT_MAX = 500;
const LIST_LIMIT_DEFAULT = 100;
const LIST_OFFSET_MAX = 100_000;

// Input length guards — synced with DB column limits.
const SOURCE_MAX_LENGTH = 32;
const AGENT_NAME_MAX_LENGTH = 64;
const TRIGGER_PHRASE_MAX_LENGTH = 500;
const CID_MAX_LENGTH = 96;

// False-positive distribution — top N rows (agent dimension only).
const FP_DIMENSION_LIMIT = 50;

// match_score precision — Decimal(4,3) mapping.
const MATCH_SCORE_MIN = 0;
const MATCH_SCORE_MAX = 1;

// DB row shapes

interface ActivationDbRow {
  id: bigint;
  occurred_at: Date;
  source: string;
  agent_name: string | null;
  trigger_phrase: string | null;
  selected: boolean;
  // PG Decimal → Prisma runtime.Decimal | null (extracted as string, then to number).
  match_score: Prisma.Decimal | null;
  cid: string | null;
  metadata: unknown;
}

interface SummaryRow {
  total: bigint;
  selected_count: bigint;
  unselected_count: bigint;
}

interface FalsePositiveDbRow {
  dimension: string;
  name: string;
  total: bigint;
  selected: bigint;
  unselected: bigint;
}

interface InsertedRow {
  id: bigint;
  occurred_at: Date;
}

// helpers

/** BigInt id → JSON-safe number · 100+ rows/hour ingest 기준 MAX_SAFE_INTEGER 초과 운영상 도달 불가. */
function bigintToNumber(value: bigint): number {
  return Number(value);
}

/** Prisma.Decimal → number | null. */
function decimalToNumber(value: Prisma.Decimal | null): number | null {
  if (value === null) {
    return null;
  }
  return Number(value.toString());
}

/** JSONB(unknown) → Record<string, unknown> | null · null/undefined/object 외엔 방어적으로 null. */
function normalizeMetadata(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function toActivationRow(row: ActivationDbRow): ActivationRow {
  return {
    id: bigintToNumber(row.id),
    occurred_at: row.occurred_at.toISOString(),
    // Schema is free-form, but the route INSERT only admits allowlisted values, so the cast is safe.
    source: row.source as ActivationSource,
    agent_name: row.agent_name,
    trigger_phrase: row.trigger_phrase,
    selected: row.selected,
    match_score: decimalToNumber(row.match_score),
    cid: row.cid,
    metadata: normalizeMetadata(row.metadata),
  };
}

/** 입력 문자열 trim + length guard · 빈 문자열 → null (optional-field 의미) · `'error' in result` 로 narrow. */
type NormalizeStringResult =
  | { value: string | null }
  | { error: "too_long" | "wrong_type" };

function normalizeOptionalString(value: unknown, maxLength: number): NormalizeStringResult {
  if (value === null || value === undefined) {
    return { value: null };
  }
  if (typeof value !== "string") {
    return { error: "wrong_type" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { value: null };
  }
  if (trimmed.length > maxLength) {
    return { error: "too_long" };
  }
  return { value: trimmed };
}

interface ParsedBody {
  source: ActivationSource;
  agent_name: string;
  trigger_phrase: string | null;
  selected: boolean;
  match_score: number | null;
  cid: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * POST 바디 파싱 + 검증 · 실패 시 첫 위반 필드명 반환.
 * - source: 4-token allowlist
 * - agent_name: 필수 (빈 문자열 거부)
 * - match_score: 0.0 ~ 1.0 (Decimal(4,3))
 * - selected: 명시적 boolean — false 도 유효 (false-positive 측정)
 */
function parseBody(body: unknown): ParsedBody | { error: string; field: string } {
  if (body === null || typeof body !== "object") {
    return { error: "invalid_body", field: "body" };
  }
  const raw = body as Record<string, unknown>;

  // source — allowlist enforced.
  if (typeof raw.source !== "string" || raw.source.length === 0) {
    return { error: "invalid_body", field: "source" };
  }
  if (raw.source.length > SOURCE_MAX_LENGTH || !ALLOWED_SOURCES.has(raw.source as ActivationSource)) {
    return { error: "invalid_body", field: "source" };
  }
  const source = raw.source as ActivationSource;

  // selected — explicit boolean.
  if (typeof raw.selected !== "boolean") {
    return { error: "invalid_body", field: "selected" };
  }

  // agent_name — required non-empty string (null → missing, error → format/length violation).
  const agentName = normalizeOptionalString(raw.agent_name, AGENT_NAME_MAX_LENGTH);
  if ("error" in agentName || agentName.value === null) {
    return { error: "invalid_body", field: "agent_name" };
  }

  // trigger_phrase — PII length guard.
  const triggerPhrase = normalizeOptionalString(raw.trigger_phrase, TRIGGER_PHRASE_MAX_LENGTH);
  if ("error" in triggerPhrase) {
    return { error: "invalid_body", field: "trigger_phrase" };
  }

  // cid — no format validation (format may change).
  const cid = normalizeOptionalString(raw.cid, CID_MAX_LENGTH);
  if ("error" in cid) {
    return { error: "invalid_body", field: "cid" };
  }

  // match_score — Decimal(4,3) range.
  let matchScore: number | null = null;
  if (raw.match_score !== null && raw.match_score !== undefined) {
    if (typeof raw.match_score !== "number" || !Number.isFinite(raw.match_score)) {
      return { error: "invalid_body", field: "match_score" };
    }
    if (raw.match_score < MATCH_SCORE_MIN || raw.match_score > MATCH_SCORE_MAX) {
      return { error: "invalid_body", field: "match_score" };
    }
    matchScore = raw.match_score;
  }

  // metadata — object or null.
  let metadata: Record<string, unknown> | null = null;
  if (raw.metadata !== null && raw.metadata !== undefined) {
    if (typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) {
      return { error: "invalid_body", field: "metadata" };
    }
    metadata = raw.metadata as Record<string, unknown>;
  }

  return {
    source,
    agent_name: agentName.value,
    trigger_phrase: triggerPhrase.value,
    selected: raw.selected,
    match_score: matchScore,
    cid: cid.value,
    metadata,
  };
}

interface ParsedListQuery {
  days: number;
  agent: string | null;
  selected: boolean | null;
  limit: number;
  offset: number;
}

/** 정수 범위 검증 헬퍼 · undefined → default, 범위 밖 → error. */
type IntRangeResult = { value: number } | { error: "invalid_param"; field: string };

function parseIntInRange(
  raw: string | undefined,
  field: string,
  min: number,
  max: number,
  defaultValue: number,
): IntRangeResult {
  if (raw === undefined) {
    return { value: defaultValue };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { error: "invalid_param", field };
  }
  return { value: parsed };
}

function parseListQuery(query: ListActivationsQuery): ParsedListQuery | { error: string; field: string } {
  // days — integer 1..90, default 7.
  const daysResult = parseIntInRange(query.days, "days", DAYS_MIN, DAYS_MAX, DAYS_DEFAULT);
  if ("error" in daysResult) {
    return daysResult;
  }

  // agent — exact match (not LIKE substring). Length guard.
  let agent: string | null = null;
  if (query.agent !== undefined && query.agent.length > 0) {
    if (query.agent.length > AGENT_NAME_MAX_LENGTH) {
      return { error: "invalid_param", field: "agent" };
    }
    agent = query.agent;
  }

  // selected — only 'true' / 'false' accepted, else rejected.
  let selected: boolean | null = null;
  if (query.selected !== undefined) {
    if (query.selected === "true") {
      selected = true;
    } else if (query.selected === "false") {
      selected = false;
    } else {
      return { error: "invalid_param", field: "selected" };
    }
  }

  // limit — 1..LIST_LIMIT_MAX, default LIST_LIMIT_DEFAULT.
  const limitResult = parseIntInRange(query.limit, "limit", 1, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT);
  if ("error" in limitResult) {
    return limitResult;
  }

  // offset — 0..LIST_OFFSET_MAX, default 0.
  const offsetResult = parseIntInRange(query.offset, "offset", 0, LIST_OFFSET_MAX, 0);
  if ("error" in offsetResult) {
    return offsetResult;
  }

  return {
    days: daysResult.value,
    agent,
    selected,
    limit: limitResult.value,
    offset: offsetResult.value,
  };
}

// registration

export async function registerTelemetryRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/telemetry/activation", handleCreate);
  app.get("/api/telemetry/activations", handleList);
}

// POST /api/telemetry/activation

async function handleCreate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<CreateActivationResponse | TelemetryErrorBody> {
  const start = Date.now();

  const parsed = parseBody(request.body);
  if ("error" in parsed) {
    return reply.code(400).send({
      error: "invalid_body",
      field: parsed.field,
      allowed: parsed.field === "source" ? Array.from(ALLOWED_SOURCES) : undefined,
    } satisfies TelemetryErrorBody);
  }

  const prisma = getPrisma();
  try {
    // metadata is JSONB — explicit cast via Prisma.sql (JSON.stringify + ::jsonb).
    const metadataLiteral =
      parsed.metadata === null
        ? Prisma.sql`NULL`
        : Prisma.sql`${JSON.stringify(parsed.metadata)}::jsonb`;
    const matchScoreLiteral =
      parsed.match_score === null ? Prisma.sql`NULL` : Prisma.sql`${parsed.match_score}::numeric(4,3)`;
    const rows = await prisma.$queryRaw<InsertedRow[]>`
      INSERT INTO core.skill_activations
        (source, agent_name, trigger_phrase, selected, match_score, cid, metadata)
      VALUES (
        ${parsed.source},
        ${parsed.agent_name},
        ${parsed.trigger_phrase},
        ${parsed.selected},
        ${matchScoreLiteral},
        ${parsed.cid},
        ${metadataLiteral}
      )
      RETURNING id, occurred_at
    `;
    const row = rows[0];
    if (row === undefined) {
      // Empty RETURNING means a PG/Prisma-level anomaly — surface as 5xx.
      request.log.error(
        { route: "/api/telemetry/activation" },
        "INSERT core.skill_activations returned no row",
      );
      return reply.code(500).send({
        error: "internal_error",
        message: "insert returned no row",
      } satisfies TelemetryErrorBody);
    }
    request.log.info(
      {
        route: "/api/telemetry/activation",
        durationMs: Date.now() - start,
        id: row.id.toString(),
        source: parsed.source,
        selected: parsed.selected,
      },
      "skill activation recorded",
    );
    reply.code(201);
    return {
      id: bigintToNumber(row.id),
      occurred_at: row.occurred_at.toISOString(),
    };
  } catch (error) {
    request.log.error(
      { err: error, route: "/api/telemetry/activation" },
      "skill activation INSERT failed",
    );
    return reply.code(503).send({
      error: "database_unavailable",
    } satisfies TelemetryErrorBody);
  }
}

// GET /api/telemetry/activations

async function handleList(
  request: FastifyRequest<{ Querystring: ListActivationsQuery }>,
  reply: FastifyReply,
): Promise<ListActivationsResponse | TelemetryErrorBody> {
  const start = Date.now();

  const parsed = parseListQuery(request.query);
  if ("error" in parsed) {
    return reply.code(400).send({
      error: "invalid_param",
      field: parsed.field,
    } satisfies TelemetryErrorBody);
  }

  // Build condition SQL — Prisma.sql + Prisma.join block injection.
  const conditions: Prisma.Sql[] = [
    Prisma.sql`occurred_at >= NOW() - ${`${parsed.days} days`}::interval`,
  ];
  if (parsed.agent !== null) {
    conditions.push(Prisma.sql`agent_name = ${parsed.agent}`);
  }
  if (parsed.selected !== null) {
    conditions.push(Prisma.sql`selected = ${parsed.selected}`);
  }
  const whereClause = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;

  // Canonical-membership gate (registry SoT — only Atrium-system agents) for the
  // two RENDERED agent-dimensioned surfaces: the raw activations LIST (rows) and
  // the FP-distribution sub-query (its own WHERE + top-N FP_DIMENSION_LIMIT).
  // Deliberately NOT applied to the shared summary whereClause — the list/summary
  // TOTALS + overall_false_positive_rate MUST stay all-agent (documented
  // invariant). Fail-soft: an empty registry skips the predicate (fail-open) —
  // Prisma.join([]) would be invalid SQL.
  const canonicalAgents = await loadCanonicalAgentKeys();
  const agentNameMembershipFilter = buildAgentMembershipFilter(
    canonicalAgents,
    Prisma.sql`agent_name`,
  );

  const prisma = getPrisma();
  try {
    // 3-way parallel: rows / summary (with COUNT) / false-positive distribution.
    // summaryRows.total is reused as the list total (saves one PG scan).
    const [rowsRaw, summaryRows, fpRows] = await Promise.all([
      prisma.$queryRaw<ActivationDbRow[]>`
        SELECT
          id,
          occurred_at,
          source,
          agent_name,
          trigger_phrase,
          selected,
          match_score,
          cid,
          metadata
        FROM core.skill_activations
        ${whereClause}
        ${agentNameMembershipFilter}
        ORDER BY occurred_at DESC
        LIMIT ${parsed.limit}
        OFFSET ${parsed.offset}
      `,
      prisma.$queryRaw<SummaryRow[]>`
        SELECT
          COUNT(*)::bigint                                              AS total,
          SUM(CASE WHEN selected THEN 1 ELSE 0 END)::bigint             AS selected_count,
          SUM(CASE WHEN NOT selected THEN 1 ELSE 0 END)::bigint         AS unselected_count
        FROM core.skill_activations
        ${whereClause}
      `,
      // False-positive distribution: single agent dimension.
      // agent_name NULL rows excluded (meaningless aggregation).
      prisma.$queryRaw<FalsePositiveDbRow[]>`
        SELECT dimension, name, total, selected, unselected FROM (
          SELECT
            'agent'::text                                                AS dimension,
            agent_name                                                   AS name,
            COUNT(*)::bigint                                             AS total,
            SUM(CASE WHEN selected THEN 1 ELSE 0 END)::bigint            AS selected,
            SUM(CASE WHEN NOT selected THEN 1 ELSE 0 END)::bigint        AS unselected
          FROM core.skill_activations
          ${whereClause}
          AND agent_name IS NOT NULL
          ${agentNameMembershipFilter}
          GROUP BY agent_name
        ) AS combined
        WHERE total > 0
        ORDER BY unselected::float / total::float DESC, total DESC
        LIMIT ${FP_DIMENSION_LIMIT}
      `,
    ]);

    const summaryRow = summaryRows[0];
    const summaryTotal = summaryRow === undefined ? 0 : bigintToNumber(summaryRow.total);
    const summarySelected = summaryRow === undefined ? 0 : bigintToNumber(summaryRow.selected_count);
    const summaryUnselected = summaryRow === undefined ? 0 : bigintToNumber(summaryRow.unselected_count);
    // total == summaryTotal (COUNT(*) over the same WHERE).
    const total = summaryTotal;
    const overallFpRate = summaryTotal === 0 ? 0 : summaryUnselected / summaryTotal;

    const falsePositiveRows: ActivationFalsePositiveRow[] = fpRows.map((r) => {
      const rowTotal = bigintToNumber(r.total);
      const rowUnselected = bigintToNumber(r.unselected);
      return {
        dimension: r.dimension,
        name: r.name,
        total: rowTotal,
        selected: bigintToNumber(r.selected),
        unselected: rowUnselected,
        false_positive_rate: rowTotal === 0 ? 0 : rowUnselected / rowTotal,
      };
    });

    request.log.info(
      {
        route: "/api/telemetry/activations",
        durationMs: Date.now() - start,
        days: parsed.days,
        total,
        returned: rowsRaw.length,
      },
      "skill activations list complete",
    );

    return {
      total,
      rows: rowsRaw.map(toActivationRow),
      summary: {
        total_activations: summaryTotal,
        selected_count: summarySelected,
        unselected_count: summaryUnselected,
        overall_false_positive_rate: overallFpRate,
        false_positive_by_dimension: falsePositiveRows,
      },
      filter: {
        days: parsed.days,
        agent: parsed.agent,
        selected: parsed.selected,
        limit: parsed.limit,
        offset: parsed.offset,
      },
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    request.log.error(
      { err: error, route: "/api/telemetry/activations" },
      "skill activations list failed",
    );
    return reply.code(503).send({
      error: "database_unavailable",
    } satisfies TelemetryErrorBody);
  }
}
