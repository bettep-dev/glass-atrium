// Screen 01 — Dashboard (live data via /api/dashboard/*, /api/agents/summary, /api/outcomes/cross-analysis)
// window.ScreenDashboard.
//
// 카드 정렬:
//   1. KPI×3 (BP-KPI-Spark) — 7d sparkline
//   2. BudgetCard (BP-BudgetBar-30Day) — 30일 누계 + 일별 미니바 · auth 부재로 예산 개념 제거
//   3. CostTimeseriesCard (Recharts — monitor 고유 유지)
//   4. AgentActivity Top 5 (full-width)
//   5. OutcomeDistribution + TokenDonut (50:50)
//
// /api/agents/summary `agents[].cost` = null (cost_attribution: unavailable) — AgentBadge-Row cost 미사용.
const { useState: useStateD, useEffect: useEffectD, useRef: useRefD, useCallback: useCallbackD } = React;

// 숫자 포맷 — ui.jsx 공용 SoT 소비 (ui.js 가 dashboard.js 보다 먼저 로드 → window.UI 가용).
// 로컬 별칭 유지 — 차트 tickFormatter 등 다수 call site 식별자 보존.
const formatUsd = window.UI.formatUsd;
const formatUsdCompact = window.UI.formatUsdCompact;
const formatInt = window.UI.formatInt;
const formatTokenCompact = window.UI.formatTokenCompact;

