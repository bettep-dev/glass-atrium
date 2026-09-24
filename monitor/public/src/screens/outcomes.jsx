// Screen 04 — Outcome 분석 (live data via /api/outcomes/*) · window.ScreenOutcomes.
// 상단 분석 섹션 + 하단 탐색기 섹션 (필터 사이드바 280px + 결과 표).
// Hooks aliased with O suffix → 모듈 간 window-scope 충돌 회피.
//
// SECURITY: MarkdownView 는 DOMPurify 게이트 통과 후에만 HTML 주입 (부재 시 raw pre fallback).
// body_md 에 concerns/lesson 등 user-supplied 문자열 보간 가능 → sanitization 필수 (core-security.md).
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
  unverified:    { label: 'Auto-check N/A',           symbol: '○', icon: 'circle', colorVar: '--dim'   },
  verified_fail: { label: 'Check failed',             symbol: '✕', icon: 'x',      colorVar: '--crit'  },
  not_measured:  { label: 'Pre-grader (legacy)',      symbol: '–', icon: 'minus',  colorVar: '--faint' },
};

// downgrade_origin 분포 순서 + 메타 — cross-analysis downgrade_breakdown 소비. writer_true_downgraded
// (작성자 pass 주장 ↔ grader 불일치)가 가장 actionable. not_recorded(레거시 NULL)는 disagreement 아님 → muted.
const DOWNGRADE_BREAKDOWN_ORDER = ['writer_true_downgraded', 'writer_false', 'synthesized', 'not_recorded'];
const DOWNGRADE_BREAKDOWN_META = {
  writer_true_downgraded: { label: 'Writer/grader disagreement', icon: 'warn',   colorVar: '--warn'  },
  writer_false:           { label: 'Writer self-reported fail',  icon: 'minus',  colorVar: '--dim'   },
  synthesized:            { label: 'Harness-reconstructed',      icon: 'circle', colorVar: '--faint' },
  not_recorded:           { label: 'Pre-provenance (legacy)',    icon: 'minus',  colorVar: '--faint' },
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

// Sort options — 백엔드 allowlist 와 동일 wire format (chip → hash → URL 변환 미경유).
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

// colorVar(--ok/--warn/--crit/--info) → canonical Badge tone 이름. 비-tone(--dim/--faint/--accent) → 'neutral'.
//   ad-hoc tone-fill 배지를 canonical Badge(role=status)로 접을 때 tone prop 공급 — shell 은 neutral 유지, 색은 내부 Icon 이 운반.
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
  healthy:          { label: 'Recorded properly', symbol: '✓', icon: 'check', colorVar: '--ok'   },
  attribution_loss: { label: 'Untraceable',       symbol: 'ℹ', icon: 'info',  colorVar: '--info' },
  literal_omission: { label: 'Missing report',    symbol: '✕', icon: 'x',     colorVar: '--crit' },
  synthesized:      { label: 'Reconstructed',     symbol: '⚠', icon: 'warn',  colorVar: '--warn' },
};

// literal_omission 선택 기간 비율 → 심각도 밴드 (분모 = 선택 기간 전체 창).
const ATTRIBUTION_OMISSION_BANDS = [
  { max: 0.03, symbol: '✓', icon: 'check', colorVar: '--ok',   label: 'OK'          },
  { max: 0.08, symbol: '⚠', icon: 'warn',  colorVar: '--warn', label: 'Watch'       },
  { max: Infinity, symbol: '✕', icon: 'x', colorVar: '--crit', label: 'Investigate' },
];

// attribution_loss 노트 컨텍스트 (정적 문구 — 건수·비율은 window_summary 에서 라이브 산출).
const ATTRIBUTION_LOSS_CONTEXT = 'remaining';

// Channel liveness 표시 메타 — 3-상태 듀얼인코딩(기호+텍스트, 색 단독 의존 금지).
// 판정(alerting/eligible)은 서버가 내리고 카드는 그 값만 읽는다 → 임계값이 프런트에 재등장하지 않음.
const CHANNEL_LIVENESS_META = {
  alerting: { label: 'Silent',      symbol: '✕', icon: 'x',     colorVar: '--crit' },
  live:     { label: 'Recording',   symbol: '✓', icon: 'check', colorVar: '--ok'   },
  low:      { label: 'Below floor', symbol: 'ℹ', icon: 'info',  colorVar: '--info' },
};

// 채널 1건 → 표시 메타. eligible 하지 않은 채널의 침묵은 뉴스가 아니므로 'low' 로 내린다.
function channelLivenessMetaO(channel) {
  if (channel.alerting) return CHANNEL_LIVENESS_META.alerting;
  return channel.eligible ? CHANNEL_LIVENESS_META.live : CHANNEL_LIVENESS_META.low;
}

