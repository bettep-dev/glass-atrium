// 헬스 카드/KPI 순수 모델 (React/JSX 비의존) — architecture.jsx 표시층·monitor/test 공용.
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

// 셸이 폴링한 harness 스토어 → 단일 harness 상태. 풋터 롤업 · System map nav 숫자 ·
// Dashboard 레인/타일이 모두 이 결과 하나만 읽는다 → 같은 사실에 대해 세 표면이 어긋날 수 없음.
// 파트 분모는 '셸이 실제로 관측한' 파트뿐 — 미관측 파트를 ok 로 세지 않는다.

// 스토어가 ready 일 때만 값 추출 — 미수신을 0/빈값으로 꾸미지 않음 (unknown → null).
function readReady(state, pick) {
  return state && state.status === 'ready' ? pick(state.data) : null;
}

// 데몬 다운 = effective_status ≠ ok. nav 배지와 fold 가 같은 수를 읽도록 여기가 단일 출처.
function countDaemonsDown(livePayload) {
  return (livePayload?.daemons || []).filter((d) => d.effective_status !== 'ok').length;
}

// 파트 kind → 관측 결과 (true ok · false down · null unchecked).
// hook chain 은 셸이 폴링하지 않는다(집계 엔드포인트는 System map 소유) → 항상 unchecked.
const HARNESS_PART_PROBES = {
  pg: (_def, { healthState }) =>
    readReady(healthState, (d) => d?.status === 'ok' && d?.db === 'open'),
  browser: (_def, { healthState }) =>
    readReady(healthState, (d) => (d?.browser || 'unprobed') !== 'failed'),
  daemon: (def, { liveState }) =>
    readReady(liveState, (d) => {
      const row = (d?.daemons || []).find((r) => r.daemon_name === def.daemonName);
      return row ? row.effective_status === 'ok' : false;
    }),
  hook: () => null,
};

function foldHarness(states = {}) {
  const parts = HEALTH_CARD_DEFS.map((def) => {
    const probe = HARNESS_PART_PROBES[def.kind];
    return { id: def.id, name: def.name, ok: probe ? probe(def, states) : null };
  });
  const checked = parts.filter((p) => p.ok !== null);
  const down = checked.filter((p) => p.ok === false);

  return {
    status: checked.length === 0 ? 'unavailable' : 'ready',
    partsOk: checked.length - down.length,
    partsChecked: checked.length,
    partsTotal: parts.length,
    downNames: down.map((p) => p.name),
    uncheckedNames: parts.filter((p) => p.ok === null).map((p) => p.name),
    daemonsDown: readReady(states.liveState, countDaemonsDown),
    failCount1h: readReady(states.kpiState, (d) => Number(d?.last_1h_fail_count) || 0),
    version: readReady(states.healthState, (d) => d?.version || null),
  };
}

window.HealthModel = {
  HEALTH_CARD_DEFS,
  isDaemonStale,
  resolveDaemonDisplayMeta,
  resolveCardFacts,
  humanizePayloadKey,
  formatPayloadValue,
  toPayloadRows,
  countDaemonsDown,
  foldHarness,
};
