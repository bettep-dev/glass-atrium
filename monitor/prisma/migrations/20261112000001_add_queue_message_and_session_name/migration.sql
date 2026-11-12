-- Owner message: a queue item kind the owner sends to a session, inserted already answered so the existing delivery carries it.
-- Session name: an optional label a session gives when it registers; the owner's session list falls back to the start directory.
--
-- ADD VALUE beside a CHECK in one file: PostgreSQL refuses a value used in the transaction that added it and Prisma runs one
-- file per transaction → every predicate on 'message' compares "kind"::text, which never turns the literal into the enum type.
-- The other enums named below ('QueueItemStatus', 'QueueAnswerRoute') were committed by earlier migrations → safe to compare.
--
-- Reversal (Prisma keeps no down file): drop the constraint and column; the enum value stays (PG has no DROP VALUE) and is
-- harmless once no row carries it.

ALTER TYPE "monitor"."QueueItemKind" ADD VALUE IF NOT EXISTS 'message';

-- a message ⇔ the send route's record; never awaiting the owner, never Seen (report only), carries no answer, no approval
-- options, recommended code and answer code → already NULL for every non-decision kind (decision_options / answer_code CHECKs)
ALTER TABLE "monitor"."queue_items"
    ADD CONSTRAINT "queue_items_message_check" CHECK (
        (("kind"::text = 'message') = ("answer_route" IS NOT DISTINCT FROM 'message'))
        AND (
            "kind"::text <> 'message'
            OR ("answer_text" IS NULL AND NOT "approval_class" AND "status" NOT IN ('open', 'seen'))
        )
    );

ALTER TABLE "monitor"."queue_sessions" ADD COLUMN "name" VARCHAR(100);

-- one display line: not blank, no control character (a line break would split the list row)
ALTER TABLE "monitor"."queue_sessions"
    ADD CONSTRAINT "queue_sessions_name_check" CHECK (btrim("name") <> '' AND "name" !~ '[[:cntrl:]]');
