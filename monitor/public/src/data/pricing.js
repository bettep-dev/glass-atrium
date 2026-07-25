// 토큰 단가 표시 전용 미러 ($ / 1M tokens) — 단가 SoT 는 hooks/pricing.json, 이 표는 그 사본.
// cost.jsx 가 소비 · JSX 내 magic number 복제 금지 · SoT 행 변경 시 이 표도 같이 갱신해야 드리프트 없음.
// 출처 https://www.anthropic.com/pricing · https://docs.anthropic.com/en/docs/about-claude/models/all-models

window.TOKEN_RATES = {
  // claude-fable-5 family — 검증된 DB cost vector 와 일치 (F28)
  'claude-fable-5':     { input: 10.00, output: 50.00, cache_read: 1.00,  cache_creation: 12.50 },

  // claude-opus-5 — opus-4-x 세대와 별개 단가라 family prefix 매칭에 기대지 않고 독립 행 유지
  'claude-opus-5':      { input:  5.00, output: 25.00, cache_read: 0.50,  cache_creation:  6.25 },

  // claude-opus-4-x family — SoT 행과 1:1 (claude-opus-4 만 예외, 아래 참고)
  'claude-opus-4-8':    { input:  5.00, output: 25.00, cache_read: 0.50,  cache_creation:  6.25 },
  'claude-opus-4-7':    { input:  5.00, output: 25.00, cache_read: 0.50,  cache_creation:  6.25 },
  // 자체 키가 없으면 claude-opus-4 stem 으로 최장 prefix 매칭돼 opus-4.0 세대 단가를 반환
  'claude-opus-4-6':    { input:  5.00, output: 25.00, cache_read: 0.50,  cache_creation:  6.25 },
  'claude-opus-4-5':    { input:  5.00, output: 25.00, cache_read: 0.50,  cache_creation:  6.25 },
  // SoT 에 claude-opus-4 행이 없어 in-repo 증거로 검증 불가 → 사실 주장 아닌 보수적 유지값
  // 서버 pricing_loader._find_family_latest 는 이 키를 opus family 최신($5/$25)으로 해소해 값이 갈림
  // core.cost_events 의 claude-opus-4* 행이 0건이라 현재는 무해
  'claude-opus-4':      { input: 15.00, output: 75.00, cache_read: 1.50,  cache_creation: 18.75 },

  // claude-sonnet-5 — SoT base row 채택 (intro tier 2.00/10.00 은 2026-08-31 만료)
  // 이 표엔 tier·날짜 입력이 없어 intro 값을 쓰면 만료 후 감지 없이 썩음
  // 두 값은 ×1.5 균일 스케일 → 렌더 결과 동일 · monitor/test/model-config.route.test.ts fixture 도 base row 표기
  'claude-sonnet-5':    { input:  3.00, output: 15.00, cache_read: 0.30,  cache_creation:  3.75 },

  // claude-sonnet-4-x family
  'claude-sonnet-4-7':  { input:  3.00, output: 15.00, cache_read: 0.30,  cache_creation:  3.75 },
  'claude-sonnet-4-6':  { input:  3.00, output: 15.00, cache_read: 0.30,  cache_creation:  3.75 },
  'claude-sonnet-4-5':  { input:  3.00, output: 15.00, cache_read: 0.30,  cache_creation:  3.75 },
  'claude-sonnet-4':    { input:  3.00, output: 15.00, cache_read: 0.30,  cache_creation:  3.75 },

  // claude-haiku-4-x family — date-suffixed key aligns to the haiku family rate
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, cache_read: 0.10, cache_creation: 1.25 },
  'claude-haiku-4-7':   { input:  1.00, output:  5.00, cache_read: 0.10,  cache_creation:  1.25 },
  'claude-haiku-4-5':   { input:  1.00, output:  5.00, cache_read: 0.10,  cache_creation:  1.25 },
  'claude-haiku-4':     { input:  1.00, output:  5.00, cache_read: 0.10,  cache_creation:  1.25 },
};

// 모델 id → 단가 조회 (miss 가능 → null · get 계약: throws 아님).
// exact 키 우선, 없으면 family-prefix 매칭 — date-suffixed id(예: claude-opus-4-8-20260101)를
// family stem(claude-opus-4-8)로 해소해 silent rate-miss(rate=1 COUNT 폴백) 방지.
// 경계 매칭('-' 구분)으로 claude-opus-4 가 claude-opus-4-8 를 오탈취하지 않게 최장 prefix 선택.
window.getTokenRate = function (model) {
  if (!model) return null;
  const rates = window.TOKEN_RATES || {};
  if (rates[model]) return rates[model];

  let best = null;
  for (const key of Object.keys(rates)) {
    if (model === key || model.startsWith(key + '-')) {
      if (best === null || key.length > best.length) best = key;
    }
  }
  return best === null ? null : rates[best];
};

// 기준 mid-tier 모델 — 향후 per-model rate consumer 용 public global (cost 계산은 API cost_usd 사용)
window.TOKEN_RATES_DEFAULT_MODEL = 'claude-sonnet-4-5';

// 토큰 카테고리 메타 — cost.jsx TOKEN_CATEGORIES + ModelCostChart 매핑과 1:1 · 행 순서대로 렌더
// --cat-1~4 단일셋으로 TokenCategory / TokenStacked / ModelCost 카드가 동일 분류에 동일 색 사용
window.TOKEN_CATEGORY_RATES = [
  { key: 'input_tokens',          rateKey: 'input',          label: 'Input',       colorVar: '--cat-3' },
  { key: 'output_tokens',         rateKey: 'output',         label: 'Output',      colorVar: '--cat-4' },
  { key: 'cache_read_tokens',     rateKey: 'cache_read',     label: 'Cache read',  colorVar: '--cat-2' },
  { key: 'cache_creation_tokens', rateKey: 'cache_creation', label: 'Cache write', colorVar: '--cat-1' },
];
