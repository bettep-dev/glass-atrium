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

// 기간 선택 — 전체 칩은 wire sentinel 'all' 전송 (route parseDaysParam 가 {7,30,90,'all'} 만 허용).
// filter.days 는 number {7,30,90} | 'all' 의 tri-state → buildSearchUrlO 의 String(filter.days) 가 그대로 직렬화.
const OUTCOME_ALL_PERIOD = 'all';
const OUTCOME_PERIODS = [
  { value: 7,                 label: '7d'  },
  { value: 30,                label: '30d' },
  { value: 90,                label: '90d' },
  { value: OUTCOME_ALL_PERIOD, label: 'All' },
];

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

// result — core-outcome-record.md enum (5 values).
const RESULT_OPTIONS = [
  { value: '',                   label: 'All'               },
  { value: 'done',               label: 'done'              },
  { value: 'done_with_concerns', label: 'done_w_concerns'   },
  { value: 'blocked',            label: 'blocked'           },
  { value: 'needs_context',      label: 'needs_context'     },
  { value: 'fail',               label: 'fail'              },
];

// confidence axis (3 + null) — 'null' = writer omission.
const CONFIDENCE_OPTIONS = [
  { value: '',       label: 'All'    },
  { value: 'high',   label: 'high'   },
  { value: 'medium', label: 'medium' },
  { value: 'low',    label: 'low'    },
  { value: 'null',   label: 'null'   },
];

