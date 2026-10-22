-- core.spawn_manifest: the canary exposure fields of each MANIFEST line — arm, salt id, delivered flag, delivered hash.
--
-- Additive only: every column NULLABLE with no default → a nullable ADD COLUMN is catalog-only on PG 11+ (no table rewrite).
-- delivered NULL = the line predates the fields; on a newer line a NULL arm / salt_id = none read, a NULL hash = not delivered.
-- No backfill → a pre-field line carries no exposure facts to recover.
-- No CHECK and no index → the ingest parser owns the value forms; no route predicate on them yet, add one on EXPLAIN evidence.
--
-- Reversal (drops every recorded exposure value):
--   ALTER TABLE "core"."spawn_manifest" DROP COLUMN "arm", DROP COLUMN "salt_id", DROP COLUMN "delivered", DROP COLUMN "delivered_hash";
-- IF NOT EXISTS keeps a re-run, and a future pre-release re-squash, a no-op.
ALTER TABLE "core"."spawn_manifest"
    ADD COLUMN IF NOT EXISTS "arm" SMALLINT,
    ADD COLUMN IF NOT EXISTS "salt_id" BIGINT,
    ADD COLUMN IF NOT EXISTS "delivered" BOOLEAN,
    ADD COLUMN IF NOT EXISTS "delivered_hash" VARCHAR(64);
