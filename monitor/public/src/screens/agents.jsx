// 에이전트 성과 화면 (live data via /api/agents/*) — RED method 6-카드.
// 단일 글로벌 period 토글 → 모든 fetch days 동기 (AbortController 1개/wave) · G4 failure-reasons 만 selectedAgent 변경 시 별도 wave.
// Hooks aliased with Ag suffix — window-scope collision 회피.
const {
  useState: useStateAg,
  useEffect: useEffectAg,
  useRef: useRefAg,
  useCallback: useCallbackAg,
  useMemo: useMemoAg,
} = React;

// Server allowlist mirror (routes/agents.ts).
const AGENT_PERIODS = [
  { value: 7,  label: '7d'  },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

// core-outcome-record.md task_type 9종 canonical enum mirror — 서버 SoT 는
// src/server/task-types.ts TASK_TYPES (Babel-standalone in-browser JSX 라 import 불가 ·
// 값 동기는 이 cross-layer 참조 주석으로 추적). 비코드 4종 (review/diagnosis/doc/cleanup)
// 누락 시 해당 outcome 이 매트릭스에서 조용히 사라진다.
const TASK_TYPE_COLUMNS = [
  { key: 'bug-fix',   label: 'bug-fix'   },
  { key: 'feature',   label: 'feature'   },
  { key: 'refactor',  label: 'refactor'  },
  { key: 'research',  label: 'research'  },
  { key: 'plan',      label: 'plan'      },
  { key: 'review',    label: 'review'    },
  { key: 'diagnosis', label: 'diagnosis' },
  { key: 'doc',       label: 'doc'       },
  { key: 'cleanup',   label: 'cleanup'   },
];

// 성공률 임계값 — 3종이 카드별로 다른 목적 (CF8 · 통일 강제 아님).
// 매트릭스 셀 위험도 OK/WARN 90/70 (agent×task 점검 우선순위) · Summary 행 운영 건전성 95/90 · Top N 컷오프 95 (action 진입선).
// success_rate ∈ [0,1] (매트릭스) · % (Summary) 스케일 차이 주의.
const SUCCESS_RATE_OK_THRESHOLD   = 0.9;
const SUCCESS_RATE_WARN_THRESHOLD = 0.7;

// Summary 행 톤 임계 (% 스케일) — 매트릭스 셀 임계와 목적이 달라 별도 상수 (CF8).
const SUMMARY_SUCCESS_OK_PCT   = 95;
const SUMMARY_SUCCESS_WARN_PCT = 90;

// revision_count 분포 — server enum 순서 (stacked bar bottom→top).
const REVISION_BUCKETS = [
  { key: '0',  label: '0',  colorVar: '--ok'   },
  { key: '1',  label: '1',  colorVar: '--info' },
  { key: '2',  label: '2',  colorVar: '--warn' },
  { key: '3',  label: '3',  colorVar: '--accent' },
  { key: '4+', label: '4+', colorVar: '--crit' },
];

const MATRIX_AGENT_CAP = 25;

// PG fallback 분류 — learning-aggregator.py 3-종 (agent_id_missing / deprecated_agent / legacy_unknown).
// 정상 agent 와 시각적 분리 + 라벨/툴팁으로 식별성 보존.
const UNKNOWN_AGENT_ID = 'unknown';
const UNKNOWN_AGENT_LABEL = 'Unidentified (old)';
const UNKNOWN_AGENT_TITLE =
  "Work that couldn't be matched to a current agent — agent_id_missing / deprecated_agent / legacy_unknown (PG fallback)";

// breakage = fail + blocked (failure-patterns breakage_rate) — fail 단독 비율 아님.
const BREAKAGE_RATE_CRIT_THRESHOLD = 0.2;

// 저활용 agent 임계 anchor — 30일 기준 SubagentStart < 3 회.
// 정보성 badge — 삭제 trigger 아님 (삭제 의사결정은 별도 단계).
// invocations 는 선택 ?days window 상대값 → 임계도 window 비례 환산 (아래 helper).
const LOW_INVOCATION_PER_30D = 3;

// 30d anchor 임계를 선택 window 로 비례 환산 — 최소 1 (0 임계는 badge 무의미).
function lowInvocationThresholdForWindow(days) {
  return Math.max(1, Math.round(LOW_INVOCATION_PER_30D * (Number(days) || 30) / 30));
}

// Top-N failing — 매트릭스 green-bias 보완 (action-triggering compact view).
const TOPN_FAILING_THRESHOLD = 0.95;
const TOPN_FAILING_LIMIT = 8;

// 랭킹 최소 표본 floor (A5) — 합산 분모(성공+실패) < 3 쌍은 비율 신뢰 불가 → 랭킹 제외.
const TOPN_MIN_SAMPLE = 3;

// Recharts 비-Responsive 환경의 sparkline 크기 (success-rate matrix cell 밀도).
const SPARK_WIDTH  = 60;
const SPARK_HEIGHT = 20;

// registry compatibility 필드 시각화 — chip 표시 trunc 길이.
const COMPATIBILITY_TRUNCATE_LENGTH = 28;

// 드로어 Recent activity 섹션 — per-agent 최근 outcomes 표시 건수 (drawer 높이 대비 확정값).
const RECENT_ACTIVITY_LIMIT = 8;

// fetch state 초기값 + helper — runFetchAg 와 함께 보일러플레이트 압축.
const INITIAL_FETCH_STATE = { status: 'loading', data: null, error: null };

// SubagentStop 미페어 outcome 의 learning-aggregator 합성 fallback — 실 에이전트 아님.
// 100% 성공률은 합성 버킷의 산물 (의미 없음) → 라벨/툴팁 분리로 오인 차단 (CF6).
const SYNTHETIC_SENTINEL_AGENT_ID = 'subagent_stop_missing';
const SYNTHETIC_SENTINEL_LABEL = 'Placeholder bucket (unpaired SubagentStop)';
const SYNTHETIC_SENTINEL_TITLE =
  'subagent_stop_missing — synthetic fallback bucket for outcomes with no paired SubagentStop (not a real agent · success rate is meaningless)';

// 'unknown' / 'subagent_stop_missing' — non-actionable agent ID 묶음 (radar / row 시각 분리).
const NON_ACTIONABLE_AGENT_IDS = new Set([UNKNOWN_AGENT_ID, SYNTHETIC_SENTINEL_AGENT_ID]);

// T14 double-filter guard (outcomes.jsx isNonActionableAgentO 미러) — /api/agents/* 는
// 이제 서버가 registry 게이트하므로 이 클라이언트 시각 집합은 정말 non-actionable 인
// sentinel(빈-레지스트리 fail-open)에만 매칭. Pure: agent id + 집합 → non-actionable 여부.
// 두 화면이 집합을 균일 적용하도록 인라인 `.has` 를 중앙화 (uneven cross-screen application 제거).
function isNonActionableAgentAg(agentId, visualSet = NON_ACTIONABLE_AGENT_IDS) {
  return visualSet.has(agentId);
}

// 카드 본문 flex 컨테이너 + 스크롤 + skeleton pulse — inline style 으로 빼두면 JSX 노이즈가 큼.
// .ag-density-compact = 행 패딩만 좁히는 밀도 토글 (T-AGT-2) — 정렬/색/sev-bar 는 그대로, padding 만 축소.
const AGENTS_INLINE_CSS = '@keyframes skelPulseAg { 0%,100%{opacity:.7} 50%{opacity:.35} } '
  + '.ag-card-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; } '
  + '.ag-card-body-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; } '
  + '.ag-chart-fill { flex: 1 1 auto; min-height: 0; width: 100%; } '
  + '.ag-density-compact .tbl td { padding-top: 4px; padding-bottom: 4px; } '
  + '.ag-density-compact .tbl th { padding-top: 5px; padding-bottom: 5px; } '
  + '.tbl td { vertical-align: top; }';

// 행 밀도 토글 옵션 (T-AGT-2) — comfortable(기본 .tbl 패딩) / compact(좁은 패딩).
const DENSITY_OPTIONS = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact',     label: 'Compact'     },
];

// Sticky thead 셀 공통 스타일 — window.UI 의 단일 SoT 참조 (S1, cost/outcomes/health/wiki 미러용).
// ui.js 가 screens 보다 먼저 로드(index.html 순서)되므로 module-eval 시점에 안전.
const STICKY_TH_STYLE = window.UI.STICKY_TH_STYLE;

// card-body flex 컨테이너 (스크롤 허용) — RadarPolygon/Latency/Detail 패널 공통.
const CARD_BODY_FLEX_SCROLL_STYLE = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' };

