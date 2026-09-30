// Screen 01 — Dashboard: triage. 경보 레인(비어도 한 행 높이 유지) + 4타일 상태 밴드가 전부.
// 추세·원장·분포는 각자 소유 화면으로 이관 — 여기는 "지금 나를 필요로 하는 일이 있나 ·
// 하네스는 건강한가"에만 답하고 나머지 질문은 링크로 넘긴다.
// harness 사실은 셸 fold(prop) 단일 출처 — 화면이 harness 스토어를 다시 읽지 않는다.
const { useState: useStateD, useEffect: useEffectD, useRef: useRefD, useCallback: useCallbackD } = React;

// 숫자 포맷 — ui.jsx 공용 SoT 소비 (ui.js 가 dashboard.js 보다 먼저 로드 → window.UI 가용).
const formatUsd = window.UI.formatUsd;
const formatInt = window.UI.formatInt;

// Update 컨트롤 상수 (P3-T4) — poll 간격 · stale 컷오프 · 엔드포인트.
// UPDATE_STALE_MS 는 서버 routes/dashboard.ts DEFAULT_STALE_MS(30분) 미러 — 클라 stale 판정이
//   서버 sweep 컷오프 이상이어야 retry(apply POST)가 서버 stale-sweep 을 태워 예약 row 를 회수함
//   (컷오프 미만이면 서버가 아직 in-progress 로 보아 재-apply 가 single_active 로 막힘).
const UPDATE_POLL_MS = 5000;
const UPDATE_STALE_MS = 30 * 60 * 1000;
const UPDATE_ENDPOINT = '/api/dashboard/update';
const UPDATE_JOB_ENDPOINT = '/api/dashboard/update-job';
const UPDATE_STATUS_ENDPOINT = '/api/dashboard/update-status';
// 라우트가 row 예약 시 넣는 자리표시자 미러 (routes/dashboard.ts PENDING_TARGET_VERSION) — 실제 릴리스 버전은
//   decoupled job 이 나중에 덮어쓴다. 버전 라벨로 렌더하면 'pending' 이라는 버전이 있는 것처럼 읽힌다.
const UPDATE_PENDING_VERSION = 'pending';

// one endpoint per region → a Retry reloads its own region; the wave reads each once, and UpdateBadge also polls updateJob
const DASH_REGION_URLS = {
  cost: '/api/cost/kpi',
  agents: '/api/agents/summary?days=7&order=runs&limit=1',
  outcomes: '/api/outcomes/cross-analysis?days=7&prior_window=1',
  update: UPDATE_STATUS_ENDPOINT,
  updateJob: UPDATE_JOB_ENDPOINT,
  spendDays: '/api/dashboard/cost-timeseries?days=7',
  heatmap: '/api/outcomes/heatmap?days=7',
};
const DASH_WAVE_REGIONS = Object.keys(DASH_REGION_URLS);
// shell-polled, not a DASH_REGION_URLS entry — its re-read is the shell's harness poll
const HARNESS_REGION = 'harness';

// 오늘 지출 경보 컷 — 7일 일평균(avg/day)의 1.25배. 규칙 소유는 Cost & usage 계획(clauded-docs/39582);
// 대시보드는 같은 /api/cost/kpi 를 읽어 그 판정을 소비만 한다 — 두 화면이 같은 분에 다른 답을 내면 안 된다.
const SPEND_PACE_CUT = 1.25;
const SPEND_BASELINE_DAYS = 7;

// severity 우선순위 — 레인 정렬 기준. 높을수록 위험.
const SEVERITY_RANK = { crit: 3, warn: 2, info: 1, neutral: 0 };

