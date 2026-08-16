-- Create core.autoagent_corpus_audits: the destination for the per-cycle corpus-growth audit that
-- until now landed in an unread JSONL family. The audit emits one reading about the corpus as a
-- whole, a cardinality no existing table carries — autoagent_proposals is keyed per proposal and
-- autoagent_loop_events is a fixed per-stage stream — so overloading either would poison exactly
-- the per-agent aggregations those tables exist to serve.
--
-- cycle_date is UNIQUE and is the UPSERT key: one reading per cycle, a same-day re-run overwrites,
-- matching the sibling writers' re-push semantics. It is a LOGICAL FK to
-- core.daemon_runs(run_date) filtered daemon_name='autoagent' — no physical constraint, because
-- that PK is composite; the same convention autoagent_proposals.cycle_date already documents.
--
-- Nullability carries meaning and must not be flattened to defaults:
--   trend_delta      — NULL when the emitter had no prior baseline, distinct from a measured 0.
--   compliance_rate  — NULL = insufficient data. A fabricated 0.0 would read as total failure.
--   override_rate    — always NULL today (the override dimension has no durable store); the column
--                      exists so the row stays 1:1 with the emitted signal and is ready the day it
--                      does. REAL matches the emitter's float precision; the series is a trend, not
--                      an accounting figure.
--
-- Retention is unbounded by design: under 400 scalar rows a year, and the series' whole value is its
-- length, so a TTL would delete the instrument's memory for no measurable saving.
--
-- Reversal:
--   DROP TABLE "core"."autoagent_corpus_audits";
-- IF NOT EXISTS keeps a re-run, and a future pre-release re-squash into the init CREATE TABLE, a
-- no-op (migrate deploy checksum-verifies applied migrations).
CREATE TABLE IF NOT EXISTS "core"."autoagent_corpus_audits" (
    "id" BIGSERIAL NOT NULL,
    "cycle_date" DATE NOT NULL,
    "word_count" INTEGER NOT NULL,
    "token_estimate" INTEGER NOT NULL,
    "file_count" INTEGER NOT NULL,
    "seeded_threshold" INTEGER NOT NULL,
    "gate_pass_count" INTEGER NOT NULL,
    "gate_trip_count" INTEGER NOT NULL,
    "gate_total_count" INTEGER NOT NULL,
    "trend_delta" INTEGER,
    "trend_alert" BOOLEAN NOT NULL,
    "absolute_alert" BOOLEAN NOT NULL,
    "compliance_rate" REAL,
    "override_rate" REAL,
    "indexed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autoagent_corpus_audits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "autoagent_corpus_audits_cycle_date_key"
    ON "core"."autoagent_corpus_audits" ("cycle_date");

-- Newest-first windowed read for GET /api/improvement/corpus-audits.
CREATE INDEX IF NOT EXISTS "autoagent_corpus_audits_cycle_date_idx"
    ON "core"."autoagent_corpus_audits" ("cycle_date" DESC);
