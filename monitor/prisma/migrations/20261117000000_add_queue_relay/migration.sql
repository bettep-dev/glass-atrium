-- Session relay: a queue item one session sends another, delivered with no owner act and kept on record for tracing.
-- Session rows gain a probe flag (hidden from the Queue page, refused as relay ends) and the transcript path register reads.
--
-- ADD VALUE beside CHECKs in one file: PostgreSQL refuses a value used in the transaction that added it and Prisma runs one
-- file per transaction → every predicate on 'relay' compares "kind"::text, which never turns the literal into the enum type.
--
-- Reversal (Prisma keeps no down file), in reverse statement order:
--   - statement 9 → set "is_probe" back to false, or drop the column with statement 5
--   - statements 8, 6, 5, 4, the relay columns, 3 → drop each constraint, index, foreign key and column they add
--   - statement 1 → irreversible: PostgreSQL has no DROP VALUE; 'relay' is harmless once no row carries it
-- Rollback of the monitor code: first move every non-terminal relay row to "withdrawn" with "relay_closed_at" set →
-- the pre-relay code would resume an answered relay on an exited row under a preamble that calls it the owner's instruction.

-- 1 · a distinct kind → a peer's text never reads as an owner message
ALTER TYPE "monitor"."QueueItemKind" ADD VALUE IF NOT EXISTS 'relay';

-- 3 · the sender: restrict → a sender's session row outlives its relays; the index serves the FK and the per-sender caps by send time
ALTER TABLE "monitor"."queue_items" ADD COLUMN "from_session_id" UUID;

ALTER TABLE "monitor"."queue_items" ADD CONSTRAINT "queue_items_from_session_id_fkey" FOREIGN KEY ("from_session_id")
    REFERENCES "monitor"."queue_sessions"("session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "queue_items_from_session_asked_idx" ON "monitor"."queue_items"("from_session_id", "asked_at");

-- hop, the relay that set it, the first fetch that counts toward hop, the redaction stamp and the original text's length
ALTER TABLE "monitor"."queue_items"
    ADD COLUMN "relay_hop" SMALLINT,
    ADD COLUMN "relay_parent_id" BIGINT,
    ADD COLUMN "relay_fetched_at" TIMESTAMPTZ(6),
    ADD COLUMN "relay_redacted_at" TIMESTAMPTZ(6),
    ADD COLUMN "relay_redacted_length" INTEGER;

ALTER TABLE "monitor"."queue_items" ADD CONSTRAINT "queue_items_relay_parent_id_fkey" FOREIGN KEY ("relay_parent_id")
    REFERENCES "monitor"."queue_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "queue_items_relay_parent_id_idx" ON "monitor"."queue_items"("relay_parent_id");

-- 4 · relay ⇔ sender ⇔ hop; hop 0..2 to another session; relay stamps on a relay only; no owner act, never awaiting the owner
-- options, recommended code and answer code → already NULL for every non-decision kind (decision_options / answer_code CHECKs)
ALTER TABLE "monitor"."queue_items"
    ADD CONSTRAINT "queue_items_relay_check" CHECK (
        ("kind"::text = 'relay') = ("from_session_id" IS NOT NULL)
        AND ("kind"::text = 'relay') = ("relay_hop" IS NOT NULL)
        AND ("relay_redacted_at" IS NULL) = ("relay_redacted_length" IS NULL)
        AND CASE
            WHEN "kind"::text = 'relay' THEN
                "from_session_id" <> "session_id"
                AND "relay_hop" BETWEEN 0 AND 2
                AND COALESCE("relay_redacted_length" BETWEEN 1 AND 4000, true)
                AND char_length("body") <= 4000
                AND "answer_text" IS NULL AND "answer_route" IS NULL AND "answer_signal" IS NULL
                AND NOT "approval_class"
                AND "status" NOT IN ('open', 'seen')
            ELSE
                "relay_parent_id" IS NULL AND "relay_fetched_at" IS NULL AND "relay_redacted_at" IS NULL
        END
    );

-- 5 · set only by the register declaration after statement 9
ALTER TABLE "monitor"."queue_sessions" ADD COLUMN "is_probe" BOOLEAN NOT NULL DEFAULT false;

-- 6 · register keeps it only when it resolves under the row's config dir and names the session id (route layer)
ALTER TABLE "monitor"."queue_sessions" ADD COLUMN "transcript_path" TEXT;

ALTER TABLE "monitor"."queue_sessions"
    ADD CONSTRAINT "queue_sessions_transcript_path_check" CHECK ("transcript_path" ~ '^/' AND "transcript_path" ~ '\.jsonl$');

-- 8 · lapse = the terminal "withdrawn" on a relay → its close stamp is set exactly then
ALTER TABLE "monitor"."queue_items" ADD COLUMN "relay_closed_at" TIMESTAMPTZ(6);

ALTER TABLE "monitor"."queue_items"
    ADD CONSTRAINT "queue_items_relay_closed_check" CHECK (
        ("relay_closed_at" IS NOT NULL) = ("kind"::text = 'relay' AND "status" = 'withdrawn')
    );

-- 9 · one-time flag of agent-made sessions: a start directory under .claude/prompt-audit/, or a deploy<N>-probe name
-- unanchored regex → a full scan, once, of a table of under a hundred rows
UPDATE "monitor"."queue_sessions"
SET "is_probe" = true
WHERE "cwd" ~ '/\.claude/prompt-audit(/|$)'
   OR "name" ~ '^deploy[0-9]+-probe$';
