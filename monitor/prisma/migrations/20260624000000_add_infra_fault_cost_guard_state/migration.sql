-- CostGuardState 에 'infra_fault' 추가 — 401/credential 인증 실패 등 인프라 결함을
--   'warn'(usage/spend 알림) 대신 정확한 fault 종류로 영속화. autoagent daemon 의
--   401 오분류(Spending guard 표시) 차단이 목적.
-- 롤백: PG 는 enum 값 DROP 불가 → 롤백은 enum recreate-and-swap 필요, forward-only.
-- CAVEAT: ADD VALUE 는 PG<12 의 txn 블록 내 실행 불가 + 추가된 값은 동일 txn 안에서 사용 불가.
--   이 값을 방출하는 코드(daemon_cycle.py)보다 먼저 적용되는 독립 migration 이므로 안전
--   (PG12+ 의 Prisma per-migration txn 정상 동작 · repo 는 PG17 대상).
ALTER TYPE "core"."CostGuardState" ADD VALUE IF NOT EXISTS 'infra_fault';
