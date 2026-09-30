// 위키 화면 — wiki.* + core.daemon_runs PG 소스 (파일시스템 비결합). 판정 줄 + 알람 레인 + 타일 밴드 + 열린 상태 행 + 상세 디스클로저.
const {
	useState: useStateW,
	useEffect: useEffectW,
	useCallback: useCallbackW,
	useMemo: useMemoW,
} = React;

// 사이클 기간 allowlist — server ALLOWED_WIKI_DAYS 와 정합 (routes/wiki.ts).
const WIKI_CYCLE_DAYS = 30;

// 실행 표 기간 allowlist — server allowlist 와 정합 (routes/health.ts).
const WIKI_REPORT_DAYS_OPTIONS = [
	{ value: 7, label: "7d" },
	{ value: 30, label: "30d" },
	{ value: 90, label: "90d" },
];

// 희소 데이터 공용 임계 — 비0 포인트가 이 값 미만이면 넓은 빈 차트 대신 compact stat 으로 대체 (A4 통일).
// 종전 KPI spark(≥2) · SparseTrendW(<3) · throughput(<3) 불일치를 단일 기준으로 정합.
const SPARSE_MIN_NONZERO = 4;

function ScreenWiki() {
	const {
		PageHeader,
		PageVerdict,
		TypeScaleStyle,
		FreshnessStamp,
		RefreshButton,
		PageErrorBanner,
		INITIAL_REGION_STATE,
		getRegionSummary,
	} = window.UI;

	const [summaryState, setSummaryState] = useStateW(INITIAL_REGION_STATE);
	const [cyclesState, setCyclesState] = useStateW(INITIAL_REGION_STATE);
	const [indexState, setIndexState] = useStateW(INITIAL_REGION_STATE);
	const [backlogState, setBacklogState] = useStateW(INITIAL_REGION_STATE);
	// 일일 보고 — /api/health/wiki-reports (라우트 불변, 호출 화면만 이동). 기간 선택 state 동반.
	const [reportState, setReportState] = useStateW(INITIAL_REGION_STATE);
	const [reportDays, setReportDays] = useStateW(30);

	const [refreshTick, setRefreshTick] = useStateW(0);
	const [settledAt, setSettledAt] = useStateW(null);

	const triggerRefresh = useCallbackW(() => setRefreshTick((t) => t + 1), []);

	const waveSections = [
		[summaryState, WIKI_FEEDERS.summary],
		[cyclesState, WIKI_FEEDERS.runHistory],
		[indexState, WIKI_FEEDERS.notesByType],
		[backlogState, WIKI_FEEDERS.backlog],
		[reportState, WIKI_FEEDERS.runTable],
	];
	const waveStates = waveSections.map(([state]) => state);
	const isBusy = getRegionSummary(waveStates).isBusy;
	const hasRead = settledAt != null || waveStates.some((st) => st.data != null);
	const outage = readWikiOutageW(waveSections);
	const verdict = useMemoW(
		() => buildWikiVerdictW(summaryState, indexState, backlogState, cyclesState),
		[summaryState, indexState, backlogState, cyclesState],
	);

	// Parallel reads — each region keeps its last payload until its own answer lands.
	useEffectW(() => {
		const request = new AbortController();

		const fetches = [
			["/api/wiki/summary", setSummaryState],
			[`/api/wiki/cycles?days=${WIKI_CYCLE_DAYS}`, setCyclesState],
			["/api/wiki/index-metrics", setIndexState],
			["/api/wiki/backlog", setBacklogState],
			[`/api/health/wiki-reports?days=${reportDays}`, setReportState],
		];

		const reads = fetches.map(([url, setState]) => {
			setState((st) => window.UI.putRegionRequest(st, url, request));
			return runFetchW(url, request, setState);
		});
		Promise.all(reads).then((results) => {
			if (!request.signal.aborted && results.includes(true)) setSettledAt(new Date().toISOString());
		});

		return () => request.abort();
	}, [refreshTick, reportDays]);

	return (
		<div className="flex flex-col">
			{/* 공유 타입스케일(.fs-* / --fs-*) 마운트 — wiki 화면 폰트 토큰 소비처. */}
			<TypeScaleStyle />
			<style>{`
        /* 상태 막대 셀 — status mix 비율 바 (0폭 셀도 보더 유지하지 않도록 min-w 0). */
        .w-mix-cell { min-width: 0; }
        /* per-run 보고 표 — 읽기 전용 RECORD(상세 드로어 없음) → .tbl 기본 pointer 커서/hover 무력화 (가짜 인터랙션 암시 방지). */
        .w-report-tbl tbody tr { cursor: default; }
        .w-report-tbl tbody tr:hover { background: transparent; }
        /* summary is a flex row, which drops the native marker → the screen draws its own chevron. */
        .w-disclosure > summary { list-style: none; }
        .w-disclosure > summary::-webkit-details-marker { display: none; }
        .w-disclosure[open] > summary .w-chevron { transform: rotate(90deg); }
        /* base.css tints only status tones → a parked (neutral) glyph recedes locally. */
        .alarm-row[data-tone="neutral"] .alarm-row-glyph { color: rgb(var(--dim)); }
        /* Name, bar and count stay within reading distance on a wide panel. */
        .w-type-list { max-width: 40rem; }
        .w-type-row { display: grid; grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) 3.5rem 2.5rem; align-items: center; gap: 0.75rem; }
        .w-type-track { display: block; height: 6px; border-radius: 9999px; background: rgb(var(--line)); }
        .w-type-fill { display: block; height: 100%; border-radius: inherit; background: rgb(var(--dim)); }
      `}</style>

			<div className="flex-shrink-0">
				<PageHeader
					title="Wiki"
					right={
						<>
							<FreshnessStamp at={settledAt} regions={waveStates} />
							<RefreshButton
								isBusy={isBusy}
								hasRead={hasRead}
								onRefresh={triggerRefresh}
								label="Refresh wiki"
							/>
						</>
					}
				/>
			</div>

			{/* Always mounted — a region inserted with its text is not announced. */}
			<div className="sr-only" role="status" aria-live="polite">
				{describeWikiWaveW(waveSections)}
			</div>

			<div className="flex flex-col gap-4">
				{outage && (
					<PageErrorBanner
						sources={outage.sources}
						error={outage.error}
						onRetry={triggerRefresh}
						isBusy={isBusy}
						focusTargetId="wiki-verdict"
					/>
				)}
				<PageVerdict
					id="wiki-verdict"
					tone={verdict.tone}
					chips={verdict.chips}
					freshness={{ at: settledAt, regions: waveStates }}
				>
					{verdict.text}
				</PageVerdict>
				{/* Above the fold — what needs a hand, then the health band. */}
				<WikiAlarmLane
					summaryState={summaryState}
					indexState={indexState}
					backlogState={backlogState}
					cyclesState={cyclesState}
				/>
				<WikiTileBand
					summaryState={summaryState}
					indexState={indexState}
					backlogState={backlogState}
					cyclesState={cyclesState}
					at={settledAt}
					shared={outage}
					onRetry={triggerRefresh}
				/>
				<WikiStatusRow
					cyclesState={cyclesState}
					summaryState={summaryState}
					indexState={indexState}
					shared={outage}
					onRetry={triggerRefresh}
				/>

				{/* Behind the click — the per-run record and the working lists. */}
				<WikiRunTableSection
					reportState={reportState}
					days={reportDays}
					onChangeDays={setReportDays}
					shared={outage}
					onRetry={triggerRefresh}
				/>
				<WikiMaintenanceSection
					backlogState={backlogState}
					cyclesState={cyclesState}
					shared={outage}
					onRetry={triggerRefresh}
				/>
			</div>
		</div>
	);
}

