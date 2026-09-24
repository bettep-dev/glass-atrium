-- Extend monitor."DocStatus" with the four stage values the Documents screen needs. 'done' is
-- reused, so no stored terminal row changes meaning; the retired 'progress' stays in the type as
-- an accepted write alias — PG has no ALTER TYPE DROP VALUE, and a row written by a
-- not-yet-updated agent must still read rather than vanish from the operator's list.
--
-- ADD VALUE only: PostgreSQL refuses a value consumed in the transaction that added it and Prisma
-- runs one file per transaction, so the default move and backfill are a separate later migration.
-- Deploy order: the widened read acceptance ships BEFORE this migration; the reverse order hands
-- the read paths values they narrow away.
--
-- Reversal (Prisma keeps no down file): no DROP VALUE exists, so recreate the type in one
-- transaction, only after confirming no row carries any of the four values:
--   ALTER TYPE "monitor"."DocStatus" RENAME TO "DocStatus_old";
--   CREATE TYPE "monitor"."DocStatus" AS ENUM ('progress','done');
--   ALTER TABLE "monitor"."documents" ALTER COLUMN "doc_status" DROP DEFAULT;
--   ALTER TABLE "monitor"."documents" ALTER COLUMN "doc_status" TYPE "monitor"."DocStatus"
--     USING "doc_status"::text::"monitor"."DocStatus";
--   ALTER TABLE "monitor"."documents" ALTER COLUMN "doc_status" SET DEFAULT 'progress';
--   DROP TYPE "monitor"."DocStatus_old";
ALTER TYPE "monitor"."DocStatus" ADD VALUE IF NOT EXISTS 'doc_review';
ALTER TYPE "monitor"."DocStatus" ADD VALUE IF NOT EXISTS 'implementing';
ALTER TYPE "monitor"."DocStatus" ADD VALUE IF NOT EXISTS 'impl_review';
ALTER TYPE "monitor"."DocStatus" ADD VALUE IF NOT EXISTS 'impl_done';
