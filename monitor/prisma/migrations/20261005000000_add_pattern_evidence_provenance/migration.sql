-- Per-pattern evidence and spawn provenance, migration pass 1 — plan clauded-docs/43378 S2.
-- core.outcomes: agent_id, session_id, user_correction_detected → join an outcome to its spawn and session.
-- core.learning_log: metric_key (closed enum) + LearningStatus 'dormant' (non-terminal).
-- core.autoagent_proposals: learning_pattern_id (FK, ON DELETE SET NULL) + generator_input_version.
-- core.spawn_manifest: one row per MANIFEST line, unique on (spool, line_offset) → the ingest position.
--
-- Additive only. Every new column on an existing table is NULLABLE with no default → NULL = not recorded,
-- and a nullable ADD COLUMN without a default is catalog-only on PG 11+ (no table rewrite).
-- No backfill → re-labelling recorded history is a database mutation requiring an explicit user decision.
-- No index on the new outcomes / proposals columns → no route predicate on them yet; add one on EXPLAIN evidence.
--
-- Transaction note: Prisma Migrate wraps this file in one transaction; since PG 12
-- ALTER TYPE ... ADD VALUE is allowed there as long as the value is not used in the same
-- transaction. No DML here uses 'dormant'.
--
-- Reversal (drops every recorded value; an enum value cannot be dropped in place):
--   DROP TABLE "core"."spawn_manifest";
--   ALTER TABLE "core"."autoagent_proposals" DROP COLUMN "learning_pattern_id", DROP COLUMN "generator_input_version";
--   ALTER TABLE "core"."learning_log" DROP COLUMN "metric_key";
--   DROP TYPE "core"."MetricKey";
--   ALTER TABLE "core"."outcomes" DROP COLUMN "agent_id", DROP COLUMN "session_id", DROP COLUMN "user_correction_detected";
-- IF NOT EXISTS keeps a re-run, and a future pre-release re-squash into the init CREATE TABLE, a no-op.
ALTER TYPE "core"."LearningStatus" ADD VALUE IF NOT EXISTS 'dormant';

DO $$
BEGIN
    CREATE TYPE "core"."MetricKey" AS ENUM ('budget_overage', 'emit_failure');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

ALTER TABLE "core"."outcomes"
    ADD COLUMN IF NOT EXISTS "agent_id" TEXT,
    ADD COLUMN IF NOT EXISTS "session_id" TEXT,
    ADD COLUMN IF NOT EXISTS "user_correction_detected" BOOLEAN;

ALTER TABLE "core"."learning_log"
    ADD COLUMN IF NOT EXISTS "metric_key" "core"."MetricKey";

ALTER TABLE "core"."autoagent_proposals"
    ADD COLUMN IF NOT EXISTS "generator_input_version" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "learning_pattern_id" BIGINT;

DO $$
BEGIN
    ALTER TABLE "core"."autoagent_proposals"
        ADD CONSTRAINT "autoagent_proposals_learning_pattern_id_fkey"
        FOREIGN KEY ("learning_pattern_id") REFERENCES "core"."learning_log"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

CREATE TABLE IF NOT EXISTS "core"."spawn_manifest" (
    "id" BIGSERIAL NOT NULL,
    "spool" TEXT NOT NULL,
    "line_offset" INTEGER NOT NULL,
    "agent_id" TEXT,
    "agent_type" VARCHAR(64) NOT NULL,
    "session_id" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ctx_bytes" INTEGER NOT NULL,
    "blocks" TEXT NOT NULL,

    CONSTRAINT "spawn_manifest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "spawn_manifest_spool_line_offset_key"
    ON "core"."spawn_manifest" ("spool", "line_offset");

CREATE INDEX IF NOT EXISTS "spawn_manifest_agent_id_idx"
    ON "core"."spawn_manifest" ("agent_id");