function ScreenDashboard({ onNav, harness, onRetryHarness }) {
  const {
    PageHeader, TypeScaleStyle, FreshnessStamp, RefreshButton, PageErrorBanner, INITIAL_REGION_STATE, getRegionSummary,
  } = window.UI;

  const [costState,      setCostState]      = useStateD(INITIAL_REGION_STATE);
  const [agentsState,    setAgentsState]    = useStateD(INITIAL_REGION_STATE);
  const [outcomesState,  setOutcomesState]  = useStateD(INITIAL_REGION_STATE);
  const [updateState,    setUpdateState]    = useStateD(INITIAL_REGION_STATE);
  const [updateJobState, setUpdateJobState] = useStateD(INITIAL_REGION_STATE);
  const [spendDaysState, setSpendDaysState] = useStateD(INITIAL_REGION_STATE);
  const [heatmapState,   setHeatmapState]   = useStateD(INITIAL_REGION_STATE);

  const [refreshTick, setRefreshTick] = useStateD(0);
  // last wave that settled with ≥1 successful read → kept across waves, never advanced by an all-failed wave
  const [settledAt, setSettledAt] = useStateD(null);

  // latest request per region — a newer request aborts its twin, unmount aborts all
  const requestsRef = useRefD({});

  const loadRegion = useCallbackD((region) => {
    const setters = {
      cost: setCostState, agents: setAgentsState, outcomes: setOutcomesState, update: setUpdateState, updateJob: setUpdateJobState,
      spendDays: setSpendDaysState, heatmap: setHeatmapState,
    };
    const requests = requestsRef.current;
    requests[region]?.abort();
    const request = new AbortController();
    requests[region] = request;
    return runFetch(DASH_REGION_URLS[region], setters[region], request);
  }, []);

  // the shell fold carries no busy flag → the page counts its own harness re-reads in flight
  const [isHarnessBusy, setHarnessBusy] = useStateD(false);
  const harnessReadsRef = useRefD(0);
  const rereadHarness = useCallbackD(() => {
    if (!onRetryHarness) return;
    const settle = () => {
      harnessReadsRef.current -= 1;
      if (harnessReadsRef.current === 0) setHarnessBusy(false);
    };
    harnessReadsRef.current += 1;
    setHarnessBusy(true);
    Promise.resolve(onRetryHarness()).then(settle, settle);
  }, [onRetryHarness]);

  // the page reads the shell's harness too → Refresh and the banner Retry re-read it with the wave
  const triggerRefresh = useCallbackD(() => {
    setRefreshTick((t) => t + 1);
    rereadHarness();
  }, [rereadHarness]);
  const retryTile = useCallbackD((region) => getTileRetry(loadRegion, rereadHarness)(region), [loadRegion, rereadHarness]);
  const refetchUpdateJob = useCallbackD(() => loadRegion('updateJob'), [loadRegion]);

  // harness 판독은 셸 fold 가 공급 — 여기서 재요청하지 않는다(풋터와 어긋나는 원인).
  useEffectD(() => {
    let isCurrentWave = true;
    Promise.all(DASH_WAVE_REGIONS.map(loadRegion)).then((results) => {
      if (isCurrentWave && results.includes(true)) setSettledAt(new Date().toISOString());
    });
    return () => { isCurrentWave = false; };
  }, [refreshTick, loadRegion]);

  useEffectD(() => () => Object.values(requestsRef.current).forEach((request) => request.abort()), []);

  const job = readUpdateJob(updateJobState);
  // 레인 행 존재 판정은 외부 관측 가능한 view 만 사용 — 배지 내부 phase 는 클릭 후에도 행을 흔들지 않는다.
  const installKind = deriveUpdateView({
    availabilityStatus: updateState.status,
    availabilityData: updateState.data,
    job,
    phase: 'idle',
    actionError: null,
    now: Date.now(),
    staleMs: UPDATE_STALE_MS,
  }).kind;

  const waveStates = [costState, agentsState, outcomesState, updateState, spendDaysState, heatmapState];
  const isWaveBusy = getRegionSummary(waveStates).isBusy;
  const alarms = buildAlarms({ harness, costState, installKind });
  const alarmReadiness = getAlarmReadiness({ harness, costState, updateState });
  const tiles = buildTiles({ harness, costState, agentsState, outcomesState, isHarnessBusy });
  const weekPanels = [{ source: 'daily spend', error: spendDaysState.error }, { source: 'runs by hour', error: heatmapState.error }];
  const sharedFailure = getPageSharedFailure(tiles, weekPanels);
  const sharedSources = sharedFailure?.sources ?? NO_SHARED_SOURCES;
  const version = describeVersion(harness);

  return (
    <div className="flex flex-col">
      {/* 타입 스케일 토큰 (ui.jsx SoT) — 멱등 마운트. .fs-* 유틸 + --fs-* CSS var 공급. */}
      <TypeScaleStyle/>
      <style>{`
        /* update 진행 스피너 — reduced-motion 은 회전 정지(정적 아이콘 + Badge/라벨이 상태 운반). */
        @keyframes ga-spin { to { transform: rotate(360deg); } }
        .ga-spin { animation: ga-spin 0.9s linear infinite; transform-origin: center; }
        @media (prefers-reduced-motion: reduce) { .ga-spin { animation: none; } }
        /* one alarm row's height — the lane keeps it while loading and when empty, so the band never jumps */
        .dash-lane-slot { min-height: calc(var(--fs-body) * 1.5 + var(--fs-meta) * 1.4 + 1.5rem); }
        /* 타일 힌트 — 2줄분 min-height 예약(clamp 없음) → 폭이 줄어도 밴드 높이 불변. */
        .dash-tile-hint { min-height: calc(var(--fs-meta) * 1.4 * 2); line-height: 1.4; }
        .dash-tile-detail { min-height: calc(var(--fs-body) * 1.5); }
        /* the shared .btn hover shifts ~4 RGB levels → an underline makes the drill's hover visible */
        .dash-drill:hover, .dash-drill:focus-visible { text-decoration: underline; text-underline-offset: 3px; }
        .dash-strip-track { height: 4rem; }
        .dash-strip-bar { background: currentColor; border-radius: 2px; }
        /* today is still accruing → an outlined bar, never a filled one that reads as a closed day */
        .dash-strip-partial { background: transparent; border: 1px dashed currentColor; }
        .dash-result-row { display: grid; grid-template-columns: 9rem 1fr 4.5rem; align-items: center; gap: 0.5rem; }
        .dash-result-fill { height: 0.5rem; background: currentColor; border-radius: 2px; }
        .dash-hour-grid { display: grid; grid-template-columns: 2.5rem repeat(24, minmax(0, 1fr)); gap: 2px; align-items: center; line-height: 1; }
        .dash-hour-cell { height: 0.75rem; background: currentColor; border-radius: 2px; }
        /* two columns (xl) → an even count puts two rows on the bottom line; both drop the hairline, not only the last */
        @media (min-width: 1280px) { .dash-alarm-grid > .alarm-row:nth-child(odd):nth-last-child(2) { border-bottom: none; } }
      `}</style>

      <div className="flex-shrink-0">
        <PageHeader
          title="Dashboard"
          sub={<span className="fs-meta">Triage</span>} // the shared eyebrow is 11px → fs-meta holds the 12px floor
          right={
            <>
              {version && <span className="fs-meta font-mono text-dim">{version}</span>}
              <FreshnessStamp {...getFreshnessInputD(settledAt, waveStates, harness)}/>
              <RefreshButton isBusy={isWaveBusy} hasRead={settledAt !== null}
                onRefresh={triggerRefresh} label="Refresh dashboard"/>
            </>
          }
        />
      </div>

      <div className="space-sections">
        {sharedFailure && (
          <PageErrorBanner sources={sharedFailure.sources} error={sharedFailure.error} onRetry={triggerRefresh}
            isBusy={isWaveBusy} focusTargetId={DASH_STATUS_BAND_ID}/>
        )}
        <AlarmLane
          alarms={alarms}
          readiness={alarmReadiness}
          onNav={onNav}
          updateState={updateState}
          updateJobState={updateJobState}
          onRefetchJob={refetchUpdateJob}
        />
        <StatusBand tiles={tiles} onNav={onNav} onRetry={retryTile} sharedSources={sharedSources}/>
        <WeekRow spendState={spendDaysState} outcomesState={outcomesState} onRetrySpend={() => loadRegion('spendDays')}
          sharedSources={sharedSources}/>
        <WeekPanel id="dash-week-hours" title="Runs by hour" state={heatmapState} source="runs by hour"
          onRetry={() => loadRegion('heatmap')} isRetryShared={sharedSources.includes('runs by hour')}
          render={(data) => <HourGrid grid={buildHourGrid(data)}/>}/>
      </div>
    </div>
  );
}

// harness 판독은 셸 소유 → 그 타일의 Retry 는 셸 재폴링, 나머지는 자기 region 재요청
function getTileRetry(loadRegion, rereadHarness) {
  return (region) => (region === HARNESS_REGION ? rereadHarness() : loadRegion(region));
}

const NO_SHARED_SOURCES = Object.freeze([]);

// ≥2 sources failing on one cause (tiles + week panels, unloaded or held) → one page banner carries the only Retry
// panels on another cause keep their own Retry → the tiles' banner still stands without them
function getPageSharedFailure(tiles, panels = []) {
  const { getSharedFailure } = window.UI;
  const tileEntries = tiles.map((tile) => ({ source: tile.source, error: tile.error }));
  return getSharedFailure([...tileEntries, ...panels]) ?? getSharedFailure(tileEntries);
}

// 경보 레인 — 비어도 한 행 높이를 지킨다(도착·새로고침 때 밴드가 밀리지 않게).
// polite live region 은 항상 마운트 — 먼저 있어야 나중에 붙는 경보 행이 안내된다.
// 행 순서는 worst-first: 가장 위험한 사실이 첫 줄에 온다.
function AlarmLane({ alarms, readiness = ALARM_READINESS_LOADING, onNav, updateState, updateJobState, onRefetchJob }) {
  const hasAlarms = alarms.length > 0;
  const [reserved, setReserved] = useStateD(0);
  const slots = getLaneSlots(alarms.length, readiness, reserved);
  if (slots.reserved !== reserved) setReserved(slots.reserved);
  const trailer = slots.trailer && <LaneTrailer trailer={slots.trailer} hasAlarms={hasAlarms} unread={readiness.unread}/>;
  const isLoading = slots.trailer === 'loading';
  return (
    <section className="dash-lane" aria-label="Alarms">
      <div aria-live="polite">
        {hasAlarms && <AlarmList alarms={alarms} onNav={onNav} updateState={updateState}
          updateJobState={updateJobState} onRefetchJob={onRefetchJob}/>}
        {!isLoading && trailer}
      </div>
      {/* the loading line is its own status region → beside the polite one, never inside, so it is announced once */}
      {isLoading && trailer}
    </section>
  );
}

/**
 * The lane's height plan: its rows plus at most one trailing line.
 * A loading source reserves one slot below the rows; once it settles the lane holds that slot with a
 * status line until a row takes it → a settle moves the band neither when it adds a row nor when it adds none.
 * @param reserved - most slots the lane reserved while a source loaded (0 before any)
 * @returns reserved - the next reservation · trailer - 'loading' | 'unknown' | 'clear', or null for rows only
 */