// window_summary.attribution_loss_rate × total_attributed → '{count} (~{rate}%) {context}' 라이브 노트.
// rate null(분모 0) → 컨텍스트만 표기 (수치 fabrication 회피).
function buildAttributionLossNoteO(lossRate, totalAttributed) {
  if (lossRate === null || lossRate === undefined || Number.isNaN(Number(lossRate))) {
    return ATTRIBUTION_LOSS_CONTEXT;
  }
  const rate  = Number(lossRate);
  const count = Math.round(rate * (Number(totalAttributed) || 0));
  return `${formatIntO(count)} (~${(rate * 100).toFixed(1)}%) ${ATTRIBUTION_LOSS_CONTEXT}`;
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

// window_summary.dev_scope → DEV-agent truncation/synthesized baseline (compact 2-tile).
//   同一 window 텔레메트리의 DEV 하위집합 — no-[COMPLETION]/budget-truncation 실패 모드를
//   DEV 에이전트 한정으로 가시화 + rolling baseline(비율 자체가 baseline).
//   DEV window 에 귀속행 0건(부재/빈 subset) → null (0/0 clutter 회피).
function AttributionDevScopeO({ devScope }) {
  if (!devScope || typeof devScope !== 'object') return null;
  const total = Number(devScope.total_attributed) || 0;
  if (total <= 0) return null;
  const truncCount = Number(devScope.budget_truncation_count) || 0;
  return (
    <div className="mt-3 pt-3 border-t border-line">
      <div className="fs-micro font-mono text-faint uppercase tracking-wider mb-1.5">
        DEV agents · truncation baseline
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div
          className="bg-elev rounded-md p-2.5 border border-line"
          title="Rate at which DEV agents ran out of budget before reporting a result over the selected window — the rolling baseline to watch for recurrence">
          <div className="fs-micro font-mono text-dim">Budget-kill rate</div>
          <div className="fs-stat font-semibold text-ink mt-1 font-mono">{formatRateO(devScope.budget_truncation_rate)}</div>
          <div className="fs-micro font-mono text-dim mt-0.5">{formatIntO(truncCount)} of {formatIntO(total)}</div>
        </div>
        <div
          className="bg-elev rounded-md p-2.5 border border-line"
          title="Synthesized-outcome rate for DEV agents — harness recovery when the agent reported no result (not a failure, a recovery artifact)">
          <div className="fs-micro font-mono text-dim">Synthesized rate</div>
          <div className="fs-stat font-semibold text-ink mt-1 font-mono">{formatRateO(devScope.synthesized_rate)}</div>
          <div className="fs-micro font-mono text-dim mt-0.5">recovered from missing report</div>
        </div>
      </div>
    </div>
  );
}

// budget_truncation_by_agent → 'Budget-killed subagents (7d)' 컴팩트 미니리스트 (agent → count, 서버가 count DESC 정렬).
//   빈 배열/부재 → null (저볼륨 신호라 non-empty 일 때만 노출 · 빈-상태 clutter 회피).
function AttributionBudgetKillListO({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (
    <div className="mt-3 pt-3 border-t border-line">
      <div className="fs-micro font-mono text-faint uppercase tracking-wider mb-1.5">
        Budget-killed subagents (7d)
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <div key={r.agent} className="flex items-center justify-between fs-micro font-mono">
            <span className="text-dim truncate" style={{ maxWidth: 220 }} title={r.agent}><window.UI.AgentName name={r.agent}/></span>
            <span className="text-ink font-semibold tabular-nums">{formatIntO(r.count)}</span>
          </div>
        ))}
      </div>
    </div>
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

// Needs-you 질의 — 서버 parseFilters 는 needs_attention 에 'true'|'false' 만 받는다(그 밖 → 400).
// 창은 analyticsDaysO 로 접힌 분석 창: 타일 1 의 분자·분모가 다른 창을 읽으면 비율이 성립하지 않는다.
// limit=1 → total 만 소비.
function buildAttentionParamsO(days) {
  return new URLSearchParams({ days: String(days), needs_attention: 'true', limit: '1' });
}

// 자가개선 데몬 사이클 raw 이벤트 로그 — Learning 화면에서 이관(operational data, 집계 신호 아님).
//   소유 endpoint: /api/improvement/loop-events (core.autoagent_loop_events per-cycle stage stream).
const LOOP_EVENTS_URL = '/api/improvement/loop-events?limit=50';

// daemon eval_result → dual-encoded 배지 (색 + 기호 + 라벨, 색맹 안전).
//   verified=✓ ok · reject/fail=✕ crit · *_dryrun=⚠ warn(드라이런 — 미적용) · 기타 fallback ℹ info.
function loopResultMetaO(result) {
  if (result === 'verified') return { tone: 'ok', symbol: '✓', icon: 'check', label: 'Passed' };
  if (result === 'reject' || result === 'fail') return { tone: 'crit', symbol: '✕', icon: 'x', label: result === 'fail' ? 'Failed' : 'Declined' };
  if (typeof result === 'string' && result.endsWith('_dryrun')) return { tone: 'warn', symbol: '⚠', icon: 'warn', label: 'Dry run' };
  return { tone: 'info', symbol: 'ℹ', icon: 'info', label: result || '—' };
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
@keyframes skelPulseO { 0%,100%{opacity:.7} 50%{opacity:.35} }
.outcome-md { font-size: var(--fs-body); line-height: 1.65; color: rgb(var(--ink)); font-family: 'Pretendard Variable', Pretendard, ui-sans-serif, system-ui, sans-serif; }
/* md 헤딩 3레벨 → title 토큰 공통 (동일 content-level) · 시각 위계는 font-weight 600 + margin 으로 보존 */
.outcome-md h1, .outcome-md h2, .outcome-md h3, .outcome-md h4 { font-weight: 600; margin: 14px 0 6px; line-height: 1.3; }
.outcome-md h1, .outcome-md h2, .outcome-md h3 { font-size: var(--fs-title); }
.outcome-md p { margin: 6px 0; }
.outcome-md ul, .outcome-md ol { margin: 6px 0; padding-left: 22px; }
.outcome-md li { margin: 2px 0; }
.outcome-md code { font-family: 'JetBrains Mono', monospace; font-size: var(--fs-meta); background: rgb(var(--sunken)); padding: 1px 5px; border-radius: 3px; }
.outcome-md pre { font-family: 'JetBrains Mono', monospace; font-size: var(--fs-meta); background: rgb(var(--sunken)); padding: 10px 12px; border-radius: 6px; border: 1px solid rgb(var(--line)); overflow-x: auto; }
.outcome-md pre code { background: transparent; padding: 0; }
.outcome-md blockquote { border-left: 3px solid rgb(var(--accent)); padding: 2px 12px; margin: 8px 0; color: rgb(var(--dim)); background: rgb(var(--sunken) / 0.4); }
.outcome-md a { color: rgb(var(--accent)); text-decoration: underline; }
.outcome-md table { border-collapse: collapse; margin: 8px 0; font-size: var(--fs-meta); }
.outcome-md th, .outcome-md td { border: 1px solid rgb(var(--line)); padding: 4px 8px; text-align: left; }
.outcome-md th { background: rgb(var(--sunken)); font-weight: 500; }
.outcome-row { transition: background 100ms; }
.outcome-row:hover { background: rgb(var(--accent) / 0.06); }
.outcome-row.is-fail   { box-shadow: inset 3px 0 0 rgb(var(--crit)); }
.outcome-row.is-review { box-shadow: inset 3px 0 0 rgb(var(--warn)); }
.filter-chip { padding: 3px 8px; border-radius: 6px; font-family: 'JetBrains Mono', monospace; font-size: var(--fs-micro); cursor: pointer; border: 1px solid rgb(var(--line)); background: rgb(var(--elev)); color: rgb(var(--dim)); transition: background 100ms, color 100ms; }
.filter-chip:hover { background: rgb(var(--sunken)); color: rgb(var(--ink)); }
.filter-chip.is-active { background: rgb(var(--accent) / 0.14); border-color: rgb(var(--accent) / 0.5); color: rgb(var(--accent)); font-weight: 500; }
`;

function ScreenOutcomes({ onNav }) {
  const { PageHeader, Icon, Pill, TypeScaleStyle, FreshnessStamp } = window.UI;

  // Filter state — URL hash 초기화 → 북마크 / 직접링크 복원.
  const [filter, setFilter] = useStateO(() => readFilterFromHashO());
  const [page,   setPage]   = useStateO(0);
  const [sort,   setSort]   = useStateO(() => readSortFromHashO());

  // 키워드 입력은 filter 와 분리 → debounce 가능 (request thrashing 회피).
  const [keywordInput, setKeywordInput] = useStateO(filter.q || '');

  const [searchState, setSearchState] = useStateO({ status: 'loading', data: null, error: null });
  // ledger 의 Needs-you 섹션 — 페이지가 아닌 창 전체를 읽는다(stream 1 attention 술어).
  const [needsYouState, setNeedsYouState] = useStateO({ status: 'loading', data: null, error: null });

  // 창은 filter.days 하나 — 헤더 컨트롤이 ledger 와 분석을 함께 움직인다 (두 period 컨트롤 병합).
  const analyticsPeriod = analyticsDaysO(filter.days);
  const [analyticsState,  setAnalyticsState]  = useStateO({ status: 'loading', data: null, error: null });

  // Attribution Health — /api/outcomes/attribution-daily (analyticsPeriod 와 동일 window).
  const [attributionState, setAttributionState] = useStateO({ status: 'loading', data: null, error: null });

  // Channel liveness — /api/outcomes/channel-liveness. analyticsPeriod 에 연동하지 않는다:
  // eligibility 는 peak-daily 를 읽으므로 창을 넓히면 수 주 전 버스트로 계속 자격이 유지된다.
  const [channelLivenessState, setChannelLivenessState] = useStateO({ status: 'loading', data: null, error: null });

  // Needs-you 모집단 — 서버 attention 술어(needs_attention) 를 그대로 읽는다. limit=1 → total 만 소비.
  const [attentionState, setAttentionState] = useStateO({ status: 'loading', data: null, error: null });

  // Loop-events raw 로그 — Learning 에서 이관(operational data). period 무관 all-time → refreshTick 만 의존.
  const [loopEventsState, setLoopEventsState] = useStateO({ status: 'loading', data: null, error: null });

  // Detail modal — active row + body_md (optional).
  const [detailRow,   setDetailRow]   = useStateO(null);
  const [detailState, setDetailState] = useStateO({ status: 'idle', data: null, error: null });

  const [refreshTick, setRefreshTick] = useStateO(0);

  // as-of = 마지막으로 성공한 fetch 의 수신 시각 (요청 시각 아님) — 화면 전체에 하나만 둔다.
  const [asOfAt, setAsOfAt] = useStateO(null);
  const markFreshO = useCallbackO(() => setAsOfAt(new Date().toISOString()), []);

  // T13 (O2) — canonical agent facet 소스 (registry 게이트된 /api/agents/summary).
  const [canonicalAgentsState, setCanonicalAgentsState] = useStateO({ status: 'loading', data: null, error: null });

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

  // 탐색기 fetch — filter / sort / page / refresh 변경 시 재실행.
  useEffectO(() => {
    const ctrl = new AbortController();
    filterAbortRef.current?.abort();
    filterAbortRef.current = ctrl;

    setSearchState({ status: 'loading', data: null, error: null });

    const searchUrl = buildSearchUrlO(filter, sort, page, PAGE_LIMIT_DEFAULT, includeAll);

    fetchJsonO(searchUrl, ctrl.signal)
      .then((data) => {
        firstFailAtRef.current = null;
        markFreshO();
        setSearchState({ status: 'ready', data, error: null });
      })
      .catch((err) => handleSearchErrorO(err, setSearchState, firstFailAtRef));

    return () => ctrl.abort();
  }, [filter, sort, page, refreshTick, includeAll]);

  // page 무관 — Needs-you 는 매 페이지 같은 창 전체 집합이라 page hop 에 재요청하지 않는다.
  useEffectO(() => {
    const ctrl = new AbortController();
    setNeedsYouState({ status: 'loading', data: null, error: null });
    fetchJsonO(buildNeedsYouUrlO(filter, sort, PAGE_LIMIT_DEFAULT, includeAll), ctrl.signal)
      .then((data) => setNeedsYouState({ status: 'ready', data, error: null }))
      .catch((err) => handleErrorO(err, setNeedsYouState));
    return () => ctrl.abort();
  }, [filter, sort, refreshTick, includeAll]);

  // 분석 fetch — 창 변경 시 재실행. AbortController 분리 → 탐색기 wave 와 독립.
  useEffectO(() => {
    const ctrl = new AbortController();
    setAnalyticsState({ status: 'loading', data: null, error: null });

    const crossUrl = `/api/outcomes/cross-analysis?days=${analyticsPeriod}`;

    fetchJsonO(crossUrl, ctrl.signal)
      .then((overall) => {
        const data = buildAnalyticsDataO(overall);
        markFreshO();
        setAnalyticsState({ status: 'ready', data, error: null });
      })
      .catch((err) => handleErrorO(err, setAnalyticsState));

    return () => ctrl.abort();
  }, [analyticsPeriod, refreshTick]);

  // Attribution Health fetch — 같은 window, AbortController 공유 회피 위해 별도 effect.
  // analyticsPeriod {7,30,90} 가 backend 의 ALLOWED_DAYS_NUMERIC 와 동일 → param 검증 추가 불필요.
  useEffectO(() => {
    const ctrl = new AbortController();
    setAttributionState({ status: 'loading', data: null, error: null });

    fetchJsonO(`/api/outcomes/attribution-daily?days=${analyticsPeriod}`, ctrl.signal)
      .then((data) => { markFreshO(); setAttributionState({ status: 'ready', data, error: null }); })
      .catch((err) => handleErrorO(err, setAttributionState));

    return () => ctrl.abort();
  }, [analyticsPeriod, refreshTick]);

  // Channel liveness fetch — days 파라미터 미전달 → 라우트 기본 창을 그대로 사용(카드가 창 폭을
  // 재선언하지 않도록). 표시 라벨은 응답의 days 에서 파생.
  useEffectO(() => {
    const ctrl = new AbortController();
    setChannelLivenessState({ status: 'loading', data: null, error: null });

    fetchJsonO('/api/outcomes/channel-liveness', ctrl.signal)
      .then((data) => { markFreshO(); setChannelLivenessState({ status: 'ready', data, error: null }); })
      .catch((err) => handleErrorO(err, setChannelLivenessState));

    return () => ctrl.abort();
  }, [refreshTick]);

  // Loop-events raw 로그 fetch — period 무관(all-time stream). AbortController 분리 → 부분 실패 격리.
  useEffectO(() => {
    const ctrl = new AbortController();
    setLoopEventsState({ status: 'loading', data: null, error: null });

    fetchJsonO(LOOP_EVENTS_URL, ctrl.signal)
      .then((data) => { markFreshO(); setLoopEventsState({ status: 'ready', data, error: null }); })
      .catch((err) => handleErrorO(err, setLoopEventsState));

    return () => ctrl.abort();
  }, [refreshTick]);

  // T13 (O2) — canonical agent facet 소스 fetch. 레코드 로그는 서버가 registry 로
  // 게이트(T7)하므로 agent facet 은 registry 집합을 나열 (페이지 rows 아님). 소스는
  // /api/agents/summary (registry 게이트 · 활동 스코프) — 넓은 90d 창 + 최대 limit 으로
  // 활성 registry 를 커버. 실패 → 빈 facet (graceful · 'All' 옵션은 항상 유지).
  // explorer 필터와 독립 → 페이지네이션·기간 변경에도 안정.
  useEffectO(() => {
    const ctrl = new AbortController();
    fetchJsonO('/api/agents/summary?days=90&order=runs&limit=50', ctrl.signal)
      .then((data) => setCanonicalAgentsState({ status: 'ready', data, error: null }))
      .catch((err) => handleErrorO(err, setCanonicalAgentsState));

    return () => ctrl.abort();
  }, [refreshTick]);

  useEffectO(() => {
    const ctrl = new AbortController();
    setAttentionState({ status: 'loading', data: null, error: null });

    // include_all 미전송 — 분모(cross-analysis)가 registry 스코프이므로 분자도 같은 스코프를 읽는다.
    const params = buildAttentionParamsO(analyticsPeriod);

    fetchJsonO(`/api/outcomes/search?${params.toString()}`, ctrl.signal)
      .then((data) => { markFreshO(); setAttentionState({ status: 'ready', data, error: null }); })
      .catch((err) => handleErrorO(err, setAttentionState));

    return () => ctrl.abort();
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
  // 미적재·실패 → null: 섹션은 페이지 분할로 되돌아가고 헤더가 'on this page' 로 범위를 밝힌다.
  const ledgerNeedsYou = needsYouState.status === 'ready'
    ? {
      rows: needsYouState.data?.rows ?? [],
      total: Number(needsYouState.data?.total) || 0,
      windowLabel: /^\d+$/.test(String(filter.days)) ? `${filter.days}d` : 'all time',
    }
    : null;

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
    if (!detailRow || rows.length === 0) return;
    const idx = rows.findIndex((r) => r.id === detailRow.id);
    if (idx < 0) return;
    const nextIdx = direction === 'next' ? idx + 1 : idx - 1;
    if (nextIdx < 0 || nextIdx >= rows.length) return;
    setDetailRow(rows[nextIdx]);
  }, [detailRow, rows]);

  return (
    <div className="flex flex-col min-h-0">
      {/* 공유 타입스케일(fs 토큰 + fs 클래스) 마운트 — SPA 단일 screen 모델: outcomes 활성 시 토큰·클래스 가용화 (ui.jsx 정의 소비, 미정의 시 클래스 no-op 회귀 차단). */}
      <TypeScaleStyle/>
      <style>{SCREEN_OUTCOMES_CSS}</style>
      <div className="flex-shrink-0">
        <PageHeader
          title="Task results"
          sub="Agent task outcomes"
          right={
            <>
              <FreshnessStamp {...getFreshnessInputO(asOfAt, [searchState, analyticsState, attributionState, channelLivenessState, loopEventsState, attentionState])}/>
              <WindowSeg value={filter.days} onChange={setWindowDays}/>
              <button className="btn ghost sm" onClick={triggerRefresh} aria-label="Refresh task results">
                <Icon name="refresh" size={14}/>
                Refresh
              </button>
            </>
          }
        />
      </div>

      <AlarmLaneO channelLivenessState={channelLivenessState} searchState={searchState}/>

      <StatusBandO
        analyticsState={analyticsState}
        attentionState={attentionState}
        windowDays={analyticsPeriod}
        onRetry={triggerRefresh}
      />

      {/* 탐색기 — 필터 사이드바 280px + 결과 표 1fr. max-h 78vh 로 페이지 길이 제한. */}
      <div
        className="grid gap-4 mt-4"
        style={{
          gridTemplateColumns: '280px 1fr',
          maxHeight: '78vh',
          minHeight: 0,
        }}>
        <FilterSidebar
          filter={filter}
          keywordInput={keywordInput}
          distinctAgents={distinctAgents}
          includeAll={includeAll}
          sort={sort}
          onPatchFilter={(patch) => { setFilter((p) => ({ ...p, ...patch })); setPage(0); }}
          onKeywordChange={setKeywordInput}
          onToggleIncludeAll={(v) => { setIncludeAll(v); setPage(0); }}
          onSortChange={(v) => { setSort(v); setPage(0); }}
          onReset={resetFilter}
        />
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
          onRowClick={setDetailRow}
          onRetry={triggerRefresh}
          needsYou={ledgerNeedsYou}
          closure={{ pendingIds: closureState.pendingIds, closedOverrides: closureState.closedOverrides, onMarkClosed: markClosedO }}
        />
      </div>

      <AgentFailureTableO state={analyticsState} onRetry={triggerRefresh}/>

      {/* 주간·월간 사실 3종 — 닫힌 채로 바닥에 둔다. 매일 읽는 band/ledger 를 밀어내지 않게. */}
      <DisclosureO title="Reporting health" summary={reportingHealthSummaryO(channelLivenessState)}>
        <AttributionHealthCard state={attributionState} period={analyticsPeriod} onRetry={triggerRefresh}/>
        <ChannelLivenessCard state={channelLivenessState} onRetry={triggerRefresh}/>
      </DisclosureO>

      <DisclosureO title="Self-report quality" summary={selfReportSummaryO(analyticsState)}>
        <GraderBreakdownCard state={analyticsState} onRetry={triggerRefresh}/>
        <CrosstabCard state={analyticsState} onRetry={triggerRefresh}/>
      </DisclosureO>

      {/* Learning 에서 이관된 raw 데몬 사이클 이벤트 로그 — operational data (집계 신호 아님 · W3-T3/T7). */}
      <DisclosureO title="Learning-run events" summary={loopEventsSummaryO(loopEventsState)}>
        <LoopEventsCard state={loopEventsState} onRetry={triggerRefresh}/>
      </DisclosureO>

      {detailRow && (
        <DetailModal
          detailRow={detailRow}
          detailState={detailState}
          rows={rows}
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
    <div className="flex flex-col gap-2 mb-4 flex-shrink-0" role="region" aria-label="Alarms">
      {isBlocked && <BlockedBannerO detail={searchState.error}/>}
      {silent.length > 0 && <SilentChannelRowO channels={silent}/>}
    </div>
  );
}

// 고volume 채널의 침묵은 다른 모든 카드에서 '품질 변화' 로 위장한다 → 레인 행 자격.
function SilentChannelRowO({ channels }) {
  const { Icon } = window.UI;
  return (
    <div
      role="alert"
      className="rounded-md border p-3 flex items-start gap-3 mx-3"
      style={{ background: 'rgb(var(--crit) / 0.08)', borderColor: 'rgb(var(--crit) / 0.4)' }}>
      <Icon name="x" size={16} className="text-crit mt-0.5"/>
      <div className="flex-1 min-w-0">
        <div className="fs-body font-medium text-ink">Recording stopped: {channels.join(', ')}</div>
        <div className="fs-meta text-dim mt-1">
          A channel that was writing daily has recorded nothing — every count below is understated until it resumes.
        </div>
      </div>
    </div>
  );
}

// stamping panels only → any failed read marks the kept stamp stale, so a partial refresh never claims full freshness
function getFreshnessInputO(asOfAt, stampStates) {
  return {
    at: asOfAt,
    loading: stampStates.some((st) => st.status === 'loading'),
    failed: stampStates.some((st) => st.status === 'error'),
  };
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

// 닫힘이 기본인 개시 영역 — 여는 수고가 곧 빈도 순위다. 요약 줄은 열지 않고도 답을 주는 한 줄.
function DisclosureO({ title, summary, children }) {
  return (
    <details className="card mt-4">
      <summary className="px-4 py-3 cursor-pointer select-none flex items-center gap-3">
        <span className="fs-title font-medium text-ink">{title}</span>
        <span className="fs-micro font-mono text-faint ml-auto">{summary}</span>
      </summary>
      <div className="pb-1">{children}</div>
    </details>
  );
}

// 미적재 payload 의 요약 토큰 — loading 과 실패를 구분하고, 어느 쪽도 '이상 없음' 으로 읽히지 않게.
function getUnloadedSummaryO(status) {
  return status === 'loading' ? 'Loading…' : 'Unavailable';
}

function reportingHealthSummaryO(channelLivenessState) {
  if (channelLivenessState.status !== 'ready') return getUnloadedSummaryO(channelLivenessState.status);
  const alerting = channelLivenessState.data?.alerting || [];
  return alerting.length > 0 ? `Silent: ${alerting.join(', ')}` : 'All channels recording';
}

function selfReportSummaryO(analyticsState) {
  if (analyticsState.status !== 'ready') return getUnloadedSummaryO(analyticsState.status);
  const writerTotal = window.UI.getWriterTotal(analyticsState.data?.overall);
  return `${formatIntO(writerTotal)} writer-emitted records`;
}

function loopEventsSummaryO(loopEventsState) {
  if (loopEventsState.status !== 'ready') return getUnloadedSummaryO(loopEventsState.status);
  const events = loopEventsState.data?.events;
  return `${formatIntO(Array.isArray(events) ? events.length : 0)} recent cycle events`;
}

// Needs-you tile → ledger 의 창 전체 Needs-you 헤딩 (hash 라우터라 href 앵커 대신 focus 이동).
const LEDGER_NEEDS_YOU_ID = 'ledger-needs-you';

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

function StatusBandO({ analyticsState, attentionState, windowDays, onRetry }) {
  if (analyticsState.status === 'loading') {
    return (
      <div className="grid grid-cols-4 gap-3 mb-4 flex-shrink-0" aria-busy="true" aria-label="Status band">
        {Array.from({ length: 4 }).map((_, i) => <KpiSkeletonO key={i}/>)}
      </div>
    );
  }
  // blocked 는 레인의 장애 배너가 원인을 소유 → 여기선 '적재 실패' 만. 그 밖의 실패는 band 자리의 배너 하나.
  if (analyticsState.status === 'blocked') {
    return (
      <div className="card mb-4 flex-shrink-0" aria-label="Status band">
        <PayloadUnavailableO label="Status band"/>
      </div>
    );
  }
  if (analyticsState.status !== 'ready') {
    return (
      <div className="mb-4 flex-shrink-0" aria-label="Status band">
        <ErrorBannerO title="Couldn't load the status band" detail={analyticsState.error} onRetry={onRetry}/>
      </div>
    );
  }

  // attention payload 가 아직/영영 없을 때 0 을 그리면 '해결됨' 으로 읽힌다 → null → em-dash.
  const attentionCount = attentionState.status === 'ready'
    ? (Number(attentionState.data?.total) || 0)
    : null;
  const tiles = buildStatusBandTilesO(analyticsState.data, attentionCount);
  // 창은 analyticsDaysO 로 접힌 {7,30,90} 뿐 — 북마크된 'all' 이 90d 를 읽고 'all time' 으로 표기되던 거짓말 제거.
  const windowLabel = `${windowDays}d`;

  const isAttentionFailed = attentionState.status === 'error' || attentionState.status === 'unavailable';

  return (
    <div className="mb-4 flex-shrink-0">
      <div className="grid grid-cols-4 gap-3" role="group" aria-label="Status band">
        {tiles.map((tile) => <BandTileO key={tile.key} tile={tile} windowLabel={windowLabel}/>)}
      </div>
      {isAttentionFailed && (
        <ErrorBannerO title="Couldn't load the needs-you count" detail={attentionState.error} onRetry={onRetry}/>
      )}
    </div>
  );
}

function BandTileO({ tile, windowLabel }) {
  const { TONE_ICON, formatPctWithDenominator } = window.UI;
  const loaded = tile.count !== null && tile.count !== undefined;
  const share  = loaded ? formatPctWithDenominator(tile.count, tile.population) : '—';
  const canJump = Boolean(tile.jumpTo) && loaded && tile.count > 0;
  const ariaLabel = `${tile.label}: ${loaded ? tile.count : 'not loaded'} — ${tile.hint}${canJump ? ' — show them in the ledger' : ''}`;
  const Tag = canJump ? 'button' : 'div';

  return (
    <Tag
      {...(canJump ? { type: 'button', onClick: () => focusLedgerSectionO(tile.jumpTo) } : {})}
      className={canJump ? 'kpi' : 'kpi cursor-default'}
      aria-label={ariaLabel}
      title={tile.hint}>
      <div className="kpi-label">
        <span className={`text-${tile.tone}`} role="img" aria-hidden="true">
          <GlyphO name={TONE_ICON[tile.tone]} size={12}/>
        </span>
        {tile.label}
      </div>
      <div className="kpi-value">{loaded ? formatIntO(tile.count) : '—'}</div>
      <div className="fs-micro font-mono text-faint">{share} · {windowLabel}</div>
    </Tag>
  );
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
    .map((entry) => ({
      agent: entry.agent,
      failed: entry.byResult?.fail || 0,
      blocked: entry.byResult?.blocked || 0,
      openCaveats: openByAgent.has(entry.agent) ? openByAgent.get(entry.agent) : null,
      total: entry.total || 0,
    }))
    .filter((row) => row.failed + row.blocked > 0)
    .sort((a, b) => (b.failed + b.blocked) - (a.failed + a.blocked));
}

function AgentFailureTableO({ state, onRetry }) {
  const { CardHead, STICKY_TH_STYLE } = window.UI;

  return (
    <div className="card mt-4">
      <CardHead title="Failed or blocked by agent" sub="Registry agents only · non-zero rows"/>
      <div className="card-body" style={{ padding: 0 }}>
        <AgentFailureBodyO state={state} onRetry={onRetry} stickyStyle={STICKY_TH_STYLE}/>
      </div>
    </div>
  );
}

const AGENT_FAILURE_COLUMNS_O = [
  { label: 'Agent', align: 'left' },
  { label: 'Failed', align: 'right' },
  { label: 'Blocked', align: 'right' },
  { label: 'Open caveats', align: 'right' },
  { label: 'of records', align: 'right' },
];

// 적재 중에도 표의 모양을 유지 — 빈 본문은 '실패한 agent 없음' 으로 읽힌다.
function AgentFailureSkeletonO({ stickyStyle }) {
  return (
    <table className="w-full fs-meta" style={{ borderCollapse: 'separate', borderSpacing: 0 }} aria-busy={true} aria-label="Loading by-agent failures">
      <thead>
        <tr>
          {AGENT_FAILURE_COLUMNS_O.map(({ label, align }) => (
            <th key={label} className={`text-${align} text-faint fs-micro font-mono uppercase tracking-wider px-3 py-2 border-b border-line`} style={stickyStyle}>{label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {[0, 1, 2].map((i) => (
          <tr key={i}>
            <td colSpan={AGENT_FAILURE_COLUMNS_O.length} className="px-3 py-2 border-b border-line">
              <div style={{ height: 12, borderRadius: 4, background: 'rgb(var(--sunken))', animation: 'skelPulseO 1.4s ease-in-out infinite' }}/>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AgentFailureBodyO({ state, onRetry, stickyStyle }) {
  if (state.status === 'loading') return <AgentFailureSkeletonO stickyStyle={stickyStyle}/>;
  if (state.status === 'error') {
    return <ErrorBannerO title="Couldn't load by-agent failures" detail={state.error} onRetry={onRetry}/>;
  }

  const rows = buildAgentFailureRowsO(state.data?.agentStack, state.data?.overall?.by_agent_top_10);
  if (rows.length === 0) {
    return <EmptyStateO message="No registry agent failed or blocked in this window."/>;
  }

  return (
    <div className="overflow-auto" style={{ maxHeight: 260 }}>
      <table className="w-full fs-meta" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
        <thead>
          <tr>
            {AGENT_FAILURE_COLUMNS_O.map(({ label, align }) => (
              <th key={label} className={`text-${align} text-faint fs-micro font-mono uppercase tracking-wider px-3 py-2 border-b border-line`} style={stickyStyle}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.agent} className="outcome-row">
              <td className="text-left text-ink px-3 py-1.5 border-b border-line truncate" title={row.agent}><window.UI.AgentName name={row.agent}/></td>
              <td className="text-right text-ink font-mono px-3 py-1.5 border-b border-line">{formatIntO(row.failed)}</td>
              <td className="text-right text-ink font-mono px-3 py-1.5 border-b border-line">{formatIntO(row.blocked)}</td>
              <OpenCaveatCellO count={row.openCaveats}/>
              <td className="text-right text-faint font-mono px-3 py-1.5 border-b border-line">{formatIntO(row.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// null = the agent sits outside the top-10 rollup → em-dash, never a zero that was not loaded.
function OpenCaveatCellO({ count }) {
  const isLoaded = count !== null;
  return (
    <td
      className="text-right text-ink font-mono px-3 py-1.5 border-b border-line"
      title={isLoaded ? undefined : 'Not loaded — only the top 10 agents by volume carry an open-caveat count'}>
      {isLoaded ? formatIntO(count) : '—'}
    </td>
  );
}

function KpiSkeletonO() {
  return (
    <div className="kpi" aria-busy="true">
      <div
        style={{
          height: 70,
          borderRadius: 6,
          background: 'rgb(var(--sunken))',
          opacity: 0.7,
          animation: 'skelPulseO 1.4s ease-in-out infinite',
        }}/>
    </div>
  );
}

// ----- Attribution Health (텔레메트리 귀속 품질) ------------------------------
// /api/outcomes/attribution-daily — attribution_source 4-category 분해.
// 일별 stacked-bar (inline SVG, Recharts 미사용) + window 요약 4-tile + literal-omission 심각도 배지.
// NULL attribution_source 행은 backend 가 제외 (귀속 추적 이전 행) → 모든 비율 분모 = total_attributed.

function AttributionHealthCard({ state, period, onRetry }) {
  const { CardHead, Badge } = window.UI;

  const summary = state.status === 'ready' ? state.data?.window_summary : null;
  const omissionRate = summary ? summary.literal_omission_rate : null;
  const badge = attributionOmissionBadgeO(omissionRate);

  return (
    <div className="card mb-4">
      <CardHead
        title="Reporting health"
        sub=""
        right={
          <Badge
            role="status"
            tone={toneFromColorVarO(badge.colorVar)}
            icon
            title={`Missing-report (literal_omission) rate, last ${period} days — hygiene signal over the full selected window`}>
            Missing reports, {period} days: {badge.text}
          </Badge>
        }
      />
      <div className="card-body">
        <AttributionHealthBody state={state} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function AttributionHealthBody({ state, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonO height={200} aria-label="Loading reporting health"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerO title="Couldn't load reporting health" detail={state.error} onRetry={onRetry}/>;
  }

  const series  = Array.isArray(state.data?.days_series) ? state.data.days_series : [];
  const summary = state.data?.window_summary || null;
  const totalAttributed = Number(summary?.total_attributed) || 0;

  // 귀속 기록된 실행 0건 (빈 window) → 안내 indicator.
  if (totalAttributed === 0) {
    return <EmptyStateO message="No attributed runs in this period."/>;
  }

  // 활동일만 backend 전송 → 최근 ATTRIBUTION_GRID_BARS 일 그리드로 0-fill.
  const grid = buildAttributionGridO(series, ATTRIBUTION_GRID_BARS);

  return (
    <div>
      <AttributionSummaryRow summary={summary} totalAttributed={totalAttributed}/>
      <AttributionDailyChart grid={grid}/>
      <AttributionLegend/>
      <div className="fs-micro text-faint font-mono mt-2 leading-relaxed">
        <span className="inline-flex items-center gap-1">
          <span style={{ color: `rgb(var(${ATTRIBUTION_CATEGORY_META.attribution_loss.colorVar}))` }} aria-hidden="true">
            <GlyphO name={ATTRIBUTION_CATEGORY_META.attribution_loss.icon}/>
          </span>
          Untraceable: {buildAttributionLossNoteO(summary?.attribution_loss_rate, totalAttributed)}
        </span>
      </div>
      <AttributionBudgetKillListO rows={summary?.budget_truncation_by_agent}/>
      <AttributionDevScopeO devScope={summary?.dev_scope}/>
    </div>
  );
}

// window 요약 4-tile — 카테고리별 비율 (분모 = total_attributed).
//   'Missing report'(literal_omission) tile 아래 세부 sub-line 추가 — budget-kill/truncated/missing 내역.
//   tile/rate 렌더는 불변 · sub-line 은 count 내역만 (총계·비율 미변경).
function AttributionSummaryRow({ summary, totalAttributed }) {
  const omissionBreakdown = buildLiteralOmissionBreakdownO(summary?.literal_omission_breakdown);
  const omissionMeta = ATTRIBUTION_CATEGORY_META.literal_omission;
  return (
    <div className="mb-4">
      <div className="grid grid-cols-4 gap-2">
        {ATTRIBUTION_CATEGORY_ORDER.map((key) => {
          const meta = ATTRIBUTION_CATEGORY_META[key];
          const rate = summary ? summary[`${key}_rate`] : null;
          const count = Math.round((Number(rate) || 0) * totalAttributed);
          return (
            <div key={key} className="bg-elev rounded-md p-2.5 border border-line">
              <div className="flex items-start gap-1.5 fs-micro font-mono min-h-[2.2em]">
                <span style={{ color: `rgb(var(${meta.colorVar}))` }} aria-hidden="true"><GlyphO name={meta.icon}/></span>
                <span className="text-dim">{meta.label}</span>
              </div>
              <div className="fs-stat font-semibold text-ink mt-1 font-mono">
                {formatRateO(rate)}
              </div>
              <div className="fs-micro font-mono text-dim mt-0.5">{formatIntO(count)}</div>
            </div>
          );
        })}
      </div>
      {omissionBreakdown && (
        <div
          className="fs-micro font-mono text-dim mt-1.5 leading-relaxed"
          title={`Missing report breakdown — budget kill ${formatIntO(omissionBreakdown.budget)}, truncated completion ${formatIntO(omissionBreakdown.truncated)}, completion missing ${formatIntO(omissionBreakdown.missing)} (sums to the Missing report count; the rate is unchanged)`}>
          <span style={{ color: `rgb(var(${omissionMeta.colorVar}))` }} className="mr-0.5" aria-hidden="true"><GlyphO name={omissionMeta.icon}/></span>
          <span className="mr-1">{omissionMeta.label}:</span>
          budget-kill {formatIntO(omissionBreakdown.budget)} · truncated {formatIntO(omissionBreakdown.truncated)} · missing {formatIntO(omissionBreakdown.missing)}
        </div>
      )}
    </div>
  );
}

// 일별 stacked-bar — 각 일자 1막대, 4-category 비례 stack (inline SVG, 외부 라이브러리 없음).
// bar 폭/간격은 grid 길이 기준 자동 분배. 0건 일자는 빈 트랙 표시.
function AttributionDailyChart({ grid }) {
  const chartHeight = 132;
  const labelBand   = 16;
  const barAreaH    = chartHeight - labelBand;
  const slot = 100 / grid.length;
  const barW = slot * 0.72;
  const barGap = (slot - barW) / 2;

  return (
    <div>
      <svg
        width="100%"
        height={chartHeight}
        viewBox={`0 0 100 ${chartHeight}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Daily reporting-health stacked bar chart"
        style={{ display: 'block' }}>
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
                <title>{isOut ? `${point.day} · before data window (out-of-range)` : `${point.day} · no activity`}</title>
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
                    <title>{`${point.day} · ${meta.label}: ${formatIntO(count)} (${(count / point.total * 100).toFixed(1)}%)`}</title>
                  </rect>
                );
              })}
            </React.Fragment>
          );
        })}
      </svg>
      <div className="flex items-center justify-between fs-micro font-mono text-faint mt-1">
        <span>{attributionDayLabelO(grid[0]?.day)}</span>
        <span>today</span>
      </div>
    </div>
  );
}

