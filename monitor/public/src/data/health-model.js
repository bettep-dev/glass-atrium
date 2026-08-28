// 헬스 카드/KPI 순수 모델 (React/JSX 비의존) — health.jsx 표시층·monitor/test 공용.
// 카드 tone 과 KPI 버킷을 단일 출처에서 결정 → '정상 N/M' 분모 == 렌더 카드 수 불변식 보장 (F02).
// window.UI 는 호출 시점 참조 — node 테스트는 import 전 window.UI 스텁 주입으로 로드.

// 컴포넌트 카드 정의 — PG / browser / daemon×4 / hook. KPI 분모 = 이 목록 중 ready 카드 수.
// 의도적으로 동결하지 않음 — 참조로 내보낸 이 배열을 픽스처가 splice 로 줄였다 복원해
// '분모가 정의 목록을 따른다'를 붉게 만들 수 있어야 함 (T14 · architecture.live-badge 픽스처).
const HEALTH_CARD_DEFS = [
  { id: 'pg',            name: 'PostgreSQL',      icon: 'db',       kind: 'pg' },
  { id: 'browser',       name: 'Chromium Export', icon: 'download', kind: 'browser' },
  { id: 'daemon-cycle',  name: 'autoagent',       icon: 'spark',    kind: 'daemon', daemonName: 'autoagent' },
  { id: 'glass-atrium-wiki-curator',  name: 'glass-atrium-wiki-curator',    icon: 'brain',    kind: 'daemon', daemonName: 'wiki' },
  { id: 'daily-restart-autoagent', name: 'daily-restart-autoagent', icon: 'refresh', kind: 'daemon', daemonName: 'daily-restart-autoagent' },
  { id: 'daily-restart-wiki',      name: 'daily-restart-wiki',      icon: 'refresh', kind: 'daemon', daemonName: 'daily-restart-wiki' },
  { id: 'hook-chain',    name: 'Hook Chain',      icon: 'pulse',    kind: 'hook' },
];

// 데몬 판정 = 서버의 effective_status 소비 — 지연 여부를 클라가 다시 계산하지 않음.
// 판정을 못 받은 행(비객체·필드 부재) → 'missing': 모르는 상태를 정상으로 꾸미지 않음.
function resolveDaemonStatus(d) {
  if (!d || typeof d !== 'object') return 'missing';
  const status = d.effective_status;
  return typeof status === 'string' && status !== '' ? status : 'missing';
}

function isDaemonStale(d) {
  return resolveDaemonStatus(d) === 'stale';
}

// 데몬 행 → 표시 tone/label — 서버 판정을 그대로 넘겨 매핑만 위임,
// ui.jsx DAEMON_STATUS_TONE 단일 SoT. 로컬 리터럴 금지: crit/'Overdue' 도 info/'No data' 도
// 공용 테이블에서만 결정 (screen 간 정합, F04).
function resolveDaemonDisplayMeta(d) {
  const status = resolveDaemonStatus(d);
  return { tone: window.UI.daemonStatusTone(status), label: window.UI.daemonStatusLabel(status) };
}

// kind 별 사실(facts) 산출 — tone/isStale 등 집계 입력만. 표시 문자열은 화면 빌더 담당.
const CARD_FACTS_RESOLVERS = {
  pg(_def, { pgState }) {
    if (pgState.status !== 'ready') return { status: pgState.status, error: pgState.error };
    const pgOk = pgState.data?.status === 'ok' && pgState.data?.db === 'open';
    return { status: 'ready', tone: pgOk ? 'ok' : 'crit', pgOk };
  },

  // Chromium export 프로브 — /api/health `browser` 필드. KPI 분자/분모 포함 (F02).
  browser(_def, { pgState }) {
    if (pgState.status !== 'ready') return { status: pgState.status, error: pgState.error };
    const launch = pgState.data?.browser || 'unprobed';
    const tone = launch === 'ok' ? 'ok' : (launch === 'failed' ? 'crit' : 'info');
    return { status: 'ready', tone, launch };
  },

  daemon(def, { daemonState }) {
    if (daemonState.status !== 'ready') return { status: daemonState.status, error: daemonState.error };
    const daemon = (daemonState.data?.daemons || []).find((row) => row.daemon_name === def.daemonName) || null;
    if (!daemon) return { status: 'ready', tone: 'info', isStale: false, daemon: null };
    const stale = isDaemonStale(daemon);
    return { status: 'ready', tone: resolveDaemonDisplayMeta(daemon).tone, isStale: stale, daemon };
  },

  // tone 소스 = core.hook_failures 24h recency (F08) — 설정 인벤토리는 sub-metric 강등.
  // crit = 미재시도 실패 존재(유실 위험) · warn = 24h 내 실패(재시도됨) · 집계 미수신 → 설정 기반 폴백.
  hook(_def, { hookState, hookFailState }) {
    if (hookState.status !== 'ready') return { status: hookState.status, error: hookState.error };
    const events = hookState.data?.events || [];
    const configured = events.length > 0;
    const fail = hookFailState && hookFailState.status === 'ready' ? hookFailState.data : null;
    const count24h = fail && typeof fail.count_24h === 'number' ? fail.count_24h : null;
    const unretried24h = fail && typeof fail.unretried_count_24h === 'number' ? fail.unretried_count_24h : null;
    let tone;
    if (unretried24h > 0) tone = 'crit';
    else if (count24h > 0) tone = 'warn';
    else tone = configured ? 'ok' : 'info';
    return { status: 'ready', tone, configured, events, count24h, unretried24h };
  },
};