function getLaneSlots(rowCount, readiness, reserved) {
  if (readiness.status === 'loading') return { reserved: Math.max(reserved, rowCount + 1), trailer: 'loading' };
  if (readiness.status === 'unknown') return { reserved, trailer: 'unknown' };
  return { reserved, trailer: rowCount === 0 || rowCount < reserved ? 'clear' : null };
}

// one slot-high line under the rows — its wording depends on whether rows sit above it
function LaneTrailer({ trailer, hasAlarms, unread }) {
  const { LoadingPlaceholder } = window.UI;
  if (trailer === 'loading') return <LoadingPlaceholder label={hasAlarms ? 'other alarms' : 'alarms'} className="dash-lane-slot"/>;
  const sources = unread.join(' · ');
  const text = {
    unknown: hasAlarms ? `Couldn't read ${sources} — more alarms may be hidden.` : `Alarms unknown — couldn't read ${sources}.`,
    clear: hasAlarms ? 'No other alarms.' : 'No alarms need you right now.',
  }[trailer];
  return <p className="dash-lane-slot fs-meta text-dim flex items-center">{text}</p>;
}

const ALARM_READINESS_LOADING = Object.freeze({ status: 'loading', unread: [] });
const ALARM_SOURCE_LABELS = { harness: 'harness health', costState: "today's spend", updateState: 'install state' };

/**
 * Whether the lane may claim an all-clear: 'loading' while any source is unsettled,
 * 'unknown' once one settled without an answer, 'read' only when every source answered.
 * @returns unread - labels of the sources that settled without an answer
 */
function getAlarmReadiness(sources) {
  const entries = Object.entries(ALARM_SOURCE_LABELS).map(([key, label]) => ({ source: sources[key], label }));
  if (entries.some(({ source }) => !source || source.status === 'loading')) return ALARM_READINESS_LOADING;

  // a held reading whose latest read failed is unread too — its all-clear is stale
  const unread = entries.filter(({ source }) => source.status !== 'ready' || source.error != null).map(({ label }) => label);
  return { status: unread.length > 0 ? 'unknown' : 'read', unread };
}

function AlarmList({ alarms, onNav, updateState, updateJobState, onRefetchJob }) {
  return (
    <div role="list" className="dash-alarm-grid grid grid-cols-1 xl:grid-cols-2 gap-x-4">
      {alarms.map((alarm) => (
        <AlarmRow key={alarm.id} alarm={alarm} onNav={onNav}>
          {alarm.id === 'install' && (
            <UpdateBadge
              availabilityState={updateState}
              jobState={updateJobState}
              onRefetchJob={onRefetchJob}
            />
          )}
        </AlarmRow>
      ))}
    </div>
  );
}

// 한 줄 = 한 사실. 소유 화면 링크를 갖거나(target) 자기 조치를 품거나(children) 둘 중 하나.
// flat hairline row (.alarm-row) — tone rides on the leading glyph only
function AlarmRow({ alarm, onNav, children }) {
  const { Badge, Icon, TONE_ICON } = window.UI;
  return (
    <div role="listitem" className="alarm-row" data-tone={alarm.tone}>
      <span className="alarm-row-glyph"><Icon name={TONE_ICON[alarm.tone]} size={16}/></span>
      <div className="min-w-0">
        <div className="fs-body font-medium text-ink flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{alarm.title}</span>
          {alarm.isHeld && <Badge tone="neutral">Last known</Badge>}
        </div>
        {alarm.detail && <div className="fs-meta text-dim">{alarm.detail}</div>}
      </div>
      <div className="flex items-center gap-2">
        {children}
        {alarm.target && <DrillLink target={alarm.target} label={alarm.targetLabel} onNav={onNav}/>}
      </div>
    </div>
  );
}

// 상태 밴드 — 4타일 고정, 좁은 폭에선 2×2. 값 · 힌트 한 줄 · 소유 화면 링크.
function StatusBand({ tiles, onNav, onRetry, sharedSources = NO_SHARED_SOURCES }) {
  return (
    <div id={DASH_STATUS_BAND_ID} className="grid grid-cols-2 xl:grid-cols-4 gap-card">
      {tiles.map((tile) => (
        <StatusTile key={tile.id} tile={tile} onNav={onNav} onRetry={onRetry}
          isRetryShared={sharedSources.includes(tile.source)}/>
      ))}
    </div>
  );
}

// the band outlives every recovery → a banner Retry that leaves on success hands focus here
const DASH_STATUS_BAND_ID = 'dash-status';

// a banner-carried outage is stated once, above → the tile stays flat with its unknown dash
const BANNER_POINTER = 'see the notice above';
const SHARED_FAILURE_HINT = `Not loaded — ${BANNER_POINTER}.`;

// 상태 4종이 서로 다르게 읽히는 지점 — loading(status 자리표시) · error(공용 unavailable 카드) · unavailable/empty(중립 문구) · ready(값).
// 값 자리는 never 0-for-unknown: 미수신은 '—' 로 남는다.
function StatusTile({ tile, onNav, onRetry, isRetryShared = false }) {
  const { RetryButton } = window.UI;
  const cardId = getTileCardId(tile);
  const isCovered = tile.status === 'error' && isRetryShared;
  return (
    <div id={cardId} className={`card p-3 flex flex-col gap-1.5 ${tile.isBusy ? 'opacity-70' : ''}`.trim()}
      aria-busy={tile.isBusy ? 'true' : undefined}>
      <h2 className="fs-meta text-dim uppercase tracking-wide">
        {tile.label}
        {tile.window && <span className="normal-case"> ({tile.window})</span>}
      </h2>
      {/* a failure stays flat in the tile → one card, one Retry; a banner-carried one points up instead of repeating */}
      <window.UI.TileSplit
        lead={<StatusTileValue tile={tile}/>}
        detail={
          <>
            <div className="fs-body text-dim dash-tile-detail">{isCovered ? null : tile.detail}</div>
            <div className="fs-meta text-dim dash-tile-hint" title={tile.note}>
              {isCovered ? SHARED_FAILURE_HINT : tile.hint}
            </div>
          </>
        }
      />
      {tile.canRetry && !isRetryShared && (
        <RetryButton onRetry={() => onRetry(tile.region)} isBusy={tile.isBusy} focusTargetId={cardId}/>
      )}
      {/* the drill stays a card-foot child, a failed tile's too → mt-auto keeps the four CTAs on one baseline at xl */}
      {tile.target && <DrillLink target={tile.target} label={tile.targetLabel} onNav={onNav} className="self-start mt-auto"/>}
    </div>
  );
}

function getTileCardId(tile) {
  return `dash-tile-${tile.id}`;
}

function StatusTileValue({ tile }) {
  const { Badge, KpiValue, LoadingPlaceholder } = window.UI;
  if (tile.status === 'loading') {
    // an empty .kpi-value strut holds the loaded row's line box → the tile keeps its height when the value lands
    return (
      <div className="flex items-center gap-2">
        <span className="kpi-value" aria-hidden="true">{'\u200b'}</span>
        <LoadingPlaceholder label={tile.label.toLowerCase()}/>
      </div>
    );
  }
  // value + unit never break apart or wrap → a narrow tile drops the badge to its own line instead
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex items-center gap-2">
          <KpiValue><span className="whitespace-nowrap">{tile.value}</span></KpiValue>
          {tile.unit && <span className="fs-body text-dim">{tile.unit}</span>}
        </div>
        {(tile.tone !== 'neutral' || tile.isHeld) && <Badge role="status" tone={tile.tone} icon>{tile.badge ?? TONE_WORD[tile.tone]}</Badge>}
      </div>
      {tile.trend && <div className="fs-meta text-dim">{tile.trend}</div>}
    </div>
  );
}

