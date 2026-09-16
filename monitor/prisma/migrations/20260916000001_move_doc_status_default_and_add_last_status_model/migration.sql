-- Move monitor.documents.doc_status onto the stage vocabulary the preceding migration added, and
-- record which model last moved a document's status. The backfill maps the retired token to the
-- first stage: it meant exactly "in flight, not yet closed", and no other stage is inferable from
-- a stored row. last_status_model is NULLABLE deliberately — an existing row genuinely has no
-- recorded actor, and a NOT NULL default would manufacture a placeholder that reads as fact.
--
-- Separate file from the ADD VALUEs: PostgreSQL refuses a value used in the transaction that
-- added it, and Prisma runs one file per transaction — merging the two fails on apply.
--
-- Reversal (Prisma keeps no down file), 1:1 for the default move and the column add only:
--   ALTER TABLE "monitor"."documents" ALTER COLUMN "doc_status" SET DEFAULT 'progress';
--   ALTER TABLE "monitor"."documents" DROP COLUMN "last_status_model";
--   UPDATE "monitor"."documents" SET "doc_status" = 'progress' WHERE "doc_status" = 'doc_review';
-- The backfill's reverse is 1:1 ONLY immediately after this migration applies; afterwards a
-- 'doc_review' row may be a genuinely new document, so the reverse is data loss, not a rollback.
ALTER TABLE "monitor"."documents" ALTER COLUMN "doc_status" SET DEFAULT 'doc_review';

UPDATE "monitor"."documents" SET "doc_status" = 'doc_review' WHERE "doc_status" = 'progress';

ALTER TABLE "monitor"."documents" ADD COLUMN IF NOT EXISTS "last_status_model" VARCHAR(128);
