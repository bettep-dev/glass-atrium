-- core.api_response_metrics 제거 — ApiResponseMetric 모델 + 모든 read/write 코드가
--   이미 삭제되어 런타임 무참조(inert) 상태. route_ts / level_route 인덱스 2개는 테이블과 함께 drop.
-- 롤백: 데이터는 data/backups/api_response_metrics_20260627.sql 백업 보존 → 필요 시 복원, forward-only.
DROP TABLE IF EXISTS core.api_response_metrics;
