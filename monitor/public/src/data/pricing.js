// 토큰 단가 카탈로그 SoT ($ / 1M tokens) — cost.jsx 가 소비, JSX 내 magic number 복제 금지
// 출처 https://www.anthropic.com/pricing · https://docs.anthropic.com/en/docs/about-claude/models/all-models

window.TOKEN_RATES = {
  // claude-fable-5 family — 검증된 DB cost vector 와 일치 (F28)
  'claude-fable-5':     { input: 10.00, output: 50.00, cache_read: 1.00,  cache_creation: 12.50 },

  // claude-opus-4-x family — date-suffixed keys align to the opus family rate
  'claude-opus-4-8':    { input: 15.00, output: 75.00, cache_read: 1.50,  cache_creation: 18.75 },
  'claude-opus-4-7':    { input: 15.00, output: 75.00, cache_read: 1.50,  cache_creation: 18.75 },
  'claude-opus-4-5':    { input: 15.00, output: 75.00, cache_read: 1.50,  cache_creation: 18.75 },
  'claude-opus-4':      { input: 15.00, output: 75.00, cache_read: 1.50,  cache_creation: 18.75 },

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
