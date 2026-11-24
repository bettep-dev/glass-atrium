// Screen 04 — Outcome analysis (live data via /api/outcomes/*) · window.ScreenOutcomes.
// Analysis sections on top, explorer below (filter bar under the Results card head + results table).
// Hooks aliased with an O suffix → no window-scope collisions across modules.
//
// SECURITY: body_md carries user-supplied strings (concerns/lesson) → MarkdownView injects HTML only past the DOMPurify gate, else raw pre (core-security.md).
const {
  useState: useStateO,
  useEffect: useEffectO,
  useRef: useRefO,
  useCallback: useCallbackO,
  useMemo: useMemoO,
} = React;

// budget-truncation attribution_source 리터럴 — track-outcome.sh + 서버 3파일과 byte-identical (rename 금지).
const ATTRIBUTION_SOURCE_BUDGET_TRUNCATION = 'budget-truncation';

// 북마크된 'all' 창은 wire sentinel 로 보존 (route parseDaysParam 가 {7,30,90,'all'} 만 허용).
// filter.days 는 number {7,30,90} | 'all' 의 tri-state → buildSearchUrlO 의 String(filter.days) 가 그대로 직렬화.
const OUTCOME_ALL_PERIOD = 'all';

// task_type — core-outcome-record.md enum (9 values). 백엔드 축당 단일값 → FE single-select.
const TASK_TYPE_OPTIONS = [
  { value: '',          label: 'All'      },
  { value: 'bug-fix',   label: 'bug-fix'  },
  { value: 'feature',   label: 'feature'  },
  { value: 'refactor',  label: 'refactor' },
  { value: 'research',  label: 'research' },
  { value: 'plan',      label: 'plan'     },
  { value: 'review',    label: 'review'   },
  { value: 'diagnosis', label: 'diagnosis'},
  { value: 'doc',       label: 'doc'      },
  { value: 'cleanup',   label: 'cleanup'  },
];

// result — core-outcome-record.md enum (5 values). Labels sourced from RESULT_META (label SoT).
const RESULT_OPTIONS = [
  { value: '',                   label: 'All'               },
  { value: 'done',               label: 'Done'              },
  { value: 'done_with_concerns', label: 'Done with caveats' },
  { value: 'blocked',            label: 'Blocked'           },
  { value: 'needs_context',      label: 'Needs info'        },
  { value: 'fail',               label: 'Failed'            },
];

// confidence axis (3 + null) — 'null' = writer omission.
const CONFIDENCE_OPTIONS = [
  { value: '',       label: 'All'    },
  { value: 'high',   label: 'High'   },
  { value: 'medium', label: 'Medium' },
  { value: 'low',    label: 'Low'    },
  { value: 'null',   label: 'None'   },
];

// metric_pass axis — writer self-check (true/false/none).
const METRIC_PASS_OPTIONS = [
  { value: '',      label: 'All'  },
  { value: 'true',  label: 'Pass' },
  { value: 'false', label: 'Fail' },
  { value: 'null',  label: 'None' },
];

// review_flag toggle.
const REVIEW_FLAG_OPTIONS = [
  { value: '',      label: 'All'     },
  { value: 'true',  label: 'Flagged' },
  { value: 'false', label: 'Clear'   },
];

// attribution_source exact-match 필터 (선택) — raw source 는 오픈 enum 이라 관심 신호 1종(budget-truncation)만 노출.
const ATTRIBUTION_SOURCE_OPTIONS = [
  { value: '',                                   label: 'All'         },
  { value: ATTRIBUTION_SOURCE_BUDGET_TRUNCATION, label: 'budget-kill' },
];

// grader_verdict (측정 신호) — 결정론적 grader 산출 (writer self-report metric_pass 와 분리, 색맹 안전 듀얼인코딩).
//   verified_pass = 측정 통과 · unverified = 미측정(중립, 실패 아님) · verified_fail = 측정 실패 · NULL = 레거시(grader 도입 전).
//   unverified/NULL 은 crit(빨강) 절대 금지 — "측정 안 됨" 중립 muted.
// icon = window.UI.Icon 이름(렌더 경로 전용, FIX-D 중앙화) · symbol = 문자열 폴백(레거시/비-Icon 컨텍스트).
//   ✓→check · ○→circle(측정 안 됨 중립) · ✕→x · –→minus(레거시 dash). crit 회귀 차단 톤은 colorVar 가 담당.
const GRADER_VERDICT_META = {
  verified_pass: { label: 'Check passed', symbol: '✓', icon: 'check',  colorVar: '--ok'   },
  unverified:    { label: 'Auto-check N/A',  symbol: '○', icon: 'circle', colorVar: '--dim'  },
  verified_fail: { label: 'Check failed', symbol: '✕', icon: 'x',      colorVar: '--crit' },
};

// NULL grader_verdict (레거시 un-graded 행) — unverified 와 구분해 명시적 "Pre-grader (legacy)" 표기.
const GRADER_VERDICT_NULL_META = { label: 'Pre-grader (legacy)', symbol: '–', icon: 'minus', colorVar: '--faint' };

// 측정 분포 카드 버킷 순서 + 메타 — cross-analysis grader_breakdown 소비 (verified_pass/unverified/verified_fail + not_measured).
const GRADER_BREAKDOWN_ORDER = ['verified_pass', 'unverified', 'verified_fail', 'not_measured'];
const GRADER_BREAKDOWN_META = {
  verified_pass: { label: 'Check passed',             symbol: '✓', icon: 'check',  colorVar: '--ok'    },
  unverified:    { label: 'N/A',                      symbol: '○', icon: 'circle', colorVar: '--dim'   },
  verified_fail: { label: 'Check failed',             symbol: '✕', icon: 'x',      colorVar: '--crit'  },
  not_measured:  { label: 'Legacy',                   symbol: '–', icon: 'minus',  colorVar: '--faint' },
};

// downgrade_origin 분포 순서 + 메타 — cross-analysis downgrade_breakdown 소비. writer_true_downgraded
// (작성자 pass 주장 ↔ grader 불일치)가 가장 actionable. not_recorded(레거시 NULL)는 disagreement 아님 → muted.
// writer_true_downgraded is left out: the Check failed stat already counts it
const DOWNGRADE_BREAKDOWN_ORDER = ['writer_false', 'synthesized', 'not_recorded'];
const DOWNGRADE_BREAKDOWN_LABELS = {
  writer_false: 'Agent reported its own failure',
  synthesized:  'Rebuilt by the harness, no report',
  not_recorded: 'Older record, source not tracked',
};

// grader_verdict 문자열 → 표시 메타 조회. NULL/미인식 drift → 레거시 muted 폴백 (crit 회귀 차단).
function graderVerdictMetaO(verdict) {
  if (verdict == null) return GRADER_VERDICT_NULL_META;
  return GRADER_VERDICT_META[verdict] || GRADER_VERDICT_NULL_META;
}

// 렌더 심볼 SoT (FIX-D 중앙화) — 화면 로컬 meta.icon(Icon 이름)을 window.UI.Icon 으로 렌더.
//   aria-hidden 기본 장식 + stroke=currentColor → 감싸는 span 의 tone 색 상속(색+기호+텍스트 3중 인코딩 보존).
//   name 부재 시 미렌더 (드리프트 방어). 색은 호출부 wrapping 이 style={{color}} 로 공급.
function GlyphO({ name, size = 12, className = '' }) {
  const { Icon } = window.UI;
  return name ? <Icon name={name} size={size} className={className} /> : null;
}

// Pagination — 테이블 응답성 보존.
const PAGE_LIMIT_DEFAULT = 50;
// Needs-you rows shown before 'Show N more' — a full page of them buries Routine below the fold.
const NEEDS_YOU_PAGE_CAP = 10;

// Sort options — the backend allowlist's wire format (no trigger → hash → URL conversion)
const SORT_OPTIONS = [
  { value: 'record_ts:desc',      label: 'Newest first'  },
  { value: 'record_ts:asc',       label: 'Oldest first'  },
  { value: 'revision_count:desc', label: 'Most reworked' },
];

// 연속 5xx/network 30s 경과 시 'blocked' 상태로 전환.
const BACKEND_FAIL_THRESHOLD_MS = 30_000;

// 키워드 입력 debounce — 타이핑 중 request storm 방지.
const KEYWORD_DEBOUNCE_MS = 300;

// Distinct agents 는 현재 페이지 행 기준 — discovery 요청 회피.
// 페이지 외 agent 는 dropdown 미노출 → 페이지네이션 후 재선택.

// result enum → CSS 토큰 var 명. tone 은 RESULT_META(ui.jsx) SoT 가 결정 — 로컬 result→color 맵 금지(T-OUT-1).
//   ok/warn/crit/info 는 동명 토큰, needs_context(neutral tone) 만 화면 관례상 accent 강조 (4-KPI 밖 세그먼트).
const RESULT_COLOR_VAR = { ok: '--ok', warn: '--warn', crit: '--crit', info: '--info', neutral: '--accent' };

// result enum → 화면 표시 색 토큰 var. resolveResultMeta(ui.jsx) 경유 → 단일 출처 보장 (no local result→color map).
// closedAt 지정 시 종결 행은 --dim 으로 탈강조 — neutral tone 의 화면 관례색(--accent)은 강조라 부적합.
function resultColorVarO(result, closedAt) {
  const meta = window.UI.resolveResultMeta(result, closedAt);
  if (meta.closed) return '--dim';
  return RESULT_COLOR_VAR[meta.tone] || '--dim';
}

// DWC 종결 토글의 optimistic 상태 (clauded-docs doc-status-toggle 선례 미러 — pending Set + override Map).
// 순수 전이 함수로 분리해 pending 생명주기를 단위 테스트 가능하게 유지한다.
//   begin  → pending 진입 (중복 클릭 차단은 호출부 가드)
//   settle → 성공/실패 모두 pending 해제 · closedAt 있을 때만 override 기록 (실패 시 amber 유지)
const CLOSURE_STATE_EMPTY = { pendingIds: new Set(), closedOverrides: new Map() };

function buildClosureState(state, action) {
  const pendingIds = new Set(state.pendingIds);
  const closedOverrides = new Map(state.closedOverrides);
  if (action.type === 'begin') {
    pendingIds.add(action.id);
    return { pendingIds, closedOverrides };
  }
  if (action.type === 'settle') {
    pendingIds.delete(action.id);
    if (action.closedAt) closedOverrides.set(action.id, action.closedAt);
    return { pendingIds, closedOverrides };
  }
  return state;
}

// colorVar(--ok/--warn/--crit/--info) → head Status tone · non-tone (--dim/--faint/--accent) → 'neutral'
function toneFromColorVarO(colorVar) {
  const t = String(colorVar || '').replace(/^--/, '');
  return (t === 'ok' || t === 'warn' || t === 'crit' || t === 'info') ? t : 'neutral';
}

// KPI 4 버킷 — 라벨/색/기호는 RESULT_META SoT 에서 파생 (로컬 중복 맵 제거, T-OUT-1).
const ANALYTICS_KPI_ORDER = ['done', 'done_with_concerns', 'blocked', 'fail'];

// Attribution Health 상수 — /api/outcomes/attribution-daily 4-category 분해 (sum-complete, 색맹 안전 듀얼인코딩).
// 의미: literal_omission = actionable 위생 신호 · attribution_loss = 잔존 버그 신호(감소 모니터) · synthesized = 복구 산물(실패 아님).
const ATTRIBUTION_CATEGORY_ORDER = ['healthy', 'attribution_loss', 'literal_omission', 'synthesized'];
const ATTRIBUTION_CATEGORY_META = {
  healthy:          { label: 'Recorded',      symbol: '✓', icon: 'check', colorVar: '--ok'   },
  attribution_loss: { label: 'Untraceable',   symbol: 'ℹ', icon: 'info',  colorVar: '--info' },
  literal_omission: { label: 'Missing',       symbol: '✕', icon: 'x',     colorVar: '--crit' },
  synthesized:      { label: 'Reconstructed', symbol: '⚠', icon: 'warn',  colorVar: '--warn' },
};

// literal_omission 선택 기간 비율 → 심각도 밴드 (분모 = 선택 기간 전체 창).
const ATTRIBUTION_OMISSION_BANDS = [
  { max: 0.03,     colorVar: '--ok',   label: 'normal'   },
  { max: 0.08,     colorVar: '--warn', label: 'high'     },
  { max: Infinity, colorVar: '--crit', label: 'critical' },
];

// Channel liveness 표시 메타 — 3-상태 듀얼인코딩(기호+텍스트, 색 단독 의존 금지).
// 판정(alerting/eligible)은 서버가 내리고 카드는 그 값만 읽는다 → 임계값이 프런트에 재등장하지 않음.
const CHANNEL_LIVENESS_META = {
  alerting: { label: 'Silent',      colorVar: '--crit' },
  live:     { label: 'Recording',   colorVar: '--ok'   },
  low:      { label: 'Below floor', colorVar: '--info' },
};

// 채널 1건 → 표시 메타. eligible 하지 않은 채널의 침묵은 뉴스가 아니므로 'low' 로 내린다.
function channelLivenessMetaO(channel) {
  if (channel.alerting) return CHANNEL_LIVENESS_META.alerting;
  return channel.eligible ? CHANNEL_LIVENESS_META.live : CHANNEL_LIVENESS_META.low;
}

// literal_omission_breakdown → 'Missing report' 세부 3-분해 (budget-kill / truncated / missing).
//   세 값 합 = literal_omission window count (budget_truncation = attribution_source=='budget-truncation' 행).
//   'Missing report' 총계·비율은 불변 → 이 sub-line 은 그 count 의 내역만 표기 (rate 미변경).
//   부재/전-필드(레거시) 행 → null → sub-line 미렌더 (수치 fabrication 회피).
function buildLiteralOmissionBreakdownO(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return null;
  const budget    = Number(breakdown.budget_truncation)    || 0;
  const truncated = Number(breakdown.truncated_completion) || 0;
  const missing   = Number(breakdown.completion_missing)   || 0;
  if (budget + truncated + missing <= 0) return null;
  return { budget, truncated, missing };
}

// window_summary.dev_scope → DEV-agent truncation/synthesized baseline (StatRow).
//   同一 window 텔레메트리의 DEV 하위집합 — no-[COMPLETION]/budget-truncation 실패 모드를
//   DEV 에이전트 한정으로 가시화 + rolling baseline(비율 자체가 baseline).
//   DEV window 에 귀속행 0건(부재/빈 subset) → null (0/0 clutter 회피).
function AttributionDevScopeO({ devScope }) {
  if (!devScope || typeof devScope !== 'object') return null;
  const total = Number(devScope.total_attributed) || 0;
  if (total <= 0) return null;
  const truncCount = Number(devScope.budget_truncation_count) || 0;
  const { Stack, StatRow } = window.UI;
  const stats = [
    { key: 'budget_kill', label: 'Budget-kill rate', value: formatRateO(devScope.budget_truncation_rate), context: `${formatIntO(truncCount)} of ${formatIntO(total)}` },
    { key: 'synthesized', label: 'Synthesized rate', value: formatRateO(devScope.synthesized_rate), context: 'recovered from missing report' },
  ];
  return (
    <Stack gap="label">
      <div className="fs-meta text-dim">DEV agents, truncation baseline</div>
      <StatRow stats={stats}/>
    </Stack>
  );
}