// Changes only when the whole wave changes state, so settling reads are not announced one by one.
function describeWikiWaveW(sections) {
	if (sections.some(([state]) => state.status === "loading")) {
		return "Loading wiki…";
	}
	if (sections.some(([state]) => state.busy)) return "Refreshing wiki…";

	const failed = sections
		.filter(([state]) => state.error != null || state.status === "error")
		.map(([, name]) => name);
	if (failed.length === 0) return "Wiki loaded.";
	const failedList = failed.join(", ");
	return failed.length === sections.length
		? `Couldn't load ${failedList}.`
		: `Wiki partly loaded — couldn't load ${failedList}.`;
}

// Non-null when ≥2 sections failed for one cause → one page banner carries the only Retry.
function readWikiOutageW(sections) {
	return window.UI.getSharedFailure(
		sections.map(([state, source]) => ({ source, error: state.error ?? null })),
	);
}

// RegionFailure matches its own label → feeders the banner covers are restated under this region's label.
function WikiRegionFailureW({ feeders, source, error, isBusy, shared, focusTargetId, onRetry }) {
	const isCovered = feeders.length > 0 && feeders.every((feeder) => shared?.sources?.includes(feeder));
	const regionShared = isCovered ? { ...shared, sources: [source] } : null;

	return (
		<window.UI.RegionFailure
			source={source}
			error={error}
			isBusy={isBusy}
			shared={regionShared}
			focusTargetId={focusTargetId}
			onRetry={onRetry}
		/>
	);
}

// Daily cycle plus a grace window — past this the cycle counts as missed.
const CYCLE_OVERDUE_HOURS = 36;

function isCycleOverdueW(hours) {
	return typeof hours === "number" && hours > CYCLE_OVERDUE_HOURS;
}

// Runs an unchanged proposal count must survive before the pair reads as parked.
const PROPOSAL_PARKED_RUNS = 7;

// Same threshold on the dated source — the cycle is daily, so a run and a day match.
const PROPOSAL_PARKED_DAYS = PROPOSAL_PARKED_RUNS;

// Element id of the merge-proposals fold — the verdict chip's target.
const MERGE_PROPOSALS_ID = "wiki-merge-proposals";

// Wave section names — the banner lists them, and a region is covered when its feeder is among them.
const WIKI_FEEDERS = Object.freeze({
	summary: "summary",
	runHistory: "run history",
	notesByType: "notes by type",
	backlog: "maintenance backlog",
	runTable: "per-run table",
});

// Region card ids — a covered region's slot names its card, so the banner's Retry lands there on recovery.
const WIKI_REGION_IDS = Object.freeze({
	tiles: "wiki-tiles",
	runHistory: "wiki-run-history",
	notesByType: "wiki-notes-by-type",
	runTable: "wiki-run-table",
});

// One sentence over the lane's checks; a parked proposal informs but never raises the tone.
// An unread summary adds no sentence — PageVerdict's shared not-read note speaks for it.
function buildWikiVerdictW(summaryState, indexState, backlogState, cyclesState) {
	if (summaryState.status !== "ready") {
		const isFailed = window.UI.getRegionView(summaryState) === "error";
		const text = isFailed ? "The daily cycle summary could not be read." : null;
		return { tone: "neutral", text, chips: [] };
	}

	const summary = summaryState.data || {};
	const lane = buildAlarmLaneModel(summaryState, indexState, backlogState, cyclesState);
	const proposals = lane.alarms.filter((alarm) => alarm.proposal);
	const compiled = buildCompiledTileW(summaryState, backlogState, cyclesState);
	const tones = [
		wikiStatusToneW(summary.last_status),
		compiled.tone,
		...lane.alarms.map((alarm) => alarm.tone),
	];
	const parts = [
		summary.last_cycle_started_at
			? `last run ${window.UI.formatRelativeTime(summary.last_cycle_started_at)}`
			: "no run recorded",
		typeof summary.latest_compiled_count === "number"
			? `${formatCountW(summary.latest_compiled_count)} compiled`
			: null,
		describeProposalBacklogW(proposals),
		describeLaneGapW(lane),
	];

	return {
		tone: getVerdictToneW(tones, lane),
		text: parts.filter(Boolean).join(" · "),
		chips:
			proposals.length > 0
				? [{ key: "proposals", label: "Open proposals", targetId: MERGE_PROPOSALS_ID }]
				: [],
	};
}

// A known warn/crit stands; the all-clear waits until every lane feeder has answered.
function getVerdictToneW(tones, lane) {
	const worst = window.UI.getWorstTone(tones);
	if (worst && worst !== "ok") return worst;

	const complete = !lane.pending && lane.unchecked.length === 0;
	return complete ? "ok" : "neutral";
}

function describeLaneGapW(lane) {
	if (lane.unchecked.length > 0) return `couldn't check ${lane.unchecked.join(", ")}`;
	return lane.pending ? "still checking" : null;
}

// Rows arrive parked-last and oldest-last, so the final row carries the oldest age.
function describeProposalBacklogW(proposals) {
	if (proposals.length === 0) return null;

	const count = proposals.length;
	const parked = proposals.filter((p) => p.parked).length;
	const noun = count === 1 ? "merge" : "merges";
	const state =
		parked === count ? "parked" : parked === 0 ? "waiting" : `waiting (${parked} parked)`;
	const oldest = proposals[count - 1].ageLabel;
	return `${count} ${noun} ${state}${oldest ? `, oldest ${oldest}` : ""}`;
}

// Alarm lane — domain facts awaiting a decision, in decision order: dirty index →
// missed daily cycle → proposals awaiting approval (parked ones last). A failed payload
// renders its banner at the group it feeds, never a lane row.

function WikiAlarmLane({ summaryState, indexState, backlogState, cyclesState }) {
	const { Icon, TONE_ICON } = window.UI;

	const model = useMemoW(
		() =>
			buildAlarmLaneModel(
				summaryState,
				indexState,
				backlogState,
				cyclesState,
			),
		[summaryState, indexState, backlogState, cyclesState],
	);

	// Proposals ride the page verdict; the lane keeps what needs a hand now.
	const rows = model.alarms.filter((alarm) => !alarm.proposal);

	// Empty lane and unloaded lane must not look alike — silence only once every feeder answered.
	if (rows.length === 0 && model.unchecked.length === 0) {
		return model.pending ? (
			<div className="fs-meta text-faint" aria-busy="true">
				Checking what needs attention…
			</div>
		) : null;
	}

	return (
		<ul
			className="rounded-md border border-line m-0 p-0 list-none"
			aria-label="Wiki alarms"
		>
			{rows.map((alarm) => (
				<li key={alarm.key} className="alarm-row" data-tone={alarm.tone}>
					<span className="alarm-row-glyph" aria-hidden="true">
						<Icon name={TONE_ICON[alarm.tone]} size={14} />
					</span>
					<span className="min-w-0">
						<span className="fs-body text-ink font-medium block break-words">
							{alarm.label}
						</span>
						<span className="fs-meta text-faint block leading-tight">
							{alarm.detail}
						</span>
					</span>
				</li>
			))}
			{model.unchecked.length > 0 && (
				<li className="fs-meta text-faint px-4 py-2">
					{`Couldn't read ${model.unchecked.join(", ")} — alarms from ${model.unchecked.length === 1 ? "it" : "them"} are not shown.`}
				</li>
			)}
		</ul>
	);
}

