-- Owner report / decision queue tables — plan clauded-docs/43944 S1.
-- monitor.queue_sessions: one row per registered Claude session (realpath cwd, derived worktree root, session marker).
-- monitor.queue_items: one report or decision per row; queue_position draws from the owned sequence
--   queue_items_queue_position_seq on insert, and Later sets nextval() on the same sequence → concurrent writers
--   never share a position.
-- monitor.queue_deliveries: one row per delivery attempt (socket frame, pull claim, automatic resume spawn).
-- monitor.queue_drift_checks: one bundle-check row per Claude Code version.
--
-- Items → session and deliveries → item are ON DELETE RESTRICT → pruning an exited session that still owns an item,
--   or deleting an item with a delivery record, fails loud instead of erasing the page record.
-- Indexes: the two FK indexes, the msg id and version unique keys, and the resume partial unique index only;
--   no other reader index yet → add one on EXPLAIN evidence.
--
-- Raw SQL the Prisma DSL cannot declare (below the generated DDL): the CHECKs and the resume partial unique index.
--   schema.prisma documents each one on its model → a migration squash MUST carry this SQL.
--   monitor/test/queue.schema.test.ts runs them against the migrated chain → a squash that drops one goes red.
--
-- Reversal (drops every queued item, delivery record, session row and drift check — irreversible data loss):
--   DROP TABLE "monitor"."queue_deliveries";
--   DROP TABLE "monitor"."queue_items";        -- takes queue_items_queue_position_seq with it
--   DROP TABLE "monitor"."queue_sessions";
--   DROP TABLE "monitor"."queue_drift_checks";
--   DROP TYPE "monitor"."QueueSessionState", "monitor"."QueueSessionExitReason", "monitor"."QueuePermissionHint",
--     "monitor"."QueueLaunchHint", "monitor"."QueueItemKind", "monitor"."QueueItemStatus",
--     "monitor"."QueueDeliveryRoute", "monitor"."QueueDeliveryResult", "monitor"."QueueDeliveryAbortReason",
--     "monitor"."QueueBundleResult", "monitor"."QueueCanaryResult";
-- Additive only: no existing table, column or type is touched.

-- CreateEnum
CREATE TYPE "monitor"."QueueSessionState" AS ENUM ('live', 'stale', 'exited');

-- CreateEnum
CREATE TYPE "monitor"."QueueSessionExitReason" AS ENUM ('ended', 'dead', 'replaced');

-- CreateEnum
CREATE TYPE "monitor"."QueuePermissionHint" AS ENUM ('default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan');

-- CreateEnum
CREATE TYPE "monitor"."QueueLaunchHint" AS ENUM ('accept_wrapper');

-- CreateEnum
CREATE TYPE "monitor"."QueueItemKind" AS ENUM ('report', 'decision');

-- CreateEnum
CREATE TYPE "monitor"."QueueItemStatus" AS ENUM ('open', 'answered', 'delivering', 'unacked', 'held', 'expired', 'resume_pending', 'delivered', 'seen', 'withdrawn');

-- CreateEnum
CREATE TYPE "monitor"."QueueDeliveryRoute" AS ENUM ('socket', 'resume', 'pull');

-- CreateEnum
CREATE TYPE "monitor"."QueueDeliveryResult" AS ENUM ('sent', 'held', 'expired', 'dead_socket', 'acked', 'failed', 'aborted');

-- CreateEnum
CREATE TYPE "monitor"."QueueDeliveryAbortReason" AS ENUM ('session_returned', 'shared_worktree');

-- CreateEnum
CREATE TYPE "monitor"."QueueBundleResult" AS ENUM ('pass', 'fail');

-- CreateEnum
CREATE TYPE "monitor"."QueueCanaryResult" AS ENUM ('pass', 'fail', 'inconclusive');

