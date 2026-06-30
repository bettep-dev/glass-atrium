// Request/response shapes for /api/telemetry/* endpoints — orchestrator
// agent-selection telemetry.
//
// Data model: core.skill_activations (prisma/schema.prisma model SkillActivation).
// id (BigInt) is narrowed to number on JSON serialization — same pattern as
// outcomes.ts / clauded-docs.ts (rows past Number.MAX_SAFE_INTEGER never occur
// operationally).
//
// source is PG VARCHAR(32) free-form but the route layer enforces a 4-token
// allowlist (orchestrator | subagent | hook | manual) for analysis SoT consistency.

// ----- common --------------------------------------------------------------

/**
 * source allowlist — schema is free-form VARCHAR but the route layer enforces it
 * for analysis consistency. Consider an enum once the pattern accumulates.
 */
export type ActivationSource = "orchestrator" | "subagent" | "hook" | "manual";

/** Single activation row — shared by the POST response + GET list items. */
export interface ActivationRow {
  id: number;
  occurred_at: string;
  source: ActivationSource;
  agent_name: string | null;
  trigger_phrase: string | null;
  selected: boolean;
  /** Decimal(4,3) — 0.000 ~ 1.000. May be null (source not provided). */
  match_score: number | null;
  cid: string | null;
  /** JSONB metadata — free-form. */
  metadata: Record<string, unknown> | null;
}

// ----- POST /api/telemetry/activation --------------------------------------

export interface CreateActivationBody {
  source: ActivationSource;
  /** Required — agent_name is the single mandatory identifier. */
  agent_name: string;
  trigger_phrase?: string | null;
  selected: boolean;
  match_score?: number | null;
  cid?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** POST 201 response — returns only the identifier + timestamp the caller needs for follow-up queries. */
export interface CreateActivationResponse {
  id: number;
  occurred_at: string;
}

// ----- GET /api/telemetry/activations --------------------------------------

export interface ListActivationsQuery {
  days?: string;
  agent?: string;
  selected?: string;
  limit?: string;
  offset?: string;
}

/** Per-agent false-positive aggregation (agent is the single dimension). */
export interface ActivationFalsePositiveRow {
  /** Fixed to 'agent' — kept as a field to leave room for future dimensions. */
  dimension: string;
  /** Agent name. */
  name: string;
  total: number;
  selected: number;
  unselected: number;
  /** unselected / total — 0.000 ~ 1.000. */
  false_positive_rate: number;
}

export interface ListActivationsResponse {
  total: number;
  rows: ActivationRow[];
  summary: {
    total_activations: number;
    selected_count: number;
    unselected_count: number;
    /** unselected / total — overall false-positive rate. */
    overall_false_positive_rate: number;
    /** Per-agent false-positive distribution — top N rows. */
    false_positive_by_dimension: ActivationFalsePositiveRow[];
  };
  filter: {
    days: number;
    agent: string | null;
    selected: boolean | null;
    limit: number;
    offset: number;
  };
  fetched_at: string;
}

// ----- error responses -----------------------------------------------------

export interface TelemetryErrorBody {
  error:
    | "invalid_body"
    | "invalid_param"
    | "database_unavailable"
    | "internal_error";
  /** Which field/param was at fault — for client debugging. */
  field?: string;
  allowed?: readonly string[];
  message?: string;
}
