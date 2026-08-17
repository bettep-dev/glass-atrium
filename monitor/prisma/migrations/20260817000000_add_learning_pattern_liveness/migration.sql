-- Create core.learning_pattern_liveness: the append-only record of the aggregator's terminal skip.
-- When a run clusters a pattern whose learning_log row is already terminal (rejected/applied), the
-- aggregator discards the built entry at a bare `continue` — the cluster cleared its family's own
-- emit gate, so the signal is demonstrably live, and that fact is today observable nowhere. Each
-- row here is one such observation, and the accrued series is the only liveness evidence a later
-- per-row triage can read.
--
-- The floor lives upstream, in each family's own emit gate, and is deliberately NOT re-applied
-- here: a row exists only because the aggregator already decided the pattern cleared, so no new
-- threshold is introduced by observing it.
--
-- (pattern_signature, run_date) is UNIQUE and the write is INSERT ... ON CONFLICT DO NOTHING —
-- append-only, exactly one observation per signature per run, and a same-day re-run adds nothing
-- rather than overwriting. This diverges from the sibling writers' UPSERT re-push semantics on
-- purpose: an observation is a dated fact, not a current reading.
--
-- pattern_signature matches core.learning_log's key ("<pattern core>|<agent>"), a LOGICAL join
-- with no physical FK — a terminal row may be discharged and its learning_log row removed while
-- its accrued observations stay readable, which is the whole point of an append-only record.
--
-- agent is denormalised out of the signature so a per-agent read needs no string split; it is
-- NULL exactly when the clustered entry carried no agent.
--
-- frequency is the clustered count the run measured, carried so a triage verdict is reproducible
-- from this record alone rather than from a re-run of the aggregation.
--
-- Retention is unbounded by design: a few rows per run at most, and the series' whole value is its
-- length.
--
-- Reversal:
--   DROP TABLE "core"."learning_pattern_liveness";
-- IF NOT EXISTS keeps a re-run, and a future pre-release re-squash into the init CREATE TABLE, a
-- no-op (migrate deploy checksum-verifies applied migrations).
CREATE TABLE IF NOT EXISTS "core"."learning_pattern_liveness" (
    "id" BIGSERIAL NOT NULL,
    "pattern_signature" TEXT NOT NULL,
    "agent" TEXT,
    "run_date" DATE NOT NULL,
    "frequency" INTEGER NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_pattern_liveness_pkey" PRIMARY KEY ("id")
);

-- The append-only guarantee: one observation per signature per run.
CREATE UNIQUE INDEX IF NOT EXISTS "learning_pattern_liveness_signature_run_key"
    ON "core"."learning_pattern_liveness" ("pattern_signature", "run_date");

-- Newest-first per-agent read for the triage that consumes the accrued series.
CREATE INDEX IF NOT EXISTS "learning_pattern_liveness_agent_run_idx"
    ON "core"."learning_pattern_liveness" ("agent", "run_date" DESC);