// dual-encoded 범례 — 색상 + 기호 + 라벨 3중 부호화 (color-blind safety).
function AttributionLegend() {
  return (
    <div className="flex flex-wrap gap-3 fs-micro text-faint pt-3 border-t border-line mt-3">
      {ATTRIBUTION_CATEGORY_ORDER.map((key) => {
        const meta = ATTRIBUTION_CATEGORY_META[key];
        return (
          <span key={key} className="flex items-center gap-1.5">
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
    </div>
  );
}

// ----- Channel liveness (기록 채널 감시) --------------------------------------
// /api/outcomes/channel-liveness — 기록 채널이 조용해진 것을 사람이 알아채기 전에 지목한다.
// 대부분의 outcome 을 실어 나르던 채널이 0 으로 떨어진 채 하루 넘게 방치됐고, 그 공백이
// 대시보드에서는 품질 저하처럼 읽혔다. 판정(eligible/alerting)과 임계값은 전부 서버 응답에서
// 오며 카드는 어떤 수치도 재계산하지 않는다 — doctor §16 과 같은 정의 하나를 공유하기 위함.

function ChannelLivenessCard({ state, onRetry }) {
  const { CardHead, Badge } = window.UI;

  const badge = getChannelLivenessBadgeO(state);

  return (
    <div className="card mb-4">
      <CardHead
        title="Recording channels"
        sub=""
        right={
          <Badge
            role="status"
            tone={badge.tone}
            icon
            title="A high-volume recording channel that stops writing looks like a quality change on every other card here">
            {badge.text}
          </Badge>
        }
      />
      <div className="card-body">
        <ChannelLivenessBody state={state} onRetry={onRetry}/>
      </div>
    </div>
  );
}

// 적재 전·실패한 payload 의 'All recording' 은 확인한 적 없는 all-clear → 주장 없는 neutral 배지.
function getChannelLivenessBadgeO(state) {
  if (state.status !== 'ready') return { tone: 'neutral', text: getUnloadedSummaryO(state.status) };

  const alerting = state.data?.alerting || [];
  const days = state.data?.days;
  const meta = alerting.length > 0 ? CHANNEL_LIVENESS_META.alerting : CHANNEL_LIVENESS_META.live;
  const text = alerting.length > 0 ? `Silent: ${alerting.join(', ')}` : 'All recording';
  return { tone: toneFromColorVarO(meta.colorVar), text: days ? `${text} · ${days}d` : text };
}

function ChannelLivenessBody({ state, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonO height={120} aria-label="Loading recording channels"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerO title="Couldn't load recording channels" detail={state.error} onRetry={onRetry}/>;
  }

  const channels  = Array.isArray(state.data?.channels) ? state.data.channels : [];
  const threshold = state.data?.thresholds || null;
  const days      = state.data?.days;

  if (channels.length === 0) {
    return <EmptyStateO message="No recording channel wrote in this window."/>;
  }

  // 침묵한 채널을 먼저 — 조치가 필요한 행이 스크롤 아래로 밀리지 않게.
  const ordered = [...channels].sort((a, b) => Number(b.alerting) - Number(a.alerting));

  return (
    <div>
      <div className="flex flex-col gap-1.5">
        {ordered.map((channel) => (
          <ChannelLivenessRow
            key={channel.attribution_source}
            channel={channel}
            days={days}
            recencyDays={threshold?.eligibility_recency_days}/>
        ))}
      </div>
      {threshold ? (
        <div className="fs-micro text-faint font-mono mt-3 leading-relaxed">
          Alerts once a channel that exceeded {formatIntO(threshold.eligibility_daily_floor)} rows/day
          within the last {threshold.eligibility_recency_days}d has recorded nothing
          for {threshold.silence_hours}h.
        </div>
      ) : null}
    </div>
  );
}

function ChannelLivenessRow({ channel, days, recencyDays }) {
  const meta = channelLivenessMetaO(channel);
  const silentHours = Math.floor(Number(channel.silent_hours) || 0);
  // 자격을 결정하는 값은 최근 창의 peak 이다. 창 전체 peak 만 보이면 "버스트 171/day" 채널이
  // 'Below floor' 로 뜨는 이유를 읽을 수 없으므로, 판정에 쓰인 수치를 앞에 둔다.
  const recentPeak = formatIntO(channel.recent_peak_daily_count);
  const windowPeak = formatIntO(channel.peak_daily_count);
  return (
    <div className="flex items-center gap-2 fs-micro font-mono">
      <span style={{ color: `rgb(var(${meta.colorVar}))` }} aria-hidden="true"><GlyphO name={meta.icon}/></span>
      <span className="text-ink w-[6.5rem] flex-shrink-0">{meta.label}</span>
      <span className="text-ink flex-shrink-0">{channel.attribution_source}</span>
      <span className="text-dim tabular-nums">
        {recentPeak}/day{recencyDays ? ` last ${recencyDays}d` : ''}
        {' · '}{windowPeak}/day peak{days ? ` over ${days}d` : ''}
        {' · '}quiet {formatIntO(silentHours)}h
      </span>
    </div>
  );
}

// ----- 측정 분포 (artifact-vs-quality breakdown) -----------------------------
// /api/outcomes/cross-analysis grader_breakdown — grader_verdict 버킷 분포.
//   verified_pass/unverified/verified_fail = graded_total 분모 · not_measured(레거시 NULL) 은 비율 분모 제외.
//   목적: 측정 산물(unverified/legacy)을 품질 실패로 오독하지 않게 측정 신호를 명시 노출.

function GraderBreakdownCard({ state, onRetry }) {
  const { CardHead, Badge } = window.UI;

  const breakdown   = state.status === 'ready' ? state.data?.overall?.grader_breakdown : null;
  const gradedTotal = breakdown ? (Number(breakdown.graded_total) || 0) : 0;

  return (
    <div className="card mb-4">
      <CardHead
        title="Automatic check results (grader_verdict)"
        sub=""
        right={
          state.status === 'ready' && breakdown && (
            <Badge role="metadata">Checked records: {formatIntO(gradedTotal)}</Badge>
          )
        }
      />
      <div className="card-body">
        <GraderBreakdownBody state={state} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function GraderBreakdownBody({ state, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonO height={120} aria-label="Loading check results"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerO title="Couldn't load check results" detail={state.error} onRetry={onRetry}/>;
  }

  const breakdown = state.data?.overall?.grader_breakdown;
  if (!breakdown) {
    return <EmptyStateO message="No check data in this period."/>;
  }

  const gradedTotal = Number(breakdown.graded_total) || 0;

  return (
    <>
      <div className="grid grid-cols-4 gap-3">
        {GRADER_BREAKDOWN_ORDER.map((key) => {
          const meta  = GRADER_BREAKDOWN_META[key];
          const count = Number(breakdown[key]) || 0;
          // not_measured(레거시 NULL)는 graded_total 분모 밖 → 비율 표기 생략 (오해 차단).
          const pct   = key !== 'not_measured' && gradedTotal > 0 ? (count / gradedTotal * 100) : null;
          return (
            <div
              key={key}
              className="rounded-lg p-3 border"
              style={{
                borderColor: `rgb(var(${meta.colorVar}) / 0.3)`,
                background: `rgb(var(${meta.colorVar}) / 0.06)`,
              }}
              title={`${meta.label}: ${formatIntO(count)}${pct != null ? ` (${pct.toFixed(1)}%)` : ' (legacy — not in share denominator)'}`}>
              <div className="inline-flex items-start gap-1 fs-micro uppercase tracking-wider min-h-[2.2em] text-dim">
                <span style={{ color: `rgb(var(${meta.colorVar}))` }} aria-hidden="true"><GlyphO name={meta.icon}/></span>
                {meta.label}
              </div>
              <div className="mt-1 font-mono fs-title text-ink">{formatIntO(count)}</div>
              <div className="fs-micro text-faint">{pct != null ? `${pct.toFixed(1)}%` : 'not in share denominator'}</div>
            </div>
          );
        })}
      </div>
      <DowngradeBreakdownRowO breakdown={state.data?.overall?.downgrade_breakdown}/>
      <TaskTypeGraderCrosstabO rows={state.data?.overall?.task_type_grader_breakdown}/>
    </>
  );
}

// downgrade_origin 분포 서브라인 — grader_verdict 카드에 종속. writer_true_downgraded(작성자 pass
// 주장 ↔ grader 불일치)를 우선 노출, 나머지 provenance 는 muted. 전 표본 0 → 미렌더(no fake zero).
function DowngradeBreakdownRowO({ breakdown }) {
  if (!breakdown) return null;
  const segments = DOWNGRADE_BREAKDOWN_ORDER
    .map((key) => ({ key, count: Number(breakdown[key]) || 0 }))
    .filter((s) => s.count > 0);
  if (segments.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-line fs-micro font-mono">
      <span className="text-faint uppercase tracking-wider">downgrade origin</span>
      {segments.map(({ key, count }) => {
        const meta = DOWNGRADE_BREAKDOWN_META[key];
        return (
          <span key={key} className="inline-flex items-center gap-1 text-dim" title={key}>
            <span style={{ color: `rgb(var(${meta.colorVar}))` }} aria-hidden="true"><GlyphO name={meta.icon}/></span>
            {meta.label}: {formatIntO(count)}
          </span>
        );
      })}
    </div>
  );
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

  return (
    <div className="mt-4 flex flex-col gap-2.5">
      <TaskTypeGraderGroupO label="By task type — checkable types" rows={measured} maxTotal={maxTotal}/>
      <TaskTypeGraderGroupO label="Types with nothing to check" rows={byDesign} maxTotal={maxTotal} isMuted/>
    </div>
  );
}

function TaskTypeGraderGroupO({ label, rows, maxTotal, isMuted }) {
  return (
    <div>
      <div className="fs-micro font-mono text-faint uppercase tracking-wider mb-1">{label}</div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => <TaskTypeGraderBarO key={row.task_type} row={row} maxTotal={maxTotal} isMuted={isMuted}/>)}
      </div>
    </div>
  );
}

function TaskTypeGraderBarO({ row, maxTotal, isMuted }) {
  const total = Number(row.total) || 0;
  const widthPct = total > 0 ? (total / maxTotal) * 100 : 0;
  const bucketText = GRADER_BREAKDOWN_ORDER
    .map((key) => `${GRADER_BREAKDOWN_META[key].label} ${formatIntO(Number(row[key]) || 0)}`)
    .join(' · ');
  const title = `${row.task_type}: ${bucketText} — total ${formatIntO(total)}`;

  return (
    <div className="flex items-center gap-2" role="img" aria-label={title} title={title}>
      <span className={`fs-micro font-mono ${isMuted ? 'text-faint' : 'text-dim'}`} style={{ width: 76, flexShrink: 0 }}>
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
                  style={{ width: `${(count / total) * 100}%`, background: `rgb(var(${GRADER_BREAKDOWN_META[key].colorVar}))` }}/>
              );
            })}
          </div>
        )}
      </div>
      <span className="fs-micro font-mono text-dim" style={{ width: 56, flexShrink: 0, textAlign: 'right' }}>
        {total > 0 ? formatIntO(total) : '—'}
      </span>
    </div>
  );
}

