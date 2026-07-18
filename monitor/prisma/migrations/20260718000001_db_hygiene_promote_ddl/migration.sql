-- Promote install-path-only DDL into migration history + add missing value-domain CHECKs.
--
-- core.budget_overages and the attribution_source CHECK were previously created ONLY by
-- oss-db-setup.sh post-deploy raw SQL, so a plain `migrate deploy` outside the installer
-- (or a `migrate reset`/shadow replay) produced a DB missing both. This migration makes them
-- part of the canonical history; oss-db-setup.sh now VERIFIES rather than creates them.
--
-- CHECK constraints + a raw-SQL-created table stay out of schema.prisma by design: Prisma 7
-- DSL cannot express a CHECK predicate, and re-declaring budget_overages as a @model would
-- force `migrate diff` to manage a table the hook layer owns. Same raw-SQL-only rationale as
-- 20260718000000_restore_squash_lost_partial_indexes.
--
-- All CHECKs are NOT VALID: new writes are checked, pre-existing rows are trusted (no full
-- table scan, no backfill). DROP IF EXISTS + ADD makes every statement re-run/widen safe.

-- budget_overages: advisory budget-crossing store (advisory-subagent-budget.sh via _pg-write.py).
-- The 6 columns byte-match _pg-write.py _ALLOWED_COLUMNS['core.budget_overages']: agent_id/
-- tool_use_count/budget/crossed_pct NOT NULL, agent_type nullable (sidecar recovery norm),
-- ts defaulted (the hook passes only the other 5). Gains the surrogate PK it previously lacked.
CREATE TABLE IF NOT EXISTS "core"."budget_overages" (
    "id" BIGSERIAL NOT NULL,
    "agent_id" TEXT NOT NULL,
    "agent_type" TEXT,
    "tool_use_count" INTEGER NOT NULL,
    "budget" INTEGER NOT NULL,
    "crossed_pct" INTEGER NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "budget_overages_pkey" PRIMARY KEY ("id")
);

-- Retrofit the PK onto a live DB whose table pre-exists from the old out-of-band CREATE
-- (which had no id / PK) — CREATE TABLE IF NOT EXISTS skips it, so add the column+PK if absent.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'core' AND table_name = 'budget_overages' AND column_name = 'id'
    ) THEN
        ALTER TABLE "core"."budget_overages" ADD COLUMN "id" BIGSERIAL;
        ALTER TABLE "core"."budget_overages" ADD CONSTRAINT "budget_overages_pkey" PRIMARY KEY ("id");
    END IF;
END
$$;

-- Dedup key on the full-precision ts (now() = microsecond, distinct per INSERT) so a re-issued
-- identical (agent_id, tool_use_count, ts) triple cannot double-insert — avoids the
-- second-precision collision window a coarse stamp would open. The hook's plain INSERT is
-- unaffected: separate now() calls never collide, so no legitimate row is false-rejected.
CREATE UNIQUE INDEX IF NOT EXISTS "budget_overages_dedup"
    ON "core"."budget_overages" ("agent_id", "tool_use_count", "ts");

-- attribution_source: 11 canonical values, byte-matching the dual-write producers
-- (track-outcome.sh / outcomes.ts / daemon_cycle.py / _pg_*_dualwrite.py). Nullable exemption
-- keeps pre-2026-05-09 NULL rows valid.
ALTER TABLE "core"."outcomes" DROP CONSTRAINT IF EXISTS "outcomes_attribution_source_check";
ALTER TABLE "core"."outcomes" ADD CONSTRAINT "outcomes_attribution_source_check"
    CHECK (("attribution_source" IS NULL) OR ("attribution_source" = ANY (ARRAY[
        'hook-input','cron-derived','agent-id-missing','subagent-stop-missing',
        'completion-missing','conversation-only','truncated_completion','completion-synthesized',
        'budget-truncation','structuredoutput-derived','structuredoutput-completion'
    ]::text[]))) NOT VALID;

-- evaluative_signal: -1|0|+1 ternary (Field Input Guide); NULL = no signal emitted.
ALTER TABLE "core"."outcomes" DROP CONSTRAINT IF EXISTS "outcomes_evaluative_signal_check";
ALTER TABLE "core"."outcomes" ADD CONSTRAINT "outcomes_evaluative_signal_check"
    CHECK (("evaluative_signal" IS NULL) OR ("evaluative_signal" IN (-1, 0, 1))) NOT VALID;

-- revision_count: rework count, never negative (NOT NULL DEFAULT 0).
ALTER TABLE "core"."outcomes" DROP CONSTRAINT IF EXISTS "outcomes_revision_count_check";
ALTER TABLE "core"."outcomes" ADD CONSTRAINT "outcomes_revision_count_check"
    CHECK ("revision_count" >= 0) NOT VALID;

-- metric_type: mirrors the canonical 9-type task_type set (core-outcome-record.md); NULL allowed.
ALTER TABLE "core"."outcomes" DROP CONSTRAINT IF EXISTS "outcomes_metric_type_check";
ALTER TABLE "core"."outcomes" ADD CONSTRAINT "outcomes_metric_type_check"
    CHECK (("metric_type" IS NULL) OR ("metric_type" = ANY (ARRAY[
        'bug-fix','feature','refactor','research','plan','review','diagnosis','doc','cleanup'
    ]::text[]))) NOT VALID;

-- correction_signals.task_type: same canonical 9-type set (VARCHAR, NOT NULL — no NULL branch).
ALTER TABLE "core"."correction_signals" DROP CONSTRAINT IF EXISTS "correction_signals_task_type_check";
ALTER TABLE "core"."correction_signals" ADD CONSTRAINT "correction_signals_task_type_check"
    CHECK ("task_type" = ANY (ARRAY[
        'bug-fix','feature','refactor','research','plan','review','diagnosis','doc','cleanup'
    ]::text[])) NOT VALID;
