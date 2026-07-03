// 위키 화면 — wiki.* + core.daemon_runs PG 소스 (파일시스템 비결합) 6-섹션 SPA.
const {
	useState: useStateW,
	useEffect: useEffectW,
	useRef: useRefW,
	useCallback: useCallbackW,
	useMemo: useMemoW,
} = React;

// 사이클 기간 allowlist — server ALLOWED_WIKI_DAYS 와 정합 (routes/wiki.ts).
const WIKI_CYCLE_DAYS = 30;

// 일일 보고 기간 allowlist — server allowlist 와 정합 (routes/health.ts).
const WIKI_REPORT_DAYS_OPTIONS = [
	{ value: 7, label: "7d" },
	{ value: 14, label: "14d" },
	{ value: 30, label: "30d" },
	{ value: 90, label: "90d" },
];

const INITIAL_FETCH_STATE = { status: "loading", data: null, error: null };

// 희소 데이터 공용 임계 — 비0 포인트가 이 값 미만이면 넓은 빈 차트 대신 compact stat 으로 대체 (A4 통일).
// 종전 KPI spark(≥2) · SparseTrendW(<3) · throughput(<3) 불일치를 단일 기준으로 정합.
const SPARSE_MIN_NONZERO = 4;

function ScreenWiki() {
	const { Icon, PageHeader, TypeScaleStyle } = window.UI;

	const [summaryState, setSummaryState] = useStateW(INITIAL_FETCH_STATE);
	const [cyclesState, setCyclesState] = useStateW(INITIAL_FETCH_STATE);
	const [indexState, setIndexState] = useStateW(INITIAL_FETCH_STATE);
	const [backlogState, setBacklogState] = useStateW(INITIAL_FETCH_STATE);
	// 일일 보고 — /api/health/wiki-reports (라우트 불변, 호출 화면만 이동). 기간 선택 state 동반.
	const [reportState, setReportState] = useStateW(INITIAL_FETCH_STATE);
	const [reportDays, setReportDays] = useStateW(7);

	const [refreshTick, setRefreshTick] = useStateW(0);

	// AbortController per fetch wave — 언마운트/재요청 시 in-flight 취소.
	const abortRef = useRefW(null);

	const triggerRefresh = useCallbackW(() => setRefreshTick((t) => t + 1), []);

	// 4 parallel fetches via Promise.allSettled — 단일 실패 시에도 나머지 섹션 렌더 유지.
	useEffectW(() => {
		const ctrl = new AbortController();
		abortRef.current?.abort();
		abortRef.current = ctrl;

		const fetches = [
			["/api/wiki/summary", setSummaryState],
			[`/api/wiki/cycles?days=${WIKI_CYCLE_DAYS}`, setCyclesState],
			["/api/wiki/index-metrics", setIndexState],
			["/api/wiki/backlog", setBacklogState],
			[`/api/health/wiki-reports?days=${reportDays}`, setReportState],
		];

		fetches.forEach(([url, setter]) => {
			setter(INITIAL_FETCH_STATE);
			fetchJsonW(url, ctrl.signal)
				.then((data) => setter({ status: "ready", data, error: null }))
				.catch((err) => handleErrorW(err, setter));
		});

		return () => ctrl.abort();
	}, [refreshTick, reportDays]);

	return (
		<div className="flex flex-col gap-4">
			{/* 공유 타입스케일(.fs-* / --fs-*) 마운트 — wiki 화면 폰트 토큰 소비처. */}
			<TypeScaleStyle />
			<style>{`
        @keyframes skelPulseW { 0%,100%{opacity:.7} 50%{opacity:.35} }
        /* 상태 막대 셀 — status mix 비율 바 (0폭 셀도 보더 유지하지 않도록 min-w 0). */
        .w-mix-cell { min-width: 0; }
        /* per-run 보고 표 — 읽기 전용 RECORD(상세 드로어 없음) → .tbl 기본 pointer 커서/hover 무력화 (가짜 인터랙션 암시 방지). */
        .w-report-tbl tbody tr { cursor: default; }
        .w-report-tbl tbody tr:hover { background: transparent; }
      `}</style>

			<PageHeader
				title="Wiki"
				sub="Wiki knowledge base"
				right={
					<>
						<button
							className="btn ghost sm"
							onClick={triggerRefresh}
							aria-label="Refresh wiki"
						>
							<Icon name="refresh" size={14} />
							Refresh
						</button>
					</>
				}
			/>

			{/* 1. 개요 KPI×3 + 최근 사이클 헬스 (cycles → KPI 인라인 스파크라인 추세) */}
			<WikiOverviewSection
				state={summaryState}
				cyclesState={cyclesState}
				onRetry={triggerRefresh}
			/>

			{/* 보조 카드 — 2열 그리드(좁은 뷰포트 1열). 짧은 카드가 전폭을 점유하던 세로 공백 절감 (A5).
          누적 현황(Library totals)은 by_type 중복 → Index health 로 병합 (A3). */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
				{/* 일별 컴파일 throughput + status mix */}
				<WikiThroughputCard state={cyclesState} onRetry={triggerRefresh} />

				{/* 관리 백로그 — deadlinks/dedup 추세 + 최신 proposals explorer */}
				<WikiBacklogCard
					cyclesState={cyclesState}
					backlogState={backlogState}
					onRetry={triggerRefresh}
				/>

				{/* 인덱스 헬스 — Library totals(raw/summary/backlog) 병합 + by_type 카운트 + master-index freshness */}
				<WikiIndexHealthCard
					state={indexState}
					summaryState={summaryState}
					backlogState={backlogState}
					onRetry={triggerRefresh}
				/>

				{/* 일일 보고 — 사이클별 deadlinks/dedup 백로그 + per-run 보고 표(전폭 유지). */}
				<WikiReportsCard
					state={reportState}
					days={reportDays}
					onChangeDays={setReportDays}
					onRetry={triggerRefresh}
				/>
			</div>
		</div>
	);
}

// WikiOverviewSection — KPI×3(최근 컴파일·누적 노트·사이클 p95) + 최근 사이클 헬스 배너.
// ready 전에는 모두 '—' (가짜 0 금지). cycles 추세는 KPI 인라인 스파크라인(sparkData)으로 노출 (S3).

function WikiOverviewSection({ state, cyclesState, onRetry }) {
	const { KPI } = window.UI;

	const model = useMemoW(() => buildOverviewModel(state), [state]);
	// KPI 인라인 스파크라인 — 이미 fetch 한 cycles 재사용. 비0 < 2 면 Sparkline 미렌더(추세 의미 없음).
	const spark = useMemoW(() => buildOverviewSpark(cyclesState), [cyclesState]);

	if (state.status === "error") {
		return (
			<div className="card">
				<div className="card-body">
					<ErrorBannerW
						title="Couldn't load the wiki overview"
						detail={state.error}
						onRetry={onRetry}
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			{/* grid-cols-1 sm:grid-cols-3 — 좁은 뷰포트 1열 적층. */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<KPI
					label="Notes compiled"
					value={model.compiledLabel}
					unit=""
					sparkData={spark.compiled}
					sparkColor="rgb(var(--accent))"
				/>
				<KPI label="Total notes" value={model.notesLabel} unit="" hint="" />
				<KPI label="Run time (p95)" value={model.p95Label} unit="" />
			</div>
		</div>
	);
}

// cycles → KPI 인라인 스파크라인 시리즈. run_date asc(최신 우측) · 비0 포인트 < SPARSE_MIN_NONZERO 면 null(Sparkline 미렌더).
//   compiled = 일별 노트 산출 추세. 가짜 추세 금지(데이터 없으면 미노출).
function buildOverviewSpark(cyclesState) {
	if (!cyclesState || cyclesState.status !== "ready") return { compiled: null };

	const cycles = cyclesState.data?.cycles || [];
	const asc = [...cycles].sort((a, b) =>
		(a.run_date || "").localeCompare(b.run_date || ""),
	);
	const compiled = asc.map((c) => Number(c.compiled_count) || 0);

	const enough = (arr) => arr.filter((v) => v > 0).length >= SPARSE_MIN_NONZERO;
	return { compiled: enough(compiled) ? compiled : null };
}

// summary 응답 → 개요 표시 모델. hours_since_last_cycle(시간 정밀도, started_at 파생) 로 tone 분기 —
// 일 단위 환산은 24h/36h 임계를 무의미하게 만들어 폐기 (F33).
function buildOverviewModel(state) {
	if (state.status !== "ready") {
		return {
			compiledLabel: "—",
			notesLabel: "—",
			p95Label: "—",
		};
	}

	const d = state.data || {};

	return {
		compiledLabel: formatCountW(d.latest_compiled_count),
		notesLabel: formatCountW(d.notes_total),
		p95Label: formatDurationMsW(d.cycle_p95_ms),
	};
}

// Library totals 본문 — raw vs summary + 미처리 백로그(데몬 권위 true_backlog). Index health 카드 상단에 인라인 병합 (A3).
// by_type 카운트는 index-metrics, 총계는 summary · 백로그는 /api/wiki/backlog 의 true_backlog (재계산 금지).

function WikiAccumulationBody({ summaryState, indexState, model, onRetry }) {
	if (summaryState.status === "loading" || indexState.status === "loading") {
		return <ChartSkeletonW height={120} />;
	}
	if (summaryState.status === "error" && indexState.status === "error") {
		return (
			<ErrorBannerW
				title="Couldn't load library totals"
				detail={summaryState.error || indexState.error}
				onRetry={onRetry}
			/>
		);
	}
	if (!model.ready) {
		return <EmptyStateW message="No note data yet." />;
	}

	const { Bar } = window.UI;

	// raw/summary 비례막대 분모 — 둘 중 큰 값 (구성을 길이로 읽히게 · 백로그는 구성원 아님 → 막대 제외).
	const compMax = Math.max(model.rawCount ?? 0, model.summaryCount ?? 0);

	// 3 스탯: 원본(raw) / 요약(source-summary) / 미처리 백로그(데몬 true_backlog). 백로그 0 = ok, 양수 = info, null = pending.
	return (
		<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
			<SummaryStatW
				label="Saved originals"
				value={model.rawLabel}
				unit=""
				tone="info"
				hint="Awaiting summary"
				bar={
					typeof model.rawCount === "number" && compMax > 0 ? (
						<Bar
							value={model.rawCount}
							max={compMax}
							tone="neutral"
							ariaLabel={`Saved originals: ${model.rawLabel}`}
						/>
					) : null
				}
			/>
			<SummaryStatW
				label="Summary notes"
				value={model.summaryLabel}
				unit=""
				tone="info"
				bar={
					typeof model.summaryCount === "number" && compMax > 0 ? (
						<Bar
							value={model.summaryCount}
							max={compMax}
							tone="neutral"
							ariaLabel={`Summary notes: ${model.summaryLabel}`}
						/>
					) : null
				}
			/>
			<SummaryStatW
				label="Waiting to process"
				value={model.backlogLabel}
				unit={model.backlogUnit}
				tone={model.backlogTone}
				hint={model.backlogHint}
			/>
		</div>
	);
}

function buildAccumulationModel(summaryState, indexState, backlogState) {
	const byType =
		indexState.status === "ready" ? indexState.data?.by_type || [] : [];
	const rawCount = findTypeCountW(byType, "raw");
	const summaryCount = findTypeCountW(byType, "source-summary");

	// 총계 — index-metrics.notes_total 우선, 없으면 summary.notes_total 폴백.
	const notesTotal =
		indexState.status === "ready" &&
		typeof indexState.data?.notes_total === "number"
			? indexState.data.notes_total
			: summaryState.status === "ready"
				? summaryState.data?.notes_total
				: null;

	const ready = byType.length > 0 || typeof notesTotal === "number";

	// 미처리 백로그 — 데몬 권위 수치 true_backlog (rawCount−summaryCount 재계산 금지).
	// null(데몬 미발행/로딩/에러) → pending placeholder (백로그는 true_backlog만 사용 · 빼기 계산 금지) · 톤은 selectBacklogW 참조.
	// run_date 동반 → 데몬 비가동/사이클 미실행 시 stale 0 을 fresh 0 으로 오인하지 않도록 신선도 분기.
	const backlogData =
		backlogState && backlogState.status === "ready"
			? backlogState.data?.backlog
			: null;
	const trueBacklog = backlogData?.true_backlog ?? null;
	const backlogRunDate = backlogData?.run_date ?? null;
	const backlog = selectBacklogW(trueBacklog, backlogRunDate);

	return {
		ready,
		rawCount,
		summaryCount,
		rawLabel: formatCountW(rawCount),
		summaryLabel: formatCountW(summaryCount),
		backlogLabel: backlog.label,
		backlogTone: backlog.tone,
		backlogUnit: backlog.unit,
		backlogHint: backlog.hint,
		notesTotalLabel: formatCountW(notesTotal),
	};
}

// 백로그 stale 임계(일) — wiki 데몬 사이클이 일일 → run_date 가 1일 초과 경과면 stale.
// CYCLE_FRESH_OK_HOURS(24h)와 정합하되 run_date 는 날짜 단위라 일 카운트로 비교.
const BACKLOG_STALE_DAYS = 1;

// 데몬 true_backlog → 백로그 스탯 선택. number(0 포함) → 표시·tone(0=ok/양수=info)·단위 '개'.
// 단, run_date 가 BACKLOG_STALE_DAYS 초과 경과(데몬 비가동/사이클 미실행) → faint de-emphasis + 'as of <run_date>'.
//   stale 0 을 fresh 0 으로 오인 방지 (값은 마지막 사이클 시점 스냅샷일 뿐).
// null(미발행/로딩/에러) → pending placeholder + faint 톤 + 단위 없음 (백로그는 true_backlog만 사용 · 빼기 계산 금지).
// faint = SummaryStatW 가 rgb(var(--TONE)) 로 소비하는 유효 토큰 · --neutral 미정의 (tokens.css).
function selectBacklogW(trueBacklog, runDate) {
	if (
		typeof trueBacklog === "number" &&
		Number.isFinite(trueBacklog) &&
		trueBacklog >= 0
	) {
		const ageDays = ageInUtcDaysW(runDate);
		const isStale = typeof ageDays === "number" && ageDays > BACKLOG_STALE_DAYS;
		if (isStale) {
			return {
				label: formatCountW(trueBacklog),
				tone: "faint",
				unit: "",
				hint: `as of ${runDate} (stale — run overdue)`,
			};
		}
		return {
			label: formatCountW(trueBacklog),
			tone: trueBacklog === 0 ? "ok" : "info",
			unit: "",
			hint: "Originals awaiting summary",
		};
	}
	return {
		label: "Waiting",
		tone: "faint",
		unit: "",
		hint: "Originals awaiting summary",
	};
}

// 'YYYY-MM-DD'(UTC) run_date → 오늘(UTC) 대비 경과일. 비정상/null → null (stale 분기 보류).
// 데몬 run_date 가 UTC date 기준이므로 today 도 UTC 로 맞춰 비교 (outcomes.isoDayKeyO 패턴 미러).
function ageInUtcDaysW(runDate) {
	if (typeof runDate !== "string" || runDate.length < 10) return null;
	const runMs = Date.parse(`${runDate.slice(0, 10)}T00:00:00Z`);
	if (!Number.isFinite(runMs)) return null;
	const now = new Date();
	const todayMs = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate(),
	);
	const ageDays = Math.floor((todayMs - runMs) / 86400000);
	return ageDays >= 0 ? ageDays : null;
}

// WikiThroughputCard — 일별 컴파일 throughput + status mix.
// cycles 응답(run_date 내림차순) → 일별 compiled_count 미니바 + status 분포 비율 바.

function WikiThroughputCard({ state, onRetry }) {
	const { CardHead } = window.UI;

	const model = useMemoW(() => buildThroughputModel(state), [state]);

	return (
		<div className="card">
			<CardHead title="Daily output" right={null} />
			<div className="card-body">
				<WikiThroughputBody state={state} model={model} onRetry={onRetry} />
			</div>
		</div>
	);
}

function WikiThroughputBody({ state, model, onRetry }) {
	const { Icon } = window.UI;

	if (state.status === "loading") {
		return <ChartSkeletonW height={180} />;
	}
	if (state.status === "error") {
		return (
			<ErrorBannerW
				title="Couldn't load daily output"
				detail={state.error}
				onRetry={onRetry}
			/>
		);
	}
	if (!model.ready || model.rows.length === 0) {
		return (
			<EmptyStateW
				message={`No wiki compile runs in the last ${WIKI_CYCLE_DAYS} days.`}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			{/* status mix — 단일 우세 상태(>95%)면 칩 1개로 축약, 아니면 색맹 안전 4종 바+레전드 (A6). */}
			<div>
				<div className="fs-micro font-mono text-faint uppercase tracking-wider mb-1.5">
					Run status mix
				</div>
				{model.dominant ? (
					<div className="flex items-center gap-2 fs-meta font-mono">
						<Icon
							name="circle"
							size={9}
							className={`text-${model.dominant.tone}`}
						/>
						<span className="text-ink font-medium">
							{model.dominant.label} {model.dominant.pct}%
						</span>
						<span className="text-faint">({model.dominant.runs} runs)</span>
					</div>
				) : (
					<>
						<div
							className="flex w-full h-2.5 rounded-full overflow-hidden bg-sunken"
							role="img"
							aria-label={`Run status mix: healthy ${model.mix.ok}%, warning ${model.mix.partial}%, down ${model.mix.error}%, usage limit ${model.mix.quota}%`}
						>
							<span
								className="w-mix-cell"
								style={{
									width: `${model.mix.ok}%`,
									background: "rgb(var(--ok))",
								}}
							/>
							<span
								className="w-mix-cell"
								style={{
									width: `${model.mix.partial}%`,
									background: "rgb(var(--warn))",
								}}
							/>
							<span
								className="w-mix-cell"
								style={{
									width: `${model.mix.error}%`,
									background: "rgb(var(--crit))",
								}}
							/>
							<span
								className="w-mix-cell"
								style={{
									width: `${model.mix.quota}%`,
									background: "rgb(var(--faint))",
								}}
							/>
						</div>
						<div className="flex flex-wrap gap-x-3 gap-y-1 fs-micro font-mono text-faint mt-1.5">
							{/* 레전드 = STATUS_CHIP_META 단일 SoT (dominant 칩과 tone/label 공유). 배열 순서 = 위 바 셀 순서. */}
							{["ok", "partial", "error", "quota"].map((k) => (
								<span key={k} className="inline-flex items-center gap-1">
									<Icon
										name="circle"
										size={9}
										className={`text-${STATUS_CHIP_META[k].tone}`}
									/>
									{STATUS_CHIP_META[k].label} {model.mix[k]}%
								</span>
							))}
						</div>
					</>
				)}
			</div>

			{/* 일별 compiled_count 미니바 — 최신이 우측 (시계열). 비0 < SPARSE_MIN_NONZERO 이면 넓은 빈 차트 대신 compact stat. */}
			<div className="pt-3 border-t border-line">
				<SparseTrendW
					label="Notes per day"
					series={model.compiledSeries}
					stat={`peak ${model.maxCompiledLabel} · ${model.activeDays} active days of ${model.spanDays}`}
					w={10}
					h={44}
					tone="accent"
				/>
				{!model.sparse && (
					<div className="flex justify-between fs-micro font-mono text-faint mt-1">
						<span>{model.oldestDate}</span>
						<span>{model.newestDate}</span>
					</div>
				)}
			</div>
		</div>
	);
}

function buildThroughputModel(state) {
	if (state.status !== "ready") {
		return {
			ready: false,
			rows: [],
			compiledSeries: [],
			mix: EMPTY_MIX,
			maxCompiledLabel: "—",
			oldestDate: "",
			newestDate: "",
			sparse: false,
			totalCompiled: 0,
			spanDays: 0,
		};
	}

	const rows = state.data?.cycles || [];
	if (rows.length === 0) {
		return {
			ready: true,
			rows: [],
			compiledSeries: [],
			mix: EMPTY_MIX,
			maxCompiledLabel: "—",
			oldestDate: "",
			newestDate: "",
			sparse: false,
			totalCompiled: 0,
			spanDays: 0,
		};
	}

	// 서버 내림차순(최신 우선) → 미니바는 오래된→최신 순서로 ascending 재배열.
	const ascending = [...rows].sort((a, b) =>
		(a.run_date || "").localeCompare(b.run_date || ""),
	);
	const compiledSeries = ascending.map((r) => Number(r.compiled_count) || 0);
	const maxCompiled =
		compiledSeries.length > 0 ? Math.max(...compiledSeries) : 0;
	// F4: 비0 포인트 < SPARSE_MIN_NONZERO 면 넓은 트랙의 외톨이 막대가 차트 깨짐처럼 읽힘 → 캡션으로 "실제 희소 데이터" 표기.
	const nonZeroCount = compiledSeries.filter((v) => v > 0).length;

	const mix = computeStatusMix(rows);

	return {
		ready: true,
		rows,
		compiledSeries,
		mix,
		// A6: 한 상태가 >95% 면 4종 막대+레전드 대신 단일 칩으로 축약 (비-ok 상태 존재 시에만 전체 바).
		dominant: selectDominantStatusW(mix, rows.length),
		maxCompiledLabel: formatCountW(maxCompiled),
		oldestDate: ascending[0]?.run_date || "",
		newestDate: ascending[ascending.length - 1]?.run_date || "",
		sparse: nonZeroCount < SPARSE_MIN_NONZERO,
		activeDays: nonZeroCount,
		totalCompiled: compiledSeries.reduce((s, v) => s + v, 0),
		spanDays: compiledSeries.length,
	};
}

const EMPTY_MIX = { ok: 0, partial: 0, error: 0, quota: 0 };

// 단일 우세 상태 임계(%) — 한 상태가 이 비율 초과면 4종 바+레전드를 단일 칩으로 축약 (A6).
const STATUS_DOMINANT_PCT = 95;

const STATUS_CHIP_META = {
	ok: { tone: "ok", label: "Healthy" },
	partial: { tone: "warn", label: "Warning" },
	error: { tone: "crit", label: "Down" },
	quota: { tone: "faint", label: "Usage limit" },
};

// status mix → 단일 우세 상태(>STATUS_DOMINANT_PCT). 충족 시 { tone, label, pct, runs } · 미충족 → null(전체 바 렌더).
function selectDominantStatusW(mix, runCount) {
	for (const key of Object.keys(STATUS_CHIP_META)) {
		if (mix[key] > STATUS_DOMINANT_PCT) {
			const meta = STATUS_CHIP_META[key];
			return {
				tone: meta.tone,
				label: meta.label,
				pct: mix[key],
				runs: runCount,
			};
		}
	}
	return null;
}

// status 분포 → 백분율. ok/partial/error/quota_exceeded 외 status 는 error 로 합산(보수적).
function computeStatusMix(rows) {
	const total = rows.length;
	if (total === 0) return EMPTY_MIX;

	let ok = 0,
		partial = 0,
		error = 0,
		quota = 0;
	for (const r of rows) {
		const s = r.status;
		if (s === "ok") ok += 1;
		else if (s === "partial") partial += 1;
		else if (s === "quota_exceeded") quota += 1;
		else error += 1;
	}
	const pct = (n) => Math.round((n / total) * 100);
	return {
		ok: pct(ok),
		partial: pct(partial),
		error: pct(error),
		quota: pct(quota),
	};
}

// WikiBacklogCard — deadlinks/dedup 추세 + 최신 proposals explorer.
// 추세는 cycles(deadlinks_count·dedup_count), 최신 proposals 는 backlog payload(JSONB)에서.

function WikiBacklogCard({ cyclesState, backlogState, onRetry }) {
	const { CardHead } = window.UI;

	const model = useMemoW(
		() => buildBacklogModel(cyclesState, backlogState),
		[cyclesState, backlogState],
	);

	return (
		<div className="card">
			<CardHead title="Maintenance backlog" right={null} />
			<div className="card-body">
				<WikiBacklogBody
					cyclesState={cyclesState}
					backlogState={backlogState}
					model={model}
					onRetry={onRetry}
				/>
			</div>
		</div>
	);
}

function WikiBacklogBody({ cyclesState, backlogState, model, onRetry }) {
	if (cyclesState.status === "loading" && backlogState.status === "loading") {
		return <ChartSkeletonW height={180} />;
	}
	if (cyclesState.status === "error" && backlogState.status === "error") {
		return (
			<ErrorBannerW
				title="Couldn't load the maintenance backlog"
				detail={cyclesState.error || backlogState.error}
				onRetry={onRetry}
			/>
		);
	}

	const { MiniBars } = window.UI;

	return (
		<div className="flex flex-col gap-3">
			{/* deadlinks/dedup = 누적 백로그 스냅샷(매 사이클 재집계) → info 톤 고정 (영구 warn 신호 희석 방지). */}
			<div className="grid grid-cols-2 gap-3">
				<SummaryStatW
					label="Broken links"
					value={model.deadLabel}
					unit=""
					tone="info"
				/>
				<SummaryStatW
					label="Duplicates"
					value={model.dedupLabel}
					unit=""
					tone="info"
				/>
			</div>

			{/* 사이클별 deadlinks/dedup 추세 — 이미 fetch 한 cycles 시리즈 렌더 (F37). 최신이 우측. */}
			{(model.deadSeries.length >= 2 || model.dedupSeries.length >= 2) && (
				<div className="grid grid-cols-2 gap-3 pt-3 border-t border-line">
					{model.deadSeries.length >= 2 && (
						<div>
							<div className="fs-micro font-mono text-faint uppercase tracking-wider mb-1.5">
								Broken links trend
							</div>
							<div className="text-warn">
								<MiniBars
									data={model.deadSeries}
									w={Math.max(model.deadSeries.length * 8, 60)}
									h={32}
								/>
							</div>
						</div>
					)}
					{model.dedupSeries.length >= 2 && (
						<div>
							<div className="fs-micro font-mono text-faint uppercase tracking-wider mb-1.5">
								Duplicates trend
							</div>
							<div className="text-info">
								<MiniBars
									data={model.dedupSeries}
									w={Math.max(model.dedupSeries.length * 8, 60)}
									h={32}
								/>
							</div>
						</div>
					)}
				</div>
			)}

			{/* 최신 proposals explorer — dedup proposals + deadlink dryrun/fixes collapsible. */}
			<div className="pt-3 border-t border-line flex flex-col gap-2">
				<MergeSuggestions
					count={model.dedupProposalsCount}
					proposals={model.dedupProposals}
				/>
				{/* deadlink dryrun/fixes 는 영구 빈값(count 0) → 노출 생략, 데이터 생길 때만 explorer 렌더 (A7). */}
				{model.deadlinkDryrunCount > 0 && (
					<BacklogExplorer
						label="deadlink dryrun"
						count={model.deadlinkDryrunCount}
						payload={model.deadlinkDryrun}
					/>
				)}
				{model.deadlinkFixesCount > 0 && (
					<BacklogExplorer
						label="deadlink fixes"
						count={model.deadlinkFixesCount}
						payload={model.deadlinkFixes}
					/>
				)}
			</div>
		</div>
	);
}

// collapsible explorer shell SoT — summary(라벨+카운트) · 'none' 빈상태 · 본문 컨테이너 단일 출처.
//   children 미지정 = payload JSON dump(<pre>) 기본 거동 · children 지정 시 그 본문으로 대체 (구조 렌더 escape hatch).
function BacklogExplorer({ label, count, payload, defaultOpen, children }) {
	const isEmpty = count === 0 || payload == null;

	return (
		<details
			className="rounded-md border border-line bg-sunken"
			open={(defaultOpen && !isEmpty) || undefined}
		>
			<summary className="cursor-pointer select-none px-3 py-2 flex items-center gap-2 flex-wrap">
				{/* 12px→fs-body(12) 라벨 · 10.5px→fs-meta(11) 카운트. */}
				<span className="font-mono fs-body text-ink font-medium">{label}</span>
				<span className="ml-auto font-mono fs-meta text-dim">
					{count == null ? "—" : `${count}`}
				</span>
			</summary>
			<div className="px-3 pb-3">
				{isEmpty ? (
					<div className="fs-meta font-mono text-faint">none</div>
				) : children != null ? (
					children
				) : (
					<pre className="fs-meta font-mono text-dim whitespace-pre-wrap break-words m-0 max-h-64 overflow-y-auto">
						{stringifyPayloadW(payload)}
					</pre>
				)}
			</div>
		</details>
	);
}

// 머지 제안 explorer — BacklogExplorer shell 재사용 · 본문만 제안당 2줄 구조 렌더(target ← source · similarity · action).
//   cost_guard/cluster_hash/llm_rationale 등 내부 잡음 필드는 노출 생략 (A7).
function MergeSuggestions({ count, proposals }) {
	return (
		<BacklogExplorer
			label="Merge suggestions"
			count={count}
			payload={proposals}
			defaultOpen
		>
			<ul className="flex flex-col gap-2 m-0 p-0 list-none max-h-64 overflow-y-auto">
				{(proposals || []).map((p, i) => (
					<MergeSuggestionItem key={p.cluster_hash || i} proposal={p} />
				))}
			</ul>
		</BacklogExplorer>
	);
}

function MergeSuggestionItem({ proposal }) {
	const { Icon } = window.UI;

	const target = proposal.target_slug || "—";
	const sources = Array.isArray(proposal.source_slugs)
		? proposal.source_slugs.join(", ")
		: "—";
	const sim =
		typeof proposal.similarity_score === "number"
			? `${Math.round(proposal.similarity_score * 100)}%`
			: "—";
	const action = proposal.suggested_action || proposal.llm_verdict || "";

	return (
		<li className="rounded border border-line bg-card px-2.5 py-1.5">
			{/* line 1: target ← source(s) · similarity */}
			<div className="flex items-baseline gap-2 flex-wrap fs-meta font-mono">
				<span className="text-ink font-medium truncate" title={target}>
					{target}
				</span>
				<span className="inline-flex items-center text-faint">
					<Icon name="arrow-left" size={12} />
				</span>
				<span className="text-dim truncate" title={sources}>
					{sources}
				</span>
				<span className="ml-auto text-info">sim {sim}</span>
			</div>
			{/* line 2: 권장 액션 (DRY-RUN — 승인 필요) */}
			{action && (
				<div
					className="fs-micro font-mono text-faint mt-1 leading-tight truncate"
					title={window.UI.titleOf(action)}
				>
					{action}
				</div>
			)}
		</li>
	);
}

function buildBacklogModel(cyclesState, backlogState) {
	// 추세 숫자 — cycles 최신 1건 (서버 내림차순 → 첫 행).
	const cycles =
		cyclesState.status === "ready" ? cyclesState.data?.cycles || [] : [];
	const latest = cycles[0];
	const deadCount =
		latest && typeof latest.deadlinks_count === "number"
			? latest.deadlinks_count
			: null;
	const dedupCount =
		latest && typeof latest.dedup_count === "number"
			? latest.dedup_count
			: null;

	// 사이클별 추세 시리즈 — run_date asc (오래된→최신), 미기록 행은 0 (F37 MiniBars).
	const ascCycles = [...cycles].sort((a, b) =>
		(a.run_date || "").localeCompare(b.run_date || ""),
	);
	const deadSeries = ascCycles.map((c) =>
		typeof c.deadlinks_count === "number" ? c.deadlinks_count : 0,
	);
	const dedupSeries = ascCycles.map((c) =>
		typeof c.dedup_count === "number" ? c.dedup_count : 0,
	);

	// payload JSONB — dedup_proposals = { errors:[], proposals:[] } · deadlink_dryrun/fixes = array.
	const payload =
		backlogState.status === "ready" ? backlogState.data?.backlog || {} : {};
	const dedupRaw =
		payload.dedup_proposals && typeof payload.dedup_proposals === "object"
			? payload.dedup_proposals
			: null;
	const dedupProposals =
		dedupRaw?.proposals && Array.isArray(dedupRaw.proposals)
			? dedupRaw.proposals
			: null;
	const deadlinkDryrun = Array.isArray(payload.deadlink_dryrun)
		? payload.deadlink_dryrun
		: null;
	const deadlinkFixes = Array.isArray(payload.deadlink_fixes)
		? payload.deadlink_fixes
		: null;

	const ready =
		cyclesState.status === "ready" || backlogState.status === "ready";

	return {
		ready,
		deadLabel: formatCountW(deadCount),
		dedupLabel: formatCountW(dedupCount),
		deadSeries,
		dedupSeries,
		dedupProposals,
		dedupProposalsCount: dedupProposals ? dedupProposals.length : null,
		deadlinkDryrun,
		deadlinkDryrunCount: deadlinkDryrun ? deadlinkDryrun.length : null,
		deadlinkFixes,
		deadlinkFixesCount: deadlinkFixes ? deadlinkFixes.length : null,
	};
}

// WikiIndexHealthCard — Library totals(raw/summary/backlog) 병합 + by_type 카운트 표 + master-index 신선도(dirty_flag.dirty · last_dirty epoch ms).
// Library totals 가 별도 카드로 by_type 을 중복 노출하던 슬롭 제거 → 단일 카드로 통합 (A3).

function WikiIndexHealthCard({ state, summaryState, backlogState, onRetry }) {
	const { CardHead } = window.UI;

	const model = useMemoW(() => buildIndexHealthModel(state), [state]);
	// Library totals 본문 모델 — true_backlog 보존 위해 backlogState 동반 (재계산 금지, A3).
	const totalsModel = useMemoW(
		() => buildAccumulationModel(summaryState, state, backlogState),
		[summaryState, state, backlogState],
	);

	return (
		<div className="card">
			<CardHead title="Index health" right={null} />
			<div className="card-body">
				<WikiIndexHealthBody
					state={state}
					summaryState={summaryState}
					model={model}
					totalsModel={totalsModel}
					onRetry={onRetry}
				/>
			</div>
		</div>
	);
}

function WikiIndexHealthBody({
	state,
	summaryState,
	model,
	totalsModel,
	onRetry,
}) {
	if (state.status === "loading") {
		return <ChartSkeletonW height={160} />;
	}
	if (state.status === "error") {
		return (
			<ErrorBannerW
				title="Couldn't load index health"
				detail={state.error}
				onRetry={onRetry}
			/>
		);
	}
	if (!model.ready) {
		return <EmptyStateW message="No index metrics yet." />;
	}

	const { Badge, Bar } = window.UI;

	// note_type 최대 카운트 — 타입별 Bar 의 공통 max (구성 비율을 길이로 읽히게 · 색 단독 인코딩 회피).
	const maxTypeCount = model.byType.reduce(
		(m, t) => Math.max(m, Number(t.count) || 0),
		0,
	);

	return (
		<div className="flex flex-col gap-3">
			{/* Library totals 병합 — saved originals(raw) / summary notes / 미처리 백로그(true_backlog). (A3) */}
			<WikiAccumulationBody
				summaryState={summaryState}
				indexState={state}
				model={totalsModel}
				onRetry={onRetry}
			/>

			{/* note_type 별 카운트 — 누적 노트와 컴파일 총계(per-cycle)는 독립 표기 (드리프트/비율 아님).
          명시적 2열(A8) — auto-fill minmax 가 적은 타입수에서 남기던 후행 공백 제거. */}
			<div className="grid grid-cols-2 gap-2 pt-3 border-t border-line">
				{model.byType.map((t) => (
					<div
						key={t.note_type}
						className="rounded-md border border-line bg-sunken p-2.5"
					>
						{/* 10px→fs-micro(10) 라벨 · 18px→fs-stat 카운트. */}
						<div
							className="fs-micro font-mono text-faint uppercase tracking-wider truncate"
							title={t.note_type}
						>
							{t.note_type}
						</div>
						<div className="font-mono fs-stat font-semibold mt-0.5">
							{formatCountW(t.count)}
						</div>
						{/* 타입별 비례막대 — 구성이 형태(길이)로 읽히게 · 숫자는 위에서 카운트로 전달 (듀얼인코딩). */}
						<div className="mt-1.5">
							<Bar
								value={Number(t.count) || 0}
								max={maxTypeCount}
								tone="neutral"
								ariaLabel={`${t.note_type}: ${formatCountW(t.count)} notes`}
							/>
						</div>
					</div>
				))}
			</div>

			{/* master-index state — dirty_flag.dirty surfaced as the DIRTY/CLEAN pill (sole actionable signal). */}
			<div className="flex items-center gap-3 flex-wrap pt-3 border-t border-line">
				{/* 12px→fs-body(12). master-index label + DIRTY/CLEAN status pill. */}
				<span className="inline-flex items-center gap-3 flex-wrap min-w-0">
					<span className="fs-body font-mono text-faint">master-index</span>
					<Badge role="status" tone={model.dirty ? "warn" : "ok"} icon>
						{model.dirty ? "DIRTY" : "CLEAN"}
					</Badge>
				</span>
			</div>
		</div>
	);
}

function buildIndexHealthModel(state) {
	if (state.status !== "ready") {
		return {
			ready: false,
			byType: [],
			notesTotalLabel: "—",
			compiledTotalLabel: "—",
			dirty: false,
		};
	}

	const d = state.data || {};
	const byType = Array.isArray(d.by_type) ? d.by_type : [];

	return {
		ready: byType.length > 0 || typeof d.notes_total === "number",
		byType,
		notesTotalLabel: formatCountW(d.notes_total),
		compiledTotalLabel: formatCountW(d.latest_compiled_total),
		dirty: d.dirty === true,
	};
}

// 일일 보고 카드 — summary stats + per-cycle report 카드.

function WikiReportsCard({ state, days, onChangeDays, onRetry }) {
	const { CardHead } = window.UI;

	return (
		<div className="card">
			<CardHead
				title="Wiki daily report"
				right={
					<div className="seg" role="group" aria-label="Wiki report time range">
						{WIKI_REPORT_DAYS_OPTIONS.map((p) => (
							<button
								key={p.value}
								className={days === p.value ? "active" : ""}
								aria-pressed={days === p.value}
								onClick={() => onChangeDays(p.value)}
							>
								{p.label}
							</button>
						))}
					</div>
				}
			/>
			<div className="card-body">
				<WikiReportsBody state={state} days={days} onRetry={onRetry} />
			</div>
		</div>
	);
}

function WikiReportsBody({ state, days, onRetry }) {
	if (state.status === "loading") {
		return <ChartSkeletonW height={180} />;
	}
	if (state.status === "error") {
		return (
			<ErrorBannerW
				title="Couldn't load wiki reports"
				detail={state.error}
				onRetry={onRetry}
			/>
		);
	}
	const reports = state.data?.reports || [];
	if (reports.length === 0) {
		return (
			<EmptyStateW message={`No wiki compile runs in the last ${days} days.`} />
		);
	}

	// Newest first for the card list (server returns ascending by run_date).
	const sortedDesc = [...reports].sort((a, b) =>
		(b.run_date || "").localeCompare(a.run_date || ""),
	);

	// deadlinks/dedup = 미해결 백로그 스냅샷 (매 실행 동일값 재스탬프, per-cycle delta 아님) → 기간 합산 중복 과산정 방지 위해 최신 1건만 표시.
	const latestReport = sortedDesc[0];
	const latestDeadlinks = latestReport?.deadlinks_count ?? 0;
	const latestDedup = latestReport?.dedup_count ?? 0;

	// 사이클별 백로그 추세 시리즈 — run_date asc (오래된→최신, 최신이 우측) · 미기록 행은 0 (MiniBars 듀얼인코딩 보조).
	const ascReports = [...sortedDesc].reverse();
	const deadSeries = ascReports.map((r) =>
		typeof r.deadlinks_count === "number" ? r.deadlinks_count : 0,
	);
	const dedupSeries = ascReports.map((r) =>
		typeof r.dedup_count === "number" ? r.dedup_count : 0,
	);

	// deadlinks/dedup = 누적 백로그 스냅샷 → info 톤 고정 (정적값 영구 warn = 신호 희석).
	return (
		<div>
			{/* per-run 보고는 동질 카드 N개 → 슬롭 card-grid 가 아니라 RECORD 표(.tbl)로 노출 (S1/S6).
          최신 우선 · 수치 셀 .num · 시각 relative-time · 상태 DAEMON_STATUS_TONE · warn/crit 행만 .sev-bar 좌측 강조(전면 flood 금지). */}
			<WikiReportsTable reports={sortedDesc} />
		</div>
	);
}

// per-run 보고 표 — 동질 카드 grid 대체. sticky thead(STICKY_TH_STYLE) + .num 수치 + relative-time.
function WikiReportsTable({ reports }) {
	const { Badge, STICKY_TH_STYLE } = window.UI;

	return (
		<div
			className="overflow-x-auto overflow-y-auto rounded-md border border-line"
			style={{ maxHeight: 420 }}
		>
			<table className="tbl w-report-tbl">
				<thead>
					<tr>
						<th style={STICKY_TH_STYLE}>Run date</th>
						<th style={STICKY_TH_STYLE}>Status</th>
						<th className="num" style={STICKY_TH_STYLE}>
							Broken links
						</th>
						<th className="num" style={STICKY_TH_STYLE}>
							Duplicates
						</th>
						<th style={STICKY_TH_STYLE}>Started</th>
					</tr>
				</thead>
				<tbody>
					{reports.map((r) => (
						<WikiReportRow key={r.run_date} report={r} Badge={Badge} />
					))}
				</tbody>
			</table>
		</div>
	);
}

// per-run 보고 1행 — warn/crit 만 좌측 .sev-bar(2px) 강조, OK/neutral 은 강조 없음(전면 flood 금지, S5).
//   .sev-bar 는 셀 내부 inline-flex 로 얹음 (table row 에는 좌측 막대 직접 부착 불가).
function WikiReportRow({ report, Badge }) {
	const tone = wikiStatusToneW(report.status);
	const accent = tone === "warn" || tone === "crit";

	return (
		<tr
			aria-label={`Wiki report ${report.run_date} ${wikiStatusLabelW(report.status)}`}
		>
			<td>
				<span className="flex items-stretch gap-2 min-h-[18px]">
					{accent && <span className={`sev-bar ${tone}`} aria-hidden="true" />}
					<span className="font-mono text-ink font-medium">
						{report.run_date}
					</span>
				</span>
			</td>
			<td>
				<Badge role="status" tone={tone} icon>
					{wikiStatusLabelW(report.status)}
				</Badge>
			</td>
			{/* DEAD/DEDUP = 누적 백로그 스냅샷 (run time 컬럼은 항상 0 duration → 제거, A2). */}
			<td className="num text-dim">{report.deadlinks_count ?? "—"}</td>
			<td className="num text-dim">{report.dedup_count ?? "—"}</td>
			<td
				className="text-faint"
				title={
					report.started_at
						? window.UI.formatKstFull(report.started_at)
						: undefined
				}
			>
				{report.started_at
					? window.UI.formatRelativeTime(report.started_at)
					: "—"}
			</td>
		</tr>
	);
}

// Shared chrome (wiki-scoped — health.jsx 패턴 미러).

function SummaryStatW({ label, value, unit, tone, hint, bar }) {
	return (
		<div
			className="rounded-md border p-2.5 min-w-0"
			title={hint || undefined}
			style={{
				background: `rgb(var(--${tone}) / 0.06)`,
				borderColor: `rgb(var(--${tone}) / 0.35)`,
			}}
		>
			{/* 10px→fs-micro(10) 라벨 · 18px→fs-stat 값 · 11px→fs-meta(11) 단위 · 10px→fs-micro(10) 힌트. */}
			<div
				className="fs-micro font-mono text-faint uppercase tracking-wider truncate"
				title={label}
			>
				{label}
			</div>
			<div className="font-mono fs-stat font-semibold mt-0.5">
				{value}
				{unit && (
					<span className="fs-meta text-dim font-normal ml-1">{unit}</span>
				)}
			</div>
			{/* 선택적 비례막대 — 구성·비율을 길이로 읽히게 (옵트인, 미전달 시 종전 텍스트 전용 동작 유지). */}
			{bar && <div className="mt-1.5">{bar}</div>}
			{hint && (
				<div className="fs-micro font-mono text-faint mt-1 leading-tight truncate">
					{hint}
				</div>
			)}
		</div>
	);
}

function EmptyStateW({ message }) {
	return (
		<div className="placeholder m-3" style={{ padding: 20 }}>
			{message}
		</div>
	);
}

// 희소 추세(비0 포인트 < SPARSE_MIN_NONZERO) 공용 렌더 — 넓은 트랙 외톨이 막대가 "차트 깨짐"으로 읽히는 문제 회피.
//   sparse → MiniBars 대신 compact stat(최신/대표값) + "no activity in range" 빈상태로 대체.
//   충분히 채워진 시리즈(비0 ≥ SPARSE_MIN_NONZERO) → 종전대로 MiniBars 렌더. tone = MiniBars 색(text-* 컨테이너에서 상속).
function SparseTrendW({ label, series, stat, w, h, tone }) {
	const { MiniBars } = window.UI;
	const sparse = series.filter((v) => v > 0).length < SPARSE_MIN_NONZERO;

	return (
		<div>
			<div className="card-sub mb-1.5">{label}</div>
			{sparse ? (
				<div className="rounded-md border border-line bg-sunken px-3 py-2.5 flex items-baseline justify-between gap-3">
					<span className="font-mono fs-stat font-semibold text-dim">
						{stat}
					</span>
					<span className="fs-micro font-mono text-faint">
						no activity in range
					</span>
				</div>
			) : (
				<div className={`text-${tone}`}>
					<MiniBars data={series} w={Math.max(series.length * w, 60)} h={h} />
				</div>
			)}
		</div>
	);
}

function ErrorBannerW({ title, detail, onRetry }) {
	const { Icon } = window.UI;
	return (
		<div
			role="alert"
			className="rounded-md border p-3 flex items-start gap-3"
			style={{
				background: "rgb(var(--crit) / 0.08)",
				borderColor: "rgb(var(--crit) / 0.4)",
			}}
		>
			<Icon name="warn" size={16} className="text-crit mt-0.5" />
			<div className="flex-1 min-w-0">
				{/* 12.5px→fs-title(13) 제목 · 11px→fs-meta(11) 상세. */}
				<div className="fs-title font-medium text-ink">{title}</div>
				{detail && (
					<div
						className="fs-meta font-mono text-dim mt-1 truncate"
						title={window.UI.titleOf(detail)}
					>
						{detail}
					</div>
				)}
			</div>
			{onRetry && (
				<button className="btn sm" onClick={onRetry}>
					Retry
				</button>
			)}
		</div>
	);
}

function ChartSkeletonW({ height = 220 }) {
	return (
		<div
			aria-busy="true"
			style={{
				width: "100%",
				height,
				borderRadius: 8,
				background: "rgb(var(--sunken))",
				opacity: 0.7,
				animation: "skelPulseW 1.4s ease-in-out infinite",
			}}
		/>
	);
}

// Pure helpers (wiki-scoped — health.jsx 미러).

async function fetchJsonW(url, signal) {
	const res = await fetch(url, {
		signal,
		headers: { Accept: "application/json" },
	});
	if (!res.ok) {
		let body = "";
		try {
			body = await res.text();
		} catch (_e) {
			/* ignore body parse failure */
		}
		throw new Error(
			`HTTP ${res.status} ${res.statusText}${body ? " — " + body.slice(0, 120) : ""}`,
		);
	}
	return res.json();
}

function handleErrorW(err, setter) {
	// AbortError = 재요청/언마운트; 사용자 가시 실패 아님.
	if (err && err.name === "AbortError") return;
	setter({
		status: "error",
		data: null,
		error: err && err.message ? err.message : String(err),
	});
}

// by_type 배열에서 특정 note_type 카운트 추출 — 없으면 null (가짜 0 금지).
function findTypeCountW(byType, noteType) {
	const row = byType.find((t) => t && t.note_type === noteType);
	return row && typeof row.count === "number" ? row.count : null;
}

// 정수 천단위 콤마 — 비숫자/음수/null → '—' (가짜 0 금지).
function formatCountW(n) {
	if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
	return n.toLocaleString("en-US");
}

// p95/소요 ms → human-readable. <1s = ms · <60s = 초 · 그 외 분/초.
function formatDurationMsW(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s`;
	return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

// JSONB payload 직렬화 — 순환참조/직렬화 불가 시 안전 폴백.
function stringifyPayloadW(payload) {
	try {
		return JSON.stringify(payload, null, 2);
	} catch (_e) {
		return "[unreadable data]";
	}
}

// wiki last_status → tone. 캐논 DAEMON_STATUS_TONE(enum SoT, S4) 경유 — 로컬 status→color 맵 금지.
// fail 은 서버 enum 밖이라 DAEMON_STATUS_TONE 미보유 → crit 로 보강(데몬 실패와 동일 응급도).
function wikiStatusToneW(status) {
	if (status === "fail") return "crit";
	return window.UI.daemonStatusTone(status);
}

// wiki last_status → 표시 라벨. DAEMON_STATUS_TONE(Healthy/Warning/Down/Usage limit) 미러 — 화면 간 동일 어휘.
function wikiStatusLabelW(status) {
	if (status === "fail") return "Failed";
	if (!status) return "No data";
	return window.UI.daemonStatusLabel(status);
}

window.ScreenWiki = ScreenWiki;
