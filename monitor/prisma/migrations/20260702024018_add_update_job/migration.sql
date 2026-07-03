-- P3 git-free self-update pipeline — core.update_job single-active-job tracker.
--
-- Why: the route-enqueued updater needs a restart-resilient, crash-detectable
-- record of the one active update. A crash freezes heartbeat_at (never advanced
-- past its last tick), so the in-progress row is detectably stale to the sweep.
--
-- Single-active-job is enforced by the raw-SQL PARTIAL UNIQUE INDEX at the
-- bottom (WHERE status = 'in-progress'), NOT by an @@unique in schema.prisma:
-- Prisma 7 cannot express a partial predicate, so a mirrored @@unique would
-- diff-regress to a FULL unique index on status and wrongly block a 2nd
-- failed/completed row. This mirrors the intentional non-mirrored
-- outcomes_style_ref_agent_ts_idx / autoagent_proposals_confidence_idx pattern.
--
-- Rollback note: this migration is purely additive (new enum + table + indexes,
-- no data touched). Reverting = DROP TABLE "core"."update_job" + DROP TYPE
-- "core"."UpdateJobStatus" in a follow-up forward migration (never migrate reset).

-- CreateEnum
CREATE TYPE "core"."UpdateJobStatus" AS ENUM ('in-progress', 'failed', 'completed');

-- CreateTable
CREATE TABLE "core"."update_job" (
    "id" BIGSERIAL NOT NULL,
    "status" "core"."UpdateJobStatus" NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "heartbeat_at" TIMESTAMPTZ(6) NOT NULL,
    "target_version" TEXT NOT NULL,
    "failure_reason" TEXT,
    "preview_nonce" TEXT,

    CONSTRAINT "update_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "update_job_status_idx" ON "core"."update_job"("status");

-- Single-active-job partial UNIQUE INDEX (hand-written raw SQL — see header).
-- Among rows with status='in-progress' the "status" column must be unique;
-- since every such row shares that one value, at most ONE in-progress row can
-- exist. A 2nd concurrent INSERT trips a unique violation the route start-guard
-- catches (no separate INSERT ... WHERE NOT EXISTS needed). failed/completed
-- rows are outside the predicate and unconstrained.
CREATE UNIQUE INDEX "update_job_single_active_uniq"
    ON "core"."update_job" ("status")
    WHERE "status" = 'in-progress';
