-- "Models & limits" 설정 저장소 — monitor.model_config key-value 테이블 + seed 8행.
-- 목적: 모델/한도 설정의 UI SoT = DB (model-config spec doc 36166 D1) — daemon-config.json
--   은 PUT write-through 로 렌더되는 소비자 뷰. seed 는 사용자 preset 이 아니라 "현재
--   검증된 실제값" (drift-free 첫 렌더 — preset 적용은 UI 버튼의 명시 Save 동작).
-- 롤백: DROP TABLE "monitor"."model_config"; — 외부 FK 참조 없음 · row 는 seed 와
--   사용자 Save 만이 생성하므로 단일 DROP 으로 완결.

-- CreateTable
CREATE TABLE "monitor"."model_config" (
    "config_key" VARCHAR(64) NOT NULL,
    "config_value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(64) NOT NULL,

    CONSTRAINT "model_config_pkey" PRIMARY KEY ("config_key")
);

-- Seed appendix — 현재 검증된 실제값 8행 (spec D1).
--   - model.orchestrator: settings.json 의 verbatim 리터럴 — drift 비교는 suffix-normalize
--     ('[1m]' 제거) 후 수행하므로 verbatim 저장이 day-1 표시 drift 를 차단 (D5)
--   - 'inherit' = 해당 surface 에 명시 모델 없음 (dev-*.md 12개 전부 model 라인 부재 ·
--     daemon REPL 모델 키 미존재 → settings.json 상속)
--   - limit.* 는 trailing-zero 보존 문자열 — daemon-config.json loader 계약 ('0.50' ≠ 0.5)
--   - limit.monthly_usd '300.00' 은 placeholder — 사용자 확정 대기 (spec Risks)
--   - ON CONFLICT DO NOTHING: 라이브 DB 수동 적용 후 migrate resolve 하는 운용 경로에서
--     재실행 시 사용자 Save 값을 덮어쓰지 않음 (init_oss_baseline 운용 노트 승계)
INSERT INTO "monitor"."model_config" ("config_key", "config_value", "updated_by") VALUES
    ('model.orchestrator',       'claude-fable-5[1m]', 'seed'),
    ('model.dev',                'inherit',            'seed'),
    ('model.research',           'sonnet',             'seed'),
    ('model.autoagent_daemon',   'inherit',            'seed'),
    ('model.wiki_daemon',        'inherit',            'seed'),
    ('model.daemon_cycle_haiku', 'claude-haiku-4-5',   'seed'),
    ('limit.daily_usd',          '10.00',              'seed'),
    ('limit.monthly_usd',        '300.00',             'seed')
ON CONFLICT ("config_key") DO NOTHING;
