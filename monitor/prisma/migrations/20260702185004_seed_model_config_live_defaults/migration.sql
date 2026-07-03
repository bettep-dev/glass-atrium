-- Forward data-only migration: converge fresh-install monitor.model_config seeds to live
-- defaults + decommission the model.orchestrator domain.
--
-- Rationale
--   A fresh install seeds monitor.model_config from the applied migrations (there is no prisma
--   seed hook and no server-boot auto-seed), so the applied seeds are the sole source of the
--   shipped defaults. Three seeded keys converge to the current verified live values, and
--   one is actively broken on current code: model.research still seeds the bare alias
--   'sonnet', which is in REJECTED_ALIAS_VALUES (model-config-consts.ts) — a PUT restore of it
--   400s — and it mismatches the shipped agents/intel-researcher.md frontmatter
--   (model: claude-sonnet-5). A fresh install is therefore in day-1 drift. The
--   model.orchestrator domain is decommissioned entirely: the main-session model resolves
--   per-session from settings.json, so a display-only DB row (editable: false, no PUT write
--   surface) can never drive anything — the row is deleted and the server/client code paths
--   are removed with it. Editing the applied seed migrations is unsafe
--   (prisma migrate deploy validates applied-migration checksums, oss-db-setup.sh:34-36), so the
--   correction is a new forward data-only migration, mirroring the 20260613120000 rework precedent.
--
-- Row-safety invariant
--   Each UPDATE is guarded, touching ONLY rows that still carry BOTH the exact old seed value
--   AND updated_by = 'seed'. Fresh-install rows match (just written by the seed migration,
--   untouched) and converge. Any row a user changed through the monitor web UI carries
--   updated_by = 'monitor-web' (and/or a different value), so the guard skips it — the UPDATEs
--   are a no-op on customized installs and on any row already at the live value (0 rows changed).
--   updated_at is set explicitly: its column DEFAULT fires only on INSERT, never on UPDATE.
--   The model.orchestrator DELETE is deliberately UNGUARDED (config_key predicate only): the
--   domain is decommissioned, so ANY residual row — seed-written or user-edited — is
--   unreachable dead data no surviving code path reads (precedent: the 20260613120000 rework's
--   unconditional removal of the decommissioned limit.* keys).
--
-- Rollback note
--   There is no down-migration (Prisma is forward-only). Reverting means a further forward
--   migration that restores the prior seed values under the same value + updated_by = 'seed'
--   guard (budget.*_max_usd -> '0.50', model.research -> 'sonnet') and, for model.orchestrator,
--   re-INSERTs the row AND restores the removed server/client code paths — the domain is gone
--   from the code surface, not just the data. This project ships no rollback runbook file — do
--   not reference one.

UPDATE "monitor"."model_config"
SET config_value = '10.00', updated_at = CURRENT_TIMESTAMP, updated_by = 'seed'
WHERE config_key = 'budget.haiku_max_usd' AND config_value = '0.50' AND updated_by = 'seed';

UPDATE "monitor"."model_config"
SET config_value = '10.00', updated_at = CURRENT_TIMESTAMP, updated_by = 'seed'
WHERE config_key = 'budget.pre_verify_max_usd' AND config_value = '0.50' AND updated_by = 'seed';

DELETE FROM "monitor"."model_config"
WHERE config_key = 'model.orchestrator';

UPDATE "monitor"."model_config"
SET config_value = 'claude-sonnet-5', updated_at = CURRENT_TIMESTAMP, updated_by = 'seed'
WHERE config_key = 'model.research' AND config_value = 'sonnet' AND updated_by = 'seed';
