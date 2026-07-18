-- Restore 5 squash-lost partial indexes cited by schema.prisma / routes/improvement.ts /
-- routes/clauded-docs.ts but absent from 20260611000000_init_squashed. Without them a fresh
-- OSS install seq-scans the clauded-docs folder cascade + the improvement style_ref / 3-tier /
-- confidence window.
--
-- Kept as raw-SQL partial indexes because the Prisma DSL cannot express a WHERE predicate — a
-- plain @@index would make `migrate diff` drop the predicate and regenerate a full mostly-NULL
-- index. schema.prisma documents each one as "migration raw SQL only" for exactly this reason,
-- so the models intentionally omit the matching @@index declarations.
--
-- IF NOT EXISTS: idempotent against a live DB that manually pre-created any of these out-of-band.

-- improvement.ts style_ref 7-day per-agent rolling window (COUNT FILTER WHERE style_ref IS NOT NULL)
CREATE INDEX IF NOT EXISTS "outcomes_style_ref_agent_ts_idx"
    ON "core"."outcomes" ("agent", "record_ts" DESC)
    WHERE "style_ref" IS NOT NULL;

-- improvement.ts 3-tier baseline cohort split (pre_3tier_baseline_count reads the non-NULL cohort)
CREATE INDEX IF NOT EXISTS "outcomes_baseline_pre_3tier_idx"
    ON "core"."outcomes" ("baseline_pre_3tier")
    WHERE "baseline_pre_3tier" IS NOT NULL;

-- improvement.ts confidence_observed x promotion_tier distribution (AVG over the non-NULL lane)
CREATE INDEX IF NOT EXISTS "autoagent_proposals_confidence_idx"
    ON "core"."autoagent_proposals" ("confidence_observed")
    WHERE "confidence_observed" IS NOT NULL;

-- clauded-docs.ts handleUpdate folder cascade lightweight lookup (WHERE folder_id = $1)
CREATE INDEX IF NOT EXISTS "monitor_documents_folder_id_idx"
    ON "monitor"."documents" ("folder_id")
    WHERE "folder_id" IS NOT NULL;

-- clauded-docs.ts handleList group-page sort-aware covering (folder_id-scoped, created-desc order)
CREATE INDEX IF NOT EXISTS "monitor_documents_folder_created_idx"
    ON "monitor"."documents" ("folder_id", "created_at" DESC, "id" DESC)
    WHERE "folder_id" IS NOT NULL;
