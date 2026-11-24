// Screen 01 — Dashboard: triage. The Needs you alarm list + one status card of four stats + the week panels;
// answers only "does anything need me, is the harness healthy" and links every other question to its owning screen.
// harness 사실은 셸 fold(prop) 단일 출처 — 화면이 harness 스토어를 다시 읽지 않는다.
const { useState: useStateD, useEffect: useEffectD, useRef: useRefD, useCallback: useCallbackD } = React;

// 숫자 포맷 — ui.jsx 공용 SoT 소비 (ui.js 가 dashboard.js 보다 먼저 로드 → window.UI 가용).
const formatUsdCompact = window.UI.formatUsdCompact;
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
    PageHeader, TypeScaleStyle, FreshnessStamp, RefreshButton, PageErrorBanner, MachineString, INITIAL_REGION_STATE, getRegionSummary,
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
  const retryStat = useCallbackD((region) => getStatRetry(loadRegion, rereadHarness)(region), [loadRegion, rereadHarness]);
  const refetchUpdateJob = useCallbackD(() => loadRegion('updateJob'), [loadRegion]);

  // harness 판독은 셸 fold 가 공급 — 여기서 재요청하지 않는다(nav 숫자와 어긋나는 원인).
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
  const alarmSources = { harness, outcomesState, agentsState, costState, updateState, installKind };
  const alarms = buildAlarms(alarmSources);
  const alarmReadiness = getAlarmReadiness(alarmSources, alarms);
  const stats = buildStats({ harness, costState, agentsState, outcomesState, isHarnessBusy });
  const weekPanels = [{ source: 'daily spend', error: spendDaysState.error }, { source: 'runs by hour', error: heatmapState.error }];
  const sharedFailure = getPageSharedFailure(stats, weekPanels);
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
        .dash-week-panel { display: flex; flex-direction: column; }
        .dash-week-panel > .card { flex: 1 1 auto; }
        .dash-strip-track { height: 4rem; position: relative; }
        /* one 1px --line baseline across the strip → each day's segment reaches half the column gap either side */
        .dash-strip-base { position: absolute; bottom: 0; left: calc(var(--gap-label-inline) / -2); right: calc(var(--gap-label-inline) / -2); height: 1px; background: rgb(var(--line)); }
        li:first-child > .dash-strip-track > .dash-strip-base { left: 0; }
        li:last-child > .dash-strip-track > .dash-strip-base { right: 0; }
        .dash-strip-bar { background: currentColor; border-radius: 2px; }
        /* today is still accruing → an outlined bar, never a filled one that reads as a closed day */
        .dash-strip-partial { background: transparent; border: 1px dashed currentColor; }
        .dash-result-row { display: grid; grid-template-columns: 9rem 1fr 4.5rem; align-items: center; }
        .dash-result-fill { height: 0.5rem; background: currentColor; border-radius: 2px; }
        /* tracks capped at the cell cap → capped cells keep even 2px gaps instead of floating in wider tracks */
        /* the label track grows to its widest label → a folded "Wed ×2" stays on one line instead of spilling into the first cell */
        .dash-hour-grid { display: grid; grid-template-columns: minmax(2.5rem, max-content) repeat(24, minmax(0, 1.25rem)); justify-content: start; gap: 2px; align-items: center; }
        /* neutral ink ramp (spec 44084 §4.1) → the lowest run hour clears 3:1 on the card; a zero hour is an outline, never a fill */
        .dash-hour-cell, .dash-hour-swatch { border-radius: 2px; }
        .dash-hour-cell { aspect-ratio: 1; }
        .dash-hour-swatch { width: 12px; height: 12px; }
        :is(.dash-hour-cell, .dash-hour-swatch)[data-heat="0"] { box-shadow: inset 0 0 0 1px rgb(var(--line)); }
        :is(.dash-hour-cell, .dash-hour-swatch)[data-heat="1"] { background: var(--heat-1); }
        :is(.dash-hour-cell, .dash-hour-swatch)[data-heat="2"] { background: var(--heat-2); }
        :is(.dash-hour-cell, .dash-hour-swatch)[data-heat="3"] { background: var(--heat-3); }
        :is(.dash-hour-cell, .dash-hour-swatch)[data-heat="4"] { background: var(--heat-4); }
        .dash-hour-steps { display: flex; gap: 2px; }
        .dash-hour-tick { white-space: nowrap; }
      `}</style>

      <div className="flex-shrink-0">
        <PageHeader
          title="Dashboard"
          sub={<span className="fs-meta">Triage</span>}
          freshness={
            <>
              {version && <MachineString className="fs-meta text-dim">{version}</MachineString>}
              <FreshnessStamp {...getFreshnessInputD(settledAt, waveStates, harness)}/>
            </>
          }
          refresh={<RefreshButton isBusy={isWaveBusy} hasRead={settledAt !== null}
            onRefresh={triggerRefresh} label="Refresh dashboard"/>}
        />
      </div>

      {/* an idle lane is sr-only → out of flow, so it takes no section gap */}
      <div className="flex flex-col gap-section">
        {sharedFailure && (
          <PageErrorBanner sources={sharedFailure.sources} error={sharedFailure.error} onRetry={triggerRefresh}
            isBusy={isWaveBusy} focusTargetId={DASH_STATUS_ID}/>
        )}
        <AlarmLane
          alarms={alarms}
          readiness={alarmReadiness}
          onNav={onNav}
          updateState={updateState}
          updateJobState={updateJobState}
          onRefetchJob={refetchUpdateJob}
        />
        <StatusCard stats={stats} onRetry={retryStat} sharedSources={sharedSources}/>
        <WeekRow spendState={spendDaysState} outcomesState={outcomesState} heatmapState={heatmapState}
          onRetrySpend={() => loadRegion('spendDays')} onRetryHeatmap={() => loadRegion('heatmap')}
          sharedSources={sharedSources}/>
      </div>
    </div>
  );
}

// the harness reading is the shell's → its Retry re-polls the shell, every other region reloads itself
function getStatRetry(loadRegion, rereadHarness) {
  return (region) => (region === HARNESS_REGION ? rereadHarness() : loadRegion(region));
}

const NO_SHARED_SOURCES = Object.freeze([]);

// ≥2 sources failing on one cause (stats + week panels, unloaded or held) → one page banner carries the only Retry
// panels on another cause keep their own Retry → the stats' banner still stands without them
function getPageSharedFailure(stats, panels = []) {
  const { getSharedFailure } = window.UI;
  const statEntries = stats.map((stat) => ({ source: stat.source, error: stat.error }));
  return getSharedFailure([...statEntries, ...panels]) ?? getSharedFailure(statEntries);
}

// "Needs you" (spec 44084 §3.3) — one list card of alarm rows, worst first; no alarm → no card, no text, no space
// the polite region stays mounted so a later row is announced, and it announces each row → no row carries a role
function AlarmLane({ alarms, readiness = ALARM_READINESS_LOADING, onNav, updateState, updateJobState, onRefetchJob }) {
  const isUnread = readiness.status === 'unknown';
  const isIdle = alarms.length === 0 && !isUnread;
  return (
    <section className={isIdle ? 'dash-lane sr-only' : 'dash-lane'} aria-label="Needs you">
      <div aria-live="polite" className="flex flex-col gap-list">
        {alarms.length > 0 && (
          <div className="card dash-alarm-list">
            {alarms.map((alarm) => (
              <AlarmLaneRow key={alarm.id} alarm={alarm} onNav={onNav}>
                {alarm.id === 'install' && (
                  <UpdateBadge availabilityState={updateState} jobState={updateJobState} onRefetchJob={onRefetchJob}/>
                )}
              </AlarmLaneRow>
            ))}
          </div>
        )}
        {isUnread && <UnreadAlarmsCard unread={readiness.unread}/>}
      </div>
    </section>
  );
}

// one alarm row — the amount-first title, an optional detail, then a Link to the owning page or the row's own control (children)
function AlarmLaneRow({ alarm, onNav, children }) {
  const { AlarmRow, Link } = window.UI;
  const actions = children || alarm.target ? (
    <>
      {children}
      {alarm.target && <Link href={`#${alarm.target}`} onClick={getDrillClick(alarm.target, onNav)}>{alarm.targetLabel}</Link>}
    </>
  ) : null;
  return <AlarmRow tone={alarm.tone} title={alarm.title} detail={alarm.detail} isHeld={alarm.isHeld} actions={actions}/>;
}