// pending = a feeder is still loading, so "no alarms" cannot yet be told apart from
// "nothing loaded". An errored feeder is not pending — its group carries the banner.
function buildAlarmLaneModel(
	summaryState,
	indexState,
	backlogState,
	cyclesState,
) {
	const alarms = [];

	if (indexState.status === "ready" && indexState.data?.dirty === true) {
		alarms.push({
			key: "index-dirty",
			tone: "warn",
			label: "Search index is dirty",
			detail: "Run a wiki compile to regenerate the master index.",
		});
	}

	const summary = summaryState.status === "ready" ? summaryState.data : null;
	const hours = summary?.hours_since_last_cycle;
	if (isCycleOverdueW(hours)) {
		alarms.push({
			key: "cycle-overdue",
			tone: "crit",
			label: "The daily cycle has not run",
			detail: `Last run ${summary.last_run_date || "unknown"} · ${hours}h ago — inspect launchd.`,
		});
	}

	const proposals =
		backlogState.status === "ready"
			? readProposalsW(backlogState.data?.backlog)
			: null;
	if (proposals && proposals.length > 0) {
		alarms.push(
			...buildProposalAlarmsW(
				backlogState.data?.backlog,
				proposals,
				cyclesState,
			),
		);
	}

	const pending =
		window.UI.getRegionView(summaryState) === "loading" ||
		window.UI.getRegionView(indexState) === "loading" ||
		window.UI.getRegionView(backlogState) === "loading";

	// An errored feeder answers none of its checks, so the lane says so rather than reading clear.
	const unchecked = [
		[indexState, "search index"],
		[summaryState, "daily cycle"],
		[backlogState, "merge proposals"],
	]
		.filter(([state]) => window.UI.getRegionView(state) === "error")
		.map(([, label]) => label);

	return { alarms, pending, unchecked };
}

// One row per waiting proposal, each with its own age; rows sort by that age, so
// parked pairs land last and the longest-parked last of all.
function buildProposalAlarmsW(backlog, proposals, cyclesState) {
	// Undated rows share the run streak, read once for the whole lane.
	const runs = countUnchangedDedupRunsW(cyclesState);
	// Cycles still in flight → the streak is unknown, not absent.
	const checking = window.UI.getRegionView(cyclesState) === "loading";

	const rows = proposals.map((proposal, i) => {
		// No acknowledge path exists, so a parked pair is de-emphasised rather than hidden.
		const wait = readProposalWaitW(backlog, proposal);
		const age = wait ? wait.days : runs;
		const parked = wait
			? wait.days >= PROPOSAL_PARKED_DAYS
			: typeof runs === "number" && runs >= PROPOSAL_PARKED_RUNS;
		return {
			key: `proposal-${proposal?.cluster_hash || i}`,
			// cyan belongs to the chart series → a parked pair recedes to neutral, not info.
			tone: parked ? "neutral" : "warn",
			label: `Merge proposal waiting on approval · ${proposal?.target_slug || proposal?.cluster_hash || "unnamed pair"}`,
			detail: wait
				? describeProposalWaitW(wait, parked)
				: describeProposalAgeW(runs, parked, checking),
			parked,
			age: typeof age === "number" ? age : 0,
			ageLabel: wait
				? `${wait.days} d`
				: typeof runs === "number"
					? `${runs} ${runs === 1 ? "run" : "runs"}`
					: null,
			proposal,
		};
	});
	return rows.sort((x, y) => Number(x.parked) - Number(y.parked) || x.age - y.age);
}

// The proposal's own first-seen date — the server's dated age source.
// Absent map, unhashed proposal or an unparseable date → null, and the run streak answers instead.
function readProposalWaitW(backlog, proposal) {
	const firstSeen = backlog?.proposal_first_seen;
	if (!firstSeen || typeof firstSeen !== "object") return null;

	const since = firstSeen[proposal?.cluster_hash];
	if (typeof since !== "string") return null;

	const days = ageInUtcDaysW(since);
	return typeof days === "number" ? { days, since } : null;
}

function describeProposalWaitW(wait, parked) {
	const span =
		wait.days === 0
			? `Waiting since today (${wait.since})`
			: `Waiting ${wait.days} ${wait.days === 1 ? "day" : "days"} (since ${wait.since})`;
	return describeParkedSpanW(span, parked);
}

// Fallback age source for a payload with no first-seen map: the streak of newest
// cycles carrying an unchanged dedup count, labelled as a count of runs.
function countUnchangedDedupRunsW(cyclesState) {
	if (cyclesState.status !== "ready") return null;

	const cycles = [...(cyclesState.data?.cycles || [])].sort((a, b) =>
		(b.run_date || "").localeCompare(a.run_date || ""),
	);
	const newest = cycles[0];
	if (!newest || typeof newest.dedup_count !== "number") return null;

	let runs = 0;
	for (const c of cycles) {
		if (c.dedup_count !== newest.dedup_count) break;
		runs += 1;
	}
	return runs;
}

function describeProposalAgeW(runs, parked, checking) {
	if (typeof runs !== "number") {
		return checking
			? "Checking run history for the waiting time…"
			: "Waiting time unknown — no run history yet.";
	}

	const span = `Unchanged for ${runs} ${runs === 1 ? "run" : "runs"}`;
	return describeParkedSpanW(span, parked);
}

function describeParkedSpanW(span, parked) {
	return parked
		? `${span} — parked; run the curator merge or leave the pair.`
		: `${span}.`;
}

// dedup_proposals JSONB — { proposals, not_verified, errors, … }; the shape varies by
// cycle, so every read is guarded and a missing key stays null rather than an empty list.
function readDedupW(backlog) {
	const raw = backlog?.dedup_proposals;
	return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
}

function readProposalsW(backlog) {
	const list = readDedupW(backlog)?.proposals;
	return Array.isArray(list) ? list : null;
}

// Backlog figures are a per-cycle snapshot: past one cycle they are dated, and an
// undated or stale snapshot must not read as the current count.
function describeSnapshotAgeW(runDate) {
	if (!runDate) return " (run date not reported)";

	const ageDays = ageInUtcDaysW(runDate);
	const stale = typeof ageDays === "number" && ageDays > BACKLOG_STALE_DAYS;
	return stale ? ` (as of ${runDate}, cycle overdue)` : "";
}

// Four-tile band — last run · compiled last cycle · search index · library totals.
// Steady state carries no tint (the last-run sub still names the outcome); only an actionable state tints.

function WikiTileBand({ summaryState, indexState, backlogState, cyclesState, at, shared, onRetry }) {
	const tiles = useMemoW(
		() => buildTileBandModel(summaryState, indexState, backlogState, cyclesState, at),
		[summaryState, indexState, backlogState, cyclesState, at],
	);
	const failures = readTileBandFailuresW(summaryState, indexState);
	// a feeder the banner does not cover keeps its own sentence and Retry
	const uncovered = failures.filter((f) => !shared?.sources?.includes(f.feeder));
	const shown = uncovered.length > 0 ? uncovered : failures;

	return (
		<div id={WIKI_REGION_IDS.tiles} className="flex flex-col gap-2">
			{shown.length > 0 && (
				<WikiRegionFailureW
					feeders={shown.map((f) => f.feeder)}
					source={`the ${shown.map((f) => f.label).join(" and ")}`}
					error={shown[0].state.error}
					isBusy={shown.some((f) => f.state.busy)}
					shared={shared}
					focusTargetId={WIKI_REGION_IDS.tiles}
					onRetry={onRetry}
				/>
			)}
			<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
				{tiles.map((tile) => (
					<WikiTile key={tile.key} tile={tile} />
				))}
			</div>
		</div>
	);
}

