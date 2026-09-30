-- Add effort + has_mixed_effort to core.outcomes and core.cost_events — plan clauded-docs/39913 stream 2.
-- effort: last non-null `effort` on the transcript's assistant records, in transcript order.
-- On outcomes → the subagent's own tier, read at SubagentStop.
-- On cost_events → the turn's or agent file's tier, recorded beside model.
-- has_mixed_effort: TRUE when those records held more than one distinct tier.
--
-- NULLABLE with no default → fail-open: NULL = no assistant record carried the field, or a pre-carrier row.
-- has_mixed_effort is NULL whenever effort is NULL; FALSE = exactly one distinct tier.
-- VARCHAR(16) with no enum and no CHECK → the tier vocabulary is the harness's, and an unseen value never rejects a row.
-- No index → no route predicates on either column yet; add one only on EXPLAIN evidence.
-- NO backfill → re-labelling recorded history is a database mutation requiring an explicit user decision.
--
-- Lock posture: nullable ADD COLUMN without a default is catalog-only on PG 11+ (no table rewrite).
-- ACCESS EXCLUSIVE on each table is therefore held for microseconds.
--
-- Reversal (1:1 per column; drops only the recorded tier values):
--   ALTER TABLE "core"."outcomes" DROP COLUMN "effort", DROP COLUMN "has_mixed_effort";
--   ALTER TABLE "core"."cost_events" DROP COLUMN "effort", DROP COLUMN "has_mixed_effort";
-- IF NOT EXISTS keeps a re-run, and a future pre-release re-squash into the init CREATE TABLE, a no-op.
ALTER TABLE "core"."outcomes"
    ADD COLUMN IF NOT EXISTS "effort" VARCHAR(16),
    ADD COLUMN IF NOT EXISTS "has_mixed_effort" BOOLEAN;

ALTER TABLE "core"."cost_events"
    ADD COLUMN IF NOT EXISTS "effort" VARCHAR(16),
    ADD COLUMN IF NOT EXISTS "has_mixed_effort" BOOLEAN;
