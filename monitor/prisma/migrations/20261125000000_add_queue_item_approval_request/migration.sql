-- The scan-approval request a secret-approval item asks the owner about: its id only → the captured lines stay in the
-- monitor's process memory (src/server/queue/scan-approvals.ts), never in this table.
-- Additive and nullable, no backfill: every existing row keeps NULL, which the CHECK accepts.
--
-- Raw SQL the Prisma DSL cannot declare: the CHECK.
--   schema.prisma documents it on QueueItem → a migration squash MUST carry this SQL.
--   monitor/test/queue.schema.test.ts runs it against the migrated chain → a squash that drops it goes red.
--
-- Locks: statement 1 takes ACCESS EXCLUSIVE on queue_items, held to the file's commit (Prisma runs one file per transaction);
-- statements 2 and 3 scan the table once each.
--
-- Reversal (Prisma keeps no down file), in reverse statement order:
--   ALTER TABLE "monitor"."queue_items" DROP CONSTRAINT "queue_items_secret_request_check";
--   DROP INDEX "monitor"."queue_items_secret_request_id_key";
--   ALTER TABLE "monitor"."queue_items" DROP COLUMN "secret_request_id";
-- Not recoverable after the drop: which item asked about which request → the request itself never outlives a monitor restart.

-- 1
ALTER TABLE "monitor"."queue_items" ADD COLUMN "secret_request_id" UUID;

-- 2 · one item per request → a second link fails even when two posts race
CREATE UNIQUE INDEX "queue_items_secret_request_id_key" ON "monitor"."queue_items"("secret_request_id");

-- 3 · the owner answers a linked item by a fixed option only → an approval-class decision taking no free text
ALTER TABLE "monitor"."queue_items"
    ADD CONSTRAINT "queue_items_secret_request_check" CHECK (
        "secret_request_id" IS NULL OR ("kind" = 'decision' AND "approval_class" AND NOT "free_text_allowed")
    );
