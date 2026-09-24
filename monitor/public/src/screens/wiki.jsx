// 위키 화면 — wiki.* + core.daemon_runs PG 소스 (파일시스템 비결합). 알람 레인 + 타일 밴드 + 디스클로저 3종.
const {
	useState: useStateW,
	useEffect: useEffectW,
	useRef: useRefW,
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
	const [reportDays, setReportDays] = useStateW(30);

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
		<div className="flex flex-col">
			{/* 공유 타입스케일(.fs-* / --fs-*) 마운트 — wiki 화면 폰트 토큰 소비처. */}
			<TypeScaleStyle />
			<style>{`
        @keyframes skelPulseW { 0%,100%{opacity:.7} 50%{opacity:.35} }
        /* 상태 막대 셀 — status mix 비율 바 (0폭 셀도 보더 유지하지 않도록 min-w 0). */
        .w-mix-cell { min-width: 0; }
        /* per-run 보고 표 — 읽기 전용 RECORD(상세 드로어 없음) → .tbl 기본 pointer 커서/hover 무력화 (가짜 인터랙션 암시 방지). */
        .w-report-tbl tbody tr { cursor: default; }
        .w-report-tbl tbody tr:hover { background: transparent; }
        /* summary is a flex row, which drops the native marker → the screen draws its own chevron. */
        .w-disclosure > summary { list-style: none; }
        .w-disclosure > summary::-webkit-details-marker { display: none; }
        .w-disclosure[open] > summary .w-chevron { transform: rotate(90deg); }
      `}</style>

			<div className="flex-shrink-0">
				<PageHeader
					title="Wiki"
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
			</div>

			<div className="flex flex-col gap-4">
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
					onRetry={triggerRefresh}
				/>

				{/* Behind the click — working lists, run history, note composition. */}
				<WikiMaintenanceSection
					backlogState={backlogState}
					onRetry={triggerRefresh}
				/>
				<WikiRunHistorySection
					cyclesState={cyclesState}
					summaryState={summaryState}
					reportState={reportState}
					days={reportDays}
					onChangeDays={setReportDays}
					onRetry={triggerRefresh}
				/>
				<WikiNotesByTypeSection state={indexState} onRetry={triggerRefresh} />
			</div>
		</div>
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

	// Empty lane and unloaded lane must not look alike — silence only once every feeder answered.
	if (model.alarms.length === 0 && model.unchecked.length === 0) {
		return model.pending ? (
			<div className="fs-meta font-mono text-faint" aria-busy="true">
				Checking what needs attention…
			</div>
		) : null;
	}

	return (
		<ul
			className="flex flex-col gap-2 m-0 p-0 list-none"
			aria-label="Wiki alarms"
		>
			{model.alarms.map((alarm) => (
				<li
					key={alarm.key}
					className="rounded-md border border-line bg-sunken px-3 py-2 flex items-stretch gap-2.5"
				>
					<span className={`sev-bar ${alarm.tone}`} aria-hidden="true" />
					<Icon
						name={TONE_ICON[alarm.tone]}
						size={14}
						className={`text-${alarm.tone} mt-0.5 flex-shrink-0`}
					/>
					<span className="min-w-0">
						<span className="fs-body font-mono text-ink font-medium block">
							{alarm.label}
						</span>
						<span className="fs-micro font-mono text-faint block leading-tight">
							{alarm.detail}
						</span>
					</span>
				</li>
			))}
			{model.unchecked.length > 0 && (
				<li className="fs-micro font-mono text-faint">
					{`Couldn't check: ${model.unchecked.join(", ")} — the lane is incomplete.`}
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
			detail: `Last run ${summary.last_run_date || "unknown"} · ${hours} h ago — inspect launchd.`,
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
		summaryState.status === "loading" ||
		indexState.status === "loading" ||
		backlogState.status === "loading";

	// An errored feeder answers none of its checks, so the lane says so rather than reading clear.
	const unchecked = [
		[indexState, "search index"],
		[summaryState, "daily cycle"],
		[backlogState, "merge proposals"],
	]
		.filter(([state]) => state.status === "error")
		.map(([, label]) => label);

	return { alarms, pending, unchecked };
}

// One row per waiting proposal, each with its own age; rows sort by that age, so
// parked pairs land last and the longest-parked last of all.
function buildProposalAlarmsW(backlog, proposals, cyclesState) {
	// Undated rows share the run streak, read once for the whole lane.
	const runs = countUnchangedDedupRunsW(cyclesState);
	// Cycles still in flight → the streak is unknown, not absent.
	const checking = cyclesState.status === "loading";

	const rows = proposals.map((proposal, i) => {
		// No acknowledge path exists, so a parked pair is de-emphasised rather than hidden.
		const wait = readProposalWaitW(backlog, proposal);
		const age = wait ? wait.days : runs;
		const parked = wait
			? wait.days >= PROPOSAL_PARKED_DAYS
			: typeof runs === "number" && runs >= PROPOSAL_PARKED_RUNS;
		return {
			key: `proposal-${proposal?.cluster_hash || i}`,
			tone: parked ? "info" : "warn",
			label: `Merge proposal waiting on approval · ${proposal?.target_slug || proposal?.cluster_hash || "unnamed pair"}`,
			detail: wait
				? describeProposalWaitW(wait, parked)
				: describeProposalAgeW(runs, parked, checking),
			parked,
			age: typeof age === "number" ? age : 0,
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
// Steady state carries no status word and no tint; only an actionable state tints.

function WikiTileBand({ summaryState, indexState, backlogState, onRetry }) {
	const tiles = useMemoW(
		() => buildTileBandModel(summaryState, indexState, backlogState),
		[summaryState, indexState, backlogState],
	);
	const failures = readTileBandFailuresW(summaryState, indexState);

	return (
		<div className="flex flex-col gap-2">
			{failures.length > 0 && (
				<ErrorBannerW
					title={`Couldn't load the ${failures.join(" and ")} — the tiles below are incomplete`}
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
		[summaryState, "daily cycle summary"],
		[indexState, "search index"],
	]
		.filter(([state]) => state.status === "error")
		.map(([, label]) => label);
}

// Report surface → neutral chrome; a warn/crit tile carries its tone on a glyph beside the
// figure, leaving tinted containers to the alarm lane (39578 §C/§D).
function WikiTile({ tile }) {
	const { Icon, TONE_ICON } = window.UI;
	const alarmed = tile.tone === "warn" || tile.tone === "crit";

	return (
		<div className="rounded-md border border-line bg-sunken p-2.5 min-w-0">
			<div
				className="fs-micro font-mono text-faint uppercase tracking-wider truncate"
				title={tile.label}
			>
				{tile.label}
			</div>
			<div
				className={`font-mono fs-stat font-semibold mt-0.5 flex items-center gap-1.5 ${tile.state === "ready" ? "" : "text-faint"}`}
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
					className="fs-micro font-mono text-faint mt-1 leading-tight truncate"
					title={tile.sub}
				>
					{tile.sub}
				</div>
			)}
		</div>
	);
}

function buildTileBandModel(summaryState, indexState, backlogState) {
	return [
		buildLastRunTileW(summaryState),
		buildCompiledTileW(summaryState),
		buildIndexTileW(indexState),
		buildLibraryTileW(indexState, summaryState, backlogState),
	];
}

// Shared non-ready tile shapes — loading, error and unavailable stay distinguishable and
// none of them renders as a number (a zero nobody loaded is the failure mode).
// An errored tile carries no text of its own: the band's single banner names the failure.
function tilePlaceholderW(key, label, state) {
	const SUB = {
		loading: "Loading",
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
	if (state.status === "loading") return "loading";
	if (state.status === "error") return "error";
	return null;
}

function buildLastRunTileW(state) {
	const label = "Last run";
	const pending = tileFetchStateW(state);
	if (pending) return tilePlaceholderW("last-run", label, pending);

	const d = state.data || {};
	if (!d.last_cycle_started_at) {
		return tilePlaceholderW("last-run", label, "empty");
	}

	const hours = d.hours_since_last_cycle;
	const overdue = isCycleOverdueW(hours);
	const statusTone = wikiStatusToneW(d.last_status);
	const tone = overdue ? "crit" : statusTone === "ok" ? "neutral" : statusTone;

	return {
		key: "last-run",
		label,
		state: "ready",
		value: window.UI.formatRelativeTime(d.last_cycle_started_at),
		// Steady state names the cycle date only; a non-healthy run names what went wrong.
		sub: overdue
			? `Overdue · cycle ${d.last_run_date}`
			: tone === "neutral"
				? `Cycle ${d.last_run_date}`
				: `${wikiStatusLabelW(d.last_status)} · cycle ${d.last_run_date}`,
		tone,
	};
}

function buildCompiledTileW(state) {
	const label = "Compiled last cycle";
	const pending = tileFetchStateW(state);
	if (pending) return tilePlaceholderW("compiled", label, pending);

	const d = state.data || {};
	if (typeof d.latest_compiled_count !== "number") {
		return tilePlaceholderW("compiled", label, "unavailable");
	}

	return {
		key: "compiled",
		label,
		state: "ready",
		value: formatCountW(d.latest_compiled_count),
		sub: d.last_run_date ? `Cycle ${d.last_run_date}` : null,
		tone: "neutral",
	};
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
	if (flagMissing) return tilePlaceholderW("index", label, "unavailable");
	if (d.dirty === true) {
		return {
			key: "index",
			label,
			state: "ready",
			value: "Dirty",
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
		sub:
			typeof backlog === "number"
				? `${backlog === 0 ? "No" : formatCountW(backlog)} originals waiting${describeSnapshotAgeW(payload?.run_date)}`
				: "Backlog not reported",
		tone: "neutral",
	};
}

// Maintenance — one summary line above the fold, the working lists behind a click.
// The proposals list reports the cost-guard residue, since unverified candidate pairs
// make the proposal count a floor rather than a total.

function WikiMaintenanceSection({ backlogState, onRetry }) {
	const model = useMemoW(
		() => buildMaintenanceModel(backlogState),
		[backlogState],
	);

	if (model.state === "error") {
		return (
			<ErrorBannerW
				title="Couldn't load the maintenance backlog"
				detail={backlogState.error}
				onRetry={onRetry}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			<div
				className="fs-body font-mono text-dim"
				aria-busy={model.state === "loading" ? "true" : undefined}
			>
				{model.summaryLine}
			</div>

			{model.proposals && model.proposals.length > 0 && (
				<BacklogExplorer
					label="Merge proposals"
					count={model.proposals.length}
					payload={model.proposals}
				>
					<div className="flex flex-col gap-2">
						<ul className="flex flex-col gap-2 m-0 p-0 list-none max-h-64 overflow-y-auto">
							{model.proposals.map((proposal, i) => (
								<MergeSuggestionItem
									key={proposal.cluster_hash || i}
									proposal={proposal}
								/>
							))}
						</ul>
						{model.residueLine && (
							<div className="fs-micro font-mono text-faint leading-tight">
								{model.residueLine}
							</div>
						)}
					</div>
				</BacklogExplorer>
			)}

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

function buildMaintenanceModel(backlogState) {
	if (backlogState.status === "loading") {
		return { state: "loading", summaryLine: "Checking the maintenance backlog…" };
	}
	if (backlogState.status === "error") return { state: "error" };

	const backlog = backlogState.data?.backlog;
	if (!backlog) {
		return { state: "empty", summaryLine: "No maintenance cycle reported yet." };
	}

	const proposals = readProposalsW(backlog);
	const deadLinks = Array.isArray(backlog.deadlink_dryrun)
		? backlog.deadlink_dryrun
		: null;
	const linkFixes = Array.isArray(backlog.deadlink_fixes)
		? backlog.deadlink_fixes
		: null;
	const notVerified = readDedupW(backlog)?.not_verified;

	return {
		state: "ready",
		proposals,
		deadLinks,
		linkFixes,
		summaryLine: `${describeMaintenanceW(proposals, deadLinks)}${describeSnapshotAgeW(backlog.run_date)}`,
		residueLine:
			typeof notVerified === "number" && notVerified > 0
				? `${formatCountW(notVerified)} candidate pairs went unverified this cycle (cost guard) — the proposal count is a floor.`
				: null,
	};
}

// A missing key reads as "not reported", never as zero.
function describeMaintenanceW(proposals, deadLinks) {
	const proposalCount = proposals ? proposals.length : null;
	const deadCount = deadLinks ? deadLinks.length : null;

	if (proposalCount === 0 && deadCount === 0) {
		return "Nothing waiting — no merge proposals, no broken links.";
	}

	// Waiting proposals already carry their count on the disclosure header below.
	const parts = [
		proposalCount == null
			? "merge proposals not reported"
			: proposalCount === 0
				? "no merge proposals"
				: null,
		deadCount == null
			? "broken links not reported"
			: `${formatCountW(deadCount)} broken ${deadCount === 1 ? "link" : "links"}`,
	];
	return parts.filter(Boolean).join(" · ");
}

// Run history — volume and the per-run table, both behind one closed disclosure.
// The window control drives the table only; the chart and the status mix keep the
// fixed cycles window and say so.

function WikiRunHistorySection({
	cyclesState,
	summaryState,
	reportState,
	days,
	onChangeDays,
	onRetry,
}) {
	const model = useMemoW(
		() => buildThroughputModel(cyclesState),
		[cyclesState],
	);

	return (
		<WikiDisclosureW
			label="Run history"
			count={describeRunHistoryW(cyclesState, model, summaryState)}
			bodyClassName="px-3 pb-3 flex flex-col gap-3"
		>
			{cyclesState.status === "loading" ? (
				<ChartSkeletonW height={120} />
			) : cyclesState.status === "error" ? (
				<ErrorBannerW
					title="Couldn't load run history"
					detail={cyclesState.error}
					onRetry={onRetry}
				/>
			) : model.rows.length === 0 ? (
				<EmptyStateW
					message={`No wiki compile runs in the last ${WIKI_CYCLE_DAYS} days.`}
				/>
			) : (
				<>
					<SparseTrendW
						label={`Notes per day · last ${WIKI_CYCLE_DAYS} days`}
						series={model.compiledSeries}
						dates={model.compiledDates}
						stat={`${model.activeDays} active days of ${model.spanDays}`}
						w={10}
						h={44}
						tone="accent"
					/>
					{/* A near-uniform mix carries no information — only a mixed run set earns the bar. */}
					{!model.isMixUniform && <WikiStatusMixW mix={model.mix} />}
				</>
			)}

			<div className="pt-3 border-t border-line flex flex-col gap-2">
				<div className="flex items-center gap-2 flex-wrap">
					<span className="fs-micro font-mono text-faint uppercase tracking-wider">
						Per-run table
					</span>
					<div
						className="seg ml-auto"
						role="group"
						aria-label="Run table time range"
					>
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
				</div>
				<div className="fs-micro font-mono text-faint leading-tight">
					{`The window drives the table only — the figures above keep a fixed ${WIKI_CYCLE_DAYS}-day window.`}
				</div>
				<WikiReportsBody state={reportState} days={days} onRetry={onRetry} />
			</div>
		</WikiDisclosureW>
	);
}

// The server's p95 shares the cycles window, so it rides the same summary line.
function describeRunHistoryW(cyclesState, model, summaryState) {
	if (cyclesState.status === "loading") return "Loading…";
	if (cyclesState.status === "error") return "Unavailable";
	if (model.rows.length === 0) return "No runs in range";

	const p95 =
		summaryState.status === "ready" ? summaryState.data?.cycle_p95_ms : null;
	const p95Label =
		typeof p95 === "number"
			? ` · p95 ${window.UI.formatDuration(p95, "ms")}`
			: "";
	return `${model.spanDays} runs · last ${model.newestDate}${p95Label}`;
}

// Collapsible section shell — label left, count right, body below the summary.
function WikiDisclosureW({
	label,
	count,
	bodyClassName = "px-3 pb-3",
	children,
}) {
	return (
		<details className="w-disclosure rounded-md border border-line bg-sunken">
			<summary className="cursor-pointer select-none px-3 py-2 flex items-center gap-2 flex-wrap">
				<span className="w-chevron inline-block fs-micro text-faint" aria-hidden="true">
					▶
				</span>
				<span className="font-mono fs-body text-ink font-medium">{label}</span>
				<span className="ml-auto font-mono fs-meta text-dim">{count}</span>
			</summary>
			<div className={bodyClassName}>{children}</div>
		</details>
	);
}

// Notes by type — text rows; counts read as a list, not as a card grid.

function WikiNotesByTypeSection({ state, onRetry }) {
	const rows =
		state.status === "ready" && Array.isArray(state.data?.by_type)
			? state.data.by_type
			: [];

	return (
		<WikiDisclosureW
			label="Notes by type"
			count={describeNotesByTypeW(state)}
		>
			{state.status === "loading" ? (
				<div className="fs-meta font-mono text-faint" aria-busy="true">
					Loading note types…
				</div>
			) : state.status === "error" ? (
				<ErrorBannerW
					title="Couldn't load notes by type"
					detail={state.error}
					onRetry={onRetry}
				/>
			) : rows.length === 0 ? (
				<EmptyStateW message="No notes indexed yet." />
			) : (
				<ul className="flex flex-col gap-1 m-0 p-0 list-none">
					{rows.map((t) => (
						<li
							key={t.note_type}
							className="flex items-baseline gap-3 fs-meta font-mono"
						>
							<span className="text-dim truncate" title={t.note_type}>
								{t.note_type}
							</span>
							<span className="ml-auto text-ink">{formatCountW(t.count)}</span>
						</li>
					))}
				</ul>
			)}
		</WikiDisclosureW>
	);
}

function describeNotesByTypeW(state) {
	if (state.status === "loading") return "Loading…";
	if (state.status === "error") return "Unavailable";
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
			<div className="flex flex-wrap gap-x-3 gap-y-1 fs-micro font-mono text-faint mt-1.5">
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
	const compiledSeries = ascending.map((r) => Number(r.compiled_count) || 0);
	// 비0 포인트 수 — 캡션의 active days 수치 · 희소 판정은 SparseTrendW 가 자체 계산.
	const nonZeroCount = compiledSeries.filter((v) => v > 0).length;

	const mix = computeStatusMix(rows);

	return {
		rows,
		compiledSeries,
		compiledDates: ascending.map((r) => r.run_date || ""),
		mix,
		isMixUniform: isNearUniformMixW(mix),
		newestDate: ascending[ascending.length - 1]?.run_date || "",
		activeDays: nonZeroCount,
		spanDays: compiledSeries.length,
	};
}

const EMPTY_MIX = { ok: 0, partial: 0, error: 0, quota: 0 };

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

// children 미지정 = payload JSON dump(<pre>) 기본 거동 · children 지정 시 그 본문으로 대체 (구조 렌더 escape hatch).
function BacklogExplorer({ label, count, payload, children }) {
	return (
		<WikiDisclosureW label={label} count={count}>
			{children != null ? (
				children
			) : (
				<pre className="fs-meta font-mono text-dim whitespace-pre-wrap break-words m-0 max-h-64 overflow-y-auto">
					{stringifyPayloadW(payload)}
				</pre>
			)}
		</WikiDisclosureW>
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

function EmptyStateW({ message }) {
	const { EmptyState } = window.UI;
	return <EmptyState message={message} className="m-3" />;
}

// 희소 추세(비0 포인트 < SPARSE_MIN_NONZERO) 공용 렌더 — 넓은 트랙 외톨이 막대가 "차트 깨짐"으로 읽히는 문제 회피.
//   sparse → MiniBars 대신 compact stat(최신/대표값) + "no activity in range" 빈상태로 대체.
//   충분히 채워진 시리즈(비0 ≥ SPARSE_MIN_NONZERO) → 종전대로 MiniBars 렌더. tone = MiniBars 색(text-* 컨테이너에서 상속).
function SparseTrendW({ label, series, dates, stat, w, h, tone }) {
	const { MiniBars } = window.UI;
	const sparse = series.filter((v) => v > 0).length < SPARSE_MIN_NONZERO;
	const caption = [describePeakW(series, dates), stat].filter(Boolean).join(" · ");
	const firstDate = dates[0] || "";
	const lastDate = dates[dates.length - 1] || "";

	return (
		<div>
			<div className="card-sub mb-1.5">{label}</div>
			{sparse ? (
				<div className="rounded-md border border-line bg-sunken px-3 py-2.5 flex items-baseline justify-between gap-3">
					<span className="font-mono fs-body text-dim">{caption}</span>
					<span className="fs-micro font-mono text-faint">
						no activity in range
					</span>
				</div>
			) : (
				<>
					<div
						role="img"
						aria-label={`${label} from ${firstDate} to ${lastDate}: ${caption}`}
						className="inline-flex flex-col"
					>
						<div className={`text-${tone}`}>
							<MiniBars data={series} w={Math.max(series.length * w, 60)} h={h} />
						</div>
						<div className="flex justify-between gap-3 fs-micro font-mono text-faint">
							<span>{firstDate}</span>
							<span>{lastDate}</span>
						</div>
					</div>
					<div className="fs-micro font-mono text-dim">{caption}</div>
				</>
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
