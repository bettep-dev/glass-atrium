// Screen 01 — Dashboard: triage. 경보 레인(비면 아무것도 안 그림) + 4타일 상태 밴드가 전부.
// 추세·원장·분포는 각자 소유 화면으로 이관 — 여기는 "지금 나를 필요로 하는 일이 있나 ·
// 하네스는 건강한가"에만 답하고 나머지 질문은 링크로 넘긴다.
// harness 사실은 셸 fold(prop) 단일 출처 — 화면이 harness 스토어를 다시 읽지 않는다.
const { useState: useStateD, useEffect: useEffectD, useRef: useRefD, useCallback: useCallbackD } = React;

// 숫자 포맷 — ui.jsx 공용 SoT 소비 (ui.js 가 dashboard.js 보다 먼저 로드 → window.UI 가용).
const formatUsd = window.UI.formatUsd;
const formatInt = window.UI.formatInt;

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
// 라우트가 row 예약 시 넣는 자리표시자 미러 (routes/dashboard.ts PENDING_TARGET_VERSION) — 실제 릴리스 버전은
//   decoupled job 이 나중에 덮어쓴다. 버전 라벨로 렌더하면 'pending' 이라는 버전이 있는 것처럼 읽힌다.
const UPDATE_PENDING_VERSION = 'pending';

// 오늘 지출 경보 컷 — 7일 일평균(avg/day)의 1.25배. 규칙 소유는 Cost & usage 계획(clauded-docs/39582);
// 대시보드는 같은 /api/cost/kpi 를 읽어 그 판정을 소비만 한다 — 두 화면이 같은 분에 다른 답을 내면 안 된다.
const SPEND_PACE_CUT = 1.25;
const SPEND_BASELINE_DAYS = 7;

// severity 우선순위 — 레인 정렬 기준. 높을수록 위험.
const SEVERITY_RANK = { crit: 3, warn: 2, info: 1, neutral: 0 };

function ScreenDashboard({ onNav, harness }) {
  const { Icon, PageHeader, TypeScaleStyle } = window.UI;

  const [costState,      setCostState]      = useStateD(INITIAL_FETCH_STATE);
  const [agentsState,    setAgentsState]    = useStateD(INITIAL_FETCH_STATE);
  const [outcomesState,  setOutcomesState]  = useStateD(INITIAL_FETCH_STATE);
  const [updateState,    setUpdateState]    = useStateD(INITIAL_FETCH_STATE);
  const [updateJobState, setUpdateJobState] = useStateD(INITIAL_FETCH_STATE);

  const [refreshTick, setRefreshTick] = useStateD(0);
  // as-of 스탬프 — wave 가 정착한 시각. 화면 수치가 언제 것인지 없으면 stale 을 못 읽는다.
  const [settledAt, setSettledAt] = useStateD(null);

  // AbortController per fetch wave — unmount/refetch 시 in-flight 요청 취소.
  const abortRef = useRefD(null);

  const triggerRefresh = useCallbackD(() => setRefreshTick((t) => t + 1), []);

  // update-job 온디맨드 재조회 — UpdateBadge 의 poll interval + mutate 직후 즉시 상태 반영.
  //   메인 wave 와 독립(단건 GET, signal 불요 — AbortError 는 handleError 가 흡수).
  const refetchUpdateJob = useCallbackD(() => runFetch(UPDATE_JOB_ENDPOINT, undefined, setUpdateJobState), []);

  useEffectD(() => {
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;

    const setters = [setCostState, setAgentsState, setOutcomesState, setUpdateState, setUpdateJobState];
    setters.forEach((s) => s(INITIAL_FETCH_STATE));

    // harness 판독은 셸 fold 가 공급 — 여기서 재요청하지 않는다(풋터와 어긋나는 원인).
    // agents 는 meta 카운트만 필요 → limit=1 (최다 실행 1행)로 목록 전송량 최소화.
    Promise.allSettled([
      runFetch('/api/cost/kpi', ctrl.signal, setCostState),
      runFetch('/api/agents/summary?days=7&order=runs&limit=1', ctrl.signal, setAgentsState),
      runFetch('/api/outcomes/cross-analysis?days=7', ctrl.signal, setOutcomesState),
      runFetch(UPDATE_STATUS_ENDPOINT, ctrl.signal, setUpdateState),
      runFetch(UPDATE_JOB_ENDPOINT, ctrl.signal, setUpdateJobState),
    ]).then(() => {
      if (!ctrl.signal.aborted) setSettledAt(new Date().toISOString());
    });

    return () => ctrl.abort();
  }, [refreshTick]);

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

  const alarms = buildAlarms({ harness, costState, installKind });
  const tiles = buildTiles({ harness, costState, agentsState, outcomesState });

  return (
    <div className="flex flex-col">
      {/* 타입 스케일 토큰 (ui.jsx SoT) — 멱등 마운트. .fs-* 유틸 + --fs-* CSS var 공급. */}
      <TypeScaleStyle/>
      <style>{`
        @keyframes skelPulse { 0%,100%{opacity:.7} 50%{opacity:.35} }
        /* update 진행 스피너 — reduced-motion 은 회전 정지(정적 아이콘 + Badge/라벨이 상태 운반). */
        @keyframes ga-spin { to { transform: rotate(360deg); } }
        .ga-spin { animation: ga-spin 0.9s linear infinite; transform-origin: center; }
        @media (prefers-reduced-motion: reduce) { .ga-spin { animation: none; } }
        /* 레인 행 — 톤은 왼쪽 테두리 + 선행 글리프가 운반한다(문구에 색을 싣지 않음). */
        .dash-alarm { border-left-width: 3px; }
        /* 타일 1차 라벨/힌트 — 1줄 clamp + reserved 높이 → 폭이 줄어도 밴드 높이 불변. */
        .dash-tile-hint { min-height: calc(var(--fs-meta) * 1.4 * 2); line-height: 1.4; }
      `}</style>

      <div className="flex-shrink-0">
        <PageHeader
          sub="Triage"
          title="Dashboard"
          right={
            <>
              <span className="fs-meta font-mono text-dim">{describeStamp(harness, settledAt)}</span>
              <button className="btn ghost sm" onClick={triggerRefresh} aria-label="Refresh dashboard">
                <Icon name="refresh" size={14}/>
                Refresh
              </button>
            </>
          }
        />
      </div>

      <div className="space-sections">
        <AlarmLane
          alarms={alarms}
          onNav={onNav}
          updateState={updateState}
          updateJobState={updateJobState}
          onRefetchJob={refetchUpdateJob}
        />
        <StatusBand tiles={tiles} onNav={onNav} onRetry={triggerRefresh}/>
      </div>
    </div>
  );
}