// metric_pass axis (true/false/null).
const METRIC_PASS_OPTIONS = [
  { value: '',      label: 'All'  },
  { value: 'true',  label: 'pass' },
  { value: 'false', label: 'fail' },
  { value: 'null',  label: 'null' },
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

// result enum → 화면 표시 색 토큰 var. RESULT_META.tone 경유 → 단일 출처 보장 (no local result→color map).
function resultColorVarO(result) {
  const tone = window.UI.RESULT_META[result]?.tone;
  return RESULT_COLOR_VAR[tone] || '--dim';
}

// colorVar(--ok/--warn/--crit/--info) → canonical Badge tone 이름. 비-tone(--dim/--faint/--accent) → 'neutral'.
//   ad-hoc tone-fill 배지를 canonical Badge(role=status)로 접을 때 tone prop 공급 — shell 은 neutral 유지, 색은 내부 Icon 이 운반.
function toneFromColorVarO(colorVar) {
  const t = String(colorVar || '').replace(/^--/, '');
  return (t === 'ok' || t === 'warn' || t === 'crit' || t === 'info') ? t : 'neutral';
}

// KPI 4 버킷 — 라벨/색/기호는 RESULT_META SoT 에서 파생 (로컬 중복 맵 제거, T-OUT-1).
const ANALYTICS_KPI_ORDER = ['done', 'done_with_concerns', 'blocked', 'fail'];

// KPI 버킷 표시 메타 — RESULT_META(label/tone/glyph) SoT 에서 colorVar/sparkRgb 파생. 로컬 색 맵 미보유.
function kpiMetaO(result) {
  const meta     = window.UI.RESULT_META[result] || { tone: 'neutral', glyph: 'ℹ', label: result };
  const colorVar = resultColorVarO(result);
  return { label: meta.label, glyph: meta.glyph, colorVar, sparkRgb: `rgb(var(${colorVar}))` };
}

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
          title="Budget-truncation (no-[COMPLETION] budget kill) rate for DEV agents over the selected window — the rolling baseline to watch for recurrence">
          <div className="fs-micro font-mono text-dim">Budget-kill rate</div>
          <div className="fs-stat font-semibold text-ink mt-1 font-mono">{formatRateO(devScope.budget_truncation_rate)}</div>
          <div className="fs-micro font-mono text-dim mt-0.5">{formatIntO(truncCount)} of {formatIntO(total)}</div>
        </div>
        <div
          className="bg-elev rounded-md p-2.5 border border-line"
          title="Synthesized-outcome rate for DEV agents — harness recovery when no [COMPLETION] block was emitted (not a failure, a recovery artifact)">
          <div className="fs-micro font-mono text-dim">Synthesized rate</div>
          <div className="fs-stat font-semibold text-ink mt-1 font-mono">{formatRateO(devScope.synthesized_rate)}</div>
          <div className="fs-micro font-mono text-dim mt-0.5">no-[COMPLETION] recovery</div>
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
            <span className="text-dim truncate" style={{ maxWidth: 220 }} title={r.agent}>{r.agent}</span>
            <span className="text-ink font-semibold tabular-nums">{formatIntO(r.count)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 일별 그리드 막대 수 — 비활성일은 series 누락 → FE 가 0-fill (활동일만 backend 전송).
const ATTRIBUTION_GRID_BARS = 30;

// Heatmap 필터 칩 — 톤 (info/warn/crit/ok) 은 셀 색조 변수로 매핑.
// 백엔드 result enum: all|empty|failed|done — 4종 전부 노출 (done 미노출 = dead filter).
// 'failed' = fail+blocked 집계 (fail 단독 아님) → 라벨 'Fail+blocked'. needs_context 는 설계상 제외.
const HEATMAP_FILTER_OPTIONS = [
  { value: 'all',    label: 'All',          tone: 'info' },
  { value: 'empty',  label: 'EMPTY only',   tone: 'warn' },
  { value: 'failed', label: 'Fail+blocked', tone: 'crit' },
  { value: 'done',   label: 'Done only',    tone: 'ok'   },
];

// 분석 섹션 기간 (KPI/Heatmap/AgentStack 만 영향, 탐색기 days 와 독립).
const ANALYTICS_PERIOD_OPTIONS = [
  { value: 7,  label: '7d'  },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

// Postgres EXTRACT(DOW) 0=Sun → 6=Sat (outcomes.ts handleHeatmap).
const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

// AgentStackedBar 카드 상한 — 컨테이너 가독성 / cross-analysis 의 by_agent_top_10 캡과 일관.
const AGENT_STACK_TOP_N = 8;

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
  { key: 'true',  label: 'pass' },
  { key: 'false', label: 'fail' },
  { key: 'null',  label: 'null' },
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
  const { PageHeader, Icon, Pill, TypeScaleStyle } = window.UI;

  // Filter state — URL hash 초기화 → 북마크 / 직접링크 복원.
  const [filter, setFilter] = useStateO(() => readFilterFromHashO());
  const [page,   setPage]   = useStateO(0);
  const [sort,   setSort]   = useStateO(() => readSortFromHashO());

  // 키워드 입력은 filter 와 분리 → debounce 가능 (request thrashing 회피).
  const [keywordInput, setKeywordInput] = useStateO(filter.q || '');

  const [searchState, setSearchState] = useStateO({ status: 'loading', data: null, error: null });

  // 분석 섹션 상태 (탐색기 필터와 독립) — period 는 KPI/Heatmap/AgentStack 공통 기간.
  const [analyticsPeriod, setAnalyticsPeriod] = useStateO(30);
  const [heatmapFilter,   setHeatmapFilter]   = useStateO('all');
  const [analyticsState,  setAnalyticsState]  = useStateO({ status: 'loading', data: null, error: null });
  const [heatmapState,    setHeatmapState]    = useStateO({ status: 'loading', data: null, error: null });

  // Attribution Health — /api/outcomes/attribution-daily (analyticsPeriod 와 동일 window).
  const [attributionState, setAttributionState] = useStateO({ status: 'loading', data: null, error: null });

  // Loop-events raw 로그 — Learning 에서 이관(operational data). period 무관 all-time → refreshTick 만 의존.
  const [loopEventsState, setLoopEventsState] = useStateO({ status: 'loading', data: null, error: null });

  // Detail modal — active row + body_md (optional).
  const [detailRow,   setDetailRow]   = useStateO(null);
  const [detailState, setDetailState] = useStateO({ status: 'idle', data: null, error: null });

  const [refreshTick, setRefreshTick] = useStateO(0);

  // T13 (O2) — canonical agent facet 소스 (registry 게이트된 /api/agents/summary).
  const [canonicalAgentsState, setCanonicalAgentsState] = useStateO({ status: 'loading', data: null, error: null });

  // T7 (O2) — forensic 'show all' 토글: include_all 파라미터로 서버 registry 게이트 해제.
  const [includeAll, setIncludeAll] = useStateO(false);

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
        setSearchState({ status: 'ready', data, error: null });
      })
      .catch((err) => handleSearchErrorO(err, setSearchState, firstFailAtRef));

    return () => ctrl.abort();
  }, [filter, sort, page, refreshTick, includeAll]);

  // 분석 fetch — period 또는 heatmap 필터 변경 시 재실행.
  // 병렬 6 fetch: cross-analysis x5 (overall + per-result 4) + heatmap x1.
  // AbortController 분리 → 탐색기 wave 와 독립.
  useEffectO(() => {
    const ctrl = new AbortController();
    setAnalyticsState({ status: 'loading', data: null, error: null });
    setHeatmapState({ status: 'loading', data: null, error: null });

    const crossUrl   = `/api/outcomes/cross-analysis?days=${analyticsPeriod}`;
    const heatmapUrl = `/api/outcomes/heatmap?days=${analyticsPeriod}&result=${heatmapFilter}`;

    const overallTask    = fetchJsonO(crossUrl, ctrl.signal);
    const perResultTasks = ANALYTICS_KPI_ORDER.map((res) =>
      fetchJsonO(`${crossUrl}&result=${res}`, ctrl.signal),
    );
    const heatmapTask    = fetchJsonO(heatmapUrl, ctrl.signal);

    Promise.all([overallTask, ...perResultTasks])
      .then(([overall, ...perResult]) => {
        const byResultCount    = buildByResultCountMapO(overall.by_result);
        // 합성 복구행(reconstructed) 서브카운트 — KPI headline 을 writer-emitted 로 분리.
        const byResultReconstructed = buildByResultReconstructedMapO(overall.by_result);
        const agentStack       = buildAgentStackO(perResult, ANALYTICS_KPI_ORDER, AGENT_STACK_TOP_N);
        const bucketSparks     = buildBucketSparkMapO(perResult, ANALYTICS_KPI_ORDER);
        // needs_context (4-KPI 밖 유효 result) + polar-mismatch cross-tab — overall 응답에서 직접 추출.
        const needsContextCount = extractResultCountO(overall.by_result, 'needs_context');
        const crosstab          = buildCrosstabO(overall.cells);
        setAnalyticsState({
          status: 'ready',
          data: { overall, byResultCount, byResultReconstructed, agentStack, bucketSparks, needsContextCount, crosstab },
          error: null,
        });
      })
      .catch((err) => handleErrorO(err, setAnalyticsState));

    heatmapTask
      .then((data) => setHeatmapState({ status: 'ready', data, error: null }))
      .catch((err) => handleErrorO(err, setHeatmapState));

    return () => ctrl.abort();
  }, [analyticsPeriod, heatmapFilter, refreshTick]);

  // Attribution Health fetch — heatmap 과 동일 window, AbortController 공유 회피 위해 별도 effect.
  // analyticsPeriod {7,30,90} 가 backend 의 ALLOWED_DAYS_NUMERIC 와 동일 → param 검증 추가 불필요.
  useEffectO(() => {
    const ctrl = new AbortController();
    setAttributionState({ status: 'loading', data: null, error: null });

    fetchJsonO(`/api/outcomes/attribution-daily?days=${analyticsPeriod}`, ctrl.signal)
      .then((data) => setAttributionState({ status: 'ready', data, error: null }))
      .catch((err) => handleErrorO(err, setAttributionState));

    return () => ctrl.abort();
  }, [analyticsPeriod, refreshTick]);

  // Loop-events raw 로그 fetch — period 무관(all-time stream). AbortController 분리 → 부분 실패 격리.
  useEffectO(() => {
    const ctrl = new AbortController();
    setLoopEventsState({ status: 'loading', data: null, error: null });

    fetchJsonO(LOOP_EVENTS_URL, ctrl.signal)
      .then((data) => setLoopEventsState({ status: 'ready', data, error: null }))
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
              <AnalyticsPeriodSeg value={analyticsPeriod} onChange={setAnalyticsPeriod}/>
              <button className="btn ghost sm" onClick={triggerRefresh} aria-label="Refresh task results">
                <Icon name="refresh" size={14}/>
                Refresh
              </button>
            </>
          }
        />
      </div>

      <AnalyticsSection
        analyticsState={analyticsState}
        heatmapState={heatmapState}
        attributionState={attributionState}
        heatmapFilter={heatmapFilter}
        period={analyticsPeriod}
        onChangeHeatmapFilter={setHeatmapFilter}
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
        />
      </div>

      {/* Learning 에서 이관된 raw 데몬 사이클 이벤트 로그 — operational data (집계 신호 아님 · W3-T3/T7). */}
      <LoopEventsCard state={loopEventsState} onRetry={triggerRefresh}/>

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

// 분석 섹션 — 차트는 inline SVG / .heat-cell / Tailwind flex 비례 바 (Recharts 미사용).

function AnalyticsPeriodSeg({ value, onChange }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Analytics time range">
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

function AnalyticsSection({ analyticsState, heatmapState, attributionState, heatmapFilter, period, onChangeHeatmapFilter, onRetry }) {
  // Heatmap + AgentStackedBar 좌우 2열 — heat-cell aspect-ratio:1 로 폭 축소 시 높이 자동 정렬.
  // 데스크탑 viewport 만 운영 (127.0.0.1:7842) → md breakpoint 분기 불필요.
  // AttributionHealthCard — 2열 grid 아래 full-width (일별 30-bar 그리드 가독성).
  return (
    <div className="flex-shrink-0">
      <KpiBucketRow state={analyticsState} onRetry={onRetry}/>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <HeatmapCard
          state={heatmapState}
          filter={heatmapFilter}
          period={period}
          onChangeFilter={onChangeHeatmapFilter}
          onRetry={onRetry}
        />
        <AgentStackedBarCard state={analyticsState} onRetry={onRetry}/>
      </div>
      <AttributionHealthCard state={attributionState} period={period} onRetry={onRetry}/>
      <GraderBreakdownCard state={analyticsState} period={period} onRetry={onRetry}/>
      <CrosstabCard state={analyticsState} period={period} onRetry={onRetry}/>
    </div>
  );
}

// KPI 버킷 (4 result × Sparkline).

function KpiBucketRow({ state, onRetry }) {
  if (state.status === 'loading') {
    return (
      <div className="grid grid-cols-4 gap-3 mb-4" aria-busy="true" aria-label="Loading result KPIs">
        {Array.from({ length: 4 }).map((_, i) => <KpiSkeletonO key={i}/>)}
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="mb-4">
        <ErrorBannerO title="Couldn't load result KPIs" detail={state.error} onRetry={onRetry}/>
      </div>
    );
  }

  const byResultCount = state.data.byResultCount;
  // headline = writer-emitted (count - reconstructed) — 합성 복구행은 카드 내 sub-line 으로 분리
  // (Attribution Health 'Reconstructed ⚠' 어휘 재사용, 복구 산물 ≠ 실패).
  const byResultReconstructed = state.data.byResultReconstructed || {};
  const bucketSparks  = state.data.bucketSparks || {};

  // 분모 = API total (5개 result enum 전수) — 4-card 합(needs_context 제외)으로 재유도 금지.
  // total 부재 시에만 4-card 합 fallback (헤더 일치 total 우선).
  const apiTotal      = Number(state.data.overall?.total) || 0;
  const kpiTotal      = apiTotal > 0 ? apiTotal : sumByResultO(byResultCount);
  const kpiSum        = sumByResultO(byResultCount);
  const otherCount    = Math.max(0, kpiTotal - kpiSum);

  // needs_context 는 유효 result enum 이나 4-KPI 밖 → 별도 세그먼트로 노출 (드롭 회피).
  const needsContextCount = Number(state.data.needsContextCount) || 0;

  return (
    <div className="mb-4">
      <div className="grid grid-cols-4 gap-3">
        {ANALYTICS_KPI_ORDER.map((key) => {
          const meta = kpiMetaO(key);
          const totalCount = byResultCount[key] || 0;
          // clamp — 서버 불변식(reconstructed <= count) 방어 (음수 headline 차단).
          const reconstructedCount = Math.min(Number(byResultReconstructed[key]) || 0, totalCount);
          return (
            <KpiBucket
              key={key}
              meta={meta}
              count={totalCount - reconstructedCount}
              reconstructedCount={reconstructedCount}
              total={kpiTotal}
              sparkData={bucketSparks[key] ?? null}
            />
          );
        })}
      </div>
      <NeedsContextSegment
        count={needsContextCount}
        total={kpiTotal}
        otherCount={otherCount}
      />
    </div>
  );
}

// 분모 안내 행 — 4-KPI 카드 아래 단일 행. otherCount 존재 시 'Percentages out of N total' 노트만 표기.
function NeedsContextSegment({ count, total, otherCount }) {
  // residual = 4-card + needs_context 외 잔여 (fail 90d 등 — 선택 기간에 없을 수 있음).
  const residual = Math.max(0, otherCount - count);

  return (
    <div className="mt-2 flex items-center gap-3 flex-wrap">
      {otherCount > 0 && (
        <span className="fs-micro text-faint font-mono">
          Percentages out of {formatIntO(total)} total{residual > 0 ? ` · ${formatIntO(residual)} more not shown in cards/segments` : ''}
        </span>
      )}
    </div>
  );
}

function KpiBucket({ meta, count, total, sparkData, reconstructedCount = 0 }) {
  const { Sparkline } = window.UI;
  const pct = total > 0 ? (count / total * 100) : 0;

  // 0건 버킷(예: 30d fail) → dead 0% 카드 대신 빈 sparkline 숨김 + '다른 기간에서 확인' 안내.
  //   reconstructed 만 있는 버킷은 dead 아님 → sub-line 유지.
  const isZeroBucket = count === 0 && reconstructedCount === 0;
  const synthMeta = ATTRIBUTION_CATEGORY_META.synthesized;
  const ariaLabel = reconstructedCount > 0
    ? `${meta.label}: ${count} writer-emitted, ${reconstructedCount} reconstructed`
    : `${meta.label}: ${count}`;

  return (
    <div className="kpi cursor-default" aria-label={ariaLabel}>
      <div className="kpi-label">
        <span
          className="inline-block w-2 h-2 rounded-sm"
          style={{ background: `rgb(var(${meta.colorVar}))` }}
          aria-hidden="true"/>
        {meta.label}
      </div>
      <div className="kpi-value">
        {formatIntO(count)}
        <span className="unit">/ {pct.toFixed(1)}%</span>
      </div>
      {reconstructedCount > 0 && (
        <div
          className="fs-micro font-mono"
          style={{ color: `rgb(var(${synthMeta.colorVar}))` }}
          title="Harness-reconstructed records (recovery artifacts, not writer-emitted)">
          {synthMeta.symbol} {formatIntO(reconstructedCount)} {synthMeta.label.toLowerCase()}
        </div>
      )}
      {isZeroBucket ? null : (
        sparkData && sparkData.length >= 2 && (
          <div className="kpi-spark">
            <Sparkline data={sparkData} w={68} h={26} color={meta.sparkRgb}/>
          </div>
        )
      )}
    </div>
  );
}

// DOW × Hour Heatmap.

// 서버 grid 는 record_ts AT TIME ZONE meta.timezone 버킷(config [meta].timezone) →
// 응답 필드의 tz 약칭 명시. meta 부재 시 표시 tz 폴백 (tzShortLabel 인자 생략 동작).
function buildHeatmapSubText(state, period, filter) {
  if (state.status !== 'ready') {
    return state.status === 'loading' ? 'Loading…' : "Couldn't load";
  }
  const total = Number(state.data?.meta?.total_count ?? 0);
  const tzLabel = window.UI.tzShortLabel(state.data?.meta?.timezone);
  return `${tzLabel} · ${formatIntO(total)} records`;
}

function HeatmapCard({ state, filter, period, onChangeFilter, onRetry }) {
  const { CardHead, Tabs } = window.UI;
  const subText = buildHeatmapSubText(state, period, filter);

  return (
    <div className="card">
      <CardHead
        title="Activity by day and hour"
        sub={subText}
        right={
          <Tabs
            value={filter}
            onChange={onChangeFilter}
            items={HEATMAP_FILTER_OPTIONS}
          />
        }
      />
      <div className="card-body">
        <HeatmapBody state={state} filter={filter} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function HeatmapBody({ state, filter, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonO height={220} aria-label="Loading heatmap"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerO title="Couldn't load heatmap" detail={state.error} onRetry={onRetry}/>;
  }
  const grid = state.data?.data;
  if (!Array.isArray(grid) || grid.length === 0) {
    return <EmptyStateO message="No results in this period."/>;
  }

  // 단일 색조 톤 — 필터별 info/warn/crit 매핑.
  const tone = (HEATMAP_FILTER_OPTIONS.find((opt) => opt.value === filter) || HEATMAP_FILTER_OPTIONS[0]).tone;
  const toneVar = `--${tone}`;
  const max = grid.flat().reduce((m, v) => Math.max(m, Number(v) || 0), 0);

  return (
    <div>
      {/* 7x24 grid: 첫 컬럼 32px 요일 라벨, 첫 행 시간 라벨 (3h 간격). */}
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: '32px repeat(24, minmax(0, 1fr))' }}>
        <div/>
        {Array.from({ length: 24 }, (_, h) => (
          <div key={`hcol-${h}`} className="fs-micro font-mono text-faint text-center">
            {h % 3 === 0 ? h : ''}
          </div>
        ))}
        {grid.map((row, di) => (
          <React.Fragment key={`hrow-${di}`}>
            <div className="fs-micro font-mono text-faint flex items-center">
              {DOW_LABELS[di]}
            </div>
            {row.map((v, hi) => {
              const opacity = max === 0 ? 0 : 0.1 + (Number(v) / max) * 0.9;
              return (
                <div
                  key={`hc-${di}-${hi}`}
                  className="heat-cell"
                  style={{ background: `rgb(var(${toneVar}) / ${opacity.toFixed(3)})` }}
                  title={`${DOW_LABELS[di]} ${hi}:00 — ${formatIntO(v)}`}
                  aria-label={`${DOW_LABELS[di]} ${hi}:00 — ${formatIntO(v)} records`}/>
              );
            })}
          </React.Fragment>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-3 fs-micro text-faint">
        <span>Fewer</span>
        <div className="flex gap-[2px]" aria-hidden="true">
          {[0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((o) => (
            <div
              key={`leg-${o}`}
              className="w-4 h-3 rounded-sm"
              style={{ background: `rgb(var(${toneVar}) / ${o})` }}/>
          ))}
        </div>
        <span>More</span>
        <span className="ml-auto font-mono">peak {formatIntO(max)}/h</span>
      </div>
    </div>
  );
}

// ----- 에이전트별 outcome 분포 (4 result stack) -------------------------------
// 데이터: per-result cross-analysis x4 (ANALYTICS_KPI_ORDER 순) → 에이전트별 카운트 stitch.
// 가로 바 h-5 ok/warn/info/crit 비례 stack — 실제 카운트 기반.
// 한계: 4개 독립 top-10 합성 → 각 result 11위 이하 기여 누락 가능 (비권위 근사치).
//   pseudo-agent(subagent_stop_missing 등)는 NON_ACTIONABLE_AGENT_IDS_O 로 시각 분리.

function AgentStackedBarCard({ state, onRetry }) {
  const { CardHead } = window.UI;
  return (
    <div className="card">
      <CardHead title="Results by agent" sub="Approximate"/>
      <div className="card-body">
        <AgentStackedBarBody state={state} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function AgentStackedBarBody({ state, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonO height={220} aria-label="Loading results by agent"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerO title="Couldn't load results by agent" detail={state.error} onRetry={onRetry}/>;
  }
  const agentStack = state.data?.agentStack ?? [];
  if (agentStack.length === 0) {
    return <EmptyStateO message="No agent results in this period."/>;
  }

  return (
    <div>
      <div className="space-y-3">
        {agentStack.map((row) => <AgentStackedBarRow key={row.agent} row={row}/>)}
      </div>
      <AgentStackedBarLegend/>
      {/* per-result top-10 4개 독립 리스트 stitch → cutoff(#11↓) 기여 누락 가능 = 비권위 근사치 고지. */}
      <div className="fs-micro text-faint font-mono mt-2 leading-relaxed">
        <span className="inline-flex items-center gap-1">
          <GlyphO name="diamond" className="text-dim"/> = placeholder bucket (not a real agent)
        </span>
      </div>
    </div>
  );
}

function AgentStackedBarRow({ row }) {
  const { AgentBadge } = window.UI;
  const total = row.total;

  // pseudo-agent (subagent_stop_missing 등) → ◇ 표식 + dim 처리로 실 agent 와 구분.
  const isPseudoAgent = isNonActionableAgentO(row.agent);

  // 0% 셀은 width 0 → 자동 제외.
  return (
    <div>
      <div className="flex items-center gap-2 fs-body mb-1.5">
        <AgentBadge a={{ id: row.agent, name: row.agent }} size={18}/>
        <span
          className={`flex-1 font-medium truncate ${isPseudoAgent ? 'text-dim italic' : ''}`}
          title={isPseudoAgent ? `${row.agent} (placeholder bucket — not a real agent)` : row.agent}>
          {isPseudoAgent && <GlyphO name="diamond" className="mr-1"/>}
          {row.agent}
        </span>
        <span className="font-mono text-dim fs-meta">{formatIntO(total)}</span>
      </div>
      <div className="flex h-5 rounded overflow-hidden border border-line fs-micro font-mono text-white">
        {ANALYTICS_KPI_ORDER.map((key) => {
          const count = row.byResult[key] || 0;
          const pct = total > 0 ? (count / total * 100) : 0;
          if (pct <= 0) return null;
          const meta = kpiMetaO(key);
          return (
            <div
              key={key}
              className="flex items-center justify-center"
              style={{ width: `${pct.toFixed(2)}%`, background: `rgb(var(${meta.colorVar}))` }}
              title={`${meta.label}: ${formatIntO(count)} (${pct.toFixed(1)}%)`}
              aria-label={`${meta.label} ${pct.toFixed(1)}%`}>
              {pct >= 12 ? pct.toFixed(0) : ''}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentStackedBarLegend() {
  return (
    <div className="flex gap-3 fs-micro text-faint pt-3 border-t border-line mt-3">
      {ANALYTICS_KPI_ORDER.map((key) => {
        const meta = kpiMetaO(key);
        return (
          <span key={key} className="flex items-center gap-1">
            <span
              className="w-2 h-2 rounded-sm"
              style={{ background: `rgb(var(${meta.colorVar}))` }}
              aria-hidden="true"/>
            {meta.label}
          </span>
        );
      })}
    </div>
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
                <span style={{ color: `rgb(var(${meta.colorVar}))` }}>{meta.label}</span>
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
          <span style={{ color: `rgb(var(${omissionMeta.colorVar}))` }} className="mr-1">{omissionMeta.label}:</span>
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
            {/* 범례 점 크기 통일 — w-2 h-2 (AgentStackedBarLegend·KpiBucket 과 동일, W3-T7). */}
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

// ----- 측정 분포 (artifact-vs-quality breakdown) -----------------------------
// /api/outcomes/cross-analysis grader_breakdown — grader_verdict 버킷 분포.
//   verified_pass/unverified/verified_fail = graded_total 분모 · not_measured(레거시 NULL) 은 비율 분모 제외.
//   목적: 측정 산물(unverified/legacy)을 품질 실패로 오독하지 않게 측정 신호를 명시 노출.

function GraderBreakdownCard({ state, period, onRetry }) {
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
              <div className="inline-flex items-start gap-1 fs-micro uppercase tracking-wider min-h-[2.2em]" style={{ color: `rgb(var(${meta.colorVar}))` }}>
                <GlyphO name={meta.icon}/>
                {meta.label}
              </div>
              <div className="mt-1 font-mono fs-title text-ink">{formatIntO(count)}</div>
              <div className="fs-micro text-faint">{pct != null ? `${pct.toFixed(1)}%` : 'not in share denominator'}</div>
            </div>
          );
        })}
      </div>
      <TaskTypeGraderCrosstabO rows={state.data?.overall?.task_type_grader_breakdown}/>
    </>
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

function CrosstabCard({ state, period, onRetry }) {
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
    return <EmptyStateO message="No confidence×metric_pass records in this period."/>;
  }

  const max = crosstabMaxCountO(crosstab.byCell);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full fs-meta font-mono" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              <th scope="col" className="text-left text-dim font-medium px-2 py-1.5 border-b border-line">conf \ metric</th>
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
      <th scope="row" className="text-left text-ink font-medium px-2 py-1.5 border-b border-line">{rowKey}</th>
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
                    {e.agent || '—'}
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
const CHIP_FILTER_AXES = [
  { axis: 'task_type',   label: 'task_type',   options: TASK_TYPE_OPTIONS   },
  { axis: 'result',      label: 'result',      options: RESULT_OPTIONS      },
  { axis: 'confidence',  label: 'confidence',  options: CONFIDENCE_OPTIONS  },
  { axis: 'metric_pass', label: 'metric_pass', options: METRIC_PASS_OPTIONS },
  { axis: 'review_flag', label: 'review_flag', options: REVIEW_FLAG_OPTIONS },
  { axis: 'attribution_source', label: 'attribution', options: ATTRIBUTION_SOURCE_OPTIONS },
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
        <FilterAxisGroup label="Period">
          <ChipGroup
            options={OUTCOME_PERIODS.map((p) => ({ value: String(p.value), label: p.label }))}
            value={String(filter.days)}
            onChange={(v) => onPatchFilter({ days: normalizeDaysO(v) })}
            ariaLabel="Time range"
          />
        </FilterAxisGroup>

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

        {/* T7/O2 forensic 'show all' — include_all=1 로 서버 registry 게이트 해제 (비-registry / de-registered 노출). */}
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

        <FilterAxisGroup label="Sort">
          <ChipGroup
            options={SORT_OPTIONS}
            value={sort}
            onChange={onSortChange}
            ariaLabel="Sort order"
          />
        </FilterAxisGroup>

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
  onPageChange, onSortChange, onResetFilter, onRowClick, onRetry,
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
          : 'Loading…'}
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

function ResultTableBody({ state, rows, totalMatched, filter, sort, onSortChange, onResetFilter, onRowClick, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonO height={400} aria-label="Loading results"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerO title="Couldn't load search results" detail={state.error} onRetry={onRetry}/>;
  }
  if (state.status === 'blocked') {
    return <BlockedBannerO detail={state.error}/>;
  }
  if (rows.length === 0) {
    return <ResultTableZeroStateO filter={filter} onResetFilter={onResetFilter}/>;
  }

  return <ResultTable rows={rows} sort={sort} onSortChange={onSortChange} onRowClick={onRowClick}/>;
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

function ResultTable({ rows, sort, onSortChange, onRowClick }) {
  // flex: 1 + min-h: 0 → table 이 card-body 높이 fill, sticky header 유지하며 body scroll.
  // mono 는 timestamp/id/숫자 컬럼만 — 산문(agent/task_type/result/summary)은 sans (W3-T7 density).
  return (
    <div className="overflow-auto" style={{ flex: '1 1 auto', minHeight: 0 }}>
      <table className="w-full fs-meta" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
        <thead>
          <tr>
            <SortableHeader label="Time" sortKey="record_ts" currentSort={sort} onSortChange={onSortChange} align="left" width={120}/>
            <PlainHeader label="Agent" minWidth={110}/>
            <PlainHeader label="task_type"/>
            <PlainHeader label="result"/>
            <PlainHeader label="conf" align="center"/>
            <PlainHeader label="metric*" align="center"/>
            <PlainHeader label="Check" align="center"/>
            <SortableHeader label="rev" sortKey="revision_count" currentSort={sort} onSortChange={onSortChange} align="right" width={50} descOnly/>
            <PlainHeader label="summary"/>
            <PlainHeader label="cid" width={110}/>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ResultTableRow key={row.id} row={row} onRowClick={onRowClick}/>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 fs-micro text-faint px-2 py-2">
        <span><span className="text-dim">metric*</span> = self-reported, not verified</span>
      </div>
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

// confidence 3-seg NEUTRAL slate chip (T-OUT-2) — high/medium/low 를 채워진 슬레이트 세그먼트 수로 표현.
//   green/red 회피: confidence 는 품질 판정이 아니라 작성자의 자기확신도 → 중립(slate) 단계만 인코딩.
//   null(작성자 누락) = 빈 칩 + '—' (수치 fabrication 회피). 색≠의미 단독: 세그먼트 수가 위계를 전달.
const CONFIDENCE_LEVEL = { high: 3, medium: 2, low: 1 };

function ConfidenceChipO({ confidence }) {
  const level = CONFIDENCE_LEVEL[confidence] || 0;
  const label = confidence == null ? '—' : confidence;

  if (level === 0) {
    return <span className="fs-meta font-mono text-faint" title="confidence not reported">—</span>;
  }
  return (
    <span
      className="inline-flex items-center gap-1 align-middle"
      role="img"
      aria-label={`confidence ${label} (${level} of 3)`}
      title={`confidence: ${label}`}>
      <span className="inline-flex gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="inline-block rounded-sm"
            style={{
              width: 5,
              height: 10,
              background: i < level ? 'rgb(var(--dim))' : 'rgb(var(--line))',
            }}/>
        ))}
      </span>
      <span className="fs-micro font-mono text-dim">{label}</span>
    </span>
  );
}

// metric_pass = writer self-report (측정 진실 아님) → 측정 컬럼(grader_verdict)과 분리.
//   품질 실패 오독 차단: minimal check(✓)/dash(–) muted 기호만 — crit(빨강) 절대 금지 (실 측정 신호는 Check 컬럼).
//   true=✓ muted · false/null=– muted (self-report false 도 응급 신호 아님).
function MetricPassMarkO({ metricPass }) {
  const isPass = metricPass === true;
  const iconName = isPass ? 'check' : 'minus';
  const label  = metricPass === true ? 'pass (self-reported)' : metricPass === false ? 'fail (self-reported)' : 'not reported';
  return (
    <span
      className="fs-meta font-mono inline-flex items-center align-middle"
      style={{ color: isPass ? 'rgb(var(--dim))' : 'rgb(var(--faint))' }}
      role="img"
      aria-label={`metric_pass ${label}`}>
      <GlyphO name={iconName}/>
    </span>
  );
}

// qa_score (cov/ins/instr/clar 각 1-5) → 5 중립 dot (채워진 dot 수 = 평균 점수). QA 행 전용 OPTIONAL.
//   데이터 미존재(현 search/detail SELECT 에 qa_score 컬럼 없음) → 미렌더 (슬롭 회피, no fabricated dots).
function parseQaScoreAvgO(qaScore) {
  if (typeof qaScore !== 'string' || qaScore.trim() === '') return null;
  const nums = qaScore.match(/\d+(\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  const sum = nums.reduce((acc, n) => acc + Number(n), 0);
  return sum / nums.length;
}

function QaScoreDotsO({ qaScore }) {
  const avg = parseQaScoreAvgO(qaScore);
  if (avg == null) return null;
  const filled = Math.round(Math.min(Math.max(avg, 0), 5));
  return (
    <span
      className="inline-flex items-center gap-0.5 align-middle"
      role="img"
      aria-label={`qa score ${avg.toFixed(1)} of 5`}
      title={`qa_score: ${qaScore}`}>
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
function RevisionCountCellO({ revisionCount }) {
  const { Bar } = window.UI;
  const n = Number(revisionCount) || 0;

  if (n === 0) {
    return <span className="text-dim font-mono">—</span>;
  }
  if (n < 2) {
    return <span className="text-dim font-mono">{formatIntO(n)}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 justify-end" title={`reworked ${n} times — high revision frequency (≥2)`}>
      <span className="text-ink font-mono font-semibold">{formatIntO(n)}</span>
      <span style={{ width: 28 }}>
        <Bar value={Math.min(n, 5)} max={5} tone="warn" ariaLabel={`revision count ${n}, high (≥2)`}/>
      </span>
    </span>
  );
}

function ResultTableRow({ row, onRowClick }) {
  const isFail   = row.result === 'fail';
  const isReview = !isFail && row.review_flag === true;
  const rowClass = `outcome-row cursor-pointer ${isFail ? 'is-fail' : ''} ${isReview ? 'is-review' : ''}`;

  const ts       = formatTimestampO(row.record_ts);
  const summary  = truncateO(row.summary || '', 60);
  const cidShort = truncateO(row.cid || '', 12);
  const grader   = graderVerdictMetaO(row.grader_verdict);
  // result tone/icon/label = RESULT_META SoT (T-OUT-1 — 로컬 result→color map 제거, 색맹 안전 듀얼인코딩).
  const resultMeta  = window.UI.RESULT_META[row.result] || { icon: 'info', label: row.result };
  const resultColor = `rgb(var(${resultColorVarO(row.result)}))`;

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
      aria-label={`${row.agent} ${row.task_type} ${row.result} check ${grader.label} ${row.summary || ''}`}>
      <td className="text-left text-ink font-mono px-2 py-1.5 border-b border-line whitespace-nowrap">
        {ts}
      </td>
      <td className="text-left text-ink px-2 py-1.5 border-b border-line truncate" style={{ maxWidth: 140 }} title={row.agent}>
        {row.agent}
      </td>
      <td className="text-left text-dim px-2 py-1.5 border-b border-line">{row.task_type}</td>
      <td className="text-left px-2 py-1.5 border-b border-line" title={resultMeta.label}>
        <span className="inline-flex items-center gap-1" style={{ color: resultColor, fontWeight: 500 }}>
          <GlyphO name={resultMeta.icon}/>
          {row.result}
        </span>
      </td>
      <td className="text-center px-2 py-1.5 border-b border-line">
        <ConfidenceChipO confidence={row.confidence}/>
      </td>
      <td
        className="text-center font-mono px-2 py-1.5 border-b border-line">
        <span className="inline-flex items-center gap-1.5 justify-center">
          <MetricPassMarkO metricPass={row.metric_pass}/>
          <QaScoreDotsO qaScore={row.qa_score}/>
        </span>
      </td>
      <td
        className="text-center px-2 py-1.5 border-b border-line"
        title={`Automatic check (grader_verdict): ${grader.label}${
          row.grader_verdict === 'unverified'
            ? ' — no test artifact to grade for this task type.'
            : row.grader_verdict == null
            ? ' — recorded before the grader existed, not a failure.'
            : ''
        }`}>
        <span className="inline-flex items-center gap-1 justify-center" style={{ color: `rgb(var(${grader.colorVar}))`, fontWeight: 500 }}>
          <GlyphO name={grader.icon}/>
          {grader.label}
        </span>
      </td>
      <td className="text-right px-2 py-1.5 border-b border-line">
        <RevisionCountCellO revisionCount={row.revision_count}/>
      </td>
      <td className="text-left text-ink px-2 py-1.5 border-b border-line truncate" style={{ maxWidth: 380 }} title={row.summary || ''}>
        <PoisonedBadgeO row={row}/>
        {isReview && <ReviewReasonBadgeO row={row}/>}
        <AttributionSourceBadgeO row={row}/>
        {summary}
      </td>
      <td className="text-left text-faint font-mono px-2 py-1.5 border-b border-line truncate" style={{ maxWidth: 110 }} title={row.cid || ''}>
        {cidShort || '—'}
      </td>
    </tr>
  );
}

// review_flag 사유 inline 배지 — warn 색 + ⚠ 기호 dual-encoding, summary 셀 prefix.
// 분류는 window.UI.reviewFlagReasons SoT (improvement KPI 세그먼트와 공용, F12).
function ReviewReasonBadgeO({ row }) {
  const reasons = window.UI.reviewFlagReasons(row);
  if (reasons.length === 0) return null;
  const text = reasons.map((r) => r.label).join('·');
  const title = `Flagged for review: ${reasons.map((r) => `${r.label} (${r.title})`).join(' / ')}`;
  const { Badge } = window.UI;
  return (
    <Badge role="status" tone="warn" icon title={title} className="mr-1.5">{text}</Badge>
  );
}

// poisoned_window 행 배지 — 분석 집계 제외 행 표식 (탐색기에는 그대로 노출 · 'Quarantined: N excluded' 칩과 정합).
function PoisonedBadgeO({ row }) {
  if (!row || row.poisoned_window !== true) return null;
  const { Badge } = window.UI;
  return (
    <Badge role="status" tone="warn" icon title="Quarantined row — excluded from analysis stats." className="mr-1.5">Quarantined</Badge>
  );
}

// attribution_source == 'budget-truncation' 행 표식 — 예산 상한 초과로 completion 미방출된 subagent (info-tone, 에러 아님).
//   그 외 source 는 미렌더 — raw source 전량 노출 = 테이블 clutter · 관심 신호(budget-kill)만 표면화.
function AttributionSourceBadgeO({ row }) {
  if (!row || row.attribution_source !== ATTRIBUTION_SOURCE_BUDGET_TRUNCATION) return null;
  const { Badge } = window.UI;
  return (
    <Badge role="status" tone="info" icon title="attribution_source: budget-truncation — subagent hit its budget ceiling before emitting a completion block." className="mr-1.5">budget-kill</Badge>
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
  if (flag === true)  return 'true';
  if (flag === false) return 'false';
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
      <MetaField label="confidence"        value={row?.confidence ?? '—'}/>
      <MetaField label="Self-reported pass" value={row?.metric_pass == null ? '—' : String(row.metric_pass)}/>
      <div>
        <div className="fs-micro text-faint uppercase tracking-wider">Automatic check</div>
        <div className="inline-flex items-center gap-1" style={{ color: `rgb(var(${grader.colorVar}))`, fontWeight: 500 }}>
          <GlyphO name={grader.icon}/>
          {grader.label}
        </div>
      </div>
      <MetaField label="revision_count" value={formatIntO(row?.revision_count || 0)}/>
      <div>
        <div className="fs-micro text-faint uppercase tracking-wider">review_flag</div>
        <div className="text-ink inline-flex items-center gap-1.5 flex-wrap">
          {reviewFlagLabel(row?.review_flag)}
          {row?.review_flag === true && window.UI.reviewFlagReasons(row).map((r) => (
            <Badge key={r.key} role="status" tone="warn" icon title={r.title}>{r.label}</Badge>
          ))}
        </div>
      </div>
      {row?.poisoned_window === true && (
        <MetaField label="poisoned_window" value="true — quarantined window (excluded from analysis)"/>
      )}
      {evalSignal != null && (
        <MetaField label="evaluative_signal" value={formatEvaluativeSignalO(evalSignal)}/>
      )}
      {metricType != null && metricType !== '' && (
        <MetaField label="metric_type" value={String(metricType)}/>
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
  return (
    <div className="placeholder" style={{ padding: 20 }}>
      {message}
    </div>
  );
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

// 기간 칩 값 정규화 — 'all' sentinel 보존 + 숫자 칩은 Number 로 환원 (route wire format 일치).
// Number('all') = NaN 좌절 회피: 'all' 직접 통과, 그 외 유효 숫자만 number, 미해석 → 30 fallback.
function normalizeDaysO(value) {
  if (value === OUTCOME_ALL_PERIOD) return OUTCOME_ALL_PERIOD;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

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

function formatIntO(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('en-US');
}

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

// cross-analysis by_result → { result: count }. ANALYTICS_KPI_ORDER 4 키 기본값 0 보장.
function buildByResultCountMapO(byResult) {
  const out = {};
  for (const key of ANALYTICS_KPI_ORDER) out[key] = 0;
  if (!Array.isArray(byResult)) return out;
  for (const row of byResult) {
    if (row && typeof row.result === 'string') {
      out[row.result] = Number(row.count) || 0;
    }
  }
  return out;
}

// cross-analysis by_result → { result: reconstructed_count } (합성 복구행 서브카운트).
//   writer-emitted headline = count - reconstructed_count. 필드 부재(구 응답) → 0 (분리 없음과 동일).
function buildByResultReconstructedMapO(byResult) {
  const out = {};
  for (const key of ANALYTICS_KPI_ORDER) out[key] = 0;
  if (!Array.isArray(byResult)) return out;
  for (const row of byResult) {
    if (row && typeof row.result === 'string') {
      out[row.result] = Number(row.reconstructed_count) || 0;
    }
  }
  return out;
}

// per-result cross-analysis x4 응답 → 에이전트별 카운트 stitch. 인덱스 = resultOrder.
// 반환: total desc top-N.
function buildAgentStackO(perResultPayloads, resultOrder, topN) {
  const byAgent = new Map();
  perResultPayloads.forEach((payload, i) => {
    const result = resultOrder[i];
    const rows = Array.isArray(payload?.by_agent_top_10) ? payload.by_agent_top_10 : [];
    for (const row of rows) {
      if (!row || typeof row.agent !== 'string') continue;
      const entry = byAgent.get(row.agent) || { agent: row.agent, byResult: {}, total: 0 };
      const count = Number(row.count) || 0;
      entry.byResult[result] = count;
      entry.total += count;
      byAgent.set(row.agent, entry);
    }
  });
  return Array.from(byAgent.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, topN);
}

function sumByResultO(byResultCount) {
  let total = 0;
  for (const key of ANALYTICS_KPI_ORDER) total += byResultCount[key] || 0;
  return total;
}

// cross-analysis by_result[] 에서 단일 result 카운트 추출 (needs_context 등 비-KPI result, P2).
// 응답 미포함 result → 0 (해당 기간 0건과 동일 처리).
function extractResultCountO(byResult, result) {
  if (!Array.isArray(byResult)) return 0;
  for (const row of byResult) {
    if (row && row.result === result) return Number(row.count) || 0;
  }
  return 0;
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

// KPI 카드 sparkline — result 별 by_agent_top_10 카운트 series ("이 result 가 어느 에이전트들에 분포").
// 항목 < 2 → null (Sparkline 미렌더 가드 정합 — ui.jsx).
function buildBucketSparkMapO(perResultPayloads, resultOrder) {
  const out = {};
  perResultPayloads.forEach((payload, i) => {
    const result = resultOrder[i];
    const rows = Array.isArray(payload?.by_agent_top_10) ? payload.by_agent_top_10 : [];
    const data = rows.map((r) => Number(r?.count) || 0);
    out[result] = data.length >= 2 ? data : null;
  });
  return out;
}

window.ScreenOutcomes = ScreenOutcomes;
