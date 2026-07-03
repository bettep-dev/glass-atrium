-- "Models & budgets" 설정 저장소 — monitor.model_config key-value 테이블 + 최종 seed 7행.
-- 이 마이그레이션은 model_config 시드의 단일 소스다: 과거의 add→rework→live-defaults 3단계
--   누적(집계 limit.* 도입 후 제거 · budget.* '0.50' seed 후 '10.00' 정정 · model.research
--   'sonnet' seed 후 'claude-sonnet-5' 정정 · model.orchestrator seed 후 폐기)을 pre-release
--   초기상태 기준으로 접어, 최종 검증값만 1회 seed 한다.
-- 목적: 모델/예산 설정의 UI SoT = DB — daemon-config.json 은 PUT write-through 소비자 뷰.
--   seed 는 사용자 preset 이 아니라 "현재 검증된 실제값"(drift-free 첫 렌더).
--   - 'inherit' = 해당 surface 에 명시 모델 없음 → settings.json 상속
--   - budget.* 는 daemon_cycle 이 `claude -p --max-budget-usd <value>` 로 전달하는 per-call
--     hard-cap; trailing-zero 보존 문자열 계약('10.00' ≠ 10.0 — JSON serialize 시 trailing
--     zero 유실 → --max-budget-usd CLI drift 방지)
--   - model.research 는 full alias — bare 'sonnet' 은 REJECTED_ALIAS_VALUES(model-config-consts.ts)
--     라 PUT 400; shipped agents/intel-researcher.md frontmatter(claude-sonnet-5)와 일치
--   - ON CONFLICT DO NOTHING: 라이브 수동적용 후 migrate resolve 재실행 시 사용자 Save 값 미덮어쓰기
-- 롤백: DROP TABLE "monitor"."model_config"; — 외부 FK 참조 없음.

-- CreateTable
CREATE TABLE "monitor"."model_config" (
    "config_key" VARCHAR(64) NOT NULL,
    "config_value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(64) NOT NULL,

    CONSTRAINT "model_config_pkey" PRIMARY KEY ("config_key")
);

-- Seed appendix — 최종 검증값 7행 (spec D1 승계, add→rework→live-defaults 누적 결과).
INSERT INTO "monitor"."model_config" ("config_key", "config_value", "updated_by") VALUES
    ('model.dev',                'inherit',            'seed'),
    ('model.research',           'claude-sonnet-5',    'seed'),
    ('model.autoagent_daemon',   'inherit',            'seed'),
    ('model.wiki_daemon',        'inherit',            'seed'),
    ('model.daemon_cycle_haiku', 'claude-haiku-4-5',   'seed'),
    ('budget.haiku_max_usd',     '10.00',              'seed'),
    ('budget.pre_verify_max_usd', '10.00',             'seed')
ON CONFLICT ("config_key") DO NOTHING;
