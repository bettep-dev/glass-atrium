// Screen 02 — Cost / Token (live data via /api/dashboard/* + /api/cost/*).
// 카드: KPI×4 → 토큰 추이 → 카테고리 단가 → 모델별 비용 → 캐시·세션·parse_error → 이상 탐지.
// Single global period 토글이 모든 fetch 의 days 매개변수를 구동 (AbortController 1개/wave).
// AnomalyCost 는 tokenState 재사용 (추가 fetch 없음).
// Hooks C-suffix aliased — window-scope 충돌 방지.
const {
  useState: useStateC,
  useEffect: useEffectC,
  useRef: useRefC,
  useCallback: useCallbackC,
  useMemo: useMemoC,
} = React;

// 숫자 포맷 — ui.jsx 공용 SoT 소비 (ui.js 가 cost.js 보다 먼저 로드 → window.UI 가용).
// C-suffix 로컬 별칭 유지 — 차트 tickFormatter 등 다수 call site 식별자 보존.
const formatUsdC = window.UI.formatUsdCompact;
const formatUsdAxisC = window.UI.formatUsdCompact;
const formatTokenCompactC = window.UI.formatTokenCompact;
const formatIntC = window.UI.formatInt;

// 서버 allowlist (routes/cost.ts + dashboard.ts) 와 동기화 필수.
const COST_PERIODS = [
  { value: 7,  label: '7d'  },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

// Token categories (bottom→top stacking) — --cat-1~4 단일 토큰셋.
// ModelCostCard 의 cost_cache_creation→--cat-1 … cost_output→--cat-4 매핑과 1:1 정렬
// → 인접 카드(TokenCategory/TokenStacked/ModelCost) legend 색상 일관성.
const TOKEN_CATEGORIES = [
  { key: 'cache_creation_tokens', label: 'Cache write', colorVar: '--cat-1' },
  { key: 'cache_read_tokens',     label: 'Cache read', colorVar: '--cat-2' },
  { key: 'input_tokens',          label: 'Input',      colorVar: '--cat-3' },
  { key: 'output_tokens',         label: 'Output',      colorVar: '--cat-4' },
];

// 세션 비용 분포 히스토그램 bins. 마지막 bin = open-ended outlier ($100+, --warn).
const SESSION_COST_BINS = [
  { label: '$0–0.01',   min: 0,    max: 0.01,        isOutlier: false },
  { label: '$0.01–0.05',min: 0.01, max: 0.05,        isOutlier: false },
  { label: '$0.05–0.1', min: 0.05, max: 0.1,         isOutlier: false },
  { label: '$0.1–0.5',  min: 0.1,  max: 0.5,         isOutlier: false },
  { label: '$0.5–1',    min: 0.5,  max: 1,           isOutlier: false },
  { label: '$1–5',      min: 1,    max: 5,           isOutlier: false },
  { label: '$5–10',     min: 5,    max: 10,          isOutlier: false },
  { label: '$10–50',    min: 10,   max: 50,          isOutlier: false },
  { label: '$50–100',   min: 50,   max: 100,         isOutlier: true  },
  { label: '$100+',     min: 100,  max: Infinity,    isOutlier: true  },
];

// parse_error_ratio 임계 — 초과일 막대 --crit 강조.
const PARSE_ERROR_CRIT_THRESHOLD = 0.05;

// 7d window = 1주 사용 패턴 흡수 · ±2σ = 정규분포 95% CI → band 밖 = anomaly (RED 방법론).
const ROLLING_WINDOW = 7;
const ANOMALY_SIGMA = 2;

// JSX inline-object 할당 회피용 hoist.
const anomalyChartMargin = { top: 6, right: 8, left: 0, bottom: 0 };
// Recharts <Legend wrapperStyle> = HTML DOM div → 공유 토큰 var(--fs-meta) 소비 (차트 SVG tick 과 달리 DOM 텍스트).
const anomalyLegendStyle = { fontSize: 'var(--fs-meta)', paddingTop: 4 };

function ScreenCost({ onNav }) {
  const { PageHeader, Icon, TypeScaleStyle } = window.UI;

  const [days, setDays] = useStateC(30);
  const [refreshTick, setRefreshTick] = useStateC(0);

  // 패널별 fetch state 분리 — 한 fetch 실패가 화면 전체를 blank 시키지 않도록.
  const [kpiState,      setKpiState]      = useStateC({ status: 'loading', data: null, error: null }); // KPI band (고정 윈도우 — days 무관)
  const [tokenState,    setTokenState]    = useStateC({ status: 'loading', data: null, error: null });
  const [token7State,   setToken7State]   = useStateC({ status: 'loading', data: null, error: null }); // KPI sparkline source (7d 고정)
  const [modelState,    setModelState]    = useStateC({ status: 'loading', data: null, error: null });
  const [cacheState,    setCacheState]    = useStateC({ status: 'loading', data: null, error: null });
  const [sessionState,  setSessionState]  = useStateC({ status: 'loading', data: null, error: null });
  const [errorState,    setErrorState]    = useStateC({ status: 'loading', data: null, error: null });
  const [turnState,     setTurnState]     = useStateC({ status: 'loading', data: null, error: null }); // 턴 통계 (stop_reason 분포 + turns 집계)

  // wave 당 단일 AbortController — period 변경 / refresh 시 in-flight 요청 취소.
  const abortRef = useRefC(null);

  const triggerRefresh = useCallbackC(() => setRefreshTick((t) => t + 1), []);

  useEffectC(() => {
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;

    setKpiState({ status: 'loading', data: null, error: null });
    setTokenState({ status: 'loading', data: null, error: null });
    setToken7State({ status: 'loading', data: null, error: null });
    setModelState({ status: 'loading', data: null, error: null });
    setCacheState({ status: 'loading', data: null, error: null });
    setSessionState({ status: 'loading', data: null, error: null });
    setErrorState({ status: 'loading', data: null, error: null });
    setTurnState({ status: 'loading', data: null, error: null });

    // 윈도우 경계 = 서버 buildWindowLowerBound SoT (KST 기준 정확히 N일 · 오늘 포함) —
    // FE 는 days 파라미터만 전달. /api/cost/kpi 는 고정 윈도우(오늘·7d·3h)라 days 미전달.
    const tasks = [
      runFetchC('/api/cost/kpi',                               ctrl.signal, setKpiState),
      runFetchC(`/api/dashboard/cost-timeseries?days=${days}`, ctrl.signal, setTokenState),
      runFetchC('/api/dashboard/cost-timeseries?days=7',       ctrl.signal, setToken7State),
      runFetchC(`/api/cost/by-model?days=${days}`,             ctrl.signal, setModelState),
      runFetchC(`/api/cost/cache-hit?days=${days}`,            ctrl.signal, setCacheState),
      runFetchC(`/api/cost/session-distribution?days=${days}`, ctrl.signal, setSessionState),
      runFetchC(`/api/cost/parse-errors?days=${days}`,         ctrl.signal, setErrorState),
      runFetchC(`/api/cost/turn-stats?days=${days}`,           ctrl.signal, setTurnState),
    ];

    return () => ctrl.abort();
  }, [days, refreshTick]);

  // 패널 로딩 중 period 토글 비활성화 — 빠른 연타 시 abort 스톰 차단.
  const anyLoading =
    tokenState.status === 'loading' ||
    modelState.status === 'loading' ||
    cacheState.status === 'loading' ||
    sessionState.status === 'loading' ||
    errorState.status === 'loading';

  return (
    <div className="cost-screen flex flex-col">
      {/* 공유 타입스케일(--fs 토큰 + fs 클래스) 마운트 — SPA 단일 screen 모델: cost 활성 시 토큰·클래스 가용화 (ui.jsx 정의 소비, 미정의 시 클래스 no-op 회귀 차단). */}
      <TypeScaleStyle/>
      {/* Screen-scoped readability layer (W3-T5):
          - .cost-tbl: 행 높이 28→32px (vertical padding ↑) · 본문 셀 --faint→--dim 으로 승격 (산문 가독 tier).
          - .cost-foot: 카드 하단 footnote/helper line — 11.5px --dim (text-faint mono 보다 한 단 밝게, 읽기용).
          - .kpi-hint --dim override: KPI 타일 sub-caption 을 --faint 에서 --dim 으로 (ui.jsx 정의 셀프 보존, cost 화면만 승격). */}
      <style>{`
        @keyframes skelPulseC { 0%,100%{opacity:.7} 50%{opacity:.35} }
        .cost-tbl td { padding-top: 11px; padding-bottom: 11px; }
        .cost-tbl tbody td { color: rgb(var(--dim)); }
        .cost-tbl tbody td.num { color: rgb(var(--dim)); }
        .cost-foot { font-size: 11.5px; line-height: 1.5; color: rgb(var(--dim)); }
        .cost-screen .kpi-hint { color: rgb(var(--dim)); }
      `}</style>
      <div className="flex-shrink-0">
        <PageHeader
          title="Cost & usage"
          sub="Cost & token usage"
          right={
            <>
              <div className="seg" aria-label="Time range">
                {COST_PERIODS.map((p) => (
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
              <button className="btn ghost sm" onClick={triggerRefresh} aria-label="Refresh cost data">
                <Icon name="refresh" size={14}/>
                Refresh
              </button>
            </>
          }
        />
      </div>

      {/* 1. KPI×4 (R09) — 오늘 비용 · 7일 비용 · 시간당 burn (3h) · 성공 작업당 비용 */}
      <KpiRowC
        kpiState={kpiState}
        token7State={token7State}
        onRetry={triggerRefresh}
      />

      {/* 2. 비용 추이 라인 차트 (T-CST-1) — 단일 Y축 LINE, full-width */}
      <CostTrendCard state={tokenState} days={days} onRetry={triggerRefresh}/>

      {/* 2b. 예산 대비 + burn-rate 투영 (T-CST-4) — BulletBar/텍스트 투영, full-width */}
      <BudgetCard kpiState={kpiState} onRetry={triggerRefresh}/>

      {/* 3. 토큰 누적 영역 차트 (input/output 분할 — magnitude 상이 → 누적 정당) — full-width */}
      <TokenStackedCard state={tokenState} days={days} onRetry={triggerRefresh}/>

      {/* 4. 토큰 카테고리 단가 테이블 (BP-TokenCategoryTable) — full-width 5컬럼 */}
      <TokenCategoryCard state={modelState} days={days} onRetry={triggerRefresh}/>

      {/* 4. 모델별 비용 — full-width (AgentMiniBar 카드 제거 후 단독 row) */}
      <div className="mb-4">
        <ModelCostCard state={modelState} days={days} onRetry={triggerRefresh}/>
      </div>

      {/* 5. 보조 모니터 고유 카드 — 캐시 적중률 + 세션 분포 + parse_error.
          REGION(W3-T5): 16px gap(gap-card 표준) + 각 .card 의 --shadow-raised 로 세 카드가 한 strip 으로 안 뭉치고
          개별 떠오른 면으로 분리. parse_error 는 임계 초과(critDays>0)일 때만 ParseErrorCard 내부에서 --warn 강조(상시 left-rule X). */}
      <div className="grid grid-cols-3 gap-card mb-4">
        <CacheHitCard state={cacheState} days={days} onRetry={triggerRefresh}/>
        <SessionDistributionCard state={sessionState} days={days} onRetry={triggerRefresh}/>
        <ParseErrorCard state={errorState} days={days} onRetry={triggerRefresh}/>
      </div>

      {/* 6. 비용 이상 탐지 (monitor 고유 유지) — full-width */}
      <AnomalyCostCard state={tokenState} days={days} onRetry={triggerRefresh}/>

      {/* 7. 턴 통계 (P2-B) — stop_reason 분포 + turns 집계, full-width */}
      <TurnStatsCard state={turnState} days={days} onRetry={triggerRefresh}/>
    </div>
  );
}

// 1. KPI row × 4 (R09) — 오늘 비용 / 7일 비용 / 시간당 burn (3h) / 성공 작업당 비용.
// 출처 = /api/cost/kpi (고정 윈도우 · KST 기준일). 7일 비용만 7d 일별 시리즈 sparkline 동반 —
// 나머지는 단일 스칼라 → sparkline 없음 (A6).
function KpiRowC({ kpiState, token7State, onRetry }) {
  const { KPI } = window.UI;

  if (kpiState.status === 'loading') {
    return (
      <div className="grid grid-cols-3 gap-3 mb-4" aria-busy="true" aria-label="Loading KPIs">
        {Array.from({ length: 3 }).map((_, i) => <KpiSkeletonC key={i}/>)}
      </div>
    );
  }
  if (kpiState.status === 'error') {
    return (
      <div className="mb-4">
        <ErrorBannerC title="Couldn't load cost KPIs" detail={kpiState.error} onRetry={onRetry}/>
      </div>
    );
  }

  const kpi = kpiState.data || {};
  const todayCost = Number(kpi.today_cost_usd) || 0;
  const week7Cost = Number(kpi.window_7d_cost_usd) || 0;
  // null = 7일 내 done 0건 → '—' (가짜 0 금지).
  const costPerDone = kpi.cost_per_done_usd === null || kpi.cost_per_done_usd === undefined
    ? null
    : Number(kpi.cost_per_done_usd) || 0;
  const doneCount7d = Number(kpi.done_count_7d) || 0;

  // 7일 비용 sparkline + delta — 7d 일별 시리즈 (token7State 재사용).
  const cost7Points = token7State.status === 'ready' ? (token7State.data?.points ?? []) : [];
  const costSpark = cost7Points.length > 0 ? cost7Points.map((p) => Number(p.cost_usd) || 0) : null;
  const costDelta = computeSparkDeltaC(costSpark);

  return (
    <div className="grid grid-cols-3 gap-3 mb-4">
      <KPI
        label="Cost today"
        value={formatUsdC(todayCost)}
        hint={`${window.UI.tzShortLabel()} day`}
      />
      <KPI
        label="Cost, 7 days"
        value={formatUsdC(week7Cost)}
        delta={costDelta}
        deltaInverse={true}
        sparkData={costSpark}
        sparkColor="rgb(var(--crit))"
        hint="last 7 days"
      />
      <KPI
        label="Cost per finished task"
        value={costPerDone === null ? '—' : formatUsdC(costPerDone)}
        hint={costPerDone === null ? 'no done tasks in 7 days' : `7-day cost / ${formatIntC(doneCount7d)} done`}
      />
    </div>
  );
}

function KpiSkeletonC() {
  return (
    <div className="kpi" style={{ pointerEvents: 'none' }}>
      <div className="kpi-label"><SkelC w={80} h={11}/></div>
      <div className="kpi-value" style={{ marginTop: 10 }}><SkelC w={120} h={26}/></div>
    </div>
  );
}

// 2b. BudgetCard (T-CST-4) — 오늘 지출을 자기 7일 일평균 baseline 대비로 BulletBar 표현
// + 3h burn-rate 의 일·월 run-rate TEXT 투영(radial 게이지 금지).
// SLOP 가드: 시스템에 사용자 설정 예산값이 없음 → 예산 수치를 발명하지 않는다.
//   target/zone 은 "자기 7일 일평균" 이라는 실측 baseline 으로만 도출 (lower-is-better=deltaInverse 의미).
//   실 예산 config 소스가 생기면 target 을 그 값으로 교체 (shared_change_needed 로 보고).
function BudgetCard({ kpiState, onRetry }) {
  const { CardHead } = window.UI;

  return (
    <div className="card mb-4">
      <CardHead
        title="Spend vs. baseline"
      />
      <div className="card-body">
        <BudgetBody kpiState={kpiState} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function BudgetBody({ kpiState, onRetry }) {
  const { BulletBar } = window.UI;

  if (kpiState.status === 'loading') {
    return <ChartSkeletonC height={120} aria-label="Loading budget projection"/>;
  }
  if (kpiState.status === 'error') {
    return <ErrorBannerC title="Couldn't load cost KPIs" detail={kpiState.error} onRetry={onRetry}/>;
  }

  const kpi = kpiState.data || {};
  const todayCost = Number(kpi.today_cost_usd) || 0;
  const week7Cost = Number(kpi.window_7d_cost_usd) || 0;
  const burnRate = Number(kpi.burn_rate_3h_usd_per_hour) || 0;

  // 7일 비용 / 7 = 일평균 baseline (실측, 발명 아님). 0 분모 → BulletBar 생략 (placeholder).
  const avgDaily = week7Cost > 0 ? week7Cost / 7 : 0;
  // baseline 대비 비율 — 1.0 = 일평균과 동일. zone 컷: <0.75 ok · <1.25 warn · ≥1.25 crit (lower-is-better).
  // 정규화 분모 = baseline×2 (BulletBar 는 0-1 입력 → today/(avg×2) 로 0.5 가 baseline 위치).
  const ratioNorm = avgDaily > 0 ? Math.min(todayCost / (avgDaily * 2), 1) : 0;
  const targetNorm = avgDaily > 0 ? 0.5 : null;

  // 실 데이터 투영(TEXT) — 3h burn 을 일/월 run-rate 로 외삽. 게이지/radial 아님.
  const projectedDaily = burnRate * 24;
  const projectedMonthly = burnRate * 24 * 30;

  return (
    <div className="flex flex-col gap-4">
      {avgDaily > 0 ? (
        <div>
          <div className="flex items-baseline justify-end mb-1.5">
            <span className="fs-meta font-mono text-dim">
              {formatUsdC(todayCost)} <span className="text-faint">today</span> · {formatUsdC(avgDaily)} <span className="text-faint">7-day avg/day</span>
            </span>
          </div>
          <BulletBar
            value={ratioNorm}
            target={targetNorm}
            zones={BUDGET_ZONES}
            ariaLabel={`Today ${formatUsdC(todayCost)} vs 7-day average ${formatUsdC(avgDaily)} (marker = average)`}
            showValue={false}
          />
          {/* dual-encode: 막대 색 외 텍스트 verdict 도 동반 (색 단독 인코딩 금지). */}
          <div className="cost-foot mt-1.5">
            {budgetVerdictText(todayCost, avgDaily)}
          </div>
        </div>
      ) : (
        <div className="placeholder" style={{ padding: 16 }}>
          No 7-day cost yet — daily-average baseline needs cost in the last 7 days.
        </div>
      )}

      {/* burn-rate 투영 — TEXT only (T-CST-4: not radial). */}
      <div className="grid grid-cols-3 gap-3 items-start">
        <div>
          <div className="fs-meta text-dim">Burn rate</div>
          <div className="font-mono fs-stat font-semibold tracking-tight">
            {formatUsdC(burnRate)}<span className="fs-meta text-dim font-normal ml-1">/h</span>
          </div>
        </div>
        <div>
          <div className="fs-meta text-dim" title="3-hour burn rate extrapolated to 24 hours">Projected / day</div>
          <div className="font-mono fs-stat text-dim tracking-tight">{formatUsdC(projectedDaily)}</div>
        </div>
        <div>
          <div className="fs-meta text-dim" title="3-hour burn rate extrapolated to 30 days">Projected / 30 d</div>
          <div className="font-mono fs-stat text-dim tracking-tight">{formatUsdC(projectedMonthly)}</div>
        </div>
      </div>
    </div>
  );
}

// BulletBar zone cut-points (lower-is-better) — normalized to today/(avg×2):
//   < 0.375 (= today < 0.75×avg) ok · < 0.625 (= today < 1.25×avg) warn · 이상 crit.
const BUDGET_ZONES = [
  { upTo: 0.375, tone: 'ok' },
  { upTo: 0.625, tone: 'warn' },
  { upTo: 1.0,   tone: 'crit' },
];

// 텍스트 verdict — 막대 색의 dual-encode 짝 (색 단독 금지). baseline 대비 배수로 서술.
function budgetVerdictText(todayCost, avgDaily) {
  if (avgDaily <= 0) return '';
  const ratio = todayCost / avgDaily;
  if (ratio < 0.75) return `Below baseline — today is ${(ratio * 100).toFixed(0)}% of the 7-day daily average.`;
  if (ratio < 1.25) return `Around baseline — today is ${(ratio * 100).toFixed(0)}% of the 7-day daily average.`;
  return `Above baseline — today is ${(ratio * 100).toFixed(0)}% of the 7-day daily average (running hot).`;
}

// 2. CostTrendCard — 일별 비용 단일 Y축 LINE 차트 (T-CST-1).
// cost-over-time 의 1차 표현은 라인 (단일 magnitude → 누적 영역 불필요). 토큰 input/output 분할만
// 누적 영역(서로 다른 magnitude)으로 별도 카드에서 표현 (TokenStackedCard).
function CostTrendCard({ state, days, onRetry }) {
  const { CardHead } = window.UI;

  return (
    <div className="card mb-4">
      <CardHead
        title="Cost over time"
      />
      <div className="card-body">
        <CostTrendBody state={state} days={days} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function CostTrendBody({ state, days, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonC height={260} aria-label="Loading cost trend"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerC title="Couldn't load cost trend" detail={state.error} onRetry={onRetry}/>;
  }

  const points = state.data?.points ?? state.data?.rows ?? [];
  if (points.length === 0) {
    return <EmptyStateC message={`No cost events in the last ${days} days.`}/>;
  }

  const totalCost = points.reduce((s, p) => s + (Number(p.cost_usd) || 0), 0);
  const avgDaily = points.length > 0 ? totalCost / points.length : 0;
  const peak = points.reduce(
    (best, p) => {
      const c = Number(p.cost_usd) || 0;
      return c > best.cost ? { cost: c, date: p.date } : best;
    },
    { cost: 0, date: null },
  );

  const rows = points.map((p) => ({
    date: typeof p.date === 'string' ? p.date.slice(5) : '',
    fullDate: p.date,
    cost_usd: Number(p.cost_usd) || 0,
    session_count: Number(p.session_count) || 0,
  }));

  return (
    <>
      {/* 동일 크기(fs-display) · 위계는 강조(합계=semibold·기본색 / 평균·피크=text-dim)로만 표현 → baseline 정렬. */}
      <div className="flex items-start gap-4 mb-3">
        <div>
          <div className="fs-meta text-dim">Period total</div>
          <div className="font-mono fs-display font-semibold tracking-tight">{formatUsdC(totalCost)}</div>
        </div>
        <div>
          <div className="fs-meta text-dim">Period avg/day</div>
          <div className="font-mono fs-display text-dim tracking-tight">{formatUsdC(avgDaily)}</div>
        </div>
        <div>
          <div className="fs-meta text-dim">Peak day</div>
          <div className="font-mono fs-display text-dim tracking-tight">
            {peak.cost > 0 ? formatUsdC(peak.cost) : '—'}
          </div>
        </div>
      </div>
      <div style={{ width: '100%', height: 260 }}>
        <CostTrendChart rows={rows}/>
      </div>
    </>
  );
}

// 단일 Y축 LINE 차트 — gridline 없음(--faint 톤 약하게 horizontal 만). cost magnitude 단일 → 라인.
// annotations (T-CST-5): { date, label } 실 이벤트 배열. 비어있으면(기본) 아무것도 렌더 안 함 —
// 가짜 마커 발명 금지(SLOP 가드). 실 이벤트 데이터 소스가 생기면 props 로 주입.
function CostTrendChart({ rows, annotations = [] }) {
  const { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } = window.Recharts;

  // x축 dataKey 는 MM-DD 슬라이스 — annotation date 도 동일 형식으로 매칭 (full ISO → slice(5)).
  const annoByX = annotations
    .map((a) => ({ x: typeof a.date === 'string' ? a.date.slice(5) : a.date, label: a.label }))
    .filter((a) => a.x && rows.some((r) => r.date === a.x));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        {/* faint gridline — 수평만, --line 위 0.6 opacity 로 거의 안 보이게 (T-CST-1 faint/no gridlines). */}
        <CartesianGrid stroke="rgb(var(--line) / 0.6)" strokeDasharray="2 4" vertical={false}/>
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
          axisLine={{ stroke: 'rgb(var(--line))' }}
          tickLine={false}
        />
        <YAxis
          tickFormatter={formatUsdAxisC}
          tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
          axisLine={{ stroke: 'rgb(var(--line))' }}
          tickLine={false}
          width={56}
        />
        <Tooltip content={<CostTrendTooltipC/>}/>
        {annoByX.map((a, i) => (
          <ReferenceLine
            key={i}
            x={a.x}
            stroke="rgb(var(--warn))"
            strokeDasharray="3 3"
            label={{ value: a.label, position: 'insideTop', fontSize: 9, fill: 'rgb(var(--warn))' }}
          />
        ))}
        <Line
          type="monotone"
          dataKey="cost_usd"
          stroke="rgb(var(--accent))"
          strokeWidth={2}
          dot={{ r: 2, fill: 'rgb(var(--accent))', stroke: 'none' }}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function CostTrendTooltipC({ active, payload }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const row = payload[0].payload;
  return (
    <div style={tooltipStyle}>
      <div style={{ color: 'rgb(var(--ink))', marginBottom: 4, fontWeight: 600 }}>{row.fullDate}</div>
      <div style={tooltipRowStyle}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: 'rgb(var(--accent))' }}/>
        Daily cost {formatUsdC(row.cost_usd)}
      </div>
      <div style={{ color: 'rgb(var(--dim))' }}>Sessions {formatIntC(row.session_count)}</div>
    </div>
  );
}

// 3. TokenStackedCard — input/output(+cache) 토큰 분할 누적 (7d=bar, 30d/90d=area).
// 토큰 type 별 magnitude 가 서로 달라(예: cache_read >> output) 누적 영역이 정당 (T-CST-1 예외).
function TokenStackedCard({ state, days, onRetry }) {
  const { CardHead } = window.UI;

  return (
    <div className="card mb-4">
      <CardHead
        title="Token usage over time"
        right={<TokenLegend/>}
      />
      <div className="card-body">
        <TokenStackedBody state={state} days={days} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function TokenLegend() {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {TOKEN_CATEGORIES.map((cat) => (
        <div key={cat.key} className="flex items-center gap-1.5 fs-meta text-dim">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: `rgb(var(${cat.colorVar}))` }}/>
          {cat.label}
        </div>
      ))}
    </div>
  );
}

function TokenStackedBody({ state, days, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonC height={300} aria-label="Loading token trend"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerC title="Couldn't load token trend" detail={state.error} onRetry={onRetry}/>;
  }

  // cost-timeseries 응답은 `points` (구버전 `rows` 폴백 보존).
  const points = state.data?.points ?? state.data?.rows ?? [];
  if (points.length === 0) {
    return <EmptyStateC message={`No cost events in the last ${days} days.`}/>;
  }

  const totalTokens = points.reduce(
    (s, p) =>
      s +
      (Number(p.input_tokens) || 0) +
      (Number(p.output_tokens) || 0) +
      (Number(p.cache_read_tokens) || 0) +
      (Number(p.cache_creation_tokens) || 0),
    0,
  );

  return (
    <>
      {/* 세 수치 동일 크기(display 토큰 22px) — 위계는 강조(기간 합계=semibold·기본색 / 토큰·세션=text-dim)로만 표현 → 베이스라인 정렬.
          카드 지배 hero — 기존 20px 가 fs-stat(18) 로 축소됐던 것을 display 로 승격 → dashboard hero 와 크기 일치. */}
      <div className="flex items-start gap-4 mb-3">
        <div>
          <div className="fs-meta text-dim">Tokens</div>
          <div className="font-mono fs-display text-dim tracking-tight">{formatTokenCompactC(totalTokens)}</div>
        </div>
      </div>
      {/* 7d = stacked column · 30d/90d = stacked area. */}
      <div style={{ width: '100%', height: 280 }}>
        {days === 7 ? <TokenStackedColumn points={points}/> : <TokenStackedArea points={points}/>}
      </div>
    </>
  );
}

// 토큰 누적 차트용 row builder (Area·Column 공유).
function toTokenChartRows(points) {
  return points.map((p) => ({
    date: typeof p.date === 'string' ? p.date.slice(5) : '',
    fullDate: p.date,
    cost_usd: Number(p.cost_usd) || 0,
    session_count: Number(p.session_count) || 0,
    cache_creation_tokens: Number(p.cache_creation_tokens) || 0,
    cache_read_tokens:     Number(p.cache_read_tokens) || 0,
    input_tokens:          Number(p.input_tokens) || 0,
    output_tokens:         Number(p.output_tokens) || 0,
  }));
}

function TokenStackedArea({ points }) {
  const { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } = window.Recharts;

  const rows = toTokenChartRows(points);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {TOKEN_CATEGORIES.map((cat) => (
            <linearGradient key={cat.key} id={`tokGradC-${cat.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={`rgb(var(${cat.colorVar}))`} stopOpacity={0.55}/>
              <stop offset="100%" stopColor={`rgb(var(${cat.colorVar}))`} stopOpacity={0.05}/>
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false}/>
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
          axisLine={{ stroke: 'rgb(var(--line))' }}
          tickLine={false}
        />
        <YAxis
          tickFormatter={formatTokenCompactC}
          tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
          axisLine={{ stroke: 'rgb(var(--line))' }}
          tickLine={false}
          width={48}
        />
        <Tooltip content={<TokenTooltipC/>}/>
        {TOKEN_CATEGORIES.map((cat) => (
          <Area
            key={cat.key}
            type="monotone"
            dataKey={cat.key}
            stackId="tokens"
            stroke={`rgb(var(${cat.colorVar}))`}
            strokeWidth={1.5}
            fill={`url(#tokGradC-${cat.key})`}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function TokenStackedColumn({ points }) {
  const { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } = window.Recharts;

  const rows = toTokenChartRows(points);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false}/>
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
          axisLine={{ stroke: 'rgb(var(--line))' }}
          tickLine={false}
        />
        <YAxis
          tickFormatter={formatTokenCompactC}
          tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
          axisLine={{ stroke: 'rgb(var(--line))' }}
          tickLine={false}
          width={48}
        />
        <Tooltip content={<TokenTooltipC/>} cursor={{ fill: 'rgb(var(--accent) / 0.06)' }}/>
        {TOKEN_CATEGORIES.map((cat) => (
          <Bar
            key={cat.key}
            dataKey={cat.key}
            stackId="tokens"
            fill={`rgb(var(${cat.colorVar}) / 0.85)`}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function TokenTooltipC({ active, payload }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const row = payload[0].payload;
  const totalTokens =
    row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_creation_tokens;

  return (
    <div style={tooltipStyle}>
      <div style={{ color: 'rgb(var(--ink))', marginBottom: 4, fontWeight: 600 }}>{row.fullDate}</div>
      <div style={{ color: 'rgb(var(--dim))' }}>
        Cost {formatUsdC(row.cost_usd)} · sessions {formatIntC(row.session_count)}
      </div>
      <div style={{ color: 'rgb(var(--dim))', marginBottom: 6 }}>
        Total tokens {formatTokenCompactC(totalTokens)}
      </div>
      {TOKEN_CATEGORIES.slice().reverse().map((cat) => (
        <div key={cat.key} style={tooltipRowStyle}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: `rgb(var(${cat.colorVar}))` }}/>
          {cat.label} {formatTokenCompactC(row[cat.key])}
        </div>
      ))}
    </div>
  );
}

// 3. TokenCategoryCard — 4컬럼 테이블 (카테고리·토큰·비용·비중).
// 비용·비중 = /api/cost/by-model cost_usd 를 카테고리 단가·토큰 가중(tokens × rate/1M)으로 분배 → KPI '월 비용' 과 동일 출처 (Σ = cost_usd 합계 일치).
// 단순 토큰 COUNT 비율은 카테고리간 단가차 무시 → 고단가·저COUNT인 output 과소표시 → 단가 가중으로 교정 (단가 미상 모델은 COUNT 비율 폴백).
// 단가/1M 컬럼 미노출 — 빌링과 무관한 Sonnet 단일 대표값이라 오해 유발 → 단가는 ModelCostCard 귀속.
function TokenCategoryCard({ state, days, onRetry }) {
  const { CardHead } = window.UI;
  return (
    <div className="card mb-4">
      <CardHead
        title="Cost by token type"
      />
      <div className="card-body flush">
        <TokenCategoryBody state={state} days={days} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function TokenCategoryBody({ state, days, onRetry }) {
  const { Bar } = window.UI;
  if (state.status === 'loading') {
    return <div className="p-4"><ChartSkeletonC height={180} aria-label="Loading price table"/></div>;
  }
  if (state.status === 'error') {
    return <div className="p-4"><ErrorBannerC title="Couldn't load cost by model" detail={state.error} onRetry={onRetry}/></div>;
  }

  const modelRows = state.data?.rows ?? [];
  if (modelRows.length === 0) {
    return <div className="p-4"><EmptyStateC message={`No cost events in the last ${days} days.`}/></div>;
  }

  const categoryRates = window.TOKEN_CATEGORY_RATES || [];

  // 모델별 카테고리 가중치 — 단가 가중(tokens × rate/1M) 분배의 분모.
  // 토큰 COUNT 비율은 카테고리간 단가차(Opus output $75 vs cache_read $1.5 = 50배) 무시 → 고단가·저COUNT output 을 ~8배 과소표시 → 단가 가중으로 교정.
  // 단가 미상 모델(카탈로그 키 부재) → tokens × 1 = 순수 COUNT 비율 폴백 (비용 0/누락 없이 기존 거동 유지).
  // getTokenRate = exact + family-prefix — date-suffixed id 도 family 단가로 해소 (silent COUNT 폴백 방지).
  const modelWeights = (m) => {
    const rates = window.getTokenRate(m.model);
    const weight = {};
    let sum = 0;
    for (const cat of categoryRates) {
      const tk = Number(m[cat.key]) || 0;
      const rate = rates ? (Number(rates[cat.rateKey]) || 0) : 1;
      const w = tk * rate;
      weight[cat.key] = w;
      sum += w;
    }
    return { weight, sum };
  };

  // 카테고리별 집계 — tokens = 전 모델 raw 합 · cost = Σ_models(cost_usd × 단가가중 share).
  // 권위 출처(API cost_usd)를 단가·토큰 가중으로 분배 → Σ category cost = cost_usd 불변 → 테이블 합계 = KPI '월 비용' 일치.
  // Σ weight === 0(전 토큰 0) → 해당 모델 0 기여, 0 나눗셈 회피.
  const acc = new Map(categoryRates.map((cat) => [cat.key, { tokens: 0, cost: 0 }]));
  for (const m of modelRows) {
    const costUsd = Number(m.cost_usd) || 0;
    const { weight, sum } = modelWeights(m);
    for (const cat of categoryRates) {
      const bucket = acc.get(cat.key);
      bucket.tokens += Number(m[cat.key]) || 0;
      if (sum > 0) {
        bucket.cost += (costUsd * weight[cat.key]) / sum;
      }
    }
  }

  const rows = categoryRates.map((cat) => ({
    key: cat.key,
    label: cat.label,
    colorVar: cat.colorVar,
    tokens: acc.get(cat.key).tokens,
    cost: acc.get(cat.key).cost,
  }));

  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const finalRows = rows.map((r) => ({
    ...r,
    pct: totalCost > 0 ? (r.cost / totalCost) : 0,
  }));

  return (
    <table className="tbl cost-tbl">
      <thead>
        <tr>
          <th>Type</th>
          <th className="num">Tokens</th>
          <th className="num">Cost</th>
          <th className="num">Share</th>
        </tr>
      </thead>
      <tbody>
        {finalRows.map((r) => (
          <tr key={r.key}>
            <td>
              <span
                className="inline-block w-[3px] h-3 rounded-sm mr-3 align-middle"
                style={{ background: `rgb(var(${r.colorVar}))` }}
              />
              {r.label}
            </td>
            <td className="num">{formatTokenCompactC(r.tokens)}</td>
            <td className="num">{formatUsdC(r.cost)}</td>
            {/* per-row share% — 행 자체 비중을 비례막대로 (100% 누적 단일막대 아님) · 텍스트 %가 정확수치, 막대는 길이로 비교 보조. */}
            <td className="num">
              <div className="flex items-center justify-end gap-2">
                <div className="w-20 shrink-0">
                  <Bar value={r.pct} tone="info" ariaLabel={`${r.label} share ${(r.pct * 100).toFixed(1)}%`}/>
                </div>
                <span className="text-dim">{(r.pct * 100).toFixed(1)}%</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// 4. ModelCostCard — 모델별 누적 비용 (4분류 contribution 분해 stacked bar).

// 비실모델 버킷 — 'unknown' = COALESCE(model,'unknown') 미귀속 legacy 행 ·
// '<synthetic>' = subagent-scan sentinel (서버가 zero-token 행은 제외, 잔존 행도 실모델 아님).
const UNATTRIBUTED_MODEL_KEYS = new Set(['unknown', '<synthetic>']);
const UNATTRIBUTED_MODEL_LABEL = 'Unattributed';

function isUnattributedModel(model) {
  return UNATTRIBUTED_MODEL_KEYS.has(model);
}

function ModelCostCard({ state, days, onRetry }) {
  const { CardHead, Pill } = window.UI;

  const rows = state.status === 'ready' ? (state.data?.rows ?? []) : [];
  // pill 카운트 분리 — 실모델 N개 + 미귀속 legacy 1개를 합산 표기하지 않음.
  const unattributedCount = rows.reduce((s, r) => s + (isUnattributedModel(r.model) ? 1 : 0), 0);
  const realModelCount = rows.length - unattributedCount;
  // 단가 카탈로그 미등록 실모델 — COUNT 폴백 분배 중임을 카드 레벨에서 가시화 (F28).
  // getTokenRate = exact + family-prefix → date-suffixed id 는 family 단가로 해소되므로 실제 miss 만 카운트.
  const fallbackCount = rows.reduce(
    (s, r) => s + (!isUnattributedModel(r.model) && !window.getTokenRate(r.model) ? 1 : 0), 0);

  return (
    <div className="card">
      <CardHead
        title="Cost by model"
        right={fallbackCount > 0
          ? (
            <span title={`${fallbackCount} model${fallbackCount === 1 ? '' : 's'} without a catalog price — cost split falls back to token-count ratio`}>
              <Pill tone="warn">{fallbackCount} est. rate</Pill>
            </span>
          )
          : null}
      />
      <div className="card-body">
        <ModelCostBody state={state} days={days} onRetry={onRetry}/>
      </div>
    </div>
  );
}

// Top-N 실모델 + 나머지 'Other' 롤업 (T-CST-3 — NOT pie). 미귀속/단가미상 행은 정상 실모델과
// 동일 정렬 풀에서 비용 desc → 상위 N 외 전부 단일 Other 버킷으로 합산 (avg/session 은 합산 후 재계산).
const MODEL_TOPN = 5;

function rollupModelRows(modelRows, topN) {
  const sorted = modelRows.slice().sort((a, b) => b.cost_usd - a.cost_usd);
  if (sorted.length <= topN + 1) {
    return { top: sorted, other: null };
  }
  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  const other = rest.reduce(
    (acc, r) => ({
      cost_usd: acc.cost_usd + r.cost_usd,
      input_tokens: acc.input_tokens + r.input_tokens,
      output_tokens: acc.output_tokens + r.output_tokens,
      session_count: acc.session_count + r.session_count,
      count: acc.count + 1,
    }),
    { cost_usd: 0, input_tokens: 0, output_tokens: 0, session_count: 0, count: 0 },
  );
  return { top, other };
}

function ModelCostBody({ state, days, onRetry }) {
  const STICKY_TH_STYLE = window.UI.STICKY_TH_STYLE;

  if (state.status === 'loading') {
    return <ChartSkeletonC height={300} aria-label="Loading cost by model"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerC title="Couldn't load cost by model" detail={state.error} onRetry={onRetry}/>;
  }

  const rows = state.data?.rows ?? [];
  if (rows.length === 0) {
    return <EmptyStateC message={`No per-model cost events in the last ${days} days.`}/>;
  }

  const modelRows = buildModelCostRows(rows);
  const { top, other } = rollupModelRows(modelRows, MODEL_TOPN);

  // 합계 footer — Top + Other 전부 포함 (전 모델 합).
  const totalCost = modelRows.reduce((s, r) => s + r.cost_usd, 0);
  const totalIn = modelRows.reduce((s, r) => s + r.input_tokens, 0);
  const totalOut = modelRows.reduce((s, r) => s + r.output_tokens, 0);
  const totalSessions = modelRows.reduce((s, r) => s + r.session_count, 0);

  return (
    <div style={{ maxHeight: 360, overflowY: 'auto' }}>
      <table className="tbl cost-tbl">
        <thead>
          <tr>
            <th style={STICKY_TH_STYLE}>Model</th>
            <th className="num" style={STICKY_TH_STYLE}>Cost</th>
            <th className="num" style={STICKY_TH_STYLE}>Tokens in</th>
            <th className="num" style={STICKY_TH_STYLE}>Tokens out</th>
            <th className="num" style={STICKY_TH_STYLE}>Sessions</th>
            <th className="num" style={STICKY_TH_STYLE}>Avg / session</th>
          </tr>
        </thead>
        <tbody>
          {top.map((r) => (
            <ModelCostRow key={r.fullModel} r={r}/>
          ))}
          {other && (
            <tr>
              <td>
                <span className="text-dim" title={`${other.count} more models rolled up`}>Other</span>
              </td>
              <td className="num">{formatUsdC(other.cost_usd)}</td>
              <td className="num">{formatTokenCompactC(other.input_tokens)}</td>
              <td className="num">{formatTokenCompactC(other.output_tokens)}</td>
              <td className="num">{formatIntC(other.session_count)}</td>
              <td className="num text-dim">
                {other.session_count > 0 ? formatUsdC(other.cost_usd / other.session_count) : '—'}
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid rgb(var(--line))' }}>
            <td className="font-semibold">Total</td>
            <td className="num font-semibold">{formatUsdC(totalCost)}</td>
            <td className="num font-semibold">{formatTokenCompactC(totalIn)}</td>
            <td className="num font-semibold">{formatTokenCompactC(totalOut)}</td>
            <td className="num font-semibold">{formatIntC(totalSessions)}</td>
            <td className="num font-semibold">
              {totalSessions > 0 ? formatUsdC(totalCost / totalSessions) : '—'}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ModelCostRow({ r }) {
  const avgPerSession = r.session_count > 0 ? r.cost_usd / r.session_count : null;
  return (
    <tr>
      <td>
        <span className="font-mono" title={r.fullModel}>{r.model}</span>
      </td>
      <td className="num">{formatUsdC(r.cost_usd)}</td>
      <td className="num">{formatTokenCompactC(r.input_tokens)}</td>
      <td className="num">{formatTokenCompactC(r.output_tokens)}</td>
      <td className="num">{formatIntC(r.session_count)}</td>
      <td className="num text-dim">{avgPerSession === null ? '—' : formatUsdC(avgPerSession)}</td>
    </tr>
  );
}

// 모델별 카테고리 USD 기여도 (sub-bar) — TokenCategoryCard 와 동일한 단가 가중(tokens × rate/1M) 분배.
// 토큰 COUNT 비율은 카테고리간 단가차(output vs cache_read ~50배) 무시 → output 과소표시 → 단가 가중으로 교정.
// 단가 미상 모델(카탈로그 키 부재) → rate=1 = COUNT 비율 폴백 + rateFallback 마킹 (silent degrade 차단, F28).
function buildModelCostRows(rows) {
  return rows.map((r) => {
    const inputN  = Number(r.input_tokens) || 0;
    const outputN = Number(r.output_tokens) || 0;
    const cacheR  = Number(r.cache_read_tokens) || 0;
    const cacheC  = Number(r.cache_creation_tokens) || 0;
    const cost    = Number(r.cost_usd) || 0;
    const unattributed = isUnattributedModel(r.model);
    // getTokenRate = exact + family-prefix — date-suffixed id 도 family 단가로 해소.
    const rates = window.getTokenRate(r.model);
    const rateFallback = !rates;
    const rateOf = (key) => (rates ? (Number(rates[key]) || 0) : 1);
    const weights = {
      input:          inputN  * rateOf('input'),
      output:         outputN * rateOf('output'),
      cache_read:     cacheR  * rateOf('cache_read'),
      cache_creation: cacheC  * rateOf('cache_creation'),
    };
    const weightSum = weights.input + weights.output + weights.cache_read + weights.cache_creation;
    const split = (w) => (weightSum > 0 ? (cost * w) / weightSum : 0);
    return {
      // 미귀속 legacy 행은 축약 정규식 비매치 → 명시 라벨로 치환.
      model: unattributed ? UNATTRIBUTED_MODEL_LABEL : shortenModelName(r.model),
      fullModel: r.model,
      unattributed,
      rateFallback,
      cost_usd: cost,
      session_count: Number(r.session_count) || 0,
      input_tokens: inputN,
      output_tokens: outputN,
      cache_read_tokens: cacheR,
      cache_creation_tokens: cacheC,
      cost_input: split(weights.input),
      cost_output: split(weights.output),
      cost_cache_read: split(weights.cache_read),
      cost_cache_creation: split(weights.cache_creation),
    };
  });
}

// C2 결정(차트→테이블 전환 KEEP)으로 ModelCostChart / ModelCostTooltipC 제거 — 모델별 비용은
// ModelCostBody 테이블이 담당(share 막대 스캔 가능). Recharts 는 다른 차트에서 계속 사용.

// 5b. CacheHitCard — cache_read / total_input 라인 차트.
function CacheHitCard({ state, days, onRetry }) {
  const { CardHead } = window.UI;
  return (
    <div className="card">
      <CardHead
        title="Cache hit rate"
      />
      <div className="card-body">
        <CacheHitBody state={state} days={days} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function CacheHitBody({ state, days, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonC height={220} aria-label="Loading cache hit rate"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerC title="Couldn't load cache hit rate" detail={state.error} onRetry={onRetry}/>;
  }

  const rows = state.data?.rows ?? [];
  if (rows.length === 0) {
    return <EmptyStateC message={`No cache-hit events in the last ${days} days.`}/>;
  }

  // 헤더 summary = 합산(pooled) 적중률 — Σcache_read / Σ(input+cache_read).
  // 일별 비율 평균(mean-of-daily-rates)은 저트래픽 일을 고트래픽 일과 동일 가중해 왜곡 →
  // 표본 가중 합산으로 교정 (A5). 서버 per-day 분모(input+cache_read)와 동일 기준.
  const totalCacheRead = rows.reduce((s, r) => s + (Number(r.total_cache_read) || 0), 0);
  const totalInputAll  = rows.reduce((s, r) => s + (Number(r.total_input) || 0), 0);
  const pooledDenominator = totalInputAll + totalCacheRead;
  const pooledRate = pooledDenominator > 0 ? totalCacheRead / pooledDenominator : null;

  const chartRows = rows.map((r) => ({
    date: typeof r.event_date === 'string' ? r.event_date.slice(5) : '',
    fullDate: r.event_date,
    rate_pct: r.cache_hit_rate === null || r.cache_hit_rate === undefined
      ? null
      : Number(r.cache_hit_rate) * 100,
    total_cache_read: Number(r.total_cache_read) || 0,
    total_input: Number(r.total_input) || 0,
  }));

  // 실측 범위로 Y 도메인 auto-zoom — 고정 [0,100] 은 99%대 변동을 평탄화함.
  const yDomain = computeCacheYDomain(chartRows);

  return (
    <>
      <div className="flex items-baseline gap-3 mb-3">
        <div className="font-mono fs-stat font-semibold tracking-tight">
          {pooledRate === null ? '—' : (pooledRate * 100).toFixed(1) + '%'}
        </div>
        <div className="fs-meta text-dim">pooled hit rate</div>
      </div>
      <div style={{ width: '100%', height: 220 }}>
        <CacheHitChart rows={chartRows} yDomain={yDomain}/>
      </div>
    </>
  );
}

// 적중률 라인 Y 도메인 — 실측 min/max 에 패딩(±1%p) 후 [0,100] 클램프.
// 유효값 0개 / 단일값이면 고정 [0,100] 폴백 (auto-zoom 무의미).
function computeCacheYDomain(chartRows) {
  const vals = chartRows
    .map((r) => r.rate_pct)
    .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (vals.length === 0) return [0, 100];
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (max - min < 0.01) return [0, 100];
  const pad = Math.max(1, (max - min) * 0.15);
  return [Math.max(0, min - pad), Math.min(100, max + pad)];
}

function CacheHitChart({ rows, yDomain = [0, 100] }) {
  const { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } = window.Recharts;

  // 실측 도메인 폭이 좁으면(<5%p) 소수 1자리 눈금, 넓으면 정수 눈금.
  const narrow = yDomain[1] - yDomain[0] < 5;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false}/>
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
          axisLine={{ stroke: 'rgb(var(--line))' }}
          tickLine={false}
        />
        <YAxis
          domain={yDomain}
          tickFormatter={(v) => v.toFixed(narrow ? 1 : 0) + '%'}
          tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
          axisLine={{ stroke: 'rgb(var(--line))' }}
          tickLine={false}
          width={narrow ? 50 : 42}
        />
        <Tooltip content={<CacheHitTooltipC/>}/>
        <Line
          type="monotone"
          dataKey="rate_pct"
          stroke="rgb(var(--info))"
          strokeWidth={2}
          dot={{ r: 2.5, fill: 'rgb(var(--info))', stroke: 'none' }}
          activeDot={{ r: 4 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function CacheHitTooltipC({ active, payload }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const row = payload[0].payload;
  const ratePct = row.rate_pct;
  return (
    <div style={tooltipStyle}>
      <div style={{ color: 'rgb(var(--ink))', marginBottom: 4, fontWeight: 600 }}>{row.fullDate}</div>
      <div style={{ color: 'rgb(var(--dim))' }}>
        Hit rate {ratePct === null || ratePct === undefined ? 'no data' : ratePct.toFixed(1) + '%'}
      </div>
      <div style={{ color: 'rgb(var(--dim))' }}>
        cache_read {formatTokenCompactC(row.total_cache_read)} · input {formatTokenCompactC(row.total_input)}
      </div>
    </div>
  );
}

// 5c. SessionDistributionCard — 세션 비용 히스토그램 + bin 클릭 모달.
function SessionDistributionCard({ state, days, onRetry }) {
  const { CardHead, Pill } = window.UI;
  const truncated = state.status === 'ready' && state.data?.truncated === true;
  const totalCount = state.status === 'ready' ? Number(state.data?.total_session_count) || 0 : 0;
  const visibleCount = state.status === 'ready' ? (state.data?.rows?.length ?? 0) : 0;

  return (
    <div className="card">
      <CardHead
        title="Cost per session"
        sub={`${visibleCount.toLocaleString('en-US')} sessions`}
        right={truncated
          ? <span title={`Showing ${visibleCount} of ${totalCount} sessions`}><Pill tone="warn">Truncated</Pill></span>
          : null}
      />
      <div className="card-body">
        <SessionDistributionBody state={state} days={days} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function SessionDistributionBody({ state, days, onRetry }) {
  const [activeBin, setActiveBin] = useStateC(null);

  // Hooks 는 early-return 전에 호출 — 데이터 미준비 시 빈 배열로 안전 처리.
  const sessions = state.status === 'ready' ? (state.data?.rows ?? []) : [];

  const binData = useMemoC(() => computeSessionBins(sessions), [sessions]);

  if (state.status === 'loading') {
    return <ChartSkeletonC height={220} aria-label="Loading session distribution"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerC title="Couldn't load session distribution" detail={state.error} onRetry={onRetry}/>;
  }
  if (sessions.length === 0) {
    return <EmptyStateC message={`No session events in the last ${days} days.`}/>;
  }

  return (
    <>
      <div style={{ width: '100%', height: 220 }}>
        <SessionDistributionChart bins={binData} onBinClick={setActiveBin}/>
      </div>
      {activeBin && (
        <SessionBinModal
          bin={activeBin}
          sessions={sessions}
          onClose={() => setActiveBin(null)}
        />
      )}
    </>
  );
}

function SessionDistributionChart({ bins, onBinClick }) {
  const { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, CartesianGrid } = window.Recharts;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={bins}
        margin={{ top: 6, right: 8, left: 0, bottom: 0 }}
        onClick={(e) => {
          if (e?.activePayload?.[0]?.payload) {
            const bin = e.activePayload[0].payload;
            if (bin.count > 0) onBinClick(bin);
          }
        }}>
        <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false}/>
        <XAxis
          dataKey="label"
          tick={{ fontSize: 9, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
          axisLine={{ stroke: 'rgb(var(--line))' }}
          tickLine={false}
          interval={0}
          angle={-30}
          textAnchor="end"
          height={50}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
          axisLine={{ stroke: 'rgb(var(--line))' }}
          tickLine={false}
          width={36}
        />
        <Tooltip content={<SessionBinTooltipC/>} cursor={{ fill: 'rgb(var(--accent) / 0.06)' }}/>
        <Bar dataKey="count" isAnimationActive={false} cursor="pointer">
          {bins.map((b, i) => (
            <Cell
              key={i}
              fill={b.isOutlier ? 'rgb(var(--warn) / 0.85)' : 'rgb(var(--accent) / 0.85)'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function SessionBinTooltipC({ active, payload }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const bin = payload[0].payload;
  return (
    <div style={tooltipStyle}>
      <div style={{ color: 'rgb(var(--ink))', marginBottom: 4, fontWeight: 600 }}>{bin.label}</div>
      <div style={{ color: 'rgb(var(--dim))' }}>{bin.count.toLocaleString('en-US')} sessions</div>
    </div>
  );
}

function SessionBinModal({ bin, sessions, onClose }) {
  const { DetailSurface, formatRelativeTime, formatKstFull } = window.UI;

  // 본 bin 내 비용 desc 상위 20개 (drawer density cap).
  const matched = sessions
    .filter((s) => {
      const cost = Number(s.total_cost_usd) || 0;
      return cost >= bin.min && cost < bin.max;
    })
    .sort((a, b) => (Number(b.total_cost_usd) || 0) - (Number(a.total_cost_usd) || 0))
    .slice(0, 20);

  return (
    <DetailSurface open onClose={onClose} variant="drawer"
      title={`${bin.label} bucket — top ${matched.length}`}>
      {matched.length === 0
        ? <div className="fs-body text-dim">No sessions to show.</div>
        : (
          <div className="space-y-1.5">
            {matched.map((s) => (
              // 행 텍스트 text-[11.5px]→fs-meta(11px) 최근접 (11.5↔11 차 0.5 < 11.5↔12 차 0.5 동률 → 보조 meta 콘텐츠라 meta 채택).
              <div
                key={s.session_id}
                className="flex items-center gap-3 fs-meta font-mono py-1.5 border-b border-line">
                <span className="text-dim truncate flex-1" title={s.session_id}>
                  {s.session_id}
                </span>
                <span className="text-ink font-semibold">
                  {formatUsdC(s.total_cost_usd)}
                </span>
                <span className="text-faint w-20 text-right">
                  {formatTokenCompactC(s.total_tokens)}
                </span>
                <span className="text-faint w-16 text-right">
                  {formatIntC(s.event_count)} events
                </span>
                {/* last_event_at = 실 UTC ISO 시각 → 상대표시 + hover 절대시각 KST 명시 (브라우저 로컬 tz 비의존). */}
                <span
                  className="text-dim w-32 text-right"
                  title={s.last_event_at ? formatKstFull(s.last_event_at) : undefined}>
                  {s.last_event_at ? formatRelativeTime(s.last_event_at) : '—'}
                </span>
              </div>
            ))}
          </div>
        )
      }
    </DetailSurface>
  );
}

// 5d. ParseErrorCard — 일별 error_count + error_ratio 임계 강조.
// REGION(W3-T5): error_ratio 가 임계 초과한 날이 있을 때(true alert)만 카드 좌측 --warn rule.
//   상시 left-rule 금지 — 평시엔 일반 카드, 실 경보일 때만 시각 강조 (색은 단독 인코딩 아님: 내부 crit Pill + aria 가 의미 전달).
function ParseErrorCard({ state, days, onRetry }) {
  const { CardHead } = window.UI;
  const rows = state.status === 'ready' ? (state.data?.rows ?? []) : [];
  const hasAlert = rows.some((r) => (Number(r.error_ratio) || 0) > PARSE_ERROR_CRIT_THRESHOLD);
  return (
    <div
      className="card"
      style={hasAlert ? { borderLeft: '3px solid rgb(var(--warn))' } : undefined}>
      <CardHead
        title="Unreadable log entries"
      />
      <div className="card-body">
        <ParseErrorBody state={state} days={days} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function ParseErrorBody({ state, days, onRetry }) {
  const { Badge } = window.UI;

  if (state.status === 'loading') {
    return <ChartSkeletonC height={220} aria-label="Loading parse_error trend"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerC title="Couldn't load parse_error data" detail={state.error} onRetry={onRetry}/>;
  }

  const rows = state.data?.rows ?? [];
  if (rows.length === 0) {
    return <EmptyStateC message={`No data in the last ${days} days.`}/>;
  }

  const totalErrors = rows.reduce((s, r) => s + (Number(r.error_count) || 0), 0);
  const totalEvents = rows.reduce((s, r) => s + (Number(r.total_count) || 0), 0);

  // 마지막 발생일 — rows 는 event_date ASC 정렬 (server) · findLast 대신 수동 역순.
  let lastErrorDate = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if ((Number(rows[i].error_count) || 0) > 0) {
      lastErrorDate = rows[i].event_date;
      break;
    }
  }

  const chartRows = rows.map((r) => ({
    date: typeof r.event_date === 'string' ? r.event_date.slice(5) : '',
    fullDate: r.event_date,
    error_count: Number(r.error_count) || 0,
    total_count: Number(r.total_count) || 0,
    error_ratio_pct: (Number(r.error_ratio) || 0) * 100,
    isCrit: (Number(r.error_ratio) || 0) > PARSE_ERROR_CRIT_THRESHOLD,
  }));

  const critDays = chartRows.filter((r) => r.isCrit).length;

  return (
    <>
      {/* KPI 2-col (총 발생 + 마지막 발생) → 0건 분기에선 차트 생략 (action-trigger 부재). */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <div className="fs-meta text-dim">Total parse_error</div>
          <div className="font-mono fs-stat font-semibold tracking-tight">
            {formatIntC(totalErrors)}
          </div>
        </div>
        <div>
          <div className="fs-meta text-dim">Last seen</div>
          {/* 날짜 = 보조 stat — text-[16px]→fs-stat(18px) 최근접 매핑 (16↔18 차 2 < 16↔12 차 4). */}
          <div className="font-mono fs-stat text-fg/80">
            {lastErrorDate || <span className="text-dim">—</span>}
          </div>
        </div>
      </div>
      {totalErrors > 0 ? (
        <>
          {critDays > 0 && (
            <div className="mb-2">
              <Badge role="status" tone="crit" icon={true}>
                {critDays} days over threshold
              </Badge>
            </div>
          )}
          <div style={{ width: '100%', height: 200 }}>
            <ParseErrorChart rows={chartRows}/>
          </div>
        </>
      ) : (
        <div className="fs-body text-dim text-center py-8" aria-label="no parse_error — chart omitted">
          No parse_error in the last {days} days.
          <div className="fs-meta text-faint mt-2 font-mono">
            {rows.length} days analyzed · {formatIntC(totalEvents)} events total
          </div>
        </div>
      )}
    </>
  );
}

function ParseErrorChart({ rows }) {
  const { ResponsiveContainer, ComposedChart, Line, Bar, Cell, XAxis, YAxis, Tooltip, CartesianGrid } = window.Recharts;

  return (
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
          tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
          axisLine={{ stroke: 'rgb(var(--line))' }}
          tickLine={false}
          width={36}
        />
        <YAxis
          yAxisId="ratio"
          orientation="right"
          domain={[0, 100]}
          tickFormatter={(v) => v.toFixed(0) + '%'}
          tick={{ fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' }}
          axisLine={{ stroke: 'rgb(var(--line))' }}
          tickLine={false}
          width={42}
        />
        <Tooltip content={<ParseErrorTooltipC/>} cursor={{ fill: 'rgb(var(--accent) / 0.06)' }}/>
        <Bar yAxisId="count" dataKey="error_count" isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fill={r.isCrit ? 'rgb(var(--crit) / 0.85)' : 'rgb(var(--accent) / 0.65)'}/>
          ))}
        </Bar>
        <Line
          yAxisId="ratio"
          type="monotone"
          dataKey="error_ratio_pct"
          stroke="rgb(var(--warn))"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function ParseErrorTooltipC({ active, payload }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const row = payload[0].payload;
  return (
    <div style={tooltipStyle}>
      <div style={{ color: 'rgb(var(--ink))', marginBottom: 4, fontWeight: 600 }}>{row.fullDate}</div>
      <div style={{ color: 'rgb(var(--dim))' }}>
        Errors {formatIntC(row.error_count)} / total {formatIntC(row.total_count)}
      </div>
      <div style={{ color: row.isCrit ? 'rgb(var(--crit))' : 'rgb(var(--dim))' }}>
        Rate {row.error_ratio_pct.toFixed(2)}%{row.isCrit ? ' · over threshold' : ''}
      </div>
    </div>
  );
}

// 6. AnomalyCostCard — 7일 rolling mean ±2σ band, band 밖 = anomaly.
function AnomalyCostCard({ state, days, onRetry }) {
  const { CardHead } = window.UI;
  return (
    <div className="card mb-4">
      <CardHead
        title="Unusual spending"
      />
      <div className="card-body">
        <AnomalyCostBody state={state} days={days} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function AnomalyCostBody({ state, days, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonC height={200} aria-label="Loading anomaly detection"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerC title="Couldn't load anomaly data" detail={state.error} onRetry={onRetry}/>;
  }

  // cost-timeseries 응답 — points[] ASC (오래된→최신). dashboard.ts 와 동일.
  const points = state.data?.points ?? state.data?.rows ?? [];
  if (points.length < ROLLING_WINDOW) {
    return (
      <EmptyStateC
        message={`Only ${points.length} days of data (< ${ROLLING_WINDOW}) — rolling average needs at least ${ROLLING_WINDOW} days`}
      />
    );
  }

  const rows = computeAnomalyRows(points, ROLLING_WINDOW, ANOMALY_SIGMA);
  const anomalyCount = rows.reduce((s, r) => s + (r.isAnomaly ? 1 : 0), 0);
  const totalCovered = rows.reduce((s, r) => s + (r.rollingMean !== null ? 1 : 0), 0);

  return <AnomalyCostChart rows={rows} anomalyCount={anomalyCount} totalCovered={totalCovered} days={days}/>;
}

function AnomalyCostChart({ rows, anomalyCount, totalCovered, days }) {
  const { Badge } = window.UI;
  const { ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ReferenceDot } = window.Recharts;

  // 마지막 일자 anomaly 시 strong signal — 우측 KPI Pill 노출.
  const latest = rows[rows.length - 1];
  const isLatestAnomaly = !!(latest && latest.isAnomaly);

  return (
    <>
      <div className="flex items-baseline gap-3 mb-3">
        <div>
          <div className="fs-meta text-dim">Anomalies</div>
          <div className="font-mono fs-stat font-semibold tracking-tight">
            {anomalyCount}
            <span className="fs-meta text-dim font-normal ml-1">/ {totalCovered} days</span>
          </div>
        </div>
        {isLatestAnomaly && (
          <Badge role="status" tone="crit" icon={true}>
            latest day outside band
          </Badge>
        )}
      </div>
      <div style={{ width: '100%', height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={anomalyChartMargin}>
            {/* faint gridline — 비용 시계열(T-CST-1): --line 0.6 opacity 수평만. */}
            <CartesianGrid stroke="rgb(var(--line) / 0.6)" strokeDasharray="2 4" vertical={false}/>
            <XAxis
              dataKey="date"
              tick={anomalyAxisTickStyle}
              axisLine={anomalyAxisLineStyle}
              tickLine={false}
            />
            <YAxis
              tickFormatter={formatUsdAxisC}
              tick={anomalyAxisTickStyle}
              axisLine={anomalyAxisLineStyle}
              tickLine={false}
              width={56}
            />
            {/* ±σ band — 상단 Area(--faint/0.18 가시) + 하단 Area(--elev 마스킹) layering.
                Recharts 2.x array dataKey 불안정 회피용 안전 패턴. */}
            <Area
              type="monotone"
              dataKey="upperBand"
              stroke="none"
              fill="rgb(var(--faint) / 0.18)"
              isAnimationActive={false}
              connectNulls={false}
              name="±2σ band"
            />
            <Area
              type="monotone"
              dataKey="lowerBand"
              stroke="none"
              fill="rgb(var(--elev))"
              isAnimationActive={false}
              connectNulls={false}
              legendType="none"
            />
            <Line
              type="monotone"
              dataKey="rollingMean"
              stroke="rgb(var(--dim))"
              strokeDasharray="4 4"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
              name="7-day average"
            />
            <Line
              type="monotone"
              dataKey="actual"
              stroke="rgb(var(--accent))"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              name="Daily cost"
            />
            {rows.map((r) => (r.isAnomaly ? (
              <ReferenceDot
                key={r.date}
                x={r.date}
                y={r.actual}
                r={4.5}
                fill="rgb(var(--crit))"
                stroke="rgb(var(--elev))"
                strokeWidth={2}
                ifOverflow="extendDomain"
              />
            ) : null))}
            <Tooltip content={<AnomalyTooltipC/>}/>
            <Legend wrapperStyle={anomalyLegendStyle}/>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

function AnomalyTooltipC({ active, payload }) {
  const { Icon } = window.UI;
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const row = payload[0].payload;
  const hasBand = row.rollingMean !== null && row.rollingMean !== undefined;
  return (
    <div style={tooltipStyle}>
      <div style={{ color: 'rgb(var(--ink))', marginBottom: 4, fontWeight: 600 }}>{row.date}</div>
      <div style={tooltipRowStyle}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: 'rgb(var(--accent))' }}/>
        Daily cost {formatUsdC(row.actual)}
      </div>
      {hasBand && (
        <>
          <div style={tooltipRowStyle}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: 'rgb(var(--dim))' }}/>
            7-day average {formatUsdC(row.rollingMean)}
          </div>
          <div style={{ color: 'rgb(var(--faint))', marginTop: 4 }}>
            Normal range {formatUsdC(row.lowerBand)} – {formatUsdC(row.upperBand)}
          </div>
          {row.isAnomaly && (
            <div className="inline-flex items-center gap-1" style={{ color: 'rgb(var(--crit))', marginTop: 4, fontWeight: 600 }}>
              <Icon name="warn" size={11} stroke={2.4}/>
              Unusual spike
            </div>
          )}
        </>
      )}
      {!hasBand && (
        <div style={{ color: 'rgb(var(--faint))', marginTop: 4 }}>
          within warm-up window (≤{ROLLING_WINDOW - 1} days) — no rolling average yet
        </div>
      )}
    </div>
  );
}

// 7일 rolling window mean + std → ±N σ band. window 미만 / 빈 slice 행 → rollingMean=null (chart skip).
// points 정렬은 ASC (cost-timeseries API).
function computeAnomalyRows(points, window, sigma) {
  return points.map((p, i) => {
    const actual = pointCostC(p);
    const base = {
      date: typeof p.date === 'string' ? p.date.slice(5) : '',
      fullDate: p.date,
      actual,
      rollingMean: null,
      upperBand: null,
      lowerBand: null,
      isAnomaly: false,
    };
    if (i < window - 1) return base;
    // 직전 window 행 (현재 포함) → population std (N divisor).
    const slice = [];
    for (let j = i - window + 1; j <= i; j++) {
      const v = pointCostC(points[j]);
      if (Number.isFinite(v)) slice.push(v);
    }
    const n = slice.length;
    if (n === 0) return base;
    const mean = slice.reduce((s, v) => s + v, 0) / n;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    const upperBand = mean + sigma * std;
    // 비용 음수 불가 → lower 클램프. std≈0 시 모두 정상 (isAnomaly=false).
    const lowerBand = Math.max(0, mean - sigma * std);
    const isAnomaly = std > 0 && (actual > upperBand || actual < lowerBand);
    return { ...base, rollingMean: mean, upperBand, lowerBand, isAnomaly };
  });
}

// cost-timeseries point → daily cost (USD). cost_usd 우선 · split 합산 폴백 보존.
function pointCostC(p) {
  if (!p) return 0;
  const direct = Number(p.cost_usd ?? p.total_cost_usd);
  if (Number.isFinite(direct)) return direct;
  const split = Number(p.cost_input || 0) + Number(p.cost_output || 0);
  return Number.isFinite(split) ? split : 0;
}

// Axis style hoist — JSX inline-object 할당 회피.
const anomalyAxisTickStyle = { fontSize: 10, fill: 'rgb(var(--faint))', fontFamily: 'JetBrains Mono, monospace' };
const anomalyAxisLineStyle = { stroke: 'rgb(var(--line))' };

// 7. TurnStatsCard — /api/cost/turn-stats: stop_reason 분포 + turns 집계.
// no_assistant_in_turn = tool-only(LLM 미응답) 턴 · end_turn = 실 LLM 턴.
// 분포는 인라인 가로 막대(테이블 기반, sandbox-safe) — Recharts 미사용.

// stop_reason 표시 메타 — 라벨 + 색상 토큰 + 한 줄 설명. 미정의 reason 은 폴백.
const STOP_REASON_META = {
  no_assistant_in_turn: { label: 'tool-only turn', colorVar: '--dim',    desc: 'no LLM reply (tool calls only)' },
  end_turn:             { label: 'real LLM turn',   colorVar: '--accent', desc: 'ended with an assistant reply' },
  tool_use:             { label: 'tool_use',     colorVar: '--info',   desc: 'ended on a tool call' },
  unknown:              { label: 'unknown',      colorVar: '--faint',  desc: 'stop_reason not recorded' },
};

function turnStopReasonMeta(reason) {
  return STOP_REASON_META[reason] || { label: reason || '—', colorVar: '--faint', desc: '' };
}

function TurnStatsCard({ state, days, onRetry }) {
  const { CardHead } = window.UI;
  return (
    <div className="card mb-4">
      <CardHead
        title="Turn statistics"
      />
      <div className="card-body">
        <TurnStatsBody state={state} days={days} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function TurnStatsBody({ state, days, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonC height={220} aria-label="Loading turn statistics"/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerC title="Couldn't load turn statistics" detail={state.error} onRetry={onRetry}/>;
  }

  const stopReasons = state.data?.stop_reasons ?? [];
  const turns = state.data?.turns ?? null;
  if (stopReasons.length === 0) {
    return <EmptyStateC message={`No turn events in the last ${days} days.`}/>;
  }

  // 막대 정규화 분모 = 최대 event_count (서버가 DESC 정렬 → 첫 행). 0 분모 방어.
  const maxEvents = stopReasons.reduce((m, r) => Math.max(m, Number(r.event_count) || 0), 0);
  const totalEvents = stopReasons.reduce((s, r) => s + (Number(r.event_count) || 0), 0);

  return (
    <>
      {/* turns 집계 — 평균/최대/총 턴 (세션당 턴 수). */}
      {turns && <TurnAggregateRow turns={turns}/>}
      <TurnStopReasonTable rows={stopReasons} maxEvents={maxEvents} totalEvents={totalEvents}/>
    </>
  );
}

// 주 지표 = 세션당 턴 (SUM per session → AVG, 서버 집계) — maxTurns 예산 산정용 (F29).
// 이벤트당 평균은 skew-sensitive 보조 지표로 격하.
function TurnAggregateRow({ turns }) {
  const avgPerSession = Number(turns.avg_turns_per_session) || 0;
  const sessionCount = Number(turns.turn_session_count) || 0;
  const avgPerEvent = Number(turns.avg_turns) || 0;
  const maxTurns = Number(turns.max_turns) || 0;
  const totalTurns = Number(turns.total_turns) || 0;

  return (
    <div className="flex items-start gap-4 mb-3">
      <div>
        <div className="fs-meta text-dim">Avg turns/session</div>
        <div className="font-mono fs-stat font-semibold tracking-tight">
          {sessionCount > 0 ? avgPerSession.toFixed(2) : '—'}
        </div>
        {sessionCount > 0 && <div className="fs-meta text-dim font-normal mt-0.5">· {formatIntC(sessionCount)} sessions</div>}
      </div>
      <div>
        <div className="fs-meta text-dim">Avg turns/event</div>
        <div className="font-mono fs-stat text-dim tracking-tight">{avgPerEvent.toFixed(2)}</div>
      </div>
      <div>
        <div className="fs-meta text-dim">Max turns</div>
        <div className="font-mono fs-stat text-dim tracking-tight">{formatIntC(maxTurns)}</div>
      </div>
      <div>
        <div className="fs-meta text-dim">Total turns</div>
        <div className="font-mono fs-stat text-dim tracking-tight">{formatIntC(totalTurns)}</div>
      </div>
    </div>
  );
}

// stop_reason 분포 — 4컬럼 테이블 (분류 · 이벤트수+인라인바 · 세션수 · 비중). ≤5컬럼.
function TurnStopReasonTable({ rows, maxEvents, totalEvents }) {
  return (
    <table className="tbl cost-tbl">
      <thead>
        <tr>
          <th>stop_reason</th>
          <th className="num">Events</th>
          <th className="num">Sessions</th>
          <th className="num">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const meta = turnStopReasonMeta(r.stop_reason);
          const events = Number(r.event_count) || 0;
          const sessions = Number(r.session_count) || 0;
          const pct = totalEvents > 0 ? (events / totalEvents) : 0;
          const barPct = maxEvents > 0 ? (events / maxEvents) * 100 : 0;
          return (
            <tr key={r.stop_reason}>
              {/* 라벨+desc 단일행 고정 — 좁은 뷰포트서 desc 래핑→행높이 1↔2줄 점프 차단:
                  flex 1행 + desc truncate(min-w-0) + 전문 title= 툴팁 보존. */}
              <td>
                <div className="flex items-center min-w-0" title={meta.desc ? `${meta.label} — ${meta.desc}` : meta.label}>
                  <span
                    className="inline-block w-[3px] h-3 rounded-sm mr-3 shrink-0"
                    style={{ background: `rgb(var(${meta.colorVar}))` }}
                  />
                  <span className="shrink-0">{meta.label}</span>
                  <span className="fs-meta text-dim ml-2 truncate">{meta.desc}</span>
                </div>
              </td>
              <td className="num">
                {/* 인라인 정규화 막대 — max 대비 폭 (sandbox-safe, JS 차트 미사용). */}
                <div className="flex items-center justify-end gap-2">
                  <span
                    className="inline-block h-1.5 rounded-sm"
                    style={{ width: `${Math.max(barPct, 2)}%`, maxWidth: 120, background: `rgb(var(${meta.colorVar}) / 0.7)` }}
                  />
                  <span className="font-mono">{formatIntC(events)}</span>
                </div>
              </td>
              <td className="num">{formatIntC(sessions)}</td>
              <td className="num text-dim">{(pct * 100).toFixed(1)}%</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// 공통 chrome
function EmptyStateC({ message }) {
  const { EmptyState } = window.UI;
  return <EmptyState message={message} />;
}

function ErrorBannerC({ title, detail, onRetry }) {
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

function ChartSkeletonC({ height = 220, 'aria-label': ariaLabel }) {
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
        animation: 'skelPulseC 1.4s ease-in-out infinite',
      }}
    />
  );
}

// 인라인 skeleton — sunken 토큰 pulse placeholder.
function SkelC({ w = '100%', h = 14, style }) {
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
        animation: 'skelPulseC 1.4s ease-in-out infinite',
        ...style,
      }}
    />
  );
}

// 순수 helper
const tooltipStyle = {
  background: 'rgb(var(--elev))',
  border: '1px solid rgb(var(--line))',
  borderRadius: 8,
  padding: '8px 12px',
  // 툴팁 = HTML DOM div → 11.5px→var(--fs-meta)(11px) 매핑 (밀도 높은 보조 콘텐츠 tier).
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

async function fetchJsonC(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_e) { /* body parse 실패 무시 */ }
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 120) : ''}`);
  }
  return res.json();
}

// fetch + setter wiring 통합 — useEffect 본문 단순화.
function runFetchC(url, signal, setter) {
  return fetchJsonC(url, signal)
    .then((data) => setter({ status: 'ready', data, error: null }))
    .catch((err) => handleErrorC(err, setter));
}

function handleErrorC(err, setter) {
  // AbortError = period 변경 / 네비게이션 — 사용자 가시 실패 아님.
  if (err && err.name === 'AbortError') {
    return;
  }
  setter({ status: 'error', data: null, error: err && err.message ? err.message : String(err) });
}

function computeSessionBins(sessions) {
  // bin 별 count 배열 → 각 세션을 total_cost_usd 로 분류.
  const counts = SESSION_COST_BINS.map(() => 0);
  for (const s of sessions) {
    const cost = Number(s?.total_cost_usd) || 0;
    for (let i = 0; i < SESSION_COST_BINS.length; i++) {
      const bin = SESSION_COST_BINS[i];
      if (cost >= bin.min && cost < bin.max) {
        counts[i]++;
        break;
      }
    }
  }
  return SESSION_COST_BINS.map((bin, i) => ({
    label: bin.label,
    min: bin.min,
    max: bin.max,
    isOutlier: bin.isOutlier,
    count: counts[i],
  }));
}

// Sparkline 첫→끝 변화율 (%) — KPI delta 화살표.
// 길이 < 2 또는 baseline=0 이면 null (KPI Delta 가 typeof==='number' 체크).
function computeSparkDeltaC(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const first = Number(series[0]) || 0;
  const last  = Number(series[series.length - 1]) || 0;
  if (first === 0) {
    // 0→양수 +100% · 0→0 0% · 0→음수 -100% (음수 비용 방어).
    if (last > 0) return 100;
    if (last < 0) return -100;
    return 0;
  }
  return ((last - first) / Math.abs(first)) * 100;
}

// claude-opus-4-7 → opus-4.7 · claude-haiku-4-5-20251001 → haiku-4.5 (X축 공간 압축).
// family-major-minor 추출 + 후행 날짜 세그먼트(-YYYYMMDD…) 옵션 허용 (날짜형 ID 축약 실패 해소).
function shortenModelName(name) {
  if (typeof name !== 'string' || name.length === 0) return '—';
  const m = name.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d+)?$/i);
  if (m) return `${m[1]}-${m[2]}.${m[3]}`;
  return name;
}

window.ScreenCost = ScreenCost;