// 서버 allowlist 정합 (routes/dashboard.ts — {7,30,90}).
const COST_PERIODS = [
  { value: 7,  label: '7d'  },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

// Token category visual order — bottom (cache_creation) → top (output) in stacked area.
// WCAG 주의: cat-2/4 light 표면 대비 3.5-3.9:1 → chart fill/swatch 한정, text 색상 금지.
const TOKEN_CATEGORIES = [
  { key: 'cache_creation_tokens', label: 'Cache write', colorVar: '--cat-1' },
  { key: 'cache_read_tokens',     label: 'Cache read',  colorVar: '--cat-2' },
  { key: 'input_tokens',          label: 'Input',       colorVar: '--cat-3' },
  { key: 'output_tokens',         label: 'Output',      colorVar: '--cat-4' },
];

// Outcome 분포 (BP-OutcomeStackedBar) — result enum 라벨/톤 = window.UI.RESULT_META SoT (A2).
// 응답 누락 result 키는 자동 0% 처리 (폭 0 으로 시각/범례 생략).
const OUTCOME_RESULT_ORDER = ['done', 'done_with_concerns', 'blocked', 'fail', 'needs_context'];
// 차트 색 토큰 — neutral(needs_context) 만 차트 전용 '--dim' 매핑 (CSS 에 '--neutral' 토큰 부재).
function outcomeColorVar(meta) {
  return meta.tone === 'neutral' ? '--dim' : `--${meta.tone}`;
}

// agents.jsx UNKNOWN_AGENT_* 와 동일 의미 (PG fallback: agent_id_missing / deprecated_agent / legacy_unknown).
// vanilla browser 환경 — agents.jsx import 불가 → _HM suffix 로 모듈 스코프 충돌 회피.
const UNKNOWN_AGENT_HM = 'unknown';
const UNKNOWN_AGENT_LABEL_HM = 'Unidentified (old)';
const UNKNOWN_AGENT_TITLE_HM =
  "Couldn't be matched to a current agent";

const INITIAL_FETCH_STATE = { status: 'loading', data: null, error: null };

// Update 컨트롤 상수 (P3-T4) — poll 간격 · stale 컷오프 · 엔드포인트.
// UPDATE_STALE_MS 는 서버 routes/dashboard.ts DEFAULT_STALE_MS(30분) 미러 — 클라 stale 판정이
//   서버 sweep 컷오프 이상이어야 retry(apply POST)가 서버 stale-sweep 을 태워 예약 row 를 회수함
//   (컷오프 미만이면 서버가 아직 in-progress 로 보아 재-apply 가 single_active 로 막힘).
const UPDATE_POLL_MS = 5000;
const UPDATE_STALE_MS = 30 * 60 * 1000;
const UPDATE_ENDPOINT = '/api/dashboard/update';
const UPDATE_JOB_ENDPOINT = '/api/dashboard/update-job';
const UPDATE_STATUS_ENDPOINT = '/api/dashboard/update-status';

function ScreenDashboard({ onNav }) {
  const { Icon, PageHeader, TypeScaleStyle, Badge } = window.UI;

  const [kpiState,      setKpiState]      = useStateD(INITIAL_FETCH_STATE);
  const [costState,     setCostState]     = useStateD(INITIAL_FETCH_STATE);
  const [cost7State,    setCost7State]    = useStateD(INITIAL_FETCH_STATE);
  const [cost30State,   setCost30State]   = useStateD(INITIAL_FETCH_STATE);
  const [todayTokState, setTodayTokState] = useStateD(INITIAL_FETCH_STATE);
  const [agentsState,   setAgentsState]   = useStateD(INITIAL_FETCH_STATE);
  const [outcomesState, setOutcomesState] = useStateD(INITIAL_FETCH_STATE);
  // E2 update-availability(T07) — 메인 fetch wave 합류 → Refresh 시 함께 재확인.
  const [updateState,    setUpdateState]    = useStateD(INITIAL_FETCH_STATE);
  // P3-T4 update-job poll — 단일 apply 후 in-progress/failed/completed 진행 상태 구동.
  const [updateJobState, setUpdateJobState] = useStateD(INITIAL_FETCH_STATE);

  const [costDays,    setCostDays]    = useStateD(7);
  const [refreshTick, setRefreshTick] = useStateD(0);

  // AbortController per fetch wave — unmount/refetch 시 in-flight 요청 취소.
  const abortRef = useRefD(null);

  const triggerRefresh = useCallbackD(() => setRefreshTick((t) => t + 1), []);

  // update-job / update-status 온디맨드 재조회 — UpdateBadge 의 poll interval + mutate 직후 즉시 상태 반영에 사용.
  //   메인 wave 와 독립(단건 GET, signal 불요 — AbortError 는 handleError 가 흡수).
  const refetchUpdateJob = useCallbackD(() => runFetch(UPDATE_JOB_ENDPOINT, undefined, setUpdateJobState), []);
  // up_to_date apply 응답 후 availability 재확인 → resting 'current'(green) 로 해소.
  const refetchUpdateStatus = useCallbackD(() => runFetch(UPDATE_STATUS_ENDPOINT, undefined, setUpdateState), []);

  useEffectD(() => {
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;

    const setters = [
      setKpiState, setCostState, setCost7State, setCost30State,
      setTodayTokState, setAgentsState, setOutcomesState, setUpdateState, setUpdateJobState,
    ];
    setters.forEach((s) => s(INITIAL_FETCH_STATE));

    // Donut 은 days=7 응답의 마지막 point (=오늘) 재사용 — 서버 allowlist {7,30,90} 가 days=1 미허용.
    const tasks = [
      runFetch('/api/dashboard/kpi', ctrl.signal, setKpiState),
      runFetch(`/api/dashboard/cost-timeseries?days=${costDays}`, ctrl.signal, setCostState),
      runFetch('/api/dashboard/cost-timeseries?days=7', ctrl.signal, setCost7State),
      runFetch('/api/dashboard/cost-timeseries?days=30', ctrl.signal, setCost30State),
      runFetch('/api/dashboard/cost-timeseries?days=7', ctrl.signal, setTodayTokState),
      runFetch('/api/agents/summary?days=7&order=runs&limit=5', ctrl.signal, setAgentsState),
      runFetch('/api/outcomes/cross-analysis?days=7', ctrl.signal, setOutcomesState),
      runFetch(UPDATE_STATUS_ENDPOINT, ctrl.signal, setUpdateState),
      runFetch(UPDATE_JOB_ENDPOINT, ctrl.signal, setUpdateJobState),
    ];

    Promise.allSettled(tasks);

    return () => ctrl.abort();
  }, [costDays, refreshTick]);

  // 화면 전반 worst-severity rollup (T-DSH-2) — outcome 장애율 기반, enum SoT 톤만.
  const rollupTone = computeWorstRollup({ outcomesState });

  return (
    <div className="flex flex-col">
      {/* 타입 스케일 토큰 (ui.jsx SoT) — 멱등 마운트. .fs-* 유틸 + --fs-* CSS var 공급 (clauded-docs 와 동일 idiom). */}
      <TypeScaleStyle/>
      <style>{`
        @keyframes skelPulse { 0%,100%{opacity:.7} 50%{opacity:.35} }
        /* update 진행/전송 스피너 — reduced-motion 은 회전 정지(정적 아이콘 + Badge/라벨이 상태 운반). */
        @keyframes ga-spin { to { transform: rotate(360deg); } }
        .ga-spin { animation: ga-spin 0.9s linear infinite; transform-origin: center; }
        @media (prefers-reduced-motion: reduce) { .ga-spin { animation: none; } }
        .budget-bar { display: block; }
        /* 레이아웃 안정 — 축소 시 줄바꿈에 의한 행/카드 높이 변동 제거.
           1행 텍스트 = clamp 1줄 + reserved min-height → 1↔2줄 전환에도 높이 불변. 잘린 전체값은 title= 보존. */
        /* 에이전트/데몬 행 1차 라벨 — 1줄 clamp + meta 행과 합산 행 높이 고정. */
        .dash-clamp-1 { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; word-break: break-all; }
        /* 1줄 라벨 슬롯 — body 토큰(12px) × line-height 1.4 = 약 17px 예약. */
        .dash-row-label { min-height: calc(var(--fs-body) * 1.4); line-height: 1.4; }
        /* 2차 meta 라인 — meta 토큰(11px) × 1.4 예약 (mono 수치 줄바꿈 차단). */
        .dash-row-meta { min-height: calc(var(--fs-meta) * 1.4); line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        /* 에러 배너 제목/상세 — 1줄 clamp + ellipsis (banner 높이 가변 폭에서 불변). */
        .dash-banner-title { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; min-height: calc(var(--fs-body) * 1.4); line-height: 1.4; }
        /* 예산 미니바 hover 캡션 — opacity 토글이라 공간은 항상 점유(reserved). 높이 변동 없음 보강용 nowrap. */
        .dash-bar-hovercap { white-space: nowrap; }
        /* 차트 합계 라벨 — items-start 정렬 시 'Period total' 2줄 줄바꿈에도 값 행 정렬 유지(2줄 슬롯 예약). */
        .dash-stat-label { min-height: calc(var(--fs-meta) * 1.4 * 2); line-height: 1.4; }
      `}</style>
      <div className="flex-shrink-0">
        <PageHeader
          sub="Usage & cost overview"
          title="Dashboard"
          right={
            <>
              {/* self-update 통지 — 구 full-width 카드에서 toolbar 컴팩트 배지로 이관. 자기-숨김(hidden→null)이라 무조건 마운트. */}
              <UpdateBadge
                availabilityState={updateState}
                jobState={updateJobState}
                onRefetchJob={refetchUpdateJob}
                onRefetchStatus={refetchUpdateStatus}
              />
              {/* 단일 worst-severity rollup (T-DSH-2) — status Badge 가 TONE_ICON Lucide 선행(색+기호). 로딩 중엔 미렌더. */}
              {rollupTone && (
                <Badge role="status" tone={rollupTone} icon>{ROLLUP_LABEL[rollupTone] || 'Status'}</Badge>
              )}
              <button className="btn ghost sm" onClick={triggerRefresh} aria-label="Refresh dashboard">
                <Icon name="refresh" size={14}/>
                Refresh
              </button>
            </>
          }
        />
      </div>

      {/* 섹션 채널 24px(.space-sections) — 카드 그룹 사이를 16px 카드 채널보다 한 단 넓게 분리(W1-T3).
          헤더→콘텐츠 간격은 PageHeader 내부 mb-4(16px) 단독 — agents/outcomes 등 정상 화면과 동일(앱 셸 p-6 미변경). */}
      <div className="space-sections">
        <KpiRow
          kpiState={kpiState}
          cost7State={cost7State}
          onNav={onNav}
          onRetry={triggerRefresh}
        />

        <BudgetCard
          cost30State={cost30State}
          onNav={onNav}
          onRetry={triggerRefresh}
        />

        <CostTimeseriesCard
          state={costState}
          days={costDays}
          onChangeDays={setCostDays}
          onNav={onNav}
          onRetry={triggerRefresh}
        />

        <AgentActivityCard
          state={agentsState}
          onNav={onNav}
          onRetry={triggerRefresh}
        />

        <div className="grid grid-cols-2 gap-card">
          <OutcomeDistributionCard
            state={outcomesState}
            onNav={onNav}
            onRetry={triggerRefresh}
          />
          <TokenDonutCard
            state={todayTokState}
            onNav={onNav}
            onRetry={triggerRefresh}
          />
        </div>
      </div>
    </div>
  );
}

// 0. Update control — self-update 통지를 toolbar 컴팩트 3-state 배지로 렌더(구 full-width 카드 대체).
//   단일 원자적 apply: yellow "Update available <target>"(클릭) → updating(spinner) → green "✓ <version>"(persistent
//   resting). availability(/api/dashboard/update-status) + update-job(/api/dashboard/update-job) poll 로 구동 ·
//   {mode:'apply'} POST 계약과 job poll 은 불변. 4상태가 모양(window.UI.Badge) 공유 — tone/선행 아이콘/텍스트/상호작용만
//   상태별로 바뀐다(색 단독 신호 아님: 선행 Icon 이 shape+color dual-encode). heartbeat 초과 in-progress 는 stalled →
//   failed(crit, 클릭=재시도)로 degrade(영구 spinner 금지). 非actionable verdict(unknown/source-dev) + 무 job → null(무신호).
function UpdateBadge({ availabilityState, jobState, onRefetchJob, onRefetchStatus }) {
  const { Icon, Badge } = window.UI;
  const [phase,       setPhase]       = useStateD('idle');  // idle | working (apply POST 전송 중, 낙관적 updating)
  const [actionError, setActionError] = useStateD(null);    // { message, canRetry } | null (mutation 오류 → failed)

  // job 은 poll 이 ready 이고 실제 row 가 있을 때만(none 은 무 job).
  const job = (jobState.status === 'ready' && jobState.data && jobState.data.status !== 'none')
    ? jobState.data
    : null;

  const view = deriveUpdateView({
    availabilityStatus: availabilityState.status,
    availabilityData: availabilityState.data,
    job,
    phase,
    actionError,
    now: Date.now(),
    staleMs: UPDATE_STALE_MS,
  });

  // updating 뷰에서만 poll — completed/failed/current 전이 시 interval 해제(무한 spinner + 무의미 poll 차단).
  //   poll 은 부모 jobState 갱신 → 재렌더 → now 전진 → stale(→failed) 판정.
  const isPolling = view.kind === 'updating';
  useEffectD(() => {
    if (!isPolling) return undefined;
    const timer = setInterval(() => onRefetchJob(), UPDATE_POLL_MS);
    return () => clearInterval(timer);
  }, [isPolling, onRefetchJob]);

  // 단일 원자적 apply — 즉시 적용. enqueued 면 job poll 인계, up_to_date 면 availability 재확인(green resting),
  //   single_active(409) 면 live job 노출로 인계, 그 외 오류는 crit failed 배지(클릭=재-apply).
  const startApply = useCallbackD(async () => {
    setActionError(null);
    setPhase('working');

    const res = await postUpdate({ mode: 'apply' });
    setPhase('idle'); // 낙관적 working 종료 — 이후 분기가 failed/current/job-poll 로 인계.

    if (!res.ok) {
      // 409 single_active — 이미 예약된 update 존재 → error 대신 live job 노출로 인계.
      if (res.status === 409 && res.data && res.data.error === 'single_active') {
        onRefetchJob();
        return;
      }
      setActionError({ message: mutationErrorMessage(res.status, res.data), canRetry: true });
      return;
    }
    if (res.data && res.data.status === 'up_to_date') {
      onRefetchStatus();
      return;
    }
    // status:'enqueued' — decoupled job 기동. poll 로 진행상태 인계.
    onRefetchJob();
  }, [onRefetchJob, onRefetchStatus]);

  if (view.kind === 'hidden') return null;

  const availabilityData = availabilityState.data;
  const isAlert = view.kind === 'failed';

  let cluster;
  switch (view.kind) {
    // available — yellow(warn) 클릭 배지. 타깃 버전만 표기(e.g. "Update available 1.0.1", "1.0.0 → 1.0.1" 아님). 클릭=startApply.
    case 'available': {
      const latest = (availabilityData && availabilityData.latest_version) || 'latest';
      cluster = (
        <Badge role="status" tone="warn" icon interactive title={`Update to ${latest}`} onClick={startApply}>
          Update available {latest}
        </Badge>
      );
      break;
    }
    // updating — spinner(모양+motion=tone carrier)를 pill 내부 leading glyph 로 배치. 다른 state 와 동일하게 심볼이 배지 안에 들어감. 非클릭(span → 내재적 비활성).
    case 'updating': {
      const target = job && job.target_version;
      cluster = (
        <Badge role="status" tone="neutral" glyph={false}>
          <Icon name="refresh" size={11} className="text-info ga-spin"/> {target ? `Updating ${target}` : 'Updating'}
        </Badge>
      );
      break;
    }
    // current — green(ok) persistent resting 배지. 인접 "All clear" 와 동일 idiom(check icon + --dim 버전 라벨).
    //   completed job → target_version, 그 외(availability current) → local_version. ✓ 는 icon=true 가 그림(리터럴 금지).
    case 'current': {
      const version = (job && job.status === 'completed' && job.target_version)
        || (availabilityData && availabilityData.local_version)
        || '';
      cluster = <Badge role="status" tone="ok" icon>{version}</Badge>;
      break;
    }
    // failed — crit 클릭 배지(재시도). actionError / job failed / stalled in-progress 를 하나로 접음. dead-end 아님.
    case 'failed':
      cluster = (
        <Badge role="status" tone="crit" icon interactive title="Retry update" onClick={startApply}>
          Update failed
        </Badge>
      );
      break;
    default:
      return null;
  }

  // 아이콘은 aria-hidden(Badge 기본) → 라벨 텍스트를 aria-live 래퍼가 안내(updating→current 전이 통지, Badge 자체 DOM role 없음).
  //   failed = role=alert(assertive), 그 외 = role=status(polite). 래퍼 inline-flex 는 updating 의 spinner+배지 클러스터 정렬.
  return (
    <span
      role={isAlert ? 'alert' : 'status'}
      aria-live={isAlert ? 'assertive' : 'polite'}
      className="inline-flex items-center gap-1.5">
      {cluster}
    </span>
  );
}

// UpdateBadge 상태 머신(순수) — 5 kind: hidden | available | updating | current | failed.
//   우선순위: actionError → failed · working phase → updating(낙관적) · job poll(completed→current sticky /
//   failed→failed / in-progress→ age>staleMs 면 failed[stalled] 아니면 updating) · availability
//   (update-available→available / current→current[resting]) · else hidden. completed 는 age 게이트 없이
//   sticky(green 유지) — job 이 availability 보다 우선이라 stale 한 update-available 로 되돌아가지 않는다.
function deriveUpdateView(args) {
  const { availabilityStatus, availabilityData, job, phase, actionError, now, staleMs } = args;

  if (actionError) return { kind: 'failed' };
  if (phase === 'working') return { kind: 'updating' };

  // job poll 소비 — completed 는 sticky(무 age 게이트), stalled in-progress 는 failed 로 degrade.
  if (job) {
    if (job.status === 'completed') return { kind: 'current' };
    if (job.status === 'failed') return { kind: 'failed' };
    if (job.status === 'in-progress') {
      const heartbeat = Date.parse(job.heartbeat_at);
      const age = Number.isNaN(heartbeat) ? Infinity : now - heartbeat;
      return { kind: age > staleMs ? 'failed' : 'updating' };
    }
  }

  if (availabilityStatus === 'ready' && availabilityData) {
    if (availabilityData.status === 'update-available') return { kind: 'available' };
    if (availabilityData.status === 'current') return { kind: 'current' };
  }
  return { kind: 'hidden' };
}

// POST /api/dashboard/update — JSON body(mode: 'apply'). { ok, status, data } 정규화(네트워크
//   실패도 typed shape 로 흡수).
async function postUpdate(body) {
  try {
    const res = await fetch(UPDATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: 'network', reason: err && err.message ? err.message : String(err) } };
  }
}

