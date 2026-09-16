-- Move monitor.documents.doc_status onto the stage vocabulary added by the preceding migration,
-- and record which model last moved a document's status.
--
-- Three statements, each with its own reason:
--   1. DEFAULT 'progress' -> 'doc_review'. A new document starts at 문서 검증; leaving the default
--      on the retired token would keep minting rows the stage screen has to normalise forever.
--   2. Backfill 'progress' -> 'doc_review'. The retired token meant exactly "in flight, not yet
--      closed", which is the first stage — no other stage can be inferred from a stored row, so
--      this is the only honest mapping. Rows already 'done' are untouched.
--   3. ADD COLUMN last_status_model. The screen states which model performed the last status
--      action so the operator can correct a stage a wrong actor set. NULLABLE deliberately: every
--      existing row genuinely has no recorded actor, and 'unknown' is a state the screen renders
--      distinctly — a NOT NULL default would manufacture a placeholder that reads as fact.
--      VARCHAR(128) matches the existing model-id columns (core.outcomes.model). The operator's
--      own action is written as a reserved literal, which the same column carries.
--
-- WHY a separate file from the ADD VALUEs: PostgreSQL refuses a value used in the transaction
-- that added it, and Prisma runs one file per transaction. Merging the two files fails on apply.
--
-- No index on doc_status: the filter is a chip on a table of documents measured in hundreds, and
-- no EXPLAIN ANALYZE evidence exists for one. Considered and declined rather than overlooked.
--
-- Lock posture: both ALTERs are catalog-only (a nullable ADD COLUMN with no default is not a
-- rewrite on PG 11+), so ACCESS EXCLUSIVE is held for microseconds. The UPDATE takes row locks on
-- the open documents only.
--
-- Reversal, with its expiry stated:
--   ALTER TABLE "monitor"."documents" ALTER COLUMN "doc_status" SET DEFAULT 'progress';
--   ALTER TABLE "monitor"."documents" DROP COLUMN "last_status_model";
--   UPDATE "monitor"."documents" SET "doc_status" = 'progress' WHERE "doc_status" = 'doc_review';
-- The default move and the column add are 1:1 reversible. The backfill's reverse is 1:1 ONLY
-- immediately after this migration applies, while every 'doc_review' row is one this statement
-- moved. Once any document is created or advanced afterwards the mapping is many-to-one: a
-- 'doc_review' row may be a genuinely new document, and sending it back to 'progress' invents a
-- history it never had. After that point the reverse is data loss, not a rollback; recovering the
-- original distinction requires a backup taken before this migration ran.
ALTER TABLE "monitor"."documents" ALTER COLUMN "doc_status" SET DEFAULT 'doc_review';

UPDATE "monitor"."documents" SET "doc_status" = 'doc_review' WHERE "doc_status" = 'progress';

ALTER TABLE "monitor"."documents" ADD COLUMN IF NOT EXISTS "last_status_model" VARCHAR(128);
