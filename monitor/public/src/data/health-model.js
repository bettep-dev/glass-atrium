// 헬스 카드/KPI 순수 모델 (React/JSX 비의존) — health.jsx 표시층·dashboard.jsx 데몬 카드·monitor/test 공용.
// 카드 tone 과 KPI 버킷을 단일 출처에서 결정 → '정상 N/M' 분모 == 렌더 카드 수 불변식 보장 (F02).
// window.UI 는 호출 시점 참조 — node 테스트는 import 전 window.UI 스텁 주입으로 로드.

// 컴포넌트 카드 정의 — PG / browser / daemon×4 / hook. KPI 분모 = 이 목록 중 ready 카드 수.
const HEALTH_CARD_DEFS = [
  { id: 'pg',            name: 'PostgreSQL',      icon: 'db',       kind: 'pg' },
  { id: 'browser',       name: 'Chromium Export', icon: 'download', kind: 'browser' },
  { id: 'daemon-cycle',  name: 'autoagent',       icon: 'spark',    kind: 'daemon', daemonName: 'autoagent' },
  { id: 'glass-atrium-wiki-curator',  name: 'glass-atrium-wiki-curator',    icon: 'brain',    kind: 'daemon', daemonName: 'wiki' },
  { id: 'daily-restart-autoagent', name: 'daily-restart-autoagent', icon: 'refresh', kind: 'daemon', daemonName: 'daily-restart-autoagent' },
  { id: 'daily-restart-wiki',      name: 'daily-restart-wiki',      icon: 'refresh', kind: 'daemon', daemonName: 'daily-restart-wiki' },
  { id: 'hook-chain',    name: 'Hook Chain',      icon: 'pulse',    kind: 'hook' },
];

// daemon 별 staleness 임계 (기대 주기 × 1.5) — server generic 24h 임계 보정.
// 미정의 daemon → server is_stale 그대로 채택.
const DAEMON_STALE_THRESHOLD_MIN = {
  autoagent:                 24 * 60 * 1.5, // daily cycle → 36h (cron KST 04:30 매일 · server expected_next_at 정합)
  wiki:                      24 * 60 * 1.5, // daily → 36h (wiki-cycle 04:50 KST INSERT)
  'daily-restart-autoagent': 24 * 60 * 1.5, // daily → 36h (05:30 KST 역할별 행)
  'daily-restart-wiki':      24 * 60 * 1.5, // daily → 36h (05:30 KST 역할별 행)
};

function isDaemonStale(d) {
  if (!d || typeof d !== 'object') return false;
  const threshold = DAEMON_STALE_THRESHOLD_MIN[d.daemon_name];
  // 임계 미정의 OR staleness_minutes 숫자 아님 → server 판정 신뢰.
  if (threshold == null || typeof d.staleness_minutes !== 'number') return d.is_stale === true;
  return d.staleness_minutes > threshold;
}

// 데몬 행 → 표시 tone/label — stale 판정이 last_status 보다 우선 (crit 'STALE'),
// null status(실행 행 없음) = 'missing' 매핑 위임 → ui.jsx DAEMON_STATUS_TONE 단일 SoT.
// 로컬 리터럴 금지: info/'No data' 도 공용 테이블에서만 결정 (screen 간 정합, F04).
function resolveDaemonDisplayMeta(d) {
  if (isDaemonStale(d)) return { tone: 'crit', label: 'STALE' };
  if (d == null || d.last_status == null) {
    return { tone: window.UI.daemonStatusTone('missing'), label: window.UI.daemonStatusLabel('missing') };
  }
  return { tone: window.UI.daemonStatusTone(d.last_status), label: window.UI.daemonStatusLabel(d.last_status) };
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

window.HealthModel = {
  HEALTH_CARD_DEFS,
  DAEMON_STALE_THRESHOLD_MIN,
  isDaemonStale,
  resolveDaemonDisplayMeta,
  resolveCardFacts,
  computeOverviewKpis,
};