function ScreenAgents() {
  const { PageHeader, Icon, TypeScaleStyle } = window.UI;

  const [days, setDays] = useStateAg(30);
  const [refreshTick, setRefreshTick] = useStateAg(0);

  // Per-panel fetch state — independent so one failure doesn't blank the page.
  // failureState → Summary fail_count 컬럼 client-side merge (failure-patterns 흡수).
  // revisionState + reviewState → AgentQualityHealthCard 가 join 합성 (R1 idiom).
  const [summaryState,   setSummaryState]   = useStateAg(INITIAL_FETCH_STATE);
  const [latencyState,   setLatencyState]   = useStateAg(INITIAL_FETCH_STATE);
  const [successState,   setSuccessState]   = useStateAg(INITIAL_FETCH_STATE);
  const [revisionState,  setRevisionState]  = useStateAg(INITIAL_FETCH_STATE);
  const [reviewState,    setReviewState]    = useStateAg(INITIAL_FETCH_STATE);
  // reviewByAgentState → Health Index review_flag 성분 (per-agent ratio · CF1 P0).
  // reviewState(date-only)는 timeline 차트 전용으로 분리 유지.
  const [reviewByAgentState, setReviewByAgentState] = useStateAg(INITIAL_FETCH_STATE);
  const [failureState,   setFailureState]   = useStateAg(INITIAL_FETCH_STATE);
  // activationState → SkillActivation 패널 (registered endpoint, no screen 렌더 — 최고가치 orphan).
  // lifecycleState → start/stop/completed gap(orphan spawn) + duration 분포 패널 (built, never rendered).
  const [activationState, setActivationState] = useStateAg(INITIAL_FETCH_STATE);
  const [lifecycleState,  setLifecycleState]  = useStateAg(INITIAL_FETCH_STATE);
  // overageState → budget_overages(P95 옆 near-cap 뱃지). 404/503(테이블 미배포) 시 error → 뱃지 미렌더.
  const [overageState,    setOverageState]    = useStateAg(INITIAL_FETCH_STATE);

  // selectedAgent = 키보드/행 하이라이트 (드릴 진입점) · 드로어 열림과 독립 — 하이라이트는 클릭·포커스로,
  // 드로어는 클릭/Enter 로만 (open trigger 분리).
  const [selectedAgent, setSelectedAgent] = useStateAg(null);
  // drawerAgent = 명시적 행 클릭으로만 set 되는 드로어 대상 agent_id. null = 드로어 닫힘 (로드 시 자동 열림 없음).
  const [drawerAgent, setDrawerAgent] = useStateAg(null);
  // P2-B — fail/blocked 2종 분리 fetch. blocked 가 지배적 장애 유형 (fail 0 + blocked 다수 빈번).
  // 드로어 Failures 섹션 데이터 → drawerAgent 변경 시 발화 (드로어 열림과 동기).
  const [detailState, setDetailState] = useStateAg({ status: 'idle', data: null, error: null });
  const [blockedState, setBlockedState] = useStateAg({ status: 'idle', data: null, error: null });
  // Recent activity 섹션 — 드로어 열림 시 per-agent outcomes 최신순 fetch (유일한 신규 요청).
  const [recentState, setRecentState] = useStateAg({ status: 'idle', data: null, error: null });

  const abortRef = useRefAg(null);
  const detailAbortRef = useRefAg(null);
  const recentAbortRef = useRefAg(null);

  const triggerRefresh = useCallbackAg(() => setRefreshTick((t) => t + 1), []);

  useEffectAg(() => {
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;

    const mainSetters = [
      setSummaryState, setLatencyState, setSuccessState, setRevisionState,
      setReviewState, setReviewByAgentState, setFailureState,
      setActivationState, setLifecycleState, setOverageState,
    ];
    mainSetters.forEach((s) => s(INITIAL_FETCH_STATE));

    // G3 latency 서버 allowlist {1-30} — 캐핑.
    const latencyDays = Math.min(days, 30);

    const tasks = [
      runFetchAg(`/api/agents/summary?days=${days}&order=runs&limit=50`, ctrl.signal, setSummaryState),
      runFetchAg(`/api/agents/latency?days=${latencyDays}`, ctrl.signal, setLatencyState),
      runFetchAg(`/api/agents/success-rate?days=${days}`, ctrl.signal, setSuccessState),
      runFetchAg(`/api/agents/revision-distribution?days=${days}`, ctrl.signal, setRevisionState),
      runFetchAg(`/api/agents/review-flag-timeseries?days=${days}`, ctrl.signal, setReviewState),
      // CF1 P0 — Health Index review_flag 성분을 per-agent 실비율로 공급.
      // 404 (pre-deploy) 시 error 상태 → buildQualityHealthRanking 이 revision 단독으로 graceful degrade.
      runFetchAg(`/api/agents/review-flag-by-agent?days=${days}`, ctrl.signal, setReviewByAgentState),
      runFetchAg(`/api/agents/failure-patterns?days=${days}`, ctrl.signal, setFailureState),
      // 미렌더 orphan 데이터 surface (P2): activation 이벤트 + lifecycle gap. days 토글 동기.
      runFetchAg(`/api/telemetry/activations?days=${days}`, ctrl.signal, setActivationState),
      runFetchAg(`/api/agents/lifecycle-stats?days=${days}`, ctrl.signal, setLifecycleState),
      // budget_overages near-cap 뱃지 — days ∈ {7,30,90} 서버 allowlist 와 동일.
      runFetchAg(`/api/agents/budget-overages?days=${days}`, ctrl.signal, setOverageState),
    ];

    return () => ctrl.abort();
  }, [days, refreshTick]);

  // G4 wave — drawerAgent (드로어 열림) 또는 period 변경 시 발화. 메인 wave 와 독립.
  // fail/blocked 2종 동시 fetch — 단일 AbortController 로 동기 abort. 드로어 Failures 섹션 데이터.
  useEffectAg(() => {
    if (!drawerAgent) {
      setDetailState({ status: 'idle', data: null, error: null });
      setBlockedState({ status: 'idle', data: null, error: null });
      return undefined;
    }
    const ctrl = new AbortController();
    detailAbortRef.current?.abort();
    detailAbortRef.current = ctrl;
    setDetailState(INITIAL_FETCH_STATE);
    setBlockedState(INITIAL_FETCH_STATE);

    const agentParam = encodeURIComponent(drawerAgent);
    // result 미지정 → 서버 default fail (기존 동작 유지).
    runFetchAg(
      `/api/agents/failure-reasons?agent=${agentParam}&days=${days}&result=fail`,
      ctrl.signal,
      setDetailState,
    );
    runFetchAg(
      `/api/agents/failure-reasons?agent=${agentParam}&days=${days}&result=blocked`,
      ctrl.signal,
      setBlockedState,
    );

    return () => ctrl.abort();
  }, [drawerAgent, days, refreshTick]);

  // Recent-activity wave — 드로어 열림 시 per-agent outcomes 최신순 8건 (유일한 신규 엔드포인트).
  // agent 필터 축 = agent NAME (outcomes/search 계약). drawerAgent==agent_id==agent_name (현 cycle convention).
  useEffectAg(() => {
    if (!drawerAgent) {
      setRecentState({ status: 'idle', data: null, error: null });
      return undefined;
    }
    const ctrl = new AbortController();
    recentAbortRef.current?.abort();
    recentAbortRef.current = ctrl;
    setRecentState(INITIAL_FETCH_STATE);

    const agentParam = encodeURIComponent(drawerAgent);
    runFetchAg(
      `/api/outcomes/search?agent=${agentParam}&sort=record_ts:desc&limit=${RECENT_ACTIVITY_LIMIT}`,
      ctrl.signal,
      setRecentState,
    );

    return () => ctrl.abort();
  }, [drawerAgent, refreshTick]);

  // 패널 1개라도 loading → period 토글 비활성 (abort storm 방지).
  const anyLoading = [
    summaryState, latencyState, successState, revisionState,
    reviewState, reviewByAgentState, failureState,
    activationState, lifecycleState,
  ].some((s) => s.status === 'loading');

  // 추세 셀 데이터 — success-rate 일별 합계를 agent_id 별 group → 최근 7일 시리즈.
  // useMemo 로 row 마다 재계산 회피.
  const trendByAgent = useMemoAg(
    () => buildAgentTrendMap(readyData(successState)?.rows ?? []),
    [successState],
  );

  // failure-patterns API 흡수 — Summary 의 fail_count 컬럼 client-side merge.
  // agent_id == agent_name (현 cycle convention) → 직접 key join.
  const failureByAgent = useMemoAg(
    () => buildFailureMap(readyData(failureState)?.rows ?? []),
    [failureState],
  );

  // budget_overages near-cap 뱃지 — agent_type == agent_id (현 cycle convention) 직접 key join.
  const overageByAgent = useMemoAg(
    () => buildOverageMap(readyData(overageState)?.rows ?? []),
    [overageState],
  );

  // 정렬 상태를 화면 레벨로 승격 — 테이블과 드로어 Prev/Next nav 가 동일 정렬 순서를 공유 (AC3).
  const [sortBy, setSortBy] = useStateAg('name');

  // 행 밀도 (T-AGT-2) — view state 로만 보존 (서버/URL 동기 불필요). 패딩만 바꿔 한 화면에 더 많은 행.
  const [density, setDensity] = useStateAg('comfortable');

  // 드로어 nav 가 walk 하는 현재 정렬된 agent 행 — DetailModal 이 rows 위 idx 도출하는 패턴 미러.
  const sortedAgents = useMemoAg(
    () => sortAgentSummary(readyData(summaryState)?.agents ?? [], sortBy, failureByAgent),
    [summaryState, sortBy, failureByAgent],
  );

  // 행 클릭 → 하이라이트 + 드로어 동시 (open trigger). 키보드 하이라이트와 독립 유지.
  const handleSelectRow = useCallbackAg((agentId) => {
    setSelectedAgent(agentId);
    setDrawerAgent(agentId);
  }, []);

  const closeDrawer = useCallbackAg(() => setDrawerAgent(null), []);

  // 드로어 내 삭제 성공 → drawer 닫고 summary 재페치 (삭제된 행 제거 반영).
  const handleDeleted = useCallbackAg(() => {
    setDrawerAgent(null);
    setSelectedAgent(null);
    setRefreshTick((t) => t + 1);
  }, []);

  // Prev/Next + ArrowUp/Down — sortedAgents 위 현재 drawerAgent 인덱스 기준 이동.
  // 인덱스 계산은 updater 밖에서 (StrictMode double-invoke 안전 · setter 부수효과 회피).
  const navDrawer = useCallbackAg((dir) => {
    const idx = sortedAgents.findIndex((a) => a.agent_id === drawerAgent);
    if (idx < 0) return;
    const nextIdx = dir === 'prev' ? idx - 1 : idx + 1;
    if (nextIdx < 0 || nextIdx >= sortedAgents.length) return;
    const nextId = sortedAgents[nextIdx].agent_id;
    setSelectedAgent(nextId);
    setDrawerAgent(nextId);
  }, [sortedAgents, drawerAgent]);

  // 6 카드 grid — 4-row layout (Row 2/4 col-span-full · Row 1/3 grid-cols-3).
  return (
    <div className="flex flex-col">
      {/* 공유 타입스케일(--fs 토큰 + fs 클래스) 마운트 — SPA 단일 screen 모델: agents 활성 시 토큰·클래스 가용화 (ui.jsx 정의 소비 · 미정의 시 클래스 no-op 회귀 차단 · 멱등). */}
      <TypeScaleStyle/>
      <style>{AGENTS_INLINE_CSS}</style>
      <div className="flex-shrink-0">
        <PageHeader
          title="Agent performance"
          sub="Agent performance & reliability"
          right={
            <>
              <div className="seg" aria-label="Time range">
                {AGENT_PERIODS.map((p) => (
                  <button
                    key={p.value}
                    className={days === p.value ? 'active' : ''}
                    disabled={anyLoading && days !== p.value}
                    onClick={() => setDays(p.value)}
                    aria-pressed={days === p.value}
                    aria-label={`Last ${p.label}`}>
                    {p.label}
                  </button>
                ))}
              </div>
              <button className="btn ghost sm" onClick={triggerRefresh} aria-label="Refresh agent data">
                <Icon name="refresh" size={14}/>
                Refresh
              </button>
            </>
          }
        />
      </div>

      {/* Row 1 — 의사결정 진입점. 행 클릭 → 우측 슬라이드인 드로어 (인라인 사이드바 폐지 · full-width 테이블). */}
      <div className="grid grid-cols-1 gap-4 mb-4 items-stretch">
        <AgentSummaryCard
          state={summaryState}
          days={days}
          sortBy={sortBy}
          onSortChange={setSortBy}
          density={density}
          onDensityChange={setDensity}
          selectedAgent={selectedAgent}
          onSelect={handleSelectRow}
          onRetry={triggerRefresh}
          trendByAgent={trendByAgent}
          failureByAgent={failureByAgent}
          overageByAgent={overageByAgent}
        />
      </div>

      {/* Row 2 — 성능 (Duration · RED). col-span-full. */}
      <div className="grid grid-cols-1 gap-4 mb-4 items-stretch">
        <LatencyBarsCard state={latencyState} days={days} onRetry={triggerRefresh}/>
      </div>

      {/* Row 3 — 오류 분포 (Errors 세분화). grid-cols-3: Matrix 2/3 + TopN 1/3. */}
      <div className="grid grid-cols-3 gap-4 mb-4 items-stretch">
        <div className="col-span-2 h-full">
          <SuccessRateMatrixCard state={successState} days={days} onRetry={triggerRefresh}/>
        </div>
        <div className="col-span-1 h-full">
          <TopNFailingAgentsCard state={successState} days={days} onRetry={triggerRefresh} failureByAgent={failureByAgent}/>
        </div>
      </div>

      {/* Row 4 — 자가개선 신호 (Quality Health · 신규). col-span-full · 좌 60% timeline + 우 40% TOP5. */}
      <div className="grid grid-cols-1 gap-4 mb-4 items-stretch">
        <AgentQualityHealthCard
          revisionState={revisionState}
          reviewState={reviewState}
          reviewByAgentState={reviewByAgentState}
          days={days}
          onSelect={setSelectedAgent}
          onRetry={triggerRefresh}
        />
      </div>

      {/* Row 5 — orphan 데이터 surface (P2 · 미렌더 엔드포인트). grid-cols-3: Lifecycle 2/3 + Activation 1/3. */}
      <div className="grid grid-cols-3 gap-4 mb-4 items-stretch">
        <div className="col-span-2 h-full">
          <LifecycleStatsCard state={lifecycleState} days={days} onSelect={setSelectedAgent} onRetry={triggerRefresh}/>
        </div>
        <div className="col-span-1 h-full">
          <SkillActivationCard state={activationState} days={days} onRetry={triggerRefresh}/>
        </div>
      </div>

      {/* 행 클릭 시에만 마운트 (로드 시 자동 열림 없음). DetailSurface variant=drawer — focus-trap/scroll-lock/3 닫기 상속. */}
      {drawerAgent && (
        <AgentDetailDrawer
          drawerAgent={drawerAgent}
          sortedAgents={sortedAgents}
          summaryState={summaryState}
          revisionState={revisionState}
          reviewByAgentState={reviewByAgentState}
          latencyState={latencyState}
          successState={successState}
          failureState={failureState}
          lifecycleState={lifecycleState}
          detailState={detailState}
          blockedState={blockedState}
          recentState={recentState}
          trendByAgent={trendByAgent}
          failureByAgent={failureByAgent}
          days={days}
          onClose={closeDrawer}
          onNav={navDrawer}
          onRetry={triggerRefresh}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}

// AgentSummary (col-span-2) — 8 컬럼 · 행 클릭 → DetailPanel 갱신.
// 추세 셀 = 50×20 MiniBars (success-rate 7d) · 실패 컬럼 = failure-patterns API 흡수 (failureByAgent client-side merge).

const SUMMARY_SORT_OPTIONS = [
  { value: 'name',     label: 'Name (A–Z)' },
  { value: 'runs',     label: 'Most runs' },
  { value: 'success',  label: 'Success rate'   },
  { value: 'failures', label: 'Most breakages'    },
  { value: 'p95',      label: 'P95 ↓'      },
];

const MINIBAR_WIDTH = 50;
const MINIBAR_HEIGHT = 20;

function AgentSummaryCard({ state, days, sortBy, onSortChange, density, onDensityChange, selectedAgent, onSelect, onRetry, trendByAgent, failureByAgent, overageByAgent }) {
  const { CardHead, Badge } = window.UI;
  const data = readyData(state);
  const totalAgents = data?.meta?.total_agents ?? 0;
  const subText = data
    ? `${totalAgents} active`
    : (state.status === 'loading' ? 'Loading…' : "Couldn't load");

  return (
    <div className="card h-full flex flex-col min-h-0 mb-0">
      <CardHead
        title="Performance by agent"
        sub={subText}
        right={null}
      />
      <AgentSummaryBody
        state={state}
        days={days}
        sortBy={sortBy}
        onSortChange={onSortChange}
        density={density}
        onDensityChange={onDensityChange}
        selectedAgent={selectedAgent}
        onSelect={onSelect}
        onRetry={onRetry}
        trendByAgent={trendByAgent}
        failureByAgent={failureByAgent}
        overageByAgent={overageByAgent}
      />
    </div>
  );
}

function AgentSummaryBody({ state, days, sortBy, onSortChange, density, onDensityChange, selectedAgent, onSelect, onRetry, trendByAgent, failureByAgent, overageByAgent }) {
  if (state.status === 'loading') {
    return <div className="card-body"><ChartSkeletonAg height={240} aria-label="Loading agent performance"/></div>;
  }
  if (state.status === 'error') {
    return <div className="card-body"><ErrorBannerAg title="Couldn't load agent performance" detail={state.error} onRetry={onRetry}/></div>;
  }
  const agents = readyData(state)?.agents ?? [];
  if (agents.length === 0) {
    return <div className="card-body"><EmptyStateAg message={`No agent activity in the last ${days} days.`}/></div>;
  }

  // pseudo-agent(subagent_stop_missing / unknown) 는 정렬 대상 아님 → 하단 collapsed footer 로 분리.
  const actionable = agents.filter((a) => !isNonActionableAgentAg(a.agent_id));
  const pseudoAgents = agents.filter((a) => isNonActionableAgentAg(a.agent_id));
  const sorted = sortAgentSummary(actionable, sortBy, failureByAgent);
  const isCompact = density === 'compact';

  return (
    <>
      <div className="px-4 py-2.5 border-b border-line flex items-center justify-end gap-3 fs-meta text-faint">
        <div className="flex items-center gap-2">
          <span className="font-mono">Density:</span>
          <div className="seg" aria-label="Row density">
            {DENSITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={density === opt.value ? 'active' : ''}
                onClick={() => onDensityChange(opt.value)}
                aria-pressed={density === opt.value}
                aria-label={`${opt.label} row density`}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono">Sort:</span>
          <select
            className="field field-select"
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value)}
            aria-label="Agent sort order">
            {SUMMARY_SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className={`card-body flush${isCompact ? ' ag-density-compact' : ''}`}>
        <AgentSummaryTable
          agents={sorted}
          pseudoAgents={pseudoAgents}
          days={days}
          selectedAgent={selectedAgent}
          onSelect={onSelect}
          trendByAgent={trendByAgent}
          failureByAgent={failureByAgent}
          overageByAgent={overageByAgent}
        />
      </div>
    </>
  );
}

// 두 성공률 임계 세트가 의도적으로 다른 이유 한 줄 설명 — 사용자 혼동 차단 (CF8).
const SUMMARY_THRESHOLD_CAPTION =
  `Row tone tracks operational health (≥${SUMMARY_SUCCESS_OK_PCT}% ok · ≥${SUMMARY_SUCCESS_WARN_PCT}% warn); `
  + `the agent×task matrix flags earlier at ${(SUCCESS_RATE_OK_THRESHOLD * 100).toFixed(0)}/${(SUCCESS_RATE_WARN_THRESHOLD * 100).toFixed(0)}% to surface review priority.`;

// 총 컬럼 수 (footer colSpan) — badge·Agent·Runs·Launches·Success·Needs info·Breakages·P95·Trend·status = 10.
const SUMMARY_TABLE_COLSPAN = 10;

function AgentSummaryTable({ agents, pseudoAgents, days, selectedAgent, onSelect, trendByAgent, failureByAgent, overageByAgent }) {
  const [showPseudo, setShowPseudo] = useStateAg(false);
  const pseudoRows = Array.isArray(pseudoAgents) ? pseudoAgents : [];

  const renderRow = (a) => (
    <AgentSummaryRow
      key={a.agent_id}
      agent={a}
      days={days}
      isSelected={selectedAgent === a.agent_id}
      onSelect={onSelect}
      trend={trendByAgent ? trendByAgent.get(a.agent_id) : null}
      failure={failureByAgent ? failureByAgent.get(a.agent_id) : null}
      overage={overageByAgent ? overageByAgent.get(a.agent_id) : null}
    />
  );

  return (
    <div className="agent-table-minibars overflow-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th style={STICKY_TH_STYLE}></th>
            <th style={STICKY_TH_STYLE}>Agent</th>
            <th className="num" style={STICKY_TH_STYLE} title="Times the agent finished and reported a result (outcome records)">Runs</th>
            <th className="num" style={STICKY_TH_STYLE}>Launches</th>
            <th className="num" style={STICKY_TH_STYLE}>Success rate</th>
            <th className="num" style={STICKY_TH_STYLE}>Needs info</th>
            <th className="num" style={STICKY_TH_STYLE} title="Breakages = failed + blocked (blocked = a compliant halt, not a defect)">Breakages</th>
            <th className="num" style={STICKY_TH_STYLE}>P95</th>
            <th style={STICKY_TH_STYLE}>Trend</th>
            <th style={STICKY_TH_STYLE}></th>
          </tr>
        </thead>
        <tbody>
          {agents.map(renderRow)}
        </tbody>
        {pseudoRows.length > 0 && (
          <tbody>
            <tr>
              <td colSpan={SUMMARY_TABLE_COLSPAN} className="border-t border-line">
                <button
                  className="w-full text-left fs-micro font-mono text-faint px-1 py-1.5 hover:text-dim"
                  onClick={() => setShowPseudo((v) => !v)}
                  aria-expanded={showPseudo}>
                  {showPseudo ? '▾' : '▸'} {pseudoRows.length} non-actionable {pseudoRows.length === 1 ? 'bucket' : 'buckets'} (unpaired / unidentified — not real agents)
                </button>
              </td>
            </tr>
            {showPseudo && pseudoRows.map(renderRow)}
          </tbody>
        )}
      </table>
      <div className="fs-micro font-mono text-faint px-1 py-2 border-t border-line">{SUMMARY_THRESHOLD_CAPTION}</div>
    </div>
  );
}

function AgentSummaryRow({ agent, days, isSelected, onSelect, trend, failure, overage }) {
  const { AgentBadge, StatusDot, MiniBars, Bar, Badge, resolveBadge, formatPctWithDenominator, LOW_N_MIN, Icon, TONE_ICON } = window.UI;
  // non-actionable 묶음을 2종으로 분기 — synthetic sentinel 은 'legacy/deprecated' 가 아님 (CF6).
  const isSyntheticAgent = agent.agent_id === SYNTHETIC_SENTINEL_AGENT_ID;
  const isUnknownAgent = isNonActionableAgentAg(agent.agent_id);
  const nonActionableLabel = isSyntheticAgent ? SYNTHETIC_SENTINEL_LABEL : UNKNOWN_AGENT_LABEL;
  const nonActionableTitle = isSyntheticAgent ? SYNTHETIC_SENTINEL_TITLE : UNKNOWN_AGENT_TITLE;
  const successPct = Number(agent.success_pct) || 0;
  const successTone = successRateTone(successPct);
  // matrix 분모 = runs − needs_context (서버 success_pct 와 동일 semantics) → 'N.N% (x/y)' 재구성.
  const needsContextCount = Number(agent.needs_context_count) || 0;
  const successDenominator = Math.max(0, (Number(agent.runs) || 0) - needsContextCount);
  const successNumerator = Math.round((successPct / 100) * successDenominator);
  const isLowSample = successDenominator > 0 && successDenominator < LOW_N_MIN;
  const successTitle = successDenominator > 0
    ? `passed ${successNumerator} ÷ denominator ${successDenominator} (done+dwc+blocked+fail) · needs_context ${needsContextCount} excluded${isLowSample ? ` · small sample (n=${successDenominator} < ${LOW_N_MIN})` : ''}`
    : 'no outcomes besides needs_context — success rate undefined';
  // invocations = window 상대 spawn 빈도 (invocations_30d 는 deprecated alias — 1 release 유지).
  const invocations = agent.invocations !== undefined ? agent.invocations : agent.invocations_30d;
  const p95Sec = agent.p95_ms == null ? null : Number(agent.p95_ms) / 1000;
  const p95Tone = p95LatencyTone(p95Sec);
  const p95Glyph = p95GlyphTone(p95Sec);
  // near-cap 뱃지 — overage 행 존재 = 실제 tool_use 예산 크로싱 발생. 미존재/count 0 → 미렌더.
  const overageCount = overage ? Number(overage.overage_count) || 0 : 0;
  const overageBadge = overageCount > 0 ? resolveBadge('budget_near_cap') : null;
  const overageTitle = overage
    ? `${overageCount} tool_use-budget crossing${overageCount === 1 ? '' : 's'} in the last ${days}d · peak ${Number(overage.max_crossed_pct) || 0}% of budget`
    : null;
  const status = mapStatusToTone(agent.status);
  // 추세 데이터 — null 이면 미렌더 (추정값 주입 금지).
  const hasTrend = Array.isArray(trend) && trend.length > 0;
  const trendColor = trendBarColor(agent.status, successPct);
  // 장애 컬럼 — failure-patterns 의 total_breakages (fail+blocked). 미존재 = 0.
  const failCount = failure ? failure.total_breakages : 0;
  const breakageRate = failure ? failure.breakage_rate : 0;
  const failTone = failureTone(failCount, breakageRate);
  const failTitle = failure
    ? `breakages ${failure.total_breakages} = fail ${failure.fail_count} + blocked ${failure.blocked_count} · rate ${(breakageRate * 100).toFixed(1)}%`
    : 'no breakages (fail+blocked)';

  const handleClick = () => onSelect(agent.agent_id);
  const handleKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(agent.agent_id);
    }
  };

  return (
    <tr
      onClick={handleClick}
      onKeyDown={handleKey}
      tabIndex={0}
      role="button"
      aria-pressed={isSelected}
      className={isSelected ? 'bg-sunken' : ''}
      style={isUnknownAgent ? { opacity: 0.65 } : undefined}
      title={isUnknownAgent ? nonActionableTitle : `Show details for ${agent.agent_name}`}>
      <td><AgentBadge a={{ id: agent.agent_id, name: agent.agent_name }}/></td>
      <td>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-medium">{isUnknownAgent ? nonActionableLabel : agent.agent_name}</span>
          <CompatibilityBadge compatibility={agent.compatibility}/>
        </div>
      </td>
      <td className="num">{formatIntAg(agent.runs)}</td>
      <td className="num" title={formatInvocationsTitle(invocations, days)}>
        <span className={invocationsTone(invocations, days)}>
          {invocations == null ? '—' : formatIntAg(invocations)}
        </span>
      </td>
      <td className="num" title={successTitle}>
        <span
          className={successDenominator > 0 ? successTone : 'text-faint'}
          style={isLowSample ? { fontStyle: 'italic', opacity: 0.75 } : undefined}>
          {formatPctWithDenominator(successNumerator, successDenominator)}
        </span>
        {/* 비례 막대 — % 숫자 옆 즉시-스캔 shape. 측정 불가(분모 0)면 미렌더. */}
        {successDenominator > 0 && (
          <Bar
            value={successPct / 100}
            tone={barToneFromClass(successTone)}
            ariaLabel={`success rate ${successPct.toFixed(1)}%`}
          />
        )}
      </td>
      <td className="num" title={`needs_context ${needsContextCount} — excluded from success rate`}>
        <span className={needsContextCount > 0 ? 'text-dim' : 'text-faint'}>
          {needsContextCount > 0 ? formatIntAg(needsContextCount) : '—'}
        </span>
      </td>
      <td className="num" title={failTitle}>
        <span className={failTone}>{failCount > 0 ? formatIntAg(failCount) : '—'}</span>
        {/* F1: 0건은 em-dash + 막대 미렌더(none-state), 1건 이상은 항상 가시적 crit 막대 —
            막대의 "존재"가 장애 있음을, 폭이 breakage_rate 를 전달. rate 가 sub-1%라도
            Bar 의 min-width floor(3px) 로 none-state 와 명확히 구분(1건이 "없음"으로 안 읽힘). */}
        {failCount > 0 && (
          <Bar
            value={Math.max(breakageRate, 0.01)}
            tone="crit"
            ariaLabel={`breakage rate ${(breakageRate * 100).toFixed(1)}%`}
          />
        )}
      </td>
      <td
        className="num"
        title={p95Sec == null ? undefined : `p95 latency tier: ${p95Glyph} (warn >${P95_AGENT_WARN_SEC / 60}m · crit >${P95_AGENT_CRIT_SEC / 60}m)`}>
        {/* tier 글리프 — 초-도메인 톤(p95GlyphTone 600s/1200s) KEY 의 ✓/⚠/✕ (shape = 색 외 인코딩).
            종전 StatusDot 은 tone KEY 를 status enum 으로 오인받아 의미가 흐려졌고, 컷 도메인까지 어긋나
            전 에이전트가 단일 티어였다 — 글리프 + 분-도메인 컷으로 230s vs 1695s 가 가시적으로 분기.
            글리프는 옆 초 수치(스크린리더 가독)를 강화하는 장식 → aria-hidden. 측정 불가(null)면 미렌더. */}
        <span className="inline-flex items-center justify-end gap-1.5">
          {p95Sec != null ? (
            <span className="inline-flex items-center gap-1">
              <span className={p95Tone || 'text-ok'} aria-hidden="true">
                <Icon name={TONE_ICON[p95Glyph]} size={13}/>
              </span>
              <span className={p95Tone}>{formatDurationSecAg(p95Sec)}</span>
            </span>
          ) : (
            <span className="text-faint">—</span>
          )}
          {overageBadge && (
            <Badge role="status" tone={overageBadge.tone} title={overageTitle}>
              {overageBadge.pill}
            </Badge>
          )}
        </span>
      </td>
      <td>
        {hasTrend ? (
          <MiniBars data={trend} w={MINIBAR_WIDTH} h={MINIBAR_HEIGHT} color={trendColor}/>
        ) : (
          <span className="text-faint fs-micro font-mono" title="no 7-day daily success-rate breakdown">—</span>
        )}
      </td>
      <td><StatusDot status={status}/></td>
    </tr>
  );
}

// registry compatibility 필드 시각화 — 행 chip (trunc + tooltip) · 상세 패널 (full 텍스트).
// 미선언 agent 미렌더 (UI noise 회피).

function CompatibilityBadge({ compatibility }) {
  if (!compatibility) return null;
  const { Badge } = window.UI;
  const text = String(compatibility);
  const truncated = text.length > COMPATIBILITY_TRUNCATE_LENGTH
    ? `${text.slice(0, COMPATIBILITY_TRUNCATE_LENGTH)}…`
    : text;
  // 단일 Badge SoT 로 통합 — info tone 은 .pill shell(neutral 유지)이 아니라 선행 Icon 이 운반
  //   (icon=true → TONE_ICON.info). title 이 full 텍스트를 보존(트렁케이트 라벨 보완).
  return (
    <Badge role="status" tone="info" icon title={`Requires: ${text}`} className="agent-compatibility-badge">
      {truncated}
    </Badge>
  );
}

function CompatibilityDetailBlock({ compatibility }) {
  if (!compatibility) return null;
  return (
    <div className="mb-4 agent-compatibility-detail">
      <div className="fs-meta font-mono text-faint uppercase tracking-wider mb-2">Requires</div>
      <div className="rounded-md border border-info/30 bg-info/[0.06] px-3 py-2 fs-body leading-relaxed text-dim">
        {compatibility}
      </div>
    </div>
  );
}

// LatencyBars (col-span-full) — 단일 바에 P50(불투명)/P95(0.65)/P99(0.35) 3-레이어 absolute 포지셔닝.
// max = 표시 대상 p99 최대값으로 동적 정규화 (정적 고정 대비 분포 폭 다양 → 시각감 우수).

const LATENCY_DISPLAY_LIMIT = 12;

function LatencyBarsCard({ state, days, onRetry }) {
  const { CardHead } = window.UI;
  return (
    <div className="card h-full flex flex-col min-h-0">
      <CardHead title="Response time" sub={`p50 / p95 / p99 · last ${Math.min(days, 30)} days · top ${LATENCY_DISPLAY_LIMIT} agents by p95`}/>
      <div className="card-body" style={CARD_BODY_FLEX_SCROLL_STYLE}>
        <LatencyBarsBody state={state} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function LatencyBarsBody({ state, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonAg height={280} aria-label="Loading response times"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerAg title="Couldn't load response times" detail={state.error} onRetry={onRetry}/>;
  }
  // P50/P95/P99 모두 null = 페어링 없음 → 렌더 제외 (시각 스펙 보존).
  const agents = (readyData(state)?.agents ?? [])
    .filter((a) => a.p50_ms != null && a.p95_ms != null && a.p99_ms != null)
    .sort((a, b) => (Number(b.p95_ms) || 0) - (Number(a.p95_ms) || 0))
    .slice(0, LATENCY_DISPLAY_LIMIT);
  if (agents.length === 0) {
    return <EmptyStateAg message="No paired response-time data (no Start↔Stop events)."/>;
  }
  return <LatencyBars agents={agents}/>;
}

// P50/P95/P99 시각 driver — opacity descending (P99 가장 옅게 = 배경 layer).
// 3-layer 시각 마커: div[style*='opacity'] 3개.
const LATENCY_LAYERS = [
  { key: 'p99', label: 'P99', field: 'p99_ms', opacity: 0.35 },
  { key: 'p95', label: 'P95', field: 'p95_ms', opacity: 0.65 },
  { key: 'p50', label: 'P50', field: 'p50_ms', opacity: 1    },
];

function LatencyBars({ agents }) {
  const { AgentBadge } = window.UI;
  // 동적 max — p99 outlier 가 50배 격차일 수 있으므로 정적 50000ms 대신 적응 normalize.
  const maxMs = agents.reduce((m, a) => Math.max(m, Number(a.p99_ms) || 0), 0) || 1;

  return (
    <div className="latency-bars space-y-3">
      {agents.map((a) => {
        const p50 = Number(a.p50_ms) || 0;
        const p95 = Number(a.p95_ms) || 0;
        const p99 = Number(a.p99_ms) || 0;
        return (
          <div key={a.agent_id} className="fs-body">
            <div className="flex items-center gap-2 mb-1.5">
              <AgentBadge a={{ id: a.agent_id, name: a.agent_name }} size={18}/>
              <span className="flex-1 truncate">{a.agent_name}</span>
              <span className="font-mono text-faint fs-micro">P95 {formatDurationMsAg(p95)}</span>
            </div>
            <div
              className="h-2.5 bg-sunken rounded-full relative overflow-hidden"
              aria-label={`p50 ${formatDurationMsAg(p50)}, p95 ${formatDurationMsAg(p95)}, p99 ${formatDurationMsAg(p99)}`}>
              {LATENCY_LAYERS.map((layer) => (
                <div
                  key={layer.key}
                  className="absolute h-full bg-info rounded-full"
                  style={{ width: `${((Number(a[layer.field]) || 0) / maxMs) * 100}%`, opacity: layer.opacity }}
                />
              ))}
            </div>
          </div>
        );
      })}
      <div className="flex gap-3 mt-2 fs-micro text-faint pt-2 border-t border-line">
        {LATENCY_LAYERS.slice().reverse().map((layer) => (
          <span key={layer.key} className="flex items-center gap-1">
            <span className="w-2 h-2 bg-info rounded-full" style={{ opacity: layer.opacity }}/>
            {layer.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// AgentDetailDrawer (우측 슬라이드인) — DetailModal(outcomes.jsx) 미러. DetailSurface variant=drawer 위임:
// focus-trap · scroll-lock · 3 닫기(X·Esc·backdrop) · nav(ArrowUp/Down + Prev/Next) 상속.
// 5 섹션 (Overview hero / Performance / Reliability / Quality signals / Recent) — 각 섹션 독립 degrade.
// Overview hero 가 단일 verdict + 단일 success-rate 소유 (중복 success-rate 폐지) · 섹션 간 top-hairline 리듬.
// 푸터 Delete 는 origin:user 만 노출 → 같은 surface 안 typed-name confirm 서브상태로 비가역 삭제 게이트.

function AgentDetailDrawer({
  drawerAgent, sortedAgents, summaryState, revisionState, reviewByAgentState,
  latencyState, successState, failureState, lifecycleState,
  detailState, blockedState, recentState, trendByAgent, failureByAgent,
  days, onClose, onNav, onRetry, onDeleted,
}) {
  const { DetailSurface, AgentBadge, StatusDot } = window.UI;

  // summary 행에서 선택 agent 도출 — 모든 섹션의 1차 소스. 미발견 시 id 만으로 헤더 표시.
  const agent = (readyData(summaryState)?.agents ?? []).find((a) => a.agent_id === drawerAgent) || null;
  const agentName = agent?.agent_name || drawerAgent;

  // 삭제 서브상태 — confirming = typed-name 패널 노출 · confirmText 일치 시에만 커밋 · committing/error 표시.
  // origin:user 만 진입 가능 (footer 버튼 게이트). 일치 + 성공 시 onDeleted 로 부모가 drawer 닫고 refetch.
  const [confirming, setConfirming] = useStateAg(false);
  const [confirmText, setConfirmText] = useStateAg('');
  const [committing, setCommitting] = useStateAg(false);
  const [deleteError, setDeleteError] = useStateAg(null);

  // nav 어댑터 — DetailModal 의 rows-index 패턴 미러 (현재 정렬된 행 위 위치 도출).
  const idx = sortedAgents.findIndex((a) => a.agent_id === drawerAgent);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < sortedAgents.length - 1;

  const statusTone = agent ? mapStatusToTone(agent.status) : 'info';
  const isDeletable = agent?.origin === 'user';

  // name-row health verdict — Overview hero 와 동일 entry/verdict SoT 공유 (양 badge site 일관).
  // R1 low-N 억제: outcome 표본 < LOW_N_MIN → "No signal" neutral verdict.
  const healthRanking = useMemoAg(
    () => buildQualityHealthRanking(
      readyData(revisionState)?.rows ?? [],
      readyData(reviewByAgentState)?.rows ?? [],
      Number.MAX_SAFE_INTEGER,
    ),
    [revisionState, reviewByAgentState],
  );
  const headerHealthEntry = healthRanking.find((a) => a.agent === drawerAgent) || null;
  const headerHasSignal = !!headerHealthEntry && headerHealthEntry.totalRevisions >= window.UI.LOW_N_MIN;

  const title = (
    <span className="flex items-center gap-2 flex-wrap">
      <AgentBadge a={{ id: drawerAgent, name: agentName }} size={20}/>
      {agentName}
      <StatusDot status={statusTone}/>
      <QualityHealthVerdictPill entry={headerHealthEntry} hasSignal={headerHasSignal}/>
    </span>
  );
  const sub = `agent.${drawerAgent}`;

  const startConfirm = () => {
    setDeleteError(null);
    setConfirmText('');
    setConfirming(true);
  };
  const cancelConfirm = () => {
    setConfirming(false);
    setConfirmText('');
    setDeleteError(null);
  };

  const runDelete = async () => {
    if (committing || confirmText !== agentName) return;
    setCommitting(true);
    setDeleteError(null);
    try {
      const data = await sendAgentAg('DELETE', `/api/agents/${encodeURIComponent(agentName)}`, {
        mode: 'commit',
        name: agentName,
        confirm: confirmText,
      });
      if (data && data.result === 'deleted') {
        onDeleted(agentName);
        return;
      }
      // refused / rolled_back / recovery_needed — 비-deleted 결과는 사유 노출 후 drawer 유지.
      setDeleteError(formatDeleteFailureAg(data));
    } catch (err) {
      setDeleteError(messageOfAg(err));
    } finally {
      setCommitting(false);
    }
  };

  // 푸터 — confirm 서브상태 진입 전/후로 액션 세트 전환 (nav 는 surface 가 별도 슬롯에 승격).
  const footer = confirming ? (
    <>
      <div className="fs-meta text-dim font-mono mr-auto">Type the name to delete</div>
      <button className="btn ghost sm" onClick={cancelConfirm} disabled={committing} aria-label="Cancel delete">Cancel</button>
      <button
        className="btn danger sm"
        onClick={runDelete}
        disabled={committing || confirmText !== agentName}
        aria-label="Confirm and delete the agent (moves files to Trash, prunes the system wiring)">
        {committing ? 'Deleting…' : 'Confirm & delete'}
      </button>
    </>
  ) : (
    <>
      <div className="fs-meta text-dim font-mono mr-auto">
        {idx >= 0 ? `${idx + 1} of ${sortedAgents.length} agents` : 'not in the current list'}
      </div>
      {isDeletable && (
        <button className="btn danger sm" onClick={startConfirm} aria-label={`Delete ${agentName}`}>Delete</button>
      )}
      <button className="btn sm primary" onClick={onClose} aria-label="Close">Close</button>
    </>
  );

  return (
    <DetailSurface
      open
      onClose={onClose}
      variant="drawer"
      title={title}
      sub={sub}
      nav={confirming ? undefined : { onPrev: () => onNav('prev'), onNext: () => onNav('next'), hasPrev, hasNext }}
      footer={footer}>
      {confirming ? (
        <AgentDeleteConfirmPanel
          agentName={agentName}
          value={confirmText}
          committing={committing}
          error={deleteError}
          onChange={setConfirmText}
        />
      ) : (
        <div className="space-cards">
          <AgentDrawerSection title="Overview">
            <AgentOverviewSection
              agent={agent}
              drawerAgent={drawerAgent}
              summaryState={summaryState}
              revisionState={revisionState}
              reviewByAgentState={reviewByAgentState}
              onRetry={onRetry}
            />
          </AgentDrawerSection>
          <AgentDrawerSection title="Performance">
            <AgentPerformanceSection
              agent={agent}
              drawerAgent={drawerAgent}
              summaryState={summaryState}
              latencyState={latencyState}
              revisionState={revisionState}
              reviewByAgentState={reviewByAgentState}
              trendByAgent={trendByAgent}
              onRetry={onRetry}
            />
          </AgentDrawerSection>
          <AgentDrawerSection title="Reliability">
            <AgentReliabilitySection
              agent={agent}
              drawerAgent={drawerAgent}
              failureByAgent={failureByAgent}
              failureState={failureState}
              detailState={detailState}
              blockedState={blockedState}
              lifecycleState={lifecycleState}
              days={days}
              onRetry={onRetry}
            />
          </AgentDrawerSection>
          <AgentDrawerSection title="Quality signals">
            <AgentQualitySignalsSection
              drawerAgent={drawerAgent}
              revisionState={revisionState}
              reviewByAgentState={reviewByAgentState}
              onRetry={onRetry}
            />
          </AgentDrawerSection>
          <AgentDrawerSection title="Recent activity">
            <AgentRecentActivitySection recentState={recentState} days={days} onRetry={onRetry}/>
          </AgentDrawerSection>
        </div>
      )}
    </DetailSurface>
  );
}

// typed-name 삭제 확인 패널 — drawer 본문 서브상태.
// full name 정확 일치 시에만 푸터 커밋 버튼 활성 (비가역 작업 게이트는 푸터가 소유 · 여기선 입력+공시).
function AgentDeleteConfirmPanel({ agentName, value, committing, error, onChange }) {
  const { Icon } = window.UI;
  const matches = value === agentName;
  return (
    <div className="space-y-4">
      <div
        role="note"
        className="rounded-md border p-3 flex items-start gap-3"
        style={{ background: 'rgb(var(--warn) / 0.08)', borderColor: 'rgb(var(--warn) / 0.4)' }}>
        <Icon name="warn" size={16} className="text-warn mt-0.5 shrink-0"/>
        <div className="fs-meta text-dim leading-relaxed">
          <span className="font-medium text-ink">This removes a real agent.</span>{' '}
          Moves <span className="font-mono text-ink">{agentName}</span>'s file to the Trash and unwires it from the system.
        </div>
      </div>

      <div>
        <div className="fs-meta font-medium text-ink">Type the agent name to confirm</div>
        <div className="fs-meta text-faint mt-0.5 mb-1">
          Type <span className="font-mono text-ink">{agentName}</span> exactly
        </div>
        <input
          type="text"
          className={`field field--mono${value.length > 0 && !matches ? ' is-error' : ''}`}
          value={value}
          placeholder={agentName}
          disabled={committing}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Type the agent name to confirm deletion"
        />
        {value.length > 0 && !matches && (
          <div className="fs-meta text-crit mt-1">That doesn't match the agent name yet</div>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-crit/40 bg-crit/[0.08] px-3 py-2.5 fs-meta text-dim">
          <span className="font-medium text-crit">Delete failed.</span> {error}
        </div>
      )}
    </div>
  );
}

// 드로어 섹션 래퍼 — 공용 SubCard(ring + 16px padding + uppercase --dim 라벨) 로 5 섹션을 각각
// 독립 면으로 분리 (1px-hairline 합쳐보임 해소 #region). SubCard 가 라벨/패딩/면 idiom 단일 소유.
function AgentDrawerSection({ title, children }) {
  const { SubCard } = window.UI;
  return (
    <section>
      <SubCard label={title}>{children}</SubCard>
    </section>
  );
}

// 드로어 섹션 공통 degrade primitive — skeleton / inline-error-retry / dashed-empty.
// 섹션마다 status 기반으로 호출, 한 섹션 실패가 다른 섹션을 blank 시키지 않도록 독립 적용.

function DrawerSectionSkeleton({ rows = 2, label }) {
  return (
    <div aria-busy="true" aria-label={label} className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-7 bg-sunken rounded-md" style={{ animation: 'skelPulseAg 1.4s ease-in-out infinite' }}/>
      ))}
    </div>
  );
}

function DrawerSectionEmpty({ message }) {
  return (
    <div className="rounded-md border border-dashed border-line px-3 py-3 fs-meta font-mono text-faint">
      {message}
    </div>
  );
}

// Self-explaining health verdict (R4) — tooltip 없이도 의미 완결: glyph+word + 지배 driver phrase + raw index.
// hasSignal=false (R1 low-N 억제 또는 entry 부재) → "No signal" neutral verdict (수치/driver 없음).
// 양 badge site(Overview hero · drawer header name-row) 공유 → verdict 문구 단일 SoT.
//   shape/tone 은 공용 Badge(role=status)가 소유 — 본 wrapper 는 verdict label+driver+index 산출만 담당.
function QualityHealthVerdictPill({ entry, hasSignal }) {
  const { Badge } = window.UI;
  if (!hasSignal) {
    return <Badge role="status" tone="neutral">No signal</Badge>;
  }
  const verdict = qualityHealthVerdict(entry.healthIndex);
  const driver = qualityHealthDriverPhrase(entry.dominantDriver);
  const indexPct = (entry.healthIndex * 100).toFixed(0);
  return (
    <Badge role="status" tone={verdict.tone}>
      {verdict.label}
      {driver && <span className="opacity-80"> · {driver}</span>}
      <span className="opacity-70"> · {indexPct}</span>
    </Badge>
  );
}

// 라벨/값 한 줄 — Identity·Lifecycle 의 메타 나열 공통.
// 라벨 = proportional(mono 아님, #6a) · 값 = mono+tnum 으로 자릿수 정렬 (#5c).
function DrawerInfoRow({ label, value, title }) {
  return (
    <div className="flex items-start justify-between gap-3 fs-body" title={title}>
      <span className="fs-meta text-faint shrink-0">{label}</span>
      <span className="text-dim text-right min-w-0 break-words font-mono tnum">{value}</span>
    </div>
  );
}

// 1. Overview (hero) — identity + 단일 health verdict + 단일 success-rate hero number (디자인 #46399 §4.3).
// success-rate 는 패널 전체에서 단 한 번 (Performance 의 중복 박스 폐지) · 비용/모델 disclaimer 는 섹션 끝으로 후퇴.
// health index 는 buildQualityHealthRanking(공식 1−(0.6×min(1,revision÷0.5)+0.4×review_flag)) — peer-independent 절대 척도.
function AgentOverviewSection({ agent, drawerAgent, summaryState, revisionState, reviewByAgentState, onRetry }) {
  const { formatPctWithDenominator, LOW_N_MIN, Pill, BulletBar, Badge } = window.UI;

  // health entry 는 revision/review fetch 페어 — summary 와 독립 degrade. summary 에러는 hero 자체를 막음.
  const ranking = useMemoAg(
    () => buildQualityHealthRanking(
      readyData(revisionState)?.rows ?? [],
      readyData(reviewByAgentState)?.rows ?? [],
      Number.MAX_SAFE_INTEGER,
    ),
    [revisionState, reviewByAgentState],
  );

  if (summaryState.status === 'loading') {
    return <DrawerSectionSkeleton rows={3} label="Loading overview"/>;
  }
  if (summaryState.status === 'error') {
    return <ErrorBannerAg title="Couldn't load overview" detail={summaryState.error} onRetry={onRetry}/>;
  }
  if (!agent) {
    return <DrawerSectionEmpty message={`No summary row for ${drawerAgent} in this window.`}/>;
  }

  const statusTone = mapStatusToTone(agent.status);
  const lastRun = agent.last_run_at ? formatRelativeTimeAg(agent.last_run_at) : '—';
  const phaseLabel = agent.dual_phase ? 'dual-phase' : 'single-phase';

  // 단일 success-rate hero — Performance 의 분모 산식 동일 (needs_context 제외).
  const successPct = Number(agent.success_pct) || 0;
  const needsContextCount = Number(agent.needs_context_count) || 0;
  const successDenominator = Math.max(0, (Number(agent.runs) || 0) - needsContextCount);
  const successNumerator = Math.round((successPct / 100) * successDenominator);
  const successTone = successDenominator > 0 ? successRateTone(successPct) : 'text-faint';

  // 단일 health verdict — buildQualityHealthRanking entry 의 verdict + dominantDriver inline 노출 (R4).
  // R1 low-N 억제: outcome 표본 < LOW_N_MIN → entry 무시하고 기존 "No signal" neutral verdict.
  const healthEntry = ranking.find((a) => a.agent === drawerAgent) || null;
  const healthSampleN = healthEntry ? healthEntry.totalRevisions : 0;
  const healthHasSignal = !!healthEntry && healthSampleN >= LOW_N_MIN;
  const healthIndex = healthEntry ? healthEntry.healthIndex : null;
  const healthPct = healthHasSignal ? (healthIndex * 100).toFixed(0) : '—';

  return (
    <div className="space-y-3">
      {/* 식별(이름·뱃지·verdict)은 항상-노출 헤더가 단독 소유 — hero 는 고유 KPI 로 직행 (중복 제거 #dup).
          at-a-glance — success-rate hero(지배 수치, 비대칭 2fr) + health index(축소 보조 1fr).
          두 박스 동일 DetailMetric chrome 공유 → hero 는 값 크기로만 차별 (#3 twin 통합). */}
      <DetailMetric
        label="Success rate"
        tone={successTone}
        hero
        value={<>
          {formatPctWithDenominator(successNumerator, successDenominator)}
        </>}
      />

      {/* role-description 단락 = body anchor (proportional, mono 아님). 부재 시 status 라인의
          em-dash 로 축약 — 빈 박스로 면적을 차지하지 않음 (#4 recession = AREA). */}
      {agent.description && (
        <div className="fs-body text-dim leading-relaxed truncate" title={agent.description}>{agent.description}</div>
      )}

      {/* status + last-run 1 메타 라인. 설명 부재 → 같은 줄 끝에 조용한 em-dash 로 신호 (#4). */}
      <div className="fs-meta font-mono text-dim">
        {agent.status || 'unknown'} · active <span title={agent.last_run_at || undefined}>{lastRun}</span>
        {!agent.description && (
          <span className="text-faint" title="No role description in the agent .md frontmatter."> · — no role description</span>
        )}
      </div>

      <CompatibilityDetailBlock compatibility={agent.compatibility}/>

      {/* config 한 줄 — dual-phase + origin pill. 부재 데이터(origin unknown)는 dashed muted 변형으로
          present 데이터보다 조용하게 (#4). pill 은 base .pill(11px) 통일 (fs-micro override 제거, #5b). */}
      <div className="flex items-center gap-2 flex-wrap">
        <Pill tone="neutral">{phaseLabel}</Pill>
        {agent.origin ? (
          <Pill tone="neutral">origin: {agent.origin}</Pill>
        ) : (
          <Badge role="metadata" absent title="Agent origin (agent-registry.json) — not recorded">origin: unknown</Badge>
        )}
      </div>
    </div>
  );
}

// 4. Quality signals (was "Health summary", #2→#4 강등 — verdict 는 hero 가 소유, 여기엔 중복 pill 없음).
// rework 분포 + review_flag 비율 + 공식 caption(끝 muted). buildQualityHealthRanking 동일 entry 재사용.
function AgentQualitySignalsSection({ drawerAgent, revisionState, reviewByAgentState, onRetry }) {
  const ranking = useMemoAg(
    () => buildQualityHealthRanking(
      readyData(revisionState)?.rows ?? [],
      readyData(reviewByAgentState)?.rows ?? [],
      Number.MAX_SAFE_INTEGER,
    ),
    [revisionState, reviewByAgentState],
  );

  const bothLoading = revisionState.status === 'loading' && reviewByAgentState.status === 'loading';
  const bothError = revisionState.status === 'error' && reviewByAgentState.status === 'error';
  if (bothLoading) {
    return <DrawerSectionSkeleton rows={2} label="Loading quality signals"/>;
  }
  if (bothError) {
    return (
      <ErrorBannerAg
        title="Couldn't load quality signals"
        detail={revisionState.error || reviewByAgentState.error}
        onRetry={onRetry}
      />
    );
  }

  const entry = ranking.find((a) => a.agent === drawerAgent) || null;
  if (!entry) {
    return <DrawerSectionEmpty message="No revision/review_flag signal for this agent."/>;
  }

  const { Bar } = window.UI;
  const flagRatio = entry.reviewFlagRatio;
  const flagPct = (flagRatio * 100).toFixed(1);
  // high-when-bad 지표 — 낮은 비율은 neutral(녹색 불필요), 높을수록 warn→crit.
  const flagBarTone = flagRatio >= 0.5 ? 'crit' : flagRatio >= 0.25 ? 'warn' : 'neutral';

  return (
    <div className="space-y-3">
      {/* 두 info-row = tight pair → 8px (space-y-2, 4-multiple, #5a). */}
      <div className="space-y-2">
        <DrawerInfoRow
          label="reworks"
          value={`${formatIntAg(entry.totalRevisions)} (avg ${entry.avgRevision.toFixed(2)})`}
          title="revision_count weighted average — higher means more user-requested rework"
        />
        <DrawerInfoRow
          label="review_flag rate"
          value={`${flagPct}%`}
          title="share of outcomes auto-flagged for review"
        />
        {/* review_flag-rate 비례 막대 — 위 텍스트(Track B driver) 유지한 채 % shape 보강. */}
        <Bar
          value={flagRatio}
          tone={flagBarTone}
          ariaLabel={`review_flag rate ${flagPct}%`}
        />
      </div>
      <RevisionInlineMiniBar buckets={entry.buckets} total={entry.totalRevisions}/>
    </div>
  );
}

// 2. Performance — RED-method 단일 agent 뷰. success-rate 는 hero 가 소유 → 여기선 중복 박스 폐지.
// runs/launches/needs-info/P95 2-col + latency p50/p95/p99 (허용된 단일 3-up 예외) + 7일 추세.
function AgentPerformanceSection({ agent, drawerAgent, summaryState, latencyState, trendByAgent, onRetry }) {
  const { MiniBars } = window.UI;
  if (summaryState.status === 'loading') {
    return <DrawerSectionSkeleton rows={3} label="Loading performance"/>;
  }
  if (summaryState.status === 'error') {
    return <ErrorBannerAg title="Couldn't load performance" detail={summaryState.error} onRetry={onRetry}/>;
  }
  if (!agent) {
    return <DrawerSectionEmpty message="No performance data for this agent in the window."/>;
  }

  const successPct = Number(agent.success_pct) || 0;
  const needsContextCount = Number(agent.needs_context_count) || 0;
  const invocations = agent.invocations !== undefined ? agent.invocations : agent.invocations_30d;

  // latency 행 (p50/p95/p99) — 미페어 시 error/empty 독립 표기.
  const latency = (readyData(latencyState)?.agents ?? []).find((a) => a.agent_id === drawerAgent) || null;
  const p95Sec = latency?.p95_ms != null ? Number(latency.p95_ms) / 1000 : null;
  const p95Display = p95Sec == null ? '—' : formatDurationSecAg(p95Sec);
  const trend = trendByAgent ? trendByAgent.get(drawerAgent) : null;
  const hasTrend = Array.isArray(trend) && trend.length > 0;

  return (
    <div className="space-y-3">
      {/* 단일 2-col 리듬 — success-rate 박스 제거 (hero 소유). */}
      <div className="grid grid-cols-2 gap-3">
        <DetailMetric label="Total runs" value={formatIntAg(agent.runs)}/>
        <DetailMetric label="Launches" value={invocations == null ? '—' : formatIntAg(invocations)}/>
        <DetailMetric label="Needs info" value={formatIntAg(needsContextCount)}/>
        <DetailMetric label="P95" value={p95Display}/>
      </div>

      <AgentLatencyRow latency={latency} state={latencyState} onRetry={onRetry}/>

      {/* 7일 성공-기반 추세 — 데이터 없으면 미렌더 (추정값 주입 금지). */}
      <div>
        <div className="fs-meta font-mono text-faint mb-2">7-day trend</div>
        {hasTrend ? (
          <MiniBars data={trend} w={120} h={28} color={trendBarColor(agent.status, successPct)}/>
        ) : (
          <DrawerSectionEmpty message="No 7-day daily breakdown."/>
        )}
      </div>
    </div>
  );
}

// latency p50/p95/p99 한 줄 — 페어링 없으면 inline empty (Performance 내부 독립 degrade).
function AgentLatencyRow({ latency, state, onRetry }) {
  if (state.status === 'loading') {
    return <DrawerSectionSkeleton rows={1} label="Loading latency"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerAg title="Couldn't load latency" detail={state.error} onRetry={onRetry}/>;
  }
  if (!latency || (latency.p50_ms == null && latency.p95_ms == null && latency.p99_ms == null)) {
    return <DrawerSectionEmpty message="No paired response-time data (no Start↔Stop events)."/>;
  }
  const fmt = (ms) => ms == null ? '—' : formatDurationMsAg(ms);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <DetailMetric label="P50" value={fmt(latency.p50_ms)}/>
        <DetailMetric label="P95" value={fmt(latency.p95_ms)}/>
        <DetailMetric label="P99" value={fmt(latency.p99_ms)}/>
      </div>
      {/* typical/slow/worst spread 를 shape 로 — 3 숫자 비교 대신 막대 폭(LatencyBars 재사용). */}
      <LatencyBars agents={[latency]}/>
    </div>
  );
}

// 3. Reliability — Failures + Lifecycle 를 한 섹션 두 sub-block 으로 병합 (hairline 분리, 디자인 #46399 §4.3).
// (a) Breakages = headline pill + Failed/Blocked 2-col + last-breakage + top-concerns + keyword 분류(끝 muted 강등).
// (b) Lifecycle = unfinished pill + Started/Finished 2-col + duration triplet 1 mono 라인 (2번째 3-box grid 폐지).
function AgentReliabilitySection({ agent, drawerAgent, failureByAgent, failureState, detailState, blockedState, lifecycleState, days, onRetry }) {
  // 단일 separator 전략 (#6b) — top-hairline 은 AgentDrawerSection 경계에만. 두 sub-block 은
  // 순수 spacing(space-y-5=20px)으로 분리, 내부 border-t 폐지 (divider 어휘 하나).
  return (
    <div className="space-y-5">
      <AgentReliabilityBreakages
        drawerAgent={drawerAgent}
        failureByAgent={failureByAgent}
        failureState={failureState}
        detailState={detailState}
        blockedState={blockedState}
        days={days}
        onRetry={onRetry}
      />
      <AgentReliabilityLifecycle
        agent={agent}
        drawerAgent={drawerAgent}
        lifecycleState={lifecycleState}
        onRetry={onRetry}
      />
    </div>
  );
}

// (a) Breakages — failure-patterns(필터) 요약 + 기존 MergedBreakageSection(fail/blocked 키워드 분류) 재사용.
function AgentReliabilityBreakages({ drawerAgent, failureByAgent, failureState, detailState, blockedState, days, onRetry }) {
  const { Badge } = window.UI;
  if (failureState.status === 'loading') {
    return <DrawerSectionSkeleton rows={2} label="Loading failures"/>;
  }
  if (failureState.status === 'error') {
    return <ErrorBannerAg title="Couldn't load failure patterns" detail={failureState.error} onRetry={onRetry}/>;
  }

  const failure = failureByAgent ? failureByAgent.get(drawerAgent) : null;
  // failure-patterns row 의 top_concerns — failureByAgent map 은 미보유 → 원본 rows 에서 직접 조회.
  const raw = (readyData(failureState)?.rows ?? []).find((r) => r.agent === drawerAgent) || null;
  const topConcerns = Array.isArray(raw?.top_concerns) ? raw.top_concerns : [];

  return (
    <div className="space-y-3">
      <div className="fs-meta font-mono text-faint mb-1">Breakages</div>
      {failure && failure.total_breakages > 0 ? (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge role="status" tone={failure.breakage_rate > BREAKAGE_RATE_CRIT_THRESHOLD ? 'crit' : 'warn'}>
              {formatIntAg(failure.total_breakages - (failure.reconstructed || 0))} breakages · {(failure.breakage_rate * 100).toFixed(1)}%
            </Badge>
            {failure.reconstructed > 0 && (
              <span
                className="fs-micro font-mono"
                style={{ color: 'rgb(var(--faint))' }}
                title="Harness-reconstructed records (recovery artifacts) excluded from the writer-emitted breakage headline">
                ↺ {formatIntAg(failure.reconstructed)} reconstructed
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <DetailMetric label="Failed" value={formatIntAg(failure.fail_count)}/>
            <DetailMetric label="Blocked" value={formatIntAg(failure.blocked_count)}/>
          </div>
          <DrawerInfoRow
            label="last breakage"
            value={failure.last_breakage_at ? formatRelativeTimeAg(failure.last_breakage_at) : '—'}
            title={failure.last_breakage_at || undefined}
          />
          {topConcerns.length > 0 && (
            <div>
              <div className="fs-meta font-mono text-faint mb-2">Top concerns</div>
              <div className="flex flex-col gap-2">
                {topConcerns.map((c, i) => (
                  <div key={i} className="fs-body text-dim rounded border border-line px-2 py-1 leading-snug">{c}</div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <DrawerSectionEmpty message={`No fail or blocked outcomes in the last ${days} days.`}/>
      )}

      {/* fail/blocked 키워드 원인 분류 — 기존 컴포넌트 재사용. */}
      <MergedBreakageSection
        detailState={detailState}
        blockedState={blockedState}
        days={days}
        onRetry={onRetry}
      />
    </div>
  );
}

// (b) Lifecycle — lifecycle-stats(agent_type 필터) start/completed gap + duration 분포(1 mono 라인 collapse).
function AgentReliabilityLifecycle({ agent, drawerAgent, lifecycleState, onRetry }) {
  if (lifecycleState.status === 'loading') {
    return <DrawerSectionSkeleton rows={2} label="Loading lifecycle"/>;
  }
  if (lifecycleState.status === 'error') {
    return <ErrorBannerAg title="Couldn't load lifecycle stats" detail={lifecycleState.error} onRetry={onRetry}/>;
  }

  // agent_type == agent_id == drawerAgent (현 cycle convention).
  const row = (readyData(lifecycleState)?.rows ?? []).find((r) => r.agent_type === drawerAgent) || null;
  const lastRun = agent?.last_run_at ? formatRelativeTimeAg(agent.last_run_at) : '—';

  if (!row) {
    return (
      <div className="space-y-3">
        <div className="fs-meta font-mono text-faint mb-1">Lifecycle</div>
        <DrawerInfoRow label="last active" value={lastRun} title={agent?.last_run_at || undefined}/>
        <DrawerSectionEmpty message="No SubagentStart/Stop lifecycle events for this agent."/>
      </div>
    );
  }

  const { BulletBar, Badge } = window.UI;
  const startCount = Number(row.start_count) || 0;
  const completedCount = Number(row.completed_count) || 0;
  const orphans = Math.max(0, startCount - completedCount);
  const orphanRatio = startCount > 0 ? orphans / startCount : 0;
  const orphanTone = orphanRatio >= ORPHAN_RATIO_CRIT_THRESHOLD ? 'crit'
    : orphanRatio >= ORPHAN_RATIO_WARN_THRESHOLD ? 'warn' : 'ok';
  // finished/started 비율 — orphanTone(누수 심각도)을 fill 톤으로 재사용, BulletBar 의 shape 보강.
  const finishedRatio = startCount > 0 ? completedCount / startCount : 0;

  const fmtDur = (sec) => sec == null ? '—' : formatDurationSecAg(sec);

  return (
    <div className="space-y-3">
      <div className="fs-meta font-mono text-faint mb-1">Lifecycle</div>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge role="status" tone={orphanTone}>
          {formatIntAg(orphans)} unfinished · {(orphanRatio * 100).toFixed(0)}%
        </Badge>
      </div>
      {/* started 대비 finished 비례 막대 — 비율 숫자 옆 완주율 shape (높을수록 누수 적음). */}
      {startCount > 0 && (
        <BulletBar
          value={finishedRatio}
          tone={orphanTone}
          ariaLabel={`finished ${completedCount} of started ${startCount} (${(finishedRatio * 100).toFixed(0)}%)`}
        />
      )}
      {/* 단일 2-col — Started/Finished (2번째 3-box grid 폐지). */}
      <div className="grid grid-cols-2 gap-3">
        <DetailMetric label="Started" value={formatIntAg(startCount)}/>
        <DetailMetric label="Finished" value={formatIntAg(completedCount)}/>
      </div>
      {/* duration triplet — 3-box grid 대신 1 mono 라인 (tnum 자릿수 정렬, #5c). */}
      <div className="fs-meta font-mono text-dim tnum">
        avg {fmtDur(row.avg_duration_sec)} · p95 {fmtDur(row.p95_duration_sec)} · max {fmtDur(row.max_duration_sec)}
      </div>
    </div>
  );
}

// 5. Recent activity — 드로어 열림 시 fetch 한 per-agent 최신 outcomes (result dual-encoded).
function AgentRecentActivitySection({ recentState, days, onRetry }) {
  if (recentState.status === 'idle' || recentState.status === 'loading') {
    return <DrawerSectionSkeleton rows={3} label="Loading recent activity"/>;
  }
  if (recentState.status === 'error') {
    return <ErrorBannerAg title="Couldn't load recent activity" detail={recentState.error} onRetry={onRetry}/>;
  }
  const rows = readyData(recentState)?.rows ?? [];
  if (rows.length === 0) {
    return <DrawerSectionEmpty message="No outcomes recorded for this agent."/>;
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <RecentActivityRow key={r.id} row={r}/>
      ))}
    </div>
  );
}

// result → tone+glyph dual-encoding (resultToneO 매핑과 동일 의미 · TONE_GLYPH 글리프).
function resultToneAg(result) {
  if (result === 'done') return 'ok';
  if (result === 'done_with_concerns') return 'warn';
  if (result === 'blocked') return 'info';
  if (result === 'needs_context') return 'info';
  if (result === 'fail') return 'crit';
  return 'neutral';
}

function RecentActivityRow({ row }) {
  const { Badge } = window.UI;
  const revision = Number(row.revision_count) || 0;
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-line px-3 py-2 fs-body">
      <div className="flex items-center gap-2 min-w-0">
        <Badge role="status" tone={resultToneAg(row.result)}>{row.result}</Badge>
        <span className="font-mono fs-meta text-dim truncate">{row.task_type}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0 fs-micro font-mono text-faint tnum">
        {row.confidence && <span title="confidence">{row.confidence}</span>}
        {revision > 0 && <span title="revision_count" className="text-warn">rev {revision}</span>}
        <span title={row.record_ts}>{formatRelativeTimeAg(row.record_ts)}</span>
      </div>
    </div>
  );
}

// 실패/차단 통합 sub-section — fail/blocked 2 fetch 를 카테고리 단위로 client merge.
// 비율 분모 = fail+blocked 합산 (per-fetch pct 는 합산 후 무의미 → count 로 재계산).
function MergedBreakageSection({ detailState, blockedState, days, onRetry }) {
  const { Icon } = window.UI;
  const merged = useMemoAg(
    () => mergeBreakageReasons(readyData(detailState), readyData(blockedState)),
    [detailState, blockedState],
  );

  const isLoading = [detailState, blockedState].some((s) => s.status === 'idle' || s.status === 'loading');
  const firstError = [detailState, blockedState].find((s) => s.status === 'error');

  return (
    <div>
      <div
        className="fs-meta font-mono text-faint mb-2 flex items-center gap-1"
        title="Combined result IN ('fail','blocked') — same scope as the summary Breakages column (needs_context excluded)">
        <Icon name="x" size={12}/>
        Why tasks failed · fail+blocked ({days}d)
      </div>
      {isLoading ? (
        <div aria-busy="true" className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-6 bg-sunken rounded-md" style={{ animation: 'skelPulseAg 1.4s ease-in-out infinite' }}/>
          ))}
        </div>
      ) : firstError ? (
        <ErrorBannerAg title="Couldn't load failure causes" detail={firstError.error} onRetry={onRetry}/>
      ) : (
        <MergedBreakageBody merged={merged} days={days}/>
      )}
    </div>
  );
}

function MergedBreakageBody({ merged, days }) {
  const { Icon } = window.UI;
  if (!merged || merged.total === 0) {
    return (
      <div className="rounded-md border border-dashed border-ok/40 px-3 py-3 fs-meta font-mono text-dim">
        No failed or blocked tasks in the last {days} days
      </div>
    );
  }

  return (
    <div>
      <div className="fs-micro font-mono text-dim mb-2">
        Total {formatIntAg(merged.total)} = <span className="text-crit inline-flex items-center gap-1"><Icon name="x" size={11}/>fail {formatIntAg(merged.failTotal)}</span> + <span className="text-info inline-flex items-center gap-1"><Icon name="info" size={11}/>blocked {formatIntAg(merged.blockedTotal)}</span>
      </div>
      <div className="space-y-2">
        {merged.reasons.map((r) => {
          const pct = merged.total > 0 ? (r.count / merged.total) * 100 : 0;
          return (
            <div key={r.category} className="fs-body">
              <div className="flex justify-between mb-1">
                <span className="font-mono">{r.category}</span>
                <span
                  className="font-mono text-dim tnum"
                  title={`fail ${r.failCount} + blocked ${r.blockedCount}`}>
                  {r.count} · {pct.toFixed(0)}%
                </span>
              </div>
              <div className="h-1.5 bg-sunken rounded-full overflow-hidden">
                <div className="h-full bg-crit/70" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}/>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// fail/blocked failure-reasons 응답 2건 → 카테고리 합산 merge.
// 응답별 pct 는 자기 분모 기준이라 폐기, count 합산 후 통합 분모로 재산출 (호출처).
function mergeBreakageReasons(failData, blockedData) {
  const byCategory = new Map();
  const addReasons = (data, side) => {
    const reasons = data?.reasons ?? [];
    for (const r of reasons) {
      if (!r || !r.category) continue;
      let entry = byCategory.get(r.category);
      if (!entry) {
        entry = { category: r.category, count: 0, failCount: 0, blockedCount: 0 };
        byCategory.set(r.category, entry);
      }
      const count = Number(r.count) || 0;
      entry.count += count;
      entry[side] += count;
    }
  };
  addReasons(failData, 'failCount');
  addReasons(blockedData, 'blockedCount');

  const failTotal    = Number(failData?.meta?.total_failures) || 0;
  const blockedTotal = Number(blockedData?.meta?.total_failures) || 0;
  const reasons = Array.from(byCategory.values()).sort((a, b) => b.count - a.count);
  return { reasons, failTotal, blockedTotal, total: failTotal + blockedTotal };
}

// 드로어 메트릭 타일 SoT — 모든 2-col/3-col 수치 박스 + Overview hero 가 공유하는 단일 chrome.
// 다크 인버전 회피: bg-sunken(panel elev 보다 어두워 구멍) 대신 panel-fill(elev) + ring (shadow-as-border,
//   base.css 다크 .card inset 하이라이트 idiom 정합). hero=true 면 값만 28px 로 키워 패널 단일 focal point.
// value 폰트: hero 28px(.hero-stat) / 일반 13px(.fs-title) — 3단 사다리(hero>metric>meta) 강제.
// 섹션 SubCard(bg-elev raised) 위에 얹히는 메트릭 타일 — bg-sunken 으로 한 단 들어간 면 → 타일 경계 확보.
function DetailMetric({ label, value, tone = '', hero = false }) {
  return (
    <div className="flex flex-col rounded-md p-3 bg-sunken ring-1 ring-line">
      <div className="fs-micro text-faint min-h-[2.5em] leading-tight">{label}</div>
      <div className={`font-mono font-semibold mt-0.5 tnum ${hero ? 'hero-stat' : 'fs-title'} ${tone}`}>{value}</div>
    </div>
  );
}

// Panel 1: Success-rate matrix (small multiples)

function SuccessRateMatrixCard({ state, days, onRetry }) {
  const { CardHead, Pill } = window.UI;

  const data = readyData(state);
  // 서버 SUCCESS_RATE_LIMIT 포화 (M8) — 행이 잘려 매트릭스 불완전 → silent 누락 대신 disclosure (cost.jsx 세션 분포 카드와 동일 규칙).
  const isTruncated = data?.truncated === true;
  const subText = `Last ${days} days`;

  return (
    <div className="card h-full flex flex-col min-h-0">
      <CardHead
        title="Success by agent and task type"
        sub={subText}
        right={
          <>
            {isTruncated && (
              <span title="Server row limit hit — matrix incomplete. Shorten the time range for complete data.">
                <Pill tone="warn">Row limit hit — some rows missing</Pill>
              </span>
            )}
          </>
        }
      />
      <div className="card-body ag-card-body">
        <SuccessRateMatrixBody state={state} days={days} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function SuccessRateMatrixBody({ state, days, onRetry }) {
  // Hooks 는 early return 이전에 실행.
  const matrix = useMemoAg(
    () => buildSuccessRateMatrix(readyData(state)?.rows ?? []),
    [state],
  );

  if (state.status === 'loading') {
    return <ChartSkeletonAg height={280} aria-label="Loading success matrix"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerAg title="Couldn't load success rates" detail={state.error} onRetry={onRetry}/>;
  }
  if (matrix.agents.length === 0) {
    return <EmptyStateAg message={`No success-rate events in the last ${days} days.`}/>;
  }

  return <SuccessRateMatrixTable matrix={matrix}/>;
}

// 35-agent 매트릭스 self-scroll — sticky thead + first column 정렬 유지.
const MATRIX_CORNER_TH_STYLE = {
  position: 'sticky', left: 0, top: 0, background: 'rgb(var(--elev))', minWidth: 140, zIndex: 2,
};
const MATRIX_HEADER_TH_STYLE = {
  position: 'sticky', top: 0, background: 'rgb(var(--elev))', minWidth: SPARK_WIDTH + 24, zIndex: 1,
};

function SuccessRateMatrixTable({ matrix }) {
  return (
    <>
      <SuccessRateLegend/>
      <div className="overflow-auto" style={{ flex: '1 1 auto', minHeight: 0 }}>
        <table className="w-full fs-meta font-mono" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              <th
                scope="col"
                className="text-left text-dim font-medium px-2 py-1.5 border-b border-line"
                style={MATRIX_CORNER_TH_STYLE}>
                Agent
              </th>
              {TASK_TYPE_COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className="text-center text-dim font-medium px-2 py-1.5 border-b border-line"
                  style={MATRIX_HEADER_TH_STYLE}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.agents.map((agent) => <SuccessRateMatrixRow key={agent} agent={agent} cells={matrix.cells}/>)}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SuccessRateMatrixRow({ agent, cells }) {
  // unknown row = PG fallback (legacy/deprecated) — opacity + sunken bg + italic 라벨로 시각 분리.
  const isUnknownAgent = agent === UNKNOWN_AGENT_ID;
  const labelCellBg = isUnknownAgent ? 'rgb(var(--sunken))' : 'rgb(var(--elev))';
  return (
    <tr
      style={isUnknownAgent ? { opacity: 0.65 } : undefined}
      aria-label={isUnknownAgent ? UNKNOWN_AGENT_TITLE : undefined}>
      <td
        className="text-ink px-2 py-1.5 border-b border-line truncate"
        style={{ position: 'sticky', left: 0, background: labelCellBg, maxWidth: 200 }}
        title={isUnknownAgent ? UNKNOWN_AGENT_TITLE : agent}>
        {isUnknownAgent
          ? <span className="text-dim italic">{UNKNOWN_AGENT_LABEL}</span>
          : agent}
      </td>
      {TASK_TYPE_COLUMNS.map((c) => (
        <SuccessRateCell key={c.key} agent={agent} taskType={c.label} cell={cells[`${agent}|${c.key}`]}/>
      ))}
    </tr>
  );
}

function SuccessRateLegend() {
  return (
    <div className="flex items-center gap-3 mb-3 fs-meta text-dim flex-shrink-0">
      <span className="font-mono text-faint">Legend</span>
      <LegendSwatch colorVar="--ok"   label={`≥ ${(SUCCESS_RATE_OK_THRESHOLD * 100).toFixed(0)}%`}/>
      <LegendSwatch colorVar="--warn" label={`≥ ${(SUCCESS_RATE_WARN_THRESHOLD * 100).toFixed(0)}%`}/>
      <LegendSwatch colorVar="--crit" label={`< ${(SUCCESS_RATE_WARN_THRESHOLD * 100).toFixed(0)}%`}/>
    </div>
  );
}

function LegendSwatch({ colorVar, label }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: `rgb(var(${colorVar}) / 0.45)`, border: `1px solid rgb(var(${colorVar}))` }}/>
      {label}
    </span>
  );
}

// Tier-scaled highlight — green-bias 매트릭스에서 미달 셀 즉시 식별 (research R1).
const CELL_HIGHLIGHT_BY_TONE = {
  '--ok':   { bgOpacity: 0.08, borderAccent: undefined },
  '--warn': { bgOpacity: 0.18, borderAccent: '1px solid rgb(var(--warn) / 0.35)' },
  '--crit': { bgOpacity: 0.28, borderAccent: '1px solid rgb(var(--crit) / 0.55)' },
};

function SuccessRateCell({ agent, taskType, cell }) {
  // 데이터 없음.
  if (!cell || cell.totalCount === 0) {
    return (
      <td
        className="text-center text-faint px-2 py-1.5 border-b border-line"
        title={`${agent} · ${taskType} — no data`}>
        —
      </td>
    );
  }

  // 분모 0 (success/fail 외 result 만 존재) → 비율 미정의 — 0% 날조 대신 '—' (A7).
  if (cell.pooledRate === null) {
    return (
      <td
        className="text-center text-faint px-2 py-1.5 border-b border-line"
        title={`${agent} · ${taskType} — nothing conclusive to rate (no success/fail · ${cell.totalCount} total)`}>
        — · {cell.totalCount}
      </td>
    );
  }

  const tone = cellTone(cell.pooledRate);
  const { bgOpacity, borderAccent } = CELL_HIGHLIGHT_BY_TONE[tone.colorVar];
  const bg = `rgb(var(${tone.colorVar}) / ${bgOpacity})`;
  const isCrit = tone.colorVar === '--crit';
  const isLowSample = cell.rateDenominator < window.UI.LOW_N_MIN;
  const ariaLabel =
    `${agent} ${taskType} — pooled success rate ${(cell.pooledRate * 100).toFixed(0)}% (${cell.successCount}/${cell.rateDenominator}), ` +
    `${cell.totalCount} total` +
    (isLowSample ? ' (small sample)' : '') +
    (isCrit ? ' (below threshold — check this pair)' : '');

  return (
    <td
      className="text-center px-1 py-1.5 border-b border-line relative"
      style={{ background: bg, outline: borderAccent, outlineOffset: -1 }}
      title={`${agent} · ${taskType}\npooled ${(cell.pooledRate * 100).toFixed(1)}% (${cell.successCount}/${cell.rateDenominator})${isLowSample ? ` · small sample (n=${cell.rateDenominator} < ${window.UI.LOW_N_MIN})` : ''} · ${cell.totalCount} total`}
      aria-label={ariaLabel}>
      <div className="flex flex-col items-center gap-0.5">
        <SuccessRateSparkline points={cell.points} colorVar={tone.colorVar}/>
        <div className="flex items-center gap-1 fs-micro">
          <span
            style={{ color: `rgb(var(${tone.colorVar}))`, ...(isLowSample ? { fontStyle: 'italic', opacity: 0.75 } : null) }}
            className="font-semibold">
            {(cell.pooledRate * 100).toFixed(0)}%
          </span>
          <span className="text-faint">·</span>
          <span className="text-dim">n={cell.rateDenominator}</span>
        </div>
      </div>
    </td>
  );
}

function SuccessRateSparkline({ points, colorVar }) {
  const { LineChart, Line, YAxis } = window.Recharts;

  // Recharts non-Responsive 사용은 명시 width/height 필요 — matrix 밀도상 ResponsiveContainer 비현실적.
  return (
    <LineChart
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      data={points}
      margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
      <YAxis hide domain={[0, 1]}/>
      <Line
        type="monotone"
        dataKey="rate"
        stroke={`rgb(var(${colorVar}))`}
        strokeWidth={1.5}
        dot={false}
        connectNulls={false}
        isAnimationActive={false}
      />
    </LineChart>
  );
}

// Panel 1b: Top-N failing (agent, task_type) pairs.
// 매트릭스 companion — 합산 성공률 < threshold 쌍만 노출 → 대부분 green 이어도 action item 가시 유지 (research R2).

function TopNFailingAgentsCard({ state, days, onRetry, failureByAgent }) {
  const { CardHead, Pill } = window.UI;

  // 매트릭스와 동일 row 입력 — duplicate fetch 회피.
  const { failingPairs } = useMemoAg(
    () => buildTopNFailing(readyData(state)?.rows ?? [], TOPN_FAILING_THRESHOLD, TOPN_FAILING_LIMIT),
    [state],
  );

  return (
    <div className="card h-full flex flex-col min-h-0">
      <CardHead
        title="Most-failing pairs"
        sub={`Pooled success below ${(TOPN_FAILING_THRESHOLD * 100).toFixed(0)}% · last ${days} days · top ${TOPN_FAILING_LIMIT}`}
        right={state.status === 'ready' && failingPairs.length > 0
          ? <Pill tone="crit">{failingPairs.length}</Pill>
          : null}
      />
      <div className="card-body ag-card-body">
        <TopNFailingAgentsBody state={state} days={days} onRetry={onRetry} pairs={failingPairs} failureByAgent={failureByAgent}/>
      </div>
    </div>
  );
}

function TopNFailingAgentsBody({ state, days, onRetry, pairs, failureByAgent }) {
  const { Badge } = window.UI;

  if (state.status === 'loading') {
    return <ChartSkeletonAg height={200} aria-label="Loading most-failing pairs"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerAg title="Couldn't load failure rates" detail={state.error} onRetry={onRetry}/>;
  }
  if (pairs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center" style={{ minHeight: 180 }}>
        <Badge role="status" tone="ok" icon>
          Every (agent, task_type) success_rate ≥ {(TOPN_FAILING_THRESHOLD * 100).toFixed(0)}%
        </Badge>
        <div className="fs-meta text-faint mt-3 font-mono">
          Nothing under the threshold in the last {days} days
        </div>
      </div>
    );
  }

  return <TopNFailingAgentsTable pairs={pairs} failureByAgent={failureByAgent}/>;
}

// 서버 last_breakage_at(MAX(record_ts), blocked 포함) 우선 · 미존재 시 client event_date 도출 fallback.
// 서버값은 절대 타임스탬프 → 가시 텍스트는 상대시간(tz-무관) · 툴팁 절대값은 KST 고정, client 도출값은 YYYY-MM-DD 문자열 그대로.
function resolveLastBreakage(pair, failureByAgent) {
  const serverTs = failureByAgent?.get(pair.agent)?.last_breakage_at;
  if (serverTs) {
    return { text: formatRelativeTimeAg(serverTs), title: `Last failure (fail+blocked) ${window.UI.formatKstFull(serverTs)}`, fromServer: true };
  }
  if (pair.lastFailureDate) {
    return { text: pair.lastFailureDate, title: `Last fail event_date (client-derived · blocked not included) ${pair.lastFailureDate}`, fromServer: false };
  }
  return { text: '—', title: 'no failure data', fromServer: false };
}

// thead 컬럼 driver — alignment / width / 라벨만 다르고 sticky 스타일은 공통.
const TOPN_FAILING_COLUMNS = [
  { key: 'agent',   label: 'Agent',   align: 'left',  width: undefined, title: undefined },
  { key: 'task',    label: 'Task',    align: 'left',  width: undefined, title: undefined },
  { key: 'success', label: 'Success', align: 'right', width: 'w-28',    title: undefined },
  // failure-patterns last_breakage_at (서버 MAX(record_ts) · blocked 포함) 우선 채택.
  { key: 'last',    label: 'Last failure', align: 'right', width: 'w-24',    title: 'Most recent failure per agent — failure-patterns last_breakage_at (fail+blocked) preferred · falls back to success-rate event_date (fail only)' },
];

function TopNFailingAgentsTable({ pairs, failureByAgent }) {
  return (
    <div className="overflow-auto" style={{ flex: '1 1 auto', minHeight: 0 }}>
      <table className="w-full fs-meta font-mono" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
        <thead>
          <tr>
            {TOPN_FAILING_COLUMNS.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`text-${c.align} text-dim font-medium px-2 py-1.5 border-b border-line whitespace-nowrap${c.width ? ' ' + c.width : ''}`}
                style={STICKY_TH_STYLE}
                title={c.title}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pairs.map((p) => {
            const breakage = resolveLastBreakage(p, failureByAgent);
            return (
              <tr key={`${p.agent}|${p.task_type}`}>
                <td className="text-left text-ink px-2 py-1.5 border-b border-line truncate" style={{ maxWidth: 160 }} title={p.agent}>
                  {p.agent}
                </td>
                <td className="text-left text-dim px-2 py-1.5 border-b border-line">
                  {p.task_type}
                </td>
                <td
                  className="text-right px-2 py-1.5 border-b border-line font-semibold whitespace-nowrap"
                  style={{
                    color: 'rgb(var(--crit))',
                    ...(p.rateDenominator < window.UI.LOW_N_MIN ? { fontStyle: 'italic', opacity: 0.75 } : null),
                  }}
                  title={`pooled passed ${p.successCount} / (passed+failed) ${p.rateDenominator} · ${p.totalCount} total${p.rateDenominator < window.UI.LOW_N_MIN ? ` · small sample (n=${p.rateDenominator} < ${window.UI.LOW_N_MIN})` : ''}`}>
                  {window.UI.formatPctWithDenominator(p.successCount, p.rateDenominator)}
                  {/* pair 성공률 비례 막대 — % 옆 shape. 전 항목이 임계 미달 failing-pair → crit. */}
                  <window.UI.Bar
                    value={p.pooledRate}
                    tone="crit"
                    ariaLabel={`pair success rate ${(p.pooledRate * 100).toFixed(0)}%`}
                  />
                </td>
                <td
                  className={`text-right px-2 py-1.5 border-b border-line whitespace-nowrap ${breakage.fromServer ? 'text-dim' : 'text-faint'}`}
                  title={breakage.title}>
                  {breakage.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// AgentQualityHealth (col-span-full) — 자가개선 신호 단일화.
// 좌 60% review_flag 7일 timeline (ComposedChart bars + ratio line) + 우 40% Quality Health Index TOP 5 compact list.
// revisionState + reviewState 병렬 fetch 결과를 agent key 로 client-side join.

// Quality Health Index 가중치 — health = 1 - (0.6 × normalized_revision + 0.4 × review_flag_ratio).
// 점수 높을수록 건강 · TOP 5 = 점수 낮은 순 (개선 ROI 큰 순).
// TODO(maintainer/TICKET-quality-weights): 가중치 튜닝 — 데이터 7일 누적 후 재산정
const QH_REVISION_WEIGHT = 0.6;
const QH_REVIEW_FLAG_WEIGHT = 0.4;
// 절대 기준 정규화 — avgRevision 0.5(=두 task 중 한 번 rework)를 100% 페널티로 고정.
// peer-independent: 한 agent 제거가 다른 agent 점수를 움직이지 못함 (fleet min/max 앵커 폐지).
const QH_REVISION_TARGET = 0.5;
// 건강 verdict 밴드 절대 cut point — post-R2 분포(30일 측정) 재앵커: 하위 "Needs attention" 밴드를 actionable 소수로.
const QH_HEALTH_CRIT_MAX = 0.5;
const QH_HEALTH_WARN_MAX = 0.7;
// Health-index BulletBar zone 밴드 — verdict cut point 와 동일 SoT · re-render 마다 신규 배열 회피(hoist).
const QH_HEALTH_BULLET_ZONES = [
  { upTo: QH_HEALTH_CRIT_MAX, tone: 'crit' },
  { upTo: QH_HEALTH_WARN_MAX, tone: 'warn' },
  { upTo: 1, tone: 'ok' },
];
const QH_TOP_N = 5;

// review_flag timeline 좌축/우축 라벨 — re-render 마다 신규 객체 생성 회피 (Recharts 패턴).
const QH_TIMELINE_COUNT_AXIS_LABEL = {
  value: 'Flagged per day',
  angle: -90,
  position: 'insideLeft',
  fill: 'rgb(var(--dim))',
  fontSize: 11,
  style: { textAnchor: 'middle' },
};
const QH_TIMELINE_RATIO_AXIS_LABEL = {
  value: 'Rate (%)',
  angle: 90,
  position: 'insideRight',
  fill: 'rgb(var(--crit))',
  fontSize: 11,
  style: { textAnchor: 'middle' },
};

function AgentQualityHealthCard({ revisionState, reviewState, reviewByAgentState, days, onSelect, onRetry }) {
  const { CardHead } = window.UI;

  // Promise.allSettled 패턴 — 한쪽 fail 시 다른 쪽 표시 (R2 회귀 위험 완화).
  const bothLoading = revisionState.status === 'loading' && reviewState.status === 'loading';
  const bothError = revisionState.status === 'error' && reviewState.status === 'error';

  // Health Index review_flag 성분 = per-agent 엔드포인트 rows (agent 컬럼 → buildReviewFlagMap agent 분기).
  // reviewByAgentState 404/error (pre-deploy) → readyData null → [] → revision 단독으로 graceful degrade.
  const topAgents = useMemoAg(
    () => buildQualityHealthRanking(
      readyData(revisionState)?.rows ?? [],
      readyData(reviewByAgentState)?.rows ?? [],
      QH_TOP_N,
    ),
    [revisionState, reviewByAgentState],
  );

  return (
    <div className="card h-full flex flex-col min-h-0">
      <CardHead
        title="Improvement signals"
        sub={`Last ${days} days`}
      />
      <div className="card-body ag-card-body">
        {bothLoading ? (
          <ChartSkeletonAg height={280} aria-label="Loading improvement signals"/>
        ) : bothError ? (
          <ErrorBannerAg
            title="Couldn't load improvement signals"
            detail={revisionState.error || reviewState.error}
            onRetry={onRetry}
          />
        ) : (
          <div className="grid grid-cols-5 gap-4" style={{ flex: '1 1 auto', minHeight: 0 }}>
            <div className="col-span-3 flex flex-col min-h-0">
              <QualityHealthTimeline state={reviewState} onRetry={onRetry}/>
            </div>
            <div className="col-span-2 flex flex-col min-h-0">
              <QualityHealthTopList agents={topAgents} state={revisionState} onSelect={onSelect} onRetry={onRetry}/>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function QualityHealthTimeline({ state, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonAg height={260} aria-label="Loading review_flag timeline"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerAg title="Couldn't load review_flag data" detail={state.error} onRetry={onRetry}/>;
  }
  const rows = readyData(state)?.rows ?? [];
  if (rows.length === 0) {
    return <EmptyStateAg message="No review_flag data."/>;
  }

  const totalFlagged = rows.reduce((s, r) => s + (Number(r.review_flagged_count) || 0), 0);
  const totalEvents = rows.reduce((s, r) => s + (Number(r.total_count) || 0), 0);

  const chartRows = rows.map((r) => ({
    date: typeof r.event_date === 'string' ? r.event_date.slice(5) : '',
    fullDate: r.event_date,
    total_count:           Number(r.total_count) || 0,
    review_flagged_count:  Number(r.review_flagged_count) || 0,
    empty_metric_count:    Number(r.empty_metric_count) || 0,
    polar_mismatch_count:  Number(r.polar_mismatch_count) || 0,
    review_flag_ratio_pct: (Number(r.review_flag_ratio) || 0) * 100,
    // 응답에 이미 존재하나 미표시였던 비율 필드 (count 와 함께 절대·비중 동시 제공).
    empty_metric_ratio_pct: (Number(r.empty_metric_ratio) || 0) * 100,
  }));

  return (
    <>
      <div className="flex items-baseline gap-3 mb-2 flex-wrap flex-shrink-0">
        <div className="font-mono fs-stat font-semibold tracking-tight">
          {formatIntAg(totalFlagged)}
        </div>
        {/* 합산 발생률 (총 flag ÷ 총 event) — 일별 비율 평균 아님 → '평균' 라벨 금지 (A5). */}
        <div className="fs-meta text-dim">Total flagged · rate {window.UI.formatPctWithDenominator(totalFlagged, totalEvents)}</div>
      </div>
      <QualityHealthTimelineChart rows={chartRows}/>
    </>
  );
}

function QualityHealthTimelineChart({ rows }) {
  const { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid } = window.Recharts;

  return (
    <div className="ag-chart-fill">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false}/>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
            axisLine={{ stroke: 'rgb(var(--line))' }}
            tickLine={false}
          />
          <YAxis
            yAxisId="count"
            allowDecimals={false}
            label={QH_TIMELINE_COUNT_AXIS_LABEL}
            tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
            axisLine={{ stroke: 'rgb(var(--line))' }}
            tickLine={false}
            width={48}
          />
          <YAxis
            yAxisId="ratio"
            orientation="right"
            domain={[0, 100]}
            tickFormatter={(v) => v.toFixed(0) + '%'}
            label={QH_TIMELINE_RATIO_AXIS_LABEL}
            tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
            axisLine={{ stroke: 'rgb(var(--line))' }}
            tickLine={false}
            width={56}
          />
          <Tooltip content={<QualityHealthTimelineTooltip/>} cursor={{ fill: 'rgb(var(--accent) / 0.06)' }}/>
          <Bar yAxisId="count" dataKey="empty_metric_count"   stackId="rf" fill={`rgb(var(--warn) / 0.85)`}   isAnimationActive={false}/>
          <Bar yAxisId="count" dataKey="polar_mismatch_count" stackId="rf" fill={`rgb(var(--accent) / 0.85)`} isAnimationActive={false}/>
          <Line
            yAxisId="ratio"
            type="monotone"
            dataKey="review_flag_ratio_pct"
            stroke="rgb(var(--crit))"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function QualityHealthTimelineTooltip({ active, payload }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const row = payload[0].payload;
  return (
    <div style={tooltipStyle}>
      <div style={{ color: 'rgb(var(--ink))', marginBottom: 4, fontWeight: 600 }}>{row.fullDate}</div>
      <div style={{ color: 'rgb(var(--dim))' }}>
        flagged {formatIntAg(row.review_flagged_count)} / {formatIntAg(row.total_count)}
      </div>
      <div style={tooltipRowStyle}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: 'rgb(var(--warn))' }}/>
        No self-check {formatIntAg(row.empty_metric_count)}
        <span style={{ color: 'rgb(var(--faint))' }}>· {row.empty_metric_ratio_pct.toFixed(1)}%</span>
      </div>
      <div style={tooltipRowStyle}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: 'rgb(var(--accent))' }}/>
        Confidence mismatch {formatIntAg(row.polar_mismatch_count)}
      </div>
      <div style={{ color: 'rgb(var(--crit))', marginTop: 4 }}>
        Flagged rate {row.review_flag_ratio_pct.toFixed(1)}%
      </div>
    </div>
  );
}

function QualityHealthTopList({ agents, state, onSelect, onRetry }) {
  if (state.status === 'loading' && agents.length === 0) {
    return <ChartSkeletonAg height={260} aria-label="Loading improvement candidates"/>;
  }
  if (state.status === 'error' && agents.length === 0) {
    return <ErrorBannerAg title="Couldn't load revision data" detail={state.error} onRetry={onRetry}/>;
  }
  if (agents.length === 0) {
    return <EmptyStateAg message="No improvement candidates."/>;
  }
  return (
    <div className="overflow-auto" style={{ flex: '1 1 auto', minHeight: 0 }}>
      <div className="fs-micro font-mono text-faint uppercase tracking-wider mb-2 px-1">
        Top {QH_TOP_N} to improve first (lower health index = higher priority)
      </div>
      <div className="space-y-2">
        {agents.map((a, i) => (
          <QualityHealthTopRow key={a.agent} rank={i + 1} entry={a} onSelect={onSelect}/>
        ))}
      </div>
    </div>
  );
}

function QualityHealthTopRow({ rank, entry, onSelect }) {
  const handleClick = () => onSelect(entry.agent);
  const handleKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(entry.agent);
    }
  };

  // Health Index 색상 — 낮을수록 critical (개선 우선).
  const indexPct = (entry.healthIndex * 100).toFixed(0);
  const indexTone = qualityHealthTone(entry.healthIndex);

  return (
    <div
      onClick={handleClick}
      onKeyDown={handleKey}
      tabIndex={0}
      role="button"
      className="px-2 py-2 rounded border border-line hover:bg-sunken cursor-pointer transition-colors"
      title={`${entry.agent} — health ${indexPct}% (writer-emitted) · reworks ${entry.totalRevisions} · review_flag ${(entry.reviewFlagRatio * 100).toFixed(1)}%${entry.reviewFlaggedReconstructed > 0 ? ` · ${entry.reviewFlaggedReconstructed} reconstructed flag(s) excluded` : ''}`}>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-faint fs-micro font-mono w-4 text-right">{rank}</span>
          <span className="font-medium fs-body truncate">{entry.agent}</span>
        </div>
        <span className={`font-mono fs-body font-semibold ${indexTone}`}>{indexPct}</span>
      </div>
      <RevisionInlineMiniBar buckets={entry.buckets} total={entry.totalRevisions}/>
      {entry.reviewFlaggedReconstructed > 0 && (
        <div
          className="fs-micro font-mono mt-1"
          style={{ color: 'rgb(var(--faint))' }}
          title="Harness-reconstructed review_flags (recovery artifacts) excluded from the health score">
          ↺ {formatIntAg(entry.reviewFlaggedReconstructed)} reconstructed flag(s) excluded
        </div>
      )}
    </div>
  );
}

// revision_count 분포 inline mini-bar — 0/1/2/3/4+ 5색 stacked horizontal bar.
function RevisionInlineMiniBar({ buckets, total }) {
  if (total === 0) {
    return <div className="fs-micro text-faint font-mono">no revision data</div>;
  }
  return (
    <div
      className="flex h-1.5 rounded-full overflow-hidden bg-sunken"
      role="img"
      aria-label={`revision distribution — ${total} total`}>
      {REVISION_BUCKETS.map((b) => {
        const count = buckets[`bucket_${b.key}`] || 0;
        if (count === 0) return null;
        const widthPct = (count / total) * 100;
        return (
          <div
            key={b.key}
            style={{
              width: `${widthPct}%`,
              background: `rgb(var(${b.colorVar}) / 0.85)`,
            }}
            title={`revision=${b.label}: ${count} (${widthPct.toFixed(0)}%)`}
          />
        );
      })}
    </div>
  );
}

// LifecycleStats (col-span-2) — orphan spawn gap + duration 분포 (/api/agents/lifecycle-stats).
// start − completed = 미완 spawn(orphan) 누수 신호 · 행 클릭 → DetailPanel 갱신 (agent_type == agent_id convention).

const LIFECYCLE_DISPLAY_LIMIT = 12;

// orphan gap 임계 — start 대비 미완(completed 미도달) 비율. crit/warn 톤 분기.
const ORPHAN_RATIO_CRIT_THRESHOLD = 0.35;
const ORPHAN_RATIO_WARN_THRESHOLD = 0.2;

function LifecycleStatsCard({ state, days, onSelect, onRetry }) {
  const { CardHead, Pill } = window.UI;

  const rows = readyData(state)?.rows ?? [];
  const totalOrphans = state.status === 'ready'
    ? rows.reduce((s, r) => s + Math.max(0, (Number(r.start_count) || 0) - (Number(r.completed_count) || 0)), 0)
    : 0;

  return (
    <div className="card h-full flex flex-col min-h-0">
      <CardHead
        title="Unfinished runs"
        sub={`Last ${days} days · top ${LIFECYCLE_DISPLAY_LIMIT}`}
        right={state.status === 'ready' && totalOrphans > 0
          ? <Pill tone="warn">{formatIntAg(totalOrphans)} orphan</Pill>
          : null}
      />
      <div className="card-body ag-card-body">
        <LifecycleStatsBody state={state} days={days} onSelect={onSelect} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function LifecycleStatsBody({ state, days, onSelect, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonAg height={260} aria-label="Loading lifecycle stats"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerAg title="Couldn't load lifecycle stats" detail={state.error} onRetry={onRetry}/>;
  }
  const rows = (readyData(state)?.rows ?? [])
    .filter((r) => r && r.agent_type && (Number(r.start_count) || 0) > 0)
    .sort((a, b) => (Number(b.start_count) || 0) - (Number(a.start_count) || 0))
    .slice(0, LIFECYCLE_DISPLAY_LIMIT);
  if (rows.length === 0) {
    return <EmptyStateAg message={`No lifecycle events in the last ${days} days.`}/>;
  }
  return <LifecycleStatsTable rows={rows} onSelect={onSelect}/>;
}

// 컬럼 driver — start/completed/orphan/p95 (5 컬럼 cap 준수: Agent + 4 메트릭).
const LIFECYCLE_COLUMNS = [
  { key: 'agent',     label: 'Agent',     align: 'left',  title: undefined },
  { key: 'start',     label: 'Started',     align: 'right', title: undefined },
  { key: 'completed', label: 'Finished', align: 'right', title: 'completed outcome count (finished normally)' },
  { key: 'orphan',    label: 'Unfinished',    align: 'right', title: undefined },
  { key: 'p95',       label: 'P95',       align: 'right', title: undefined },
];

function LifecycleStatsTable({ rows, onSelect }) {
  return (
    <div className="overflow-auto" style={{ flex: '1 1 auto', minHeight: 0 }}>
      <table className="w-full fs-meta font-mono" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
        <thead>
          <tr>
            {LIFECYCLE_COLUMNS.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`text-${c.align} text-dim font-medium px-2 py-1.5 border-b border-line`}
                style={STICKY_TH_STYLE}
                title={c.title}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => <LifecycleStatsRow key={r.agent_type} row={r} onSelect={onSelect}/>)}
        </tbody>
      </table>
    </div>
  );
}

function LifecycleStatsRow({ row, onSelect }) {
  const { AgentBadge } = window.UI;
  const startCount = Number(row.start_count) || 0;
  const completedCount = Number(row.completed_count) || 0;
  const orphanCount = Math.max(0, startCount - completedCount);
  const orphanRatio = startCount > 0 ? orphanCount / startCount : 0;
  const orphanTone = orphanRatioTone(orphanRatio);
  const p95Sec = row.p95_duration_sec == null ? null : Number(row.p95_duration_sec);

  const handleClick = () => onSelect(row.agent_type);
  const handleKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(row.agent_type);
    }
  };

  return (
    <tr
      onClick={handleClick}
      onKeyDown={handleKey}
      tabIndex={0}
      role="button"
      className="cursor-pointer hover:bg-sunken transition-colors"
      title={`${row.agent_type} — start ${startCount} · stop ${formatIntAg(row.stop_count)} · completed ${completedCount} · orphan ${orphanCount} (${(orphanRatio * 100).toFixed(0)}%)`}>
      <td className="text-left text-ink px-2 py-1.5 border-b border-line truncate" style={{ maxWidth: 160 }}>
        <span className="flex items-center gap-1.5">
          <AgentBadge a={{ id: row.agent_type, name: row.agent_type }} size={16}/>
          <span className="truncate">{row.agent_type}</span>
        </span>
      </td>
      <td className="text-right text-dim px-2 py-1.5 border-b border-line">{formatIntAg(startCount)}</td>
      <td className="text-right text-dim px-2 py-1.5 border-b border-line">{formatIntAg(completedCount)}</td>
      <td className={`text-right px-2 py-1.5 border-b border-line font-semibold ${orphanTone}`}>
        {orphanCount > 0 ? `${formatIntAg(orphanCount)} · ${(orphanRatio * 100).toFixed(0)}%` : '0'}
      </td>
      <td className="text-right text-dim px-2 py-1.5 border-b border-line">
        {p95Sec == null ? '—' : formatDurationSecAg(p95Sec)}
      </td>
    </tr>
  );
}

// SkillActivation (col-span-1) — 에이전트/스킬 활성화 (/api/telemetry/activations).
// summary.false_positive_by_dimension(agent) = 서버 prebuilt per-agent 집계 → client 무집계 · rows = 최근 activation 이벤트 (source: subagent/orchestrator).

const ACTIVATION_RECENT_LIMIT = 8;
const ACTIVATION_TOP_AGENTS_LIMIT = 6;

function SkillActivationCard({ state, days, onRetry }) {
  const { CardHead, Pill } = window.UI;

  const data = readyData(state);
  const totalActivations = data?.summary?.total_activations ?? data?.total ?? 0;

  return (
    <div className="card h-full flex flex-col min-h-0">
      <CardHead
        title="Activations"
        sub={`Last ${days} days`}
        right={state.status === 'ready' && totalActivations > 0
          ? <Pill tone="info">{formatIntAg(totalActivations)}</Pill>
          : null}
      />
      <div className="card-body ag-card-body">
        <SkillActivationBody state={state} days={days} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function SkillActivationBody({ state, days, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonAg height={260} aria-label="Loading activations"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerAg title="Couldn't load activations" detail={state.error} onRetry={onRetry}/>;
  }
  const data = readyData(state);
  const agentCounts = (data?.summary?.false_positive_by_dimension ?? [])
    .filter((x) => x && x.dimension === 'agent')
    .map((x) => ({ name: x.name, total: Number(x.total) || 0 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, ACTIVATION_TOP_AGENTS_LIMIT);
  const recentRows = (data?.rows ?? []).slice(0, ACTIVATION_RECENT_LIMIT);

  if (agentCounts.length === 0 && recentRows.length === 0) {
    return <EmptyStateAg message={`No activation events in the last ${days} days.`}/>;
  }

  const maxCount = agentCounts.length > 0 ? agentCounts[0].total : 1;

  return (
    <div className="overflow-auto" style={{ flex: '1 1 auto', minHeight: 0 }}>
      <SkillActivationAgentBars agentCounts={agentCounts} maxCount={maxCount}/>
      <SkillActivationRecentList rows={recentRows}/>
    </div>
  );
}

function SkillActivationAgentBars({ agentCounts, maxCount }) {
  if (agentCounts.length === 0) return null;
  const { AgentBadge } = window.UI;
  return (
    <div className="mb-4">
      <div className="fs-micro font-mono text-faint uppercase tracking-wider mb-2 px-1">
        Most activated
      </div>
      <div className="space-y-2">
        {agentCounts.map((a) => (
          <div key={a.name} className="fs-body">
            <div className="flex items-center gap-1.5 mb-1">
              <AgentBadge a={{ id: a.name, name: a.name }} size={16}/>
              <span className="flex-1 truncate">{a.name}</span>
              <span className="font-mono text-faint fs-micro">{formatIntAg(a.total)}</span>
            </div>
            <div className="h-1.5 bg-sunken rounded-full overflow-hidden">
              <div
                className="h-full bg-info rounded-full"
                style={{ width: `${maxCount > 0 ? (a.total / maxCount) * 100 : 0}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// source 별 dual-encoding — 색 + 약어(SA/OR)로 색맹 안전.
const ACTIVATION_SOURCE_META = {
  subagent:     { abbr: 'SA', label: 'subagent',     colorVar: '--info' },
  orchestrator: { abbr: 'OR', label: 'orchestrator', colorVar: '--accent' },
};

function SkillActivationRecentList({ rows }) {
  if (rows.length === 0) return null;
  return (
    <div className="border-t border-line pt-3">
      <div className="fs-micro font-mono text-faint uppercase tracking-wider mb-2 px-1">
        Recent activations
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => <SkillActivationRecentRow key={r.id} row={r}/>)}
      </div>
    </div>
  );
}

function SkillActivationRecentRow({ row }) {
  const meta = ACTIVATION_SOURCE_META[row.source] || { abbr: '??', label: row.source || 'unknown', colorVar: '--dim' };
  // 가시 텍스트 = 상대시간(tz-무관) · 툴팁 절대 타임스탬프 = KST 고정 (raw UTC ISO 노출 금지).
  const when = row.occurred_at ? formatRelativeTimeAg(row.occurred_at) : '—';
  const occurredKst = row.occurred_at ? window.UI.formatKstFull(row.occurred_at) : '';
  return (
    <div className="flex items-center gap-2 fs-meta font-mono" title={`${meta.label} · ${row.agent_name || '—'} · ${occurredKst}`}>
      <span
        className="inline-flex items-center justify-center rounded px-1 fs-micro font-semibold shrink-0"
        style={{ background: `rgb(var(${meta.colorVar}) / 0.18)`, color: `rgb(var(${meta.colorVar}))`, minWidth: 22 }}>
        {meta.abbr}
      </span>
      <span className="flex-1 truncate text-dim">{row.agent_name || '—'}</span>
      <span className="text-faint shrink-0">{when}</span>
    </div>
  );
}

// Shared chrome

function EmptyStateAg({ message }) {
  const { EmptyState } = window.UI;
  return <EmptyState message={message} />;
}

function ErrorBannerAg({ title, detail, onRetry }) {
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
        <div className="fs-body font-medium text-ink">{title}</div>
        {detail && <div className="fs-meta font-mono text-dim mt-1 truncate" title={window.UI.titleOf(detail)}>{detail}</div>}
      </div>
      <button className="btn sm" onClick={onRetry} aria-label="Retry">Retry</button>
    </div>
  );
}

function ChartSkeletonAg({ height = 220 }) {
  return (
    <div
      aria-busy="true"
      style={{
        width: '100%',
        height,
        borderRadius: 8,
        background: 'rgb(var(--sunken))',
        opacity: 0.7,
        animation: 'skelPulseAg 1.4s ease-in-out infinite',
      }}
    />
  );
}

// Pure helpers

const tooltipStyle = {
  background: 'rgb(var(--elev))',
  border: '1px solid rgb(var(--line))',
  borderRadius: 8,
  padding: '8px 12px',
  // 툴팁 = HTML DOM div → 11.5px→var(--fs-meta)(11px) 매핑 (밀도 높은 보조 콘텐츠 tier · cost.jsx tooltipStyle 동일 선례).
  fontSize: 'var(--fs-meta)',
  fontFamily: 'JetBrains Mono, monospace',
  boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
};

const tooltipRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  color: 'rgb(var(--dim))',
};

async function fetchJsonAg(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_e) { /* ignore body parse failure */ }
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 120) : ''}`);
  }
  return res.json();
}

// DELETE helper — 서버는 refused(409)/rolled_back(500)/recovery_needed(500) 도 구조화 본문(result
// 필드)으로 반환 → result 있으면 결과 상태로 취급, error 필드(invalid_body / mutation_in_progress 등)만 throw.
async function sendAgentAg(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  let data = null;
  try {
    data = await res.json();
  } catch (_e) {
    // 본문 파싱 실패 — 아래 HTTP 상태로 폴백.
  }

  if (data && typeof data.result === 'string') return data;
  if (data && typeof data.error === 'string') {
    const detail = data.reason || data.field || '';
    throw new Error(`${data.error}${detail ? ' — ' + detail : ''}`);
  }
  throw new Error(`HTTP ${res.status} ${res.statusText}`);
}

function messageOfAg(err) {
  return err && err.message ? err.message : String(err);
}

// 비-deleted commit 결과(refused / rolled_back / recovery_needed) → 사용자 노출 1줄 사유.
function formatDeleteFailureAg(data) {
  if (!data) return 'The delete did not complete.';
  const reasons = Array.isArray(data.reasons) ? data.reasons.join('; ') : '';
  if (data.result === 'refused') return reasons || 'The safety policy refused the delete — nothing was changed.';
  if (data.result === 'rolled_back') return data.detail || 'A cleanup step failed; the change rolled back cleanly.';
  if (data.result === 'recovery_needed') return data.remediation || data.detail || 'Rollback failed — manual reconcile required.';
  return data.detail || `Unexpected result: ${data.result}`;
}

// fetch → setter 와이어링 보일러플레이트 통합 (dashboard.jsx runFetch 패턴).
function runFetchAg(url, signal, setter) {
  return fetchJsonAg(url, signal)
    .then((data) => setter({ status: 'ready', data, error: null }))
    .catch((err) => handleErrorAg(err, setter));
}

function handleErrorAg(err, setter) {
  // AbortError = period change / unmount — 사용자 가시 실패 아님.
  if (err && err.name === 'AbortError') return;
  setter({ status: 'error', data: null, error: err && err.message ? err.message : String(err) });
}

// state.status === 'ready' 가드 — body 부 ready data 접근 패턴 압축.
function readyData(state) {
  return state.status === 'ready' ? state.data : null;
}

// agent × task_type 매트릭스 build — flat row → { agents, cells } projection.
// CellAgg = { points: [{date, rate|null}], pooledRate, rateDenominator, totalCount, successCount, failureCount }.
// pooledRate = 기간 합산 성공/(성공+실패) — 일별 비율 평균(mean-of-daily-rates)은 표본 가중 왜곡으로 금지 (A5).
function buildSuccessRateMatrix(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { agents: [], cells: {} };
  }

  const cellMap = new Map();
  const agentTotals = new Map();

  for (const r of rows) {
    if (!r || !r.agent || !r.task_type) continue;
    const key = `${r.agent}|${r.task_type}`;
    let agg = cellMap.get(key);
    if (!agg) {
      agg = { points: [], totalCount: 0, successCount: 0, failureCount: 0 };
      cellMap.set(key, agg);
    }

    const total   = Number(r.total_count) || 0;
    const success = Number(r.success_count) || 0;
    const failure = Number(r.failure_count) || 0;
    const rate    = nullableNumber(r.success_rate);

    agg.totalCount   += total;
    agg.successCount += success;
    agg.failureCount += failure;
    agg.points.push({ date: r.event_date, rate });

    agentTotals.set(r.agent, (agentTotals.get(r.agent) || 0) + total);
  }

  for (const agg of cellMap.values()) {
    agg.points.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    agg.rateDenominator = agg.successCount + agg.failureCount;
    // null = 분모 0 (success/fail 외 result 만 존재) — fabricated 0% 차단 (A7).
    agg.pooledRate = agg.rateDenominator > 0 ? agg.successCount / agg.rateDenominator : null;
  }

  // 'unknown' 은 정상 agent 아래에 강제 배치 (시각 분리). 나머지는 total DESC + alpha.
  const agents = Array.from(agentTotals.entries())
    .sort((a, b) => {
      const aUnknown = a[0] === UNKNOWN_AGENT_ID;
      const bUnknown = b[0] === UNKNOWN_AGENT_ID;
      if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
      return (b[1] - a[1]) || a[0].localeCompare(b[0]);
    })
    .slice(0, MATRIX_AGENT_CAP)
    .map(([agent]) => agent);

  return { agents, cells: Object.fromEntries(cellMap) };
}

function cellTone(pooledRate) {
  if (pooledRate >= SUCCESS_RATE_OK_THRESHOLD)   return { colorVar: '--ok'   };
  if (pooledRate >= SUCCESS_RATE_WARN_THRESHOLD) return { colorVar: '--warn' };
  return { colorVar: '--crit' };
}

// flat row → per-pair stats · threshold 미달만 반환 · pooledRate ASC sort · limit cap.
// 합산 비율 + 최소 표본 floor (분모 < TOPN_MIN_SAMPLE 쌍 랭킹 제외, A5).
// server 가 last_failure_at 미반환 → failure_count > 0 row 의 event_date 로 client-side 도출.
function buildTopNFailing(rows, threshold, limit) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { failingPairs: [] };
  }

  const pairMap = new Map();

  for (const r of rows) {
    if (!r || !r.agent || !r.task_type) continue;
    // 'unknown' 은 actionable agent 아님 — 매트릭스에서만 시각화 (정보 손실 X).
    if (r.agent === UNKNOWN_AGENT_ID) continue;
    const key = `${r.agent}|${r.task_type}`;
    let agg = pairMap.get(key);
    if (!agg) {
      agg = {
        agent: r.agent,
        task_type: r.task_type,
        totalCount: 0,
        successCount: 0,
        failureCount: 0,
        lastFailureDate: null,
      };
      pairMap.set(key, agg);
    }
    const total   = Number(r.total_count) || 0;
    const success = Number(r.success_count) || 0;
    const failure = Number(r.failure_count) || 0;
    agg.totalCount   += total;
    agg.successCount += success;
    agg.failureCount += failure;
    // YYYY-MM-DD lex compare — 최신 failure date 추적.
    if (failure > 0 && typeof r.event_date === 'string') {
      if (!agg.lastFailureDate || r.event_date > agg.lastFailureDate) {
        agg.lastFailureDate = r.event_date;
      }
    }
  }

  const failingPairs = [];
  for (const agg of pairMap.values()) {
    const rateDenominator = agg.successCount + agg.failureCount;
    if (rateDenominator < TOPN_MIN_SAMPLE) continue;

    const pooledRate = agg.successCount / rateDenominator;
    if (pooledRate < threshold) {
      failingPairs.push({
        agent: agg.agent,
        task_type: agg.task_type,
        pooledRate,
        rateDenominator,
        totalCount: agg.totalCount,
        successCount: agg.successCount,
        failureCount: agg.failureCount,
        lastFailureDate: agg.lastFailureDate,
      });
    }
  }

  failingPairs.sort((a, b) => a.pooledRate - b.pooledRate);
  return { failingPairs: failingPairs.slice(0, limit) };
}

// Project /api/agents/revision-distribution rows → per-agent buckets map (Quality Health 좌측 input).
// 입력 row 구조: { agent, revision_bucket, occurrence_count } — buckets key = '0'/'1'/'2'/'3'/'4+'.
function buildRevisionMap(rows) {
  const byAgent = new Map();
  if (!Array.isArray(rows)) return byAgent;
  for (const r of rows) {
    if (!r || !r.agent || !r.revision_bucket) continue;
    let entry = byAgent.get(r.agent);
    if (!entry) {
      entry = { agent: r.agent, total: 0, weightedRevisions: 0 };
      for (const b of REVISION_BUCKETS) entry[`bucket_${b.key}`] = 0;
      byAgent.set(r.agent, entry);
    }
    const count = Number(r.occurrence_count) || 0;
    const bucketKey = `bucket_${r.revision_bucket}`;
    if (Object.prototype.hasOwnProperty.call(entry, bucketKey)) {
      entry[bucketKey] += count;
    }
    entry.total += count;
    // weightedRevisions = revision_count 평균 분자 (0→0, 1→1, ..., 4+→4 가정).
    const numericLevel = r.revision_bucket === '4+' ? 4 : Number(r.revision_bucket) || 0;
    entry.weightedRevisions += numericLevel * count;
  }
  return byAgent;
}

// Project review_flag rows → per-agent aggregate (Health Index review_flag 성분).
// 입력 row 구조: { agent?, total_count, review_flagged_count, reconstructed_count?, ... }.
// 주 입력원 = /api/agents/review-flag-by-agent (agent 컬럼 보유 → per-agent ratio · CF1 P0).
// agent 미포함 (legacy date-only) → __overall__ 단일 비율 fallback 유지.
//
// reconstructed_count = review_flagged_count 중 합성 복구행(harness-synthesized) 몫. 합성 backstop 이
// metric_pass=EMPTY → review_flag=true 로 기록하므로 QA/intel/design 계열의 flagged 는 대부분 recording
// artifact. 따라서 headline `flagged` + Health Index `ratio` 를 writer-emitted (flagged - reconstructed)
// 로 기본 분리 — KpiBucket 패턴. rawFlagged/reconstructed 는 artifact sub-line 노출용으로 보존.
// 필드 부재(구 응답) → reconstructed 0 (writer-emitted == raw, 분리 없음과 동일).
function buildReviewFlagMap(rows) {
  const byAgent = new Map();
  if (!Array.isArray(rows)) return byAgent;

  // agent 컬럼 존재 여부 — 미존재 시 전체 평균만 산출.
  const hasAgentColumn = rows.length > 0 && Object.prototype.hasOwnProperty.call(rows[0], 'agent');

  if (!hasAgentColumn) {
    // 전체 평균을 sentinel key 로 보관 (buildQualityHealthRanking 에서 fallback).
    let total = 0;
    let rawFlagged = 0;
    let reconstructed = 0;
    for (const r of rows) {
      total += Number(r.total_count) || 0;
      const rf = Number(r.review_flagged_count) || 0;
      rawFlagged += rf;
      reconstructed += Math.min(Number(r.reconstructed_count) || 0, rf);
    }
    const flagged = Math.max(0, rawFlagged - reconstructed);
    byAgent.set('__overall__', {
      total, flagged, rawFlagged, reconstructed,
      ratio: total > 0 ? flagged / total : 0,
    });
    return byAgent;
  }

  // agent 컬럼 존재 시 — agent 별 집계.
  for (const r of rows) {
    if (!r || !r.agent) continue;
    let entry = byAgent.get(r.agent);
    if (!entry) {
      entry = { total: 0, flagged: 0, rawFlagged: 0, reconstructed: 0, ratio: 0 };
      byAgent.set(r.agent, entry);
    }
    entry.total += Number(r.total_count) || 0;
    const rf = Number(r.review_flagged_count) || 0;
    entry.rawFlagged += rf;
    entry.reconstructed += Math.min(Number(r.reconstructed_count) || 0, rf);
  }
  for (const entry of byAgent.values()) {
    // headline/ratio = writer-emitted (합성 복구행 제외); reconstructed 는 sub-line 용 보존.
    entry.flagged = Math.max(0, entry.rawFlagged - entry.reconstructed);
    entry.ratio = entry.total > 0 ? entry.flagged / entry.total : 0;
  }
  return byAgent;
}

// Quality Health Index 산출 — health = 1 - (W_rev × normalized_revision + W_flag × review_flag_ratio).
// normalization 방식: 절대 기준 (avgRevision / QH_REVISION_TARGET, 0..1 clamp) — peer-independent,
//   한 agent 제거가 타 agent 점수를 움직이지 못함 (fleet min/max 앵커 폐지).
// 반환: agents[] sorted by healthIndex ASC (낮을수록 개선 우선), 상위 N개. 각 entry 는
//   dominantDriver({kind:'rework'|'flag', value}) 보유 — verdict inline driver phrase 소스 (R4).
function buildQualityHealthRanking(revisionRows, reviewRows, topN) {
  const revisionMap = buildRevisionMap(revisionRows);
  const reviewMap = buildReviewFlagMap(reviewRows);

  if (revisionMap.size === 0) return [];

  // 1단계 — agent 별 avg_revision_count 계산.
  const agentMetrics = [];
  for (const [agent, rev] of revisionMap.entries()) {
    const avgRevision = rev.total > 0 ? rev.weightedRevisions / rev.total : 0;
    const reviewEntry = reviewMap.get(agent);
    // agent 별 review_flag 미존재 시 전체 평균 fallback (__overall__).
    const overallEntry = reviewMap.get('__overall__');
    const sourceEntry = reviewEntry || overallEntry || null;
    // ratio 는 이미 writer-emitted (buildReviewFlagMap 에서 flagged - reconstructed 기준).
    const reviewFlagRatio = sourceEntry ? sourceEntry.ratio : 0;
    agentMetrics.push({
      agent,
      avgRevision,
      reviewFlagRatio,
      // artifact sub-line 용 — flagged headline 중 합성 복구행 몫 (writer-emitted 분리 근거).
      reviewFlaggedReconstructed: sourceEntry ? (sourceEntry.reconstructed || 0) : 0,
      totalRevisions: rev.total,
      buckets: rev,
    });
  }

  // 2단계 — health_index 산출 + dominantDriver 도출 + sort ASC (낮을수록 우선).
  // 절대 정규화 → peer-independent. dominantDriver = 두 페널티 성분 중 큰 쪽 (verdict inline phrase).
  for (const m of agentMetrics) {
    const normalizedRevision = Math.min(1, m.avgRevision / QH_REVISION_TARGET);
    const reworkPenalty = QH_REVISION_WEIGHT * normalizedRevision;
    const flagPenalty = QH_REVIEW_FLAG_WEIGHT * m.reviewFlagRatio;
    m.healthIndex = Math.max(0, Math.min(1, 1 - (reworkPenalty + flagPenalty)));
    m.dominantDriver = reworkPenalty >= flagPenalty
      ? { kind: 'rework', value: m.avgRevision }
      : { kind: 'flag', value: m.reviewFlagRatio };
  }
  agentMetrics.sort((a, b) => a.healthIndex - b.healthIndex);

  return agentMetrics.slice(0, topN);
}

// failure-patterns rows → agent → row map (Summary 컬럼 client-side merge).
function buildFailureMap(rows) {
  const map = new Map();
  if (!Array.isArray(rows)) return map;
  for (const r of rows) {
    if (!r || !r.agent) continue;
    const totalBreakages = Number(r.total_breakages) || 0;
    // reconstructed_count = total_breakages 중 합성 복구행 몫 (harness-synthesized). writer-emitted
    // breakages = total_breakages - reconstructed. breakages 는 fail/blocked 이라 합성 backstop
    // (done_with_concerns 기록)과 겹치는 경우가 드물지만, 판별식을 전 aggregation 에 균일 적용해
    // headline 을 일관되게 writer-emitted 로 노출. 필드 부재(구 응답) → 0.
    const reconstructed = Math.min(Number(r.reconstructed_count) || 0, totalBreakages);
    map.set(r.agent, {
      fail_count: Number(r.fail_count) || 0,
      blocked_count: Number(r.blocked_count) || 0,
      total_breakages: totalBreakages,
      reconstructed,
      // breakage_rate = (fail+blocked)/전체 — fail_rate 는 deprecated alias (동일값 · 1 release 유지).
      breakage_rate: Number(r.breakage_rate ?? r.fail_rate) || 0,
      // 서버 정확 타임스탬프 (MAX(record_ts) · blocked 포함). client event_date 도출보다 정확.
      last_breakage_at: r.last_breakage_at || null,
    });
  }
  return map;
}

// budget-overages API → agent_type-keyed Map (near-cap 뱃지 조회). 미배포 테이블(빈 rows) → 빈 Map.
function buildOverageMap(rows) {
  const map = new Map();
  if (!Array.isArray(rows)) return map;
  for (const r of rows) {
    if (!r || !r.agent_type) continue;
    map.set(r.agent_type, {
      overage_count: Number(r.overage_count) || 0,
      max_crossed_pct: Number(r.max_crossed_pct) || 0,
      latest_ts: r.latest_ts || null,
    });
  }
  return map;
}

// null/undefined → null · otherwise Number(value).
function nullableNumber(value) {
  if (value === null || value === undefined) return null;
  return Number(value);
}

// 공용 포매터 위임 (ui.jsx SoT) — 로컬 재구현 폐기
const formatIntAg = window.UI.formatInt;
const formatRelativeTimeAg = window.UI.formatRelativeTime;

// Tone / formatting helpers

// /api/agents/summary status → StatusDot tone (dashboard.jsx mapAgentStatus 동일).
function mapStatusToTone(status) {
  switch (status) {
    case 'active':   return 'ok';
    case 'idle':     return 'info';
    case 'inactive': return 'warn';
    case 'error':    return 'crit';
    default:         return 'info';
  }
}

// 성공률 % → 텍스트 톤 클래스 (≥95% ok / ≥90% 무톤 / 미만 warn) — 운영 건전성 목적 (CF8).
function successRateTone(pct) {
  if (pct >= SUMMARY_SUCCESS_OK_PCT)   return 'text-ok';
  if (pct >= SUMMARY_SUCCESS_WARN_PCT) return '';
  return 'text-warn';
}

// P95 응답시간(초) → 톤 (null=faint / >20s crit / >10s warn / 무톤).
// 서브에이전트 작업 p95 지연은 분(minute) 도메인 — 라이브 분포 58s~1695s(중앙값 ~11분).
// 종전 10s/20s 컷은 전 에이전트를 crit 단일 티어로 뭉개 spread 가 0 이었다(웹 p95 도메인 값을 잘못 차용).
// 작업 지연 기준으로 재조정: warn=10분(600s)·crit=20분(1200s) → 라이브에서 ok/warn/crit 3티어 실제 분포.
const P95_AGENT_WARN_SEC = 600;
const P95_AGENT_CRIT_SEC = 1200;
function p95LatencyTone(p95Sec) {
  if (p95Sec == null)            return 'text-faint';
  if (p95Sec > P95_AGENT_CRIT_SEC) return 'text-crit';
  if (p95Sec > P95_AGENT_WARN_SEC) return 'text-warn';
  return '';
}

// 동일 초-도메인 컷 → TONE_GLYPH KEY. 빠른 구간을 명시적 'ok'(✓)로 매핑한다 —
// p95LatencyTone 의 '' 무톤은 색 노이즈 회피용이라 barToneFromClass 로는 neutral(ℹ)이 되어
// "빠름"을 표현하지 못한다. 글리프 인디케이터는 별도로 ok/warn/crit 3키를 직접 산출.
function p95GlyphTone(p95Sec) {
  if (p95Sec == null)              return 'neutral';
  if (p95Sec > P95_AGENT_CRIT_SEC) return 'crit';
  if (p95Sec > P95_AGENT_WARN_SEC) return 'warn';
  return 'ok';
}

// Summary 행 "장애"(fail+blocked) 컬럼 톤 — 0건=faint · >0건=warn · breakage_rate>20%=crit.
function failureTone(count, rate) {
  if (count === 0) return 'text-faint';
  if (rate > BREAKAGE_RATE_CRIT_THRESHOLD) return 'text-crit';
  return 'text-warn';
}

// CSS-class 톤('text-ok' 등 · ''=무톤) → Bar/StatusDot KEY(ok|warn|crit|neutral) 변환.
// 텍스트 톤 helper 는 class 를 돌려주나 Bar atom 은 KEY 를 받는다 — 'text-faint'/'' 는 neutral 로.
function barToneFromClass(cls) {
  if (cls === 'text-ok')   return 'ok';
  if (cls === 'text-warn') return 'warn';
  if (cls === 'text-crit') return 'crit';
  return 'neutral';
}

// agent_events SubagentStart window 상대 카운트 톤.
// null = outcomes-only agent (orchestrator 등 spawn 대상 아님) → faint.
// window 비례 임계 미만 = 저활용 (informational flag) → warn.
// 정상 빈도 → 무톤 (시각 노이즈 회피).
function invocationsTone(count, days) {
  if (count == null) return 'text-faint';
  if (count < lowInvocationThresholdForWindow(days)) return 'text-warn';
  return '';
}

// 호출 컬럼 hover title — null vs 0 vs >0 분기 명시 (시각만으로는 ambiguous).
function formatInvocationsTitle(count, days) {
  const threshold = lowInvocationThresholdForWindow(days);
  if (count == null) {
    return 'No agent_events SubagentStart collected (outcomes-only agent · never spawned)';
  }
  if (count === 0) {
    return `0 spawns in the last ${days} days — rarely used (informational only, not a removal trigger)`;
  }
  if (count < threshold) {
    return `${count} spawns in the last ${days} days · below threshold ${threshold} (scaled from ${LOW_INVOCATION_PER_30D}/30d) — rarely used (informational)`;
  }
  return `${count} SubagentStart events in the last ${days} days`;
}

// Quality Health Index (0-1) → 톤 클래스 (낮을수록 우선 개선 대상).
// cut point = named constant (QH_HEALTH_CRIT_MAX/WARN_MAX, post-R2 분포 재앵커).
function qualityHealthTone(index) {
  if (index < QH_HEALTH_CRIT_MAX) return 'text-crit';
  if (index < QH_HEALTH_WARN_MAX) return 'text-warn';
  return 'text-ok';
}

// Quality Health Index → verdict {tone, label} SoT — 3 consumer(Overview/Quality-signals/TopN) 공유.
// tone = TONE_GLYPH 키(crit/warn/ok) · label = self-explaining 문구 (Critical→Needs attention 재명명).
function qualityHealthVerdict(index) {
  if (index < QH_HEALTH_CRIT_MAX) return { tone: 'crit', label: 'Needs attention' };
  if (index < QH_HEALTH_WARN_MAX) return { tone: 'warn', label: 'Watch' };
  return { tone: 'ok', label: 'Healthy' };
}

// dominantDriver → inline driver phrase (R4 self-explaining verdict · tooltip 불필요).
// rework = avg revision 수치 · flag = review_flag % — 페널티 지배 성분 하나만 노출.
function qualityHealthDriverPhrase(driver) {
  if (!driver) return '';
  if (driver.kind === 'flag') return `flag ${(driver.value * 100).toFixed(0)}%`;
  return `high rework ${driver.value.toFixed(2)}`;
}

// orphan spawn 비율(start 대비 미완) → 톤 — 높을수록 누수 심각.
function orphanRatioTone(ratio) {
  if (ratio >= ORPHAN_RATIO_CRIT_THRESHOLD) return 'text-crit';
  if (ratio >= ORPHAN_RATIO_WARN_THRESHOLD) return 'text-warn';
  return 'text-dim';
}

// duration_sec → 인간화 (≥60s "Mm Ss") — 공용 formatDuration(ui.jsx SoT)에 위임, lifecycle p95 표시.
const formatDurationSecAg = (sec) => window.UI.formatDuration(sec);

// latency_ms → 인간화 (<1s "NNNms" · ≥60s "Mm Ss") — 공용 formatDuration('ms') 위임, p50/p95/p99 표시.
const formatDurationMsAg = (ms) => window.UI.formatDuration(ms, 'ms');

// MiniBars 추세 색상 — error / 성공률 미달 / OK 의 3-단 (rgb literal — Tailwind 외 SVG fill).
// 추세 verdict → tone KEY → registry CSS 색(rgb(var(--tone))). 하드코딩 rgb 리터럴 제거 →
//   테마/톤 토큰 변경 시 trend bar 자동 리페인트 (색 SoT = ui.jsx toneVarColor/tokens.css).
function trendBarColor(status, successPct) {
  const tone = status === 'error' ? 'crit' : successPct < 90 ? 'warn' : 'ok';
  return window.UI.toneVarColor(tone);
}

// MiniBars 추세 — success-rate 일별 합계를 agent × date 로 group → 최근 7일 series.
// 7일 모두 0 인 agent → trendMap 미수록 → row 측 "—" 렌더 (정도 점검: 추정값 주입 금지).
function buildAgentTrendMap(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return new Map();

  // 1단계 — (agent, date) → cumulative count.
  const byAgent = new Map();
  const allDates = new Set();
  for (const r of rows) {
    if (!r || !r.agent || !r.event_date) continue;
    const date = String(r.event_date);
    allDates.add(date);
    let dateMap = byAgent.get(r.agent);
    if (!dateMap) {
      dateMap = new Map();
      byAgent.set(r.agent, dateMap);
    }
    const total = Number(r.total_count) || 0;
    dateMap.set(date, (dateMap.get(date) || 0) + total);
  }
  if (allDates.size === 0) return new Map();

  // 2단계 — YYYY-MM-DD lex sort + 마지막 7개.
  const lastSeven = Array.from(allDates).sort().slice(-7);

  // 3단계 — agent → 7개 슬롯 배열 (없는 일자=0). 전체 0 시리즈는 제외.
  const trendMap = new Map();
  for (const [agent, dateMap] of byAgent.entries()) {
    const series = lastSeven.map((d) => dateMap.get(d) || 0);
    if (series.some((v) => v > 0)) trendMap.set(agent, series);
  }
  return trendMap;
}

// SUMMARY_SORT_OPTIONS value → comparator. p95 null 은 가장 뒤로 (음수 magic 으로 sentinel).
// failures comparator 는 외부 map 의존 → sortAgentSummary 에서 closure 로 wrapping.
const AGENT_SUMMARY_COMPARATORS = {
  name:    (a, b) => String(a.agent_name || '').localeCompare(String(b.agent_name || '')),
  runs:    (a, b) => (Number(b.runs)        || 0) - (Number(a.runs)        || 0),
  success: (a, b) => (Number(b.success_pct) || 0) - (Number(a.success_pct) || 0),
  p95:     (a, b) => {
    const ap = a.p95_ms == null ? -1 : Number(a.p95_ms);
    const bp = b.p95_ms == null ? -1 : Number(b.p95_ms);
    return bp - ap;
  },
};

function sortAgentSummary(agents, sortBy, failureByAgent) {
  if (sortBy === 'failures' && failureByAgent) {
    // failure-patterns row 미존재 = 0 정렬 sentinel.
    return agents.slice().sort((a, b) => {
      const aFail = failureByAgent.get(a.agent_id);
      const bFail = failureByAgent.get(b.agent_id);
      const aCount = aFail ? aFail.total_breakages : 0;
      const bCount = bFail ? bFail.total_breakages : 0;
      return bCount - aCount;
    });
  }
  const comparator = AGENT_SUMMARY_COMPARATORS[sortBy] ?? AGENT_SUMMARY_COMPARATORS.runs;
  return agents.slice().sort(comparator);
}

window.ScreenAgents = ScreenAgents;
