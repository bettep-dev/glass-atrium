-- Create core.autoagent_apply_records: one append-only row per daemon apply that landed bytes in an agent file — plan clauded-docs/43365 S1.
-- Row: proposal identity copy · apply time + strategy · whole-file sha256 before/after · landed unified diff · worker model id.
-- The queryable copy only → the JSONL applied row is the durable copy; uninstall's dropdb removes this table and fires no trigger.
--
-- No FK to core.autoagent_proposals → proposal ids get reused across database drops, so the identity is copied, never cascaded.
-- Hash + diff columns: NOT NULL + CHECK → the hash helper's failure value is '' (not NULL), and an append-only row is never corrected.
-- (applied_at, id) index → watermark reads by apply time, id as the keyset tie-break.
--
-- Raw SQL the Prisma DSL cannot declare: the CHECKs, the function and the trigger.
--   schema.prisma documents them on AutoagentApplyRecord → a migration squash MUST carry this SQL.
--   monitor/test/autoagent-apply-records.append-only.test.ts runs them against the migrated chain → a squash that drops one goes red.
-- Trigger is FOR EACH STATEMENT → a TRUNCATE trigger must be, and an UPDATE/DELETE matching zero rows is rejected too.
-- Guards app code paths, not a security boundary: the owning role can DISABLE TRIGGER, session_replication_role=replica skips it.
--
-- Reversal (drops every recorded apply; the JSONL applied rows still hold each record):
--   DROP TABLE "core"."autoagent_apply_records";  -- takes its trigger and CHECKs with it
--   DROP FUNCTION "core"."autoagent_apply_records_reject_mutation"();
-- IF NOT EXISTS / OR REPLACE keep a re-run, and a future pre-release re-squash, a no-op.
CREATE TABLE IF NOT EXISTS "core"."autoagent_apply_records" (
    "id" BIGSERIAL NOT NULL,
    "proposal_id" BIGINT NOT NULL,
    "cycle_date" DATE NOT NULL,
    "pattern_label" VARCHAR(256) NOT NULL,
    "target_file" TEXT NOT NULL,
    "target_agent" VARCHAR(64),
    "applied_at" TIMESTAMPTZ(6) NOT NULL,
    "strategy" VARCHAR(16) NOT NULL,
    "before_sha256" VARCHAR(64) NOT NULL,
    "after_sha256" VARCHAR(64) NOT NULL,
    "landed_diff" TEXT NOT NULL,
    "model_id" VARCHAR(64),

    CONSTRAINT "autoagent_apply_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "autoagent_apply_records_before_sha256_check" CHECK ("before_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "autoagent_apply_records_after_sha256_check" CHECK ("after_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "autoagent_apply_records_landed_diff_check" CHECK ("landed_diff" <> '')
);

CREATE INDEX IF NOT EXISTS "autoagent_apply_records_applied_at_idx"
    ON "core"."autoagent_apply_records" ("applied_at", "id");

CREATE OR REPLACE FUNCTION "core"."autoagent_apply_records_reject_mutation"()
    RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'core.autoagent_apply_records is append-only: % rejected', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER "autoagent_apply_records_append_only"
    BEFORE UPDATE OR DELETE OR TRUNCATE ON "core"."autoagent_apply_records"
    FOR EACH STATEMENT
    EXECUTE FUNCTION "core"."autoagent_apply_records_reject_mutation"();