// the week behind the triage band → each half states its own span (the strip 7 days, the results 7 days + today)
function WeekRow({ spendState, outcomesState, onRetrySpend, sharedSources = NO_SHARED_SOURCES }) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-card">
      <WeekPanel id="dash-week-spend" title="Spend per day" state={spendState} source="daily spend" onRetry={onRetrySpend}
        isRetryShared={sharedSources.includes('daily spend')}
        render={(data) => <SpendStrip strip={buildSpendStrip(data.points, getTodayIn(data.timezone))}/>}/>
      <WeekPanel id="dash-week-results" title="This week's task results" state={outcomesState} source="task results"
        isRetryShared={sharedSources.includes('task results')}
        render={(data) => <ResultPanel panel={buildResultPanel(data)}/>}/>
    </div>
  );
}

// a panel without onRetry shares its source with a tile → the tile speaks for the failure, the panel only points to it
function WeekPanel({ id, title, state, source, onRetry, render, isRetryShared = false }) {
  const { Badge, LoadingPlaceholder } = window.UI;
  const view = getPanelView(state);
  return (
    <section id={id} className="card p-3 flex flex-col gap-2" aria-labelledby={`${id}-title`}
      aria-busy={state.busy ? 'true' : undefined}>
      <div className="flex items-center gap-2">
        <h2 id={`${id}-title`} className="fs-meta text-dim uppercase tracking-wide">{title}</h2>
        {view === 'held' && <Badge role="status" tone="neutral">Last known</Badge>}
      </div>
      {view === 'loading' && <LoadingPlaceholder label={title.toLowerCase()}/>}
      <PanelFailure id={id} view={view} state={state} source={source} onRetry={onRetry} isRetryShared={isRetryShared}/>
      {(view === 'ready' || view === 'held') && render(state.data)}
    </section>
  );
}

// held data whose latest read failed → 'held', the same last-known rule markHeldTile applies to the tiles
function getPanelView(state) {
  const view = window.UI.getRegionView(state);
  return view === 'ready' && state.error != null ? 'held' : view;
}

const RESULTS_TILE_POINTER = 'see the Task results tile';

// a failure the page banner carries points up to it → one cause, one Retry
function PanelFailure({ id, view, state, source, onRetry, isRetryShared }) {
  const { RetryButton, getErrorCopy } = window.UI;
  if (view !== 'error' && view !== 'held') return null;
  if (!onRetry || isRetryShared) {
    const lead = view === 'held' ? 'Showing the last reading' : 'Not loaded';
    return <p className="fs-meta text-dim">{lead} — {isRetryShared ? BANNER_POINTER : RESULTS_TILE_POINTER}.</p>;
  }
  const sentence = view === 'held' ? `Showing the last reading — couldn't refresh ${source}.` : getErrorCopy(state.error, source).sentence;
  return (
    <>
      <p className={view === 'held' ? 'fs-meta text-dim' : 'fs-body'}>{sentence}</p>
      <RetryButton onRetry={onRetry} isBusy={state.busy} focusTargetId={id}/>
    </>
  );
}

