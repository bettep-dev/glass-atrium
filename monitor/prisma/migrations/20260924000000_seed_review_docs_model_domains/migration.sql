-- Seed monitor.model_config defaults for the two-file frontmatter domains model.review + model.docs.
--
-- 'inherit' = no `model:` key rendered → the four agents keep following the session model; none
-- carries a model key today, so the seed changes no spawn behaviour.
-- ON CONFLICT DO NOTHING keeps a re-run, and any operator-saved value, a no-op.
-- Rollback = DELETE the two 'seed'-owned rows.
INSERT INTO "monitor"."model_config" ("config_key", "config_value", "updated_by") VALUES
    ('model.review', 'inherit', 'seed'),
    ('model.docs',   'inherit', 'seed')
ON CONFLICT ("config_key") DO NOTHING;
