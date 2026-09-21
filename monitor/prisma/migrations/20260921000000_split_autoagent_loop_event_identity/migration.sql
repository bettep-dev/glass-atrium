-- Split core.autoagent_loop_events identity into two classes so a corrected per-subject
-- verdict supersedes the verdict it corrects, while the per-cycle recurrence census keeps
-- behaving exactly as it does today.
--
-- Census class (subject absent): one row per (date, agent, cause) — the existing semantics
-- and the existing key. Verdict class (subject present): one row per (date, agent, subject),
-- so a re-adjudication of the SAME subject overwrites its predecessor instead of
-- accumulating a stale row beside it.
--
-- The old three-column unique carries neither cleanly: two verdict rows sharing date, agent
-- and cause with different subjects collide under it, and a corrected verdict carrying a new
-- cause does not collide with the stale one it replaces. So the index OBJECT is replaced.
--
-- Kept as raw-SQL PARTIAL unique indexes because Prisma 7 schema cannot declare
-- partial-index predicates → migration raw SQL only. The model therefore drops its @@unique
-- declaration: declaring it as a plain @@unique would cause prisma migrate diff to drop both
-- predicates and recreate one full index, which is the wrong key for both classes. Same
-- treatment 20260718000000_restore_squash_lost_partial_indexes gives its five.
--
-- Predicate authority: the two WHERE clauses below are the SQL-side defining site of the
-- class split. Nothing shares a literal across the SQL/Python boundary at apply time, so the
-- writer's two ON CONFLICT ... WHERE arms compose from ONE Python constant in
-- scripts/_pg_dual_write_daemon.py, and the stand-in reads THIS file's index DDL rather than
-- a hand tuple — a drift between the two predicates reds the identity pin on a row count.
--
-- Lock posture: Prisma Migrate wraps each migration file in ONE transaction on PostgreSQL,
-- so the strictest lock any statement below takes is acquired at the first ALTER and held to
-- COMMIT — ACCESS EXCLUSIVE on core.autoagent_loop_events for the whole file. At 5153 rows
-- the rewrite and both index builds are sub-second; the blocking window is what matters, so
-- deploy outside 04:00-05:30 KST. CONCURRENTLY is deliberately NOT used and must not be
-- added: it cannot run inside a transaction block, so it would abort the updater's
-- non-interactive migrate-deploy step rather than improve it.
--
-- No row data is touched. inserted_at stamps every pre-existing row with the migration
-- instant; `id` remains the only true insertion history for rows written before this file.
--
-- IF NOT EXISTS / IF EXISTS keep a re-run — and a future pre-release re-squash folding these
-- objects into the init CREATE TABLE — a no-op. The applied init_squashed migration stays
-- untouched (migrate deploy checksum-verifies applied migrations).

-- Identity token of the subject a verdict adjudicates; NULL means census class.
-- VARCHAR(128) mirrors the table's VARCHAR idiom (agent 64, eval_result 32) and bounds an
-- IDENTITY token, not a label: a free-form description reaching this column would make every
-- re-adjudication a new row instead of a supersede.
ALTER TABLE "core"."autoagent_loop_events"
    ADD COLUMN IF NOT EXISTS "subject" VARCHAR(128);

-- Insertion instant, so a superseded verdict's replacement stays distinguishable in time once
-- the row itself is overwritten in place. NOT NULL with a stable default rather than nullable:
-- every row has an insertion instant, and a NULL would only ever mean "written before this
-- column existed", which the default already stamps uniformly.
ALTER TABLE "core"."autoagent_loop_events"
    ADD COLUMN IF NOT EXISTS "inserted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

-- The three-column unique from 20260611000000_init_squashed — a plain unique INDEX created by
-- @@unique, not a table CONSTRAINT, so DROP INDEX rather than ALTER TABLE DROP CONSTRAINT.
DROP INDEX IF EXISTS "core"."autoagent_loop_events_dedup";

-- Census arm: unchanged key, now scoped to the class it always described.
CREATE UNIQUE INDEX IF NOT EXISTS "autoagent_loop_events_census_dedup"
    ON "core"."autoagent_loop_events" ("event_ts", "agent", "eval_result")
    WHERE "subject" IS NULL;

-- Verdict arm: the cause token leaves the key, so a correction carrying a new cause supersedes
-- the row it corrects instead of landing beside it.
CREATE UNIQUE INDEX IF NOT EXISTS "autoagent_loop_events_verdict_dedup"
    ON "core"."autoagent_loop_events" ("event_ts", "agent", "subject")
    WHERE "subject" IS NOT NULL;

-- Reversal (stated here because Prisma keeps no down file — same treatment as
-- 20260802000000_add_daemon_status_apply_failed and 20260803000000_add_daemon_status_apply_unavailable).
--
-- Reversible ONLY while every subject is still NULL. Once verdict rows exist, rows sharing
-- (event_ts, agent, eval_result) block the three-column unique's re-creation, and the subject
-- that told them apart is exactly what the reverse would destroy — so the reverse REFUSES
-- rather than inventing a dedup rule nobody adjudicated. Dedup first, by hand, with the
-- subject still present to decide by.
--
-- The guard is sufficient: when it passes, every row is census class, and the census partial
-- unique has already enforced (event_ts, agent, eval_result) over exactly those rows, so the
-- three-column unique is re-creatable without a collision.
--
-- Run inside one transaction:
--   DO $$
--   BEGIN
--     IF EXISTS (SELECT 1 FROM "core"."autoagent_loop_events" WHERE "subject" IS NOT NULL) THEN
--       RAISE EXCEPTION 'verdict rows present - dedup by subject before reverting';
--     END IF;
--   END $$;
--   DROP INDEX IF EXISTS "core"."autoagent_loop_events_verdict_dedup";
--   DROP INDEX IF EXISTS "core"."autoagent_loop_events_census_dedup";
--   CREATE UNIQUE INDEX "autoagent_loop_events_dedup"
--     ON "core"."autoagent_loop_events" ("event_ts", "agent", "eval_result");
--   ALTER TABLE "core"."autoagent_loop_events" DROP COLUMN "inserted_at";
--   ALTER TABLE "core"."autoagent_loop_events" DROP COLUMN "subject";