// ----- Polar-mismatch cross-tab (confidence × metric_pass) -------------------
// /api/outcomes/cross-analysis cells[] — 서버 계산 is_polar_mismatch 시각화.
// 행 4 (confidence) × 열 3 (metric_pass) = 12 셀 + 합계 행/열 → 5열 이내(라벨+pass+fail+null+합계).
// polar mismatch(overconfidence high+fail · underconfidence low+pass) → ⚠ 기호 + warn 색조 (dual-encoding).

function CrosstabCard({ state, onRetry }) {
  const { CardHead, Badge } = window.UI;

  const crosstab   = state.status === 'ready' ? state.data?.crosstab : null;
  const polarTotal = crosstab ? crosstab.polarTotal : 0;
  const polarPct   = crosstab && crosstab.total > 0 ? (polarTotal / crosstab.total * 100) : 0;

  return (
    <div className="card mb-4">
      <CardHead
        title="Confidence vs. reality (polar mismatch)"
        sub=""
        right={
          state.status === 'ready' && (
            <Badge role="status" tone="warn" icon>
              Mismatches: {formatIntO(polarTotal)} ({polarPct.toFixed(1)}%)
            </Badge>
          )
        }
      />
      <div className="card-body">
        <CrosstabBody state={state} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function CrosstabBody({ state, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonO height={160} aria-label="Loading cross table"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerO title="Couldn't load cross table" detail={state.error} onRetry={onRetry}/>;
  }

  const crosstab = state.data?.crosstab;
  if (!crosstab || crosstab.total === 0) {
    return <EmptyStateO message="No confidence-vs-self-check records in this period."/>;
  }

  const max = crosstabMaxCountO(crosstab.byCell);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full fs-meta font-mono" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              <th scope="col" className="text-left text-dim font-medium px-2 py-1.5 border-b border-line">confidence \ self-check</th>
              {CROSSTAB_METRIC_COLS.map((col) => (
                <th key={col.key} scope="col" className="text-center text-dim font-medium px-2 py-1.5 border-b border-line">
                  {col.label}
                </th>
              ))}
              <th scope="col" className="text-right text-dim font-medium px-2 py-1.5 border-b border-line">Total</th>
            </tr>
          </thead>
          <tbody>
            {CROSSTAB_CONFIDENCE_ROWS.map((rowKey) => (
              <CrosstabRow key={rowKey} rowKey={rowKey} byCell={crosstab.byCell} max={max}/>
            ))}
          </tbody>
          <tfoot>
            <CrosstabTotalRow byCell={crosstab.byCell} total={crosstab.total}/>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 fs-micro text-faint pt-3 border-t border-line mt-3">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" style={{ color: 'rgb(var(--warn))' }}><GlyphO name="warn"/></span>
          polar mismatch (overconfidence high+fail · underconfidence low+pass)
        </span>
      </div>
    </div>
  );
}

function CrosstabRow({ rowKey, byCell, max }) {
  let rowTotal = 0;
  for (const col of CROSSTAB_METRIC_COLS) {
    rowTotal += (byCell[`${rowKey}|${col.key}`]?.count) || 0;
  }

  return (
    <tr>
      <th scope="row" className="text-left text-ink font-medium px-2 py-1.5 border-b border-line">{rowKey === 'null' ? 'None' : rowKey}</th>
      {CROSSTAB_METRIC_COLS.map((col) => {
        const cell = byCell[`${rowKey}|${col.key}`] || { count: 0, isPolar: false };
        return <CrosstabCell key={col.key} cell={cell} max={max} rowLabel={rowKey} colLabel={col.label}/>;
      })}
      <td className="text-right text-dim px-2 py-1.5 border-b border-line">{formatIntO(rowTotal)}</td>
    </tr>
  );
}

function CrosstabCell({ cell, max, rowLabel, colLabel }) {
  const count = cell.count || 0;
  // 음영: polar 셀은 warn, 그 외 accent. 상대 빈도(0.08~0.85 opacity) — 0건은 무음영.
  const ratio   = max > 0 ? count / max : 0;
  const opacity = count > 0 ? (0.08 + ratio * 0.77).toFixed(3) : '0';
  const tintVar = cell.isPolar ? '--warn' : '--accent';

  return (
    <td
      className="text-center px-2 py-1.5 border-b border-line"
      style={{ background: `rgb(var(${tintVar}) / ${opacity})` }}
      title={`${rowLabel} × ${colLabel}: ${formatIntO(count)}${cell.isPolar ? ' · polar mismatch' : ''}`}
      aria-label={`confidence ${rowLabel} metric ${colLabel} ${count}${cell.isPolar ? ' polar mismatch' : ''}`}>
      <span className="inline-flex items-center gap-1 justify-center">
        {cell.isPolar && count > 0 && <span aria-hidden="true" style={{ color: 'rgb(var(--warn))' }}><GlyphO name="warn"/></span>}
        <span className="text-ink">{count > 0 ? formatIntO(count) : '·'}</span>
      </span>
    </td>
  );
}

function CrosstabTotalRow({ byCell, total }) {
  return (
    <tr>
      <th scope="row" className="text-left text-dim font-medium px-2 py-1.5">Total</th>
      {CROSSTAB_METRIC_COLS.map((col) => {
        let colTotal = 0;
        for (const rowKey of CROSSTAB_CONFIDENCE_ROWS) {
          colTotal += (byCell[`${rowKey}|${col.key}`]?.count) || 0;
        }
        return (
          <td key={col.key} className="text-center text-dim px-2 py-1.5">{formatIntO(colTotal)}</td>
        );
      })}
      <td className="text-right text-ink font-semibold px-2 py-1.5">{formatIntO(total)}</td>
    </tr>
  );
}

// byCell 맵의 최대 셀 카운트 — 음영 정규화 분모.
function crosstabMaxCountO(byCell) {
  let max = 0;
  for (const key in byCell) {
    const c = byCell[key]?.count || 0;
    if (c > max) max = c;
  }
  return max;
}

// ----- Loop-events log (raw daemon cycle stream, relocated from Learning) -----
// /api/improvement/loop-events — core.autoagent_loop_events per-cycle stage stream.
// operational data(집계 신호 아님)라 Task results 가 소유 (W3-T3 이관 · W3-T7 수신).
// 고정 높이 스크롤 카드 + 요약 3-tile(neutral count) + 이벤트 표(행=이벤트 / 열=5).
//   density: 행 라벨 --dim · mono 는 timestamp/id 만 · agent truncate+tooltip.
//   eval_result → loopResultMetaO dual-encoded 배지(색+기호+라벨).

function LoopEventsCard({ state, onRetry }) {
  const { CardHead } = window.UI;
  return (
    <div className="card mt-4">
      <CardHead
        title="Improvement run events"
        sub=""/>
      <div className="card-body" style={{ padding: 0 }}>
        <LoopEventsBody state={state} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function LoopEventsBody({ state, onRetry }) {
  const { Badge } = window.UI;

  if (state.status === 'loading') {
    return <ChartSkeletonO height={200} aria-label="Loading run events"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerO title="Couldn't load run events" detail={state.error} onRetry={onRetry}/>;
  }

  const total    = Number(state.data?.total_events ?? 0);
  const events   = Array.isArray(state.data?.events) ? state.data.events : [];
  const dist     = Array.isArray(state.data?.result_distribution) ? state.data.result_distribution : [];

  if (total === 0 || events.length === 0) {
    // 카드 card-body 는 padding:0(populated 테이블 소유) → empty 브랜치만 별도 패딩으로
    // 'Task results' 레퍼런스(card-body 기본 20px)와 간격 일치. populated 테이블은 padding:0 유지.
    return <div style={{ padding: 20 }}><EmptyStateO message="No run events recorded yet."/></div>;
  }

  const distMap = {};
  for (const d of dist) distMap[d.eval_result || 'unknown'] = Number(d.count ?? 0);
  const verifiedCnt = distMap.verified || 0;
  const rejectCnt   = distMap.reject || 0;

  // 요약 = 카테고리(icon+tone+label) dual-encode + 수량 neutral count Badge (color≠count 규칙).
  const summary = [
    ['ok',   'check', 'Runs applied',  verifiedCnt],
    ['crit', 'x',     'Runs declined', rejectCnt],
    ['info', 'info',  'All events',    total],
  ];

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-3">
        {summary.map(([tone, iconName, label, count]) => (
          <span key={label} className="fs-body inline-flex items-center gap-1.5">
            <span style={{ color: `rgb(var(--${tone}))` }} aria-hidden="true"><GlyphO name={iconName}/></span>
            <span className="text-dim">{label}</span>
            <Badge role="count">{formatIntO(count)}</Badge>
          </span>
        ))}
      </div>
      {/* 고정 높이 스크롤 — raw 로그가 페이지를 무한 늘이지 않도록 (max-height 42vh + 내부 스크롤). */}
      <div className="overflow-y-auto" style={{ maxHeight: '42vh' }}>
        <table className="w-full fs-meta">
          <thead>
            <tr className="text-dim uppercase tracking-wider" style={{ position: 'sticky', top: 0, background: 'rgb(var(--elev))' }}>
              <th className="text-left font-medium px-2 py-1.5 border-b border-line">Time</th>
              <th className="text-left font-medium px-2 py-1.5 border-b border-line">Agent</th>
              <th className="text-left font-medium px-2 py-1.5 border-b border-line">Result</th>
              <th className="text-right font-medium px-2 py-1.5 border-b border-line">Added</th>
              <th className="text-right font-medium px-2 py-1.5 border-b border-line">Removed</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const meta = loopResultMetaO(e.eval_result);
              return (
                <tr key={e.id}>
                  {/* mono 는 timestamp 만 (id 컬럼은 미노출 → 키만 사용). */}
                  <td className="text-left text-faint font-mono px-2 py-1.5 border-b border-line whitespace-nowrap">
                    {window.UI.formatKstDateTime(e.event_ts)}
                  </td>
                  <td className="text-left text-dim px-2 py-1.5 border-b border-line truncate" style={{ maxWidth: 160 }} title={e.agent || ''}>
                    <window.UI.AgentName name={e.agent}/>
                  </td>
                  <td className="text-left px-2 py-1.5 border-b border-line" title={String(e.eval_result || '')}>
                    <Badge role="status" tone={meta.tone} icon>{meta.label}</Badge>
                  </td>
                  <td className="text-right text-dim font-mono px-2 py-1.5 border-b border-line">+{formatIntO(Number(e.changes_added ?? 0))}</td>
                  <td className="text-right text-dim font-mono px-2 py-1.5 border-b border-line">-{formatIntO(Number(e.changes_removed ?? 0))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ----- Panel 1: Filter sidebar -----------------------------------------------

// 칩 축 driver — label, axis key (filter prop), 옵션 목록을 1행 1축으로 표현.
// 상시 노출 축 — Agent · Keyword 와 합쳐 5 그룹. 나머지는 'More filters' 뒤로 접힌다 (period 는 헤더가 소유).
const CHIP_FILTER_AXES = [
  { axis: 'result',      label: 'Result',      options: RESULT_OPTIONS      },
  { axis: 'review_flag', label: 'Flagged',     options: REVIEW_FLAG_OPTIONS },
  { axis: 'task_type',   label: 'Task type',   options: TASK_TYPE_OPTIONS   },
];

const MORE_FILTER_AXES = [
  { axis: 'confidence',  label: 'Confidence',  options: CONFIDENCE_OPTIONS  },
  { axis: 'metric_pass', label: 'Self-check',  options: METRIC_PASS_OPTIONS },
  { axis: 'attribution_source', label: 'Attribution', options: ATTRIBUTION_SOURCE_OPTIONS },
];

function FilterSidebar({
  filter, keywordInput, distinctAgents, includeAll, sort,
  onPatchFilter, onKeywordChange, onToggleIncludeAll, onSortChange, onReset,
}) {
  const { CardHead, Badge } = window.UI;

  // 활성 facet 카운트 + 'N of M' 카운터 (T-OUT-3) — 몇 축이 좁혀졌는지 한눈에.
  const activeCount = countActiveFacetsO(filter);

  // 부모 grid 가 column 을 viewport 높이로 stretch → sticky 불필요. 칩 overflow 시 card-body self-scroll.
  return (
    <div className="card h-full flex flex-col min-h-0">
      <CardHead
        title="Filters"
        sub=""
        right={
          activeCount > 0
            ? <Badge role="count">{activeCount} active</Badge>
            : null
        }
      />
      <div className="card-body" style={{ padding: 14, flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        <FilterAxisGroup label="Agent">
          <select
            className="field field-select"
            value={filter.agent || ''}
            onChange={(e) => onPatchFilter({ agent: e.target.value })}
            aria-label="Agent filter">
            <option value="">All</option>
            {distinctAgents.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </FilterAxisGroup>

        {CHIP_FILTER_AXES.map(({ axis, label, options }) => (
          <FilterAxisGroup key={axis} label={label}>
            <ChipGroup
              options={options}
              value={filter[axis] || ''}
              onChange={(v) => onPatchFilter({ [axis]: v })}
              ariaLabel={`${label} filter`}
            />
          </FilterAxisGroup>
        ))}

        <FilterAxisGroup label="Keyword">
          <input
            type="search"
            className="field"
            placeholder="summary / lesson / concerns…"
            value={keywordInput}
            onChange={(e) => onKeywordChange(e.target.value)}
            aria-label="Keyword search"
          />
        </FilterAxisGroup>

        <details className="mb-3">
          <summary className="fs-micro font-mono text-faint uppercase tracking-wider cursor-pointer select-none mb-1.5">
            More filters
          </summary>
          <div className="pt-2">
            {MORE_FILTER_AXES.map(({ axis, label, options }) => (
              <FilterAxisGroup key={axis} label={label}>
                <ChipGroup
                  options={options}
                  value={filter[axis] || ''}
                  onChange={(v) => onPatchFilter({ [axis]: v })}
                  ariaLabel={`${label} filter`}
                />
              </FilterAxisGroup>
            ))}

            <FilterAxisGroup label="Sort">
              <ChipGroup
                options={SORT_OPTIONS}
                value={sort}
                onChange={onSortChange}
                ariaLabel="Sort order"
              />
            </FilterAxisGroup>

            {/* T7/O2 forensic 'show all' — include_all=1 로 서버 registry 게이트 해제. */}
            <FilterAxisGroup label="Record scope">
              <label className="flex items-center gap-2 fs-meta cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeAll}
                  onChange={(e) => onToggleIncludeAll(e.target.checked)}
                  aria-label="Show all records including non-registry and de-registered agents"/>
                <span className={includeAll ? 'text-ink' : 'text-dim'}>
                  Show all (incl. non-registry)
                </span>
              </label>
            </FilterAxisGroup>
          </div>
        </details>

        <div className="mt-3 pt-3 border-t border-line">
          <button
            className="btn sm w-full justify-center"
            onClick={onReset}
            aria-label="Reset filters">
            Reset filters
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterAxisGroup({ label, children }) {
  return (
    <div className="mb-3">
      <div className="fs-micro font-mono text-faint uppercase tracking-wider mb-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function ChipGroup({ options, value, onChange, ariaLabel }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => {
        const isActive = value === opt.value;
        return (
          <button
            key={opt.value || '_all'}
            type="button"
            className={`filter-chip ${isActive ? 'is-active' : ''}`}
            onClick={() => onChange(opt.value)}
            role="radio"
            aria-checked={isActive}
            aria-label={`${ariaLabel}: ${opt.label}`}>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ----- Panel 2: Result table -------------------------------------------------

function ResultTableCard({
  state, rows, totalMatched, page, limit, sort, filter,
  onPageChange, onSortChange, onResetFilter, onRowClick, onRetry, closure, needsYou,
}) {
  const { CardHead, Pill } = window.UI;

  const totalPages = Math.max(1, Math.ceil(totalMatched / limit));
  const currentPage = page + 1;

  return (
    <div className="card h-full flex flex-col min-h-0">
      <CardHead
        title="Results"
        sub={state.status === 'ready'
          ? `${formatIntO(totalMatched)} matched · ${formatIntO(rows.length)} shown`
          : state.status === 'loading' ? 'Loading…' : 'Records unavailable'}
        right={
          <div className="flex items-center gap-2">
            <ActiveFilterChips filter={filter}/>
          </div>
        }
      />
      {/* card-body 가 잔여 높이 흡수 → ResultTable 내부 vertical scroll. */}
      <div className="card-body" style={{ padding: 0, flex: '1 1 auto', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <ResultTableBody
          state={state}
          rows={rows}
          totalMatched={totalMatched}
          filter={filter}
          sort={sort}
          onSortChange={onSortChange}
          onResetFilter={onResetFilter}
          onRowClick={onRowClick}
          onRetry={onRetry}
          closure={closure}
          needsYou={needsYou}
        />
      </div>
      {state.status === 'ready' && totalMatched > 0 && (
        <div className="px-4 py-2.5 border-t border-line flex items-center justify-between fs-meta text-dim font-mono">
          <span>{formatIntO(page * limit + 1)}–{formatIntO(Math.min((page + 1) * limit, totalMatched))} / {formatIntO(totalMatched)}</span>
          <div className="flex items-center gap-2">
            <button
              className="btn sm"
              disabled={page <= 0}
              onClick={() => onPageChange(Math.max(0, page - 1))}
              aria-label="Previous page">
              Previous
            </button>
            <span>page {currentPage} / {totalPages}</span>
            <button
              className="btn sm"
              disabled={currentPage >= totalPages}
              onClick={() => onPageChange(page + 1)}
              aria-label="Next page">
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// 활성 필터 → 'key=value' 칩 라벨 배열 (헤더 칩 + 빈-상태 echo 공용). 기본값 축은 생략.
function buildActiveFilterChipsO(filter) {
  const chips = [];
  if (filter.days && filter.days !== 30) chips.push(`days=${filter.days}`);
  if (filter.agent)        chips.push(`agent=${filter.agent}`);
  if (filter.task_type)    chips.push(`task=${filter.task_type}`);
  if (filter.result)       chips.push(`result=${filter.result}`);
  if (filter.confidence)   chips.push(`conf=${filter.confidence}`);
  if (filter.metric_pass)  chips.push(`metric=${filter.metric_pass}`);
  if (filter.review_flag)  chips.push(`review=${filter.review_flag}`);
  if (filter.attribution_source) chips.push(`attr=${filter.attribution_source}`);
  if (filter.q)            chips.push(`q="${truncateO(filter.q, 18)}"`);
  return chips;
}

// 활성 필터 칩 배지 렌더 — 헤더 칩(ActiveFilterChips) + 빈-상태 echo(ResultTableZeroStateO) 공용.
//   래퍼 div 는 정렬 관례가 호출부마다 달라 각 호출부가 소유 → 공용은 배지 map 만.
function FilterChipsO({ chips }) {
  const { Badge } = window.UI;
  return <>{chips.map((c) => <Badge key={c} role="metadata">{c}</Badge>)}</>;
}

function ActiveFilterChips({ filter }) {
  const chips = buildActiveFilterChipsO(filter);
  if (chips.length === 0) return null;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <FilterChipsO chips={chips}/>
    </div>
  );
}

function ResultTableBody({ state, rows, totalMatched, filter, sort, onSortChange, onResetFilter, onRowClick, onRetry, closure, needsYou }) {
  if (state.status === 'loading') {
    return <ChartSkeletonO height={400} aria-label="Loading results"/>;
  }
  if (state.status === 'blocked') {
    return <PayloadUnavailableO label="Records"/>;
  }
  if (state.status !== 'ready') {
    return <ErrorBannerO title="Couldn't load the record ledger" detail={state.error} onRetry={onRetry}/>;
  }
  if (rows.length === 0) {
    return <ResultTableZeroStateO filter={filter} onResetFilter={onResetFilter}/>;
  }

  return <ResultTable rows={rows} sort={sort} onSortChange={onSortChange} onRowClick={onRowClick} closure={closure} needsYou={needsYou}/>;
}

// 정직한 빈-상태 (S6 / T-OUT-3) — 활성 필터를 echo 해 '왜 비었는지' 맥락 제공 (never blank).
//   활성 필터 0개면 '아직 기록 없음', 1개+면 칩으로 좁힌 축을 재노출 → 사용자가 무엇을 풀지 판단 가능.
function ResultTableZeroStateO({ filter, onResetFilter }) {
  const chips = filter ? buildActiveFilterChipsO(filter) : [];

  return (
    <div className="placeholder" style={{ margin: 24 }}>
      {chips.length === 0
        ? 'No results recorded yet for this period'
        : 'No results match the active filters'}
      {chips.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap justify-center mt-2">
          <span className="fs-micro text-faint font-mono">active:</span>
          <FilterChipsO chips={chips}/>
        </div>
      )}
      <div className="mt-3">
        <button className="btn sm" onClick={onResetFilter} aria-label="Reset filters">
          Reset filters
        </button>
      </div>
    </div>
  );
}

const STICKY_HEADER_STYLE = { position: 'sticky', top: 0, background: 'rgb(var(--elev))' };

function PlainHeader({ label, align = 'left', minWidth, width }) {
  const style = { ...STICKY_HEADER_STYLE };
  if (minWidth != null) style.minWidth = minWidth;
  if (width != null) style.width = width;
  return (
    <th
      scope="col"
      className={`text-${align} text-dim font-medium px-2 py-1.5 border-b border-line`}
      style={style}>
      {label}
    </th>
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
function buildLedgerSectionsO(rows, closure, windowNeedsYou) {
  const pageNeedsYou = [];
  const routine  = [];
  for (const row of rows) {
    const closedAt = closure?.closedOverrides.get(row.id) ?? row.closed_at ?? null;
    (isNeedsYouRowO(row, closedAt) ? pageNeedsYou : routine).push(row);
  }
  windowNeedsYou = windowNeedsYou && applyClosureToWindowO(windowNeedsYou, rows, closure);
  const needsYouRows = windowNeedsYou ? windowNeedsYou.rows : pageNeedsYou;
  const needsYouHeading = windowNeedsYou
    ? `Needs you · ${formatIntO(windowNeedsYou.total)} in ${windowNeedsYou.windowLabel}`
      + (windowNeedsYou.total > needsYouRows.length ? ` · first ${formatIntO(needsYouRows.length)} shown` : '')
    : `Needs you · ${formatIntO(needsYouRows.length)} on this page`;
  return [
    { key: 'needs-you', label: 'Needs you', heading: needsYouHeading, rows: needsYouRows, anchorId: LEDGER_NEEDS_YOU_ID },
    { key: 'routine',   label: 'Routine',   heading: `Routine · ${formatIntO(routine.length)} on this page`, rows: routine },
  ];
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

function ResultTable({ rows, sort, onSortChange, onRowClick, closure, needsYou }) {
  // flex: 1 + min-h: 0 → table 이 card-body 높이 fill, sticky header 유지하며 body scroll.
  // mono 는 timestamp/id/숫자 컬럼만 — 산문(agent/task_type/result/summary)은 sans (W3-T7 density).
  // 6열 — confidence · self-check · revision · cid 는 drawer 가 운반한다(행은 판단에 필요한 축만).
  const sections = buildLedgerSectionsO(rows, closure, needsYou);

  return (
    <div className="overflow-auto" style={{ flex: '1 1 auto', minHeight: 0 }}>
      <table className="w-full fs-meta" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
        <thead>
          <tr>
            <SortableHeader label="Time" sortKey="record_ts" currentSort={sort} onSortChange={onSortChange} align="left" width={120}/>
            <PlainHeader label="Agent" minWidth={110}/>
            <PlainHeader label="task_type"/>
            <PlainHeader label="result"/>
            <PlainHeader label="Check" align="center" width={52}/>
            <PlainHeader label="summary"/>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            section.rows.length === 0 ? null : (
              <React.Fragment key={section.key}>
                <tr>
                  <th
                    id={section.anchorId}
                    tabIndex={section.anchorId ? -1 : undefined}
                    colSpan={6}
                    scope="colgroup"
                    className="text-left fs-micro font-mono uppercase tracking-wider text-faint px-2 pt-3 pb-1 border-b border-line">
                    {section.heading}
                  </th>
                </tr>
                {section.rows.map((row) => (
                  <ResultTableRow key={row.id} row={row} onRowClick={onRowClick} closure={closure}/>
                ))}
              </React.Fragment>
            )
          ))}
        </tbody>
      </table>
    </div>
  );
}

function getSortArrowIcon(isActive, dir) {
  if (!isActive) return '';
  return dir === 'asc' ? 'arrow-up' : 'arrow-down';
}

function getAriaSort(isActive, dir) {
  if (!isActive) return 'none';
  return dir === 'asc' ? 'ascending' : 'descending';
}

function SortableHeader({ label, sortKey, currentSort, onSortChange, align, width, descOnly }) {
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
    <th
      scope="col"
      className={`text-${align} text-dim font-medium px-2 py-1.5 border-b border-line cursor-pointer select-none`}
      style={{ ...STICKY_HEADER_STYLE, minWidth: width }}
      onClick={handleClick}
      aria-sort={getAriaSort(isActive, dir)}>
      {label}
      {arrowIcon && <GlyphO name={arrowIcon} className="ml-1 text-accent"/>}
    </th>
  );
}

// 요약 셀의 고정 flag 슬롯 폭 — 폭이 행마다 달라지면 요약 텍스트가 세로로 정렬되지 않는다.
const SUMMARY_FLAG_SLOT = 18;

function parseQaScoreO(qaScore) {
  if (typeof qaScore !== 'string' || qaScore.trim() === '') return null;
  const nums = qaScore.match(/\d+(\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
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
      className="inline-flex items-center gap-0.5 align-middle"
      role="img"
      aria-label={`qa score ${avg.toFixed(1)} of 5`}
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
function ResultTableRow({ row, onRowClick, closure }) {
  const isFail   = row.result === 'fail';
  const isReview = !isFail && row.review_flag === true;
  const rowClass = `outcome-row cursor-pointer ${isFail ? 'is-fail' : ''} ${isReview ? 'is-review' : ''}`;

  const ts       = formatTimestampO(row.record_ts);
  const summary  = truncateO(row.summary || '', 60);
  const grader   = graderVerdictMetaO(row.grader_verdict);
  // Check 셀은 아이콘 단독이라 이 문장이 유일한 텍스트 채널 — title 과 셀 aria-label 이 함께 소비한다.
  const graderTitle = `Automatic check (grader_verdict): ${grader.label}${
    row.grader_verdict === 'unverified'
      ? ' — no test artifact to grade for this task type.'
      : row.grader_verdict == null
      ? ' — recorded before the grader existed, not a failure.'
      : ''
  }`;
  // result tone/icon/label = RESULT_META SoT (T-OUT-1 — 로컬 result→color map 제거, 색맹 안전 듀얼인코딩).
  // closedAt = optimistic override 우선 → 서버 응답 도착 전에도 즉시 종결 표시.
  const closedAt    = closure?.closedOverrides.get(row.id) ?? row.closed_at ?? null;
  const resultMeta  = window.UI.resolveResultMeta(row.result, closedAt);
  const resultColor = `rgb(var(${resultColorVarO(row.result, closedAt)}))`;
  const isClosing   = closure?.pendingIds.has(row.id) === true;
  const canClose    = row.result === 'done_with_concerns' && !closedAt && typeof closure?.onMarkClosed === 'function';

  return (
    <tr
      className={rowClass}
      onClick={() => onRowClick(row)}
      tabIndex={0}
      role="button"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onRowClick(row);
        }
      }}
      aria-label={`${row.agent} ${row.task_type} ${resultMeta.label} check ${grader.label} ${row.summary || ''}`}>
      <td className="text-left text-ink font-mono px-2 py-1.5 border-b border-line whitespace-nowrap">
        {ts}
      </td>
      <td className="text-left text-ink px-2 py-1.5 border-b border-line truncate" style={{ maxWidth: 140 }} title={row.agent}>
        <window.UI.AgentName name={row.agent}/>
      </td>
      <td className="text-left text-dim px-2 py-1.5 border-b border-line">{row.task_type}</td>
      <td className="text-left px-2 py-1.5 border-b border-line" title={resultMeta.label}>
        {/* 배지+종결 어포던스를 한 nowrap 컨테이너로 — 셀 안에서 줄바꿈되면 행 높이가 형제 행의 2배로 부푼다. */}
        <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
          <span className="inline-flex items-center gap-0.5 text-ink" style={{ fontWeight: 500 }}>
            <span style={{ color: resultColor }} aria-hidden="true"><GlyphO name={resultMeta.icon}/></span>
            {row.result}
            {/* 텍스트 라벨 = 듀얼인코딩의 두 번째 채널 — 회색 tone 단독으로 종결을 encode 하지 않는다. */}
            {resultMeta.closed && <span className="fs-micro text-dim">{resultMeta.label}</span>}
          </span>
          {canClose && (
            // -my-1 = 24px 타깃을 유지한 채 행 높이 기여만 상쇄 (셀 패딩 안으로 겹침) → 형제 행과 높이 동일.
            // pending 은 색 회전 없이 투명도만 (DocStatusBadgeCD 선례 — 새 의미 카테고리 시사 차단 + reduced-motion 무관).
            <button
              className="btn ghost sm icon shrink-0 -my-1"
              aria-busy={isClosing}
              aria-label={`Mark outcome ${row.id} closed`}
              title={isClosing ? 'Closing…' : 'Mark closed'}
              style={isClosing ? { opacity: 0.65 } : undefined}
              onClick={(e) => {
                // row onClick 이 detail modal 을 여는 것과 의도 충돌 → bubble 차단.
                e.stopPropagation();
                if (!isClosing) closure.onMarkClosed(row.id);
              }}>
              <GlyphO name="circle-check" size={14}/>
            </button>
          )}
        </span>
      </td>
      <td
        className="text-center px-2 py-1.5 border-b border-line"
        title={graderTitle}>
        {/* 아이콘 단독 — 상태별 모양(✓/○/✕/–)이 다르므로 색+모양 듀얼인코딩은 유지되고, 전문은 title + 행 aria-label 이 운반. */}
        <span
          className="inline-flex items-center justify-center"
          style={{ color: `rgb(var(${grader.colorVar}))` }}
          role="img"
          aria-label={graderTitle}>
          <GlyphO name={grader.icon} size={14}/>
        </span>
      </td>
      <td className="text-left text-ink px-2 py-1.5 border-b border-line truncate" style={{ maxWidth: 380 }} title={row.summary || ''}>
        <SummaryFlagSlotO row={row}/>
        {summary}
      </td>
    </tr>
  );
}

// 요약 셀 선두 플래그 집계 — review 사유/격리/budget-kill 을 tone 하나로 접는다.
//   1행 1줄·고정폭 슬롯 규율 유지 → 테이블에선 글리프 하나만, 사유 전문은 title 이 운반 (사유별 배지는 detail 패널).
//   분류는 window.UI.reviewFlagReasons SoT (기록된 사유 토큰 → 라벨, improvement KPI 세그먼트와 공용, F12) — 여기서 재파생 금지.
//   경고급(review 사유·격리)이 정보급(budget-kill)을 이긴다 — 조치 필요 신호가 참고 신호에 가려지면 안 된다.
function buildSummaryFlagO(row) {
  const reasons = row?.review_flag === true ? window.UI.reviewFlagReasons(row) : [];
  const isQuarantined = row?.poisoned_window === true;
  const isBudgetKill = row?.attribution_source === ATTRIBUTION_SOURCE_BUDGET_TRUNCATION;

  const notes = [];
  if (reasons.length > 0) notes.push(`Flagged for review: ${reasons.map((r) => `${r.label} (${r.title})`).join(' / ')}`);
  if (isQuarantined) notes.push('Quarantined row — excluded from analysis stats.');
  if (isBudgetKill) notes.push('attribution_source: budget-truncation — subagent hit its budget ceiling before emitting a completion block.');

  if (notes.length === 0) return null;
  return { tone: reasons.length > 0 || isQuarantined ? 'warn' : 'info', title: notes.join(' · ') };
}

// 플래그 유무와 무관하게 같은 폭을 점유 — 그래야 요약 텍스트가 모든 행에서 같은 x 에서 시작한다.
function SummaryFlagSlotO({ row }) {
  const flag = buildSummaryFlagO(row);
  const slotStyle = { width: SUMMARY_FLAG_SLOT };

  if (flag == null) {
    return <span className="inline-block shrink-0 align-middle mr-1" style={slotStyle} aria-hidden="true"/>;
  }
  return (
    <span
      className={`inline-flex items-center justify-center shrink-0 align-middle mr-1 text-${flag.tone}`}
      style={slotStyle}
      role="img"
      aria-label={flag.title}
      title={flag.title}>
      <GlyphO name={flag.tone} size={13}/>
    </span>
  );
}

// ----- Detail Modal (body_md preview + nav) ----------------------------------

function DetailModal({ detailRow, detailState, rows, onClose, onNav }) {
  // 오버레이/계약(focus-trap · scroll-lock · Esc/X/backdrop · nav Arrow 바인딩)은 DetailSurface 위임.
  const { DetailSurface } = window.UI;

  if (!detailRow) return null;

  // list-index → prev/next 어댑터 — 현재 페이지 결과 행에서 detailRow 위치 도출.
  const idx     = rows.findIndex((r) => r.id === detailRow?.id);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < rows.length - 1;

  const titleParts = [
    detailRow?.agent,
    detailRow?.task_type,
    detailRow?.result,
    formatTimestampO(detailRow?.record_ts),
  ].filter(Boolean);

  // nav footer 와 병존하는 추가 footer — 페이지 내 위치 인디케이터 + 1차 Close 버튼.
  const extraFoot = (
    <>
      <div className="fs-meta text-dim font-mono mr-auto">
        {idx >= 0 ? `${idx + 1} of ${rows.length} on this page` : 'not on this page'}
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
      {/* T-OUT-5 / S2 body order: identity(title) → numeric grid → narrative → references. */}
      <DetailMetadata row={detailRow} detail={detailState?.status === 'ready' ? detailState.data : null}/>
      <DetailNarrative row={detailRow} detailState={detailState}/>
      <DetailReferences row={detailRow}/>
    </DetailSurface>
  );
}

function reviewFlagLabel(flag) {
  if (flag === true)  return 'Yes';
  if (flag === false) return 'No';
  return '—';
}

function DetailMetadata({ row, detail }) {
  // defensive guard — row undefined 에서 React batching edge case 회피 (내부 optional chaining 도 이중 안전망).
  if (!row) return null;
  const { Badge } = window.UI;

  // concerns/files_modified 는 전 표본 빈 배열 → length>0 게이트 영구 미렌더 (dead UI 제거).
  // 데이터 미채움 자체는 쓰기 파이프라인 결함 가능성 → 모니터 범위 밖, 시스템 트랙 에스컬레이션.

  // evaluative_signal / metric_type 는 /api/outcomes/:id detail 응답에만 존재 (search row 미포함).
  //   비-null 일 때만 노출 (대다수 null — concerns/files_modified 와 동일 length-gate 패턴).
  const evalSignal = detail ? detail.evaluative_signal : null;
  const metricType = detail ? detail.metric_type : null;

  const grader = graderVerdictMetaO(row?.grader_verdict);

  return (
    <div className="grid grid-cols-2 gap-3 mb-4 fs-meta font-mono">
      <MetaField label="Confidence"         value={row?.confidence ?? '—'}/>
      <MetaField label="Self-reported pass" value={row?.metric_pass == null ? '—' : String(row.metric_pass)}/>
      <div>
        <div className="fs-micro text-faint uppercase tracking-wider">Automatic check</div>
        <div className="inline-flex items-center gap-1" style={{ color: `rgb(var(${grader.colorVar}))`, fontWeight: 500 }}>
          <GlyphO name={grader.icon}/>
          {grader.label}
        </div>
      </div>
      <MetaField label="Reworks" value={formatIntO(row?.revision_count || 0)}/>
      <div>
        <div className="fs-micro text-faint uppercase tracking-wider">Flagged for review</div>
        <div className="text-ink inline-flex items-center gap-1.5 flex-wrap">
          {reviewFlagLabel(row?.review_flag)}
          {/* 미상 사유는 여러 토큰이 같은 버킷 키로 접히므로 index 를 섞어 React key 충돌을 막는다. */}
          {row?.review_flag === true && window.UI.reviewFlagReasons(row).map((r, i) => (
            <Badge key={`${r.key}#${i}`} role="status" tone="warn" icon title={r.title}>{r.label}</Badge>
          ))}
        </div>
      </div>
      {row?.poisoned_window === true && (
        <MetaField label="Quarantined window" value="true — excluded from analysis"/>
      )}
      {evalSignal != null && (
        <MetaField label="User signal" value={formatEvaluativeSignalO(evalSignal)}/>
      )}
      {metricType != null && metricType !== '' && (
        <MetaField label="Check type" value={String(metricType)}/>
      )}
      {parseQaScoreO(row?.qa_score) != null && (
        <div>
          <div className="fs-micro text-faint uppercase tracking-wider">QA score</div>
          <div className="text-ink inline-flex items-center gap-2">
            <QaScoreDotsO qaScore={row.qa_score}/>
            <span className="font-mono text-dim">{row.qa_score}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// 서사 영역 (S2 narrative) — lesson(작성자 distilled 패턴) + body_md(전문). 식별/수치 다음, references 앞.
function DetailNarrative({ row, detailState }) {
  return (
    <div className="mb-4">
      {row?.lesson && (
        <div className="mb-3">
          <div className="fs-micro text-faint uppercase tracking-wider mb-0.5">lesson</div>
          <div className="fs-body text-ink">{row.lesson}</div>
        </div>
      )}
      <DetailBody detailState={detailState}/>
    </div>
  );
}

// 참조 영역 (S2 references) — cid(delegation tracking ID). 본문 가장 뒤 = 식별→수치→서사→참조 순서 종결.
function DetailReferences({ row }) {
  if (!row?.cid) return null;
  return (
    <div className="pt-3 border-t border-line">
      <div className="fs-micro text-faint uppercase tracking-wider mb-0.5">references</div>
      <div className="fs-meta font-mono text-dim">cid: {row.cid}</div>
    </div>
  );
}

// evaluative_signal (-1/0/+1 ternary) → 부호 + 의미 라벨. 숫자 단독 대신 의미 부여 (dual-encoding).
function formatEvaluativeSignalO(signal) {
  const n = Number(signal);
  if (n > 0)  return '+1 (praised)';
  if (n < 0)  return '-1 (corrected)';
  return '0 (neutral)';
}

function MetaField({ label, value, className = '' }) {
  return (
    <div className={className}>
      <div className="fs-micro text-faint uppercase tracking-wider">{label}</div>
      <div className="text-ink">{value}</div>
    </div>
  );
}

function DetailBody({ detailState }) {
  // defensive guard + optional chaining 보존.
  if (!detailState) return <ChartSkeletonO height={200} aria-label="Loading body"/>;

  if (detailState?.status === 'idle' || detailState?.status === 'loading') {
    return <ChartSkeletonO height={200} aria-label="Loading body"/>;
  }
  if (detailState?.status === 'error') {
    return (
      <div className="fs-body text-crit font-mono">
        Couldn't load the body: {detailState?.error || 'unknown error'}
      </div>
    );
  }

  const bodyMd = detailState?.data?.body_md;
  if (!bodyMd) {
    return (
      <div className="fs-body text-faint font-mono italic">
        No body text — showing metadata only.
      </div>
    );
  }

  return <MarkdownView markdown={bodyMd}/>;
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
  return purifier.sanitize(raw);
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

function EmptyStateO({ message }) {
  const { EmptyState } = window.UI;
  return <EmptyState message={message} />;
}

function ErrorBannerO({ title, detail, onRetry }) {
  const { Icon } = window.UI;
  return (
    <div
      role="alert"
      className="rounded-md border p-3 flex items-start gap-3 m-3"
      style={{
        background: 'rgb(var(--crit) / 0.08)',
        borderColor: 'rgb(var(--crit) / 0.4)',
      }}>
      <Icon name="warn" size={16} className="text-crit mt-0.5"/>
      <div className="flex-1 min-w-0">
        <div className="fs-body font-medium text-ink">{title}</div>
        {detail && <div className="fs-meta font-mono text-dim mt-1 break-all">{detail}</div>}
      </div>
      <button className="btn sm" onClick={onRetry} aria-label="Retry">Retry</button>
    </div>
  );
}

// 레인이 실패 배너를 소유하므로 본문은 '적재 실패' 만 말한다 — 같은 오류를 두 번 쓰지 않는다.
function PayloadUnavailableO({ label }) {
  return (
    <div className="p-4 fs-meta text-dim" role="status">
      {label} unavailable — see the alarm above.
    </div>
  );
}

// blocked banner — shown when 30s+ of repeated backend failures suggest an outage rather than a
// transient network blip. User can still trigger refresh manually via the page header.
function BlockedBannerO({ detail }) {
  const { Icon } = window.UI;
  return (
    <div
      role="alert"
      className="rounded-md border p-4 m-3"
      style={{
        background: 'rgb(var(--warn) / 0.08)',
        borderColor: 'rgb(var(--warn) / 0.4)',
      }}>
      <div className="flex items-start gap-3">
        <Icon name="warn" size={18} className="text-warn mt-0.5"/>
        <div className="flex-1 min-w-0">
          <div className="fs-title font-medium text-ink">Server not responding (30 s timeout)</div>
          <div className="fs-meta text-dim mt-1">
            Not responding. Check the service or try again shortly.
          </div>
          {detail && (
            <div className="fs-meta font-mono text-faint mt-2 break-all">
              Last error: {detail}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChartSkeletonO({ height = 220 }) {
  return (
    <div
      aria-busy="true"
      style={{
        width: '100%',
        height,
        borderRadius: 8,
        background: 'rgb(var(--sunken))',
        opacity: 0.7,
        animation: 'skelPulseO 1.4s ease-in-out infinite',
      }}
    />
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

// 선택 가능한 faceted 축 — 'N of M active' 카운터 분모. period(days)는 항상-설정 기본축이라 제외.
const FACET_AXES = ['agent', 'task_type', 'result', 'confidence', 'metric_pass', 'review_flag', 'attribution_source', 'q'];

// 활성 facet 수 (기본값이 아닌 축) — period 는 30 기본과 다를 때만 1 카운트.
function countActiveFacetsO(filter) {
  let active = FACET_AXES.reduce((acc, axis) => acc + (filter[axis] ? 1 : 0), 0);
  if (filter.days && filter.days !== 30) active += 1;
  return active;
}

// faceted 분모 = 선택 가능 축 총수 (period 포함 → FACET_AXES + 1).
const FACET_AXIS_TOTAL = FACET_AXES.length + 1;

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
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_e) { /* ignore body parse failure */ }
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 120) : ''}`);
  }
  return res.json();
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function handleErrorO(err, setter) {
  // AbortError = filter/navigation 전환 — user-visible failure 아님.
  if (err && err.name === 'AbortError') return;
  setter({ status: 'error', data: null, error: errorMessage(err) });
}

// 연속 5xx/network 실패 BACKEND_FAIL_THRESHOLD_MS 경과 → 'blocked' 상태 + 별도 배너.
function handleSearchErrorO(err, setter, firstFailRef) {
  if (err && err.name === 'AbortError') return;
  const now = Date.now();
  if (firstFailRef.current == null) firstFailRef.current = now;
  const elapsed = now - firstFailRef.current;
  const detail = errorMessage(err);
  const status = elapsed >= BACKEND_FAIL_THRESHOLD_MS ? 'blocked' : 'error';
  setter({ status, data: null, error: detail });
}

function truncateO(str, len) {
  if (typeof str !== 'string') return '';
  if (str.length <= len) return str;
  return str.slice(0, len - 1) + '…';
}

// 공용 formatInt 위임 (ui.jsx SoT) — 로컬 재구현 폐기. 음수/NaN → '—' 가드 승격 상속.
const formatIntO = window.UI.formatInt;

// record_ts = real-UTC ISO (server .toISOString()) → 표시 tz 'MM/DD HH:mm' 표시.
// 직접 getHours()/getMinutes() = 브라우저 로컬 tz → 사용자 지시 'tz 명시' 위반 →
// window.UI.formatKstDateTime (Intl timeZone = config 시드 표시 tz, 로컬 tz 독립) 위임.
function formatTimestampO(iso) {
  if (!iso) return '—';
  return window.UI.formatKstDateTime(iso);
}

// ----- Attribution Health helpers -------------------------------------------

// 비율(0-1 fraction) → 백분율 문자열. null/NaN → '—' (denominator 0 — 데이터 부재).
function formatRateO(rate) {
  if (rate === null || rate === undefined || Number.isNaN(Number(rate))) return '—';
  return `${(Number(rate) * 100).toFixed(1)}%`;
}

// literal-omission 선택 기간 비율 → 심각도 밴드 배지. null → ℹ '—' (데이터 부재).
function attributionOmissionBadgeO(rate) {
  if (rate === null || rate === undefined || Number.isNaN(Number(rate))) {
    return { symbol: 'ℹ', icon: 'info', colorVar: '--info', text: '—' };
  }
  const value = Number(rate);
  const band = ATTRIBUTION_OMISSION_BANDS.find((b) => value < b.max) || ATTRIBUTION_OMISSION_BANDS[ATTRIBUTION_OMISSION_BANDS.length - 1];
  return { symbol: band.symbol, icon: band.icon, colorVar: band.colorVar, text: `${(value * 100).toFixed(2)}% ${band.label}` };
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

// 'YYYY-MM-DD' → 'MM/DD' (축 라벨용). 비정상 입력 → 원본 반환.
function attributionDayLabelO(day) {
  if (typeof day !== 'string' || day.length < 10) return day || '—';
  return `${day.slice(5, 7)}/${day.slice(8, 10)}`;
}

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
