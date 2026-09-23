-- Replace the three-column unique on core.autoagent_loop_events with two predicate-bearing
-- partial uniques: a census row keeps its (event_ts, agent, cause) key, and a verdict row keys
-- on (event_ts, agent, subject) so a re-adjudication supersedes rather than accumulates.
-- The old key expressed neither class — verdict rows sharing a cause collided, and a corrected
-- verdict carrying a NEW cause did not collide with the row it replaces.
-- No row data is touched, so every pre-existing row keeps subject NULL and stays census class —
-- a later verdict row for the same proposal lands beside it rather than superseding it — and
-- IF [NOT] EXISTS keeps a re-run, or a future pre-release re-squash folding these objects into
-- the init CREATE TABLE, a no-op.

-- Lock posture: Prisma Migrate wraps the file in ONE transaction, so ACCESS EXCLUSIVE is taken
-- at this first ALTER and held to COMMIT. The blocking window, not the row count, is what
-- matters — deploy outside 04:00-05:30 KST. CONCURRENTLY is deliberately NOT used and must not
-- be added: it cannot run inside a transaction block, so it would abort the updater's
-- non-interactive migrate-deploy step rather than improve it.
--
-- Identity token of the subject a verdict adjudicates; NULL means census class.
-- VARCHAR(128) mirrors the table's VARCHAR idiom (agent 64, eval_result 32) and bounds an
-- IDENTITY token, not a label: a free-form description reaching this column would make every
-- re-adjudication a new row instead of a supersede.
ALTER TABLE "core"."autoagent_loop_events"
    ADD COLUMN IF NOT EXISTS "subject" VARCHAR(128);

-- Stamps INSERTION and nothing else: the writer's DO UPDATE arms omit this column
-- (scripts/_pg_dual_write_daemon.py -> _get_loop_event_conflict_arm), so it is CONSTANT across a
-- supersede -- a correction overwrites the verdict row in place, the original instant survives,
-- and no column here records when the correction landed.
-- Backfill stamps every pre-existing row with the one migration instant, so those rows carry no
-- ordering in this column and `id` stays their only history -- which is why the loop-event read
-- orders on id rather than on inserted_at.
-- NOT NULL with a stable default rather than nullable: every row has an insertion instant, and a
-- NULL would only ever mean "written before this column existed", which the default stamps.
ALTER TABLE "core"."autoagent_loop_events"
    ADD COLUMN IF NOT EXISTS "inserted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

-- The three-column unique from 20260611000000_init_squashed — a plain unique INDEX created by
-- @@unique, not a table CONSTRAINT, so DROP INDEX rather than ALTER TABLE DROP CONSTRAINT.
DROP INDEX IF EXISTS "core"."autoagent_loop_events_dedup";

-- Raw-SQL partial indexes because the Prisma schema cannot declare a predicate, so the model
-- drops its @@unique: declaring it there would make `prisma migrate diff` collapse both
-- predicates into one full index, the wrong key for both classes. Same treatment
-- 20260718000000_restore_squash_lost_partial_indexes gives its five.
-- These two WHERE clauses are the SQL-side defining site of the split: the writer's ON CONFLICT
-- arms compose from ONE Python constant in scripts/_pg_dual_write_daemon.py and the stand-in
-- reads its index DDL from THIS file, so a drift between them reds the identity pin.

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