// 서버 error taxonomy → 사용자 문구(types/dashboard.ts UpdateMutationErrorBody 미러).
function mutationErrorMessage(status, data) {
  const code = data && data.error;
  const reason = data && data.reason;
  if (code === 'single_active')    return 'Another update is already in progress.';
  if (code === 'claude_unresolved') return "The updater couldn't find the tool it needs on this host.";
  if (code === 'enqueue_failed')   return "Couldn't start the update job.";
  if (code === 'preview_failed')   return reason ? `Update check failed: ${reason}` : 'Update check failed.';
  if (code === 'network')          return reason ? `Network error: ${reason}` : 'Network error.';
  if (reason)                      return String(reason);
  return `Request failed (HTTP ${status}).`;
}

// 1. KPI row (BP-KPI-Spark × 3)
function KpiRow({ kpiState, cost7State, onNav, onRetry }) {
  const { KPI } = window.UI;

  if (kpiState.status === 'loading') {
    return (
      <div className="grid grid-cols-3 gap-card" aria-busy="true" aria-label="Loading KPIs">
        {Array.from({ length: 3 }).map((_, i) => <KpiSkeleton key={i}/>)}
      </div>
    );
  }
  if (kpiState.status === 'error') {
    return <ErrorBanner title="Couldn't load KPI data" detail={kpiState.error} onRetry={onRetry}/>;
  }

  const k = kpiState.data;
  // delta 기준 = 어제 동시각 누계(yesterday_same_time_*) — 아침 판독이 어제 '전일
  // 전체'와 비교되는 왜곡 차단 (F10). 필드 부재(legacy payload) → 전일 전체 fallback
  // + 기준 라벨 동기 전환 (기준 미스라벨 금지).
  const hasSameTimeCut  = k.yesterday_same_time_cost_usd != null && k.yesterday_same_time_session_count != null;
  const costBasis       = hasSameTimeCut ? k.yesterday_same_time_cost_usd : k.yesterday_cost_usd;
  const sessionBasis    = hasSameTimeCut ? k.yesterday_same_time_session_count : k.yesterday_session_count;
  const deltaBasisLabel = hasSameTimeCut ? 'vs same time yesterday' : 'vs yesterday';
  const costDelta    = computeDeltaPct(k.today_cost_usd, costBasis);
  // 비용 KPI 와 동일 delta helper/듀얼인코딩 대칭 적용.
  const sessionDelta = computeDeltaPct(k.today_session_count, sessionBasis);
  // 기준 0 → delta 미표시 + '신규' 마커 (가짜 +100% 금지, F10).
  const costIsNew    = costBasis === 0 && k.today_cost_usd > 0;
  const sessionIsNew = sessionBasis === 0 && k.today_session_count > 0;

  // cost7State 가 ready 일 때만 spark 시리즈 주입 (실패/로딩 시 KPI 본문은 그대로 표시).
  const cost7Points = cost7State.status === 'ready' ? cost7State.data.points : null;
  const costSpark    = cost7Points ? cost7Points.map((p) => Number(p.cost_usd) || 0) : null;
  const sessionSpark = cost7Points ? cost7Points.map((p) => Number(p.session_count) || 0) : null;

  // last_etl_at = 진짜 UTC 순간 → 공용 KST 포매터. ETL 스탬프는 cost_events 를 설명 → 비용 KPI 에 귀속 (F01, F05).
  const etlSuffix = k.last_etl_at ? ` · ETL ${window.UI.formatKstDateTime(k.last_etl_at)}` : '';
  const breakageCount = (Number(k.fail_count_24h) || 0) + (Number(k.blocked_count_24h) || 0);
  const tz = window.UI.tzShortLabel();

  return (
    <div className="grid grid-cols-3 gap-card">
      <KPI
        label="Cost today"
        value={formatUsd(k.today_cost_usd)}
        delta={costDelta}
        deltaInverse={true}
        hint={<>{tz} day{costDelta != null && ` · ${deltaBasisLabel}`}{etlSuffix}{costIsNew && <span className="text-info"> · new</span>}</>}
        sparkData={costSpark}
        sparkColor="rgb(var(--crit))"
        onClick={() => onNav('cost')}
      />
      <KPI
        label="Sessions today"
        value={formatInt(k.today_session_count)}
        delta={sessionDelta}
        hint={<>{tz} day{sessionDelta != null && ` · ${deltaBasisLabel}`}{sessionIsNew && <span className="text-info"> · new</span>}</>}
        sparkData={sessionSpark}
        sparkColor="rgb(var(--accent))"
        onClick={() => onNav('cost')}
      />
      {/* 단일 스칼라(24h 윈도우) → sparkline 부적합. blocked 는 실패 아님 → info 톤 분리 표기 (F05/A2). */}
      <KPI
        label="Failures (24 h)"
        value={formatInt(breakageCount)}
        hint={<>Failed {formatInt(k.fail_count_24h)} · <span className="text-info">Blocked {formatInt(k.blocked_count_24h)}</span></>}
        onClick={() => onNav('outcomes')}
      />
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="kpi" style={{ pointerEvents: 'none' }}>
      <div className="kpi-label"><Skel w={80} h={11}/></div>
      <div className="kpi-value" style={{ marginTop: 10 }}><Skel w={120} h={26}/></div>
    </div>
  );
}