// a source that settled without an answer is information, not an empty lane → the header Refresh is its action
function UnreadAlarmsCard({ unread }) {
  return (
    <window.UI.AlertCard tone="neutral" hasLiveHost title="Couldn't check for alarms"
      body={`Couldn't read ${unread.join(' · ')} — more alarms may be hidden.`}/>
  );
}

const ALARM_READINESS_LOADING = Object.freeze({ status: 'loading', unread: [] });
// each source of the lane, in tie order → its readiness label, the one alarm row it can raise and that row's builder;
// isAnswered → a read payload that still lacks the reading its row is built on is no answer
const ALARM_SOURCES = [
  { key: 'harness', label: 'system parts', alarmId: 'harness', build: buildHarnessAlarm },
  { key: 'outcomesState', label: 'task results', alarmId: 'outcomes', build: buildOutcomeAlarm },
  { key: 'agentsState', label: 'agents', alarmId: 'fleet', build: buildFleetAlarm, isAnswered: (source) => getBreakerCounts(source.data) != null },
  { key: 'costState', label: "today's spend", alarmId: 'spend', build: buildSpendAlarm },
  { key: 'updateState', label: 'install state', alarmId: 'install', build: buildInstallAlarm },
];

/**
 * Whether the lane may claim an all-clear: 'loading' while any source is unsettled,
 * 'unknown' once one settled without an answer, 'read' only when every source answered.
 * @param alarms - the listed rows; a source whose held row is listed hides nothing more
 * @returns unread - labels of the sources that settled without an answer
 */
function getAlarmReadiness(sources, alarms = []) {
  const entries = ALARM_SOURCES.map((meta) => ({ ...meta, source: sources[meta.key] }));
  if (entries.some(({ source }) => !source || source.status === 'loading')) return ALARM_READINESS_LOADING;

  // a held reading whose latest read failed is unread too — its all-clear is stale
  const heldAlarmIds = new Set(alarms.filter((alarm) => alarm.isHeld).map((alarm) => alarm.id));
  const unread = entries
    .filter(({ source, alarmId, isAnswered }) => !isSourceAnswered(source, isAnswered) && !heldAlarmIds.has(alarmId))
    .map(({ label }) => label);
  return { status: unread.length > 0 ? 'unknown' : 'read', unread };
}

function isSourceAnswered(source, isAnswered) {
  return source.status === 'ready' && source.error == null && (!isAnswered || isAnswered(source));
}

// the card outlives every recovery → a banner or stat Retry that leaves on success hands focus here
const DASH_STATUS_ID = 'dash-status';

const RESULTS_STAT_POINTER = 'the Failed or blocked stat above';

// spec 44084 §9 — one card, four stats (label, value, one context line); every counting rule and window behind one ⓘ
function StatusCard({ stats, onRetry, sharedSources = NO_SHARED_SOURCES }) {
  const { Card, StatRow, StatNotes } = window.UI;
  const noted = stats.filter((stat) => stat.notes?.length > 0);
  const items = stats.map((stat) => buildStatItem(stat, { onRetry, isRetryShared: sharedSources.includes(stat.source) }));
  return (
    <div id={DASH_STATUS_ID} aria-busy={stats.some((stat) => stat.isBusy) ? 'true' : undefined}>
      <Card title="Status" info={noted.length > 0 && <StatNotes stats={noted.map(buildStatNote)}/>} infoLabel="How these figures are read">
        <StatRow stats={items}/>
      </Card>
    </div>
  );
}

// stat model → one StatRow stat; the value is the Link to the owning screen once there is something to link
function buildStatItem(stat, { onRetry, isRetryShared }) {
  if (stat.status === 'loading') return { key: stat.id, label: getStatLabel(stat), isLoading: true };
  return {
    key: stat.id, label: getStatLabel(stat), value: <StatValue stat={stat}/>, unit: stat.absent ? undefined : stat.unit,
    context: getStatContext(stat, { onRetry, isRetryShared }),
    href: `#${stat.target}`,
  };
}