function resolveCardFacts(def, states) {
  const resolver = CARD_FACTS_RESOLVERS[def.kind];
  if (!resolver) return { status: 'error', error: `unknown kind: ${def.kind}` };
  return resolver(def, states);
}

const EMPTY_OVERVIEW_KPIS = {
  okCount: '—', degradedCount: '—', infoCount: '—', staleCount: '—', totalCount: '—',
};

// KPI 집계 — 카드 facts 와 동일 출처 fold (KPI 와 카드 tone 분기 불일치 차단).
// ready 카드만 분모 (loading/error 가짜 0 금지) · info 버킷 = info+neutral 명시 귀속.
// 불변식: okCount + degradedCount + infoCount === totalCount === ready 카드 수.
function computeOverviewKpis(states) {
  if (states.daemonState.status !== 'ready') return EMPTY_OVERVIEW_KPIS;

  let okCount = 0;
  let degradedCount = 0;
  let infoCount = 0;
  let staleCount = 0;
  let totalCount = 0;
  for (const def of HEALTH_CARD_DEFS) {
    const facts = resolveCardFacts(def, states);
    if (facts.status !== 'ready') continue;

    totalCount += 1;
    if (facts.tone === 'ok') okCount += 1;
    else if (facts.tone === 'warn' || facts.tone === 'crit') degradedCount += 1;
    else infoCount += 1;
    if (facts.isStale) staleCount += 1;
  }

  return { okCount, degradedCount, infoCount, staleCount, totalCount };
}

// daemon_run_payload jsonb 키 → 표시 라벨 (P18) — 동적/write-only 키라 하드코딩 맵 없이 humanize.
// snake/kebab/camel → 공백 분리 후 첫 글자만 대문자 (키 원형 보존, 과도 변형 금지).
function humanizePayloadKey(key) {
  const raw = String(key == null ? '' : key).trim();
  if (raw === '') return '—';
  const spaced = raw
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// jsonb 값 → 표시 문자열 + 복합 여부. null/undefined→'—' · 원시값→문자열 · 객체/배열→compact JSON.
// 직렬화 불가(순환참조 등) → 안전 폴백 (raw render 깨짐 방지).
function formatPayloadValue(value) {
  if (value === null || value === undefined) return { text: '—', complex: false };
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    return { text: String(value), complex: false };
  }
  try {
    return { text: JSON.stringify(value), complex: true };
  } catch (_e) {
    return { text: '[unreadable data]', complex: true };
  }
}

// payload 객체 → keyed/labeled 렌더 행 [{ key, label, text, complex }] (P18).
// 비객체/배열/null → [] (빈 상태 위임). 카드 렌더층이 이 순수 변환만 소비.
function toPayloadRows(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.keys(payload).map((key) => {
    const formatted = formatPayloadValue(payload[key]);
    return { key, label: humanizePayloadKey(key), text: formatted.text, complex: formatted.complex };
  });
}

window.HealthModel = {
  HEALTH_CARD_DEFS,
  isDaemonStale,
  resolveDaemonDisplayMeta,
  resolveCardFacts,
  computeOverviewKpis,
  humanizePayloadKey,
  formatPayloadValue,
  toPayloadRows,
};
