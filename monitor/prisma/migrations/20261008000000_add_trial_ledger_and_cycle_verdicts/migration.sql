-- Trial ledger + per-cycle all-reject verdicts, migration pass 2 — plan clauded-docs/43378 S4a.
-- core.autoagent_trial_ledger: one append-only row per trial event, with an actor token and a JSONB payload.
-- core.autoagent_cycle_verdicts: one immutable cycle-time verdict per cycle_date → the all-reject walk reads it,
--   so a later status change on a past proposal never rewrites that date's verdict.
--
-- Ledger dedupe_key: once-only events insert with ON CONFLICT ("dedupe_key") DO NOTHING → a repeat adds no row,
--   and DO NOTHING fires no UPDATE trigger. NULL = a repeatable event; NULLs never conflict (NULLS DISTINCT).
-- Ledger trial_key / agent / learning_pattern_id are NULLABLE → cycle-level rows (power-pass count, A/A restart)
--   belong to no trial. No FK on learning_pattern_id → an FK action on a learning_log delete would UPDATE this table.
-- event / actor are VARCHAR, not enums → each closed set is declared once at its writer; a new value needs no migration.
-- CHECKs fail loud on values an append-only row could never correct: a trial_key that is not a whole sha256 hex,
--   and an empty event, actor or dedupe_key (an empty key would dedupe unrelated events).
-- No secondary index beyond the two unique ones → no reader yet; add one on EXPLAIN evidence.
--
-- Raw SQL the Prisma DSL cannot declare: the CHECKs, the functions and the triggers.
--   schema.prisma documents them on both models → a migration squash MUST carry this SQL.
--   monitor/test/autoagent-trial-ledger.append-only.test.ts runs them against the migrated chain → a squash that drops one goes red.
-- Triggers are FOR EACH STATEMENT → a TRUNCATE trigger must be, and an UPDATE/DELETE matching zero rows is rejected too.
-- Guards app code paths, not a security boundary: the owning role can DISABLE TRIGGER, session_replication_role=replica skips it.
--
-- Reversal (drops every recorded trial event and verdict):
--   DROP TABLE "core"."autoagent_trial_ledger";    -- takes its trigger, CHECKs and indexes with it
--   DROP TABLE "core"."autoagent_cycle_verdicts";
--   DROP FUNCTION "core"."autoagent_trial_ledger_reject_mutation"();
--   DROP FUNCTION "core"."autoagent_cycle_verdicts_reject_mutation"();
--   DROP TYPE "core"."CycleVerdict";
-- IF NOT EXISTS / OR REPLACE / duplicate_object keep a re-run, and a future pre-release re-squash, a no-op.
DO $$
BEGIN
    CREATE TYPE "core"."CycleVerdict" AS ENUM ('extends', 'neutral', 'breaks');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

CREATE TABLE IF NOT EXISTS "core"."autoagent_trial_ledger" (
    "id" BIGSERIAL NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trial_key" VARCHAR(64),
    "agent" VARCHAR(64),
    "learning_pattern_id" BIGINT,
    "event" VARCHAR(64) NOT NULL,
    "actor" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupe_key" TEXT,

    CONSTRAINT "autoagent_trial_ledger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "autoagent_trial_ledger_trial_key_check" CHECK ("trial_key" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "autoagent_trial_ledger_event_check" CHECK ("event" <> ''),
    CONSTRAINT "autoagent_trial_ledger_actor_check" CHECK ("actor" <> ''),
    CONSTRAINT "autoagent_trial_ledger_dedupe_key_check" CHECK ("dedupe_key" <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS "autoagent_trial_ledger_dedupe_key_key"
    ON "core"."autoagent_trial_ledger" ("dedupe_key");

CREATE TABLE IF NOT EXISTS "core"."autoagent_cycle_verdicts" (
    "id" BIGSERIAL NOT NULL,
    "cycle_date" DATE NOT NULL,
    "verdict" "core"."CycleVerdict" NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autoagent_cycle_verdicts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "autoagent_cycle_verdicts_cycle_date_key"
    ON "core"."autoagent_cycle_verdicts" ("cycle_date");

CREATE OR REPLACE FUNCTION "core"."autoagent_trial_ledger_reject_mutation"()
    RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'core.autoagent_trial_ledger is append-only: % rejected', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER "autoagent_trial_ledger_append_only"
    BEFORE UPDATE OR DELETE OR TRUNCATE ON "core"."autoagent_trial_ledger"
    FOR EACH STATEMENT
    EXECUTE FUNCTION "core"."autoagent_trial_ledger_reject_mutation"();

CREATE OR REPLACE FUNCTION "core"."autoagent_cycle_verdicts_reject_mutation"()
    RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'core.autoagent_cycle_verdicts is append-only: % rejected', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER "autoagent_cycle_verdicts_append_only"
    BEFORE UPDATE OR DELETE OR TRUNCATE ON "core"."autoagent_cycle_verdicts"
    FOR EACH STATEMENT
    EXECUTE FUNCTION "core"."autoagent_cycle_verdicts_reject_mutation"();