// The band's own feeders; the backlog's failure is announced by the maintenance group it feeds.
function readTileBandFailuresW(summaryState, indexState) {
	return [
		{ state: summaryState, feeder: WIKI_FEEDERS.summary, label: "daily cycle summary" },
		{ state: indexState, feeder: WIKI_FEEDERS.notesByType, label: "search index" },
	].filter((f) => window.UI.getRegionView(f.state) === "error");
}

// Report surface → neutral chrome; a warn/crit tile carries its tone on a glyph beside the
// figure, leaving tinted containers to the alarm lane (39578 §C/§D).
function WikiTile({ tile }) {
	const { Icon, TONE_ICON } = window.UI;
	const alarmed = tile.tone === "warn" || tile.tone === "crit";

	return (
		<div className="rounded-md border border-line bg-sunken p-2.5 min-w-0">
			<div
				className="fs-meta text-faint leading-tight break-words"
				title={tile.label}
			>
				{tile.label}
			</div>
			<div
				className={`${tile.isWord ? "" : "font-mono "}fs-stat font-semibold mt-0.5 flex items-center gap-1.5 ${tile.state === "ready" ? "" : "text-faint"}`}
				aria-busy={tile.state === "loading" ? "true" : undefined}
			>
				{alarmed && (
					<span className={`text-${tile.tone} flex-shrink-0`} aria-hidden="true">
						<Icon name={TONE_ICON[tile.tone]} size={13} />
					</span>
				)}
				{tile.value}
			</div>
			{tile.sub && (
				<div
					className="fs-meta text-faint mt-1 leading-tight break-words"
					title={tile.hint || tile.sub}
				>
					{tile.sub}
				</div>
			)}
		</div>
	);
}

function buildTileBandModel(summaryState, indexState, backlogState, cyclesState, at) {
	return [
		buildLastRunTileW(summaryState, at),
		buildCompiledTileW(summaryState, backlogState, cyclesState),
		buildIndexTileW(indexState),
		buildLibraryTileW(indexState, summaryState, backlogState),
	];
}

// Shared non-ready tile shapes — loading, error and unavailable stay distinguishable and
// none of them renders as a number (a zero nobody loaded is the failure mode).
// Loading and errored tiles carry no sub text: the "…" value and the band's single banner speak for them.
function tilePlaceholderW(key, label, state) {
	const SUB = {
		loading: null,
		error: null,
		unavailable: "Not reported yet",
		empty: "Nothing recorded",
	};
	return {
		key,
		label,
		state,
		value: state === "loading" ? "…" : "—",
		sub: SUB[state],
		tone: "neutral",
	};
}

function tileFetchStateW(state) {
	if (window.UI.getRegionView(state) === "loading") return "loading";
	if (window.UI.getRegionView(state) === "error") return "error";
	return null;
}

function buildLastRunTileW(state, at) {
	const label = "Last run";
	const pending = tileFetchStateW(state);
	if (pending) return tilePlaceholderW("last-run", label, pending);

	const d = state.data || {};
	if (!d.last_cycle_started_at) {
		return tilePlaceholderW("last-run", label, "empty");
	}

	const hours = d.hours_since_last_cycle;
	const overdue = isCycleOverdueW(hours);
	const outcome = getLastRunOutcomeW(state, at, overdue);
	const tone = outcome.tone === "ok" ? "neutral" : outcome.tone;

	return {
		key: "last-run",
		label,
		state: "ready",
		value: window.UI.formatRelativeTime(d.last_cycle_started_at),
		// "21h ago" in the mono stat face → its space reads as a double gap
		isWord: true,
		sub: overdue
			? `${outcome.label} · cycle ${d.last_run_date}`
			: `${outcome.label}${describeP95W(d.cycle_p95_ms)}`,
		hint: `Cycle ${d.last_run_date}`,
		tone,
	};
}

// A held summary under a failed or aged read takes the shared verdict: Last known, ok → neutral, warn/crit kept.
function getLastRunOutcomeW(state, at, overdue) {
	const status = state.data?.last_status;
	const outcome = overdue
		? { tone: "crit", label: "Overdue" }
		: { tone: wikiStatusToneW(status), label: wikiStatusLabelW(status) };
	if (!at) return outcome;

	return window.UI.getFreshnessVerdict({ ...outcome, at, regions: [state] });
}

function describeP95W(ms) {
	return typeof ms === "number" ? ` · p95 ${window.UI.formatDuration(ms, "ms")}` : "";
}

// A zero names its cause: idle (nothing waiting) stays quiet, stalled (originals waiting) tints.
function buildCompiledTileW(
	state,
	backlogState = UNKNOWN_REGION_W,
	cyclesState = UNKNOWN_REGION_W,
) {
	const label = "Compiled last cycle";
	const pending = tileFetchStateW(state);
	if (pending) return tilePlaceholderW("compiled", label, pending);

	const count = state.data?.latest_compiled_count;
	if (typeof count !== "number") {
		return tilePlaceholderW("compiled", label, "unavailable");
	}

	const waiting =
		backlogState.status === "ready" ? backlogState.data?.backlog?.true_backlog : undefined;
	const isStalled = count === 0 && typeof waiting === "number" && waiting > 0;
	const cause =
		count !== 0 || typeof waiting !== "number"
			? null
			: isStalled
				? `${formatCountW(waiting)} originals waiting, none compiled`
				: "Nothing to compile — no originals waiting";
	// same span as Run history → the two totals read alike
	const trend = buildThroughputModel(cyclesState);
	const windowTotal =
		trend.rows.length > 0 ? `${formatCountW(trend.total)} in ${trend.spanDays} d` : null;

	return {
		key: "compiled",
		label,
		state: "ready",
		value: formatCountW(count),
		sub: [cause, windowTotal].filter(Boolean).join(" · ") || null,
		tone: isStalled ? "warn" : "neutral",
	};
}

function sumCompiledW(cyclesState) {
	if (cyclesState.status !== "ready") return null;
	return (cyclesState.data?.cycles || []).reduce(
		(sum, c) => sum + (Number(c.compiled_count) || 0),
		0,
	);
}

function buildIndexTileW(state) {
	const label = "Search index";
	const pending = tileFetchStateW(state);
	if (pending) return tilePlaceholderW("index", label, pending);

	const d = state.data || {};
	// The server states row presence outright; the timestamp inference covers a payload predating it.
	const flagMissing =
		d.has_dirty_flag === false ||
		(d.has_dirty_flag == null && d.dirty !== true && d.last_dirty_ms == null);
	// No row yet → say what is unknown rather than show a bare dash.
	if (flagMissing) {
		return {
			...tilePlaceholderW("index", label, "unavailable"),
			value: "Not reported",
			sub: "Freshness not reported",
			hint: "No dirty flag on record — the compiler has not written one, so cleanliness is unknown",
			isWord: true,
		};
	}
	if (d.dirty === true) {
		return {
			key: "index",
			label,
			state: "ready",
			value: "Dirty",
			isWord: true,
			sub:
				typeof d.last_dirty_ms === "number"
					? `Since ${window.UI.formatRelativeTime(new Date(d.last_dirty_ms).toISOString())}`
					: "Compile pending",
			tone: "warn",
		};
	}

	return {
		key: "index",
		label,
		state: "ready",
		value: "Clean",
		isWord: true,
		sub: "Master index current",
		tone: "neutral",
	};
}

