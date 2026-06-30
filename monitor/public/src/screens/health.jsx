// Screen — System Health (live data via /api/health/*)
//   카드: KPI×3 / HealthCardGrid (PG + daemon 3 + hook) / Payload / HookFailure.
//   Registers as window.ScreenHealth.
const {
  useState: useStateH,
  useEffect: useEffectH,
  useRef: useRefH,
  useCallback: useCallbackH,
  useMemo: useMemoH,
} = React;

const INITIAL_FETCH_STATE = { status: 'loading', data: null, error: null };

function ScreenHealth() {
  const { Icon, PageHeader, TypeScaleStyle } = window.UI;

  const [daemonState, setDaemonState] = useStateH(INITIAL_FETCH_STATE);
  const [hookState,   setHookState]   = useStateH(INITIAL_FETCH_STATE);
  // PG liveness probe — `db: open|closed` 로 PG 카드 상태 결정.
  const [pgState,     setPgState]     = useStateH(INITIAL_FETCH_STATE);
  // 데몬 실행 페이로드 (per-cycle 드릴다운) — 선택 데몬의 최근 실행 payload(JSONB).
  const [payloadState, setPayloadState]   = useStateH(INITIAL_FETCH_STATE);
  // 훅 실패 로그 (전 훅 raw) — 최근 N일 실패 이벤트.
  const [hookFailState, setHookFailState] = useStateH(INITIAL_FETCH_STATE);

  // 페이로드 드릴다운 대상 데몬 — PAYLOAD_DAEMON_OPTIONS (payload 기록 데몬 autoagent/wiki).
  const [payloadDaemon, setPayloadDaemon] = useStateH('autoagent');

  const [refreshTick, setRefreshTick] = useStateH(0);

  // AbortController per fetch wave — cancels in-flight requests on unmount/refetch.
  const abortRef = useRefH(null);

  const triggerRefresh = useCallbackH(() => setRefreshTick((t) => t + 1), []);

  // 5 parallel fetches (fire-and-forget). payloadDaemon 변경 시에도 재발화 (선택 데몬 드릴다운).
  useEffectH(() => {
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;

    const fetches = [
      ['/api/health/daemons',                                       setDaemonState],
      ['/api/health/hook-chain',                                    setHookState],
      ['/api/health',                                               setPgState],
      [`/api/health/daemon-payload?daemon=${payloadDaemon}&limit=10`, setPayloadState],
      ['/api/health/hook-failures?days=30&limit=50',               setHookFailState],
    ];

    fetches.forEach(([url, setter]) => {
      setter(INITIAL_FETCH_STATE);
      fetchJsonH(url, ctrl.signal)
        .then((data) => setter({ status: 'ready', data, error: null }))
        .catch((err) => handleErrorH(err, setter));
    });

    return () => ctrl.abort();
  }, [refreshTick, payloadDaemon]);

  // 60s 자동 새로고침 — health 는 장애 대응 화면 (F07/A4).
  useEffectH(() => {
    const intervalId = setInterval(() => setRefreshTick((t) => t + 1), 60_000);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* 공유 타입스케일(.fs-* / --fs-*) 마운트 — health 화면 ad-hoc 폰트 토큰화 소비처. */}
      <TypeScaleStyle/>
      <style>{`
        @keyframes skelPulseH { 0%,100%{opacity:.7} 50%{opacity:.35} }
        .h-card-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
        /* 레이아웃 안정 — 컴포넌트 카드 이름 1줄 클램프 + 높이 예약 (긴 식별자 래핑 시 카드 높이 점프 차단). */
        .h-card-name { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; min-height: calc(var(--fs-title) * 1.4); line-height: 1.4; word-break: break-all; }
        /* 카드 note(주기/버전) 1줄 클램프 + 높이 예약 — 미수신/긴 문자열 시 metric 그리드 밀림 방지. */
        .h-card-note { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; min-height: calc(var(--fs-meta) * 1.4); line-height: 1.4; word-break: break-all; }
      `}</style>

      <PageHeader
        title="System health"
        sub="Daemon & system health"
        right={
          <button className="btn ghost sm" onClick={triggerRefresh} aria-label="Refresh system health">
            <Icon name="refresh" size={14}/>
            Refresh
          </button>
        }
      />

      {/* KPI×3 — 컴포넌트 카드 facts 와 동일 출처 집계 (window.HealthModel) */}
      <HealthOverviewKpiRow
        daemonState={daemonState}
        pgState={pgState}
        hookState={hookState}
        hookFailState={hookFailState}
      />

      {/* 컴포넌트 헬스 카드 그리드 — lg 3-col / md 2-col 반응형 */}
      <HealthCardGrid
        daemonState={daemonState}
        pgState={pgState}
        hookState={hookState}
        hookFailState={hookFailState}
        onRetry={triggerRefresh}
      />

      {/* 데몬 실행 페이로드 드릴다운 — 선택 데몬의 최근 실행 payload(JSONB) collapsible */}
      <DaemonPayloadCard
        state={payloadState}
        daemon={payloadDaemon}
        onChangeDaemon={setPayloadDaemon}
        onRetry={triggerRefresh}
      />

      {/* 훅 실패 로그 — 전 훅 raw 실패 이벤트 테이블, error_kind 듀얼인코딩 */}
      <HookFailureCard state={hookFailState} onRetry={triggerRefresh}/>
    </div>
  );
}