// budget_truncation_by_agent → 'Budget-killed subagents (7d)' 컴팩트 미니리스트 (agent → count, 서버가 count DESC 정렬).
//   빈 배열/부재 → null (저볼륨 신호라 non-empty 일 때만 노출 · 빈-상태 clutter 회피).
function AttributionBudgetKillListO({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const { Stack } = window.UI;
  return (
    <Stack gap="label">
      <div className="fs-meta text-dim">Budget-killed subagents (7d)</div>
      <Stack gap="stack">
        {rows.map((r) => (
          <div key={r.agent} className="flex items-center justify-between fs-meta tabular-nums">
            <span className="text-dim truncate" style={{ maxWidth: 220 }} title={r.agent}><window.UI.AgentName name={r.agent}/></span>
            <span className="text-ink font-semibold tabular-nums">{formatIntO(r.count)}</span>
          </div>
        ))}
      </Stack>
    </Stack>
  );
}

// 일별 그리드 막대 수 — 비활성일은 series 누락 → FE 가 0-fill (활동일만 backend 전송).
const ATTRIBUTION_GRID_BARS = 30;

// 헤더의 단일 window 컨트롤 — band · ledger · 분석이 같은 창을 읽는다 (사이드바 period 병합).
const ANALYTICS_PERIOD_OPTIONS = [
  { value: 7,  label: '7d'  },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

// 분석 라우트는 {7,30,90} 만 받는다 → 그 밖의 ledger 창(북마크된 'all')은 드롭 대신 최대 창으로 해소.
function analyticsDaysO(days) {
  return ANALYTICS_PERIOD_OPTIONS.some((o) => o.value === days) ? days : 90;
}

// the folded window is always 7/30/90 → the prior window is always a valid opt-in
function buildAnalyticsUrlO(days) {
  return `/api/outcomes/cross-analysis?days=${days}&prior_window=1`;
}

// Needs-you 질의 — 서버 parseFilters 는 needs_attention 에 'true'|'false' 만 받는다(그 밖 → 400).
// 창은 analyticsDaysO 로 접힌 분석 창: 타일 1 의 분자·분모가 다른 창을 읽으면 비율이 성립하지 않는다.
// limit=1 → total 만 소비.
function buildAttentionParamsO(days, part = {}) {
  return new URLSearchParams({ days: String(days), needs_attention: 'true', ...part, limit: '1' });
}

// disjoint split of the needs-you predicate — a flag claims a record first, so no record sits in two parts
const ATTENTION_PARTS_O = [
  { key: 'flagged', filter: { review_flag: 'true' } },
  { key: 'fail', filter: { review_flag: 'false', result: 'fail' } },
  { key: 'blocked', filter: { review_flag: 'false', result: 'blocked' } },
  { key: 'open', filter: { review_flag: 'false', result: 'done_with_concerns' } },
];

// headline + parts in one wave → the parts are read beside the total they add up to; only the headline needs a prior count
async function fetchAttentionO(days, signal) {
  const urls = [{ prior_window: '1' }, ...ATTENTION_PARTS_O.map((part) => part.filter)]
    .map((filter) => `/api/outcomes/search?${buildAttentionParamsO(days, filter).toString()}`);
  const [head, ...parts] = await Promise.all(urls.map((url) => fetchJsonO(url, signal)));
  return {
    total: Number(head?.total) || 0,
    priorTotal: head?.prior_window ? Number(head.prior_window.total) || 0 : null,
    parts: Object.fromEntries(ATTENTION_PARTS_O.map((part, i) => [part.key, Number(parts[i]?.total) || 0])),
  };
}

// 자가개선 데몬 사이클 raw 이벤트 로그 — Learning 화면에서 이관(operational data, 집계 신호 아님).
//   소유 endpoint: /api/improvement/loop-events (core.autoagent_loop_events per-cycle stage stream).
const LOOP_EVENTS_URL = '/api/improvement/loop-events?limit=50';

// daemon eval_result → glyph + word (tone color + symbol + label, color-blind safe)
//   verified=✓ ok · reject/fail=✕ crit · *_dryrun=⚠ warn (dry run — not applied) · anything else falls back to ℹ info.
function loopResultMetaO(result) {
  if (result === 'verified') return { tone: 'ok', symbol: '✓', icon: 'check', label: 'Passed' };
  if (result === 'reject' || result === 'fail') return { tone: 'crit', symbol: '✕', icon: 'x', label: result === 'fail' ? 'Failed' : 'Declined' };
  if (typeof result === 'string' && result.endsWith('_dryrun')) return { tone: 'warn', symbol: '⚠', icon: 'warn', label: 'Dry run' };
  return { tone: 'info', symbol: 'ℹ', icon: 'info', label: result || window.UI.EMPTY_VALUE_TEXT };
}

// 비-actionable pseudo-agent ID — attribution-fallback 버킷 (실 agent 아님).
// agents.jsx NON_ACTIONABLE_AGENT_IDS 와 동일 집합 (named-token 정합, T14).
// 서버가 registry 게이트(T7)하므로 canonical agent 는 이 집합에 절대 없음 → 집합은
// O2 include_all 포렌식 뷰 + 빈-레지스트리 fail-open 에서 sentinel 이 표면화될 때만 적용.
const UNKNOWN_AGENT_ID_O = 'unknown';
const SYNTHETIC_SENTINEL_AGENT_ID_O = 'subagent_stop_missing';
const NON_ACTIONABLE_AGENT_IDS_O = new Set([UNKNOWN_AGENT_ID_O, SYNTHETIC_SENTINEL_AGENT_ID_O]);

// T14 double-filter guard — 서버 registry 게이트(T7) 이후, 이 클라이언트 시각 집합은
// canonical agent 에는 절대 매칭되지 않으므로 "정말 non-actionable 인 sentinel 만" 표식.
// Pure: agent id + 시각 집합 → non-actionable 여부. 두 화면(agents.jsx 미러)이 동일
// 게이트를 균일 적용하도록 인라인 `.has` 를 중앙화 (uneven cross-screen application 제거).
function isNonActionableAgentO(agentId, visualSet = NON_ACTIONABLE_AGENT_IDS_O) {
  return visualSet.has(agentId);
}

// Polar-mismatch cross-tab 상수 — /api/outcomes/cross-analysis cells[] (행=confidence × 열=metric_pass, 서버가 is_polar_mismatch 계산).
// polar mismatch(overconfidence high+fail · underconfidence low+pass) = core-outcome-record.md Mismatch Review Trigger → ⚠ 기호 표식.
const CROSSTAB_CONFIDENCE_ROWS = ['high', 'medium', 'low', 'null'];
const CROSSTAB_METRIC_COLS = [
  { key: 'true',  label: 'Pass' },
  { key: 'false', label: 'Fail' },
  { key: 'null',  label: 'None' },
];

// cells[].metric_pass (boolean|null) → 'true'|'false'|'null' 문자열 키 (열 매핑용).
function crosstabMetricKeyO(metricPass) {
  if (metricPass === true)  return 'true';
  if (metricPass === false) return 'false';
  return 'null';
}

// cells[].confidence (string|null) → 'high'|'medium'|'low'|'null' 행 키.
function crosstabConfidenceKeyO(confidence) {
  return confidence === null || confidence === undefined ? 'null' : String(confidence);
}

// 화면 전용 inline CSS — render 마다 string 재할당 회피 위해 모듈 상수.
const SCREEN_OUTCOMES_CSS = `
.outcome-md { font-size: var(--fs-body); line-height: 1.6; color: rgb(var(--ink)); font-family: 'Pretendard Variable', Pretendard, ui-sans-serif, system-ui, sans-serif; }
/* md 헤딩 3레벨 → title 토큰 공통 (동일 content-level) · 시각 위계는 font-weight 600 + margin 으로 보존 */
.outcome-md h1, .outcome-md h2, .outcome-md h3, .outcome-md h4 { font-weight: 600; margin: var(--space-3) 0 var(--space-1_5); line-height: 1.3; }
.outcome-md h1, .outcome-md h2, .outcome-md h3 { font-size: var(--fs-title); }
.outcome-md p { margin: 6px 0; }
.outcome-md ul, .outcome-md ol { margin: 6px 0; padding-left: var(--space-6); }
.outcome-md li { margin: 2px 0; }
.outcome-md code { font-family: 'JetBrains Mono', monospace; font-size: var(--fs-meta); background: rgb(var(--sunken)); padding: 0 var(--space-1); border-radius: 3px; }
.outcome-md pre { font-family: 'JetBrains Mono', monospace; font-size: var(--fs-meta); background: rgb(var(--sunken)); padding: var(--space-2) var(--space-3); border-radius: 6px; border: 1px solid rgb(var(--line)); overflow-x: auto; }
.outcome-md pre code { background: transparent; padding: 0; }
.outcome-md blockquote { border-left: 3px solid rgb(var(--accent)); padding: 2px 12px; margin: 8px 0; color: rgb(var(--dim)); background: rgb(var(--sunken) / 0.4); }
.outcome-md a { color: rgb(var(--ink)); text-decoration: underline; text-underline-offset: 2px; }
.outcome-md table { border-collapse: collapse; margin: 8px 0; font-size: var(--fs-meta); }
.outcome-md th, .outcome-md td { border: 1px solid rgb(var(--line)); padding: 4px 8px; text-align: left; }
.outcome-md th { background: rgb(var(--sunken)); font-weight: 500; }
.outcome-row { transition: background 120ms; }
.outcome-row:hover { background: rgb(var(--accent) / 0.06); }
@media (prefers-reduced-motion: reduce) {
  .outcome-row { transition: none; }
}
`;

function ScreenOutcomes({ onNav }) {
  const {
    PageHeader, TypeScaleStyle, FreshnessStamp, RefreshButton, PageErrorBanner,
    INITIAL_REGION_STATE, getRegionSummary, getSharedFailure,
  } = window.UI;

  // Filter state — URL hash 초기화 → 북마크 / 직접링크 복원.
  const [filter, setFilter] = useStateO(() => readFilterFromHashO());
  const [page,   setPage]   = useStateO(0);
  const [sort,   setSort]   = useStateO(() => readSortFromHashO());

  // 키워드 입력은 filter 와 분리 → debounce 가능 (request thrashing 회피).
  const [keywordInput, setKeywordInput] = useStateO(filter.q || '');

  const [searchState, setSearchState] = useStateO(INITIAL_REGION_STATE);
  // ledger 의 Needs-you 섹션 — 페이지가 아닌 창 전체를 읽는다(stream 1 attention 술어).
  const [needsYouState, setNeedsYouState] = useStateO(INITIAL_REGION_STATE);

  // 창은 filter.days 하나 — 헤더 컨트롤이 ledger 와 분석을 함께 움직인다 (두 period 컨트롤 병합).
  const analyticsPeriod = analyticsDaysO(filter.days);
  const [analyticsState,  setAnalyticsState]  = useStateO(INITIAL_REGION_STATE);

  // Attribution Health — /api/outcomes/attribution-daily (analyticsPeriod 와 동일 window).
  const [attributionState, setAttributionState] = useStateO(INITIAL_REGION_STATE);

  // Channel liveness — /api/outcomes/channel-liveness. analyticsPeriod 에 연동하지 않는다:
  // eligibility 는 peak-daily 를 읽으므로 창을 넓히면 수 주 전 버스트로 계속 자격이 유지된다.
  const [channelLivenessState, setChannelLivenessState] = useStateO(INITIAL_REGION_STATE);

  // Needs-you 모집단 — 서버 attention 술어(needs_attention) 를 그대로 읽는다. limit=1 → total 만 소비.
  const [attentionState, setAttentionState] = useStateO(INITIAL_REGION_STATE);

  // Loop-events raw 로그 — Learning 에서 이관(operational data). period 무관 all-time → refreshTick 만 의존.
  const [loopEventsState, setLoopEventsState] = useStateO(INITIAL_REGION_STATE);

  // Detail modal — active row + body_md (optional).
  const [detailRow,   setDetailRow]   = useStateO(null);
  const [isNeedsYouExpanded, setNeedsYouExpanded] = useStateO(false);
  const [detailState, setDetailState] = useStateO({ status: 'idle', data: null, error: null });

  const [refreshTick, setRefreshTick] = useStateO(0);

  // as-of = 마지막으로 성공한 fetch 의 수신 시각 (요청 시각 아님) — 화면 전체에 하나만 둔다.
  const [asOfAt, setAsOfAt] = useStateO(null);
  const markFreshO = useCallbackO(() => setAsOfAt(new Date().toISOString()), []);

  // T13 (O2) — canonical agent facet 소스 (registry 게이트된 /api/agents/summary).
  const [canonicalAgentsState, setCanonicalAgentsState] = useStateO(INITIAL_REGION_STATE);

  // T7 (O2) — forensic 'show all' 토글: include_all 파라미터로 서버 registry 게이트 해제.
  const [includeAll, setIncludeAll] = useStateO(false);

  // DWC 종결 토글 상태 — 서버 응답 전 즉시 반영(optimistic) + in-flight 중복 PATCH 차단.
  const [closureState, setClosureState] = useStateO(CLOSURE_STATE_EMPTY);

  const markClosedO = useCallbackO(async (id) => {
    if (closureState.pendingIds.has(id)) return;
    setClosureState((prev) => buildClosureState(prev, { type: 'begin', id }));
    let closedAt = null;
    try {
      const res = await fetch(`/api/outcomes/${id}/close`, { method: 'PATCH', headers: { Accept: 'application/json' } });
      if (res.ok) {
        const body = await res.json();
        closedAt = body && body.closed_at ? body.closed_at : null;
      }
    } catch (_e) {
      // 네트워크 실패 → override 미기록 = 행이 amber 로 남는다 (거짓 종결 표시 차단).
    }
    setClosureState((prev) => buildClosureState(prev, { type: 'settle', id, closedAt }));
  }, [closureState.pendingIds]);

  const filterAbortRef = useRefO(null);
  const detailAbortRef = useRefO(null);

  // first-failure timestamp — 30s 경과 시 'error' → 'blocked' 전환용.
  const firstFailAtRef = useRefO(null);

  // 키워드 debounce → filter.q 패치. 초기 마운트(input == filter.q) 시 skip.
  useEffectO(() => {
    if (keywordInput === (filter.q || '')) return;
    const id = setTimeout(() => {
      setFilter((prev) => ({ ...prev, q: keywordInput }));
      setPage(0);
    }, KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [keywordInput]);

  // URL hash 동기화 — page 는 의도적으로 share-URL 에서 제외.
  useEffectO(() => {
    writeFilterToHashO(filter, sort);
  }, [filter, sort]);

  const triggerRefresh = useCallbackO(() => setRefreshTick((t) => t + 1), []);

  const setWindowDays = useCallbackO((days) => {
    setFilter((prev) => ({ ...prev, days }));
    setPage(0);
  }, []);

  const resetFilter = useCallbackO(() => {
    setFilter(defaultFilterO());
    setKeywordInput('');
    setSort('record_ts:desc');
    setPage(0);
    setIncludeAll(false);
  }, []);

  // one filter-axis patch from the bar
  const patchFilter = useCallbackO((patch) => {
    setFilter((prev) => ({ ...prev, ...patch }));
    setPage(0);
  }, []);

  // 탐색기 fetch — filter / sort / page / refresh 변경 시 재실행.
  useEffectO(() => {
    const { putRegionRequest, putRegionData } = window.UI;
    const searchUrl = buildSearchUrlO(filter, sort, page, PAGE_LIMIT_DEFAULT, includeAll);
    const ctrl = new AbortController();
    filterAbortRef.current?.abort();
    filterAbortRef.current = ctrl;

    setSearchState((s) => putRegionRequest(s, searchUrl, ctrl));

    fetchJsonO(searchUrl, ctrl.signal)
      .then((data) => {
        firstFailAtRef.current = null;
        markFreshO();
        setSearchState((s) => putRegionData(s, ctrl, data));
      })
      .catch((err) => {
        if (err?.name !== 'AbortError' && firstFailAtRef.current == null) firstFailAtRef.current = Date.now();
        const elapsedMs = firstFailAtRef.current == null ? 0 : Date.now() - firstFailAtRef.current;
        setSearchState((s) => putSearchFailureO(s, ctrl, err, elapsedMs));
      });

    return () => ctrl.abort();
  }, [filter, sort, page, refreshTick, includeAll]);

  // page 무관 — Needs-you 는 매 페이지 같은 창 전체 집합이라 page hop 에 재요청하지 않는다.
  useEffectO(() => {
    return runRegionFetchO(setNeedsYouState, buildNeedsYouUrlO(filter, sort, PAGE_LIMIT_DEFAULT, includeAll));
  }, [filter, sort, refreshTick, includeAll]);

  // 분석 fetch — 창 변경 시 재실행. AbortController 분리 → 탐색기 wave 와 독립.
  useEffectO(() => {
    return runRegionFetchO(setAnalyticsState, buildAnalyticsUrlO(analyticsPeriod), {
      mapData: buildAnalyticsDataO,
      onData: markFreshO,
    });
  }, [analyticsPeriod, refreshTick]);

  // Attribution Health fetch — 같은 window, AbortController 공유 회피 위해 별도 effect.
  // analyticsPeriod {7,30,90} 가 backend 의 ALLOWED_DAYS_NUMERIC 와 동일 → param 검증 추가 불필요.
  useEffectO(() => {
    return runRegionFetchO(setAttributionState, `/api/outcomes/attribution-daily?days=${analyticsPeriod}`, { onData: markFreshO });
  }, [analyticsPeriod, refreshTick]);

  // Channel liveness fetch — days 파라미터 미전달 → 라우트 기본 창을 그대로 사용(카드가 창 폭을
  // 재선언하지 않도록). 표시 라벨은 응답의 days 에서 파생.
  useEffectO(() => {
    return runRegionFetchO(setChannelLivenessState, '/api/outcomes/channel-liveness', { onData: markFreshO });
  }, [refreshTick]);

  // Loop-events raw 로그 fetch — period 무관(all-time stream). AbortController 분리 → 부분 실패 격리.
  useEffectO(() => {
    return runRegionFetchO(setLoopEventsState, LOOP_EVENTS_URL, { onData: markFreshO });
  }, [refreshTick]);

  // T13 (O2) — canonical agent facet 소스 fetch. 레코드 로그는 서버가 registry 로
  // 게이트(T7)하므로 agent facet 은 registry 집합을 나열 (페이지 rows 아님). 소스는
  // /api/agents/summary (registry 게이트 · 활동 스코프) — 넓은 90d 창 + 최대 limit 으로
  // 활성 registry 를 커버. 실패 → 빈 facet (graceful · 'All' 옵션은 항상 유지).
  // explorer 필터와 독립 → 페이지네이션·기간 변경에도 안정.
  useEffectO(() => {
    return runRegionFetchO(setCanonicalAgentsState, '/api/agents/summary?days=90&order=runs&limit=50');
  }, [refreshTick]);

  useEffectO(() => {
    // include_all 미전송 — 분모(cross-analysis)가 registry 스코프이므로 분자도 같은 스코프를 읽는다.
    const params = buildAttentionParamsO(analyticsPeriod);
    return runRegionFetchO(setAttentionState, `/api/outcomes/search?${params.toString()}`, {
      onData: markFreshO,
      load: (_url, signal) => fetchAttentionO(analyticsPeriod, signal),
    });
  }, [analyticsPeriod, refreshTick]);

  // Detail fetch — modal open / nav 시 active row 변경에 반응.
  useEffectO(() => {
    if (!detailRow) {
      setDetailState({ status: 'idle', data: null, error: null });
      return;
    }
    if (!detailRow.has_body_md) {
      // body_md 없음 → fetch skip + summary fallback.
      setDetailState({ status: 'ready', data: { ...detailRow, body_md: null }, error: null });
      return;
    }

    const ctrl = new AbortController();
    detailAbortRef.current?.abort();
    detailAbortRef.current = ctrl;

    setDetailState({ status: 'loading', data: null, error: null });

    fetchJsonO(`/api/outcomes/${encodeURIComponent(detailRow.id)}`, ctrl.signal)
      .then((data) => setDetailState({ status: 'ready', data, error: null }))
      .catch((err) => handleErrorO(err, setDetailState));

    return () => ctrl.abort();
  }, [detailRow]);

  const rows         = searchState.status === 'ready' ? (searchState.data?.rows ?? [])           : [];
  const totalMatched = searchState.status === 'ready' ? (Number(searchState.data?.total) || 0)   : 0;
  const isSearchReady = searchState.status === 'ready';
  // a refresh that shrinks the match count under a held page → step back to the last page, so the next search asks for rows that exist
  useEffectO(() => {
    if (isSearchReady) setPage((held) => getClampedPageO(held, totalMatched, PAGE_LIMIT_DEFAULT));
  }, [isSearchReady, totalMatched]);
  // not read or failed → null: Needs you falls back to the page's own split
  const ledgerNeedsYou = needsYouState.status === 'ready'
    ? { rows: needsYouState.data?.rows ?? [], total: Number(needsYouState.data?.total) || 0 }
    : null;
  const needsYouCap = isNeedsYouExpanded ? null : NEEDS_YOU_PAGE_CAP;
  // drawer Prev/Next + counter walk the grouped order the ledger draws, not the search order
  const displayRows = getLedgerDisplayRowsO(buildLedgerSectionsO(rows, closureState, ledgerNeedsYou, needsYouCap));

  // T13 (O2) — facet 옵션을 현재 페이지 rows 대신 canonical registry 집합에서 생성
  // (페이지네이션 안정). registry 소스는 /api/agents/summary 응답의 agent_id 들.
  const canonicalAgentKeys = useMemoO(
    () => extractCanonicalAgentIdsO(canonicalAgentsState.status === 'ready' ? canonicalAgentsState.data : null),
    [canonicalAgentsState],
  );
  const distinctAgents = useMemoO(() => buildAgentFacetOptionsO(canonicalAgentKeys), [canonicalAgentKeys]);

  // Modal navigation — 현재 페이지 내 prev/next 만 지원. cross-page (TODO MON-OUTCOMES-NAV-PERSIST):
  // 가장자리 진입 시 page hop + index 복원이 필요해 v1 에서는 페이지네이션으로 더 로드 후 재선택.
  const handleNavDetail = useCallbackO((direction) => {
    if (!detailRow || displayRows.length === 0) return;
    const idx = displayRows.findIndex((r) => r.id === detailRow.id);
    if (idx < 0) return;
    const nextIdx = direction === 'next' ? idx + 1 : idx - 1;
    if (nextIdx < 0 || nextIdx >= displayRows.length) return;
    setDetailRow(displayRows[nextIdx]);
  }, [detailRow, displayRows]);

  const stampRegions = [searchState, needsYouState, analyticsState, attributionState, channelLivenessState, loopEventsState, attentionState];
  // keyed by region card, not payload → one payload feeding four cards is one outage, and each covered card goes quiet
  const sharedFailure = getSharedFailure(buildRegionFailuresO({
    'the status band': analyticsState, 'the needs-you count': attentionState, 'the record ledger': searchState,
    'needs-you records': needsYouState, 'by-agent failures': analyticsState, 'record attribution': attributionState,
    'recording channels': channelLivenessState, 'check results': analyticsState, 'cross table': analyticsState,
    'run events': loopEventsState,
  }));
  const freshness = { at: asOfAt, regions: stampRegions };
  const isRefreshing = getRegionSummary(stampRegions).isBusy;
  // busy only while a failed region is being re-read — another panel's first load is not this Retry
  const isRetrying = stampRegions.some((region) => region.error != null && region.busy);
  // every region card retries through the page refresh and goes quiet under a shared outage
  const regionRetry = { onRetry: triggerRefresh, shared: sharedFailure };
  const taskTypeRows = analyticsState.data?.overall?.task_type_grader_breakdown;

  return (
    <div className="flex flex-col min-h-0">
      {/* 공유 타입스케일(fs 토큰 + fs 클래스) 마운트 — SPA 단일 screen 모델: outcomes 활성 시 토큰·클래스 가용화 (ui.jsx 정의 소비, 미정의 시 클래스 no-op 회귀 차단). */}
      <TypeScaleStyle/>
      <style>{SCREEN_OUTCOMES_CSS}</style>
      <div className="flex-shrink-0">
        <PageHeader
          title="Task results"
          sub="Agent task outcomes"
          freshness={<FreshnessStamp {...getFreshnessInputO(asOfAt, stampRegions)}/>}
          range={<WindowSeg value={filter.days} onChange={setWindowDays}/>}
          refresh={
            <RefreshButton
              isBusy={isRefreshing}
              hasRead={asOfAt != null}
              onRefresh={triggerRefresh}
              label="Refresh task results"/>
          }
        />
      </div>

      {sharedFailure && (
        <div className="mb-section flex-shrink-0">
          <PageErrorBanner sources={sharedFailure.sources} error={sharedFailure.error} onRetry={triggerRefresh}
            isBusy={isRetrying} focusTargetId={REGION_CARD_IDS.statusBand}/>
        </div>
      )}

      <AlarmLaneO channelLivenessState={channelLivenessState} searchState={searchState}/>

      <StatusBandO
        analyticsState={analyticsState}
        attentionState={attentionState}
        windowDays={analyticsPeriod}
        freshness={freshness}
        {...regionRetry}
      />

      {/* page scroll only — no inner scroller; the filters sit in the Results card's filter bar, so the ledger takes the full width */}
      <div className="mt-section">
        <ResultTableCard
          state={searchState}
          rows={rows}
          totalMatched={totalMatched}
          page={page}
          limit={PAGE_LIMIT_DEFAULT}
          sort={sort}
          filter={filter}
          onPageChange={setPage}
          onSortChange={(v) => { setSort(v); setPage(0); }}
          onResetFilter={resetFilter}
          filterControls={{
            keywordInput,
            distinctAgents,
            includeAll,
            onPatchFilter: patchFilter,
            onKeywordChange: setKeywordInput,
            onToggleIncludeAll: (v) => { setIncludeAll(v); setPage(0); },
          }}
          onRowClick={setDetailRow}
          {...regionRetry}
          needsYou={ledgerNeedsYou}
          needsYouCap={needsYouCap}
          onToggleNeedsYou={() => setNeedsYouExpanded((isExpanded) => !isExpanded)}
          closure={{ pendingIds: closureState.pendingIds, closedOverrides: closureState.closedOverrides, onMarkClosed: markClosedO }}
        />
      </div>

      {/* Reporting-trust signals are status → stay open; only the breakdown (daily chart, budget-kill list) folds into detail. */}
      {/* per-agent table full width — a half-width column beside the taller Reporting health stack leaves a hole; peer reporting cards pair at equal height */}
      <div className="mt-section">
        <AgentFailureTableO state={analyticsState} {...regionRetry}/>
      </div>
      <window.UI.Disclosure kind="status" title="Reporting health" sub={reportingHealthSummaryO(channelLivenessState, attributionState)} className="mt-section">
        <window.UI.Stack>
          <window.UI.SplitRow ratio="1:1-wide" layout="divided">
            <AttributionHealthBlock state={attributionState} period={analyticsPeriod} {...regionRetry}/>
            <ChannelLivenessBlock state={channelLivenessState} {...regionRetry}/>
          </window.UI.SplitRow>
          <window.UI.Disclosure kind="detail" level={3} isInline title="Daily breakdown" sub="Budget-killed subagents">
            <AttributionBreakdownO state={attributionState}/>
          </window.UI.Disclosure>
        </window.UI.Stack>
      </window.UI.Disclosure>

      <window.UI.Disclosure kind="status" title="Self-report quality" sub={selfReportSummaryO(analyticsState)} className="mt-section">
        <window.UI.Stack>
          <window.UI.SplitRow ratio="1:1" layout="divided">
            <GraderBreakdownBlock state={analyticsState} {...regionRetry}/>
            <CrosstabBlock state={analyticsState} {...regionRetry}/>
          </window.UI.SplitRow>
          <window.UI.Disclosure kind="detail" level={3} isInline title="By task type"
            tone={getTaskTypeFoldToneO(taskTypeRows)}
            sub={getTaskTypeFoldSubO(taskTypeRows)}>
            <TaskTypeGraderCrosstabO rows={taskTypeRows}/>
          </window.UI.Disclosure>
        </window.UI.Stack>
      </window.UI.Disclosure>

      {/* Learning 에서 이관된 raw 데몬 사이클 이벤트 로그 — operational data (집계 신호 아님 · W3-T3/T7). */}
      <window.UI.Disclosure kind="detail" title="Learning-run events" sub={loopEventsSummaryO(loopEventsState)} isFlush className="mt-section">
        <LoopEventsRegion state={loopEventsState} {...regionRetry}/>
      </window.UI.Disclosure>

      {detailRow && (
        <DetailModal
          detailRow={detailRow}
          detailState={detailState}
          rows={displayRows}
          onClose={() => setDetailRow(null)}
          onNav={handleNavDetail}
        />
      )}
    </div>
  );
}

// 예약 레인 — 침묵한 기록 채널과 지속 장애(blocked)만 싣는다. payload 실패 배너는 소유 그룹 자리에 둔다
// (stream 3) — 레인에 쌓으면 어느 그룹이 비었는지 떨어져 읽힌다.
function AlarmLaneO({ channelLivenessState, searchState }) {
  const silent = channelLivenessState.status === 'ready' ? (channelLivenessState.data?.alerting || []) : [];
  const isBlocked = searchState.status === 'blocked';

  if (silent.length === 0 && !isBlocked) return null;

  return (
    <div className="flex flex-col gap-list mb-section flex-shrink-0" role="region" aria-label="Alarms">
      {isBlocked && <BlockedBannerO detail={searchState.error}/>}
      {silent.length > 0 && <SilentChannelRowO channels={silent}/>}
    </div>
  );
}

// 고volume 채널의 침묵은 다른 모든 카드에서 '품질 변화' 로 위장한다 → 레인 행 자격.
function SilentChannelRowO({ channels }) {
  const { AlertCard } = window.UI;
  return (
    <AlertCard
      tone="crit"
      title={`${channels.length === 1 ? 'Silent channel' : 'Silent channels'}: ${channels.join(', ')}`}
      body="Was writing daily and has recorded nothing past the silence threshold."/>
  );
}

// busy or failed regions → the stamp never claims fresh while a panel is refreshing or failed
function getFreshnessInputO(asOfAt, regions) {
  return { at: asOfAt, regions };
}

// { source → region } → getSharedFailure entries; source names read inside "Couldn't load …"
function buildRegionFailuresO(regionsBySource) {
  return Object.entries(regionsBySource).map(([source, region]) => ({ source, error: region.error }));
}

function WindowSeg({ value, onChange }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Time range">
      {ANALYTICS_PERIOD_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={value === opt.value ? 'active' : ''}
          onClick={() => onChange(opt.value)}
          role="radio"
          aria-checked={value === opt.value}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// 미적재 payload 의 요약 토큰 — loading 과 실패를 구분하고, 어느 쪽도 '이상 없음' 으로 읽히지 않게.
function getUnloadedSummaryO(status) {
  return status === 'loading' ? 'Loading…' : 'Unavailable';
}

// the fold's worst state across both blocks, never a repeat of a block's own all-clear → null when nothing is wrong
function reportingHealthSummaryO(channelLivenessState, attributionState) {
  const alerting = channelLivenessState.status === 'ready' ? channelLivenessState.data?.alerting || [] : [];
  if (alerting.length > 0) return `${formatIntO(alerting.length)} ${alerting.length === 1 ? 'channel' : 'channels'} silent`;
  const summary = attributionState.status === 'ready' ? attributionState.data?.window_summary : null;
  const band = summary ? getAttributionOmissionBandO(summary.literal_omission_rate) : null;
  if (band && band.colorVar !== '--ok') return `Missing reports ${band.label}`;
  const unloaded = [channelLivenessState, attributionState].find((state) => state.status !== 'ready');
  return unloaded ? getUnloadedSummaryO(unloaded.status) : null;
}

function selfReportSummaryO(analyticsState) {
  if (analyticsState.status !== 'ready') return getUnloadedSummaryO(analyticsState.status);
  const overall = analyticsState.data?.overall;
  return `${formatIntO(window.UI.getWriterTotal(overall))} of ${formatIntO(Number(overall?.total) || 0)} self-reported`;
}

function loopEventsSummaryO(loopEventsState) {
  if (loopEventsState.status !== 'ready') return getUnloadedSummaryO(loopEventsState.status);
  const events = loopEventsState.data?.events;
  return `${formatIntO(Array.isArray(events) ? events.length : 0)} recent cycle events`;
}

// Needs-you tile → ledger 의 창 전체 Needs-you 헤딩 (hash 라우터라 href 앵커 대신 focus 이동).
const LEDGER_NEEDS_YOU_ID = 'ledger-needs-you';
// focus lands on a region's card when a focused Retry leaves on recovery
const REGION_CARD_IDS = {
  statusBand: 'outcomes-status-band',
  agentFailures: 'outcomes-agent-failures',
  attribution: 'outcomes-attribution',
  channels: 'outcomes-channels',
  checks: 'outcomes-checks',
  crosstab: 'outcomes-crosstab',
  loopEvents: 'outcomes-loop-events',
  ledger: 'outcomes-ledger',
};

// Status band — 4 타일. 값은 모집단·창과 용접되고, tone 은 글리프에만 탄다 (39578 §D-§E).

// 타일 tone/값 산출 — 임계 판정은 공유 SoT(window.UI.outcomeShareTone) 뿐이고 여기서 두 번째 규칙을 만들지 않는다.
// 모집단이 low-N 이면 tone 주장을 포기한다(neutral) — 소표본의 한 건이 crit 으로 보이면 안 된다.
function buildStatusBandTilesO(data, attentionCount) {
  const {
    getWriterTotal, outcomeShareTone, LOW_N_MIN,
    OUTCOME_BREAKAGE_CRIT_SHARE, OUTCOME_OPEN_CAVEAT_WARN_SHARE, OUTCOME_MISSING_REPORT_WARN_SHARE,
  } = window.UI;

  const byResult    = data?.byResultCount || {};
  const total       = Number(data?.overall?.total) || 0;
  const writerTotal = getWriterTotal(data?.overall);
  const broken      = (byResult.fail || 0) + (byResult.blocked || 0);
  const omitted     = Math.max(0, total - writerTotal);
  // /search attention 술어는 오염 창 행을 빼지 않는다 → 분모에 excluded_poisoned_count 를 되돌린다.
  const attentionTotal = total + (Number(data?.overall?.excluded_poisoned_count) || 0);
  // 두 모집단은 서로 다른 사실을 센다 — writer-emitted 사실은 writerTotal, 창 전체 사실은 total.
  const hasWriterFloor    = writerTotal >= LOW_N_MIN;
  const hasRecordFloor    = total >= LOW_N_MIN;
  const hasAttentionFloor = attentionTotal >= LOW_N_MIN;

  return [
    {
      key: 'attention',
      label: 'Needs you',
      count: attentionCount,
      // 서버 attention 술어는 복구행을 빼지 않는다 → 분모도 창 전체 기록. writerTotal 이면 100% 초과 가능.
      population: attentionTotal,
      tone: !hasAttentionFloor || attentionCount === null
        ? 'neutral'
        : (outcomeShareTone(attentionCount, attentionTotal, OUTCOME_OPEN_CAVEAT_WARN_SHARE, 'warn') || 'ok'),
      hint: 'Records in the window, quarantined included, flagged for review, failed, blocked, or carrying an unclosed caveat',
      jumpTo: LEDGER_NEEDS_YOU_ID,
    },
    {
      key: 'broken',
      label: 'Failed or blocked',
      count: broken,
      population: writerTotal,
      tone: !hasWriterFloor
        ? 'neutral'
        : (outcomeShareTone(broken, writerTotal, OUTCOME_BREAKAGE_CRIT_SHARE, 'crit') || 'ok'),
      hint: 'Writer-emitted records whose result is fail or blocked',
    },
    {
      key: 'recorded',
      // 'Recorded properly' = attribution healthy 모집단 전용 라벨 — writer 발신 전체(untraceable 포함)는 다른 이름.
      label: 'Self-reported',
      count: writerTotal,
      population: total,
      // 누락 보고는 여기 글리프가 유일한 등급 채널 — 레인 행으로 올리지 않는다.
      tone: !hasRecordFloor
        ? 'neutral'
        : (outcomeShareTone(omitted, total, OUTCOME_MISSING_REPORT_WARN_SHARE, 'warn') || 'ok'),
      hint: 'Records the agent emitted itself; the rest were reconstructed by the harness',
    },
    {
      key: 'done',
      label: 'Done',
      count: byResult.done || 0,
      population: writerTotal,
      // 볼륨 사실 — 위험 주장이 아니므로 tone 을 태우지 않는다.
      tone: 'neutral',
      hint: 'Writer-emitted records completed without a concern recorded',
    },
  ];
}

/**
 * Signed share delta of each band tile against the prior window; the window itself sits in the band's ⓘ.
 * The prior needs-you count reads closure as of now, so the hero compares shares, not two snapshots in time.
 * @param priorAttentionCount - the prior window's needs-you count; null → the hero states no change
 */
function buildBandTrendsO(data, tiles, priorAttentionCount) {
  const prior = data?.overall?.prior_window;
  if (!prior) return {};
  const priorData = { overall: prior, byResultCount: buildByResultCountMapO(prior.by_result) };
  const priorTiles = buildStatusBandTilesO(priorData, priorAttentionCount);
  return Object.fromEntries(tiles.map((tile, i) => [tile.key, getBandTrendO(tile, priorTiles[i])]));
}

function getBandTrendO(tile, priorTile) {
  const { LOW_N_MIN } = window.UI;
  if (tile.count === null || priorTile.count === null || tile.population < LOW_N_MIN) return null;
  if (priorTile.population < LOW_N_MIN) return 'No comparison';
  const points = (tile.count / tile.population - priorTile.count / priorTile.population) * 100;
  if (Math.abs(points) < 0.05) return 'Level';
  // U+2212 minus → read as "minus", never as a dash; the points figure in the Dashboard trend's form
  return `${points > 0 ? '+' : '\u2212'}${window.UI.formatDecimal(Math.abs(points))} pts`;
}

// One stat row card — needs you · failed or blocked · the volume facts; the window once in the sub-line.
function StatusBandO({ analyticsState, attentionState, windowDays, freshness, onRetry, shared }) {
  const { getRegionView, getFreshnessVerdict, Card, StatRow, Stack } = window.UI;
  const view = getRegionView(analyticsState);
  // blocked 는 레인의 장애 배너가 원인을 소유 → 여기선 '적재 실패' 만. 그 밖의 실패는 band 자리의 배너 하나.
  if (analyticsState.status === 'blocked') {
    return (
      <div className="mb-section flex-shrink-0" aria-label="Status band">
        <Card><PayloadUnavailableO label="Status band"/></Card>
      </div>
    );
  }
  if (view === 'error') {
    return (
      <div id={REGION_CARD_IDS.statusBand} className="mb-section flex-shrink-0" aria-label="Status band">
        <Card><RegionErrorO source="the status band" state={analyticsState} onRetry={onRetry} shared={shared} focusTargetId={REGION_CARD_IDS.statusBand}/></Card>
      </div>
    );
  }

  const isLoading = view === 'loading';
  // attention payload 가 아직/영영 없을 때 0 을 그리면 '해결됨' 으로 읽힌다 → null → em-dash.
  const attentionCount = attentionState.status === 'ready'
    ? (Number(attentionState.data?.total) || 0)
    : null;
  const bandTiles = buildStatusBandTilesO(analyticsState.data, attentionCount);
  const trends = isLoading ? {} : buildBandTrendsO(analyticsState.data, bandTiles, attentionState.data?.priorTotal ?? null);
  const prior = analyticsState.data?.overall?.prior_window;
  const priorRange = prior ? window.UI.formatDayRange(prior) : null;
  // stale or partial read → an ok tile drops to neutral, warn/crit kept (the freshness rule)
  const tiles = bandTiles
    .map((tile) => ({ ...tile, trend: trends[tile.key] ?? null }))
    .map((tile) => (freshness ? { ...tile, tone: getFreshnessVerdict({ ...freshness, tone: tile.tone }).tone } : tile));
  const reasons = buildNeedsYouReasonsO(analyticsState.data, attentionState.status === 'ready' ? attentionState.data : null);
  const unloadedText = getUnloadedSummaryO(attentionState.status);
  // only the needs-you count names its own wait; every other unread count takes the shared Not loaded mark
  const stats = tiles.map((tile) => buildBandStatO(tile, isLoading, tile.key === 'attention' ? unloadedText : null));
  const isAttentionFailed = getRegionView(attentionState) === 'error';

  return (
    <div id={REGION_CARD_IDS.statusBand} className="mb-section flex-shrink-0">
      <Stack gap="block">
        {/* window folded to {7,30,90} by analyticsDaysO → the sub-line states every stat's window once */}
        <Card title="Status" sub={`Last ${windowDays} days`} infoLabel="How the status band is counted"
          info={!isLoading && <BandRulesO tiles={tiles} reasons={reasons} priorRange={priorRange}/>}>
          <div aria-busy={isLoading ? 'true' : undefined}>
            <StatRow stats={stats}/>
          </div>
        </Card>
        {isAttentionFailed && (
          <RegionErrorO source="the needs-you count" state={attentionState} onRetry={onRetry} shared={shared} focusTargetId={REGION_CARD_IDS.statusBand}/>
        )}
      </Stack>
    </div>
  );
}

// tile model → one StatRow stat: the tone glyph on the label, the share and its delta on the one context line
function buildBandStatO(tile, isLoading, unloadedText) {
  const isLoaded = !isLoading && tile.count !== null && tile.count !== undefined;
  const share = isLoaded && tile.population > 0 ? formatShareO(tile.count, tile.population) : null;
  const context = share ? [share, tile.trend].filter(Boolean).join(' · ') : null;
  return {
    key: tile.key,
    label: <BandStatLabelO tile={tile}/>,
    value: <BandStatValueO tile={tile} isLoading={isLoading} unloadedText={unloadedText}/>,
    context,
  };
}

// ok/neutral carry no glyph; warn/crit name their tone, so the glyph is never colour alone
function BandStatLabelO({ tile }) {
  const glyph = getBandTileGlyphO(tile.tone);
  if (!glyph) return tile.label;
  return (
    <span className="inline-flex items-center gap-label-inline">
      <span className={`text-${tile.tone}`} role="img" aria-label={tile.tone === 'crit' ? 'critical' : 'warning'}>
        <GlyphO name={glyph} size={12}/>
      </span>
      {tile.label}
    </span>
  );
}

// a reachable count jumps to its ledger section → a link-styled control, never a button tile
// an unread count says so instead of a dash that reads as data: unloadedText when the tile names its own wait, else Not loaded
function BandStatValueO({ tile, isLoading, unloadedText }) {
  const { LoadingPlaceholder, AbsentValue } = window.UI;
  if (isLoading) {
    return <span className="inline-flex"><LoadingPlaceholder label={tile.label.toLowerCase()}/></span>;
  }
  if (tile.count === null || tile.count === undefined) {
    return unloadedText ? <span className="fs-body text-dim">{unloadedText}</span> : <AbsentValue kind="not-loaded"/>;
  }
  const count = formatIntO(tile.count);
  if (!tile.jumpTo || tile.count === 0) return count;
  return (
    <button type="button" className="link" onClick={() => focusLedgerSectionO(tile.jumpTo)}
      aria-label={`${tile.label}: ${count} — show them in the ledger`}>
      {count}<span aria-hidden="true" className="link-arrow">↓</span>
    </button>
  );
}

/**
 * Disjoint needs-you parts that add up to the headline — flags first, then unflagged failures and open caveats.
 * A gap between the headline and its parts (records that changed between reads) is a named remainder, never dropped.
 * @param attention - the needs-you wave ({ total, parts }); unread → every part unknown
 */
function buildNeedsYouReasonsO(data, attention) {
  const brokenTone = buildStatusBandTilesO(data, null).find((tile) => tile.key === 'broken').tone;
  const parts = attention?.parts ?? null;
  const reasons = [
    { key: 'flagged', label: 'Flagged for review', count: parts ? parts.flagged : null, tone: 'neutral' },
    { key: 'broken', label: 'Failed or blocked', count: parts ? parts.fail + parts.blocked : null, tone: brokenTone },
    { key: 'open', label: 'Caveat still open', count: parts ? parts.open : null, tone: 'neutral' },
  ];
  if (!parts) return reasons;
  // parts read after the headline can outgrow it → no meaningful remainder, never a negative count
  const remainder = attention.total - reasons.reduce((sum, reason) => sum + reason.count, 0);
  return remainder <= 0 ? reasons : [...reasons, { key: 'other', label: 'Changed between reads', count: remainder, tone: 'neutral' }];
}

// callers pass a population past their own > 0 check (buildBandStatO) → the share always has a denominator
function formatShareO(count, population) {
  return formatPctO((count / population) * 100);
}

// the counting method and the delta's comparison window live here, never on a tile
function BandRulesO({ tiles, reasons, priorRange }) {
  const { DateRange, LOW_N_MIN } = window.UI;
  return (
    <dl className="fs-body flex flex-col gap-list">
      {tiles.map((tile) => (
        <div key={tile.key}>
          <dt className="text-ink">{tile.label}</dt>
          <dd className="text-dim">{tile.hint}</dd>
        </div>
      ))}
      <div>
        <dt className="text-ink">Reasons</dt>
        <dd className="text-dim">Each record counted once, flags first</dd>
        {reasons.map((reason) => {
          const glyph = getBandTileGlyphO(reason.tone);
          return (
            <dd key={reason.key} className="flex items-center gap-label-inline text-dim">
              {glyph && <span className={`text-${reason.tone}`} aria-hidden="true"><GlyphO name={glyph} size={12}/></span>}
              {reason.label}
              <span className="ml-auto tabular-nums text-ink">{reason.count === null ? <window.UI.AbsentValue kind="not-loaded" title="The open-caveat records were not read"/> : formatIntO(reason.count)}</span>
            </dd>
          );
        })}
      </div>
      {priorRange && (
        <div>
          <dt className="text-ink">Change</dt>
          {/* the range rides in its own nowrap span → the sentence wraps around it, never inside the dates */}
          <dd className="text-dim"><DateRange range={priorRange}>{`Points of share against the prior window, ${priorRange}; under ${LOW_N_MIN} records there it reads No comparison`}</DateRange></dd>
        </div>
      )}
    </dl>
  );
}

// ok/neutral → no glyph: a check on a "Failed or blocked" tile reads as the opposite of its label
function getBandTileGlyphO(tone) {
  if (tone === 'crit') return 'x';
  if (tone === 'warn') return 'warn';
  return null;
}

// 헤딩으로 즉시 스크롤(모션 없음 → reduced-motion 무관) 후 focus — 스크린리더가 도착 지점을 읽는다.
function focusLedgerSectionO(id, doc = document) {
  const el = doc.getElementById(id);
  if (!el) return false;
  el.scrollIntoView({ block: 'start' });
  el.focus({ preventScroll: true });
  return true;
}

// registry 스코프 by-agent 실패 표 — 누적 막대가 답하지 못한 단 하나의 질문('누가 깨졌나')만 남긴다.
// 행 자체가 조치 대상이므로 tone 은 글리프가 아니라 숫자의 존재로 운반된다(0 행은 아예 렌더하지 않음).
// by_agent_top_10 → per-agent open-caveat lookup. The stack rows (by_agent_result) carry no
// such field, so it joins on the agent key — an agent outside the top-10 rollup has no loaded count.
function buildAgentOpenCaveatMapO(byAgentTop) {
  const { getWriterOpenCount } = window.UI;
  const rows = Array.isArray(byAgentTop) ? byAgentTop : [];
  return new Map(rows.map((row) => [row?.agent, getWriterOpenCount(row)]));
}

function buildAgentFailureRowsO(agentStack, byAgentTop) {
  const rows = Array.isArray(agentStack) ? agentStack : [];
  const openByAgent = buildAgentOpenCaveatMapO(byAgentTop);
  return rows
    .map((entry) => buildAgentFailureRowO(entry, openByAgent))
    .filter((row) => row.failed + row.blocked > 0)
    .sort(compareAgentFailureRowsO);
}

function buildAgentFailureRowO(entry, openByAgent) {
  const failed = entry.byResult?.fail || 0;
  const blocked = entry.byResult?.blocked || 0;
  const total = entry.total || 0;
  return {
    agent: entry.agent,
    failed,
    blocked,
    openCaveats: openByAgent.has(entry.agent) ? openByAgent.get(entry.agent) : null,
    total,
    rate: total > 0 ? (failed + blocked) / total : 0,
    isLowSample: window.UI.isLowSample(total),
  };
}

// low-sample rows sink below sampled ones → 3 of 5 runs failing never outranks a measured rate
function compareAgentFailureRowsO(a, b) {
  if (a.isLowSample !== b.isLowSample) return a.isLowSample ? 1 : -1;
  if (b.rate !== a.rate) return b.rate - a.rate;
  return (b.failed + b.blocked) - (a.failed + a.blocked);
}

function AgentFailureTableO({ state, onRetry, shared }) {
  const { Card } = window.UI;

  return (
    <div id={REGION_CARD_IDS.agentFailures}>
      <Card title="Failures by agent" sub="Worst failure rate first" isFlush
        info={<p className="fs-body">Failed or blocked records per registry agent. Agents with none are left out; the worst rate comes first.</p>}>
        <AgentFailureBodyO state={state} onRetry={onRetry} shared={shared}/>
      </Card>
    </div>
  );
}

// Numeric columns, alignment only: values and headers right-aligned, tabular figures, one line — every typeface stays as it is
const AGENT_FAILURE_COLUMNS_O = Object.freeze([
  { key: 'agent', label: 'Agent' },
  { key: 'rate', label: 'Failure rate', isNumeric: true },
  { key: 'failed', label: 'Failed', isNumeric: true },
  { key: 'blocked', label: 'Blocked', isNumeric: true },
  { key: 'caveats', label: 'Open caveats', isNumeric: true },
  { key: 'total', label: 'Total records', isNumeric: true },
]);
// loading and loaded tables share these → no column moves when rows land; Agent takes the slack, the numbers shrink to their content
const AGENT_FAILURE_WIDTHS_O = Object.freeze([undefined, '40%', '1%', '1%', '1%', '1%']);
// six numeric columns stop fitting under this width → each agent stacks onto a two-line item, no column lost to the wrapper clip
const AGENT_FAILURE_STACK_BELOW_PX = 560;
// .tbl--own-face: the .tbl cell geometry under this page's meta-step body and dim one-line head, with no clickable-row hover.
// separate borders: a collapsed border would not travel with the sticky header row
const OWN_FACE_TABLE_CLASS_O = 'tbl--own-face fs-meta border-separate border-spacing-0 [&_thead_th]:text-dim [&_thead_th]:font-medium [&_thead_th]:whitespace-nowrap';

function AgentFailureBodyO({ state, onRetry, shared }) {
  const view = window.UI.getRegionView(state);
  // the table keeps its shape while loading — an empty body would read as 'no agent failed'
  if (view === 'loading') {
    return <window.UI.Table caption="Loading by-agent failures" columns={AGENT_FAILURE_COLUMNS_O} widths={AGENT_FAILURE_WIDTHS_O}
      isHeadSticky className={OWN_FACE_TABLE_CLASS_O}
      bodies={[{ key: 'skeleton', rows: <window.UI.SkeletonRows rows={3} columns={AGENT_FAILURE_COLUMNS_O.length}/>, isBusy: true, className: 'tbl-compact' }]}/>;
  }
  if (view === 'error') {
    return <RegionErrorO source="by-agent failures" state={state} onRetry={onRetry} shared={shared} focusTargetId={REGION_CARD_IDS.agentFailures} isInset/>;
  }

  const rows = buildAgentFailureRowsO(state.data?.agentStack, state.data?.overall?.by_agent_top_10);
  if (rows.length === 0) {
    return <window.UI.EmptyState message="No registry agent failed or blocked in this window."/>;
  }

  // the table's .tbl-wrap clips sideways and never scrolls → the sticky head reaches the 70vh card body, the scroller that does
  const maxRate = getFailureRateMaxO(rows);
  const getRows = (tableView) => rows.map((row) => <AgentFailureRowO key={row.agent} row={row} maxRate={maxRate} view={tableView}/>);
  return <window.UI.Table caption="Failure rate by registry agent, worst first" columns={AGENT_FAILURE_COLUMNS_O} widths={AGENT_FAILURE_WIDTHS_O} isHeadSticky
    stackBelowPx={AGENT_FAILURE_STACK_BELOW_PX} className={OWN_FACE_TABLE_CLASS_O}
    bodies={[{ key: 'agents', rows: getRows, className: 'tbl-compact' }]}/>;
}

// the worst sampled rate scales the bars → a low-sample row never shrinks the others; it fills at most its whole track
function getFailureRateMaxO(rows) {
  const sampled = rows.filter((row) => !row.isLowSample);
  return Math.max(...(sampled.length > 0 ? sampled : rows).map((row) => row.rate));
}

function AgentFailureRowO({ row, maxRate, view }) {
  const { TableRow, TableCell } = window.UI;
  return (
    <TableRow view={view} className="outcome-row">
      <TableCell view={view} className="text-ink truncate" title={row.agent}><window.UI.AgentName name={row.agent}/></TableCell>
      <AgentFailureRateCellO row={row} maxRate={maxRate} view={view}/>
      <TableCell view={view} textRole="meta" label="Failed" isNumeric className="text-ink">{formatIntO(row.failed)}</TableCell>
      <TableCell view={view} textRole="meta" label="Blocked" isNumeric className="text-ink">{formatIntO(row.blocked)}</TableCell>
      <OpenCaveatCellO count={row.openCaveats} view={view}/>
      <TableCell view={view} textRole="meta" label="Total records" isNumeric className="text-faint">{formatIntO(row.total)}</TableCell>
    </TableRow>
  );
}

// the crit word every failure-rate view shares
const HIGH_FAILURE_RATE_WORD_O = 'High failure rate';

// the widest slot: a low-sample mark under the low-n floor beside a full share, "(n=29) 100.0%"
const FAILURE_RATE_SLOT_WIDTH_O = '14ch';

// bar = a neutral quantity against the column's worst rate · severity = a crit word over the breakage share · low-sample rows claim none
function AgentFailureRateCellO({ row, maxRate, view }) {
  const { Bar, StatusDot, LowSampleMark, TableCell, outcomeShareTone, OUTCOME_BREAKAGE_CRIT_SHARE } = window.UI;
  const isHigh = !row.isLowSample && Boolean(outcomeShareTone(row.failed + row.blocked, row.total, OUTCOME_BREAKAGE_CRIT_SHARE, 'crit'));
  const runsNote = `${formatIntO(row.failed + row.blocked)} of ${formatIntO(row.total)} runs failed or blocked`;
  return (
    <TableCell view={view} textRole="meta" label="Failure rate" isNumeric title={runsNote}>
      {/* the share ends the cell → every rate shares one right edge; the marks and the share sit in one fixed slot → one track length per row */}
      <div className="flex items-center gap-control">
        <div className="flex-1" style={{ minWidth: 40 }}><Bar value={row.rate} max={maxRate} ariaLabel={runsNote}/></div>
        <span className="inline-flex items-center justify-end gap-label-inline tabular-nums whitespace-nowrap" style={{ width: FAILURE_RATE_SLOT_WIDTH_O, flexShrink: 0 }}>
          {isHigh && <StatusDot status="crit" word={HIGH_FAILURE_RATE_WORD_O}/>}
          {row.isLowSample && <LowSampleMark n={row.total}/>}
          <span className={row.isLowSample ? 'text-faint' : 'text-ink'}>{formatRateO(row.rate, 1)}</span>
        </span>
      </div>
    </TableCell>
  );
}

// null = the agent sits outside the top-10 rollup → Not loaded, never a zero that was not read
function OpenCaveatCellO({ count, view }) {
  return (
    <window.UI.TableCell view={view} textRole="meta" label="Open caveats" isNumeric className="text-ink">
      {count !== null ? formatIntO(count)
        : <window.UI.AbsentValue kind="not-loaded" title="Only the top 10 agents by volume carry an open-caveat count"/>}
    </window.UI.TableCell>
  );
}

// ----- Attribution Health (telemetry attribution quality) ------------------
// /api/outcomes/attribution-daily — attribution_source split into 4 categories.
// daily stacked bar (inline SVG, no Recharts) + window summary stat row + literal-omission severity head status (glyph + word)
// NULL attribution_source rows excluded by the backend (rows older than attribution tracking) → every ratio denominator = total_attributed.

// a toned state → the shared head Status · no tone (nothing read, or nothing to count) → its faint word alone, no mark
function BlockStatusO({ tone, children }) {
  if (tone) return <window.UI.HeadStatus tone={tone}>{children}</window.UI.HeadStatus>;
  return <span className="fs-meta text-dim">{children}</span>;
}

/**
 * One block of a status fold's body, with no card box of its own: a level-3 title, its status and ⓘ on the title's line.
 * @param isFlush - a table body whose edge cells carry the card padding → the head and foot take the same inset
 */
function FoldBlockO({ id, title, status, info, isFlush = false, foot, children }) {
  const { Stack, SectionLabel, CardInfo } = window.UI;
  const titleId = `${id}-title`;
  const inset = isFlush ? 'px-card-pad' : '';

  return (
    <section id={id} aria-labelledby={titleId} className="min-w-0">
      <Stack>
        {/* one head height, the ⓘ box's → split blocks with and without an ⓘ start their title and body on one line */}
        <div className={`flex flex-wrap items-center gap-label ${inset}`.trim()} style={{ minHeight: 'var(--ctl-min-h)' }}>
          <SectionLabel level={3} id={titleId}>{title}</SectionLabel>
          {info && <CardInfo label="How this is counted" describedBy={titleId}>{info}</CardInfo>}
          {status}
        </div>
        {children}
        {foot && <div className={inset || undefined}>{foot}</div>}
      </Stack>
    </section>
  );
}

function AttributionHealthBlock({ state, period, onRetry, shared }) {
  const badge = getAttributionHeadBadgeO(state, period);

  // one inline span → the flex gap sits after the glyph only, never between the sentence's own runs
  return (
    <FoldBlockO
      id={REGION_CARD_IDS.attribution}
      title="Record attribution"
      status={badge && (
        <BlockStatusO tone={badge.colorVar && toneFromColorVarO(badge.colorVar)}>
          <span>Missing reports {badge.text}</span>
        </BlockStatusO>
      )}>
      <AttributionHealthBody state={state} onRetry={onRetry} shared={shared}/>
    </FoldBlockO>
  );
}

// a ready payload without window_summary → nothing read for the window: Not loaded in head and body, never the empty window
const ATTRIBUTION_NO_SUMMARY_TITLE_O = 'The attribution read landed with no window summary, so the window was not read';

// first read in flight → no head (the body's loading status is the loading look) · failed or summary-less → Not loaded + its cause ·
// read → the window's rate
function getAttributionHeadBadgeO(state, period) {
  const { getRegionView, getErrorCopy, AbsentValue } = window.UI;
  const view = getRegionView(state);
  if (view === 'loading') return null;
  if (view === 'error') {
    const { sentence, detail } = getErrorCopy(state.error, `record attribution for the last ${period} days`);
    return { colorVar: null, text: <AbsentValue kind="not-loaded" title={`${sentence} ${detail}`}/> };
  }
  const summary = state.data?.window_summary;
  if (!summary) return { colorVar: null, text: <AbsentValue kind="not-loaded" title={ATTRIBUTION_NO_SUMMARY_TITLE_O}/> };
  return attributionOmissionBadgeO(summary.literal_omission_rate);
}

function AttributionHealthBody({ state, onRetry, shared }) {
  const view = window.UI.getRegionView(state);
  if (view === 'loading') {
    return <window.UI.LoadingPlaceholder label="record attribution" minHeight={200}/>;
  }
  if (view === 'error') {
    return <RegionErrorO source="record attribution" state={state} onRetry={onRetry} shared={shared} focusTargetId={REGION_CARD_IDS.attribution}/>;
  }

  const summary = state.data?.window_summary;
  if (!summary) {
    return <window.UI.AbsentValue kind="not-loaded" title={ATTRIBUTION_NO_SUMMARY_TITLE_O}/>;
  }
  const totalAttributed = Number(summary.total_attributed) || 0;

  // 귀속 기록된 실행 0건 (빈 window) → 안내 indicator.
  if (totalAttributed === 0) {
    return <window.UI.EmptyState message="No attributed runs in this period."/>;
  }

  return (
    <window.UI.Stack>
      <AttributionSummaryRow summary={summary} totalAttributed={totalAttributed}/>
      <AttributionDevScopeO devScope={summary?.dev_scope}/>
    </window.UI.Stack>
  );
}

// Reporting-health detail breakdown — silent on loading/error/a summary-less payload, which the status cards above already report.
function AttributionBreakdownO({ state }) {
  const summary = state.data?.window_summary;
  if (state.status !== 'ready' || !summary) return null;

  if (!(Number(summary.total_attributed) > 0)) {
    return <window.UI.EmptyState message="No daily breakdown in this period."/>;
  }

  // backend sends active days only → 0-fill into the last ATTRIBUTION_GRID_BARS days.
  const series = Array.isArray(state.data?.days_series) ? state.data.days_series : [];

  return (
    <window.UI.Stack>
      <AttributionDailyChart grid={buildAttributionGridO(series, ATTRIBUTION_GRID_BARS)}/>
      <AttributionLegend/>
      <AttributionBudgetKillListO rows={summary.budget_truncation_by_agent}/>
    </window.UI.Stack>
  );
}

// window summary stat row — per-category rate (denominator = total_attributed)
// 'Missing report' (literal_omission) stat → a budget-kill/truncated/missing sub-line, counts only (no total, no rate)
function AttributionSummaryRow({ summary, totalAttributed }) {
  const omissionBreakdown = buildLiteralOmissionBreakdownO(summary?.literal_omission_breakdown);
  const omissionMeta = ATTRIBUTION_CATEGORY_META.literal_omission;
  const { Stack, StatRow } = window.UI;
  const stats = ATTRIBUTION_CATEGORY_ORDER.map((key) => {
    const meta = ATTRIBUTION_CATEGORY_META[key];
    const rate = summary ? summary[`${key}_rate`] : null;
    const count = Math.round((Number(rate) || 0) * totalAttributed);
    return { key, label: <StatGlyphLabelO meta={meta}/>, value: formatRateO(rate), context: `${formatIntO(count)} runs` };
  });
  return (
    <Stack gap="label">
      <StatRow stats={stats}/>
      {omissionBreakdown && (
        <div
          className="fs-meta text-dim leading-relaxed"
          title={`Missing report breakdown — budget kill ${formatIntO(omissionBreakdown.budget)}, truncated completion ${formatIntO(omissionBreakdown.truncated)}, completion missing ${formatIntO(omissionBreakdown.missing)} (sums to the Missing report count; the rate is unchanged)`}>
          {/* glyph + label as one unbreakable unit → the × never wraps onto a line of its own */}
          <span className="inline-flex items-center gap-label-inline whitespace-nowrap mr-label-inline">
            <span style={{ color: `rgb(var(${omissionMeta.colorVar}))` }} aria-hidden="true"><GlyphO name={omissionMeta.icon}/></span>
            {omissionMeta.label}:
          </span>
          budget-kill {formatIntO(omissionBreakdown.budget)} · truncated {formatIntO(omissionBreakdown.truncated)} · missing {formatIntO(omissionBreakdown.missing)}
        </div>
      )}
    </Stack>
  );
}

// a stat label led by its category glyph — colour + glyph + word, never colour alone
function StatGlyphLabelO({ meta }) {
  return <span className="inline-flex items-start gap-label-inline">
    <span style={{ color: `rgb(var(${meta.colorVar}))` }} aria-hidden="true"><GlyphO name={meta.icon}/></span>
    {meta.label}
  </span>;
}

// 일별 stacked-bar — 각 일자 1막대, 4-category 비례 stack (inline SVG, 외부 라이브러리 없음).
// bar 폭/간격은 grid 길이 기준 자동 분배. 0건 일자는 빈 트랙 표시.
// one daily chart per screen → a fixed id for its keyboard note
const DAILY_CHART_KEYS_ID = 'outcomes-daily-chart-keys';

function AttributionDailyChart({ grid }) {
  const { activeIndex, handlers } = useStackedChartReadoutO(grid.length);
  const chartHeight = 132;
  const labelBand   = 16;
  const barAreaH    = chartHeight - labelBand;
  const slot = 100 / grid.length;
  const barW = slot * 0.72;
  const barGap = (slot - barW) / 2;

  return (
    <figure className="min-w-0 grid gap-x-label-inline" style={{ gridTemplateColumns: `${STACKED_Y_AXIS_WIDTH}px minmax(0, 1fr)` }}>
      <StackedYAxisO barAreaH={barAreaH} chartHeight={chartHeight}/>
      <div role="img" aria-label={getStackedChartLabelO(grid)} aria-describedby={DAILY_CHART_KEYS_ID} tabIndex={0}
        style={{ cursor: 'crosshair', minWidth: 0 }} {...handlers}>
      <svg
        width="100%"
        height={chartHeight}
        viewBox={`0 0 100 ${chartHeight}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ display: 'block' }}>
        {activeIndex !== null && (
          <rect x={activeIndex * slot} y={0} width={slot} height={barAreaH} fill="rgb(var(--ink) / 0.07)"/>
        )}
        {grid.map((point, di) => {
          const x = di * slot + barGap;
          if (point.total <= 0) {
            // out-of-range(데이터 창 시작 전) → 점선 hairline + 더 옅게 / 진짜 0활동일 → 실선 hairline.
            const isOut = point.outOfRange === true;
            return (
              <rect
                key={`empty-${point.day}`}
                x={x}
                y={barAreaH - 1}
                width={barW}
                height={1}
                fill="rgb(var(--line))"
                opacity={isOut ? '0.22' : '0.6'}
                strokeDasharray={isOut ? '1.5 1.5' : undefined}>
                <title>{isOut ? `${point.day} · ${EMPTY_DAY_LABEL_NOT_READ}` : `${point.day} · ${EMPTY_DAY_LABEL_NO_RECORDS}`}</title>
              </rect>
            );
          }
          let yCursor = barAreaH;
          return (
            <React.Fragment key={point.day}>
              {ATTRIBUTION_CATEGORY_ORDER.map((key) => {
                const count = point[key] || 0;
                if (count <= 0) return null;
                const segH = (count / point.total) * barAreaH;
                yCursor -= segH;
                const meta = ATTRIBUTION_CATEGORY_META[key];
                return (
                  <rect
                    key={key}
                    x={x}
                    y={yCursor}
                    width={barW}
                    height={segH}
                    fill={`rgb(var(${meta.colorVar}))`}
                    opacity="0.92">
                    <title>{`${point.day} · ${meta.label}: ${formatIntO(count)} (${formatPctO(count / point.total * 100)})`}</title>
                  </rect>
                );
              })}
            </React.Fragment>
          );
        })}
      </svg>
      </div>
      <div className="col-start-2">
        <StackedChartTicksO grid={grid}/>
        <div aria-live="polite" className="fs-meta text-dim" style={{ minHeight: 18, fontVariantNumeric: 'tabular-nums' }}>
          {activeIndex === null ? 'Point at a day to read its counts.' : getStackedDayReadoutO(grid[activeIndex])}
        </div>
        <span id={DAILY_CHART_KEYS_ID} className="sr-only">Focus the chart and use the arrow keys to read each day.</span>
      </div>
    </figure>
  );
}

const STACKED_Y_AXIS_WIDTH = 32;
// label box height in px → the end ticks clamp inside the plot instead of clipping at its edges
const STACKED_Y_LABEL_H = 12;

// 100%-stacked bars → the scale is a share of each day's records, so a tick at p% sits p% up the bar area
function getStackedYTicksO(barAreaH) {
  return [100, 50, 0].map((pct) => ({ label: `${pct}%`, y: barAreaH * (1 - pct / 100) }));
}

function StackedYAxisO({ barAreaH, chartHeight }) {
  return (
    <div aria-hidden="true" className="fs-meta tabular-nums text-faint"
      style={{ position: 'relative', width: STACKED_Y_AXIS_WIDTH, height: chartHeight, flexShrink: 0 }}>
      {getStackedYTicksO(barAreaH).map((tick) => {
        const top = Math.min(Math.max(tick.y - STACKED_Y_LABEL_H / 2, 0), barAreaH - STACKED_Y_LABEL_H);
        return (
          <span key={tick.label} style={{ position: 'absolute', right: 0, lineHeight: `${STACKED_Y_LABEL_H}px`, top }}>
            {tick.label}
          </span>
        );
      })}
    </div>
  );
}

// pointer + arrow/Home/End → one active day; the first arrow press lands on the latest day
function useStackedChartReadoutO(count) {
  const [activeIndex, setActiveIndex] = useStateO(null);
  const { getRovingIndex, getChartIndexAtRatio } = window.UI;
  const handlers = {
    onPointerMove: (e) => {
      const box = e.currentTarget.getBoundingClientRect();
      if (box.width > 0) setActiveIndex(getChartIndexAtRatio((e.clientX - box.left) / box.width, count, 'bars'));
    },
    onPointerLeave: () => setActiveIndex(null),
    onBlur: () => setActiveIndex(null),
    onKeyDown: (e) => {
      const next = getRovingIndex(e.key, activeIndex, count, 'horizontal', 'last');
      if (next === undefined) return;
      e.preventDefault();
      setActiveIndex(next);
    },
  };
  return { activeIndex, handlers };
}

function StackedChartTicksO({ grid }) {
  const ticks = window.UI.getChartTicks(grid.length);
  const last = grid.length - 1;
  return (
    <div className="relative fs-meta tabular-nums text-faint mt-stack" style={{ height: 18 }} aria-hidden="true">
      {ticks.map((i) => (
        <span
          key={i}
          className="absolute whitespace-nowrap"
          style={{ left: `${((i + 0.5) / grid.length) * 100}%`, transform: i === 0 ? 'none' : i === last ? 'translateX(-100%)' : 'translateX(-50%)' }}>
          {attributionDayLabelO(grid[i].day)}
        </span>
      ))}
    </div>
  );
}

function getStackedDayReadoutO(point) {
  if (!(point.total > 0)) {
    return `${point.day} · ${point.outOfRange === true ? EMPTY_DAY_LABEL_NOT_READ : EMPTY_DAY_LABEL_NO_RECORDS}`;
  }
  const parts = ATTRIBUTION_CATEGORY_ORDER
    .filter((key) => (point[key] || 0) > 0)
    .map((key) => `${ATTRIBUTION_CATEGORY_META[key].label} ${point[key]}`);
  return `${point.day} · ${point.total} records: ${parts.join(', ')}`;
}

function getStackedChartLabelO(grid) {
  const total = grid.reduce((sum, point) => sum + (Number(point.total) || 0), 0);
  return `Daily reporting health, ${grid.length} days, ${total} records.`;
}

const EMPTY_DAY_LABEL_NO_RECORDS = 'No records';
const EMPTY_DAY_LABEL_NOT_READ = 'Not read (before the data window)';

// dual-encoded 범례 — 색상 + 기호 + 라벨 3중 부호화 (color-blind safety).
function AttributionLegend() {
  return (
    <div className="flex flex-wrap gap-list fs-meta text-faint">
      {ATTRIBUTION_CATEGORY_ORDER.map((key) => {
        const meta = ATTRIBUTION_CATEGORY_META[key];
        return (
          <span key={key} className="flex items-center gap-label-inline">
            {/* 범례 점 크기 통일 — w-2 h-2 (화면 공통, W3-T7). */}
            <span
              className="w-2 h-2 rounded-sm inline-flex items-center justify-center"
              style={{ background: `rgb(var(${meta.colorVar}))` }}
              aria-hidden="true"/>
            <span aria-hidden="true" style={{ color: `rgb(var(${meta.colorVar}))` }}><GlyphO name={meta.icon}/></span>
            {meta.label}
          </span>
        );
      })}
      {/* the chart's two empty-day hairlines: solid = a read day with no records, dashed = a day before the data window */}
      <span className="flex items-center gap-label-inline">
        <span className="w-3 inline-block" style={{ borderTop: '1px solid rgb(var(--line))' }} aria-hidden="true"/>
        {EMPTY_DAY_LABEL_NO_RECORDS}
      </span>
      <span className="flex items-center gap-label-inline">
        <span className="w-3 inline-block" style={{ borderTop: '1px dashed rgb(var(--line))' }} aria-hidden="true"/>
        {EMPTY_DAY_LABEL_NOT_READ}
      </span>
    </div>
  );
}

// ----- Channel liveness (기록 채널 감시) --------------------------------------
// /api/outcomes/channel-liveness — 기록 채널이 조용해진 것을 사람이 알아채기 전에 지목한다.
// 대부분의 outcome 을 실어 나르던 채널이 0 으로 떨어진 채 하루 넘게 방치됐고, 그 공백이
// 대시보드에서는 품질 저하처럼 읽혔다. 판정(eligible/alerting)과 임계값은 전부 서버 응답에서
// 오며 카드는 어떤 수치도 재계산하지 않는다 — doctor §16 과 같은 정의 하나를 공유하기 위함.

function ChannelLivenessBlock({ state, onRetry, shared }) {
  const badge = getChannelLivenessBadgeO(state);
  const watchNote = getChannelWatchNoteO(state.data?.thresholds);
  const hasTable = state.status === 'ready' && getChannelsO(state).length > 0;

  return (
    <FoldBlockO
      id={REGION_CARD_IDS.channels}
      title="Recording channels"
      status={badge && <BlockStatusO tone={badge.tone}>{badge.text}</BlockStatusO>}
      info={watchNote && <p className="fs-body">{watchNote}</p>}
      isFlush={hasTable}>
      <ChannelLivenessBody state={state} onRetry={onRetry} shared={shared}/>
    </FoldBlockO>
  );
}

function getChannelsO(state) {
  return Array.isArray(state.data?.channels) ? state.data.channels : [];
}

function getChannelWatchNoteO(threshold) {
  if (!threshold) return null;
  return `Alerts once a channel that exceeded ${formatIntO(threshold.eligibility_daily_floor)} rows/day `
    + `within the last ${threshold.eligibility_recency_days}d has recorded nothing for ${threshold.silence_hours}h.`;
}

// first read in flight → no head · failed → Not loaded · no channel read → None · 'All recording' only over a read channel list
function getChannelLivenessBadgeO(state) {
  const { getRegionView, AbsentValue } = window.UI;
  const view = getRegionView(state);
  if (view === 'loading') return null;
  if (view === 'error') return { tone: null, text: <AbsentValue kind="not-loaded"/> };
  const channels = getChannelsO(state);
  if (channels.length === 0) return { tone: null, text: <AbsentValue kind="none"/> };

  const alerting = state.data?.alerting || [];
  const meta = alerting.length > 0 ? CHANNEL_LIVENESS_META.alerting : CHANNEL_LIVENESS_META.live;
  return { tone: toneFromColorVarO(meta.colorVar), text: alerting.length > 0 ? `Silent: ${alerting.join(', ')}` : 'All recording' };
}

function ChannelLivenessBody({ state, onRetry, shared }) {
  const view = window.UI.getRegionView(state);
  if (view === 'loading') {
    return <window.UI.LoadingPlaceholder label="recording channels" minHeight={120}/>;
  }
  if (view === 'error') {
    return <RegionErrorO source="recording channels" state={state} onRetry={onRetry} shared={shared} focusTargetId={REGION_CARD_IDS.channels}/>;
  }

  const channels = getChannelsO(state);
  if (channels.length === 0) {
    return <window.UI.EmptyState message="No recording channel wrote in this window."/>;
  }

  // 침묵한 채널을 먼저 — 조치가 필요한 행이 스크롤 아래로 밀리지 않게.
  const ordered = [...channels].sort((a, b) => Number(b.alerting) - Number(a.alerting));
  const columns = getChannelColumnsO(state.data?.days, state.data?.thresholds?.eligibility_recency_days);

  return (
    <window.UI.Table caption="Recording channels by state" columns={columns} widths={CHANNEL_WIDTHS_O} className={OWN_FACE_TABLE_CLASS_O}
      stackBelowPx={CHANNEL_STACK_BELOW_PX}
      bodies={[{ key: 'body', rows: (view) => ordered.map((channel) => (
        <ChannelRowO key={channel.attribution_source} channel={channel} view={view}/>
      )) }]}/>
  );
}

const CHANNEL_STACK_BELOW_PX = 480;
// Status and Quiet shrink to their content → the channel name keeps one line
const CHANNEL_WIDTHS_O = Object.freeze([undefined, '1%', undefined, undefined, '1%']);

// window peak over the read window · busiest day over the eligibility recency window — both come with the payload
function getChannelColumnsO(days, recencyDays) {
  return [
    { key: 'channel', label: 'Channel' },
    { key: 'status', label: 'Status' },
    { key: 'peak', label: days ? `Peak, ${days}d` : 'Peak', isNumeric: true },
    { key: 'busiest', label: recencyDays ? `Busiest, ${recencyDays}d` : 'Busiest', isNumeric: true },
    { key: 'quiet', label: 'Quiet', isNumeric: true },
  ];
}

function ChannelRowO({ channel, view }) {
  const { TableRow, TableCell, StatusDot, MachineString } = window.UI;
  const meta = channelLivenessMetaO(channel);

  // the dot's sr-only word names the state → the painted word is for sight only
  return (
    <TableRow view={view}>
      <TableCell view={view} kind="row-header" className="whitespace-nowrap font-normal"><MachineString>{channel.attribution_source}</MachineString></TableCell>
      <TableCell view={view} label="Status">
        <span className="inline-flex items-center gap-label-inline whitespace-nowrap">
          <StatusDot status={toneFromColorVarO(meta.colorVar)} word={meta.label} isInText/>
          <span aria-hidden="true">{meta.label}</span>
        </span>
      </TableCell>
      <TableCell view={view} label="Peak" isNumeric>{formatIntO(channel.peak_daily_count)}/day</TableCell>
      <TableCell view={view} label="Busiest" isNumeric>{formatIntO(channel.recent_peak_daily_count)}/day</TableCell>
      <TableCell view={view} label="Quiet" isNumeric>{formatIntO(Math.floor(Number(channel.silent_hours) || 0))}h</TableCell>
    </TableRow>
  );
}

// ----- 측정 분포 (artifact-vs-quality breakdown) -----------------------------
// /api/outcomes/cross-analysis grader_breakdown — grader_verdict 버킷 분포.
//   verified_pass/unverified/verified_fail = graded_total 분모 · not_measured(레거시 NULL) 은 비율 분모 제외.
//   목적: 측정 산물(unverified/legacy)을 품질 실패로 오독하지 않게 측정 신호를 명시 노출.

function GraderBreakdownBlock({ state, onRetry, shared }) {
  // the foot footnotes the drawn breakdown → absent while the body shows loading, error or empty
  const isReady = window.UI.getRegionView(state) === 'ready' && Boolean(state.data?.overall?.grader_breakdown);
  const segments = isReady ? getDowngradeSegmentsO(state.data.overall.downgrade_breakdown) : [];

  return (
    <FoldBlockO id={REGION_CARD_IDS.checks} title="Automatic check results"
      info={segments.length > 0 && <DowngradeSourcesO segments={segments}/>}>
      <GraderBreakdownBody state={state} onRetry={onRetry} shared={shared}/>
    </FoldBlockO>
  );
}

// not_measured (legacy NULL) tile only when it counts something → no dead "0" tile
function getGraderTileKeysO(breakdown) {
  return GRADER_BREAKDOWN_ORDER.filter((key) => key !== 'not_measured' || (Number(breakdown?.[key]) || 0) > 0);
}

function GraderBreakdownBody({ state, onRetry, shared }) {
  const view = window.UI.getRegionView(state);
  if (view === 'loading') {
    return <window.UI.LoadingPlaceholder label="check results" minHeight={120}/>;
  }
  if (view === 'error') {
    return <RegionErrorO source="check results" state={state} onRetry={onRetry} shared={shared} focusTargetId={REGION_CARD_IDS.checks}/>;
  }

  const breakdown = state.data?.overall?.grader_breakdown;
  if (!breakdown) {
    return <window.UI.EmptyState message="No check data in this period."/>;
  }

  const gradedTotal = Number(breakdown.graded_total) || 0;
  const stats = getGraderTileKeysO(breakdown).map((key) => {
    const meta  = GRADER_BREAKDOWN_META[key];
    const count = Number(breakdown[key]) || 0;
    return { key, label: <StatGlyphLabelO meta={meta}/>, value: formatIntO(count), context: getGraderStatContextO(key, count, gradedTotal) };
  });

  return <window.UI.StatRow stats={stats}/>;
}

// a share of graded_total · not_measured (legacy NULL) sits outside it · an empty window → no line under its zero
function getGraderStatContextO(key, count, gradedTotal) {
  if (key === 'not_measured') return 'not in share denominator';
  return gradedTotal > 0 ? formatPctO(count / gradedTotal * 100) : undefined;
}

// downgrade_origin 분포 서브라인 — grader_verdict 카드에 종속. writer_true_downgraded(작성자 pass
// 주장 ↔ grader 불일치)를 우선 노출, 나머지 provenance 는 muted. 전 표본 0 → 미렌더(no fake zero).
function getDowngradeSegmentsO(breakdown) {
  if (!breakdown) return [];
  return DOWNGRADE_BREAKDOWN_ORDER
    .map((key) => ({ key, count: Number(breakdown[key]) || 0 }))
    .filter((s) => s.count > 0);
}

function DowngradeSourcesO({ segments }) {
  const { Table, TableRow, TableCell } = window.UI;
  return (
    <Table caption="Where each verdict came from" isCaptionShown columns={DOWNGRADE_SOURCE_COLUMNS_O}
      bodies={[{ key: 'sources', rows: (view) => segments.map(({ key, count }) => (
        <TableRow key={key} view={view}>
          <TableCell view={view} kind="row-header" className="font-normal">{DOWNGRADE_BREAKDOWN_LABELS[key]}</TableCell>
          <TableCell view={view} label="Records" isNumeric className="tabular-nums">{formatIntO(count)}</TableCell>
        </TableRow>
      )) }]}/>
  );
}

const DOWNGRADE_SOURCE_COLUMNS_O = Object.freeze([
  { key: 'source', label: 'Source' },
  { key: 'count', label: 'Records', isNumeric: true },
]);

// any failing checkable type → crit; else untoned
function getTaskTypeFoldToneO(rows) {
  return Array.isArray(rows) && rows.some(isTaskTypeFailingO) ? 'crit' : undefined;
}

// the fold head's worst state in words → the colour of an opened fold is never its only cue
function getTaskTypeFoldSubO(rows) {
  if (getTaskTypeFoldToneO(rows) !== 'crit') return null;
  return <window.UI.HeadStatus tone="crit">{HIGH_FAILURE_RATE_WORD_O}</window.UI.HeadStatus>;
}

// a checkable type whose failed checks reach the breakage share, low samples excluded
function isTaskTypeFailingO(row) {
  const { outcomeShareTone, isLowSample, OUTCOME_BREAKAGE_CRIT_SHARE } = window.UI;
  const total = Number(row.total) || 0;
  return row.by_design_unverified !== true && !isLowSample(total)
    && outcomeShareTone(row.verified_fail, total, OUTCOME_BREAKAGE_CRIT_SHARE, 'crit') === 'crit';
}

// ----- 9-type × grader_verdict 교차 (F16) ------------------------------------
// cross-analysis task_type_grader_breakdown — 서버 고정 9행 (task_type enum 순).
// by_design_unverified(review/diagnosis/doc/cleanup) 그룹 분리 — grader 가 설계상
// unverified 로 skip 하는 유형을 측정 대상 유형과 섞으면 품질 신호로 오독 (R07).
// 막대 폭 ∝ 행 합/최대 (볼륨) · 내부 분할 = grader 버킷 구성비 (색 = 버킷 카드 SoT).
function TaskTypeGraderCrosstabO({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const maxTotal = Math.max(...rows.map((r) => Number(r.total) || 0));
  if (maxTotal <= 0) return null;

  const measured = rows.filter((r) => r.by_design_unverified !== true);
  const byDesign = rows.filter((r) => r.by_design_unverified === true);
  // one failing type → every row keeps the word's slot, so all bar tracks end on one x
  const hasStateSlot = rows.some(isTaskTypeFailingO);

  return (
    <div className="mt-block flex flex-col gap-block">
      <TaskTypeGraderGroupO label="By task type — checkable types" rows={measured} maxTotal={maxTotal} hasStateSlot={hasStateSlot}/>
      <TaskTypeGraderGroupO label="Types with nothing to check" rows={byDesign} maxTotal={maxTotal} hasStateSlot={hasStateSlot} isMuted/>
    </div>
  );
}

function TaskTypeGraderGroupO({ label, rows, maxTotal, hasStateSlot, isMuted }) {
  return (
    <div>
      <div className="fs-meta text-faint mb-label">{label}</div>
      <div className="flex flex-col gap-list">
        {rows.map((row) => <TaskTypeGraderBarO key={row.task_type} row={row} maxTotal={maxTotal} hasStateSlot={hasStateSlot} isMuted={isMuted}/>)}
      </div>
    </div>
  );
}

// the widest state word, "✕ High failure rate", at the meta size
const TASK_TYPE_STATE_SLOT_WIDTH_O = '16ch';

// the failed share is a quantity here → neutral data; the row's crit word carries the state
function getTaskTypeSegmentColorO(key) {
  return key === 'verified_fail' ? '--data' : GRADER_BREAKDOWN_META[key].colorVar;
}

function TaskTypeGraderBarO({ row, maxTotal, hasStateSlot = false, isMuted }) {
  const total = Number(row.total) || 0;
  const widthPct = total > 0 ? (total / maxTotal) * 100 : 0;
  const isFailing = isTaskTypeFailingO(row);
  const bucketText = GRADER_BREAKDOWN_ORDER
    .map((key) => `${GRADER_BREAKDOWN_META[key].label} ${formatIntO(Number(row[key]) || 0)}`)
    .join(' · ');
  const title = `${row.task_type}: ${isFailing ? `${HIGH_FAILURE_RATE_WORD_O} · ` : ''}${bucketText} — total ${formatIntO(total)}`;

  return (
    <div className="flex items-center gap-label" role="img" aria-label={title} title={title}>
      <span className={`fs-meta ${isMuted ? 'text-faint' : 'text-dim'}`} style={{ width: 76, flexShrink: 0 }}>
        {row.task_type}
      </span>
      <div className="flex-1 h-3 rounded-sm overflow-hidden" style={{ background: 'rgb(var(--sunken))' }} aria-hidden="true">
        {total > 0 && (
          <div className="flex h-full" style={{ width: `${widthPct}%` }}>
            {GRADER_BREAKDOWN_ORDER.map((key) => {
              const count = Number(row[key]) || 0;
              if (count <= 0) return null;
              return (
                <div
                  key={key}
                  style={{ width: `${(count / total) * 100}%`, background: `rgb(var(${getTaskTypeSegmentColorO(key)}))` }}/>
              );
            })}
          </div>
        )}
      </div>
      {hasStateSlot && (
        <span className="fs-meta inline-flex items-center gap-label-inline whitespace-nowrap text-ink" style={{ width: TASK_TYPE_STATE_SLOT_WIDTH_O, flexShrink: 0 }}>
          {isFailing && <><window.UI.StatusDot status="crit" word={HIGH_FAILURE_RATE_WORD_O} isInText/><span aria-hidden="true">{HIGH_FAILURE_RATE_WORD_O}</span></>}
        </span>
      )}
      <span className="fs-meta tabular-nums text-dim" style={{ width: 56, flexShrink: 0, textAlign: 'right' }}>
        {formatIntO(total)}
      </span>
    </div>
  );
}

// ----- Polar-mismatch cross-tab (confidence × metric_pass) -------------------
// /api/outcomes/cross-analysis cells[] — 서버 계산 is_polar_mismatch 시각화.
// 행 4 (confidence) × 열 3 (metric_pass) = 12 셀 + 합계 행/열 → 5열 이내(라벨+pass+fail+null+합계).
// polar mismatch(overconfidence high+fail · underconfidence low+pass) → ⚠ 기호 + warn 색조 (dual-encoding).

function CrosstabBlock({ state, onRetry, shared }) {
  const crosstab   = state.status === 'ready' ? state.data?.crosstab : null;
  const polarTotal = crosstab ? crosstab.polarTotal : 0;
  const confidentFailed = getConfidentFailedO(crosstab);
  const hasTable = crosstab != null && crosstab.total > 0;

  // the meta keeps the share (width capped at "100.0%"; a count widens with the install) → the count rides the hover title
  return (
    <FoldBlockO
      id={REGION_CARD_IDS.crosstab}
      title="Confident but failed"
      status={(confidentFailed || state.status === 'ready') && (
        <span className="inline-flex items-center gap-label-inline fs-meta text-dim">
          {confidentFailed && (
            <span title={`${formatIntO(confidentFailed.count)} of ${formatIntO(crosstab.total)} records · ${formatRateO(confidentFailed.share)}`}>
              {formatRateO(confidentFailed.share)}
            </span>
          )}
          {state.status === 'ready' && (polarTotal > 0
            ? <window.UI.HeadStatus tone="warn">{formatIntO(polarTotal)} mismatches</window.UI.HeadStatus>
            : <window.UI.AbsentValue kind="none"/>)}
        </span>
      )}
      info={<p className="fs-body">Records whose writer reported high confidence while the record's own check failed. Empty rows are hidden.</p>}
      // the table's edge cells carry the card padding → the head takes the same inset; loading, error and empty keep none
      isFlush={hasTable}>
      <CrosstabBody state={state} onRetry={onRetry} shared={shared}/>
    </FoldBlockO>
  );
}

function CrosstabBody({ state, onRetry, shared }) {
  const view = window.UI.getRegionView(state);
  if (view === 'loading') {
    return <window.UI.LoadingPlaceholder label="cross table" minHeight={160}/>;
  }
  if (view === 'error') {
    return <RegionErrorO source="cross table" state={state} onRetry={onRetry} shared={shared} focusTargetId={REGION_CARD_IDS.crosstab}/>;
  }

  const crosstab = state.data?.crosstab;
  if (!crosstab || crosstab.total === 0) {
    return <window.UI.EmptyState message="No confidence-vs-self-check records in this period."/>;
  }

  // the page's own-face table class: the .tbl cell geometry and the ledger's column-header face, no clickable-row hover (these rows open nothing)
  return (
    <window.UI.Table caption="Records by writer confidence and self-check result" columns={CROSSTAB_COLUMNS_O}
      className={OWN_FACE_TABLE_CLASS_O}
      bodies={[{ key: 'body', rows: (view) => getCrosstabVisibleRowsO(crosstab.byCell).map((rowKey) => (
        <CrosstabRow key={rowKey} view={view} rowKey={rowKey} byCell={crosstab.byCell}/>
      )) }]}
      foot={(view) => <CrosstabTotalRow view={view} byCell={crosstab.byCell} total={crosstab.total}/>}/>
  );
}

const CROSSTAB_COLUMNS_O = [
  { key: 'confidence', label: 'Confidence \\ self-check' },
  ...CROSSTAB_METRIC_COLS.map((col) => ({ key: col.key, label: col.label, isNumeric: true })),
  { key: 'total', label: 'Total', isNumeric: true },
];

function CrosstabRow({ view, rowKey, byCell }) {
  const { TableRow, TableCell } = window.UI;
  let rowTotal = 0;
  for (const col of CROSSTAB_METRIC_COLS) {
    rowTotal += (byCell[`${rowKey}|${col.key}`]?.count) || 0;
  }

  return (
    <TableRow view={view}>
      <TableCell view={view} kind="row-header" className="font-medium">{rowKey === 'null' ? 'None' : rowKey}</TableCell>
      {CROSSTAB_METRIC_COLS.map((col) => {
        const cell = byCell[`${rowKey}|${col.key}`] || { count: 0, isPolar: false };
        return <CrosstabCell key={col.key} view={view} cell={cell} rowLabel={rowKey} colLabel={col.label}/>;
      })}
      <TableCell view={view} textRole="meta" label="Total" isNumeric className="text-dim">{formatIntO(rowTotal)}</TableCell>
    </TableRow>
  );
}

// high confidence with a failed check, or low confidence with a passed one
const POLAR_CELL_NOTE_O = 'confidence and check disagree';

function CrosstabCell({ view, cell, rowLabel, colLabel }) {
  const { TableCell } = window.UI;
  const count = cell.count || 0;

  return (
    <TableCell
      view={view}
      isNumeric
      title={`${rowLabel} × ${colLabel}: ${formatIntO(count)}${cell.isPolar ? ` · ${POLAR_CELL_NOTE_O}` : ''}`}
      aria-label={`confidence ${rowLabel} metric ${colLabel} ${count}${cell.isPolar ? `, ${POLAR_CELL_NOTE_O}` : ''}`}>
      <span className="inline-flex items-center gap-label-inline justify-end">
        {cell.isPolar && count > 0 && <span aria-hidden="true" style={{ color: 'rgb(var(--warn))' }}><GlyphO name="warn"/></span>}
        <span className={count > 0 ? 'text-ink' : 'text-faint'}>{formatIntO(count)}</span>
      </span>
    </TableCell>
  );
}

function CrosstabTotalRow({ view, byCell, total }) {
  const { TableRow, TableCell } = window.UI;
  return (
    <TableRow view={view}>
      <TableCell view={view} kind="row-header" className="font-medium">Total</TableCell>
      {CROSSTAB_METRIC_COLS.map((col) => {
        let colTotal = 0;
        for (const rowKey of CROSSTAB_CONFIDENCE_ROWS) {
          colTotal += (byCell[`${rowKey}|${col.key}`]?.count) || 0;
        }
        return (
          <TableCell key={col.key} view={view} textRole="meta" label={col.label} isNumeric className="text-dim">{formatIntO(colTotal)}</TableCell>
        );
      })}
      <TableCell view={view} textRole="meta" label="Total" isNumeric className="text-ink font-semibold">{formatIntO(total)}</TableCell>
    </TableRow>
  );
}

function getConfidentFailedO(crosstab) {
  if (!crosstab || !(crosstab.total > 0)) return null;
  const count = crosstab.byCell?.['high|false']?.count || 0;
  return { count, share: count / crosstab.total };
}

function getCrosstabVisibleRowsO(byCell) {
  return CROSSTAB_CONFIDENCE_ROWS.filter((rowKey) =>
    CROSSTAB_METRIC_COLS.some((col) => (byCell[`${rowKey}|${col.key}`]?.count || 0) > 0));
}

// ----- Loop-events log (raw daemon cycle stream, relocated from Learning) -----
// /api/improvement/loop-events — core.autoagent_loop_events per-cycle stage stream.
// operational data, not an aggregate signal → owned by Task results
// fixed-height scroll log + summary count row (plain tabular count) + event table (row = event · 5 columns)
// density: row labels --dim · timestamps sans tabular-nums · agent truncate + tooltip
// eval_result → loopResultMetaO symbol (tone color) + label, no badge

// the fold is the log's one box → its flush body; the wrapper stays mounted in every state as the Retry focus target
function LoopEventsRegion({ state, onRetry, shared }) {
  return (
    <div id={REGION_CARD_IDS.loopEvents}>
      <LoopEventsBody state={state} onRetry={onRetry} shared={shared}/>
    </div>
  );
}

function LoopEventsBody({ state, onRetry, shared }) {
  const view = window.UI.getRegionView(state);
  if (view === 'loading') {
    return <window.UI.LoadingPlaceholder label="run events" minHeight={200}/>;
  }
  if (view === 'error') {
    return <RegionErrorO source="run events" state={state} onRetry={onRetry} shared={shared} focusTargetId={REGION_CARD_IDS.loopEvents} isInset/>;
  }

  const total    = Number(state.data?.total_events ?? 0);
  const events   = Array.isArray(state.data?.events) ? state.data.events : [];
  const dist     = Array.isArray(state.data?.result_distribution) ? state.data.result_distribution : [];

  if (total === 0 || events.length === 0) {
    // 폴드 body 는 flush(테이블 가장자리 셀이 inset 소유) → empty 줄만 card-pad 를 직접 받음
    return <div className="p-card-pad"><window.UI.EmptyState message="No run events recorded yet."/></div>;
  }

  const distMap = {};
  for (const d of dist) distMap[d.eval_result || 'unknown'] = Number(d.count ?? 0);
  const verifiedCnt = distMap.verified || 0;
  const rejectCnt   = distMap.reject || 0;

  // summary = category symbol (tone) + label + count in plain ink (color ≠ count)
  const summary = [
    ['ok',   'check', 'Runs applied',  verifiedCnt],
    ['crit', 'x',     'Runs declined', rejectCnt],
    ['info', 'info',  'All events',    total],
  ];

  const { Stack, Cluster, Table } = window.UI;
  const getRows = (tableView) => events.map((event) => <LoopEventRowO key={event.id} event={event} view={tableView}/>);
  return (
    <Stack gap="block" className="pt-card-pad">
      <Cluster gap="control-group" className="px-card-pad">
        {summary.map(([tone, iconName, label, count]) => (
          <span key={label} className="fs-body inline-flex items-center gap-label-inline">
            <span style={{ color: `rgb(var(--${tone}))` }} aria-hidden="true"><GlyphO name={iconName}/></span>
            <span className="text-dim">{label}</span>
            <span className="text-ink tabular-nums">{formatIntO(count)}</span>
          </span>
        ))}
      </Cluster>
      {/* fixed-height scroll → the raw log never stretches the page (max-height 42vh + inner scroll); the sticky head stops at its top */}
      <div className="overflow-y-auto" style={{ maxHeight: '42vh' }}>
        <Table caption="Learning-run events" columns={LOOP_EVENT_COLUMNS_O} isHeadSticky stackBelowPx={LOOP_EVENT_STACK_BELOW_PX}
          className={OWN_FACE_TABLE_CLASS_O} bodies={[{ key: 'events', rows: getRows, className: 'tbl-compact' }]}/>
      </div>
    </Stack>
  );
}

const LOOP_EVENT_COLUMNS_O = Object.freeze([
  { key: 'time', label: 'Time' },
  { key: 'agent', label: 'Agent' },
  { key: 'result', label: 'Result' },
  { key: 'added', label: 'Added', isNumeric: true },
  { key: 'removed', label: 'Removed', isNumeric: true },
]);
// five columns stop fitting under this width → each event stacks onto a two-line item, its agent first
const LOOP_EVENT_STACK_BELOW_PX = 480;

function LoopEventRowO({ event, view }) {
  const { TableRow, TableCell } = window.UI;
  const meta = loopResultMetaO(event.eval_result);
  return (
    <TableRow view={view}>
      <TableCell view={view} textRole="meta" label="Time" className="text-faint tabular-nums whitespace-nowrap">
        {window.UI.formatKstDateTime(event.event_ts)}
      </TableCell>
      <TableCell view={view} className="text-dim truncate" style={{ maxWidth: 160 }} title={event.agent || ''}>
        <window.UI.AgentName name={event.agent}/>
      </TableCell>
      <TableCell view={view} textRole="meta" label="Result" title={String(event.eval_result || '')}>
        <span className="inline-flex items-center gap-label-inline text-ink whitespace-nowrap">
          <span style={{ color: `rgb(var(--${meta.tone}))` }} aria-hidden="true"><GlyphO name={meta.icon}/></span>
          {meta.label}
        </span>
      </TableCell>
      <TableCell view={view} textRole="meta" label="Added" isNumeric className="text-dim">+{formatIntO(Number(event.changes_added ?? 0))}</TableCell>
      <TableCell view={view} textRole="meta" label="Removed" isNumeric className="text-dim">-{formatIntO(Number(event.changes_removed ?? 0))}</TableCell>
    </TableRow>
  );
}

// ----- Panel 1: Filter bar ---------------------------------------------------

// One trigger per axis on the Results bar, after Agent (period → page header, keyword → bar search).
const FILTER_AXES_O = [
  { axis: 'result',      label: 'Result',      options: RESULT_OPTIONS      },
  { axis: 'review_flag', label: 'Flagged',     options: REVIEW_FLAG_OPTIONS },
  { axis: 'task_type',   label: 'Task type',   options: TASK_TYPE_OPTIONS   },
  { axis: 'confidence',  label: 'Confidence',  options: CONFIDENCE_OPTIONS  },
  { axis: 'metric_pass', label: 'Self-check',  options: METRIC_PASS_OPTIONS },
  { axis: 'attribution_source', label: 'Attribution', options: ATTRIBUTION_SOURCE_OPTIONS },
];

// Forensic 'all records' — include_all=1 lifts the server registry gate.
const SCOPE_OPTIONS_O = [
  { value: 'registry', label: 'Registry agents' },
  { value: 'all',      label: 'All records'     },
];

/**
 * The Results filter bar: bar search, then Agent, every axis, Scope and Sort as triggers naming their value.
 * Reset shows while a filter, keyword or the all-records scope is applied — sort orders the rows, it filters none.
 */
function ResultFilterBarO({
  filter, sort, keywordInput, distinctAgents, includeAll,
  onPatchFilter, onKeywordChange, onToggleIncludeAll, onSortChange, onReset,
}) {
  const { FilterBar, BarSearch } = window.UI;
  return <FilterBar label="Result filters" isApplied={isFilterAppliedO(filter, includeAll)} onReset={onReset}>
    <BarSearch label="Keyword search" value={keywordInput} onChange={onKeywordChange}
      placeholder="Search summary, lesson, concerns" />
    <FilterAxisTriggerO axis="Agent" options={buildAgentOptionsO(distinctAgents, filter.agent)} value={filter.agent || ''}
      onPick={(agent) => onPatchFilter({ agent })} />
    {FILTER_AXES_O.map(({ axis, label, options }) => <FilterAxisTriggerO key={axis} axis={label} options={options}
      value={filter[axis] || ''} onPick={(value) => onPatchFilter({ [axis]: value })} />)}
    <FilterAxisTriggerO axis="Scope" options={SCOPE_OPTIONS_O} value={includeAll ? 'all' : 'registry'}
      onPick={(scope) => onToggleIncludeAll(scope === 'all')} />
    <FilterAxisTriggerO axis="Sort" options={SORT_OPTIONS} value={sort} onPick={onSortChange} />
  </FilterBar>;
}

// One radio axis — '' (All) is a real option, so the trigger always names the value in force.
function FilterAxisTriggerO({ axis, options, value, onPick }) {
  return <window.UI.FilterTrigger axis={axis} value={getOptionLabelO(options, value)}
    options={options.map(({ value: key, label }) => ({ key, label }))} chosenKeys={[value]} onPick={onPick} />;
}

// distinct agent ids → the Agent axis options, All first, each under its display name
// a chosen agent outside the facet set (a hash link) stays an option → its trigger and check still name it
function buildAgentOptionsO(agents, chosen) {
  const getName = window.UI.getAgentDisplayName;
  const ids = chosen && !agents.includes(chosen) ? [chosen, ...agents] : agents;
  return [{ value: '', label: 'All' }, ...ids.map((agent) => ({ value: agent, label: getName(agent) }))];
}

// ----- Panel 2: Result table -------------------------------------------------

function ResultTableCard({
  state, rows, totalMatched, page, limit, sort, filter,
  onPageChange, onSortChange, onResetFilter, onRowClick, onRetry, shared, closure, needsYou, needsYouCap, onToggleNeedsYou,
  filterControls = {},
}) {
  const { Card, Pagination } = window.UI;
  const { keywordInput = '', distinctAgents = [], includeAll = false, ...barHandlers } = filterControls;

  return (
    <div id={REGION_CARD_IDS.ledger}>
      {/* lifts the shared 70vh card-body cap → the Routine rows scroll with the page, not in a nested box */}
      <Card
        className="[&>.card-body]:max-h-none [&>.card-body]:overflow-y-visible"
        isFlush
        title="Results"
        sub={state.status === 'ready'
          ? `${formatIntO(totalMatched)} matched`
          : state.status === 'loading' ? 'Loading…' : 'Records unavailable'}
        bar={<ResultFilterBarO filter={filter} sort={sort} keywordInput={keywordInput} distinctAgents={distinctAgents}
          includeAll={includeAll} {...barHandlers} onSortChange={onSortChange} onReset={onResetFilter} />}
        foot={state.status === 'ready' && totalMatched > 0 && (
          <Pagination page={page} pageSize={limit} total={totalMatched} onPageChange={onPageChange} label="Results pages"/>
        )}>
        <ResultTableBody
          state={state}
          rows={rows}
          filter={filter}
          isFilterApplied={isFilterAppliedO(filter, includeAll)}
          sort={sort}
          onSortChange={onSortChange}
          onRowClick={onRowClick}
          onRetry={onRetry} shared={shared}
          closure={closure}
          needsYou={needsYou}
          needsYouCap={needsYouCap}
          onToggleNeedsYou={onToggleNeedsYou}
        />
      </Card>
    </div>
  );
}

function getOptionLabelO(options, value) {
  return options.find((option) => option.value === value)?.label ?? value;
}

// Drawer value → the filter bar's name for it, so bar, ledger cell and drawer agree.
function getDetailValueLabelO(axis, value) {
  const { options } = FILTER_AXES_O.find((group) => group.axis === axis);
  return getOptionLabelO(options, String(value ?? 'null'));
}

function ResultTableBody({
  state, rows, filter, isFilterApplied, sort, onSortChange, onRowClick, onRetry, shared, closure, needsYou, needsYouCap, onToggleNeedsYou,
}) {
  const view = window.UI.getRegionView(state);
  if (view === 'loading') {
    const columns = getLedgerColumnsO(sort, onSortChange);
    return <window.UI.Table caption="Loading outcome records" columns={columns} widths={LEDGER_WIDTHS_O} isHeadSticky className={OWN_FACE_TABLE_CLASS_O}
      bodies={[{ key: 'skeleton', rows: <window.UI.SkeletonRows rows={NEEDS_YOU_PAGE_CAP} columns={columns.length}/>, isBusy: true }]}/>;
  }
  if (state.status === 'blocked') {
    return <PayloadUnavailableO label="Records" isInset/>;
  }
  if (view !== 'ready') {
    return <RegionErrorO source="the record ledger" state={state} onRetry={onRetry} shared={shared} focusTargetId={REGION_CARD_IDS.ledger} isInset/>;
  }
  if (rows.length === 0) {
    return isFilterApplied
      ? <window.UI.EmptyState kind="no-results"/>
      : <window.UI.EmptyState message={`No task results in the last ${filter.days} days.`}/>;
  }

  return (
    <ResultTable
      rows={rows} sort={sort} onSortChange={onSortChange} onRowClick={onRowClick} closure={closure}
      needsYou={needsYou} needsYouCap={needsYouCap} onToggleNeedsYou={onToggleNeedsYou}/>
  );
}

// 서버 attention 술어의 클라이언트 미러 — 한 곳에서만 판정해 같은 행이 두 섹션에 겹치지 않게 한다.
function isNeedsYouRowO(row, closedAt) {
  if (row.review_flag === true) return true;
  if (row.result === 'fail' || row.result === 'blocked') return true;
  return row.result === 'done_with_concerns' && !closedAt;
}

// [Needs you, Routine] 섹션. 빈 섹션은 헤딩째 렌더하지 않는다(빈 자리가 0 으로 읽히지 않게).
// windowNeedsYou 가 있으면 Needs-you 는 창 전체 질의 결과, 없으면 이 페이지 분할로 되돌아간다.
// needsYouCap → Needs-you shows its first N rows and counts the rest in hiddenCount; null shows all.
function buildLedgerSectionsO(rows, closure, windowNeedsYou, needsYouCap = null) {
  const pageNeedsYou = [];
  const routine  = [];
  for (const row of rows) {
    const closedAt = closure?.closedOverrides.get(row.id) ?? row.closed_at ?? null;
    (isNeedsYouRowO(row, closedAt) ? pageNeedsYou : routine).push(row);
  }
  windowNeedsYou = windowNeedsYou && applyClosureToWindowO(windowNeedsYou, rows, closure);
  const allNeedsYouRows = windowNeedsYou ? windowNeedsYou.rows : pageNeedsYou;
  const needsYouRows = needsYouCap == null ? allNeedsYouRows : allNeedsYouRows.slice(0, needsYouCap);
  const hiddenCount = allNeedsYouRows.length - needsYouRows.length;
  const needsYouTotal = windowNeedsYou ? windowNeedsYou.total : allNeedsYouRows.length;
  // shown of total → Needs you counts its window, Routine only this page
  return [
    { key: 'needs-you', label: 'Needs you', heading: `Needs you · ${formatIntO(needsYouRows.length)} of ${formatIntO(needsYouTotal)}`, rows: needsYouRows, hiddenCount, anchorId: LEDGER_NEEDS_YOU_ID },
    { key: 'routine',   label: 'Routine',   heading: `Routine · ${formatIntO(routine.length)} of ${formatIntO(rows.length)} on this page`, rows: routine, hiddenCount: 0 },
  ];
}

function getLedgerDisplayRowsO(sections) {
  return sections.flatMap((section) => section.rows);
}

function getDetailPositionLabelO(displayRows, row) {
  const idx = displayRows.findIndex((r) => r.id === row?.id);
  return idx >= 0 ? `${idx + 1} of ${displayRows.length}` : 'not in this list';
}

// Session closures the window query has not re-read yet → drop them from its rows and total, or a row shows in both sections.
function applyClosureToWindowO(windowNeedsYou, pageRows, closure) {
  const overrides = closure?.closedOverrides;
  if (!overrides || overrides.size === 0) return windowNeedsYou;
  const rowsById = new Map([...pageRows, ...windowNeedsYou.rows].map((row) => [row.id, row]));
  const settledIds = new Set();
  for (const [id, closedAt] of overrides) {
    const row = rowsById.get(id);
    if (row && isNeedsYouRowO(row, row.closed_at ?? null) && !isNeedsYouRowO(row, closedAt)) settledIds.add(id);
  }
  return {
    ...windowNeedsYou,
    rows: windowNeedsYou.rows.filter((row) => !settledIds.has(row.id)),
    total: Math.max(0, windowNeedsYou.total - settledIds.size),
  };
}

function ResultTable({ rows, sort, onSortChange, onRowClick, closure, needsYou, needsYouCap = null, onToggleNeedsYou }) {
  // 5 columns — confidence · self-check · automatic check · reworks · cid live in the drawer; nearly every row's check is 'not checked'.
  const sections = buildLedgerSectionsO(rows, closure, needsYou, needsYouCap);
  const [activeRow, setActiveRow] = useStateO(0);
  const rowStarts = getLedgerRowStartsO(sections);
  const rowCount = getLedgerDisplayRowsO(sections).length;
  const getFocusProps = (row, index) => window.UI.getRowFocusProps({
    index, activeIndex: activeRow, count: rowCount, onActivate: () => onRowClick(row), onActiveChange: setActiveRow,
  });
  const getRows = (view) => sections.flatMap((section, sectionIndex) => (section.rows.length === 0 ? [] : [
    <LedgerGroupRowO key={`group-${section.key}`} section={section} view={view}/>,
    ...section.rows.map((row, i) => <ResultTableRow key={row.id} row={row} view={view} onRowClick={onRowClick} closure={closure}
      isRoutine={section.key === 'routine'} focusProps={getFocusProps(row, rowStarts[sectionIndex] + i)}/>),
    section.key === 'needs-you' && <NeedsYouToggleRowO key={`toggle-${section.key}`} section={section} view={view}
      isCapped={needsYouCap != null} onToggle={onToggleNeedsYou}/>,
  ]));

  // the table's .tbl-wrap is positioned → AgentName's sr-only spans resolve inside it; clipped, never a scroller → the sticky head reaches the page
  return <window.UI.Table caption="Outcome records" columns={getLedgerColumnsO(sort, onSortChange)} widths={LEDGER_WIDTHS_O}
    isHeadSticky stackBelowPx={LEDGER_STACK_BELOW_PX} className={OWN_FACE_TABLE_CLASS_O} bodies={[{ key: 'ledger', rows: getRows }]}/>;
}

const LEDGER_PLAIN_COLUMNS_O = Object.freeze([
  { key: 'agent', label: 'Agent' },
  { key: 'task_type', label: 'Task type' },
  { key: 'result', label: 'Result' },
  { key: 'why', label: 'Why' },
  { key: 'summary', label: 'Summary' },
  { key: 'actions', label: <span className="sr-only">Actions</span> },
]);
// the skeleton and the rows share these → no column moves when rows land; Summary takes the width left, Actions shrinks to its button
const LEDGER_WIDTHS_O = Object.freeze(['120px', '110px', '130px', '150px', '165px', undefined, '1%']);
// the columns stop fitting under this width → each record stacks onto a two-line item, its summary first
const LEDGER_STACK_BELOW_PX = 640;

// aria-sort sits on the Time column's th; the sort button inside it is the Tab stop and takes Enter and Space
function getLedgerColumnsO(sort, onSortChange) {
  const [field, dir] = sort.split(':');
  return [
    { key: 'record_ts', label: <SortButtonO label="Time" sortKey="record_ts" currentSort={sort} onSortChange={onSortChange}/>,
      sort: getAriaSort(field === 'record_ts', dir) },
    ...LEDGER_PLAIN_COLUMNS_O,
  ];
}

function LedgerGroupRowO({ section, view }) {
  const { TableRow, TableCell } = window.UI;
  return <TableRow view={view}><TableCell view={view} kind="group-header" id={section.anchorId}>{section.heading}</TableCell></TableRow>;
}

// Capped → 'Show N more' (N hidden); expanded past the cap → 'Show first N'; nothing to toggle → no row.
function NeedsYouToggleRowO({ section, isCapped, onToggle, view }) {
  const needsYouTotal = section.rows.length + section.hiddenCount;
  const hasToggle = typeof onToggle === 'function'
    && (isCapped ? section.hiddenCount > 0 : needsYouTotal > NEEDS_YOU_PAGE_CAP);
  if (!hasToggle) return null;
  const { TableRow, TableCell } = window.UI;
  return (
    <TableRow view={view}>
      <TableCell view={view} kind="span">
        <button type="button" className="btn ghost sm" aria-expanded={!isCapped} onClick={onToggle}>
          {isCapped ? `Show ${formatIntO(section.hiddenCount)} more` : `Show first ${NEEDS_YOU_PAGE_CAP}`}
        </button>
      </TableCell>
    </TableRow>
  );
}

// section → its first row's index in the one roving sequence the ledger rows share
function getLedgerRowStartsO(sections) {
  let next = 0;
  return sections.map((section) => {
    const start = next;
    next += section.rows.length;
    return start;
  });
}

function getSortArrowIcon(isActive, dir) {
  if (!isActive) return '';
  return dir === 'asc' ? 'arrow-up' : 'arrow-down';
}

function getAriaSort(isActive, dir) {
  if (!isActive) return 'none';
  return dir === 'asc' ? 'ascending' : 'descending';
}

// The 32 control in a th puts the header row on the control-cell step → it stays 40
function SortButtonO({ label, sortKey, currentSort, onSortChange, descOnly }) {
  const [field, dir] = currentSort.split(':');
  const isActive = field === sortKey;
  const arrowIcon = getSortArrowIcon(isActive, dir);

  // descOnly (e.g. revision_count) → backend allowlist 가 desc 만 허용. 활성 상태에서 클릭하면 방향 토글.
  const handleClick = () => {
    if (descOnly) {
      onSortChange(`${sortKey}:desc`);
      return;
    }
    const nextDir = isActive && dir === 'desc' ? 'asc' : 'desc';
    onSortChange(`${sortKey}:${nextDir}`);
  };

  return (
    <button type="button" className="btn ghost sm tbl-sort" onClick={handleClick}>
      {label}
      {arrowIcon && <GlyphO name={arrowIcon} className="text-accent"/>}
    </button>
  );
}

// values only, never key-name digits — the d8 tail sits outside the 4 core keys → excluded from sum + avg
function parseQaScoreO(qaScore) {
  if (typeof qaScore !== 'string' || qaScore.trim() === '') return null;
  const nums = qaScore
    .split(',')
    .filter((pair) => pair.split('=')[0].trim() !== 'd8')
    .flatMap((pair) => pair.slice(pair.indexOf('=') + 1).match(/\d+(\.\d+)?/g) ?? []);
  if (nums.length === 0) return null;
  const sum = nums.reduce((acc, n) => acc + Number(n), 0);
  return { sum, avg: sum / nums.length };
}

// 테이블 metric 컬럼의 점수 슬롯 — 합계를 숫자로 노출 (dot 은 4개 항목 분해를 못 실어 detail 패널에만 남긴다).
//   미보고 행도 '—' 로 같은 폭을 차지해야 열이 세로로 정렬된다.
function QaScoreDotsO({ qaScore }) {
  const score = parseQaScoreO(qaScore);
  if (score == null) return null;
  const avg = score.avg;
  const filled = Math.round(Math.min(Math.max(avg, 0), 5));
  return (
    <span
      className="inline-flex items-center gap-label-inline align-middle"
      role="img"
      aria-label={`qa score ${formatDecimalO(avg)} of 5`}
      title={`QA score: ${qaScore}`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: i < filled ? 'rgb(var(--dim))' : 'rgb(var(--line))' }}
          aria-hidden="true"/>
      ))}
    </span>
  );
}

// revision_count 미니 flag — ≥2 (process improvement 대상, core-learning-log.md) 일 때 UI.Bar 막대 표식.
//   숫자 + warn-tone Bar (max 5 정규화) dual-encode. <2 = 숫자만 (또는 0=dash).
function ResultTableRow({ row, view, onRowClick, closure, isRoutine = false, focusProps }) {
  const { TableRow, TableCell } = window.UI;
  const ts      = formatTimestampO(row.record_ts);
  const summary  = row.summary || '';
  // result tone/icon/label = RESULT_META SoT (T-OUT-1 — 로컬 result→color map 제거, 색맹 안전 듀얼인코딩).
  // closedAt = optimistic override 우선 → 서버 응답 도착 전에도 즉시 종결 표시.
  const closedAt    = closure?.closedOverrides.get(row.id) ?? row.closed_at ?? null;
  const resultMeta  = window.UI.resolveResultMeta(row.result, closedAt);
  const resultLabel = window.UI.resolveResultMeta(row.result, null).label;
  const resultColor = `rgb(var(${resultColorVarO(row.result, closedAt)}))`;
  const isClosing   = closure?.pendingIds.has(row.id) === true;
  const canClose    = row.result === 'done_with_concerns' && !closedAt && typeof closure?.onMarkClosed === 'function';
  const why = getNeedsYouReasonO(row, closedAt);
  // the Routine heading already says "no reason" for every row → that None is spoken, never painted (design.md §12.6 Cells)
  const isWhyBlank = !why && isRoutine;

  return (
    <TableRow
      view={view}
      className="outcome-row cursor-pointer"
      onClick={() => onRowClick(row)}
      {...focusProps}
      aria-label={[row.agent, row.task_type, resultMeta.label, why?.label, row.summary].filter(Boolean).join(' ')}>
      <TableCell view={view} textRole="meta" label="Time" className="text-ink tabular-nums whitespace-nowrap">
        {ts ?? <window.UI.AbsentValue kind="none" title="No record time"/>}
      </TableCell>
      <TableCell view={view} textRole="meta" label="Agent" className="text-ink truncate" style={{ maxWidth: 140 }} title={row.agent}>
        <window.UI.AgentName name={row.agent}/>
      </TableCell>
      <TableCell view={view} textRole="meta" label="Task type" className="text-dim whitespace-nowrap">{row.task_type}</TableCell>
      <TableCell view={view} textRole="meta" label="Result" title={resultMeta.label}>
        {/* result glyph + word and the closure word in one nowrap container — a wrap inside the cell doubles the row height against its siblings */}
        <span className="inline-flex items-center gap-label-inline whitespace-nowrap">
          <span data-group="result" className="inline-flex items-center gap-label-inline text-ink" style={{ fontWeight: 500 }}>
            <span style={{ color: resultColor }} aria-hidden="true"><GlyphO name={resultMeta.icon}/></span>
            {resultLabel}
          </span>
          {/* closure = its own dim glyph + word, so 'Done with caveats' and 'Closed' never read as one run of text */}
          {resultMeta.closed && (
            <span data-group="closure" className="inline-flex items-center gap-label-inline shrink-0 text-dim">
              <span aria-hidden="true"><GlyphO name={resultMeta.icon}/></span>
              {resultMeta.label}
            </span>
          )}
        </span>
      </TableCell>
      <TableCell view={view} textRole="meta" label={isWhyBlank ? undefined : 'Why'} className="text-ink whitespace-nowrap" title={why?.note}>
        {isWhyBlank ? <span className="sr-only">{window.UI.EMPTY_VALUE_TEXT}</span> : (why?.label ?? <window.UI.AbsentValue kind="none"/>)}
      </TableCell>
      {/* width 100% + max-width 0 → the column takes only the width left in the scroller, so the ellipsis stays inside the card */}
      {/* stacked → the summary leads its two-line item at full width, so the wide-mode squeeze drops */}
      <TableCell view={view} className="text-ink" style={view?.isStacked ? undefined : SUMMARY_WIDE_STYLE_O} title={summary}>
        <div className="truncate">{summary}</div>
      </TableCell>
      <TableCell view={view} className="whitespace-nowrap">
        {canClose && <CloseCaveatActionO rowId={row.id} isClosing={isClosing} onClose={closure.onMarkClosed}/>}
      </TableCell>
    </TableRow>
  );
}

// row onClick opens the drawer → the press stops here; pending dims only, no colour turn (a new meaning would read in)
function CloseCaveatActionO({ rowId, isClosing, onClose }) {
  const { RowActions, QuietButton, ROW_CONTROL_PROPS } = window.UI;
  return <RowActions label={`Actions for record ${rowId}`} action={
    <QuietButton {...ROW_CONTROL_PROPS} className="sm" aria-busy={isClosing} style={isClosing ? { opacity: 0.65 } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (!isClosing) onClose(rowId);
      }}>
      {isClosing ? 'Closing…' : 'Close caveat'}
    </QuietButton>
  }/>;
}

const SUMMARY_WIDE_STYLE_O = Object.freeze({ width: '100%', maxWidth: 0 });

const WHY_CAVEAT_OPEN_O = Object.freeze({ label: 'Caveat open', note: 'Caveat open: done, with a caveat not yet closed' });
const WHY_QUARANTINED_O = Object.freeze({ label: 'Quarantined', note: 'Quarantined: left out of analysis stats' });
const WHY_BUDGET_KILLED_O = Object.freeze({ label: 'Budget-killed', note: 'Budget-killed: hit its budget before reporting' });

// Why a row needs a look → the first reason that applies + every reason's note; null when none applies (a broken row's Result cell says it)
function getNeedsYouReasonO(row, closedAt) {
  const flags = window.UI.reviewFlagReasons(row);
  const whys = [
    flags.length > 0 && {
      label: `${flags[0].label}${flags.length > 1 ? ` +${flags.length - 1}` : ''}`,
      note: flags.map((flag) => `${flag.label}: ${flag.title}`).join(' · '),
    },
    row.result === 'done_with_concerns' && !closedAt && WHY_CAVEAT_OPEN_O,
    row.poisoned_window === true && WHY_QUARANTINED_O,
    row.attribution_source === ATTRIBUTION_SOURCE_BUDGET_TRUNCATION && WHY_BUDGET_KILLED_O,
  ].filter(Boolean);
  if (whys.length === 0) return null;
  return { label: whys[0].label, note: whys.map((why) => why.note).join(' · ') };
}

// ----- Detail Modal (body_md preview + nav) ----------------------------------

function DetailModal({ detailRow, detailState, rows, onClose, onNav }) {
  // 오버레이/계약(focus-trap · scroll-lock · Esc/X/backdrop · nav Arrow 바인딩)은 DetailSurface 위임.
  const { DetailSurface } = window.UI;

  if (!detailRow) return null;

  // rows = the ledger's displayed order → counter and Prev/Next match what the operator sees.
  const idx     = rows.findIndex((r) => r.id === detailRow?.id);
  const { fields, body } = splitRecordFieldsO(detailState?.status === 'ready' ? detailState.data?.body_md || '' : '');
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < rows.length - 1;

  // identity only — result and time are facts in the body, so the title never restates the ledger row
  const titleParts = [detailRow?.agent, detailRow?.task_type].filter(Boolean);

  // nav footer 와 병존하는 추가 footer — 페이지 내 위치 인디케이터 + 1차 Close 버튼.
  const extraFoot = (
    <>
      <div className="fs-meta text-dim tabular-nums mr-auto">
        {getDetailPositionLabelO(rows, detailRow)}
      </div>
      <button className="btn sm primary" onClick={onClose} aria-label="Close">
        Close
      </button>
    </>
  );

  return (
    <DetailSurface
      open
      onClose={onClose}
      variant="drawer"
      title={titleParts.join(' · ')}
      nav={{ onPrev: () => onNav('prev'), onNext: () => onNav('next'), hasPrev, hasNext }}
      footer={extraFoot}>
      {/* body order: identity (title) → facts → narrative → references */}
      <window.UI.Stack gap="block">
        <DetailMetadata row={detailRow} detail={detailState?.status === 'ready' ? detailState.data : null} recordFields={fields}/>
        <DetailNarrative row={detailRow} detailState={detailState} markdown={body}/>
        <DetailReferences row={detailRow}/>
      </window.UI.Stack>
    </DetailSurface>
  );
}

function getGraderNoteO(verdict) {
  if (verdict === 'unverified') return 'No test artifact to grade for this task type.';
  if (verdict == null) return 'Recorded before the grader existed, not a failure.';
  return '';
}

function DetailMetadata({ row, detail, recordFields = [] }) {
  // defensive guard — undefined row from a React batching edge case
  if (!row) return null;
  const { Stack, DetailField } = window.UI;
  return (
    <Stack gap="list">
      {getDetailFactsO(row, detail, recordFields).map((fact) => (
        <DetailField key={fact.label} label={fact.label} value={fact.value} mono={fact.isMachine === true}/>
      ))}
    </Stack>
  );
}

/**
 * Drawer facts in reading order, an absent fact left out (spec §6: a detail list, not a table cell).
 * evaluative_signal / metric_type exist only on the /api/outcomes/:id detail response → absent until it loads.
 */
function getDetailFactsO(row, detail, recordFields) {
  const facts = [
    row.result && { label: 'Result', value: <ResultFactO result={row.result}/> },
    row.record_ts && { label: 'Time', value: <span className="tabular-nums">{formatTimestampO(row.record_ts)}</span> },
    row.confidence != null && { label: 'Confidence', value: getDetailValueLabelO('confidence', row.confidence) },
    row.metric_pass != null && { label: 'Self-check', value: getDetailValueLabelO('metric_pass', row.metric_pass) },
    { label: 'Automatic check', value: <GraderFactO verdict={row.grader_verdict}/> },
    { label: 'Reworks', value: <span className="tabular-nums">{formatIntO(row.revision_count || 0)}</span> },
    row.review_flag != null && { label: 'Flagged for review', value: <ReviewFlagFactO row={row}/> },
    row.poisoned_window === true && { label: 'Quarantined window', value: 'Yes — excluded from analysis' },
    detail?.evaluative_signal != null && { label: 'User signal', value: formatEvaluativeSignalO(detail.evaluative_signal) },
    detail?.metric_type != null && detail.metric_type !== '' && { label: 'Check type', value: String(detail.metric_type) },
    ...recordFields,
    parseQaScoreO(row.qa_score) != null && { label: 'QA score', value: <QaScoreFactO qaScore={row.qa_score}/> },
  ];
  return facts.filter(Boolean);
}

function ResultFactO({ result }) {
  const meta = window.UI.resolveResultMeta(result, null);
  return (
    <span className="inline-flex items-center gap-label-inline">
      <span style={{ color: `rgb(var(${resultColorVarO(result, null)}))` }} aria-hidden="true"><GlyphO name={meta.icon}/></span>
      {meta.label}
    </span>
  );
}

function GraderFactO({ verdict }) {
  const grader = graderVerdictMetaO(verdict);
  const note = getGraderNoteO(verdict);
  return (
    <span className="inline-flex flex-col items-end">
      <span className="inline-flex items-center gap-label-inline" style={{ color: `rgb(var(${grader.colorVar}))`, fontWeight: 500 }}>
        <GlyphO name={grader.icon}/>
        {grader.label}
      </span>
      {note && <span className="fs-meta text-dim">{note}</span>}
    </span>
  );
}

function ReviewFlagFactO({ row }) {
  const { Badge, reviewFlagReasons } = window.UI;
  return (
    <span className="inline-flex items-center justify-end gap-label-inline flex-wrap">
      {row.review_flag ? 'Yes' : 'No'}
      {/* unknown reasons fold several tokens into one bucket key → index mixed into the React key to avoid collisions */}
      {row.review_flag === true && reviewFlagReasons(row).map((r, i) => (
        <Badge key={`${r.key}#${i}`} role="status" tone="warn" icon title={r.title}>{r.label}</Badge>
      ))}
    </span>
  );
}

function QaScoreFactO({ qaScore }) {
  return (
    <span className="inline-flex items-center gap-label-inline">
      <QaScoreDotsO qaScore={qaScore}/>
      <window.UI.MachineString className="text-dim">{qaScore}</window.UI.MachineString>
    </span>
  );
}

// 서사 영역 (S2 narrative) — lesson(작성자 distilled 패턴) + body_md(전문). 식별/수치 다음, references 앞.
function DetailNarrative({ row, detailState, markdown }) {
  const { lesson, body } = splitLessonO(dropAbsentSectionsO(markdown));
  const lessonText = lesson || row?.lesson;

  return (
    <window.UI.Stack gap="block">
      {lessonText && (
        <window.UI.Stack gap="label">
          <h3 className="fs-title font-semibold">Lesson</h3>
          <p className="fs-body text-ink">{lessonText}</p>
        </window.UI.Stack>
      )}
      <DetailBody detailState={detailState} markdown={body}/>
    </window.UI.Stack>
  );
}

// body_md '## Lesson' section → lifted out so the narrative block prints the lesson once, in full.
function splitLessonO(markdown) {
  const match = /^##\s+Lesson[ \t]*\n([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/m.exec(markdown);
  if (!match) return { lesson: '', body: markdown };
  return { lesson: match[1].trim(), body: markdown.slice(0, match.index) + markdown.slice(match.index + match[0].length) };
}

// Fields the drawer already shows — title (agent/type/result) and references (cid).
const RECORD_FIELDS_SHOWN_ELSEWHERE = new Set(['Agent', 'Task type', 'Result', 'Correlation ID']);

// body_md '## Heading' section holding only a recorder placeholder → left out (spec §6: an absent fact is omitted)
function dropAbsentSectionsO(markdown) {
  return markdown.replace(/^##[ \t]+[^\n]*\n([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/gm, (section, body) => (isAbsentRecordValueO(body) ? '' : section)).trim();
}

// body_md '# Outcome Record' bullet list → drawer facts; the recorder writes a bullet only when its value is set.
function splitRecordFieldsO(markdown) {
  const match = /^#\s+Outcome Record[ \t]*\n((?:[ \t]*\n|- \*\*[^*\n]+\*\*:[^\n]*\n?)*)/m.exec(markdown);
  if (!match) return { fields: [], body: markdown };
  const fields = [];
  for (const [, label, value] of match[1].matchAll(/^- \*\*([^*\n]+)\*\*:[ \t]*(.*?)[ \t]*$/gm)) {
    if (!RECORD_FIELDS_SHOWN_ELSEWHERE.has(label) && !isAbsentRecordValueO(value)) fields.push(getRecordFactO(label, value));
  }
  return { fields, body: (markdown.slice(0, match.index) + markdown.slice(match.index + match[0].length)).trim() };
}

// hooks/track-outcome.sh → BODY_MD: an unset Lesson / Concerns / Directive Hint section body; the rest of the placeholder set is the shared one
const RECORDER_PLACEHOLDERS_O = new Set(['(none)', '(not recorded)']);

function isAbsentRecordValueO(value) {
  return RECORDER_PLACEHOLDERS_O.has(value.trim().toLowerCase()) || !window.UI.hasFieldValue(value);
}

// path-valued record fields → machine strings (spec §2 family rule); Files one path per line (spec §6)
function getRecordFactO(label, value) {
  if (label === 'Tool use') return { label, value: formatToolUseO(value) };
  if (label === 'Style Ref') return { label, value, isMachine: true };
  if (label === 'Files') return { label, value: <FileListO files={value}/> };
  return { label, value };
}

// recorder joins Files with ', '
function FileListO({ files }) {
  const paths = files.split(',').map((path) => path.trim()).filter(Boolean);
  return (
    <ul>
      {paths.map((path, i) => <li key={`${path}#${i}`}><window.UI.MachineString>{path}</window.UI.MachineString></li>)}
    </ul>
  );
}

// Recorder's 'actual=N declared=M' → words; any other shape passes through.
function formatToolUseO(value) {
  const match = /^actual=(\d+)(?: declared=(\d+))?$/.exec(value);
  if (!match) return value;
  const [, actual, declared] = match;
  return `${actual} tool call${actual === '1' ? '' : 's'}${declared ? ` · ${declared} estimated` : ''}`;
}

// references block — the delegation's correlation id, last in the drawer
function DetailReferences({ row }) {
  if (!row?.cid) return null;
  return <window.UI.DetailField label="Correlation ID" value={row.cid} mono/>;
}

// evaluative_signal (-1/0/+1 ternary) → 부호 + 의미 라벨. 숫자 단독 대신 의미 부여 (dual-encoding).
function formatEvaluativeSignalO(signal) {
  const n = Number(signal);
  if (n > 0)  return '+1 (praised)';
  if (n < 0)  return '-1 (corrected)';
  return '0 (neutral)';
}

function DetailBody({ detailState, markdown }) {
  // defensive guard + optional chaining 보존.
  if (!detailState) return <window.UI.LoadingPlaceholder label="body" minHeight={200}/>;

  if (detailState?.status === 'idle' || detailState?.status === 'loading') {
    return <window.UI.LoadingPlaceholder label="body" minHeight={200}/>;
  }
  if (detailState?.status === 'error') {
    const { RegionUnavailable } = window.UI;
    return <RegionUnavailable source="the record body" error={detailState.error}/>;
  }

  if (!markdown) {
    return (
      <p className="fs-body text-faint">No body text — showing the facts only.</p>
    );
  }

  return <MarkdownView markdown={markdown}/>;
}

// SECURITY: marked.parse → DOMPurify.sanitize → HTML. DOMPurify 부재 / parse 실패 시 null 반환 →
// 호출처가 plain <pre> fallback (unsanitized HTML 주입 방지 — core-security.md / OWASP A03).
function sanitizeMarkdownToHtmlO(markdown) {
  const marked   = window.marked;
  const purifier = window.DOMPurify;
  if (!marked || typeof marked.parse !== 'function') return null;
  if (!purifier || typeof purifier.sanitize !== 'function') return null;

  let raw;
  try {
    raw = marked.parse(String(markdown || ''));
  } catch (_e) {
    return null;
  }
  return purifier.sanitize(raw, getBodySanitizeConfigO());
}

// the shared viewer config + no style tag or attribute → nothing paints outside the drawer, which has no style containment
function getBodySanitizeConfigO() {
  const { SANITIZE_CONFIG } = window.UI;
  return {
    ...SANITIZE_CONFIG,
    FORBID_TAGS: [...SANITIZE_CONFIG.FORBID_TAGS, 'style'],
    FORBID_ATTR: [...SANITIZE_CONFIG.FORBID_ATTR, 'style'],
    WHOLE_DOCUMENT: false,
  };
}

function MarkdownView({ markdown }) {
  const html = useMemoO(() => sanitizeMarkdownToHtmlO(markdown), [markdown]);

  if (html === null) {
    // Fallback — raw text as <pre>, HTML interpretation 없음.
    return (
      <pre className="code-block" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
        {String(markdown || '')}
      </pre>
    );
  }

  // SECURITY: html 은 sanitizeMarkdownToHtmlO 의 DOMPurify 통과 결과.
  return (
    <div
      className="outcome-md"
      style={{ maxHeight: '60vh', overflowY: 'auto' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ----- Shared chrome --------------------------------------------------------

/**
 * Plain sentence + next step; the raw answer stays behind Details, Retry only when no page banner owns it.
 * @param state - the failed region: its error is the answer, busy while a Retry re-reads it
 * @param focusTargetId - the region's own card, which takes focus when a focused Retry succeeds
 * @param isInset - a flush card body → the failure takes the card padding as its own inset
 */
function RegionErrorO({ source, state, onRetry, shared, focusTargetId, isInset = false }) {
  const { RegionFailure } = window.UI;
  return <RegionFailure source={source} error={state.error} shared={shared} onRetry={onRetry} isBusy={state.busy} focusTargetId={focusTargetId} className={isInset ? 'p-card-pad' : ''}/>;
}

// the lane owns the failure banner → the body says only '<label> unavailable', never the error twice · isInset → card-pad margin in a flush card body
function PayloadUnavailableO({ label, isInset = false }) {
  return (
    <div className={`fs-meta text-dim ${isInset ? 'p-card-pad' : ''}`.trim()} role="status">
      {label} unavailable — see the alarm above.
    </div>
  );
}

// blocked banner — shown when 30s+ of repeated backend failures suggest an outage rather than a
// transient network blip. User can still trigger refresh manually via the page header.
function BlockedBannerO({ detail }) {
  const { AlertCard } = window.UI;
  return (
    <AlertCard
      tone="warn"
      title="Server not responding (30 s timeout)"
      body="Not responding. Check the service or try again shortly."
      details={detail}/>
  );
}

// ----- Pure helpers ---------------------------------------------------------

// URL hash days 복원 — 'all' 문자열 보존 (북마크/새로고침 시 전체 기간 뷰 유지).
function normalizeDaysFromHashO(raw, fallback) {
  if (raw === OUTCOME_ALL_PERIOD) return OUTCOME_ALL_PERIOD;
  return Number(raw) || fallback;
}

function defaultFilterO() {
  return {
    days: 30,
    agent: '',
    task_type: '',
    result: '',
    confidence: '',
    metric_pass: '',
    review_flag: '',
    attribution_source: '',
    q: '',
  };
}

// Reset's visibility — what resetFilter clears, minus period (page header) and sort (an order, not a filter)
function isFilterAppliedO(filter, includeAll) {
  return includeAll || Boolean(filter.agent || filter.q) || FILTER_AXES_O.some(({ axis }) => filter[axis]);
}

// URL hash format: #outcomes?days=30&agent=glass-atrium-dev-react&q=phase&sort=record_ts:desc
// 'outcomes' prefix 는 app.jsx 라우팅 소유, '?' 이후만 파싱. RFC 3986 fragment 내 ':' 안전.
function getHashSearchParams() {
  try {
    const hash = window.location.hash.slice(1);
    const qIdx = hash.indexOf('?');
    return qIdx < 0 ? null : new URLSearchParams(hash.slice(qIdx + 1));
  } catch (_e) {
    return null;
  }
}

function readFilterFromHashO() {
  const def = defaultFilterO();
  const params = getHashSearchParams();
  if (!params) return def;
  return {
    days:        normalizeDaysFromHashO(params.get('days'), def.days),
    agent:       params.get('agent')       || '',
    task_type:   params.get('task_type')   || '',
    result:      params.get('result')      || '',
    confidence:  params.get('confidence')  || '',
    metric_pass: params.get('metric_pass') || '',
    review_flag: params.get('review_flag') || '',
    attribution_source: params.get('attribution_source') || '',
    q:           params.get('q')           || '',
  };
}

function readSortFromHashO() {
  const fallback = 'record_ts:desc';
  const params = getHashSearchParams();
  if (!params) return fallback;
  const sort = params.get('sort');
  return SORT_OPTIONS.some((o) => o.value === sort) ? sort : fallback;
}

// filter 객체에서 빈 값을 제외하고 URLSearchParams 에 set 하는 공통 옵셔널 축 목록.
const OPTIONAL_FILTER_AXES = ['agent', 'task_type', 'result', 'confidence', 'metric_pass', 'review_flag', 'attribution_source', 'q'];

function setOptionalAxesO(params, filter) {
  for (const axis of OPTIONAL_FILTER_AXES) {
    if (filter[axis]) params.set(axis, filter[axis]);
  }
}

function writeFilterToHashO(filter, sort) {
  try {
    const def = defaultFilterO();
    const params = new URLSearchParams();
    if (filter.days && filter.days !== def.days) params.set('days', String(filter.days));
    setOptionalAxesO(params, filter);
    if (sort && sort !== 'record_ts:desc') params.set('sort', sort);

    const hash = window.location.hash.slice(1);
    const qIdx = hash.indexOf('?');
    const screenId = qIdx < 0 ? hash : hash.slice(0, qIdx);
    const search = params.toString();
    const newHash = search ? `${screenId}?${search}` : screenId;
    if (window.location.hash.slice(1) !== newHash) {
      // replaceState → 필터 조정마다 history entry 누적 방지.
      window.history.replaceState(null, '', `#${newHash}`);
    }
  } catch (_e) { /* hash sync best-effort */ }
}

// T7 (O2) forensic 'show all' — include_all=1 은 서버 registry 게이트를 해제해 전체
// all-records 뷰(de-registered / sentinel 포함)를 반환. Pure param setter
// (setOptionalAxesO 미러): 토글 on 일 때만 set, idempotent, side-channel state 없음.
// off → param 생략 → 서버가 기본 registry 게이트 적용.
function setIncludeAllParamO(params, includeAll) {
  if (includeAll) params.set('include_all', '1');
  return params;
}

function buildSearchUrlO(filter, sort, page, limit, includeAll) {
  const params = new URLSearchParams();
  params.set('days',   String(filter.days));
  params.set('limit',  String(limit));
  params.set('offset', String(page * limit));
  params.set('sort',   sort);
  setOptionalAxesO(params, filter);
  setIncludeAllParamO(params, includeAll);
  return `/api/outcomes/search?${params.toString()}`;
}

// Needs-you 창 전체 질의 — ledger 필터 그대로 + attention 술어, 항상 첫 행부터 (page 무관).
function buildNeedsYouUrlO(filter, sort, limit, includeAll) {
  return `${buildSearchUrlO(filter, sort, 0, limit, includeAll)}&needs_attention=true`;
}

// T13 (O2) — agent facet 옵션을 canonical registry 집합에서 생성 (현재 페이지 rows
// 파생 아님 · 구 collectDistinctAgentsO 는 페이지 스코프라 페이지네이션마다 드롭다운이
// 흔들렸다). Pure: canonical keys in → 정렬·중복제거된 non-empty 옵션값 out.
// 빈/부재 입력 → [] (facet 은 'All' 만 노출).
function buildAgentFacetOptionsO(canonicalKeys) {
  if (!Array.isArray(canonicalKeys)) return [];
  const set = new Set();
  for (const key of canonicalKeys) {
    if (typeof key === 'string' && key) set.add(key);
  }
  return Array.from(set).sort();
}

// /api/agents/summary 응답 → canonical agent-id 배열 (서버가 registry 게이트).
// facet 소스가 페이지 rows 대신 registry 집합이 되도록 summary rows 의 agent_id 만 추출.
function extractCanonicalAgentIdsO(summaryData) {
  const agents = summaryData && Array.isArray(summaryData.agents) ? summaryData.agents : [];
  const out = [];
  for (const a of agents) {
    if (a && typeof a.agent_id === 'string' && a.agent_id) out.push(a.agent_id);
  }
  return out;
}

async function fetchJsonO(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw await window.UI.getFetchError(res);
  return res.json();
}

/**
 * One region fetch wave keyed by its URL — held data stays on screen until the answer settles.
 * @param options.mapData - payload → region data
 * @param options.onData - runs only when this wave's answer lands (e.g. advancing the stamp time)
 * @param options.load - reads the wave's payload; defaults to one JSON fetch of url
 * @returns cleanup that aborts the wave; a superseded or aborted wave never lands
 */
function runRegionFetchO(setter, url, { mapData, onData, load = fetchJsonO } = {}) {
  const { putRegionRequest, putRegionData, putRegionFailure } = window.UI;
  const ctrl = new AbortController();
  setter((s) => putRegionRequest(s, url, ctrl));

  load(url, ctrl.signal)
    .then((data) => {
      // effects abort before re-running → an unaborted wave is the newest one
      if (!ctrl.signal.aborted) onData?.();
      setter((s) => putRegionData(s, ctrl, mapData ? mapData(data) : data));
    })
    .catch((err) => setter((s) => putRegionFailure(s, ctrl, err)));

  return () => ctrl.abort();
}

// no rows held + failing past the threshold → outage ('blocked'); held rows stay on screen instead
function putSearchFailureO(state, request, err, elapsedMs) {
  const next = window.UI.putRegionFailure(state, request, err);
  const isOutage = next !== state && next.status === 'error' && elapsedMs >= BACKEND_FAIL_THRESHOLD_MS;
  return isOutage ? { ...next, status: 'blocked' } : next;
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function handleErrorO(err, setter) {
  // AbortError = filter/navigation 전환 — user-visible failure 아님.
  if (err && err.name === 'AbortError') return;
  setter({ status: 'error', data: null, error: errorMessage(err) });
}


// 공용 formatInt 위임 (ui.jsx SoT) — 로컬 재구현 폐기. 음수/NaN → '—' 가드 승격 상속.
const formatIntO = window.UI.formatInt;
const formatPctO = window.UI.formatPct;
const formatDecimalO = window.UI.formatDecimal;

// record_ts = real-UTC ISO (server .toISOString()) → 표시 tz 'MM-DD HH:mm' 표시 · 없음 → null (호출부가 None 표시).
// 직접 getHours()/getMinutes() = 브라우저 로컬 tz → 사용자 지시 'tz 명시' 위반 →
// window.UI.formatKstDateTime (Intl timeZone = config 시드 표시 tz, 로컬 tz 독립) 위임.
function formatTimestampO(iso) {
  if (!iso) return null;
  return window.UI.formatKstDateTime(iso);
}

// held page → the last page that still has rows; an in-range page stays where it is
function getClampedPageO(page, total, pageSize) {
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  return Math.min(page, lastPage);
}

// ----- Attribution Health helpers -------------------------------------------

// 비율(0-1 fraction) → 백분율 문자열 · fixedDigits = 표 열 고정 소수. null/NaN (분모 0) → null → StatRow/호출부가 None 표시.
function formatRateO(rate, fixedDigits) {
  if (rate === null || rate === undefined || Number.isNaN(Number(rate))) return null;
  return formatPctO(Number(rate) * 100, fixedDigits);
}

// literal-omission rate over the selected window → attribution head-status severity tone (colorVar) + copy · null → info tone None (no attributed records)
// no rate (no attributed run) → None with no tone, never a band
function attributionOmissionBadgeO(rate) {
  const band = getAttributionOmissionBandO(rate);
  return band ? { colorVar: band.colorVar, text: band.label } : { colorVar: null, text: <window.UI.AbsentValue kind="none"/> };
}

function getAttributionOmissionBandO(rate) {
  if (rate === null || rate === undefined || Number.isNaN(Number(rate))) return null;
  const value = Number(rate);
  return ATTRIBUTION_OMISSION_BANDS.find((b) => value < b.max) || ATTRIBUTION_OMISSION_BANDS[ATTRIBUTION_OMISSION_BANDS.length - 1];
}

// 활동일만 담긴 days_series ('YYYY-MM-DD' ASC) → 최근 N 일 0-fill 그리드.
// backend 가 비활동일을 누락하므로 day → point map 으로 매핑, 없는 날짜는 0 막대.
// 최초 활동일보다 이전 날짜는 out-of-range(데이터 창 미포함) → outOfRange 플래그로 진짜 0활동일과 구분.
function buildAttributionGridO(series, barCount) {
  const byDay = new Map();
  let earliestKey = null;
  for (const point of series) {
    if (point && typeof point.day === 'string') {
      byDay.set(point.day, point);
      if (earliestKey === null || point.day < earliestKey) earliestKey = point.day;
    }
  }

  const out = [];
  const cursor = new Date();
  // 가장 최신 활동일 기준이 아닌 '오늘' 기준 N일 — series 마지막 날짜가 오늘이 아닐 수 있으나
  // backend day 는 UTC date_trunc → ISO 'YYYY-MM-DD' 키 직접 비교로 정렬 일관 유지.
  for (let i = barCount - 1; i >= 0; i--) {
    const d = new Date(cursor);
    d.setUTCDate(d.getUTCDate() - i);
    const key = isoDayKeyO(d);
    const hit = byDay.get(key);
    if (hit) {
      out.push({ ...hit, outOfRange: false });
      continue;
    }
    // earliestKey 보다 이전 = 데이터 창 시작 전(out-of-range) · 그 이후 = 진짜 0활동일.
    const outOfRange = earliestKey !== null && key < earliestKey;
    out.push({ day: key, healthy: 0, attribution_loss: 0, literal_omission: 0, synthesized: 0, total: 0, outOfRange });
  }
  return out;
}

// Date → 'YYYY-MM-DD' (UTC) — backend date_trunc('day', record_ts) 키와 정합.
function isoDayKeyO(date) {
  const yyyy = date.getUTCFullYear();
  const mm   = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 'YYYY-MM-DD' → 'MM-DD' (축 라벨용)
const attributionDayLabelO = window.UI.formatKstDay;

// ----- 분석 섹션 helpers -----------------------------------------------------

// cross-analysis by_result → { result: writer-emitted count } — 모집단 writerTotal 과 같은 사실 (getWriterCount SoT).
// ANALYTICS_KPI_ORDER 4 키 기본값 0 보장.
function buildByResultCountMapO(byResult) {
  const out = {};
  for (const key of ANALYTICS_KPI_ORDER) out[key] = 0;
  if (!Array.isArray(byResult)) return out;
  for (const row of byResult) {
    if (row && typeof row.result === 'string') {
      out[row.result] = window.UI.getWriterCount(row);
    }
  }
  return out;
}

// cross-analysis payload → analytics card data. The agent stack stays uncapped: the failure table must list every failing registry agent.
function buildAnalyticsDataO(overall) {
  return {
    overall,
    byResultCount: buildByResultCountMapO(overall.by_result),
    agentStack: buildAgentStackO(overall.by_agent_result, ANALYTICS_KPI_ORDER),
    crosstab: buildCrosstabO(overall.cells),
  };
}

// cross-analysis by_agent_result (단일 GROUP BY (agent, result)) → 에이전트별 스택 행.
// 이전 per-result top-10 4-list stitch(는 #11↓ agent 를 소리없이 누락 = 근사치)를 대체 —
// 서버가 canonical agent 전체의 모든 result 를 한 쿼리로 반환하므로 per-agent total 이 정확히 정합.
// resultOrder(4-KPI) 밖 result(needs_context 등)는 스택 미표시 → total/byResult 에서 제외(막대 합 100%).
// reconstructed = reconstructed_count 누적(합성 복구행) — headline 을 writer-emitted(total-reconstructed)로 분리.
// 반환: total desc top-N (topN 생략 시 전체).
function buildAgentStackO(byAgentResult, resultOrder, topN) {
  const resultSet = new Set(resultOrder);
  const byAgent = new Map();
  const rows = Array.isArray(byAgentResult) ? byAgentResult : [];
  for (const row of rows) {
    if (!row || typeof row.agent !== 'string' || !resultSet.has(row.result)) continue;
    const entry = byAgent.get(row.agent) || { agent: row.agent, byResult: {}, total: 0, reconstructed: 0 };
    const count = Number(row.count) || 0;
    const reconstructed = Math.min(Number(row.reconstructed_count) || 0, count);
    entry.byResult[row.result] = (entry.byResult[row.result] || 0) + count;
    entry.total += count;
    entry.reconstructed += reconstructed;
    byAgent.set(row.agent, entry);
  }
  return Array.from(byAgent.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, topN);
}

// cross-analysis cells[] (12-cell) → confidence×metric_pass 조회 맵 + 합계 (P2 polar-mismatch cross-tab).
// 반환: { byCell:{ 'high|true': {count,isPolar}, ... }, total, polarTotal } — null/누락 셀은 0 채움.
function buildCrosstabO(cells) {
  const byCell = {};
  let total = 0;
  let polarTotal = 0;
  if (Array.isArray(cells)) {
    for (const cell of cells) {
      if (!cell) continue;
      const rowKey = crosstabConfidenceKeyO(cell.confidence);
      const colKey = crosstabMetricKeyO(cell.metric_pass);
      const count  = Number(cell.count) || 0;
      const isPolar = cell.is_polar_mismatch === true;
      byCell[`${rowKey}|${colKey}`] = { count, isPolar };
      total += count;
      if (isPolar) polarTotal += count;
    }
  }
  return { byCell, total, polarTotal };
}

window.ScreenOutcomes = ScreenOutcomes;
