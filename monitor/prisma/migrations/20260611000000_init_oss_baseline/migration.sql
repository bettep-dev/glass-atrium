-- OSS fresh-install baseline — schema.prisma 전체를 단일 init 으로 재생성한 마이그레이션.
-- 사유: 과거 마이그레이션 묶음은 의도적으로 삭제됨(이력 정리) — fresh DB 는 본 baseline
--   하나로 현행 스키마에 도달한다. 기존(라이브) DB 는 install.sh 의 presence-probe 가
--   bootstrap 을 skip 하므로 영향 없음. 라이브 DB 에서 `install.sh db-setup` 을 직접 실행할
--   때만 1회 `prisma migrate resolve --applied 20260611000000_init_oss_baseline` 필요.
-- 생성: `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
--   + 수기 부록(아래) — Prisma DSL 은 GENERATED tsvector 칼럼과 gin_trgm_ops /
--   gin_bigm_ops 인덱스를 표현하지 못함 (wiki_fts · clauded_doc_mgmt 부록 패턴 승계).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "core";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "monitor";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "wiki";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gin" WITH SCHEMA "wiki";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "wiki";

-- CreateEnum
CREATE TYPE "core"."DaemonType" AS ENUM ('autoagent', 'wiki', 'daily-restart', 'daily-restart-autoagent', 'daily-restart-wiki');

-- CreateEnum
CREATE TYPE "core"."DaemonStatus" AS ENUM ('ok', 'partial', 'error', 'missing', 'stale', 'quota_exceeded');

-- CreateEnum
CREATE TYPE "core"."CostGuardState" AS ENUM ('ok', 'warn', 'block');

-- CreateEnum
CREATE TYPE "core"."TaskType" AS ENUM ('bug-fix', 'feature', 'refactor', 'research', 'plan', 'review', 'diagnosis', 'doc', 'cleanup');

-- CreateEnum
CREATE TYPE "core"."GraderVerdict" AS ENUM ('verified_pass', 'unverified', 'verified_fail');

-- CreateEnum
CREATE TYPE "core"."DowngradeOrigin" AS ENUM ('writer_true_downgraded', 'writer_false', 'synthesized');

-- CreateEnum
CREATE TYPE "core"."OutcomeResult" AS ENUM ('done', 'done_with_concerns', 'blocked', 'needs_context', 'fail');

-- CreateEnum
CREATE TYPE "core"."Confidence" AS ENUM ('high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "core"."LearningStatus" AS ENUM ('identified', 'proposed', 'approved', 'applied', 'rejected');

-- CreateEnum
CREATE TYPE "core"."ApprovalTier" AS ENUM ('auto', 'llm', 'user-pending', 'user');

-- CreateEnum
CREATE TYPE "core"."ProposalClassification" AS ENUM ('apply', 'reject');

-- CreateEnum
CREATE TYPE "core"."ProposalStatus" AS ENUM ('pending', 'approved', 'rejected', 'applied', 'snoozed');

-- CreateEnum
CREATE TYPE "core"."HookErrorKind" AS ENUM ('connection_refused', 'timeout', 'constraint_violation', 'unknown');

-- CreateEnum
CREATE TYPE "monitor"."AuditResultCode" AS ENUM ('success', 'blocked', 'error');

-- CreateEnum
CREATE TYPE "monitor"."AutoagentDecision" AS ENUM ('approved', 'rejected', 'snoozed');

-- CreateEnum
CREATE TYPE "monitor"."DocStatus" AS ENUM ('progress', 'done');

-- CreateTable
CREATE TABLE "core"."cost_events" (
    "id" BIGSERIAL NOT NULL,
    "event_date" DATE NOT NULL,
    "event_time" TIME(6) NOT NULL,
    "session_id" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'turn',
    "dedup_key" TEXT,
    "input_tokens" BIGINT NOT NULL,
    "output_tokens" BIGINT NOT NULL,
    "cache_read_tokens" BIGINT NOT NULL,
    "cache_creation_tokens" BIGINT NOT NULL,
    "cost_usd" DECIMAL(12,6) NOT NULL,
    "duration_ms" BIGINT NOT NULL,
    "num_turns" INTEGER NOT NULL,
    "stop_reason" VARCHAR(64),
    "model" VARCHAR(128),
    "parse_error" BOOLEAN NOT NULL,
    "raw_input" VARCHAR(500),
    "inserted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."agent_events" (
    "id" BIGSERIAL NOT NULL,
    "event_ts" TIMESTAMPTZ(6) NOT NULL,
    "event_name" VARCHAR(64) NOT NULL,
    "agent_id" TEXT NOT NULL,
    "agent_type" VARCHAR(64) NOT NULL,

    CONSTRAINT "agent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."outcomes" (
    "id" BIGSERIAL NOT NULL,
    "record_ts" TIMESTAMPTZ(6) NOT NULL,
    "agent" VARCHAR(64) NOT NULL,
    "task_type" "core"."TaskType" NOT NULL,
    "result" "core"."OutcomeResult" NOT NULL,
    "confidence" "core"."Confidence",
    "metric_pass" BOOLEAN,
    "metric_type" VARCHAR(32),
    "revision_count" INTEGER NOT NULL DEFAULT 0,
    "evaluative_signal" INTEGER,
    "directive_hint" TEXT,
    "lesson" TEXT,
    "concerns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "files_modified" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "correlation_id" VARCHAR(96),
    "cid" VARCHAR(96),
    "attribution_source" TEXT,
    "summary" TEXT NOT NULL,
    "review_flag" BOOLEAN NOT NULL DEFAULT false,
    "body_md" TEXT,
    "style_ref" TEXT,
    "style_ref_verified" BOOLEAN,
    "baseline_pre_3tier" BOOLEAN,
    "grader_verdict" "core"."GraderVerdict",
    "downgrade_origin" "core"."DowngradeOrigin",
    "poisoned_window" BOOLEAN NOT NULL DEFAULT false,
    "inserted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."correction_signals" (
    "id" BIGSERIAL NOT NULL,
    "event_ts" TIMESTAMPTZ(6) NOT NULL,
    "task_type" VARCHAR(32) NOT NULL,
    "stage1_matched" BOOLEAN NOT NULL,
    "stage2_matched" BOOLEAN NOT NULL,
    "final_detected" BOOLEAN NOT NULL,
    "revision_count_delta" INTEGER NOT NULL,
    "outcome_id" BIGINT,

    CONSTRAINT "correction_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."learning_log" (
    "id" BIGSERIAL NOT NULL,
    "discovered_date" DATE NOT NULL,
    "pattern_signature" TEXT NOT NULL,
    "frequency" INTEGER NOT NULL,
    "agent" VARCHAR(64),
    "status" "core"."LearningStatus" NOT NULL,
    "approval_tier" "core"."ApprovalTier" NOT NULL,
    "last_updated" TIMESTAMPTZ(6) NOT NULL,
    "last_transition_at" TIMESTAMPTZ(6),
    "last_transition_reason" VARCHAR(500),

    CONSTRAINT "learning_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."daemon_runs" (
    "run_date" DATE NOT NULL,
    "daemon_name" "core"."DaemonType" NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "status" "core"."DaemonStatus" NOT NULL,
    "cost_guard_state" "core"."CostGuardState",
    "patches_count" INTEGER,
    "patches_apply_count" INTEGER,
    "patches_reject_count" INTEGER,
    "deadlinks_count" INTEGER,
    "dedup_count" INTEGER,
    "compiled_count" INTEGER,
    "compiled_total" INTEGER,
    "compile_ms" BIGINT,
    "notes" TEXT,
    "inserted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daemon_runs_pkey" PRIMARY KEY ("run_date","daemon_name")
);

-- CreateTable
CREATE TABLE "core"."daemon_run_payload" (
    "run_date" DATE NOT NULL,
    "daemon_name" "core"."DaemonType" NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_size_bytes" INTEGER NOT NULL,

    CONSTRAINT "daemon_run_payload_pkey" PRIMARY KEY ("run_date","daemon_name")
);

-- CreateTable
CREATE TABLE "core"."autoagent_proposals" (
    "id" BIGSERIAL NOT NULL,
    "cycle_date" DATE NOT NULL,
    "pattern_label" VARCHAR(128) NOT NULL,
    "target_file" TEXT NOT NULL,
    "target_agent" VARCHAR(64),
    "classification" "core"."ProposalClassification" NOT NULL,
    "rationale" TEXT,
    "haiku_status" VARCHAR(32),
    "approval_tier" "core"."ApprovalTier" NOT NULL,
    "status" "core"."ProposalStatus" NOT NULL,
    "proposed_diff" TEXT,
    "cost_guard_state" VARCHAR(16),
    "reviewed_at" TIMESTAMPTZ(6),
    "reviewed_by" VARCHAR(64),
    "audit_log_id" BIGINT,
    "source_file" TEXT NOT NULL,
    "source_file_mtime" BIGINT NOT NULL,
    "indexed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pre_verify_passed" BOOLEAN,
    "pre_verify_status" VARCHAR(64),
    "pre_verify_rationale" TEXT,
    "pre_verify_axes" JSONB,
    "confidence_observed" REAL,
    "project_key" TEXT,
    "promotion_tier" TEXT,
    "stale_attempt_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "autoagent_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."autoagent_loop_events" (
    "id" BIGSERIAL NOT NULL,
    "event_ts" TIMESTAMPTZ(6) NOT NULL,
    "agent" VARCHAR(64) NOT NULL,
    "rice" DECIMAL(8,3),
    "eval_result" VARCHAR(32) NOT NULL,
    "changes_added" INTEGER NOT NULL,
    "changes_removed" INTEGER NOT NULL,

    CONSTRAINT "autoagent_loop_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."audit_queue" (
    "id" BIGSERIAL NOT NULL,
    "excluded_path" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "excluded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."locks" (
    "lock_name" VARCHAR(128) NOT NULL,
    "acquired_at" TIMESTAMPTZ(6) NOT NULL,
    "holder" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "locks_pkey" PRIMARY KEY ("lock_name")
);

-- CreateTable
CREATE TABLE "core"."aggregator_state" (
    "name" VARCHAR(64) NOT NULL,
    "last_processed_ts" TIMESTAMPTZ(6) NOT NULL,
    "lag_seconds" INTEGER,

    CONSTRAINT "aggregator_state_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "core"."hook_failures" (
    "id" BIGSERIAL NOT NULL,
    "failure_ts" TIMESTAMPTZ(6) NOT NULL,
    "hook_name" VARCHAR(64) NOT NULL,
    "target_table" VARCHAR(96) NOT NULL,
    "error_kind" "core"."HookErrorKind" NOT NULL,
    "payload_ref" VARCHAR(128),
    "retry_attempted" BOOLEAN NOT NULL,

    CONSTRAINT "hook_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wiki"."notes" (
    "id" BIGSERIAL NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "tags" TEXT NOT NULL,
    "note_type" VARCHAR(64) NOT NULL,
    "source_url" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "mtime" BIGINT NOT NULL,
    "indexed_at" BIGINT NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wiki"."dirty_flag" (
    "id" INTEGER NOT NULL,
    "dirty" BOOLEAN NOT NULL,
    "last_dirty" BIGINT NOT NULL,

    CONSTRAINT "dirty_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor"."audit_log" (
    "id" BIGSERIAL NOT NULL,
    "event_ts" TIMESTAMPTZ(6) NOT NULL,
    "actor" VARCHAR(64) NOT NULL,
    "action_kind" VARCHAR(64) NOT NULL,
    "target_table" VARCHAR(96),
    "target_id" BIGINT,
    "payload" JSONB,
    "result_code" "monitor"."AuditResultCode" NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor"."audit_log_archive" (
    "id" BIGSERIAL NOT NULL,
    "event_ts" TIMESTAMPTZ(6) NOT NULL,
    "actor" VARCHAR(64) NOT NULL,
    "action_kind" VARCHAR(64) NOT NULL,
    "target_table" VARCHAR(96),
    "target_id" BIGINT,
    "payload" JSONB,
    "result_code" "monitor"."AuditResultCode" NOT NULL,
    "archived_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_log_archive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor"."autoagent_decisions" (
    "id" BIGSERIAL NOT NULL,
    "proposal_id" BIGINT NOT NULL,
    "decision" "monitor"."AutoagentDecision" NOT NULL,
    "reviewed_at" TIMESTAMPTZ(6) NOT NULL,
    "reviewed_by" VARCHAR(64) NOT NULL,
    "audit_log_id" BIGINT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "autoagent_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor"."documents" (
    "id" BIGSERIAL NOT NULL,
    "legacy_prefix" TEXT,
    "title" TEXT NOT NULL,
    "author" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "html_path" TEXT NOT NULL,
    "md_copy_path" TEXT,
    "indexable_text" TEXT NOT NULL,
    "last_synced_at" TIMESTAMPTZ(6),
    "audience" VARCHAR(16),
    "inserted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedes_id" BIGINT,
    "doc_status" "monitor"."DocStatus" NOT NULL DEFAULT 'progress',
    "folder_id" BIGINT,
    "display_order" INTEGER,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."skill_activations" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" VARCHAR(32) NOT NULL,
    "agent_name" VARCHAR(64),
    "trigger_phrase" TEXT,
    "selected" BOOLEAN NOT NULL,
    "match_score" DECIMAL(4,3),
    "cid" VARCHAR(96),
    "metadata" JSONB,

    CONSTRAINT "skill_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."api_response_metrics" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "route" VARCHAR(96) NOT NULL,
    "level" INTEGER,
    "response_bytes" INTEGER NOT NULL,
    "response_tokens_estimate" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "status_code" INTEGER NOT NULL,
    "cid" VARCHAR(96),
    "metadata" JSONB,

    CONSTRAINT "api_response_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cost_events_date_time_idx" ON "core"."cost_events"("event_date", "event_time");

-- CreateIndex
CREATE INDEX "cost_events_session_idx" ON "core"."cost_events"("session_id");

-- CreateIndex
CREATE INDEX "cost_events_model_idx" ON "core"."cost_events"("model");

-- CreateIndex
CREATE UNIQUE INDEX "cost_events_session_dedup_key" ON "core"."cost_events"("session_id", "dedup_key");

-- CreateIndex
CREATE INDEX "agent_events_ts_idx" ON "core"."agent_events"("event_ts");

-- CreateIndex
CREATE INDEX "agent_events_type_ts_idx" ON "core"."agent_events"("agent_type", "event_ts");

-- CreateIndex
CREATE UNIQUE INDEX "agent_events_dedup" ON "core"."agent_events"("event_ts", "agent_id", "event_name");

-- CreateIndex
CREATE INDEX "outcomes_ts_idx" ON "core"."outcomes"("record_ts");

-- CreateIndex
CREATE INDEX "outcomes_agent_ts_idx" ON "core"."outcomes"("agent", "record_ts");

-- CreateIndex
CREATE INDEX "outcomes_task_ts_idx" ON "core"."outcomes"("task_type", "record_ts");

-- CreateIndex
CREATE INDEX "outcomes_review_flag_idx" ON "core"."outcomes"("review_flag");

-- CreateIndex
CREATE UNIQUE INDEX "outcomes_dedup" ON "core"."outcomes"("record_ts", "agent", "task_type");

-- CreateIndex
CREATE INDEX "correction_signals_ts_idx" ON "core"."correction_signals"("event_ts");

-- CreateIndex
CREATE INDEX "correction_signals_outcome_idx" ON "core"."correction_signals"("outcome_id");

-- CreateIndex
CREATE UNIQUE INDEX "correction_signals_dedup" ON "core"."correction_signals"("event_ts", "task_type", "outcome_id");

-- CreateIndex
CREATE INDEX "learning_log_date_idx" ON "core"."learning_log"("discovered_date");

-- CreateIndex
CREATE INDEX "learning_log_status_tier_idx" ON "core"."learning_log"("status", "approval_tier");

-- CreateIndex
CREATE INDEX "learning_log_status_transition_idx" ON "core"."learning_log"("status", "last_transition_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "learning_log_pattern_uniq" ON "core"."learning_log"("pattern_signature");

-- CreateIndex
CREATE INDEX "daemon_runs_name_date_idx" ON "core"."daemon_runs"("daemon_name", "run_date" DESC);

-- CreateIndex
CREATE INDEX "daemon_runs_status_date_idx" ON "core"."daemon_runs"("status", "run_date" DESC);

-- CreateIndex
CREATE INDEX "autoagent_proposals_cycle_idx" ON "core"."autoagent_proposals"("cycle_date");

-- CreateIndex
CREATE INDEX "autoagent_proposals_status_tier_idx" ON "core"."autoagent_proposals"("status", "approval_tier");

-- CreateIndex
CREATE INDEX "autoagent_proposals_agent_cycle_idx" ON "core"."autoagent_proposals"("target_agent", "cycle_date");

-- CreateIndex
CREATE UNIQUE INDEX "autoagent_proposals_cycle_pattern_target_key" ON "core"."autoagent_proposals"("cycle_date", "pattern_label", "target_file");

-- CreateIndex
CREATE INDEX "autoagent_loop_events_ts_idx" ON "core"."autoagent_loop_events"("event_ts");

-- CreateIndex
CREATE INDEX "autoagent_loop_events_agent_ts_idx" ON "core"."autoagent_loop_events"("agent", "event_ts");

-- CreateIndex
CREATE UNIQUE INDEX "autoagent_loop_events_dedup" ON "core"."autoagent_loop_events"("event_ts", "agent", "eval_result");

-- CreateIndex
CREATE INDEX "audit_queue_ts_idx" ON "core"."audit_queue"("excluded_at");

-- CreateIndex
CREATE INDEX "hook_failures_ts_idx" ON "core"."hook_failures"("failure_ts");

-- CreateIndex
CREATE INDEX "hook_failures_hook_ts_idx" ON "core"."hook_failures"("hook_name", "failure_ts");

-- CreateIndex
CREATE UNIQUE INDEX "notes_path_key" ON "wiki"."notes"("path");

-- CreateIndex
CREATE INDEX "notes_type_idx" ON "wiki"."notes"("note_type");

-- CreateIndex
CREATE INDEX "notes_tags_idx" ON "wiki"."notes"("tags");

-- CreateIndex
CREATE INDEX "notes_mtime_idx" ON "wiki"."notes"("mtime");

-- CreateIndex
CREATE INDEX "audit_log_ts_idx" ON "monitor"."audit_log"("event_ts");

-- CreateIndex
CREATE INDEX "audit_log_actor_ts_idx" ON "monitor"."audit_log"("actor", "event_ts");

-- CreateIndex
CREATE INDEX "audit_log_action_ts_idx" ON "monitor"."audit_log"("action_kind", "event_ts");

-- CreateIndex
CREATE INDEX "audit_log_archive_archived_at_idx" ON "monitor"."audit_log_archive"("archived_at");

-- CreateIndex
CREATE INDEX "audit_log_archive_event_ts_idx" ON "monitor"."audit_log_archive"("event_ts");

-- CreateIndex
CREATE INDEX "autoagent_decisions_proposal_idx" ON "monitor"."autoagent_decisions"("proposal_id");

-- CreateIndex
CREATE INDEX "autoagent_decisions_reviewed_at_idx" ON "monitor"."autoagent_decisions"("reviewed_at" DESC);

-- CreateIndex
CREATE INDEX "monitor_documents_created_idx" ON "monitor"."documents"("created_at" DESC);

-- CreateIndex
CREATE INDEX "monitor_documents_author_created_idx" ON "monitor"."documents"("author", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "monitor_documents_hash_uniq" ON "monitor"."documents"("content_hash");

-- CreateIndex
CREATE INDEX "skill_activations_ts_idx" ON "core"."skill_activations"("occurred_at");

-- CreateIndex
CREATE INDEX "skill_activations_agent_ts_idx" ON "core"."skill_activations"("agent_name", "occurred_at");

-- CreateIndex
CREATE INDEX "skill_activations_selected_ts_idx" ON "core"."skill_activations"("selected", "occurred_at");

-- CreateIndex
CREATE INDEX "api_response_metrics_route_ts_idx" ON "core"."api_response_metrics"("route", "occurred_at");

-- CreateIndex
CREATE INDEX "api_response_metrics_level_route_idx" ON "core"."api_response_metrics"("level", "route");

-- AddForeignKey
ALTER TABLE "core"."correction_signals" ADD CONSTRAINT "correction_signals_outcome_id_fkey" FOREIGN KEY ("outcome_id") REFERENCES "core"."outcomes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."daemon_run_payload" ADD CONSTRAINT "daemon_run_payload_run_date_daemon_name_fkey" FOREIGN KEY ("run_date", "daemon_name") REFERENCES "core"."daemon_runs"("run_date", "daemon_name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor"."autoagent_decisions" ADD CONSTRAINT "autoagent_decisions_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "core"."autoagent_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor"."documents" ADD CONSTRAINT "documents_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "monitor"."documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor"."documents" ADD CONSTRAINT "documents_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "monitor"."documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ----------------------------------------------------------------------------
-- Raw SQL appendix 1 — wiki FTS: GENERATED tsvector + GIN/trgm 인덱스
-- 가중치(BM25 근사): title = A(1.0) > tags = B(0.4) > content = C(0.2)
-- ----------------------------------------------------------------------------
ALTER TABLE wiki.notes
  ADD COLUMN ts tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(tags, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'C')
  ) STORED;

CREATE INDEX notes_ts_gin ON wiki.notes USING GIN (ts);

-- pg_trgm GIN — CJK trigram 부분일치 (similarity()/word_similarity())
CREATE INDEX notes_title_trgm   ON wiki.notes USING GIN (title   wiki.gin_trgm_ops);
CREATE INDEX notes_tags_trgm    ON wiki.notes USING GIN (tags    wiki.gin_trgm_ops);
CREATE INDEX notes_content_trgm ON wiki.notes USING GIN (content wiki.gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- Raw SQL appendix 2 — monitor.documents FTS: GENERATED tsvector + GIN/trgm
-- 가중치: title = A > author = B > indexable_text = C
-- gin_trgm_ops 는 wiki 스키마 설치본 재사용 (pg_trgm 은 DB 당 단일 설치)
-- ----------------------------------------------------------------------------
ALTER TABLE "monitor"."documents"
  ADD COLUMN "ts" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("author", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("indexable_text", '')), 'C')
  ) STORED;

CREATE INDEX "monitor_documents_ts_gin" ON "monitor"."documents" USING GIN ("ts");
CREATE INDEX "monitor_documents_title_trgm" ON "monitor"."documents" USING GIN ("title" wiki.gin_trgm_ops);
CREATE INDEX "monitor_documents_indexable_text_trgm" ON "monitor"."documents" USING GIN ("indexable_text" wiki.gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- Raw SQL appendix 3 — pg_bigm (선택적 호스트 확장): 한국어 bigram 부분일치
-- 호스트 미설치 시 NOTICE 만 남기고 skip — 라우트 레이어가 tsvector 단독으로 fallback
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_bigm WITH SCHEMA monitor;
  RAISE NOTICE 'pg_bigm extension ready in schema monitor';
EXCEPTION
  WHEN feature_not_supported THEN
    RAISE NOTICE 'pg_bigm not available — Korean substring search falls back to tsvector-only path';
  WHEN undefined_file THEN
    RAISE NOTICE 'pg_bigm shared library missing — install pg_bigm then re-run to backfill the bigm index';
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_bigm install failed (SQLSTATE=%, message=%) — bigm index skipped', SQLSTATE, SQLERRM;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_bigm') THEN
    CREATE INDEX IF NOT EXISTS "ClaudedDoc_indexable_text_bigm_idx"
      ON monitor."documents"
      USING gin (indexable_text monitor.gin_bigm_ops);
  ELSE
    RAISE NOTICE 'Skipping ClaudedDoc_indexable_text_bigm_idx — pg_bigm not present';
  END IF;
END
$$;
