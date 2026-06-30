-- HookErrorKind 에 'identifier_rejected' 추가 — SQL 식별자 거부(caller bug)를 'unknown'
--   버킷 대신 정확한 종류로 영속화. _pg_dual_write 가 이미 stderr/로그에서 이 종류를 방출함.
-- 롤백: PG 는 enum 값 DROP 불가 → 롤백은 enum recreate-and-swap 필요, forward-only.
-- CAVEAT: ADD VALUE 는 PG<12 의 txn 블록 내 실행 불가 + 추가된 값은 동일 txn 안에서 사용 불가.
--   이 값을 방출하는 코드보다 먼저 적용되는 독립 migration 이므로 안전 (PG12+ 의 Prisma
--   per-migration txn 정상 동작 · repo 는 PG17 대상).
ALTER TYPE "core"."HookErrorKind" ADD VALUE IF NOT EXISTS 'identifier_rejected';
