-- Send id: one uuid on every copy one owner send creates (owner-sessions.ts → createMessages) → the page folds the copies
-- of an order to several sessions on an id. Rows written before this column keep NULL; the history read folds them by
-- their equal answered_at and body, which the one send transaction stamped on every copy.
--
-- Reversal (Prisma keeps no down file): drop the index and the column; no other row depends on them.

ALTER TABLE "monitor"."queue_items" ADD COLUMN "send_id" UUID;

CREATE INDEX "queue_items_send_id_idx" ON "monitor"."queue_items"("send_id");
