-- Retire the haiku-named monitor.model_config keys in favour of role-named ones.
--
--   model.daemon_cycle_haiku -> model.daemon_cycle_worker
--   budget.haiku_max_usd     -> budget.worker_max_usd
--
-- WHY a new migration rather than an edit to the init_squashed appendix: `migrate
-- deploy` checksum-verifies ALREADY-APPLIED migrations, so editing that appendix
-- breaks every existing install. Same carrier pattern as
-- 20260720000000_seed_meta_wiki_model_domains: a FRESH DB runs the whole chain
-- (init_squashed seeds the old keys, this migration renames them), an EXISTING DB
-- runs only this pending migration. Folding the result back into the appendix is
-- deferred to the next pre-release re-squash, per the L655 folding convention.
--
-- VALUE POLICY, stated because the two keys are deliberately NOT treated alike:
--   * MODEL — an operator's saved non-haiku choice is carried forward verbatim;
--     a haiku id (including the stale init_squashed 'claude-haiku-4-5' seed) is
--     REWRITTEN to 'claude-sonnet-5'. Carrying a haiku id forward would rename the
--     key while leaving the loop running on the retired model, which is the one
--     outcome this migration exists to prevent.
--   * BUDGET — carried forward VERBATIM, always. A per-call cap is a spending
--     decision that belongs to the operator; a rename must not move it. The
--     ceiling's adequacy under the more expensive model is a separate, explicit
--     decision and is deliberately NOT made here.
--
-- Rollback: INSERT the two old keys back from the new ones and DELETE the new rows.

INSERT INTO "monitor"."model_config" ("config_key", "config_value", "updated_by")
SELECT
    'model.daemon_cycle_worker',
    CASE
        WHEN "config_value" LIKE 'claude-haiku%' OR "config_value" = 'haiku'
            THEN 'claude-sonnet-5'
        ELSE "config_value"
    END,
    "updated_by"
FROM "monitor"."model_config"
WHERE "config_key" = 'model.daemon_cycle_haiku'
ON CONFLICT ("config_key") DO NOTHING;

INSERT INTO "monitor"."model_config" ("config_key", "config_value", "updated_by")
SELECT 'budget.worker_max_usd', "config_value", "updated_by"
FROM "monitor"."model_config"
WHERE "config_key" = 'budget.haiku_max_usd'
ON CONFLICT ("config_key") DO NOTHING;

-- Floor for a DB that somehow carries neither source row (a hand-pruned install):
-- without these the renamed domains would be absent and the monitor would render
-- them as missing rather than defaulted.
INSERT INTO "monitor"."model_config" ("config_key", "config_value", "updated_by") VALUES
    ('model.daemon_cycle_worker', 'claude-sonnet-5', 'seed'),
    ('budget.worker_max_usd',     '10.00',           'seed')
ON CONFLICT ("config_key") DO NOTHING;

-- The old rows are now unread by every seam (model-config-consts.ts keys the
-- renamed ids), so leaving them would strand two rows the UI never shows.
DELETE FROM "monitor"."model_config"
WHERE "config_key" IN ('model.daemon_cycle_haiku', 'budget.haiku_max_usd');
