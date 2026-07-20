-- Seed monitor.model_config defaults for the two new per-domain targets model.meta + model.wiki.
--
-- Mirrors the model.research seed row (init_squashed appendix, migration.sql L661): concrete-id
-- default claude-sonnet-5 (never a bare alias — REJECTED_ALIAS_VALUES), updated_by 'seed'.
--
-- One carrier, both coverage surfaces (D2 R1): a FRESH DB runs the full chain (init_squashed +
-- this migration → both rows present), an EXISTING DB runs only this pending migration (rows
-- added, deploy exit 0). ON CONFLICT DO NOTHING keeps a re-run — and any operator-saved value —
-- a no-op, so a user Save is never overwritten.
--
-- The applied init_squashed appendix stays untouched (migrate deploy checksum-verifies applied
-- migrations); folding these rows into that appendix is deferred to the next pre-release
-- re-squash per the L655 folding convention. Rollback = DELETE the two 'seed'-owned rows.
INSERT INTO "monitor"."model_config" ("config_key", "config_value", "updated_by") VALUES
    ('model.meta',  'claude-sonnet-5',    'seed'),
    ('model.wiki',  'claude-sonnet-5',    'seed')
ON CONFLICT ("config_key") DO NOTHING;
