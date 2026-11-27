-- Answer record on each queue item: the owner route that answered it and the page-origin signal the gate saw.
-- answered_at stays the "when"; an answered item with no record was written outside the monitor.
-- New CREATE TYPE enums only → safe to use in this same transaction (unlike ALTER TYPE … ADD VALUE).

CREATE TYPE "monitor"."QueueAnswerRoute" AS ENUM ('answer', 'reply', 'message');

CREATE TYPE "monitor"."QueueAnswerSignal" AS ENUM ('fetch_metadata', 'origin', 'before_record');

ALTER TABLE "monitor"."queue_items"
    ADD COLUMN "answer_route" "monitor"."QueueAnswerRoute",
    ADD COLUMN "answer_signal" "monitor"."QueueAnswerSignal";

-- Answers given before the record existed → labelled, so the page never lists them as outside answers
UPDATE "monitor"."queue_items"
SET "answer_route" = (CASE WHEN "kind" = 'decision' THEN 'answer' ELSE 'reply' END)::"monitor"."QueueAnswerRoute",
    "answer_signal" = 'before_record'
WHERE "answered_at" IS NOT NULL
   OR "status" IN ('answered', 'delivering', 'unacked', 'held', 'expired', 'resume_pending', 'delivered');

ALTER TABLE "monitor"."queue_items"
    ADD CONSTRAINT "queue_items_answer_record_check" CHECK (("answer_route" IS NULL) = ("answer_signal" IS NULL));