function buildLibraryTileW(indexState, summaryState, backlogState) {
	const label = "Library notes";
	const pending = tileFetchStateW(indexState) || tileFetchStateW(summaryState);
	if (pending) return tilePlaceholderW("library", label, pending);

	const total =
		typeof indexState.data?.notes_total === "number"
			? indexState.data.notes_total
			: summaryState.data?.notes_total;
	if (typeof total !== "number") {
		return tilePlaceholderW("library", label, "unavailable");
	}

	const payload =
		backlogState.status === "ready" ? backlogState.data?.backlog : null;
	const backlog = payload?.true_backlog;

	return {
		key: "library",
		label,
		state: "ready",
		value: formatCountW(total),
		sub: payload
			? `${describeOriginalsW(backlog)} · ${describeBrokenLinksW(payload.deadlink_dryrun)}${describeSnapshotAgeW(payload.run_date)}`
			: "Backlog not reported",
		tone: "neutral",
	};
}

function describeOriginalsW(backlog) {
	if (typeof backlog !== "number") return "originals not reported";
	return `${backlog === 0 ? "No" : formatCountW(backlog)} originals waiting`;
}

// A missing key reads as "not reported", never as zero.
function describeBrokenLinksW(deadLinks) {
	if (!Array.isArray(deadLinks)) return "broken links not reported";
	const count = deadLinks.length;
	return `${formatCountW(count)} broken ${count === 1 ? "link" : "links"}`;
}

// Maintenance — one summary line above the fold, the working lists behind a click.
// The proposals list reports the cost-guard residue, since unverified candidate pairs
// make the proposal count a floor rather than a total.

function WikiMaintenanceSection({ backlogState, cyclesState, shared, onRetry }) {
	const { LoadingPlaceholder } = window.UI;
	const model = useMemoW(
		() => buildMaintenanceModel(backlogState, cyclesState),
		[backlogState, cyclesState],
	);

	return (
		<div className="flex flex-col gap-2">
			{model.state === "error" ? (
				<WikiRegionFailureW
					feeders={[WIKI_FEEDERS.backlog]}
					source="the maintenance backlog"
					error={backlogState.error}
					isBusy={backlogState.busy}
					shared={shared}
					focusTargetId={MERGE_PROPOSALS_ID}
					onRetry={onRetry}
				/>
			) : null}

			{/* Always present, so the verdict's proposals chip and the page layout never lose it. */}
			<WikiDisclosureW
				id={MERGE_PROPOSALS_ID}
				label="Merge proposals"
				count={describeProposalCountW(model)}
				tone={model.proposalTone}
			>
				{model.state === "loading" ? (
					<LoadingPlaceholder label="merge proposals" />
				) : model.state === "error" ? (
					<EmptyStateW message="The maintenance backlog could not be read — see above." />
				) : !model.proposals || model.proposals.length === 0 ? (
					<EmptyStateW
						message={
							model.proposals
								? "No merge proposals waiting."
								: "The last cycle did not report merge proposals."
						}
					/>
				) : (
					<div className="flex flex-col gap-2">
						{model.isDryRun && (
							<div className="fs-meta text-dim leading-tight">
								Dry run — nothing merges until you approve it.
							</div>
						)}
						<div className="fs-meta text-dim leading-tight">
							Each proposal merges the notes after the arrow into the note before it.
						</div>
						<ul className="flex flex-col gap-2 m-0 p-0 list-none">
							{model.proposals.map((proposal, i) => (
								<MergeSuggestionItem
									key={proposal.cluster_hash || i}
									proposal={proposal}
								/>
							))}
						</ul>
						{model.residueLine && (
							<div className="fs-meta text-faint leading-tight">
								{model.residueLine}
							</div>
						)}
					</div>
				)}
			</WikiDisclosureW>

			{/* Dead-link lists appear only once the fixer has something to report. */}
			{model.deadLinks && model.deadLinks.length > 0 && (
				<BacklogExplorer
					label="Broken links"
					count={model.deadLinks.length}
					payload={model.deadLinks}
				/>
			)}
			{model.linkFixes && model.linkFixes.length > 0 && (
				<BacklogExplorer
					label="Link fixes applied"
					count={model.linkFixes.length}
					payload={model.linkFixes}
				/>
			)}
		</div>
	);
}

function describeProposalCountW(model) {
	if (model.state === "loading") return "Loading…";
	if (model.state === "error") return "Unavailable";
	return model.proposals ? formatCountW(model.proposals.length) : "Not reported";
}

const UNKNOWN_REGION_W = { status: "idle", data: null, error: null };

function buildMaintenanceModel(backlogState, cyclesState = UNKNOWN_REGION_W) {
	if (window.UI.getRegionView(backlogState) === "loading") {
		return { state: "loading" };
	}
	if (window.UI.getRegionView(backlogState) === "error") return { state: "error" };

	const backlog = backlogState.data?.backlog;
	if (!backlog) {
		return { state: "empty" };
	}

	const proposalRows = readProposalRowsW(backlog, readProposalsW(backlog), cyclesState);
	const deadLinks = Array.isArray(backlog.deadlink_dryrun)
		? backlog.deadlink_dryrun
		: null;
	const linkFixes = Array.isArray(backlog.deadlink_fixes)
		? backlog.deadlink_fixes
		: null;
	const notVerified = readDedupW(backlog)?.not_verified;

	const proposals = proposalRows && proposalRows.map((row) => row.proposal);

	return {
		state: "ready",
		proposals,
		isDryRun: Boolean(proposals?.some(isDryRunProposalW)),
		// A waiting pair → warn, so the fold holding it opens itself; parked pairs stay neutral.
		proposalTone: proposalRows && window.UI.getWorstTone(proposalRows.map((row) => row.tone)),
		deadLinks,
		linkFixes,
		residueLine:
			typeof notVerified === "number" && notVerified > 0
				? `${formatCountW(notVerified)} candidate pairs went unverified this cycle (cost guard) — the proposal count is a floor.`
				: null,
	};
}

// The lane's rows, so row N in the lane is row N in the list.
function readProposalRowsW(backlog, proposals, cyclesState) {
	if (!proposals) return proposals;
	return buildProposalAlarmsW(backlog, proposals, cyclesState);
}

// Status row — the compile trend and the library's composition, open side by side.
function WikiStatusRow({ cyclesState, summaryState, indexState, shared, onRetry }) {
	const { SplitRow } = window.UI;

	return (
		<SplitRow ratio="2:1">
			<WikiRunHistorySection
				cyclesState={cyclesState}
				summaryState={summaryState}
				shared={shared}
				onRetry={onRetry}
			/>
			<WikiNotesByTypeSection state={indexState} shared={shared} onRetry={onRetry} />
		</SplitRow>
	);
}