// 경보 레인 — 아무것도 없으면 아무것도 그리지 않는다(빈 카드가 '이상 없음'보다 시끄럽다).
// 행 순서는 worst-first: 가장 위험한 사실이 첫 줄에 온다.
function AlarmLane({ alarms, onNav, updateState, updateJobState, onRefetchJob }) {
  if (alarms.length === 0) return null;
  return (
    <div role="list" aria-label="Alarms" className="flex flex-col gap-2">
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
function AlarmRow({ alarm, onNav, children }) {
  const { Icon } = window.UI;
  return (
    <div
      role="listitem"
      className="dash-alarm rounded-md p-3 flex items-center gap-3"
      style={{
        background: `rgb(var(--${alarm.tone}) / 0.08)`,
        borderColor: `rgb(var(--${alarm.tone}) / 0.5)`,
      }}>
      <Icon name={TONE_ICON_NAME[alarm.tone]} size={16} className={`text-${alarm.tone}`}/>
      <div className="flex-1 min-w-0">
        <div className="fs-body font-medium text-ink truncate" title={alarm.title}>{alarm.title}</div>
        {alarm.detail && (
          <div className="fs-meta font-mono text-dim truncate" title={alarm.detail}>{alarm.detail}</div>
        )}
      </div>
      {children}
      {alarm.target && (
        <button className="btn sm" onClick={() => onNav(alarm.target)}>
          {alarm.targetLabel}
          <window.UI.Icon name="arrow-right" size={14}/>
        </button>
      )}
    </div>
  );
}

// 상태 밴드 — 4타일 고정. 값 · 힌트 한 줄 · 소유 화면 링크.
function StatusBand({ tiles, onNav, onRetry }) {
  return (
    <div className="grid grid-cols-4 gap-card">
      {tiles.map((tile) => <StatusTile key={tile.id} tile={tile} onNav={onNav} onRetry={onRetry}/>)}
    </div>
  );
}

// 상태 4종이 서로 다르게 읽히는 지점 — loading(스켈레톤) · error(재시도) · unavailable/empty(중립 문구) · ready(값).
// 값 자리는 never 0-for-unknown: 미수신은 '—' 로 남는다.
function StatusTile({ tile, onNav, onRetry }) {
  const { Badge } = window.UI;
  return (
    <div className="card p-3 flex flex-col gap-1.5">
      <div className="fs-meta text-dim uppercase tracking-wide">{tile.label}</div>
      {tile.status === 'loading' ? (
        <Skel w={90} h={24}/>
      ) : (
        <div className="flex items-center gap-2">
          <span className="fs-h2 font-semibold text-ink">{tile.value}</span>
          {tile.tone !== 'neutral' && <Badge role="status" tone={tile.tone} icon>{TONE_WORD[tile.tone]}</Badge>}
        </div>
      )}
      <div className="fs-meta text-dim dash-tile-hint">{tile.hint}</div>
      {tile.status === 'error' ? (
        <button className="btn sm self-start" onClick={onRetry}>Retry</button>
      ) : (
        <button className="btn sm self-start" onClick={() => onNav(tile.target)}>
          {tile.targetLabel}
          <window.UI.Icon name="arrow-right" size={14}/>
        </button>
      )}
    </div>
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

// 톤 → Lucide 아이콘 이름. 색 단독 신호 금지 — 모양이 색과 함께 간다.
const TONE_ICON_NAME = { crit: 'x', warn: 'warn', info: 'info', ok: 'check', neutral: 'info' };
// 톤 → 배지 문구. 문구는 상태를 이름 짓고, 위험도는 톤이 운반한다.
const TONE_WORD = { crit: 'Down', warn: 'Attention', ok: 'Healthy', info: 'No data' };

// 레인 union — harness · fleet · spend · install 만 합친다. Learning/Wiki/Task-results/Models
// 경보는 각 화면의 nav 숫자가 운반하므로 여기서 합성하지 않는다(같은 사실 이중 신고 방지).
// fleet 정지(suspension) 행은 소스가 아직 없다 — 없는 사실을 지어내지 않고 타일 힌트로만 고지한다.
function buildAlarms({ harness, costState, installKind }) {
  const rows = [];

  if (harness && harness.status === 'ready' && harness.downNames.length > 0) {
    rows.push({
      id: 'harness',
      tone: 'crit',
      title: `${harness.downNames.length} harness ${harness.downNames.length === 1 ? 'part is' : 'parts are'} down`,
      detail: harness.downNames.join(' · '),
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
      detail: `${formatUsd(spend.today)} so far · ${formatUsd(spend.pace)}/day at the 3 h burn · ${formatUsd(spend.basis)} 7-day avg/day`,
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
function buildTiles({ harness, costState, agentsState, outcomesState }) {
  return [
    buildHarnessTile(harness),
    buildOutcomeTile(outcomesState),
    buildFleetTile(agentsState),
    buildSpendTile(costState),
  ];
}

// 타일 1 — 하네스 파트. 분모는 셸이 실제로 관측한 파트 수: 미관측 파트를 정상으로 세지 않는다.
function buildHarnessTile(harness) {
  const base = { id: 'harness', label: 'Harness health', target: 'architecture', targetLabel: 'System map' };
  if (!harness || harness.status !== 'ready') {
    return { ...base, status: 'unavailable', tone: 'neutral', value: '—', hint: 'Harness readings unavailable.' };
  }
  const unchecked = harness.uncheckedNames.length > 0
    ? ` · ${harness.uncheckedNames.join(' · ')} checked on the System map`
    : '';
  const down = harness.downNames.length > 0 ? `Down: ${harness.downNames.join(' · ')}` : 'All polled parts healthy';
  return {
    ...base,
    status: 'ready',
    tone: harness.downNames.length > 0 ? 'crit' : 'ok',
    value: `${harness.partsOk} of ${harness.partsChecked}`,
    hint: `${down}${unchecked}`,
  };
}

// 타일 2 — 7일 작업 결과. 판정과 임계는 ui.jsx 공용 규칙 소비 (Task results 와 동일 분모).
function buildOutcomeTile(outcomesState) {
  const base = { id: 'outcomes', label: 'Task results (7 d)', target: 'outcomes', targetLabel: 'Task results' };
  if (!outcomesState || outcomesState.status === 'loading') {
    return { ...base, status: 'loading', tone: 'neutral', value: '—', hint: 'Loading…' };
  }
  if (outcomesState.status === 'error') {
    return { ...base, status: 'error', tone: 'neutral', value: '—', hint: "Couldn't load task results." };
  }
  const rate = window.UI.resolveOutcomeRate(outcomesState.data);
  return { ...base, status: OUTCOME_TILE_STATUS[rate.status], tone: rate.tone, value: describeOutcomeValue(rate), hint: describeOutcomeHint(rate) };
}

// 판정 → 타일 상태. low-n 은 ready 가 아니다 — 표본 부족을 '정상'으로 읽히게 두지 않는다.
const OUTCOME_TILE_STATUS = {
  unavailable: 'unavailable', empty: 'empty', 'low-n': 'unavailable', ok: 'ready', warn: 'ready', crit: 'ready',
};

function describeOutcomeValue(rate) {
  if (rate.status === 'unavailable' || rate.status === 'empty') return '—';
  if (rate.status === 'low-n') return formatInt(rate.writerTotal);
  const share = rate.status === 'crit' ? rate.breakage : rate.openCaveats;
  if (rate.status === 'ok') return formatInt(rate.writerTotal);
  return window.UI.formatPctWithDenominator(share, rate.writerTotal);
}

function describeOutcomeHint(rate) {
  if (rate.status === 'unavailable') return 'No writer-emitted outcomes to judge.';
  if (rate.status === 'empty') return 'No outcomes recorded in the last 7 days.';
  if (rate.status === 'low-n') return `Sample below ${window.UI.LOW_N_MIN} — too small to judge.`;
  if (rate.status === 'crit') return 'Failed or blocked share is above its line.';
  if (rate.status === 'warn') return 'Open done-with-caveats share is above its line.';
  return `${formatInt(rate.writerTotal)} writer-emitted outcomes, all shares within their lines.`;
}

// 타일 3 — 함대. 정지(suspension) 사실은 Agents 계획(clauded-docs/39585 T1)이 아직 발행하지 않는다.
// 없는 수를 지어내지 않고 unavailable 로 고지 — 그 필드가 붙으면 힌트만 교체된다.
function buildFleetTile(agentsState) {
  const base = { id: 'fleet', label: 'Fleet (7 d)', target: 'agents', targetLabel: 'Agents' };
  if (!agentsState || agentsState.status === 'loading') {
    return { ...base, status: 'loading', tone: 'neutral', value: '—', hint: 'Loading…' };
  }
  if (agentsState.status === 'error') {
    return { ...base, status: 'error', tone: 'neutral', value: '—', hint: "Couldn't load the fleet summary." };
  }
  const total = Number(agentsState.data?.meta?.total_agents);
  if (!Number.isFinite(total)) {
    return { ...base, status: 'unavailable', tone: 'neutral', value: '—', hint: 'Fleet population unavailable.' };
  }
  const suffix = 'Suspension markers are not published yet — check Agents.';
  return { ...base, status: total > 0 ? 'ready' : 'empty', tone: 'neutral', value: formatInt(total), hint: total > 0 ? `Agents with runs in 7 days · ${suffix}` : `No agent ran in the last 7 days · ${suffix}` };
}

// 타일 4 — 오늘 지출. 톤은 pace 판정에서만 온다(금액 자체는 위험도가 아니다).
function buildSpendTile(costState) {
  const base = { id: 'spend', label: 'Spend today', target: 'cost', targetLabel: 'Cost & usage' };
  if (!costState || costState.status === 'loading') {
    return { ...base, status: 'loading', tone: 'neutral', value: '—', hint: 'Loading…' };
  }
  if (costState.status === 'error') {
    return { ...base, status: 'error', tone: 'neutral', value: '—', hint: "Couldn't load today's spend." };
  }
  const pace = resolveSpendPace(costState);
  const hint = pace.status === 'no-basis'
    ? 'No spend in the last 7 days — no baseline to compare against.'
    : `${formatUsd(pace.basis)} 7-day avg/day · alarm at ${SPEND_PACE_CUT}× so-far or pace.`;
  return { ...base, status: 'ready', tone: pace.status === 'hot' ? 'warn' : 'neutral', value: formatUsd(pace.today), hint };
}

// 헤더 우측 중립 텍스트 — 설치 버전 + wave 정착 시각. 조치 신호는 레인이 운반하므로 여기는 톤이 없다.
function describeStamp(harness, settledAt) {
  const version = harness && harness.version ? `v${harness.version}` : 'version unknown';
  const stamp = settledAt ? window.UI.formatKstTime(settledAt) : '—';
  return `${version} · as of ${stamp} ${window.UI.tzShortLabel()}`;
}

// update-job poll → 실제 row (none 은 무 job).
function readUpdateJob(jobState) {
  return (jobState.status === 'ready' && jobState.data && jobState.data.status !== 'none') ? jobState.data : null;
}

// ── Shared chrome ──

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

// ── Pure helpers ──
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

window.ScreenDashboard = ScreenDashboard;
