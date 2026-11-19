-- Close time of a decision or report: when it left open (the owner's wait) → the done list's time and its newest-first page.
-- One writer: a BEFORE row trigger → every path out of open is stamped, a write from outside the monitor included
-- (answer, reply, Seen, the session's withdraw, a direct SQL write — the answered-outside case).
-- Stamp = the row's answer time, else the writing transaction's now(); set once → a withdraw after an answer keeps the answer time.
-- Kept apart from relay_closed_at: that stamp is a relay's lapse, set by the sweep; a relay never waits on the owner (relay CHECK).
--
-- Raw SQL the Prisma DSL cannot declare: the CHECK, the function and the trigger.
--   schema.prisma documents them on QueueItem → a migration squash MUST carry this SQL.
--   monitor/test/queue.schema.test.ts runs them against the migrated chain → a squash that drops one goes red.
--
-- Locks: statement 1 takes ACCESS EXCLUSIVE on queue_items, held to the file's commit (Prisma runs one file per transaction)
-- → every read and write of the table waits for the whole file; statements 2 and 3 scan the table once each.
--
-- Reversal (Prisma keeps no down file), in reverse statement order:
--   DROP TRIGGER "queue_items_set_closed_at" ON "monitor"."queue_items";
--   DROP FUNCTION "monitor"."queue_items_set_closed_at"();
--   DROP INDEX "monitor"."queue_items_closed_at_idx";
--   ALTER TABLE "monitor"."queue_items" DROP CONSTRAINT "queue_items_closed_check";
--   ALTER TABLE "monitor"."queue_items" DROP COLUMN "closed_at";
-- Not recoverable after the drop: the stamps of seen and withdrawn items closed after this file → no other column holds that time.
-- Monitor code without the column runs unchanged on this schema: it never writes closed_at, and the trigger stamps its writes.

-- 1
ALTER TABLE "monitor"."queue_items" ADD COLUMN "closed_at" TIMESTAMPTZ(6);

-- 2 · every decision and report not open; no write returns an item to open → nothing open is marked closed
-- answer time exact; updated_at is the close for seen and withdrawn rows written through Prisma, early only after a raw-SQL change
UPDATE "monitor"."queue_items"
SET "closed_at" = COALESCE("answered_at", "updated_at")
WHERE "kind" IN ('decision', 'report') AND "status" <> 'open';

-- 3 · after the backfill → a non-open decision or report never sorts first under DESC with a null time
ALTER TABLE "monitor"."queue_items"
    ADD CONSTRAINT "queue_items_closed_check" CHECK (
        ("closed_at" IS NOT NULL) = ("kind" IN ('decision', 'report') AND "status" <> 'open')
    );

-- 4 · the done list pages by (close time, id), newest first
CREATE INDEX "queue_items_closed_at_idx" ON "monitor"."queue_items"("closed_at" DESC, "id" DESC);

-- 5
CREATE OR REPLACE FUNCTION "monitor"."queue_items_set_closed_at"()
    RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."kind" IN ('decision', 'report') AND NEW."status" <> 'open' AND NEW."closed_at" IS NULL THEN
        NEW."closed_at" := COALESCE(NEW."answered_at", now());
    END IF;
    RETURN NEW;
END;
$$;

-- BEFORE → the stamp is in the row the CHECK sees; an insert already closed is stamped too
CREATE OR REPLACE TRIGGER "queue_items_set_closed_at"
    BEFORE INSERT OR UPDATE OF "status", "closed_at" ON "monitor"."queue_items"
    FOR EACH ROW
    EXECUTE FUNCTION "monitor"."queue_items_set_closed_at"();