// windows in labels read "7d" (spec 44084 §9); prose spells "7 days"
function getStatLabel(stat) {
  return stat.window ? `${stat.label}, ${stat.window}` : stat.label;
}

// the one visible line: the builder's context or a banner pointer; the stat's own Retry rides it
function getStatContext(stat, { onRetry, isRetryShared }) {
  const { DayTokens, HeadStatus, RetryButton } = window.UI;
  const isCovered = isRetryShared && stat.error != null;
  // a banner-carried outage is stated once, above → the value reads Not loaded, the line is the pointer alone
  const text = isCovered && stat.status === 'error' ? window.UI.getNoticePointer() : stat.context;
  const hasRetry = Boolean(stat.canRetry) && !isRetryShared;
  if (!text && !hasRetry) return null;
  const line = <DayTokens>{text}</DayTokens>;
  return (
    <>
      {text && <span title={stat.cause ?? text}>{stat.isContextTripped ? <HeadStatus tone={stat.tone}>{line}</HeadStatus> : line}</span>}
      {hasRetry && (
        // a one-line box → the 32 control overhangs into the card padding, the card never grows
        <span className="one-line-box ml-control">
          <RetryButton onRetry={() => onRetry(stat.region)} isBusy={stat.isBusy} focusTargetId={DASH_STATUS_ID}/>
        </span>
      )}
    </>
  );
}

// tones a stat may show → the glyph sits on the figure that tripped (the value, or the context line); the alarm list owns the sentence
const FIRING_TONES = new Set(['warn', 'crit']);

function StatValue({ stat }) {
  const { AbsentValue, ToneGlyph } = window.UI;
  if (stat.absent) return <AbsentValue kind={stat.absent}/>;
  const figure = <span className={`whitespace-nowrap${stat.isBusy ? ' opacity-70' : ''}`}>{stat.value}</span>;
  if (!FIRING_TONES.has(stat.tone) || stat.isContextTripped) return figure;
  return <><ToneGlyph tone={stat.tone}/>{figure}</>;
}

// the card's one ⓘ — each stat's notes led by its label
function buildStatNote(stat) {
  const { DayTokens } = window.UI;
  return { key: stat.id, label: getStatLabel(stat), info: <DayTokens>{stat.notes.join(' ')}</DayTokens> };
}

// the week behind the status card → each panel states its own span (the strip 7 days, the results 7 days + today)
// results | runs by hour pair from xl (both this week's runs; half width keeps the hour cells square and short) → Spend's strip spans the row below
function WeekRow({ spendState, outcomesState, heatmapState, onRetrySpend, onRetryHeatmap, sharedSources = NO_SHARED_SOURCES }) {
  return (
    <>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-section">
        <WeekPanel id="dash-week-results" title="Task results" state={outcomesState} source="task results"
          note={`${OUTCOME.COUNTING_NOTE} ${RESULTS_PANEL_NOTE}`} isRetryShared={sharedSources.includes('task results')}
          render={(data) => <ResultPanel panel={buildResultPanel(data)}/>}/>
        <WeekPanel id="dash-week-hours" title="Runs by hour" state={heatmapState} source="runs by hour"
          note={(data) => <HourGridNote grid={data ? buildHourGrid(data) : null}/>} onRetry={onRetryHeatmap} isRetryShared={sharedSources.includes('runs by hour')}
          render={(data) => <HourGrid grid={buildHourGrid(data)}/>}/>
      </div>
      <WeekPanel id="dash-week-spend" title="Spend per day" state={spendState} source="daily spend" onRetry={onRetrySpend}
        isRetryShared={sharedSources.includes('daily spend')}
        render={(data) => <SpendStrip strip={buildSpendStrip(data.points)}/>}/>
    </>
  );
}

// a panel without onRetry shares its source with a stat → the stat speaks for the failure, the panel only points to it
// note: a sentence, or (data | null) → the drawer body, so a fact read from the payload joins the method it qualifies
function WeekPanel({ id, title, state, source, onRetry, render, note = null, isRetryShared = false }) {
  const { Card, LoadingPlaceholder, Stack } = window.UI;
  const view = getPanelView(state);
  const hasData = view === 'ready' || view === 'held';
  const info = note && (typeof note === 'function' ? note(hasData ? state.data : null) : <p className="fs-body">{note}</p>);
  // a held reading says Last known in plain words beside the title, never a badge (spec 44084 §3)
  return (
    <section id={id} className="dash-week-panel" aria-label={title} aria-busy={state.busy ? 'true' : undefined}>
      <Card title={title} sub={view === 'held' ? window.UI.LAST_KNOWN_TEXT : null} info={info}>
        <Stack gap="list">
          {view === 'loading' && <LoadingPlaceholder label={title.toLowerCase()}/>}
          <PanelFailure id={id} view={view} state={state} source={source} onRetry={onRetry} isRetryShared={isRetryShared}/>
          {hasData && render(state.data)}
        </Stack>
      </Card>
    </section>
  );
}

// held data whose latest read failed → 'held', the same last-known rule markHeldStat applies to the stats
function getPanelView(state) {
  const view = window.UI.getRegionView(state);
  return view === 'ready' && state.error != null ? 'held' : view;
}

// a failure the page banner carries points up to it → one cause, one Retry
// held → the head already says Last known, so the body names only the failed refresh
function PanelFailure({ id, view, state, source, onRetry, isRetryShared }) {
  const { AlertCard, RetryButton, getErrorCopy } = window.UI;
  if (view !== 'error' && view !== 'held') return null;
  if (!onRetry || isRetryShared) {
    const lead = view === 'held' ? "Couldn't refresh" : 'Not loaded';
    return <p className="fs-meta text-dim">{window.UI.getNoticePointer(lead, isRetryShared ? undefined : RESULTS_STAT_POINTER)}</p>;
  }
  const retry = <RetryButton onRetry={onRetry} isBusy={state.busy} focusTargetId={id}/>;
  if (view === 'held') {
    return <AlertCard tone="neutral" surface="inset" title={`Couldn't refresh ${source}.`} actions={retry}/>;
  }
  const copy = getErrorCopy(state.error, source);
  return <AlertCard tone="crit" surface="inset" title={copy.sentence} body={copy.next} details={copy.detail} actions={retry}/>;
}