function SpendStrip({ strip }) {
  if (strip.bars.length === 0) return <p className="fs-meta text-dim">No spend recorded in the last 7 days.</p>;
  const max = Math.max(...strip.bars.map((bar) => bar.cost)) || 1;
  const hasPartial = strip.bars.some((bar) => bar.isPartial);
  return (
    <>
      <p className="fs-meta text-dim">{strip.span}{hasPartial ? ' · today is still accruing' : ''}</p>
      <ol className="grid grid-cols-7 gap-1" aria-label={`Spend per day, ${strip.span}`}>
        {strip.bars.map((bar) => (
          <li key={bar.date} className="flex flex-col items-center gap-1 min-w-0">
            <span className="fs-meta font-mono whitespace-nowrap">{window.UI.formatUsdCompact(bar.cost)}</span>
            <div className="dash-strip-track w-full flex items-end text-info" aria-hidden="true">
              <div className={`w-full ${bar.isPartial ? 'dash-strip-partial' : 'dash-strip-bar'}`}
                style={{ height: `${Math.max(2, (bar.cost / max) * 100)}%` }}/>
            </div>
            <span className="fs-meta text-dim whitespace-nowrap">{bar.isPartial ? 'Today, so far' : formatDay(bar.date)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

const RESULT_ROW_META = {
  done: { label: 'Done', tone: 'ok' },
  done_with_concerns: { label: 'Done with caveats', tone: 'warn' },
  fail: { label: 'Failed', tone: 'crit' },
  blocked: { label: 'Blocked', tone: 'crit' },
};

function ResultPanel({ panel }) {
  if (panel.writerTotal <= 0) return <p className="fs-meta text-dim">No reported outcomes, {panel.span}.</p>;
  return (
    <>
      <p className="fs-meta text-dim" title={OUTCOME_COUNTING_NOTE}>
        {panel.span} · {formatInt(panel.writerTotal)} reported outcomes, the tile's count
      </p>
      <ul className="flex flex-col gap-1.5">
        {panel.rows.map((row) => {
          const meta = RESULT_ROW_META[row.result] ?? { label: row.result, tone: 'info' };
          return (
            <li key={row.result} className="dash-result-row fs-body">
              <span>{meta.label}</span>
              <div aria-hidden="true">
                <div className={`dash-result-fill text-${meta.tone}`} style={{ width: `${(row.count / panel.writerTotal) * 100}%` }}/>
              </div>
              <span className="font-mono text-right">{formatInt(row.count)}</span>
            </li>
          );
        })}
      </ul>
      <BreakageAgents agents={panel.agents}/>
    </>
  );
}

function BreakageAgents({ agents }) {
  if (agents.length === 0) return <p className="fs-meta text-dim">No agent had a failed or blocked run.</p>;
  return (
    <>
      <h3 className="fs-meta text-dim">Most failed or blocked</h3>
      <ul className="flex flex-col gap-1">
        {agents.map((row) => (
          <li key={row.agent} className="flex items-center justify-between gap-2 fs-body">
            {/* a real href, not onNav → the query reaches the Task results filter through hashchange */}
            <a href={getAgentOutcomesHref(row.agent)} className="dash-drill truncate min-w-0"
              aria-label={`${row.agent}: ${formatInt(row.count)} failed or blocked — open its task results`}>{row.agent}</a>
            <span className="font-mono">{formatInt(row.count)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function getAgentOutcomesHref(agent) {
  return `#outcomes?agent=${encodeURIComponent(agent)}&days=7`;
}

const HOUR = {
  OF_DAY: Array.from({ length: 24 }, (_, hour) => hour),
  TICKS: new Set([0, 6, 12, 18]),
  // the heatmap counts differently from the results panel beside it → it states its own basis
  GRID_BASIS: 'All recorded runs — reconstructed included, poisoned excluded.',
};

function HourGrid({ grid }) {
  if (grid.total <= 0) return <p className="fs-meta text-dim">No runs recorded in the last 7 days.</p>;
  return (
    <>
      <p className="fs-meta text-dim">{grid.span} · {formatInt(grid.total)} runs · {HOUR.GRID_BASIS}</p>
      {grid.folds.length > 0 && (
        <p className="fs-meta text-dim">
          {grid.folds.map((row) => `${row.day} ×2 sums ${row.fold}`).join(' · ')} — runs are counted by weekday, not by date.
        </p>
      )}
      <div role="img" aria-label={describeHourGrid(grid)} className="dash-hour-grid fs-meta text-dim">
        {grid.rows.map((row) => (
          <React.Fragment key={row.day}>
            <span title={row.fold ?? undefined}>{row.fold ? `${row.day} ×2` : row.day}</span>
            {row.counts.map((count, hour) => (
              <span key={hour} className="dash-hour-cell text-info" title={`${getRowLabel(row)} ${formatHour(hour)} — ${formatInt(count)} runs`}
                style={{ opacity: count === 0 ? 0.06 : 0.2 + (0.8 * count) / grid.max }}/>
            ))}
          </React.Fragment>
        ))}
        <span/>
        {HOUR.OF_DAY.map((hour) => <span key={hour}>{HOUR.TICKS.has(hour) ? formatHour(hour) : ''}</span>)}
      </div>
    </>
  );
}

function getRowLabel(row) {
  return row.fold ? `${row.day} (${row.fold})` : row.day;
}

function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function describeHourGrid(grid) {
  const { peak } = grid;
  return `Runs by hour, ${grid.span}: busiest ${getRowLabel(peak)} ${formatHour(peak.hour)} with ${formatInt(peak.count)} runs`;
}

// 소유 화면 링크 — 실제 href(#screen) 앵커. 수식 클릭·가운데 클릭은 브라우저에 맡겨 새 탭으로 연다.
function DrillLink({ target, label, onNav, className = '' }) {
  const onClick = (event) => {
    const isModified = event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (isModified) return;
    event.preventDefault();
    onNav(target);
  };
  return (
    <a href={`#${target}`} className={`btn sm dash-drill ${className}`.trim()} onClick={onClick}>
      {label}
      <window.UI.Icon name="arrow-right" size={14}/>
    </a>
  );
}

// 0. Update control — self-update 통지를 toolbar 컴팩트 3-state 배지로 렌더(구 full-width 카드 대체).
//   단일 원자적 apply: yellow "Update available <target>"(클릭) → updating(spinner) → green "✓ <version>"(persistent
//   resting). availability(/api/dashboard/update-status) + update-job(/api/dashboard/update-job) poll 로 구동 ·
//   {mode:'apply'} POST 계약과 job poll 은 불변. 4상태가 모양(window.UI.Badge) 공유 — tone/선행 아이콘/텍스트/상호작용만
//   상태별로 바뀐다(색 단독 신호 아님: 선행 Icon 이 shape+color dual-encode). heartbeat 초과 in-progress 는 stalled →
//   failed(crit, 클릭=재시도)로 degrade(영구 spinner 금지). 非actionable verdict(unknown/source-dev) + 무 job → null(무신호).
function UpdateBadge({ availabilityState, jobState, onRefetchJob }) {
  const { Icon, Badge } = window.UI;
  const [phase,       setPhase]       = useStateD('idle');  // idle | working (apply POST 전송 중, 낙관적 updating)
  const [actionError, setActionError] = useStateD(null);    // { message, canRetry } | null (mutation 오류 → failed)

  const job = readUpdateJob(jobState);

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

  // 단일 원자적 apply — 즉시 적용. 성공 응답은 status:'enqueued' 단일 결과라 job poll 로 일원화된다
  //   (라우트가 사전 검사 없이 예약하므로 이미 최신인 설치도 job 을 받는다). single_active(409) 는
  //   live job 노출로 인계, 그 외 오류는 crit failed 배지(클릭=재-apply).
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
    // status:'enqueued' — decoupled job 기동. poll 로 진행상태 인계.
    onRefetchJob();
  }, [onRefetchJob]);

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
      const target = getJobVersion(job);
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
      const version = (job && job.status === 'completed' && getJobVersion(job))
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

// job row 의 표시 가능한 릴리스 버전 — 자리표시자와 빈 값은 null. 호출부는 null 일 때 버전 없는 라벨로 떨어진다.
function getJobVersion(job) {
  const version = job && job.target_version;
  if (!version || version === UPDATE_PENDING_VERSION) return null;
  return version;
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
  if (code === 'network')          return reason ? `Network error: ${reason}` : 'Network error.';
  if (reason)                      return String(reason);
  return `Request failed (HTTP ${status}).`;
}

// ── Pure builders (the lane union and the band) ──

// 톤 → 배지 문구. 문구는 상태를 이름 짓고, 위험도는 톤이 운반한다.
const TONE_WORD = { crit: 'Down', warn: 'Attention', ok: 'Healthy', info: 'No data' };

// 레인 union — harness · fleet · spend · install 만 합친다. Learning/Wiki/Task-results/Models
// 경보는 각 화면의 nav 숫자가 운반하므로 여기서 합성하지 않는다(같은 사실 이중 신고 방지).
function buildAlarms({ harness, costState, installKind }) {
  const rows = [];

  if (harness && harness.status === 'ready' && harness.downNames.length > 0) {
    rows.push({
      id: 'harness',
      tone: 'crit',
      title: `${harness.downNames.length} harness ${harness.downNames.length === 1 ? 'part is' : 'parts are'} down`,
      detail: joinPartNames(harness.downNames),
      isHeld: hasHeldPartRead(harness),
      target: 'architecture',
      targetLabel: 'System map',
    });
  }

  const spend = resolveSpendPace(costState);
  if (spend.status === 'hot') {
    rows.push({
      id: 'spend',
      tone: 'warn',
      title: 'Spend is running ahead of the 7-day average',
      detail: `${formatUsd(spend.today)} so far · ${formatUsd(spend.pace)}/day at the last 3 hours' rate · ${formatUsd(spend.basis)} 7-day avg/day`,
      isHeld: costState?.error != null,
      target: 'cost',
      targetLabel: 'Cost & usage',
    });
  }

  if (installKind === 'available' || installKind === 'failed') {
    rows.push({
      id: 'install',
      tone: installKind === 'failed' ? 'crit' : 'warn',
      title: installKind === 'failed' ? 'The last update did not finish' : 'An update is ready to apply',
      detail: null,
      target: null,
      targetLabel: null,
    });
  }

  return rows.sort((a, b) => (SEVERITY_RANK[b.tone] || 0) - (SEVERITY_RANK[a.tone] || 0));
}

// the failure count feeds failCount1h only, never downNames → its failed read leaves the down-part reading fresh
const FAILURE_COUNT_SOURCE = 'the failure count'; // app.jsx → HARNESS_SOURCES.kpiState.label

function hasHeldPartRead(harness) {
  return (harness.unreadSources ?? []).some((source) => source !== FAILURE_COUNT_SOURCE);
}

// 오늘 누계(so-far) 또는 일간 pace 가 7일 일평균의 컷을 넘는지 — Cost 화면과 같은 payload·같은 컷.
// 기준 0 → 'no-basis'(가짜 +100% 금지) · 미수신 → 'unavailable'.
function resolveSpendPace(costState) {
  if (!costState || costState.status !== 'ready') return { status: 'unavailable', today: null, basis: null, pace: null };
  const k = costState.data || {};
  const today = Number(k.today_cost_usd) || 0;
  // pace = 3h burn 의 일간 외삽 — so-far 만 보면 이른 시각의 과열은 하루가 끝나야 읽힌다.
  const pace = (Number(k.burn_rate_3h_usd_per_hour) || 0) * 24;
  const basis = (Number(k.window_7d_cost_usd) || 0) / SPEND_BASELINE_DAYS;
  if (basis <= 0) return { status: 'no-basis', today, basis, pace };
  const cut = basis * SPEND_PACE_CUT;
  return { status: today >= cut || pace >= cut ? 'hot' : 'normal', today, basis, pace };
}

// 4타일 데이터 — 렌더와 분리된 순수 변환이라 상태 4종을 테스트가 그대로 고정할 수 있다.
// every tile keeps its drill even when an alarm row drills the same screen → the tile is where the eye lands
function buildTiles({ harness, costState, agentsState, outcomesState, isHarnessBusy = false }) {
  const busyByRegion = {
    outcomes: outcomesState?.busy, agents: agentsState?.busy, cost: costState?.busy, [HARNESS_REGION]: isHarnessBusy,
  };
  const tiles = [
    buildHarnessTile(harness),
    markHeldTile(buildOutcomeTile(outcomesState), outcomesState),
    markHeldTile(buildFleetTile(agentsState), agentsState),
    markHeldTile(buildSpendTile(costState, harness?.kpi), costState),
  ];
  // a first load is 'loading', not a refresh → only held data dims while its region re-reads
  return tiles.map((tile) => ({
    ...tile,
    isBusy: tile.status !== 'loading' && Boolean(busyByRegion[tile.region]),
  }));
}

// held data whose latest read failed → last-known badge + own Retry; its error joins the shared-outage check
// shared freshness rule → a held warn/crit keeps its alarm, a held all-clear drops to neutral
function markHeldTile(tile, state) {
  if (tile.status === 'loading' || tile.status === 'error' || state?.error == null) return tile;
  const isAlarm = tile.tone === 'warn' || tile.tone === 'crit';
  return {
    ...tile, tone: isAlarm ? tile.tone : 'neutral', isHeld: true, badge: 'Last known', error: state.error, canRetry: true,
    hint: `Showing the last reading — couldn't refresh ${tile.source}.`,
  };
}

// 타일 1 — 하네스 파트. 분모는 셸이 관측한 파트 수, 콜드 실패로 잃은 파트가 있으면 전체 파트 수: 미관측 파트를 정상으로 세지 않는다.
function buildHarnessTile(harness) {
  const base = {
    id: 'harness', label: 'Harness health', region: HARNESS_REGION, target: 'architecture', targetLabel: 'System map',
    source: 'harness health',
  };
  if (harness && harness.status === 'loading') {
    return { ...base, status: 'loading', tone: 'neutral', value: '—', hint: null };
  }
  if (harness && harness.status !== 'ready' && harness.error != null) {
    return buildFailedTile(base, harness.error);
  }
  if (!harness || harness.status !== 'ready') {
    // not a region fetch error → never joins the page banner, so the tile keeps its own Retry
    return { ...base, status: 'unavailable', tone: 'neutral', value: '—', hint: 'Harness readings unavailable.', canRetry: true };
  }
  return { ...base, ...describeHarnessReading(harness), status: 'ready', error: harness.error ?? null };
}

// a failed refresh over held parts → last known · a cold failure drops its parts → counted against every part
function describeHarnessReading(harness) {
  const downCount = harness.downNames.length;
  const isPartlyUnread = (harness.unreadSources ?? []).length > 0;
  const lostCount = isPartlyUnread ? harness.partsTotal - harness.partsChecked : 0;
  const partCount = lostCount > 0 ? harness.partsTotal : harness.partsChecked;
  // a known fault keeps crit; otherwise an unread source withholds the healthy verdict
  const unreadTone = isPartlyUnread ? 'info' : 'ok';
  return {
    tone: downCount > 0 ? 'crit' : unreadTone,
    badge: getHarnessBadge({ isPartlyUnread, lostCount, downCount }),
    value: downCount > 0 ? `${downCount} of ${partCount} down` : `${harness.partsOk} of ${partCount} up`,
    detail: lostCount > 0 ? `${lostCount} not read` : undefined,
    trend: describeHarnessCoverage(harness, isPartlyUnread),
    hint: describeHarnessHint(harness, { isPartlyUnread, lostCount, downCount }),
    canRetry: isPartlyUnread,
  };
}

function getHarnessBadge({ isPartlyUnread, lostCount, downCount }) {
  if (isPartlyUnread && lostCount === 0) return 'Last known';
  if (downCount > 0) return BADGE.HARNESS_DOWN;
  return isPartlyUnread ? 'Partly unknown' : undefined;
}

const BADGE = {
  // the value already says "down" → the verdict and the names line each use another word
  HARNESS_DOWN: 'Action needed',
  // the detail line leads with the judged pace → the badge names that multiple, never the so-far one
  SPEND_HOT: `Pace above ${SPEND_PACE_CUT}×`,
  SPEND_NORMAL: 'Within pace',
};

function describeHarnessHint(harness, { isPartlyUnread, lostCount, downCount }) {
  if (isPartlyUnread) {
    const sources = harness.unreadSources.join(' · ');
    return lostCount > 0 ? `Couldn't read ${sources}.` : `Showing the last reading — couldn't refresh ${sources}.`;
  }
  // the headline already carries the count → the hint names the parts instead of restating it
  return downCount > 0 ? `Not answering: ${joinPartNames(harness.downNames)}` : 'All polled parts healthy';
}

// its own line under the count → an unpolled part never reads as one more down part
// a failed read leaves parts unjudged too, indistinguishable in the fold → then no part is credited to the System map
function describeHarnessCoverage(harness, isPartlyUnread) {
  if (harness.uncheckedNames.length === 0) return `All ${formatInt(harness.partsChecked)} parts polled on every harness read`;
  const counted = `${formatInt(harness.partsChecked)} of ${formatInt(harness.partsTotal)} parts`;
  if (isPartlyUnread) return `${counted} read this time`;
  return `${counted} polled here; ${joinPartNames(harness.uncheckedNames)} checked on the System map`;
}

// U+2011 non-breaking hyphen → a name like daily-restart-autoagent never wraps mid-name in a narrow tile
function joinPartNames(names) {
  return names.map((name) => name.replace(/-/g, '\u2011')).join(' · ');
}

// 첫 판독 전(loading) · 데이터 없는 실패(error) → 타일, 그 외 null. 실패 문구는 base.source 로 공용 카드가 만든다.
// a cold error stays 'error' through its Retry (getRegionView) → the focused Retry card never becomes a loader
function buildPendingTile(base, state) {
  const view = state ? window.UI.getRegionView(state) : 'loading';
  if (view === 'loading') return { ...base, status: 'loading', tone: 'neutral', value: '—', hint: null };
  if (view === 'error') return buildFailedTile(base, state.error);
  return null;
}

// the shared error copy, laid flat in the tile's own lines → no card nests inside the tile card
function buildFailedTile(base, error) {
  const copy = window.UI.getErrorCopy(error, base.source);
  return {
    ...base, status: 'error', tone: 'neutral', value: '—', detail: copy.sentence, hint: copy.next, note: copy.detail ?? undefined,
    error, canRetry: true,
  };
}

// 타일 2 — 7일 작업 결과. 판정과 임계는 ui.jsx 공용 규칙 소비 (Task results 와 동일 분모).
function buildOutcomeTile(outcomesState) {
  const base = {
    id: 'outcomes', label: 'Task results', window: '7 d', target: 'outcomes', targetLabel: 'Task results',
    region: 'outcomes', source: 'task results',
  };
  const pending = buildPendingTile(base, outcomesState);
  if (pending) return pending;
  const rate = window.UI.resolveOutcomeRate(outcomesState.data);
  return {
    ...base, status: OUTCOME_TILE_STATUS[rate.status], tone: rate.tone, badge: OUTCOME_VERDICT[rate.status],
    value: describeOutcomeValue(rate), detail: describeOutcomeDetail(rate), hint: describeOutcomeHint(rate),
    trend: describeOutcomeTrend(rate, outcomesState.data?.prior_window), note: OUTCOME_COUNTING_NOTE,
  };
}

// 판정 → 타일 상태. low-n 은 ready 가 아니다 — 표본 부족을 '정상'으로 읽히게 두지 않는다.
const OUTCOME_TILE_STATUS = {
  unavailable: 'unavailable', empty: 'empty', 'low-n': 'unavailable', ok: 'ready', warn: 'ready', crit: 'ready',
};

// numbers headline, the verdict rides in the badge (a neutral low-n tile renders no badge)
const OUTCOME_VERDICT = { ok: 'Below alert lines', warn: 'Caveats above alert line', crit: 'Failures above alert line' };
const OUTCOME_COUNTING_NOTE = 'Counts only writer-emitted outcomes — records the agent reported itself; synthesized records are left out.';

function describeOutcomeValue(rate) {
  if (rate.status === 'low-n') return formatInt(rate.writerTotal);
  if (!Object.hasOwn(OUTCOME_VERDICT, rate.status)) return '—';
  return getSharePct(rate.breakage, rate.writerTotal);
}

function describeOutcomeDetail(rate) {
  if (rate.status === 'low-n') return 'outcomes · too few to judge';
  if (!Object.hasOwn(OUTCOME_VERDICT, rate.status)) return null;
  return `${formatInt(rate.breakage)} of ${formatInt(rate.writerTotal)} failed or blocked · alert at ${formatAlertLine(window.UI.OUTCOME_BREAKAGE_CRIT_SHARE)}`;
}

function describeOutcomeHint(rate) {
  if (rate.status === 'unavailable') return 'No reported outcomes to judge.';
  if (rate.status === 'empty') return 'No outcomes recorded in the last 7 days.';
  if (rate.status === 'low-n') return `Needs ${window.UI.LOW_N_MIN} reported outcomes to judge.`;
  const caveats = `${getSharePct(rate.openCaveats, rate.writerTotal)} (${formatInt(rate.openCaveats)}) finished with caveats`;
  return `${caveats} · alert at ${formatAlertLine(window.UI.OUTCOME_OPEN_CAVEAT_WARN_SHARE)}`;
}

// shares, never counts → a busier week at the same failure rate reads level
function describeOutcomeTrend(rate, prior) {
  if (!prior || !Object.hasOwn(OUTCOME_VERDICT, rate.status)) return null;
  const priorRange = formatDayRange(prior);
  const priorRate = window.UI.resolveOutcomeRate(prior);
  if (!Object.hasOwn(OUTCOME_VERDICT, priorRate.status)) return `No comparison — too few reported outcomes in ${priorRange}`;
  const points = (rate.breakage / rate.writerTotal - priorRate.breakage / priorRate.writerTotal) * 100;
  const change = Math.abs(points) < 0.05 ? 'Level' : `${points > 0 ? 'Up' : 'Down'} ${Math.abs(points).toFixed(1)} pts`;
  return `${change} since ${formatDay(prior.period_end)} vs ${getSharePct(priorRate.breakage, priorRate.writerTotal)} in ${priorRange}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// server-anchored YYYY-MM-DD → MM-DD; never re-derived from the browser clock
function formatDay(date) {
  return String(date).slice(5, 10);
}

// period_end is exclusive → the last day shown is the day before it
function formatDayRange({ period_start: start, period_end: end }) {
  const last = new Date(Date.parse(`${end}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  return `${formatDay(start)} – ${formatDay(last)}`;
}

function formatAlertLine(share) {
  return `${Math.round(share * 100)}%`;
}

// headline share without its " (n/d)" tail → a 28px value stays on one line; the counts ride the detail line
function getSharePct(numerator, denominator) {
  return window.UI.formatPctWithDenominator(numerator, denominator).split(' (')[0];
}

// 타일 3 — 함대. headline = suspended agents from the circuit-breaker summary; an unloaded breaker is unavailable, never 0.
function buildFleetTile(agentsState) {
  const base = {
    id: 'fleet', label: 'Fleet', window: '7 d', target: 'agents', targetLabel: 'Agents',
    region: 'agents', source: 'the fleet summary',
  };
  const pending = buildPendingTile(base, agentsState);
  if (pending) return pending;
  const meta = agentsState.data?.meta;
  const breaker = meta?.circuit_breaker;
  const suspended = Number(breaker?.suspended_count);
  const streak = Number(breaker?.streak_count);
  if (breaker?.source !== 'loaded' || !Number.isFinite(suspended) || !Number.isFinite(streak)) {
    return { ...base, status: 'unavailable', tone: 'neutral', value: '—', hint: 'Suspension state unavailable.' };
  }
  const tone = suspended > 0 ? 'crit' : streak > 0 ? 'warn' : 'ok';
  const agentCount = Number(meta.total_agents);
  return {
    ...base, status: 'ready', tone, badge: FLEET_VERDICT[tone], value: formatInt(suspended), unit: 'suspended',
    detail: `${formatInt(streak)} on a failing streak`,
    trend: describeFleetReach(agentCount, Number(breaker.registry_agents)),
    hint: describeBusiestAgent(agentsState.data?.agents?.[0]),
  };
}

function describeFleetReach(agentCount, registryCount) {
  if (!Number.isFinite(agentCount)) return null;
  const of = Number.isFinite(registryCount) && registryCount > 0 ? ` of ${formatInt(registryCount)} registered` : '';
  return `${formatInt(agentCount)}${of} agents had a run in the last 7 days`;
}

// the region reads order=runs&limit=1 → its one row is the busiest agent of the window
function describeBusiestAgent(row) {
  const runs = Number(row?.runs);
  if (!row || !Number.isFinite(runs)) return null;
  return `Most runs: ${row.agent_name ?? row.agent_id}, ${formatInt(runs)}`;
}

// the value's unit already says "suspended" → the verdict never repeats it
const FLEET_VERDICT = { ok: 'All active', warn: 'Failing streak', crit: 'Needs review' };

// 타일 4 — 오늘 지출. 톤은 pace 판정에서만 온다(금액 자체는 위험도가 아니다).
function buildSpendTile(costState, kpi) {
  const base = {
    id: 'spend', label: 'Spend today', target: 'cost', targetLabel: 'Cost & usage', region: 'cost', source: "today's spend",
  };
  const pending = buildPendingTile(base, costState);
  if (pending) return pending;

  const pace = resolveSpendPace(costState);
  const tone = { hot: 'warn', normal: 'ok' }[pace.status] ?? 'neutral';
  const reading = { ...base, status: 'ready', tone, value: formatUsd(pace.today), trend: describeSpendTrend(kpi) };
  if (pace.status === 'no-basis') {
    return { ...reading, hint: 'No spend in the last 7 days — no baseline to compare against.' };
  }
  return {
    ...reading, badge: tone === 'warn' ? BADGE.SPEND_HOT : BADGE.SPEND_NORMAL, detail: describeSpendPace(pace),
    hint: `Alarm at ${SPEND_PACE_CUT}× the 7-day average/day, on so-far or the 3-hour pace`,
  };
}

// day-over-day from one payload (the shell's /api/dashboard/kpi) → today and its comparand never mix sources
function describeSpendTrend(kpi) {
  const prior = Number(kpi?.yesterday_same_time_cost_usd);
  if (kpi?.today_cost_usd == null || kpi.yesterday_same_time_cost_usd == null) return 'Change on yesterday unavailable — the harness read carries no spend';
  if (!(prior > 0)) return 'No spend yesterday by this time to compare against';
  const change = Math.round(((Number(kpi.today_cost_usd) - prior) / prior) * 100);
  const comparand = `${formatUsd(prior)} yesterday by this time`;
  if (change === 0) return `Level with ${comparand}`;
  return `${change > 0 ? 'Up' : 'Down'} ${Math.abs(change)}% on ${comparand}`;
}

// the verdict trips on the larger of so-far and pace → the lead line states that same figure
function describeSpendPace(pace) {
  const judged = Math.max(pace.today, pace.pace);
  return `On pace for ${formatUsd(judged)} today, ${(judged / pace.basis).toFixed(1)}× the 7-day average (${formatUsd(pace.basis)})`;
}

// 헤더 우측 중립 텍스트 — 설치 버전. 조치 신호는 레인이 운반하므로 여기는 톤이 없다.
// a pending read names no version → the freshness stamp beside it already says loading
function describeVersion(harness) {
  if (harness?.status === 'loading') return null;
  return harness && harness.version ? `v${harness.version}` : 'version unknown';
}

// wave regions + the shell harness — update-job polls on its own, so it stays out and never moves the stamp
// the stamp also answers for the harness tile → a pending harness read keeps it busy, a failed one keeps it off Fresh
// the shell owns the harness read → its page state leaves that region out, so a harness-only failure is reported once
function getFreshnessInputD(settledAt, waveStates, harness) {
  return { at: settledAt, regions: [...waveStates, toHarnessRegion(harness)], shellRegions: waveStates };
}

// the shell fold carries no busy flag → its read in flight is status 'loading'
function toHarnessRegion(harness) {
  if (!harness) return null;
  return { status: harness.status, busy: harness.status === 'loading', error: harness.error ?? null };
}

const RESULT_ORDER = Object.keys(RESULT_ROW_META);

// same payload and same writer rule as the Task results tile → the panel's failed + blocked is the tile's breakage
function buildResultPanel(data) {
  const byResult = new Map((data?.by_result ?? []).map((row) => [row.result, row]));
  const results = [...RESULT_ORDER, ...[...byResult.keys()].filter((result) => !RESULT_ORDER.includes(result))];
  const rows = results.filter((result) => byResult.has(result))
    .map((result) => ({ result, count: window.UI.getWriterCount(byResult.get(result)) }));
  const start = data?.prior_window?.period_end;
  return {
    rows, writerTotal: window.UI.getWriterTotal(data), agents: getBreakageAgents(data?.by_agent_result),
    span: start ? `${formatDay(start)} – today` : 'Last 7 days and today',
  };
}

const BREAKAGE = { RESULTS: ['fail', 'blocked'], AGENT_LIMIT: 3 };

// per (agent, result) row under the tile's writer rule → each agent's failed + blocked, worst first
function getBreakageAgents(rows) {
  const counts = new Map();
  for (const row of rows ?? []) {
    if (!BREAKAGE.RESULTS.includes(row.result)) continue;
    counts.set(row.agent, (counts.get(row.agent) ?? 0) + window.UI.getWriterCount(row));
  }
  return [...counts].filter(([, count]) => count > 0)
    .sort(([agentA, countA], [agentB, countB]) => countB - countA || agentA.localeCompare(agentB))
    .slice(0, BREAKAGE.AGENT_LIMIT)
    .map(([agent, count]) => ({ agent, count }));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The server's Sun-first 7×24 grid, rotated so the bucket timezone's today is the last row.
 * meta.bucket_dates names the window's dates in that timezone (9 while it runs ahead of the UTC anchor) — never the browser clock.
 * The server buckets by weekday only → every weekday holding two of those dates sums both; its row carries `fold`.
 */
function buildHourGrid(data) {
  const grid = Array.isArray(data?.data) ? data.data : [];
  const dates = data?.meta?.bucket_dates ?? null;
  const todayIndex = dates ? getWeekday(dates.last) : WEEKDAYS.length - 1;
  const folds = dates ? getFoldsByWeekday(dates) : new Map();
  const rows = WEEKDAYS.map((_, offset) => (todayIndex + 1 + offset) % WEEKDAYS.length).map((dow) => ({
    day: WEEKDAYS[dow], counts: HOUR.OF_DAY.map((hour) => Number(grid[dow]?.[hour]) || 0), fold: folds.get(dow) ?? null,
  }));
  const cells = rows.flatMap((row) => row.counts.map((count, hour) => ({ day: row.day, fold: row.fold, hour, count })));
  const peak = cells.reduce((best, cell) => (cell.count > best.count ? cell : best), cells[0]);
  return {
    rows, peak, max: peak.count, total: cells.reduce((sum, cell) => sum + cell.count, 0),
    folds: rows.filter((row) => row.fold),
    span: dates ? `${formatDay(dates.first)} – today, ${dates.count} calendar dates` : 'Last 7 days',
  };
}

function getWeekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// weekday → 'MM-DD + MM-DD' for each weekday the window covers twice; the last date reads 'today'
function getFoldsByWeekday({ first, last, count }) {
  const labelsByWeekday = new Map();
  for (let offset = 0; offset < count; offset += 1) {
    const date = new Date(Date.parse(`${first}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
    const dow = getWeekday(date);
    labelsByWeekday.set(dow, [...(labelsByWeekday.get(dow) ?? []), date === last ? 'today' : formatDay(date)]);
  }
  return new Map([...labelsByWeekday].filter(([, labels]) => labels.length > 1).map(([dow, labels]) => [dow, labels.join(' + ')]));
}

/** @param today - YYYY-MM-DD in the series' own timezone; the point on that day is still accruing */
function buildSpendStrip(points, today) {
  const bars = (points ?? []).map((point) => ({ date: point.date, cost: Number(point.cost_usd) || 0, isPartial: point.date === today }));
  if (bars.length === 0) return { bars, span: null };
  const last = bars[bars.length - 1];
  return { bars, span: `${formatDay(bars[0].date)} – ${last.isPartial ? 'today' : formatDay(last.date)}` };
}

// the series' day boundary, not the browser's → en-CA formats as YYYY-MM-DD
function getTodayIn(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  } catch {
    return null;
  }
}

// update-job poll → 실제 row (none 은 무 job).
function readUpdateJob(jobState) {
  return (jobState.status === 'ready' && jobState.data && jobState.data.status !== 'none') ? jobState.data : null;
}

// ── Pure helpers ──
async function fetchJson(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw await window.UI.getFetchError(res);
  return res.json();
}

// one region read → resolves true only when its answer arrived (an abort or failure is false)
function runFetch(url, setter, request) {
  const { putRegionRequest, putRegionData, putRegionFailure } = window.UI;
  setter((state) => putRegionRequest(state, url, request));
  return fetchJson(url, request.signal)
    .then((data) => {
      setter((state) => putRegionData(state, request, data));
      return true;
    })
    .catch((err) => {
      setter((state) => putRegionFailure(state, request, err));
      return false;
    });
}

window.ScreenDashboard = ScreenDashboard;