// Run history — the notes-per-day trend as an open status strip on the fixed cycles window.
function WikiRunHistorySection({ cyclesState, summaryState, shared, onRetry }) {
	const { LoadingPlaceholder } = window.UI;
	const model = useMemoW(
		() => buildThroughputModel(cyclesState),
		[cyclesState],
	);

	return (
		<WikiCardW
			id={WIKI_REGION_IDS.runHistory}
			label="Run history"
			count={describeRunHistoryW(cyclesState, model, summaryState)}
		>
			{window.UI.getRegionView(cyclesState) === "loading" ? (
				<LoadingPlaceholder label="run history" minHeight={120} />
			) : window.UI.getRegionView(cyclesState) === "error" ? (
				<WikiRegionFailureW
					feeders={[WIKI_FEEDERS.runHistory]}
					source="run history"
					error={cyclesState.error}
					isBusy={cyclesState.busy}
					shared={shared}
					focusTargetId={WIKI_REGION_IDS.runHistory}
					onRetry={onRetry}
				/>
			) : model.rows.length === 0 ? (
				<EmptyStateW
					message={`No wiki compile runs in the last ${WIKI_CYCLE_DAYS} days.`}
				/>
			) : (
				<>
					{/* The window is a fetch bound, not what is drawn → name the days the bars cover. */}
					<SparseTrendW
						label={`Notes per day · ${model.spanDays} ${model.spanDays === 1 ? "day" : "days"}`}
						series={model.compiledSeries}
						dates={model.compiledDates}
						stat={`${formatCountW(model.total)} notes in ${model.spanDays} d · ${model.activeDays} active days`}
					/>
					{/* A near-uniform mix carries no information — only a mixed run set earns the bar. */}
					{!model.isMixUniform && <WikiStatusMixW mix={model.mix} />}
				</>
			)}
		</WikiCardW>
	);
}

// Per-run record — a detail fold whose summary line states the run streak without a click.
function WikiRunTableSection({ reportState, days, onChangeDays, shared, onRetry }) {
	return (
		<WikiDisclosureW
			id={WIKI_REGION_IDS.runTable}
			label="Per-run table"
			count={describeRunTableW(reportState, days)}
			bodyClassName="px-3 pb-3 flex flex-col gap-2"
		>
			<div className="flex items-center gap-2 flex-wrap">
				<span className="fs-meta text-faint leading-tight">
					{`The window drives the table only — the trend keeps a fixed ${WIKI_CYCLE_DAYS}-day window.`}
				</span>
				<div
					className="seg ml-auto"
					role="group"
					aria-label="Run table time range"
				>
					{WIKI_REPORT_DAYS_OPTIONS.map((p) => (
						<button
							key={p.value}
							type="button"
							className={days === p.value ? "active" : ""}
							aria-pressed={days === p.value}
							onClick={() => onChangeDays(p.value)}
						>
							{p.label}
						</button>
					))}
				</div>
			</div>
			<WikiReportsBody state={reportState} days={days} shared={shared} onRetry={onRetry} />
		</WikiDisclosureW>
	);
}

// One streak → "27 healthy runs in a row since …"; several → how many streaks the window holds.
function describeRunTableW(state, days) {
	if (window.UI.getRegionView(state) === "loading") return "Loading…";
	if (window.UI.getRegionView(state) === "error") return "Unavailable";

	const reports = state.data?.reports || [];
	if (reports.length === 0) return `No runs in ${days} d`;

	const groups = groupConstantRunsW(sortRunsNewestFirstW(reports));
	if (groups.length > 1) return `${reports.length} runs in ${groups.length} streaks`;

	const [only] = groups;
	const status = wikiStatusLabelW(only.newest.status).toLowerCase();
	return only.count === 1
		? `1 ${status} run on ${only.newest.run_date}`
		: `${only.count} ${status} runs in a row since ${only.oldest.run_date}`;
}

// The server returns runs ascending by run_date.
function sortRunsNewestFirstW(reports) {
	return [...reports].sort((a, b) =>
		(b.run_date || "").localeCompare(a.run_date || ""),
	);
}

// The server's p95 shares the cycles window, so it rides the same summary line.
function describeRunHistoryW(cyclesState, model, summaryState) {
	if (window.UI.getRegionView(cyclesState) === "loading") return null;
	if (window.UI.getRegionView(cyclesState) === "error") return "Unavailable";
	if (model.rows.length === 0) return "No runs in range";

	const p95 =
		summaryState.status === "ready" ? summaryState.data?.cycle_p95_ms : null;
	const runs = model.rows.length === 1 ? "run" : "runs";
	return `${model.rows.length} ${runs} in ${model.spanDays} d · last ${model.newestDate}${describeP95W(p95)}`;
}

/**
 * Collapsible section shell — label left, count right, body below the summary.
 * h2 inside the summary (HTML allows one heading there) → heading navigation lands on the toggle.
 * Follows UI.Disclosure's detail rule: a warn/crit `tone` opens it; a later recovery never force-closes it.
 */
function WikiDisclosureW({
	id,
	label,
	count,
	tone,
	bodyClassName = "px-3 pb-3",
	children,
}) {
	const isAlerting = window.UI.getDisclosureOpen("detail", tone);
	// Latched → the `open` prop never flips back to false, so React never closes a fold the reader left open.
	const [hasAlerted, setAlerted] = useStateW(isAlerting);

	useEffectW(() => {
		if (isAlerting) setAlerted(true);
	}, [isAlerting]);

	return (
		<details
			id={id}
			open={hasAlerted || undefined}
			onFocus={id ? openOnOwnFocusW : undefined}
			className="w-disclosure rounded-md border border-line bg-sunken"
		>
			<summary className="cursor-pointer select-none px-3 py-2 flex items-center gap-2 flex-wrap">
				<span className="w-chevron inline-block fs-meta text-faint" aria-hidden="true">
					▶
				</span>
				<h2 className="m-0 fs-body text-ink font-medium">{label}</h2>
				<span className="ml-auto fs-meta text-dim">{count}</span>
			</summary>
			<div className={bodyClassName}>{children}</div>
		</details>
	);
}

// A chip focusing the fold itself opens it; Tab landing on the summary does not.
function openOnOwnFocusW(event) {
	if (event.target === event.currentTarget) event.currentTarget.open = true;
}

// Open section shell — the status-card counterpart of WikiDisclosureW.
// Fills its split-row cell → a paired card ends level with its neighbour.
function WikiCardW({ id, label, count, children }) {
	return (
		<section id={id} className="rounded-md border border-line bg-sunken p-3 flex flex-col gap-2 min-w-0 h-full">
			<div className="flex items-center gap-2 flex-wrap">
				<h2 className="m-0 fs-body text-ink font-medium">{label}</h2>
				<span className="ml-auto fs-meta text-dim">{count}</span>
			</div>
			{children}
		</section>
	);
}

// Notes by type — the library's composition, open as a compact list.
function WikiNotesByTypeSection({ state, shared, onRetry }) {
	const { LoadingPlaceholder } = window.UI;
	const rows =
		state.status === "ready" && Array.isArray(state.data?.by_type)
			? buildNoteTypeRowsW(state.data.by_type)
			: [];
	const coverage = describeNoteCoverageW(rows);

	return (
		<WikiCardW id={WIKI_REGION_IDS.notesByType} label="Notes by type" count={describeNotesByTypeW(state)}>
			{window.UI.getRegionView(state) === "loading" ? (
				<LoadingPlaceholder label="note types" />
			) : window.UI.getRegionView(state) === "error" ? (
				<WikiRegionFailureW
					feeders={[WIKI_FEEDERS.notesByType]}
					source="notes by type"
					error={state.error}
					isBusy={state.busy}
					shared={shared}
					focusTargetId={WIKI_REGION_IDS.notesByType}
					onRetry={onRetry}
				/>
			) : rows.length === 0 ? (
				<EmptyStateW message="No notes indexed yet." />
			) : (
				<>
					<ul className="w-type-list flex flex-col gap-1.5 m-0 p-0 list-none">
						{rows.map((t) => (
							<li key={t.type} className="w-type-row fs-meta" title={t.type}>
								<span className="text-dim break-words">{t.label}</span>
								<span className="w-type-track" aria-hidden="true">
									<span className="w-type-fill" style={{ width: `${t.share}%` }} />
								</span>
								<span className="font-mono text-ink text-right">{formatCountW(t.count)}</span>
								<span className="font-mono text-faint text-right">{`${t.pct}%`}</span>
							</li>
						))}
					</ul>
					{coverage && (
						<div className="fs-meta text-faint leading-tight">{coverage}</div>
					)}
				</>
			)}
		</WikiCardW>
	);
}