// CardHead 우측 'detail 화면 이동' 버튼 idiom 통합 — 5개 카드가 'btn sm' + trailing arrow-right(14) 를 반복하던 것을 단일 출처로.
// arrow 는 불변 → 모듈 상수로 hoist: poll 재렌더마다 Icon 카탈로그 재조회 + 자식 SVG 재할당 없이 참조 안정(동일 element ref → React subtree bailout).
const CARD_NAV_ARROW = <window.UI.Icon name="arrow-right" size={14}/>;

// label 지정 시 텍스트+arrow, 생략 시 아이콘 전용(시각 라벨 부재 → ariaLabel 필수).
function CardNavButton({ onNav, target, label, ariaLabel }) {
  return (
    <button className="btn sm" onClick={() => onNav(target)} aria-label={ariaLabel}>
      {label && `${label} `}
      {CARD_NAV_ARROW}
    </button>
  );
}

// 2. BudgetCard (BP-BudgetBar-30Day) — 30일 누계 비용 + 일별 미니바 (오늘 bg-crit).
// 예산/소진율 시각화 없음 (auth/billing 부재 → 무의미 수치 금지).
function BudgetCard({ cost30State, onNav, onRetry }) {
  const { CardHead } = window.UI;

  return (
    <div className="card budget-bar">
      <CardHead
        title="Cost, last 30 days"
        right={<CardNavButton onNav={onNav} target="cost" label="Details"/>}
      />
      <div className="card-body">
        <BudgetBody cost30State={cost30State} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function BudgetBody({ cost30State, onRetry }) {
  if (cost30State.status === 'loading') {
    return <ChartSkeleton height={120} aria-label="Loading cost data"/>;
  }
  if (cost30State.status === 'error') {
    return <ErrorBanner title="Couldn't load cost data" detail={cost30State.error} onRetry={onRetry}/>;
  }
  const points = cost30State.data.points || [];
  if (points.length === 0) {
    return <EmptyState message="No cost events."/>;
  }

  const spent = sumCost(points);
  const todayIdx = points.length - 1;
  const maxDailyCost = points.reduce((m, p) => Math.max(m, Number(p.cost_usd) || 0), 0) || 1;

  return (
    <div>
      <div className="flex items-baseline gap-3 mb-3">
        {/* 카드 지배 hero 수치 → display 토큰(22px) — 기존 28px ad-hoc 흡수 (screen 간 hero 크기 통일). */}
        <div className="fs-display font-mono font-semibold tracking-tight">{formatUsd(spent)}</div>
        <div className="fs-title text-dim font-mono">30-day total</div>
      </div>
      <div
        className="grid grid-cols-30 gap-[3px] mt-4"
        role="list"
        aria-label="Daily cost mini bars, last 30 days">
        {points.map((p, i) => {
          const cost = Number(p.cost_usd) || 0;
          const h = (cost / maxDailyCost) * 100;
          const isToday = i === todayIdx;
          const tooltip = `${p.date} · ${formatUsd(cost)}`;
          return (
            <div key={p.date} className="flex flex-col items-center group relative" role="listitem">
              {/* hover 캡션 — opacity 토글(공간 항상 점유)이라 hover 시 행 높이 불변. micro 토큰 매핑(9→10px). */}
              <div className="fs-micro font-mono text-faint mb-1 opacity-0 group-hover:opacity-100 dash-bar-hovercap">
                {formatUsdCompact(cost)}
              </div>
              <div className="w-full bg-sunken rounded-sm relative" style={{ height: 48 }}>
                <div
                  className={`absolute bottom-0 left-0 right-0 rounded-sm ${isToday ? 'bg-crit' : 'bg-ink/70'}`}
                  style={{ height: `${Math.max(h, 2)}%` }}
                  title={tooltip}
                />
              </div>
              <div className="fs-micro font-mono text-faint mt-1">{p.date.slice(-2)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Agent Activity Top 5 (BP-AgentBadge-Row) — cost 미사용 (runs / success_pct / status 만 의존).
function AgentActivityCard({ state, onNav, onRetry }) {
  const { CardHead } = window.UI;
  const subText = subStatusText(state, () => `${state.data.meta.total_agents} active`);

  return (
    <div className="card">
      <CardHead
        title="Agent status"
        sub={subText}
        right={<CardNavButton onNav={onNav} target="agents" ariaLabel="Open agent status details"/>}
      />
      <div className="card-body flush">
        <AgentActivityBody state={state} onNav={onNav} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function AgentActivityBody({ state, onNav, onRetry }) {
  const { AgentBadge, StatusDot } = window.UI;

  if (state.status === 'loading') {
    return (
      <div aria-busy="true" aria-label="Loading agents" style={{ padding: 14 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} style={ROW_SKELETON_STYLE}>
            <Skel w={22} h={22} style={{ borderRadius: 7 }}/>
            <div style={{ flex: 1 }}>
              <Skel w="60%" h={12}/>
              <div style={{ marginTop: 6 }}><Skel w="40%" h={10}/></div>
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (state.status === 'error') {
    return <div style={{ padding: 16 }}><ErrorBanner title="Couldn't load agent status" detail={state.error} onRetry={onRetry}/></div>;
  }
  const agents = state.data.agents || [];
  if (agents.length === 0) {
    // 카드 card-body 는 flush(populated 리스트의 full-width divider 용) → empty 브랜치만 별도 패딩으로
    // 'Task results' 레퍼런스(card-body 기본 20px)와 간격 일치. populated 리스트는 flush 유지.
    return <div style={{ padding: 20 }}><EmptyState message="No agents ran in the last 7 days."/></div>;
  }
  // 서버 limit=5 요청이지만 방어적 슬라이스 보강.
  const top5 = agents.slice(0, 5);

  return (
    <>
      {top5.map((a) => {
        const isUnknownAgent = a.agent_id === UNKNOWN_AGENT_HM;
        const displayName = isUnknownAgent ? UNKNOWN_AGENT_LABEL_HM : a.agent_name;
        const tooltip = isUnknownAgent ? UNKNOWN_AGENT_TITLE_HM : undefined;
        // 성공률 분모 = needs_context 제외 (matrix 의미론, F21) — 'N=' 병기 + n<30 muted/italic (A5).
        const successDen = Math.max(0, (Number(a.runs) || 0) - (Number(a.needs_context_count) || 0));
        const isLowSample = successDen < window.UI.LOW_N_MIN;
        return (
          <div
            key={a.agent_id}
            className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-sunken cursor-pointer"
            role="button"
            tabIndex={0}
            onClick={() => onNav('agents')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNav('agents'); } }}
            aria-label={`Open ${displayName} agent details`}
            title={tooltip}
            style={isUnknownAgent ? { opacity: 0.7 } : undefined}>
            <AgentBadge a={{ id: a.agent_id, name: a.agent_name }} size={22}/>
            <div className="flex-1 min-w-0">
              {/* 행 안정 — 라벨 1줄 clamp + reserved 높이, meta 1줄 nowrap → 축소 시 행 높이 불변. */}
              <div className="fs-body font-medium dash-clamp-1 dash-row-label" title={displayName}>{displayName}</div>
              {/* 메타 라인 = --dim sans 산문; mono 는 수치 토큰(runs / 성공률)에만 — 라벨 전체를 mono 로 두면 산문이 좁아 보임. */}
              <div
                className="fs-meta text-dim dash-row-meta"
                style={isLowSample ? { fontStyle: 'italic', opacity: 0.75 } : undefined}
                title={`${formatInt(a.runs)} runs · ${successDen > 0 ? `${a.success_pct.toFixed(1)}% (N=${successDen})` : '—'}${isLowSample ? ` · low sample (n<${window.UI.LOW_N_MIN})` : ''}`}>
                <span className="font-mono">{formatInt(a.runs)}</span> runs · {successDen > 0 ? <><span className="font-mono">{a.success_pct.toFixed(1)}%</span> (N={successDen})</> : '—'}
              </div>
            </div>
            <StatusDot status={mapAgentStatus(a.status)}/>
          </div>
        );
      })}
    </>
  );
}

// 4a. Outcome Distribution Stacked Bar (BP-OutcomeStackedBar)
function OutcomeDistributionCard({ state, onNav, onRetry }) {
  const { CardHead } = window.UI;
  const subText = subStatusText(state, () => `Last 7 days · ${formatInt(state.data.total)} total`);

  return (
    <div className="card">
      <CardHead
        title="Task results"
        sub={subText}
        right={<CardNavButton onNav={onNav} target="outcomes" label="Analyze"/>}
      />
      <div className="card-body">
        <OutcomeDistributionBody state={state} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function OutcomeDistributionBody({ state, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeleton height={140} aria-label="Loading task results"/>;
  }
  if (state.status === 'error') {
    return <ErrorBanner title="Couldn't load task results" detail={state.error} onRetry={onRetry}/>;
  }
  const total = Number(state.data.total) || 0;
  if (total === 0) {
    return <EmptyState message="No task results."/>;
  }

  // OUTCOME_RESULT_ORDER 순서 매핑 — 응답 누락 키는 count=0 (시각/범례 생략).
  const byResultMap = new Map((state.data.by_result || []).map((r) => [r.result, r.count]));
  const buckets = OUTCOME_RESULT_ORDER
    .map((key) => {
      const meta = window.UI.RESULT_META[key];
      const count = byResultMap.get(key) || 0;
      return {
        key,
        label: meta.label,
        colorVar: outcomeColorVar(meta),
        count,
        pct: total > 0 ? count / total : 0,
      };
    })
    .filter((b) => b.count > 0);

  const emptyHint = computeOutcomeHint(byResultMap, total);

  return (
    <div>
      <div className="flex h-7 rounded-md overflow-hidden border border-line mb-3">
        {buckets.map((b) => (
          <div
            key={b.key}
            style={{
              width: `${b.pct * 100}%`,
              background: `rgb(var(${b.colorVar}))`,
            }}
            title={`${b.label}: ${formatInt(b.count)} (${(b.pct * 100).toFixed(1)}%)`}
            aria-label={`${b.label}: ${formatInt(b.count)}`}/>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {buckets.map((b) => (
          <div key={b.key} className="flex items-center gap-2 fs-body">
            <span
              className="w-2.5 h-2.5 rounded-sm"
              style={{ background: `rgb(var(${b.colorVar}))` }}/>
            <span className="flex-1 truncate" title={b.label}>{b.label}</span>
            {/* 분모 공개 'N.N% (x/y)' — bare % 금지 (A5). */}
            <span className="font-mono text-dim">{window.UI.formatPctWithDenominator(b.count, total)}</span>
          </div>
        ))}
      </div>
      {emptyHint && (
        <div className="mt-4 p-3 bg-sunken rounded-md fs-body text-dim">
          <span className={`text-${emptyHint.tone} font-medium`}>{emptyHint.text}</span>
        </div>
      )}
    </div>
  );
}

// 4b. Token Composition Donut (BP-DonutChart 140×140 inline SVG arc)
function TokenDonutCard({ state, onNav, onRetry }) {
  const { CardHead } = window.UI;
  // 도넛 = days=7 응답의 마지막 (=오늘) point 1개 (서버 allowlist {7,30,90} 가 days=1 미허용).
  const todayPoint = state.status === 'ready' && state.data.points.length > 0
    ? state.data.points[state.data.points.length - 1]
    : null;
  const totalTokens = todayPoint ? sumTokens(todayPoint) : 0;

  let subText;
  if (todayPoint) {
    subText = `Today · ${formatTokenCompact(totalTokens)} tokens`;
  } else if (state.status === 'loading') {
    subText = 'Loading…';
  } else {
    subText = 'No data';
  }

  return (
    <div className="card">
      <CardHead
        title="Token usage mix"
        sub={subText}
        right={<CardNavButton onNav={onNav} target="cost" label="Breakdown"/>}
      />
      <div className="card-body">
        <TokenDonutBody state={state} todayPoint={todayPoint} totalTokens={totalTokens} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function TokenDonutBody({ state, todayPoint, totalTokens, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeleton height={160} aria-label="Loading token donut"/>;
  }
  if (state.status === 'error') {
    return <ErrorBanner title="Couldn't load token data" detail={state.error} onRetry={onRetry}/>;
  }
  if (!todayPoint || totalTokens === 0) {
    return <EmptyState message="No token usage recorded today."/>;
  }

  const segments = TOKEN_CATEGORIES
    .map((cat) => ({
      key: cat.key,
      label: cat.label,
      colorVar: cat.colorVar,
      value: Number(todayPoint[cat.key]) || 0,
    }))
    .filter((s) => s.value > 0);

  return (
    <DonutChart
      segments={segments}
      total={totalTokens}
      centerPrimary={formatTokenCompact(totalTokens)}
      centerSecondary={todayPoint.date.slice(2)}
    />
  );
}

// 시안 BP-DonutChart 1:1 — 140×140 viewBox · r=56 · sw=18 · arc path (M/A) 누적각도.
// segments[].colorVar 는 token 변수 이름 (예: '--cat-1') → strokeColor 로 변환.
function DonutChart({ segments, total, centerPrimary, centerSecondary }) {
  const r = 56, cx = 70, cy = 70, sw = 18;
  let cum = 0;

  return (
    <div className="flex items-center gap-5">
      <svg width="140" height="140" viewBox="0 0 140 140" aria-label="Token mix donut">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgb(var(--sunken))" strokeWidth={sw}/>
        {segments.map((seg) => {
          const frac = seg.value / total;
          const start = cum * Math.PI * 2 - Math.PI / 2;
          cum += frac;
          const end = cum * Math.PI * 2 - Math.PI / 2;
          const x1 = cx + Math.cos(start) * r;
          const y1 = cy + Math.sin(start) * r;
          const x2 = cx + Math.cos(end) * r;
          const y2 = cy + Math.sin(end) * r;
          const large = frac > 0.5 ? 1 : 0;
          // frac=1 (단일 세그먼트 100%) → start=end → arc 가 0 길이 → 시각 누락. 분기 처리.
          if (frac >= 0.999) {
            return (
              <circle
                key={seg.key}
                cx={cx} cy={cy} r={r}
                fill="none"
                stroke={`rgb(var(${seg.colorVar}))`}
                strokeWidth={sw}
              />
            );
          }
          return (
            <path
              key={seg.key}
              d={`M${x1.toFixed(3)},${y1.toFixed(3)} A${r},${r} 0 ${large} 1 ${x2.toFixed(3)},${y2.toFixed(3)}`}
              fill="none"
              stroke={`rgb(var(${seg.colorVar}))`}
              strokeWidth={sw}
            />
          );
        })}
        <text x={cx} y={cy - 2} textAnchor="middle" className="font-mono"
          style={{ fontSize: 'var(--fs-title)', fill: 'rgb(var(--ink))' }}>
          {centerPrimary}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle"
          style={{ fontSize: 'var(--fs-micro)', fill: 'rgb(var(--dim))' }}>
          {centerSecondary}
        </text>
      </svg>
      <div className="flex-1 space-y-1.5">
        {segments.map((seg) => (
          <div key={seg.key} className="flex items-center gap-2 fs-body">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: `rgb(var(${seg.colorVar}))` }}/>
            <span className="flex-1 truncate" title={seg.label}>{seg.label}</span>
            <span className="font-mono text-dim">{((seg.value / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 5a. CostTimeseriesCard (monitor 고유 유지 — Recharts AreaChart)
function CostTimeseriesCard({ state, days, onChangeDays, onNav, onRetry }) {
  const { CardHead } = window.UI;

  return (
    <div className="card">
      <CardHead
        title="Token usage over time"
        right={
          <>
            <div className="seg">
              {COST_PERIODS.map((p) => (
                <button
                  key={p.value}
                  className={days === p.value ? 'active' : ''}
                  onClick={() => onChangeDays(p.value)}>
                  {p.label}
                </button>
              ))}
            </div>
            <CardNavButton onNav={onNav} target="cost" label="Breakdown"/>
          </>
        }
      />
      <div className="card-body">
        <CostChartBody state={state} days={days} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function CostChartBody({ state, days, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeleton height={260} aria-label="Loading token trend chart"/>;
  }
  if (state.status === 'error') {
    return <ErrorBanner title="Couldn't load token trend data" detail={state.error} onRetry={onRetry}/>;
  }
  const points = state.data.points;
  if (!points || points.length === 0) {
    return <EmptyState message={`No cost events in the last ${days} days.`}/>;
  }

  const totalCost     = points.reduce((s, p) => s + (Number(p.cost_usd) || 0), 0);
  const totalSessions = points.reduce((s, p) => s + (Number(p.session_count) || 0), 0);
  const totalTokens   = points.reduce((s, p) => s + sumTokens(p), 0);

  return (
    <>
      {/* 세 수치 동일 크기(display 토큰 22px) — 위계는 강조(기간 합계=semibold·기본색 / 세션·토큰=text-dim)로만 표현 → 상단 정렬(라벨 슬롯 2줄 예약 — 줄바꿈 시 값 행 정렬 유지).
          기존 20px ad-hoc → display 흡수 (카드 지배 hero · screen 간 크기 통일). 라벨은 meta 토큰 매핑. */}
      <div className="flex items-start gap-4 mb-3">
        <div>
          <div className="fs-meta text-dim dash-stat-label">Period total</div>
          <div className="font-mono fs-display font-semibold tracking-tight">{formatUsd(totalCost)}</div>
        </div>
        <div>
          <div className="fs-meta text-dim dash-stat-label">Sessions</div>
          <div className="font-mono fs-display text-dim tracking-tight">{formatInt(totalSessions)}</div>
        </div>
        <div>
          <div className="fs-meta text-dim dash-stat-label">Tokens</div>
          <div className="font-mono fs-display text-dim tracking-tight">{formatTokenCompact(totalTokens)}</div>
        </div>
      </div>
      <CostStackedArea points={points}/>
      <div className="flex items-center gap-4 mt-3 flex-wrap">
        {TOKEN_CATEGORIES.map((cat) => (
          <div key={cat.key} className="flex items-center gap-1.5 fs-meta text-dim">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: `rgb(var(${cat.colorVar}))` }}/>
            {cat.label}
          </div>
        ))}
      </div>
    </>
  );
}

function CostStackedArea({ points }) {
  const { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } = window.Recharts;

  // Prepare chart rows: numeric values + short date label.
  const rows = points.map((p) => ({
    date: p.date.slice(5), // MM-DD
    fullDate: p.date,
    cost_usd: p.cost_usd,
    session_count: p.session_count,
    cache_creation_tokens: p.cache_creation_tokens,
    cache_read_tokens: p.cache_read_tokens,
    input_tokens: p.input_tokens,
    output_tokens: p.output_tokens,
  }));

  return (
    <div style={{ width: '100%', height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <defs>
            {TOKEN_CATEGORIES.map((cat) => (
              <linearGradient key={cat.key} id={`g-${cat.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={`rgb(var(${cat.colorVar}))`} stopOpacity={0.55}/>
                <stop offset="100%" stopColor={`rgb(var(${cat.colorVar}))`} stopOpacity={0.05}/>
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false}/>
          {/* Recharts tick.fontSize 는 SVG font-size 속성으로 렌더 → CSS var() 미해석.
              값 10px = --fs-micro 와 동일 → 토큰 정렬은 유지(숫자 리터럴 불가피). */}
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
            axisLine={{ stroke: 'rgb(var(--line))' }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={formatTokenCompact}
            tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
            axisLine={{ stroke: 'rgb(var(--line))' }}
            tickLine={false}
            width={48}
          />
          <Tooltip content={<CostTooltip/>}/>
          {TOKEN_CATEGORIES.map((cat) => (
            <Area
              key={cat.key}
              type="monotone"
              dataKey={cat.key}
              stackId="tokens"
              stroke={`rgb(var(${cat.colorVar}))`}
              strokeWidth={1.5}
              fill={`url(#g-${cat.key})`}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function CostTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const row = payload[0].payload;
  const totalTokens = sumTokens(row);

  return (
    <div style={{
      background: 'rgb(var(--elev))',
      border: '1px solid rgb(var(--line))',
      borderRadius: 8,
      padding: '8px 12px',
      fontSize: 'var(--fs-meta)',
      fontFamily: 'JetBrains Mono, monospace',
      boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
    }}>
      <div style={{ color: 'rgb(var(--ink))', marginBottom: 4, fontWeight: 600 }}>{row.fullDate}</div>
      <div style={{ color: 'rgb(var(--dim))' }}>Cost {formatUsd(row.cost_usd)} · Sessions {formatInt(row.session_count)}</div>
      <div style={{ color: 'rgb(var(--dim))', marginBottom: 6 }}>Total tokens {formatTokenCompact(totalTokens)}</div>
      {TOKEN_CATEGORIES.slice().reverse().map((cat) => (
        <div key={cat.key} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'rgb(var(--dim))' }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: `rgb(var(${cat.colorVar}))` }}/>
          {cat.label} {formatTokenCompact(row[cat.key])}
        </div>
      ))}
    </div>
  );
}

// Shared chrome
function EmptyState({ message }) {
  return (
    <div className="placeholder" style={{ padding: 20 }}>
      {message}
    </div>
  );
}

function ErrorBanner({ title, detail, onRetry }) {
  const { Icon } = window.UI;
  return (
    <div
      role="alert"
      className="rounded-md border p-3 flex items-start gap-3"
      style={{
        background: 'rgb(var(--crit) / 0.08)',
        borderColor: 'rgb(var(--crit) / 0.4)',
      }}>
      <Icon name="warn" size={16} className="text-crit mt-0.5"/>
      <div className="flex-1 min-w-0">
        {/* 배너 안정 — 제목 1줄 clamp + reserved 높이, 상세 1줄 truncate → 가변 폭에서 배너 높이 불변. */}
        <div className="fs-body font-medium text-ink dash-banner-title" title={title}>{title}</div>
        {detail && <div className="fs-meta font-mono text-dim mt-1 truncate" title={window.UI.titleOf(detail)}>{detail}</div>}
      </div>
      <button className="btn sm" onClick={onRetry}>Retry</button>
    </div>
  );
}

function ChartSkeleton({ height = 220, 'aria-label': ariaLabel }) {
  return (
    <div
      aria-busy="true"
      aria-label={ariaLabel}
      style={{
        width: '100%',
        height,
        borderRadius: 8,
        background: 'rgb(var(--sunken))',
        opacity: 0.7,
        animation: 'skelPulse 1.4s ease-in-out infinite',
      }}
    />
  );
}

// Inline skeleton block — sunken 토큰 pulse placeholder.
function Skel({ w = '100%', h = 14, style }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: w,
        height: h,
        background: 'rgb(var(--sunken))',
        borderRadius: 4,
        opacity: 0.7,
        animation: 'skelPulse 1.4s ease-in-out infinite',
        ...style,
      }}
    />
  );
}

// Shared style constants (inline-style 객체 중복 제거)
const ROW_SKELETON_STYLE = {
  display: 'flex',
  gap: 12,
  alignItems: 'center',
  padding: '8px 0',
};

// Pure helpers
async function fetchJson(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_e) { /* ignore body parse failure */ }
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 120) : ''}`);
  }
  return res.json();
}

// fetch + setter wiring 보일러플레이트 통합 — useEffect 본문 단순화.
function runFetch(url, signal, setter) {
  return fetchJson(url, signal)
    .then((data) => setter({ status: 'ready', data, error: null }))
    .catch((err) => handleError(err, setter));
}

function handleError(err, setter) {
  // AbortError = navigation away (사용자 가시 실패 아님).
  if (err && err.name === 'AbortError') {
    return;
  }
  setter({ status: 'error', data: null, error: err && err.message ? err.message : String(err) });
}

// CardHead sub 라인 4종 (alerts / agents / outcome / donut) 패턴 통합.
// ready → readyFn() · loading → 'Loading…' · error → "Couldn't load".
function subStatusText(state, readyFn) {
  if (state.status === 'ready') return readyFn();
  if (state.status === 'loading') return 'Loading…';
  return "Couldn't load";
}

// 4분류 토큰 합계 (input + output + cache_read + cache_creation).
function sumTokens(point) {
  return (Number(point.input_tokens) || 0)
    + (Number(point.output_tokens) || 0)
    + (Number(point.cache_read_tokens) || 0)
    + (Number(point.cache_creation_tokens) || 0);
}

// Outcome 분포 EMPTY 인사이트 박스 — 우려동반 / 실패차단 임계 hint. 비율은 'N.N% (x/y)' 분모 공개 (A5).
function computeOutcomeHint(byResultMap, total) {
  if (total <= 0) return null;
  const concernCount = byResultMap.get('done_with_concerns') || 0;
  if (concernCount / total >= 0.1) {
    return { tone: 'warn', text: `Done-with-caveats rate ${window.UI.formatPctWithDenominator(concernCount, total)} — above the 7-day norm, worth a look.` };
  }
  const breakageCount = (byResultMap.get('fail') || 0) + (byResultMap.get('blocked') || 0);
  if (breakageCount / total >= 0.05) {
    return { tone: 'crit', text: `Failure rate ${window.UI.formatPctWithDenominator(breakageCount, total)}.` };
  }
  return null;
}

// 기준(previous) 0 → null (배지 미렌더) — 가짜 +100%/0% 금지, '신규' 마커가 대체 (F10).
function computeDeltaPct(current, previous) {
  if (!previous || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function sumCost(points) {
  return (points || []).reduce((s, p) => s + (Number(p.cost_usd) || 0), 0);
}

// /api/agents/summary status (active|idle|inactive|error) → StatusDot tone.
function mapAgentStatus(status) {
  if (status === 'active')   return 'ok';
  if (status === 'idle')     return 'info';
  if (status === 'inactive') return 'warn';
  if (status === 'error')    return 'crit';
  return 'info';
}

// severity 우선순위 — worst-of 축약 기준. 높을수록 위험 (crit 최상위).
// neutral/info 는 "위험 아님" 동급(0) — 둘 다 정상 신호로 rollup 톤을 끌어올리지 않음.
const SEVERITY_RANK = { crit: 3, warn: 2, ok: 1, info: 0, neutral: 0 };

// 두 톤 중 더 위험한 쪽 반환 — enum SoT 톤만 입력(로컬 색맵 없음).
function worstTone(a, b) {
  return (SEVERITY_RANK[b] || 0) > (SEVERITY_RANK[a] || 0) ? b : a;
}

// 화면 전반 worst-severity rollup — outcome 장애율 기반 severity (데몬 입력은 health 화면으로 이관).
// outcome 소스의 톤만 반영. 미수신/로딩 시 건너뜀(부재를 위험으로 오인 금지).
// 모든 톤은 enum SoT 경유 — 로컬 status→color 맵 없음. n<임계 표본은 rollup 에서 제외(가짜 경보 차단).
function computeWorstRollup({ outcomesState }) {
  let tone = 'ok';
  let anyReady = false;

  if (outcomesState.status === 'ready') {
    anyReady = true;
    const total = Number(outcomesState.data.total) || 0;
    const byResult = new Map((outcomesState.data.by_result || []).map((r) => [r.result, r.count]));
    if (total >= window.UI.LOW_N_MIN) {
      const breakage = (byResult.get('fail') || 0) + (byResult.get('blocked') || 0);
      const concerns = byResult.get('done_with_concerns') || 0;
      if (breakage / total >= 0.05) tone = worstTone(tone, 'crit');
      else if (concerns / total >= 0.1) tone = worstTone(tone, 'warn');
    }
  }

  return anyReady ? tone : null;
}

// rollup 톤 → 사용자 라벨 (status Badge 가 TONE_ICON Lucide 선행 — 색+기호 듀얼인코딩).
const ROLLUP_LABEL = { ok: 'All clear', warn: 'Attention', crit: 'Issues' };

window.ScreenDashboard = ScreenDashboard;