-- CreateTable
CREATE TABLE "monitor"."queue_sessions" (
    "session_id" UUID NOT NULL,
    "config_dir_set" BOOLEAN NOT NULL,
    "config_dir" TEXT,
    "profile_label" VARCHAR(64) NOT NULL,
    "cwd" TEXT NOT NULL,
    "worktree_root" TEXT,
    "pid" INTEGER NOT NULL,
    "process_start_time" VARCHAR(64) NOT NULL,
    "socket_path" TEXT,
    "permission_hint" "monitor"."QueuePermissionHint",
    "launch_hint" "monitor"."QueueLaunchHint",
    "state" "monitor"."QueueSessionState" NOT NULL,
    "exit_reason" "monitor"."QueueSessionExitReason",
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "resume_awaiting_register_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queue_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "monitor"."queue_items" (
    "id" BIGSERIAL NOT NULL,
    "kind" "monitor"."QueueItemKind" NOT NULL,
    "session_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "linked_doc_ids" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "options" JSONB,
    "recommended_code" VARCHAR(2),
    "free_text_allowed" BOOLEAN NOT NULL,
    "approval_class" BOOLEAN NOT NULL DEFAULT false,
    "status" "monitor"."QueueItemStatus" NOT NULL DEFAULT 'open',
    "queue_position" BIGSERIAL NOT NULL,
    "defer_count" INTEGER NOT NULL DEFAULT 0,
    "answer_code" VARCHAR(2),
    "answer_text" TEXT,
    "next_attempt" INTEGER NOT NULL DEFAULT 1,
    "asked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor"."queue_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "msg_id" UUID NOT NULL,
    "item_id" BIGINT NOT NULL,
    "route" "monitor"."QueueDeliveryRoute" NOT NULL,
    "attempt" INTEGER NOT NULL,
    "result" "monitor"."QueueDeliveryResult" NOT NULL,
    "abort_reason" "monitor"."QueueDeliveryAbortReason",
    "sent_at" TIMESTAMPTZ(6) NOT NULL,
    "ack_deadline_at" TIMESTAMPTZ(6) NOT NULL,
    "receipt_at" TIMESTAMPTZ(6),
    "bg_id" VARCHAR(64),

    CONSTRAINT "queue_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor"."queue_drift_checks" (
    "id" BIGSERIAL NOT NULL,
    "binary_realpath" TEXT NOT NULL,
    "binary_size" BIGINT NOT NULL,
    "binary_mtime" TIMESTAMPTZ(6) NOT NULL,
    "version" VARCHAR(64) NOT NULL,
    "bundle_result" "monitor"."QueueBundleResult" NOT NULL,
    "canary_result" "monitor"."QueueCanaryResult",
    "checked_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "queue_drift_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "queue_items_session_status_idx" ON "monitor"."queue_items"("session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "queue_deliveries_msg_id_key" ON "monitor"."queue_deliveries"("msg_id");

-- CreateIndex
CREATE INDEX "queue_deliveries_item_attempt_idx" ON "monitor"."queue_deliveries"("item_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "queue_drift_checks_version_key" ON "monitor"."queue_drift_checks"("version");

-- AddForeignKey
ALTER TABLE "monitor"."queue_items" ADD CONSTRAINT "queue_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "monitor"."queue_sessions"("session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "monitor"."queue_deliveries" ADD CONSTRAINT "queue_deliveries_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "monitor"."queue_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Raw SQL only — CHECKs (each nested CASE keeps a JSON function off a value it would raise on)
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE "monitor"."queue_sessions"
    -- path present only when CLAUDE_CONFIG_DIR was set
    ADD CONSTRAINT "queue_sessions_config_dir_check"
        CHECK ((("config_dir" IS NOT NULL) = "config_dir_set") AND ("config_dir" IS NULL OR "config_dir" ~ '^/')),
    ADD CONSTRAINT "queue_sessions_cwd_check" CHECK ("cwd" ~ '^/'),
    ADD CONSTRAINT "queue_sessions_worktree_root_check" CHECK ("worktree_root" ~ '^/'),
    ADD CONSTRAINT "queue_sessions_pid_check" CHECK ("pid" > 0),
    -- the sender connects to this path → confined to cc-socks/<registered pid>.sock
    ADD CONSTRAINT "queue_sessions_socket_path_check" CHECK (
        "socket_path" IN ('/tmp/cc-socks/' || "pid"::text || '.sock', '/private/tmp/cc-socks/' || "pid"::text || '.sock')
    ),
    ADD CONSTRAINT "queue_sessions_exit_reason_check" CHECK (("state" = 'exited') = ("exit_reason" IS NOT NULL)),
    ADD CONSTRAINT "queue_sessions_profile_label_check" CHECK ("profile_label" <> ''),
    ADD CONSTRAINT "queue_sessions_process_start_time_check" CHECK ("process_start_time" <> '');

ALTER TABLE "monitor"."queue_items"
    ADD CONSTRAINT "queue_items_title_check" CHECK (btrim("title") <> ''),
    ADD CONSTRAINT "queue_items_body_check" CHECK (char_length("body") <= 20000 AND btrim("body") <> ''),
    ADD CONSTRAINT "queue_items_answer_text_check" CHECK (char_length("answer_text") <= 20000),
    ADD CONSTRAINT "queue_items_linked_doc_ids_check" CHECK (
        "linked_doc_ids" IS NOT NULL
        AND cardinality("linked_doc_ids") <= 20
        AND array_position("linked_doc_ids", NULL) IS NULL
    ),
    -- decision ⇔ 2..9 R-coded options + a recommended code naming one of them; report ⇒ neither
    ADD CONSTRAINT "queue_items_decision_options_check" CHECK (
        CASE
            WHEN "kind" = 'decision' THEN
                CASE
                    WHEN jsonb_typeof("options") = 'array' THEN
                        jsonb_array_length("options") BETWEEN 2 AND 9
                        AND COALESCE("recommended_code" ~ '^R[1-9]$', false)
                        AND jsonb_path_exists("options", '$[*] ? (@.code == $code)', jsonb_build_object('code', "recommended_code"))
                    ELSE false
                END
            ELSE "options" IS NULL AND "recommended_code" IS NULL
        END
    ),
    ADD CONSTRAINT "queue_items_answer_code_check" CHECK (
        "answer_code" IS NULL
        OR CASE
            WHEN "kind" = 'decision' AND jsonb_typeof("options") = 'array' THEN
                jsonb_path_exists("options", '$[*] ? (@.code == $code)', jsonb_build_object('code', "answer_code"))
            ELSE false
        END
    ),
    ADD CONSTRAINT "queue_items_next_attempt_check" CHECK ("next_attempt" >= 1),
    ADD CONSTRAINT "queue_items_defer_count_check" CHECK ("defer_count" >= 0);

ALTER TABLE "monitor"."queue_deliveries"
    ADD CONSTRAINT "queue_deliveries_attempt_check" CHECK ("attempt" >= 1),
    -- aborted = a resume the pre-spawn re-read stopped → a reason on that row only
    ADD CONSTRAINT "queue_deliveries_abort_reason_check" CHECK (
        (("result" = 'aborted') = ("abort_reason" IS NOT NULL)) AND ("result" <> 'aborted' OR "route" = 'resume')
    ),
    -- pasted into owner-run `claude logs|stop <bg id>` → a leading letter or digit, never an option token
    ADD CONSTRAINT "queue_deliveries_bg_id_check" CHECK (
        "bg_id" IS NULL OR ("route" = 'resume' AND "bg_id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    ),
    ADD CONSTRAINT "queue_deliveries_ack_deadline_check" CHECK ("ack_deadline_at" > "sent_at");

ALTER TABLE "monitor"."queue_drift_checks"
    ADD CONSTRAINT "queue_drift_checks_binary_realpath_check" CHECK ("binary_realpath" ~ '^/'),
    ADD CONSTRAINT "queue_drift_checks_binary_size_check" CHECK ("binary_size" >= 0),
    ADD CONSTRAINT "queue_drift_checks_version_check" CHECK ("version" <> '');

-- ---------------------------------------------------------------------------------------------------------------
-- Raw SQL only — at most one automatic resume per item and attempt; socket and pull rows repeat freely.
-- The resume claim's per-attempt check runs inside its locked transaction; this index backs it structurally,
-- so two overlapping sweep passes cannot both insert a resume row → the losing claim rolls back and spawns nothing.
-- ---------------------------------------------------------------------------------------------------------------

CREATE UNIQUE INDEX "queue_deliveries_resume_item_attempt_key"
    ON "monitor"."queue_deliveries" ("item_id", "attempt")
    WHERE "route" = 'resume';