// Internal note_type → reader label; an unlisted type keeps its name after "Other".
const NOTE_TYPE_LABELS = { raw: "Saved originals", "source-summary": "Summary notes" };

// Bar length = share of the largest type; pct = share of all notes.
function buildNoteTypeRowsW(rows) {
	const counts = rows.map((t) => Number(t.count) || 0);
	const max = Math.max(0, ...counts);
	const total = counts.reduce((sum, n) => sum + n, 0);
	return rows.map((t, i) => ({
		type: t.note_type,
		label: NOTE_TYPE_LABELS[t.note_type] || `Other · ${t.note_type}`,
		count: counts[i],
		share: max > 0 ? Math.round((counts[i] / max) * 100) : 0,
		pct: total > 0 ? Math.round((counts[i] / total) * 100) : 0,
	}));
}

// Summaries against the originals they cover; either type missing → no line.
function describeNoteCoverageW(rows) {
	const countOf = (type) => rows.find((t) => t.type === type)?.count;
	const summaries = countOf("source-summary");
	const originals = countOf("raw");
	if (typeof summaries !== "number" || typeof originals !== "number") return null;
	return `${formatCountW(summaries)} summary notes for ${formatCountW(originals)} saved originals`;
}

function describeNotesByTypeW(state) {
	if (window.UI.getRegionView(state) === "loading") return null;
	if (window.UI.getRegionView(state) === "error") return "Unavailable";
	const rows = Array.isArray(state.data?.by_type) ? state.data.by_type : [];
	return `${rows.length} types`;
}

// 백로그 stale 임계(일) — wiki 데몬 사이클이 일일 → run_date 가 1일 초과 경과면 stale.
// CYCLE_FRESH_OK_HOURS(24h)와 정합하되 run_date 는 날짜 단위라 일 카운트로 비교.
const BACKLOG_STALE_DAYS = 1;

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

// Status mix bar + legend — colour-blind-safe 4-cell proportion with a text legend.
function WikiStatusMixW({ mix }) {
	const { Icon } = window.UI;

	return (
		<>
			<div
				className="flex w-full h-2.5 rounded-full overflow-hidden bg-sunken"
				role="img"
				aria-label={`Run status mix: healthy ${mix.ok}%, warning ${mix.partial}%, down ${mix.error}%, usage limit ${mix.quota}%`}
			>
				<span
					className="w-mix-cell"
					style={{ width: `${mix.ok}%`, background: "rgb(var(--ok))" }}
				/>
				<span
					className="w-mix-cell"
					style={{ width: `${mix.partial}%`, background: "rgb(var(--warn))" }}
				/>
				<span
					className="w-mix-cell"
					style={{ width: `${mix.error}%`, background: "rgb(var(--crit))" }}
				/>
				<span
					className="w-mix-cell"
					style={{ width: `${mix.quota}%`, background: "rgb(var(--faint))" }}
				/>
			</div>
			<div className="flex flex-wrap gap-x-3 gap-y-1 fs-meta text-faint mt-1.5">
				{["ok", "partial", "error", "quota"].map((k) => (
					<span key={k} className="inline-flex items-center gap-1">
						<Icon
							name="circle"
							size={9}
							className={`text-${STATUS_CHIP_META[k].tone}`}
						/>
						{STATUS_CHIP_META[k].label} {mix[k]}%
					</span>
				))}
			</div>
		</>
	);
}

function buildThroughputModel(state) {
	if (state.status !== "ready") {
		return {
			rows: [],
			compiledSeries: [],
			compiledDates: [],
			mix: EMPTY_MIX,
			newestDate: "",
			spanDays: 0,
		};
	}

	const rows = state.data?.cycles || [];
	if (rows.length === 0) {
		return {
			rows: [],
			compiledSeries: [],
			compiledDates: [],
			mix: EMPTY_MIX,
			newestDate: "",
			spanDays: 0,
		};
	}

	// 서버 내림차순(최신 우선) → 미니바는 오래된→최신 순서로 ascending 재배열.
	const ascending = [...rows].sort((a, b) =>
		(a.run_date || "").localeCompare(b.run_date || ""),
	);
	const { dates: compiledDates, series: compiledSeries } = fillRunDaysW(ascending);
	// 비0 포인트 수 — 캡션의 active days 수치 · 희소 판정은 SparseTrendW 가 자체 계산.
	const nonZeroCount = compiledSeries.filter((v) => v > 0).length;

	const mix = computeStatusMix(rows);

	return {
		rows,
		compiledSeries,
		compiledDates,
		mix,
		isMixUniform: isNearUniformMixW(mix),
		newestDate: ascending[ascending.length - 1]?.run_date || "",
		activeDays: nonZeroCount,
		total: sumCompiledW(state),
		spanDays: compiledSeries.length,
	};
}

const EMPTY_MIX = { ok: 0, partial: 0, error: 0, quota: 0 };

const DAY_MS_W = 86_400_000;

// Every calendar day first run → last run; a day without a run reads zero, so bars sit on an even date axis.
function fillRunDaysW(ascending) {
	const compiledByDate = new Map();
	for (const r of ascending) {
		compiledByDate.set(r.run_date, (compiledByDate.get(r.run_date) || 0) + (Number(r.compiled_count) || 0));
	}
	const first = Date.parse(`${ascending[0].run_date}T00:00:00Z`);
	const last = Date.parse(`${ascending[ascending.length - 1].run_date}T00:00:00Z`);
	if (Number.isNaN(first) || Number.isNaN(last)) {
		return { dates: [...compiledByDate.keys()].map((d) => d || ""), series: [...compiledByDate.values()] };
	}

	const dates = [];
	for (let t = first; t <= last; t += DAY_MS_W) dates.push(new Date(t).toISOString().slice(0, 10));
	return { dates, series: dates.map((d) => compiledByDate.get(d) ?? 0) };
}

// ui.jsx CHART_MAX_TICKS — the chart's own tick ceiling.
const TREND_MAX_TICKS_W = 7;

// Largest tick cap that splits the count−1 day gaps into equal steps (first + last alone always do).
function getEvenTickCapW(count) {
	for (let cap = Math.min(TREND_MAX_TICKS_W, Math.max(2, count)); cap > 2; cap--) {
		if ((count - 1) % (cap - 1) === 0) return cap;
	}
	return 2;
}

// One status above this share of runs → the mix is near-uniform.
const STATUS_UNIFORM_PCT = 95;

function isNearUniformMixW(mix) {
	return Object.values(mix).some((pct) => pct > STATUS_UNIFORM_PCT);
}

const STATUS_CHIP_META = {
	ok: { tone: "ok", label: "Healthy" },
	partial: { tone: "warn", label: "Warning" },
	error: { tone: "crit", label: "Down" },
	quota: { tone: "faint", label: "Usage limit" },
};

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

// payload JSON dump(<pre>) 원형 표시 — dead-link · link-fix 목록 전용.
function BacklogExplorer({ label, count, payload }) {
	return (
		<WikiDisclosureW label={label} count={count}>
			<pre className="fs-meta font-mono text-dim whitespace-pre-wrap break-words m-0 max-h-64 overflow-y-auto">
				{stringifyPayloadW(payload)}
			</pre>
		</WikiDisclosureW>
	);
}

