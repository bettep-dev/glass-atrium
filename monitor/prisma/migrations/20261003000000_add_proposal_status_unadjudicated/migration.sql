-- Add 'unadjudicated' to core."ProposalStatus" — the terminal status for a proposal closed
-- without a gate verdict (supersede, back-off, quota, auth, skipped, parked), so 'rejected'
-- keeps meaning a real verdict.
--
-- Transaction note: Prisma Migrate wraps this file in one transaction; since PG 12
-- ALTER TYPE ... ADD VALUE is allowed there as long as the value is not used in the same
-- transaction. No DML here uses it.
--
-- IF NOT EXISTS keeps a re-run a no-op.
ALTER TYPE "core"."ProposalStatus" ADD VALUE IF NOT EXISTS 'unadjudicated';
