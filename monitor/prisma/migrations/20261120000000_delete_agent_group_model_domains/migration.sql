-- Agent models live in each agent file's own model line → the six agent-group rows have no reader and no writer.
DELETE FROM monitor.model_config
WHERE config_key IN ('model.dev', 'model.research', 'model.meta', 'model.wiki', 'model.review', 'model.docs');