// HealthOverviewKpiRow (KPI ×3) — 카드 facts 단일 출처 집계 (window.HealthModel).
// 분모 불변식: okCount + degradedCount + infoCount === totalCount === ready 카드 수 (F02).

function HealthOverviewKpiRow({ daemonState, pgState, hookState, hookFailState }) {
  const { KPI } = window.UI;

  // KPI 집계 — daemon ready 아닐 때는 모두 '—' 표시 (가짜 0 금지).
  const kpis = useMemoH(
    () => window.HealthModel.computeOverviewKpis({ daemonState, pgState, hookState, hookFailState }),
    [daemonState, pgState, hookState, hookFailState],
  );

  // 정보 버킷(info+neutral — 미수신/미검증/한도) 공개 — 정상도 장애도 아닌 카드의 분모 귀속 명시.
  const liveHint = kpis.totalCount === '—'
    ? ''
    : (kpis.infoCount > 0 ? `${kpis.infoCount} informational` : '');

  // 좁은 뷰포트 1열 적층 반응형.
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <KPI
        label="Healthy parts"
        value={kpis.okCount}
        unit={kpis.okCount === '—' ? '' : `/${kpis.totalCount}`}
        hint={liveHint}
      />
      <KPI
        label="Needs attention"
        value={kpis.degradedCount}
      />
      <KPI
        label="Overdue jobs"
        value={kpis.staleCount}
      />
    </div>
  );
}

// daemon 운영 주기 노트 — 서버 expected_next_at 에서 KST 일정으로 파생 (cron 변경 시 드리프트 방지).
function daemonScheduleNoteH(expectedNextAt) {
  if (!expectedNextAt) return 'no schedule set';
  const kst = formatDailyKstH(expectedNextAt);
  return kst ? `daily at ${kst} ${window.UI.tzShortLabel()}` : 'no schedule set';
}

// 카드 tone → 정렬 우선순위 (작을수록 먼저) — CRIT 최우선 노출 (T-HLT-2).
// 미해결(loading/error)·정보 톤은 OK 뒤로 — 위험 신호가 항상 좌상단.
const HEALTH_TONE_RANK = { crit: 0, warn: 1, ok: 2, neutral: 3, info: 4 };

// def 별 정렬 tone 산출 — ready 카드는 facts.tone, 미해결 카드는 'info' 로 후순위.
// 동률은 HEALTH_CARD_DEFS 원래 순서 유지 (안정 정렬).
function cardSortToneH(def, states) {
  const facts = window.HealthModel.resolveCardFacts(def, states);
  return facts.status === 'ready' ? facts.tone : 'info';
}

