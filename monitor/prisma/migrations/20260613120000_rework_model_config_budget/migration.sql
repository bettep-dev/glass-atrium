-- "Models & limits" → "Models & budgets" 재구성 — 집계 USD 한도(limit.*) 제거 +
-- 실제 per-call hard-cap budget(budget.*) 추가. monitor.model_config key-value 테이블의
-- DATA 변경만 — 컬럼/제약 불변(key-value store, DDL 없음).
-- 목적: limit.daily_usd / limit.monthly_usd 는 daemon 코드가 읽지 않는 orphaned 키 —
--   전부 OAuth(구독) 경유라 metered 과금이 없어 집계 한도가 무의미. 대신 daemon_cycle 이
--   `claude -p --max-budget-usd <value>` 로 실제 전달하는 per-call 상한
--   (haiku_max_budget_usd / pre_verify_max_budget_usd, daemon_config.py 가 읽음)을 UI SoT 로 노출.
-- 롤백: 99-rollback.sql 참조 (maintenance/model-config-budget-rework/) — limit.* 2행 복원 +
--   budget.* 2행 삭제. 이 migration 자체에는 down 이 없으므로(Prisma forward-only) 운용 롤백은
--   해당 runbook 사용.

-- 1) orphaned 집계 한도 2행 제거 — daemon 소비자 ZERO (scripts/hooks/autoagent grep 0건).
DELETE FROM "monitor"."model_config"
WHERE "config_key" IN ('limit.daily_usd', 'limit.monthly_usd');

-- 2) per-call hard-cap budget 2행 seed — daemon-config.json 현재 검증값 승계.
--   - budget.haiku_max_usd → daemon-config.json haiku_max_budget_usd ('0.50'):
--       autoagent generation 호출 + wiki compile 호출 둘 다 governing
--   - budget.pre_verify_max_usd → daemon-config.json pre_verify_max_budget_usd ('0.50'):
--       autoagent pre-verify 호출만
--   - 값은 trailing-zero 보존 2-decimal 문자열 — daemon-config.json loader 계약
--     ('0.50' ≠ 0.5 — JSON number 로 serialize 시 trailing zero 유실 → --max-budget-usd CLI drift)
--   - ON CONFLICT DO NOTHING: 라이브 수동 적용 후 migrate resolve 운용 경로 재실행 시
--     사용자 Save 값 미덮어쓰기 (add_model_config 운용 노트 승계)
INSERT INTO "monitor"."model_config" ("config_key", "config_value", "updated_by") VALUES
    ('budget.haiku_max_usd',     '0.50', 'seed'),
    ('budget.pre_verify_max_usd', '0.50', 'seed')
ON CONFLICT ("config_key") DO NOTHING;