function MergeSuggestionItem({ proposal }) {
	const { Icon } = window.UI;

	const target = proposal.target_slug || "—";
	const sources = Array.isArray(proposal.source_slugs)
		? proposal.source_slugs.join(", ")
		: "—";
	const similarity =
		typeof proposal.similarity_score === "number"
			? `${Math.round(proposal.similarity_score * 100)}% similar`
			: null;
	const action = readProposalActionW(proposal);

	return (
		<li className="rounded border border-line bg-card px-2.5 py-1.5">
			<div className="flex items-baseline gap-2 flex-wrap fs-meta font-mono">
				<span className="text-ink font-medium break-words min-w-0">{target}</span>
				<span className="inline-flex items-center text-faint">
					<Icon name="arrow-left" size={12} />
				</span>
				<span className="text-dim break-words min-w-0">{sources}</span>
				{similarity && <span className="ml-auto text-dim">{similarity}</span>}
			</div>
			{action && (
				<div className="fs-meta text-faint mt-1 leading-tight break-words whitespace-pre-wrap">
					{action}
				</div>
			)}
		</li>
	);
}

// The cleaner tags every action DRY-RUN → the list states it once, each row keeps its own action.
const DRY_RUN_TAIL_W = /\s*DRY-RUN\b[\s\S]*$/;

// "Merge notes/a.md into notes/b.md." restates the row's target ← sources → the list explains the arrow once.
const MERGE_RESTATEMENT_W = /^Merge\s+\S.*\s+into\s+\S+$/i;

function readProposalActionW(proposal) {
	const action = (proposal.suggested_action || proposal.llm_verdict || "").replace(DRY_RUN_TAIL_W, "").trim();
	return MERGE_RESTATEMENT_W.test(action) ? "" : action;
}

function isDryRunProposalW(proposal) {
	return DRY_RUN_TAIL_W.test(proposal.suggested_action || "");
}

function WikiReportsBody({ state, days, shared, onRetry }) {
	if (window.UI.getRegionView(state) === "loading") {
		return <WikiReportsTable reports={[]} isLoading />;
	}
	if (window.UI.getRegionView(state) === "error") {
		return (
			<WikiRegionFailureW
				feeders={[WIKI_FEEDERS.runTable]}
				source="the run table"
				error={state.error}
				isBusy={state.busy}
				shared={shared}
				focusTargetId={WIKI_REGION_IDS.runTable}
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

	const sortedDesc = sortRunsNewestFirstW(reports);

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
          최신 우선 · 수치 셀 .num · 시각 relative-time · 상태 DAEMON_STATUS_TONE · 상태 톤은 배지만 담당. */}
			<WikiReportsTable reports={sortedDesc} />
		</div>
	);
}

const WIKI_REPORT_COLUMNS = [
	{ key: "run_date", label: "Run date" },
	{ key: "status", label: "Status" },
	{ key: "deadlinks", label: "Broken links", isNumeric: true },
	{ key: "dedup", label: "Duplicates", isNumeric: true },
	{ key: "started", label: "Started" },
];

// Rows flow in page scroll; the wrapper only scrolls sideways on a narrow pane.
function WikiReportsTable({ reports, isLoading = false }) {
	const { Badge, Table, SkeletonRows } = window.UI;

	return (
		<div className="overflow-x-auto rounded-md border border-line">
			<Table
				caption="Wiki compile runs, newest first, one row per run"
				columns={WIKI_REPORT_COLUMNS}
				className="w-report-tbl"
			>
				{isLoading ? (
					<SkeletonRows rows={5} columns={WIKI_REPORT_COLUMNS.length} rowHeight={36} />
				) : (
					reports.map((report) => (
						<WikiReportRow key={report.run_date} report={report} Badge={Badge} />
					))
				)}
			</Table>
		</div>
	);
}

// The status badge carries the tone; the row takes no stripe.
function WikiReportRow({ report, Badge }) {
	const tone = wikiStatusToneW(report.status);

	return (
		<tr>
			<td>
				<span className="font-mono text-ink font-medium">
					{report.run_date}
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

// Newest-first runs → one group per streak of equal status and backlog snapshot.
function groupConstantRunsW(reports) {
	const groups = [];
	for (const report of reports) {
		const current = groups[groups.length - 1];
		if (current && isSameRunW(current.oldest, report)) {
			current.oldest = report;
			current.count += 1;
		} else {
			groups.push({ newest: report, oldest: report, count: 1 });
		}
	}
	return groups;
}

function isSameRunW(a, b) {
	return (
		a.status === b.status &&
		a.deadlinks_count === b.deadlinks_count &&
		a.dedup_count === b.dedup_count
	);
}

// Shared chrome (wiki-scoped — health.jsx 패턴 미러).

function EmptyStateW({ message }) {
	const { EmptyState } = window.UI;
	return <EmptyState message={message} className="m-3" />;
}

// 희소 추세(비0 포인트 < SPARSE_MIN_NONZERO) 공용 렌더 — 넓은 트랙 외톨이 막대가 "차트 깨짐"으로 읽히는 문제 회피.
//   sparse → TrendChart 대신 한 줄 안내 · 헤드라인 수치(합계·활성일·피크)는 항상 차트 위.
//   충분히 채워진 시리즈(비0 ≥ SPARSE_MIN_NONZERO) → 패널 폭 TrendChart(막대별 날짜·값 readout).
function SparseTrendW({ label, series, dates, stat }) {
	const { TrendChart } = window.UI;
	const sparse = series.filter((v) => v > 0).length < SPARSE_MIN_NONZERO;
	const headline = [stat, describePeakW(series, dates)].filter(Boolean).join(" · ");

	return (
		<div>
			<div className="fs-body text-ink mb-1">{headline}</div>
			<div className="card-sub mb-1.5">{label}</div>
			{sparse ? (
				<div className="rounded-md border border-line bg-sunken px-3 py-2.5 fs-meta text-faint">
					Too few active days to draw a trend.
				</div>
			) : (
				<TrendChart
					label={label}
					kind="bars"
					tone="info"
					points={series.map((value, i) => ({ label: dates[i] || "", value }))}
					formatValue={formatCountW}
					yScale
					maxTicks={getEvenTickCapW(series.length)}
					h={112}
				/>
			)}
		</div>
	);
}

// First-occurring maximum and the day it fell on; an empty series names nothing.
function describePeakW(series, dates) {
	if (series.length === 0) return "";

	const peakIndex = series.indexOf(Math.max(...series));
	return `peak ${formatCountW(series[peakIndex])} on ${dates[peakIndex] || "an unknown day"}`;
}

// Pure helpers (wiki-scoped — health.jsx 미러).

async function fetchJsonW(url, signal) {
	const res = await fetch(url, {
		signal,
		headers: { Accept: "application/json" },
	});
	if (!res.ok) throw await window.UI.getFetchError(res);
	return res.json();
}

// resolves true only on a successful read → only those advance the header stamp
function runFetchW(url, request, setState) {
	const { putRegionData, putRegionFailure } = window.UI;
	return fetchJsonW(url, request.signal)
		.then((data) => {
			setState((st) => putRegionData(st, request, data));
			return true;
		})
		.catch((err) => {
			setState((st) => putRegionFailure(st, request, err));
			return false;
		});
}

// 공용 포매터 위임 (ui.jsx SoT) — 로컬 재구현 폐기. formatInt 가 wiki 가드(음수/NaN → '—') 승격 보유.
const formatCountW = window.UI.formatInt;

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
