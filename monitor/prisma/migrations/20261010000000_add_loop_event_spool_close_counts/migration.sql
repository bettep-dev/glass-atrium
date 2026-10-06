-- core.autoagent_loop_events: the typed counts of a manifest-spool-closed row — MANIFEST lines read, and lines without a spawn_manifest row.
--
-- Additive only: both columns NULLABLE with no default → a nullable ADD COLUMN is catalog-only on PG 11+ (no table rewrite).
-- NULL = not a spool close, or a row written before the columns → a reader names it, never reads it as zero lost.
-- No backfill → a pre-column close row carries no count to recover.
-- No CHECK and no index → the writer owns the value forms; no reader predicate on them yet, add one on EXPLAIN evidence.
--
-- Reversal (drops every recorded close count):
--   ALTER TABLE "core"."autoagent_loop_events" DROP COLUMN "lines_read", DROP COLUMN "lines_without_row";
-- IF NOT EXISTS keeps a re-run, and a future pre-release re-squash, a no-op.
ALTER TABLE "core"."autoagent_loop_events"
    ADD COLUMN IF NOT EXISTS "lines_read" INTEGER,
    ADD COLUMN IF NOT EXISTS "lines_without_row" INTEGER;