function SpendStrip({ strip }) {
  if (strip.bars.length === 0) return <p className="fs-meta text-dim">No spend recorded in the last <window.UI.NoWrap>7 days</window.UI.NoWrap>.</p>;
  const max = Math.max(...strip.bars.map((bar) => bar.cost)) || 1;
  const hasPartial = strip.bars.some((bar) => bar.isPartial);
  return (
    <>
      <p className="fs-meta text-dim"><window.UI.DayTokens>{strip.span}</window.UI.DayTokens>{hasPartial ? ' · today is still accruing' : ''}</p>
      <ol className="grid grid-cols-7 gap-label-inline" aria-label={`Spend per day, ${strip.span}`}>
        {strip.bars.map((bar) => (
          <li key={bar.date} className="flex flex-col items-center gap-stack min-w-0">
            <span className="fs-meta tabular-nums whitespace-nowrap">{formatUsdCompact(bar.cost)}</span>
            <div className="dash-strip-track w-full flex items-end text-data" aria-hidden="true">
              {bar.cost > 0 && <div className={`w-full ${bar.isPartial ? 'dash-strip-partial' : 'dash-strip-bar'}`}
                style={{ height: `${Math.max(2, (bar.cost / max) * 100)}%` }}/>}
              <span className="dash-strip-base" data-chart-baseline=""/>
            </div>
            <span className="fs-meta text-dim whitespace-nowrap">{bar.isPartial ? 'Today, so far' : formatDay(bar.date)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

// a result's bar is a quantity → the data colour; the label word (ui.jsx RESULT_META) names the result
function ResultPanel({ panel }) {
  if (panel.writerTotal <= 0) return <p className="fs-meta text-dim">No task results, <window.UI.DayTokens>{panel.span}</window.UI.DayTokens>.</p>;
  return (
    <>
      <p className="fs-meta text-dim">
        <window.UI.DayTokens>{panel.span}</window.UI.DayTokens> · {formatInt(panel.writerTotal)} task results
      </p>
      <ul className="flex flex-col gap-list">
        {panel.rows.map((row) => {
          return (
            <li key={row.result} className="dash-result-row gap-label-inline fs-body">
              <span>{window.UI.resolveResultMeta(row.result).label}</span>
              <div aria-hidden="true">
                <div className="dash-result-fill text-data" style={{ width: `${(row.count / panel.writerTotal) * 100}%` }}/>
              </div>
              <span className="tabular-nums text-right">{formatInt(row.count)}</span>
            </li>
          );
        })}
      </ul>
      <BreakageAgents agents={panel.agents}/>
    </>
  );
}

// the whole row is one Link (spec 44084 §9.1) → name left, count and the Link's arrow right
function BreakageAgents({ agents }) {
  const { Link } = window.UI;
  if (agents.length === 0) return <p className="fs-meta text-dim">No agent had a failed or blocked run.</p>;
  return (
    <>
      <h3 className="fs-meta text-dim">Most failed or blocked</h3>
      <ul className="flex flex-col gap-list">
        {agents.map((row) => (
          <li key={row.agent} className="flex fs-body">
            {/* a real href, not onNav → the query reaches the Task results filter through hashchange */}
            <Link href={getAgentOutcomesHref(row.agent)} className="inline-target flex-1 min-w-0 gap-label-inline"
              aria-label={`${row.agent}: ${formatInt(row.count)} failed or blocked — open its task results`}>
              <span className="flex-1 min-w-0 truncate">{row.agent}</span>
              <span className="tabular-nums">{formatInt(row.count)}</span>
            </Link>
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
  STEPS: [1, 2, 3, 4],
  // the heatmap counts differently from the results panel beside it → it states its own basis
  GRID_BASIS: 'All recorded runs — reconstructed included, poisoned excluded.',
};

function HourGrid({ grid }) {
  const { NoWrap } = window.UI;
  if (grid.total <= 0) return <p className="fs-meta text-dim">No runs recorded in the last <NoWrap>7 days</NoWrap>.</p>;
  return (
    <>
      <p className="fs-meta text-dim"><window.UI.DayTokens>{grid.span}</window.UI.DayTokens> · {formatInt(grid.total)} runs</p>
      <div role="img" aria-label={describeHourGrid(grid)} className="dash-hour-grid fs-meta text-dim">
        {grid.rows.map((row) => (
          <React.Fragment key={row.day}>
            <span className="whitespace-nowrap leading-none" title={row.fold ?? undefined}>{row.fold ? `${row.day} ×2` : row.day}</span>
            {row.counts.map((count, hour) => (
              <span key={hour} className="dash-hour-cell" data-heat={getHeatStep(count, grid.max)}
                title={`${getRowLabel(row)} ${formatHour(hour)} — ${formatInt(count)} runs`}/>
            ))}
          </React.Fragment>
        ))}
        <span/>
        {HOUR.OF_DAY.map((hour) => <span key={hour} className="dash-hour-tick leading-none">{HOUR.TICKS.has(hour) ? formatHourTick(hour) : ''}</span>)}
      </div>
      {/* the img label already states range and peak → the key is for the eye only */}
      <div className="dash-hour-key flex items-center gap-label mt-label fs-meta text-dim" aria-hidden="true">
        <span>0</span>
        <span className="dash-hour-swatch" data-heat={0}/>
        <span>1</span>
        <span className="dash-hour-steps">
          {HOUR.STEPS.map((step) => <span key={step} className="dash-hour-swatch" data-heat={step}/>)}
        </span>
        <span>{formatInt(grid.max)} runs per hour</span>
        {grid.folds.length > 0 && <span>· ×2 = two dates summed</span>}
      </div>
    </>
  );
}

// the ⓘ drawer — the basis and the window's date count; the weekday fold once the payload names a doubled weekday
function HourGridNote({ grid }) {
  const { NoWrap } = window.UI;
  return (
    <>
      <p className="fs-body">{HOUR.GRID_BASIS}{grid?.dateCount ? ` Covers ${grid.dateCount} calendar dates.` : ''}</p>
      {grid?.folds.length > 0 && (
        <p className="fs-body">
          {grid.folds.map((row, at) => (
            <React.Fragment key={row.day}>{at > 0 && ' · '}<NoWrap>{`${row.day} ×2`}</NoWrap>{` sums ${row.fold}`}</React.Fragment>
          ))} — runs are counted by weekday, not by date.
        </p>
      )}
    </>
  );
}

// linear in the count, as the ramp always was → 0 = no run, 1–4 = the --heat-N step
function getHeatStep(count, max) {
  if (count <= 0) return 0;
  return Math.max(1, Math.ceil((HOUR.STEPS.length * count) / max));
}

function getRowLabel(row) {
  return row.fold ? `${row.day} (${row.fold})` : row.day;
}

function formatHour(hour) {
  return `${formatHourTick(hour)}:00`;
}

// a 20px column fits two digits, not HH:00 → the tooltip keeps the full hour
function formatHourTick(hour) {
  return String(hour).padStart(2, '0');
}

function describeHourGrid(grid) {
  const { peak } = grid;
  return `Runs by hour, ${grid.span}: busiest ${getRowLabel(peak)} ${formatHour(peak.hour)} with ${formatInt(peak.count)} runs`;
}

// a plain click routes in-app; a modified or middle click is left to the browser → a new tab
function getDrillClick(target, onNav) {
  return (event) => {
    const isModified = event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (isModified) return;
    event.preventDefault();
    onNav(target);
  };
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

// ── Pure builders (the lane union and the stat row) ──

// the lane union — one row per firing Status-card source + the install state; a firing stat shows only its glyph,
// so its sentence lives here (spec 44084 §9). Learning · Wiki · Models alarms ride their own nav counts
/** @param sources - the ALARM_SOURCES region states by key, plus the install view's `installKind` */
function buildAlarms(sources) {
  const rows = ALARM_SOURCES.flatMap(({ alarmId, build }) => {
    const row = build(sources);
    return row ? [{ id: alarmId, ...row }] : [];
  });
  return rows.sort((a, b) => (SEVERITY_RANK[b.tone] || 0) - (SEVERITY_RANK[a.tone] || 0));
}

function buildHarnessAlarm({ harness }) {
  if (!harness || harness.status !== 'ready' || harness.downNames.length === 0) return null;
  return {
    tone: 'crit',
    title: `${harness.downNames.length} system ${harness.downNames.length === 1 ? 'part is' : 'parts are'} down`,
    detail: joinPartNames(harness.downNames),
    isHeld: hasHeldPartRead(harness),
    target: 'architecture',
    targetLabel: 'System map',
  };
}

// the Task results stat's rule, worded: the tripped line's share and its count — the thresholds stay behind the stat's ⓘ
function buildOutcomeAlarm({ outcomesState }) {
  if (outcomesState?.data == null) return null;
  const rate = window.UI.resolveOutcomeRate(outcomesState.data);
  if (!FIRING_TONES.has(rate.tone)) return null;
  const isCrit = rate.tone === 'crit';
  const count = isCrit ? rate.breakage : rate.openCaveats;
  const share = getSharePct(count, rate.writerTotal);
  return {
    tone: rate.tone,
    title: `${share} of task results ${isCrit ? 'failed or blocked' : 'have open caveats'} in the last 7 days`,
    detail: `${formatInt(count)} of ${formatInt(rate.writerTotal)} task results`,
    isHeld: outcomesState.error != null, target: 'outcomes', targetLabel: 'Task results',
  };
}

// the Fleet stat's breaker reading, worded: suspension first, a streak beside it as the detail
function buildFleetAlarm({ agentsState }) {
  const breaker = agentsState?.data == null ? null : getBreakerCounts(agentsState.data);
  if (!breaker || (breaker.suspended === 0 && breaker.streak === 0)) return null;
  const isCrit = breaker.suspended > 0;
  return {
    tone: isCrit ? 'crit' : 'warn',
    title: isCrit ? describeAgentCount(breaker.suspended, 'suspended') : describeAgentCount(breaker.streak, 'on a failing streak'),
    detail: isCrit && breaker.streak > 0 ? describeStreak(breaker.streak) : null,
    isHeld: agentsState.error != null, target: 'agents', targetLabel: 'Agents',
  };
}

function describeAgentCount(count, state) {
  return `${formatInt(count)} ${count === 1 ? 'agent is' : 'agents are'} ${state}`;
}

function describeStreak(streak) {
  return `${streak === 0 ? 'None' : formatInt(streak)} on a failing streak`;
}

function buildSpendAlarm({ costState }) {
  const spend = resolveSpendPace(costState);
  if (spend.status !== 'hot') return null;
  return { tone: 'warn', ...describeSpendAlarm(spend), isHeld: costState?.error != null, target: 'cost', targetLabel: 'Cost & usage' };
}

function buildInstallAlarm({ installKind }) {
  if (installKind !== 'available' && installKind !== 'failed') return null;
  const isFailed = installKind === 'failed';
  return {
    tone: isFailed ? 'crit' : 'warn',
    title: isFailed ? 'The last update did not finish' : 'An update is ready to apply',
    detail: null,
    target: null,
    targetLabel: null,
  };
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

// the four stats — a pure transform apart from the render, so tests pin each payload state as it is
function buildStats({ harness, costState, agentsState, outcomesState, isHarnessBusy = false }) {
  const busyByRegion = {
    outcomes: outcomesState?.busy, agents: agentsState?.busy, cost: costState?.busy, [HARNESS_REGION]: isHarnessBusy,
  };
  const stats = [
    buildHarnessStat(harness),
    markHeldStat(buildOutcomeStat(outcomesState), outcomesState),
    markHeldStat(buildFleetStat(agentsState), agentsState),
    markHeldStat(buildSpendStat(costState, harness), costState),
  ];
  // a first load is 'loading', not a refresh → only held data dims while its region re-reads
  return stats.map((stat) => ({
    ...stat,
    isBusy: stat.status !== 'loading' && Boolean(busyByRegion[stat.region]),
  }));
}

// held data whose latest read failed → Last known on the context line + own Retry; its error joins the shared-outage check
// the failed refresh → the line's title and the card's ⓘ · shared freshness rule → a held warn/crit keeps its alarm, a held all-clear drops to neutral
function markHeldStat(stat, state) {
  if (stat.status === 'loading' || stat.status === 'error' || state?.error == null) return stat;
  const { LAST_KNOWN_TEXT, getHeldCause } = window.UI;
  const isAlarm = FIRING_TONES.has(stat.tone);
  const cause = getHeldCause(stat.source);
  return {
    ...stat, tone: isAlarm ? stat.tone : 'neutral', isHeld: true, error: state.error, canRetry: true, isContextTripped: false,
    context: LAST_KNOWN_TEXT, cause, notes: [`${cause}.`, ...stat.notes],
  };
}

// stat 1 — harness parts. the denominator is the parts the shell polled, or every part once a cold failure lost some:
// an unread part never counts as healthy
function buildHarnessStat(harness) {
  const base = {
    id: 'harness', label: 'System parts', region: HARNESS_REGION, target: 'architecture', source: 'system parts', notes: [],
  };
  if (harness && harness.status === 'loading') {
    return { ...base, status: 'loading', tone: 'neutral', value: null, context: null };
  }
  if (harness && harness.status !== 'ready' && harness.error != null) {
    return buildFailedStat(base, harness.error);
  }
  if (!harness || harness.status !== 'ready') {
    // not a region fetch error → never joins the page banner, so the stat keeps its own Retry
    return { ...base, status: 'unavailable', tone: 'neutral', value: null, absent: 'not-loaded', context: 'System parts unavailable.', canRetry: true };
  }
  return { ...base, ...describeHarnessReading(harness), status: 'ready', error: harness.error ?? null };
}

// down parts are the alarm row's to name → the context line carries coverage, or the source a failed read left unread
function describeHarnessReading(harness) {
  const downCount = harness.downNames.length;
  const isPartlyUnread = (harness.unreadSources ?? []).length > 0;
  const lostCount = isPartlyUnread ? harness.partsTotal - harness.partsChecked : 0;
  const partCount = lostCount > 0 ? harness.partsTotal : harness.partsChecked;
  const coverage = describeHarnessCoverage(harness, isPartlyUnread);
  // a known fault keeps crit; otherwise an unread source withholds the healthy verdict
  const unreadTone = isPartlyUnread ? 'info' : 'ok';
  // a down part trips the value → the line goes empty, its coverage behind ⓘ
  const reading = {
    tone: downCount > 0 ? 'crit' : unreadTone,
    value: downCount > 0 ? `${downCount} of ${partCount} down` : `${harness.partsOk} of ${partCount} up`,
    context: downCount > 0 ? null : coverage, notes: downCount > 0 ? [`${coverage}.`] : [], canRetry: isPartlyUnread,
  };
  if (!isPartlyUnread) return reading;
  const unread = describeUnread(harness, lostCount);
  return { ...reading, ...unread, notes: [`${coverage}.`, `${unread.cause}.`] };
}

// the held line's shape → the state alone on the line, every unread source in the title and the ⓘ note
function describeUnread(harness, lostCount) {
  const sources = harness.unreadSources.join(' · ');
  if (lostCount === 0) return { context: window.UI.LAST_KNOWN_TEXT, cause: window.UI.getHeldCause(sources) };
  const context = `${formatInt(lostCount)} not read`;
  return { context, cause: `${context} — couldn't read ${sources}` };
}

// an unpolled part never reads as one more down part
// a failed read leaves parts unjudged too, indistinguishable in the fold → then no part is credited to the System map
function describeHarnessCoverage(harness, isPartlyUnread) {
  if (harness.uncheckedNames.length === 0) return `All ${formatInt(harness.partsChecked)} checked`;
  const counted = `${formatInt(harness.partsChecked)} of ${formatInt(harness.partsTotal)}`;
  if (isPartlyUnread) return `${counted} read this time`;
  return `${counted} checked here; ${joinPartNames(harness.uncheckedNames)} on the System map`;
}

// U+2011 non-breaking hyphen → a name like glass-atrium-wiki-curator never wraps mid-name in a narrow line
function joinPartNames(names) {
  return names.map((name) => name.replace(/-/g, '\u2011')).join(' · ');
}

// before the first read → loading; a failure with no data → failed; anything else → null, the builder reads the data
// a cold error stays 'error' through its Retry (getRegionView) → the focused Retry never becomes a loader
function buildPendingStat(base, state) {
  const view = state ? window.UI.getRegionView(state) : 'loading';
  if (view === 'loading') return { ...base, status: 'loading', tone: 'neutral', value: null, context: null };
  if (view === 'error') return buildFailedStat(base, state.error);
  return null;
}

// the shared error copy on the stat's own line; what to do next and the raw answer ride the card's ⓘ
function buildFailedStat(base, error) {
  const copy = window.UI.getErrorCopy(error, base.source);
  return {
    ...base, status: 'error', tone: 'neutral', value: null, absent: 'not-loaded', context: copy.sentence,
    notes: [copy.next, copy.detail].filter(Boolean), error, canRetry: true,
  };
}

// stat 2 — task results over 7 days. verdict and alert lines come from the shared ui.jsx rule (Task results' own denominator)
function buildOutcomeStat(outcomesState) {
  const base = {
    id: 'outcomes', label: 'Failed or blocked', window: '7d', target: 'outcomes', region: 'outcomes', source: 'task results', notes: [],
  };
  const pending = buildPendingStat(base, outcomesState);
  if (pending) return pending;
  const rate = window.UI.resolveOutcomeRate(outcomesState.data);
  const trend = describeOutcomeTrend(rate, outcomesState.data?.prior_window);
  return {
    ...base, status: OUTCOME.STAT_STATUS[rate.status], tone: rate.tone,
    value: describeOutcomeValue(rate), absent: isOutcomeJudgeable(rate) ? undefined : 'none', context: describeOutcomeContext(rate),
    isContextTripped: rate.tone === 'warn',
    notes: [...describeOutcomeLines(rate), ...(trend ? [`${trend}.`] : []), OUTCOME.COUNTING_NOTE],
  };
}

const OUTCOME = {
  // verdict → stat status. low-n is not ready — too small a sample never reads as healthy
  STAT_STATUS: {
    unavailable: 'unavailable', empty: 'empty', 'low-n': 'unavailable', ok: 'ready', warn: 'ready', crit: 'ready',
  },
  JUDGED: new Set(['ok', 'warn', 'crit']),
  COUNTING_NOTE: 'Counts only writer-emitted task results — records the agent reported itself; synthesized records are left out.',
};
// the panel beside the stat counts every result → its ⓘ says how the stat's caveat figure differs
const RESULTS_PANEL_NOTE = 'The Failed or blocked stat above counts the same task results; its caveat figure counts open caveats only.';

// empty or no writer-reported outcome → known to hold nothing (absent 'none'), the share has no denominator
function isOutcomeJudgeable(rate) {
  return rate.status === 'low-n' || OUTCOME.JUDGED.has(rate.status);
}

function describeOutcomeValue(rate) {
  if (rate.status === 'low-n') return formatInt(rate.writerTotal);
  if (!isOutcomeJudgeable(rate)) return null;
  return getSharePct(rate.breakage, rate.writerTotal);
}

function describeOutcomeContext(rate) {
  if (rate.status === 'unavailable') return 'No task results to judge.';
  if (rate.status === 'empty') return 'No task results recorded in the last 7 days.';
  if (rate.status === 'low-n') return 'task results, too few to judge';
  // the failed share tripped → the value carries the glyph, the alarm row the count; open caveats tripped → the line names them
  if (rate.tone === 'crit') return null;
  if (rate.tone === 'warn') return `${formatInt(rate.openCaveats)} of ${formatInt(rate.writerTotal)} with open caveats`;
  return `${formatInt(rate.breakage)} of ${formatInt(rate.writerTotal)} task results`;
}

// the alert lines and the caveat share → behind ⓘ, beside the counting rule
function describeOutcomeLines(rate) {
  const { LOW_N_MIN, OUTCOME_BREAKAGE_CRIT_SHARE, OUTCOME_OPEN_CAVEAT_WARN_SHARE } = window.UI;
  if (rate.status === 'low-n') return [`Needs ${LOW_N_MIN} task results to judge.`];
  if (!OUTCOME.JUDGED.has(rate.status)) return [];
  const caveats = `Open caveats ${getSharePct(rate.openCaveats, rate.writerTotal)} (${formatInt(rate.openCaveats)})`;
  return [
    `Failed or blocked: alarm at ${formatAlertLine(OUTCOME_BREAKAGE_CRIT_SHARE)}.`,
    `${caveats}, alarm at ${formatAlertLine(OUTCOME_OPEN_CAVEAT_WARN_SHARE)}.`,
  ];
}

// shares, never counts → a busier week at the same failure rate reads level
function describeOutcomeTrend(rate, prior) {
  if (!prior || !OUTCOME.JUDGED.has(rate.status)) return null;
  const priorRange = window.UI.formatDayRange(prior);
  const priorRate = window.UI.resolveOutcomeRate(prior);
  if (!OUTCOME.JUDGED.has(priorRate.status)) return `No comparison — too few task results in ${priorRange}`;
  const points = (rate.breakage / rate.writerTotal - priorRate.breakage / priorRate.writerTotal) * 100;
  const change = Math.abs(points) < 0.05 ? 'Level' : `${points > 0 ? 'Up' : 'Down'} ${window.UI.formatDecimal(Math.abs(points))} pts`;
  return `${change} since ${formatDay(prior.period_end)} vs ${getSharePct(priorRate.breakage, priorRate.writerTotal)} in ${priorRange}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// server-anchored YYYY-MM-DD → MM-DD; never re-derived from the browser clock
const formatDay = window.UI.formatKstDay;

function formatAlertLine(share) {
  return window.UI.formatPct(share * 100);
}

// headline share without its counts → the value stays on one line; the counts ride the context line
// callers pass a writer total past the low-n gate → the denominator is never 0
function getSharePct(numerator, denominator) {
  return window.UI.formatPct((numerator / denominator) * 100);
}

// stat 3 — fleet. headline = suspended agents from the circuit-breaker summary; an unloaded breaker is unavailable, never 0
function buildFleetStat(agentsState) {
  const base = { id: 'fleet', label: 'Agents', window: '7d', target: 'agents', region: 'agents', source: 'agents', notes: [] };
  const pending = buildPendingStat(base, agentsState);
  if (pending) return pending;
  const breaker = getBreakerCounts(agentsState.data);
  if (!breaker) {
    return { ...base, status: 'unavailable', tone: 'neutral', value: null, absent: 'not-loaded', context: 'Suspension state unavailable.' };
  }
  const { suspended, streak } = breaker;
  const tone = suspended > 0 ? 'crit' : streak > 0 ? 'warn' : 'ok';
  const meta = agentsState.data.meta;
  const notes = [describeFleetReach(Number(meta.total_agents), Number(meta.circuit_breaker.registry_agents)), describeBusiestAgent(agentsState.data.agents?.[0])];
  return {
    // a suspension trips the value → the line stays empty; a streak alone trips the line, which names it
    ...base, status: 'ready', tone, value: formatInt(suspended), unit: 'suspended', context: tone === 'crit' ? null : describeStreak(streak),
    isContextTripped: tone === 'warn',
    notes: notes.filter(Boolean),
  };
}

// an unloaded breaker → null, never a zero suspended
function getBreakerCounts(data) {
  const breaker = data?.meta?.circuit_breaker;
  const suspended = Number(breaker?.suspended_count);
  const streak = Number(breaker?.streak_count);
  if (breaker?.source !== 'loaded' || !Number.isFinite(suspended) || !Number.isFinite(streak)) return null;
  return { suspended, streak };
}

function describeFleetReach(agentCount, registryCount) {
  if (!Number.isFinite(agentCount)) return null;
  const of = Number.isFinite(registryCount) && registryCount > 0 ? ` of ${formatInt(registryCount)} registered` : '';
  return `${formatInt(agentCount)}${of} agents had a run in the last 7 days.`;
}

// the region reads order=runs&limit=1 → its one row is the busiest agent of the window
function describeBusiestAgent(row) {
  const runs = Number(row?.runs);
  if (!row || !Number.isFinite(runs)) return null;
  return `Most runs: ${row.agent_name ?? row.agent_id}, ${formatInt(runs)}.`;
}

// stat 4 — spend today. tone comes from the pace verdict alone (an amount is no severity); the multiple is the alarm row's
function buildSpendStat(costState, harness) {
  const base = { id: 'spend', label: 'Spend today', target: 'cost', region: 'cost', source: "today's spend", notes: [] };
  const pending = buildPendingStat(base, costState);
  if (pending) return pending;

  const pace = resolveSpendPace(costState);
  const tone = { hot: 'warn', normal: 'ok' }[pace.status] ?? 'neutral';
  const note = pace.status === 'no-basis'
    ? 'No spend in the last 7 days — no baseline to judge the pace against.'
    : `Alarms when today's spend so far, or the last 3 hours' rate held for a day, reaches ${SPEND_PACE_CUT}× the 7-day average (${formatUsdCompact(pace.basis)}/day).`;
  // a hot day trips the value → the alarm row holds the one baseline
  const context = tone === 'warn' ? null : describeSpendTrend(harness);
  return { ...base, status: 'ready', tone, value: formatUsdCompact(pace.today), context, notes: [note] };
}

// day-over-day from one payload (the shell's /api/dashboard/kpi) → today and its comparand never mix sources
// the shell settles every harness source in one read → a null kpi beside a failed read is the kpi read's own failure
function describeSpendTrend(harness) {
  const kpi = harness?.kpi;
  if (kpi == null) {
    return harness?.error != null ? "Change on yesterday unavailable — couldn't read yesterday's spend" : 'Change on yesterday not read yet';
  }
  const prior = Number(kpi.yesterday_same_time_cost_usd);
  if (kpi.today_cost_usd == null || kpi.yesterday_same_time_cost_usd == null) return 'Change on yesterday unavailable — the reading carries no spend';
  if (!(prior > 0)) return 'No spend yesterday by this time to compare against';
  const ratio = Number(kpi.today_cost_usd) / prior;
  const change = (ratio - 1) * 100;
  const comparand = `${formatUsdCompact(prior)} yesterday by this time`;
  if (change === 0) return `Level with ${comparand}`;
  // a rise of 100% or more is a multiple (spec 44084 §2.1) → no three-digit percentage
  if (ratio >= 2) return `${ratio.toFixed(1)}\u00d7 yesterday by this time (${formatUsdCompact(prior)})`;
  return `${change > 0 ? 'Up' : 'Down'} ${window.UI.formatPct(Math.abs(change))} on ${comparand}`;
}

// amount first (spec 44084 §3.4) — the verdict trips on the larger of so-far and pace → the title names that leg,
// the detail its multiple of the 7-day average
function describeSpendAlarm(spend) {
  const { formatSpendSoFar, formatSpendMultiple } = window.UI;
  const soFar = formatSpendSoFar(spend.today);
  const isPaceLed = spend.pace >= spend.today;
  const judged = isPaceLed ? spend.pace : spend.today;
  return {
    title: isPaceLed ? `${soFar}, running at ${formatUsdCompact(spend.pace)}/day over the last 3 hours` : soFar,
    detail: formatSpendMultiple(judged / spend.basis, spend.basis),
  };
}

// 헤더 우측 중립 텍스트 — 설치 버전. 조치 신호는 레인이 운반하므로 여기는 톤이 없다.
// a pending read names no version → the freshness stamp beside it already says loading
function describeVersion(harness) {
  if (harness?.status === 'loading') return null;
  return harness && harness.version ? `v${harness.version}` : 'version unknown';
}

// wave regions + the shell harness — update-job polls on its own, so it stays out and never moves the stamp
// the stamp also answers for the harness stat → a pending harness read keeps it busy, a failed one keeps it off Fresh
function getFreshnessInputD(settledAt, waveStates, harness) {
  return { at: settledAt, regions: [...waveStates, toHarnessRegion(harness)] };
}

// the shell fold carries no busy flag → its read in flight is status 'loading'
function toHarnessRegion(harness) {
  if (!harness) return null;
  return { status: harness.status, busy: harness.status === 'loading', error: harness.error ?? null };
}

// same payload and same writer rule as the Task results stat → the panel's failed + blocked is the stat's breakage
// known results always get a row, zero included → an absent Failed reads as none, not as missing
function buildResultPanel(data) {
  const byResult = new Map((data?.by_result ?? []).map((row) => [row.result, row]));
  const order = Object.keys(window.UI.RESULT_META);
  const results = [...order, ...[...byResult.keys()].filter((result) => !order.includes(result))];
  const rows = results.map((result) => ({ result, count: window.UI.getWriterCount(byResult.get(result)) }));
  const start = data?.prior_window?.period_end;
  return {
    rows, writerTotal: window.UI.getWriterTotal(data), agents: getBreakageAgents(data?.by_agent_result),
    span: start ? `${formatDay(start)} – today` : 'Last 7 days and today',
  };
}

const BREAKAGE = { RESULTS: ['fail', 'blocked'], AGENT_LIMIT: 3 };

// per (agent, result) row under the stat's writer rule → each agent's failed + blocked, worst first
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
    folds: rows.filter((row) => row.fold), dateCount: dates?.count ?? null,
    span: dates ? `${formatDay(dates.first)} – today` : 'Last 7 days',
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

// the route ends the series on its bucket-timezone today → the last point is still accruing
function buildSpendStrip(points) {
  const series = points ?? [];
  const bars = series.map((point, i) => ({ date: point.date, cost: Number(point.cost_usd) || 0, isPartial: i === series.length - 1 }));
  if (bars.length === 0) return { bars, span: null };
  const last = bars[bars.length - 1];
  return { bars, span: `${formatDay(bars[0].date)} – ${last.isPartial ? 'today' : formatDay(last.date)}` };
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
