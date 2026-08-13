-- Add core.outcomes.grader_crosscheck — the four-value transcript Write/Edit cross-check state
-- that hooks/lib/code-based-grader.sh computes and then discards. grader_verdict collapses it
-- (na and verified both fall through to the files-evidence arm, withhold flattens into
-- unverified), and review_flag_reasons carries the contradiction verdict only, so the withheld
-- versus not-applicable split — the one distinction that separates "could not demonstrate
-- absence" from "cross-check inapplicable" — has no carrier at all today.
--
-- NULLABLE with no default, deliberately: NULL means the cross-check never ran on that row and
-- stays distinguishable from the recorded `na` token, which means it ran and was inapplicable.
--
-- NO backfill of historical rows: the state is derived from the subagent transcript, and an
-- outcome row carries no session or transcript key, so it is not recomputable from the database.
-- Re-labelling recorded history would be a mutation requiring an explicit user decision.
--
-- No index: no route predicates on the column — the aggregation consumer reads it by GROUP BY
-- over an already-bounded scan.
--
-- Lock posture: CREATE TYPE takes no table lock; ADD COLUMN without a default is catalog-only on
-- PG 11+ (no table rewrite), so ACCESS EXCLUSIVE is held for microseconds.
--
-- Reversal: ALTER TABLE "core"."outcomes" DROP COLUMN "grader_crosscheck";
--           DROP TYPE "core"."GraderCrosscheck";
-- The DO block and IF NOT EXISTS keep a re-run, and a future pre-release re-squash into the init
-- CREATE TABLE, a no-op (migrate deploy checksum-verifies applied migrations).
DO $$
BEGIN
    CREATE TYPE "core"."GraderCrosscheck" AS ENUM ('na', 'verified', 'contradicted', 'withhold');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "core"."outcomes" ADD COLUMN IF NOT EXISTS "grader_crosscheck" "core"."GraderCrosscheck";