// HealthCardGrid — 컴포넌트 카드: PG / browser / daemon×4 / hook-chain (정의 SoT = window.HealthModel).
function HealthCardGrid({ daemonState, pgState, hookState, hookFailState, onRetry }) {
  const states = { daemonState, pgState, hookState, hookFailState };

  // CRIT→WARN→OK 정렬 (T-HLT-2) — index 보존 안정 정렬 (동률 시 원래 순서).
  const orderedDefs = useMemoH(() => {
    return window.HealthModel.HEALTH_CARD_DEFS
      .map((def, i) => ({ def, i, rank: HEALTH_TONE_RANK[cardSortToneH(def, states)] ?? 5 }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((x) => x.def);
  }, [daemonState, pgState, hookState, hookFailState]);

  // 반응형 그리드: lg 3-col / md 2-col / mobile 1-col.
  return (
    <div className="health-card-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {orderedDefs.map((def) => (
        <HealthComponentCard
          key={def.id}
          def={def}
          daemonState={daemonState}
          pgState={pgState}
          hookState={hookState}
          hookFailState={hookFailState}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

function HealthComponentCard({ def, daemonState, pgState, hookState, hookFailState, onRetry }) {
  const { Icon, Badge } = window.UI;

  // 라이브 ready 일 때만 metric 값 노출 — 그 외 '—' (가짜 latency/uptime 금지).
  const card = useMemoH(() => buildHealthCardModel(def, { daemonState, pgState, hookState, hookFailState }),
    [def, daemonState, pgState, hookState, hookFailState]);

  if (card.status === 'loading') {
    return <DaemonSkeleton/>;
  }
  if (card.status === 'error') {
    return (
      <div className="card">
        <div className="card-body">
          <ErrorBannerH title={`Couldn't load ${def.name} status`} detail={card.error} onRetry={onRetry}/>
        </div>
      </div>
    );
  }

  // WARN/CRIT 만 좌측 2px 강조 (S5 — OK/info 중립, 전체 행 flood 금지). 색만 아닌 tone-glyph Badge 동반.
  const accent = card.tone === 'warn' || card.tone === 'crit';

  return (
    <div
      className="card overflow-hidden"
      role="group"
      aria-label={`${def.name} status ${card.statusLabel}`}>
      <div className="flex">
        {accent && <span className={`sev-bar ${card.tone}`} aria-hidden="true"/>}
        <div className="card-body flex-1 min-w-0">
        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-md grid place-items-center bg-sunken text-${card.tone === 'ok' ? 'dim' : card.tone}`}>
            <Icon name={def.icon} size={16}/>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-2 flex-wrap">
              {/* 1줄 클램프+높이예약 — 긴 식별자 카드 높이 점프 차단. */}
              <span className="fs-title font-medium h-card-name min-w-0 flex-1" title={def.name}>{def.name}</span>
              {/* 상태 Badge(status, 선행 TONE_GLYPH) + (autoagent 한정) 비용가드 칩 — 제목 우측 동일 행 묶음. */}
              <span className="ml-auto flex items-center gap-2">
                <Badge role="status" tone={card.tone}>{card.pillLabel}</Badge>
                {card.costGuard && (
                  /* costGuard 는 자체 symbol 보유 → glyph=false (이중 글리프 방지) · title prop 미전달 → tooltip 은 wrapper span 바인딩. */
                  <span title={card.costGuard.titleHint}>
                    <Badge role="status" tone={card.costGuard.tone} glyph={false}>{card.costGuard.symbol} {card.costGuard.prefix}{card.costGuard.label}</Badge>
                  </span>
                )}
              </span>
            </div>
            {/* note 1줄 클램프+높이예약 — 미수신/긴 일정 문자열 시 그리드 밀림 방지. */}
            <div className="fs-meta font-mono text-faint mt-0.5 h-card-note" title={card.note}>{card.note}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-line">
          <div>
            <div className="fs-micro font-mono text-faint uppercase tracking-wider truncate" title={card.metricLabel}>{card.metricLabel}</div>
            <div className="fs-title font-mono font-medium mt-0.5 truncate" title={String(card.metricValue)}>{card.metricValue}</div>
          </div>
          <div>
            <div className="fs-micro font-mono text-faint uppercase tracking-wider truncate" title={card.subMetricLabel}>{card.subMetricLabel}</div>
            <div className="fs-title font-mono font-medium mt-0.5 truncate" title={String(card.subMetricValue)}>{card.subMetricValue}</div>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

// 카드 데이터 모델 빌더 — facts(tone/stale 판정 = window.HealthModel 단일 출처) 위에 표시 문자열만 부착.
// 라이브 데이터 부재 시 metric 은 '—'.
function buildHealthCardModel(def, states) {
  const facts = window.HealthModel.resolveCardFacts(def, states);
  if (facts.status !== 'ready') return { status: facts.status, error: facts.error };
  const builder = CARD_MODEL_BUILDERS[def.kind];
  if (!builder) return { status: 'error', error: `unknown kind: ${def.kind}` };
  return builder(def, facts, states);
}

const CARD_MODEL_BUILDERS = {
  pg(_def, facts, { pgState }) {
    return {
      status: 'ready',
      tone:           facts.tone,
      pillLabel:      facts.pgOk ? 'OPEN' : 'CLOSED',
      statusLabel:    facts.pgOk ? 'Connected' : 'Disconnected',
      // version 필드 = 모니터 앱 버전 — PG server_version 아님 (오인 차단).
      note:           `monitor app version ${pgState.data?.version || '—'}`,
      metricLabel:    'Connection',
      metricValue:    pgState.data?.db || '—',
      subMetricLabel: 'API status',
      subMetricValue: pgState.data?.status || '—',
    };
  },

  // Chromium export 렌더러 — /api/health `browser` 필드 (boot probe + 실제 launch 가 갱신).
  // failed = playwright 업그레이드 후 바이너리 드리프트 등 launch 불가 → HTML export 전건 실패 상태.
  browser(_def, facts, { pgState }) {
    const launch = facts.launch;
    return {
      status: 'ready',
      tone:           facts.tone,
      pillLabel:      launch.toUpperCase(),
      statusLabel:    launch === 'ok' ? 'Healthy' : (launch === 'failed' ? 'Failed to start' : 'Unverified'),
      note:           launch === 'failed'
        ? (pgState.data?.browser_reason || 'launch failed')
        : '',
      metricLabel:    'launch',
      metricValue:    launch,
      subMetricLabel: 'Checked at',
      subMetricValue: formatTimeShortH(pgState.data?.browser_checked_at),
    };
  },

  daemon(_def, facts) {
    const d = facts.daemon;
    if (!d) {
      return {
        status: 'ready',
        tone:           facts.tone,
        pillLabel:      'NO DATA',
        statusLabel:    'No data',
        note:           'never reported',
        metricLabel:    'Last run', metricValue:    '—',
        subMetricLabel: 'Next due', subMetricValue: '—',
      };
    }
    const meta = window.HealthModel.resolveDaemonDisplayMeta(d);
    return {
      status: 'ready',
      tone:           facts.tone,
      pillLabel:      meta.label,
      statusLabel:    meta.label,
      note:           daemonScheduleNoteH(d.expected_next_at),
      // 비용가드 라이브 신호 — autoagent 만 반환, 타 데몬은 null → 칩 미렌더 (가짜 'ok' 금지).
      costGuard:      costGuardModelH(d.cost_guard_state),
      metricLabel:    'Last run',
      metricValue:    d.last_run_at ? formatTimeShortH(d.last_run_at) : '—',
      subMetricLabel: 'STALENESS',
      subMetricValue: typeof d.staleness_minutes === 'number' ? formatStaleness(d.staleness_minutes) : '—',
    };
  },

  // 주 metric = core.hook_failures 24h recency (F08) · 설정 인벤토리는 sub-metric 강등.
  hook(_def, facts, { hookState }) {
    const totalHooks = facts.events.reduce(
      (sum, ev) => sum + (ev.groups || []).reduce((s, g) => s + (g.hooks?.length || 0), 0),
      0,
    );
    let pillLabel;
    let statusLabel;
    if (facts.tone === 'crit')      { pillLabel = 'FAILED'; statusLabel = 'Failed in 24 h (not retried)'; }
    else if (facts.tone === 'warn') { pillLabel = 'WARN';   statusLabel = 'Failed in 24 h (retried)'; }
    else if (!facts.configured)     { pillLabel = 'NOT SET UP'; statusLabel = 'Not set up'; }
    else                            { pillLabel = 'ACTIVE'; statusLabel = 'Active'; }

    const failKnown = facts.count24h !== null;
    const unretriedSuffix = facts.unretried24h > 0 ? ` · ${facts.unretried24h} not retried` : '';
    return {
      status: 'ready',
      tone:           facts.tone,
      pillLabel,
      statusLabel,
      note:           `settings.json ${hookState.data?.source_mtime ? formatTimeShortH(hookState.data.source_mtime) : '—'}`,
      metricLabel:    'Failures, 24 h',
      metricValue:    failKnown ? `${facts.count24h}${unretriedSuffix}` : '—',
      subMetricLabel: 'Configured',
      subMetricValue: `${facts.events.length} event types · ${totalHooks} hooks`,
    };
  },
};

function DaemonSkeleton() {
  return (
    <div className="card">
      <div className="card-body">
        <div className="flex items-start gap-3">
          <SkelH w={36} h={36}/>
          <div className="flex-1">
            <SkelH w="60%" h={14} style={{ marginBottom: 8 }}/>
            <SkelH w="40%" h={11}/>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-line">
          <div>
            <SkelH w="50%" h={10} style={{ marginBottom: 6 }}/>
            <SkelH w="80%" h={14}/>
          </div>
          <div>
            <SkelH w="50%" h={10} style={{ marginBottom: 6 }}/>
            <SkelH w="80%" h={14}/>
          </div>
        </div>
      </div>
    </div>
  );
}

// 데몬 페이로드 드릴다운 카드 (per-cycle JSONB 페이로드).
// 소스: /api/health/daemon-payload?daemon=&limit=10 — 선택 데몬의 최근 실행 payload(가변 키 JSONB).
// 데몬별 키 상이 → collapsible <details> 로 동적 키 렌더 (payload_size_bytes 로 무게 표시).

// 페이로드 드릴다운 대상 데몬 — payload 를 실제로 기록하는 autoagent/wiki 2종.
// daily-restart-* 및 레거시 merged 'daily-restart' 는 run *status* 만 남기고 payload 를 쓰지 않아 항상 빈 entries → 옵션 제외.
// (server allowlist 는 과거 payload 행 정합 유지를 위해 그대로 둠 / daemon_runs status 추적도 별도 유지.)
const PAYLOAD_DAEMON_OPTIONS = [
  { value: 'autoagent', label: 'autoagent' },
  { value: 'wiki',      label: 'wiki' },
];

function DaemonPayloadCard({ state, daemon, onChangeDaemon, onRetry }) {
  const { CardHead } = window.UI;

  const entryCount = state.status === 'ready' ? (state.data?.entries || []).length : null;

  return (
    <div className="card h-full flex flex-col min-h-0">
      <CardHead
        title="Job run details"
        sub={entryCount === null ? null : `Last ${entryCount} runs`}
        right={
          <div className="seg" role="group" aria-label="Select job for payload">
            {PAYLOAD_DAEMON_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={daemon === opt.value ? 'active' : ''}
                aria-pressed={daemon === opt.value}
                onClick={() => onChangeDaemon(opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>
        }
      />
      <div className="card-body h-card-body">
        <DaemonPayloadBody state={state} daemon={daemon} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function DaemonPayloadBody({ state, daemon, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonH height={180}/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerH title="Couldn't load job payloads" detail={state.error} onRetry={onRetry}/>;
  }
  const entries = state.data?.entries || [];
  if (entries.length === 0) {
    return <EmptyStateH message={`No recent run payloads for ${daemon}.`}/>;
  }

  // 사이클별 collapsible 카드 — run_date + payload_size_bytes 헤더, 펼치면 동적 키 + JSON.
  // 전부 기본 접힘 — raw JSON 은 디버그 데이터라 항상 펼침이 아니라 필요 시 펼치는 on-demand 면.
  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry, i) => (
        <DaemonPayloadEntry key={`${entry.run_date}-${i}`} entry={entry}/>
      ))}
    </div>
  );
}

function DaemonPayloadEntry({ entry }) {
  const payload = entry?.payload && typeof entry.payload === 'object' ? entry.payload : {};
  const keys = Object.keys(payload);
  const sizeLabel = formatBytesH(entry?.payload_size_bytes);

  return (
    <details className="rounded-md border border-line bg-sunken">
      <summary className="cursor-pointer select-none px-3 py-2 flex items-center gap-2 flex-wrap">
        {/* 12px→fs-body(12) run_date · 10.5px→fs-meta(11) 키수/크기. */}
        <span className="font-mono fs-body text-ink font-medium">{entry?.run_date || '—'}</span>
        <span className="font-mono fs-meta text-faint">{keys.length} fields</span>
        <span className="ml-auto font-mono fs-meta text-dim">{sizeLabel}</span>
      </summary>
      <div className="px-3 pb-3">
        {/* 10.5px→fs-meta(11) 빈 페이로드/JSON pre. */}
        {keys.length === 0
          ? <div className="fs-meta font-mono text-faint">Empty payload</div>
          : <pre className="fs-meta font-mono text-dim whitespace-pre-wrap break-words m-0 max-h-64 overflow-y-auto">{stringifyPayloadH(payload)}</pre>}
      </div>
    </details>
  );
}

// payload_size_bytes → human-readable; 숫자 아님/음수 → '—'. B/KB 환산만 (페이로드 ≤수십 KB).
function formatBytesH(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// JSONB 페이로드 직렬화 — 순환참조/직렬화 불가 시 안전 폴백 (raw render 깨짐 방지).
function stringifyPayloadH(payload) {
  try {
    return JSON.stringify(payload, null, 2);
  } catch (_e) {
    return '[unreadable data]';
  }
}

// 훅 실패 로그 카드 (전 훅 raw 실패 이벤트).
// 소스: /api/health/hook-failures?days=30&limit=50 — 전 훅 실패 로그 (failure_ts KST 표시).
// error_kind 듀얼인코딩(심볼+색) — 색상만으로 실패 종류 구분 금지 (색맹 안전).

// error_kind → 듀얼인코딩 톤/심볼/라벨. 미정의 종류 → unknown 폴백 (가짜 'ok' 금지).
const HOOK_ERROR_KIND_MODEL = {
  connection_refused:   { tone: 'crit',    symbol: '✕', label: 'Connection refused' },
  timeout:              { tone: 'warn',    symbol: '⚠', label: 'Timed out' },
  constraint_violation: { tone: 'warn',    symbol: '⚠', label: 'Data conflict' },
  unknown:              { tone: 'neutral', symbol: '·', label: 'Unknown' },
};
function hookErrorKindModelH(kind) {
  return HOOK_ERROR_KIND_MODEL[kind] || { tone: 'info', symbol: 'ℹ', label: String(kind || '—') };
}

// 동일 실패(hook+table+error_kind+retry) 그룹핑 — 입력 순서(시간 역순) 보존, 첫 등장이 대표 행.
// count = 그룹 전건 수 → "and N similar" 표기 근거 (T-HLT-3). 입력 비배열/null 안전.
function consolidateHookFailuresH(failures) {
  const order = [];
  const byKey = new Map();
  for (const f of failures || []) {
    const key = `${f.hook_name}|${f.target_table}|${f.error_kind}|${f.retry_attempted ? 1 : 0}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      const group = { key, rep: f, count: 1 };
      byKey.set(key, group);
      order.push(group);
    }
  }
  return order;
}

function HookFailureCard({ state, onRetry }) {
  const { CardHead } = window.UI;

  const failCount = state.status === 'ready' ? (state.data?.failures || []).length : null;
  const days = state.status === 'ready' ? state.data?.days : null;

  return (
    <div className="card h-full flex flex-col min-h-0">
      <CardHead
        title="Hook failures"
        sub={failCount === null ? null : `Last ${days ?? 30} days · ${failCount} failures`}
        right={null}
      />
      <div className="card-body h-card-body">
        <HookFailureBody state={state} onRetry={onRetry}/>
      </div>
    </div>
  );
}

function HookFailureBody({ state, onRetry }) {
  if (state.status === 'loading') {
    return <ChartSkeletonH height={180}/>;
  }
  if (state.status === 'error') {
    return <ErrorBannerH title="Couldn't load hook failures" detail={state.error} onRetry={onRetry}/>;
  }
  const failures = state.data?.failures || [];
  if (failures.length === 0) {
    return <EmptyStateH message="No hook failures in this period."/>;
  }

  // 동일 (hook + table + error_kind + retry) 실패를 1행으로 접고 "and N similar" 로 표기 (T-HLT-3).
  // 대표 행 = 최신 failure_ts (입력이 시간 역순이면 첫 등장) · count 는 그룹 전건 수.
  const groups = consolidateHookFailuresH(failures);

  // 테이블 5 컬럼: 시각(KST) / hook / table / error_kind(듀얼인코딩) / retry (D8 ≤5 컬럼).
  return (
    <div className="overflow-x-auto">
      {/* 본문 fs-body(12) text-dim — 읽기용 데이터라 AA-clean(--dim) · py-2 행높이 (이전 py-1.5 대비 여유). */}
      <table className="w-full fs-body font-mono border-collapse">
        <thead>
          <tr className="text-dim text-left border-b border-line">
            <th className="py-2 pr-2 font-medium">Time ({window.UI.tzShortLabel()})</th>
            <th className="py-2 px-2 font-medium">hook</th>
            <th className="py-2 px-2 font-medium">table</th>
            <th className="py-2 px-2 font-medium">error_kind</th>
            <th className="py-2 pl-2 font-medium text-center">retry</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const f = g.rep;
            const kind = hookErrorKindModelH(f.error_kind);
            const extra = g.count - 1;
            return (
              <tr key={g.key} className="border-b border-line/40">
                <td className="py-2 pr-2 text-dim whitespace-nowrap">
                  {formatTimeKstH(f.failure_ts)}
                  {extra > 0 && <span className="fs-meta text-faint ml-1">and {extra} similar</span>}
                </td>
                <td className="py-2 px-2 text-ink truncate max-w-[120px]" title={f.hook_name}>{f.hook_name}</td>
                <td className="py-2 px-2 text-dim truncate max-w-[140px]" title={f.target_table}>{f.target_table}</td>
                <td className={`py-2 px-2 whitespace-nowrap text-${kind.tone === 'ok' ? 'dim' : kind.tone}`}
                  title={f.error_kind}>
                  {kind.symbol} {kind.label}
                </td>
                <td className="py-2 pl-2 text-center text-dim">{f.retry_attempted ? '↻' : '·'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="fs-micro font-mono text-faint mt-2 leading-tight">
        retry: ↻ retried
      </div>
    </div>
  );
}

// ISO 타임스탬프(UTC) → 표시 tz MM/DD HH:MM 문자열 — 훅 실패 시각 표시용.
// 서버 failure_ts 는 UTC(Z) → timeZone 옵션(config 시드 표시 tz)으로 환산. 파싱불가 → '—'.
function formatTimeKstH(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ko-KR', {
      timeZone: window.UI.getDisplayTimezone(),
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch (_e) {
    return '—';
  }
}

function EmptyStateH({ message }) {
  // m-3 외곽 여백 — .card-body flush 안 점선 보더가 카드 외곽선에 붙는 문제 해소.
  return <div className="placeholder m-3" style={{ padding: 20 }}>{message}</div>;
}

function ErrorBannerH({ title, detail, onRetry }) {
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
        {/* 12.5px→fs-title(13) 에러 제목 · 11px→fs-meta(11) 상세. */}
        <div className="fs-title font-medium text-ink">{title}</div>
        {detail && <div className="fs-meta font-mono text-dim mt-1 truncate" title={window.UI.titleOf(detail)}>{detail}</div>}
      </div>
      {onRetry && <button className="btn sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

function ChartSkeletonH({ height = 220 }) {
  return (
    <div
      aria-busy="true"
      style={{
        width: '100%',
        height,
        borderRadius: 8,
        background: 'rgb(var(--sunken))',
        opacity: 0.7,
        animation: 'skelPulseH 1.4s ease-in-out infinite',
      }}
    />
  );
}

function SkelH({ w = '100%', h = 14, style }) {
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
        animation: 'skelPulseH 1.4s ease-in-out infinite',
        ...style,
      }}
    />
  );
}

async function fetchJsonH(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_e) { /* ignore body parse failure */ }
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 120) : ''}`);
  }
  return res.json();
}

function handleErrorH(err, setter) {
  // AbortError = filter change / unmount; not a user-visible failure.
  if (err && err.name === 'AbortError') return;
  setter({ status: 'error', data: null, error: err && err.message ? err.message : String(err) });
}

// cost_guard_state → 듀얼인코딩 칩 모델 (symbol + label + tone, 색맹 안전).
// null/미반환(autoagent 외 데몬) → null 반환 → 칩 미렌더 (가짜 'ok' 표시 금지).
// warn = Claude 사용 한도 감지 정보 신호 (차단 아님 · 시간 경과 시 회복) → 'neutral' 회색 (비차단 신호 과장 차단).
// prefix = 칩 라벨 접두 (data-driven) — spend 상태는 'Spending guard ', infra_fault 는 ''
//   (auth 결함은 usage/spend 가 아니므로 'Spending guard' 접두 금지 — 오분류 표시 차단).
const COST_GUARD_MODEL = {
  ok:             { tone: 'ok',      symbol: '✓', label: 'OK',            prefix: 'Spending guard ', titleHint: 'Spending guard OK' },
  warn:           { tone: 'neutral', symbol: 'ℹ', label: 'Limit notice',  prefix: 'Spending guard ', titleHint: 'Usage limit detected — not blocking, recovers with time' },
  block:          { tone: 'crit',    symbol: '✕', label: 'Blocked',       prefix: 'Spending guard ', titleHint: 'Spending guard blocked — runs stopped (spend ceiling reached)' },
  infra_fault:    { tone: 'crit',    symbol: '✕', label: 'Auth fault',    prefix: '',                titleHint: 'Auth fault — daemon login expired (HTTP 401 / credential), NOT a usage limit · re-auth required' },
  limited:        { tone: 'warn',    symbol: '⚠', label: 'Restricted',    prefix: 'Spending guard ', titleHint: 'Spending guard restricted — some work held back this run' },
  quota_exceeded: { tone: 'neutral', symbol: 'ℹ', label: 'Limit reached', prefix: 'Spending guard ', titleHint: 'Spending guard limit reached — not a fault (external usage cap · recovers with time)' },
  paused:         { tone: 'crit',    symbol: '✕', label: 'Paused',        prefix: 'Spending guard ', titleHint: 'Spending guard paused — runs temporarily stopped' },
};
function costGuardModelH(state) {
  if (state == null) return null;
  return COST_GUARD_MODEL[state] || { tone: 'info', symbol: 'ℹ', label: String(state), prefix: 'Spending guard ', titleHint: `Spending guard state: ${String(state)}` };
}

// UTC ISO 실순간(last_run_at·source_mtime·started_at) → KST "MM/DD HH:mm".
// 공용 포매터 window.UI.formatKstDateTime 위임 — 브라우저 로컬 tz 비의존 (전 표시시각 KST 단일화).
// 파싱불가/미수신 → '—' (공용 포매터가 iso||'—' 폴백 처리).
function formatTimeShortH(iso) {
  if (!iso) return '—';
  return window.UI.formatKstDateTime(iso);
}

// ISO 타임스탬프 → 표시 tz HH:MM 24시간 문자열 — daemon 일정 노트 파생용.
// 서버 응답이 UTC(Z)여도 timeZone 옵션(config 시드 표시 tz)으로 환산 (예: KST 19:30Z → 04:30).
function formatDailyKstH(iso) {
  try {
    return new Date(iso).toLocaleTimeString('ko-KR', {
      timeZone: window.UI.getDisplayTimezone(),
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch (_e) {
    return '';
  }
}

// staleness_minutes → human-readable; minutes/hours/days breakdown.
function formatStaleness(minutes) {
  if (minutes < 60)        return `${minutes}m`;
  if (minutes < 60 * 24)   return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  return `${days}d ${hours}h`;
}

window.ScreenHealth = ScreenHealth;
