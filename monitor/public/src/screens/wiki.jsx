// 위키 화면 — wiki.* + core.daemon_runs PG 소스 (파일시스템 비결합). 알람 레인 + 타일 밴드 + 디스클로저 3종.
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
		[summaryState, "summary"],
		[cyclesState, "run history"],
		[indexState, "notes by type"],
		[backlogState, "maintenance backlog"],
		[reportState, "per-run table"],
	];
	const waveStates = waveSections.map(([state]) => state);
	const isBusy = getRegionSummary(waveStates).isBusy;
	const hasRead = settledAt != null || waveStates.some((st) => st.data != null);
	const outage = readWikiOutageW(waveSections);
	// a shared outage owns the page's single Retry → sections stay quiet
	const sectionRetry = outage ? undefined : triggerRefresh;

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
        .w-alarm-open { min-height: var(--ctl-min-h); cursor: pointer; }
        /* base.css tints only status tones → a parked (neutral) glyph recedes locally. */
        .alarm-row[data-tone="neutral"] .alarm-row-glyph { color: rgb(var(--dim)); }
        /* Name, bar and count stay within reading distance on a wide panel. */
        .w-type-list { max-width: 40rem; }
        .w-type-row { display: grid; grid-template-columns: minmax(0, 12rem) minmax(0, 1fr) 4rem; align-items: center; gap: 0.75rem; }
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
					/>
				)}
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
					onRetry={sectionRetry}
				/>

				{/* Behind the click — working lists, run history, note composition. */}
				<WikiMaintenanceSection
					backlogState={backlogState}
					cyclesState={cyclesState}
					onRetry={sectionRetry}
				/>
				<WikiRunHistorySection
					cyclesState={cyclesState}
					summaryState={summaryState}
					reportState={reportState}
					days={reportDays}
					onChangeDays={setReportDays}
					onRetry={sectionRetry}
				/>
				<WikiNotesByTypeSection state={indexState} onRetry={sectionRetry} />
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
			{model.alarms.map((alarm) => (
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
					{alarm.anchorId && (
						<button
							type="button"
							className="w-alarm-open fs-meta text-accent px-2 self-center"
							aria-label={`Open proposal: ${alarm.label}`}
							onClick={() => openProposalW(alarm.anchorId)}
						>
							Open proposal
						</button>
					)}
				</li>
			))}
			{model.unchecked.length > 0 && (
				<li className="fs-meta text-faint px-4 py-2">
					{`Couldn't check: ${model.unchecked.join(", ")} — the lane is incomplete.`}
				</li>
			)}
		</ul>
	);
}

// Element id of a proposal's list item; a pair without a hash has no stable anchor.
function getProposalAnchorIdW(hash) {
	if (typeof hash !== "string" || hash === "") return null;
	return `wiki-proposal-${hash.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

// Opens the disclosure holding the item, then moves focus onto it.
function openProposalW(anchorId) {
	const item = document.getElementById(anchorId);
	if (!item) return;

	const disclosure = item.closest("details");
	if (disclosure) disclosure.open = true;
	item.scrollIntoView({ block: "nearest" });
	item.focus();
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
			// cyan belongs to the chart series → a parked pair recedes to neutral, not info.
			tone: parked ? "neutral" : "warn",
			label: `Merge proposal waiting on approval · ${proposal?.target_slug || proposal?.cluster_hash || "unnamed pair"}`,
			detail: wait
				? describeProposalWaitW(wait, parked)
				: describeProposalAgeW(runs, parked, checking),
			parked,
			age: typeof age === "number" ? age : 0,
			anchorId: getProposalAnchorIdW(proposal?.cluster_hash),
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
// Steady state carries no status word and no tint; only an actionable state tints.

function WikiTileBand({ summaryState, indexState, backlogState, onRetry }) {
	const { RegionUnavailable } = window.UI;
	const tiles = useMemoW(
		() => buildTileBandModel(summaryState, indexState, backlogState),
		[summaryState, indexState, backlogState],
	);
	const failures = readTileBandFailuresW(summaryState, indexState);

	return (
		<div className="flex flex-col gap-2">
			{failures.length > 0 && (
				<RegionUnavailable
					source={`the ${failures.join(" and ")}`}
					error={summaryState.error ?? indexState.error}
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
				className="fs-meta text-faint truncate"
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
					className="fs-meta text-faint mt-1 leading-tight truncate"
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
	// No row yet → say what is unknown rather than show a bare dash.
	if (flagMissing) {
		return {
			...tilePlaceholderW("index", label, "unavailable"),
			value: "Untracked",
			sub: "No dirty flag on record — cleanliness unknown",
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

function WikiMaintenanceSection({ backlogState, cyclesState, onRetry }) {
	const { RegionUnavailable, LoadingPlaceholder } = window.UI;
	const model = useMemoW(
		() => buildMaintenanceModel(backlogState, cyclesState),
		[backlogState, cyclesState],
	);

	return (
		<div className="flex flex-col gap-2">
			{model.state === "error" ? (
				<RegionUnavailable
					source="the maintenance backlog"
					error={backlogState.error}
					onRetry={onRetry}
				/>
			) : null}

			{/* Always present, so the lane's "Open proposal" and the page layout never lose it. */}
			<WikiDisclosureW
				label="Merge proposals"
				count={describeProposalCountW(model)}
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

const UNKNOWN_CYCLES_W = { status: "idle", data: null, error: null };

function buildMaintenanceModel(backlogState, cyclesState = UNKNOWN_CYCLES_W) {
	if (backlogState.status === "loading") {
		return { state: "loading" };
	}
	if (backlogState.status === "error") return { state: "error" };

	const backlog = backlogState.data?.backlog;
	if (!backlog) {
		return { state: "empty" };
	}

	const proposals = orderProposalsW(backlog, readProposalsW(backlog), cyclesState);
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
		residueLine:
			typeof notVerified === "number" && notVerified > 0
				? `${formatCountW(notVerified)} candidate pairs went unverified this cycle (cost guard) — the proposal count is a floor.`
				: null,
	};
}

// The lane's order, so row N in the lane is row N in the list.
function orderProposalsW(backlog, proposals, cyclesState) {
	if (!proposals) return proposals;
	return buildProposalAlarmsW(backlog, proposals, cyclesState).map((row) => row.proposal);
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
	const { RegionUnavailable, LoadingPlaceholder, SectionLabel } = window.UI;
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
				<LoadingPlaceholder label="run history" minHeight={120} />
			) : cyclesState.status === "error" ? (
				<RegionUnavailable
					source="run history"
					error={cyclesState.error}
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
					/>
					{/* A near-uniform mix carries no information — only a mixed run set earns the bar. */}
					{!model.isMixUniform && <WikiStatusMixW mix={model.mix} />}
				</>
			)}

			<div className="pt-3 border-t border-line flex flex-col gap-2">
				<div className="flex items-center gap-2 flex-wrap">
					<SectionLabel level={3} className="m-0">
						Per-run table
					</SectionLabel>
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
				<div className="fs-meta text-faint leading-tight">
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

/**
 * Collapsible section shell — label left, count right, body below the summary.
 * h2 inside the summary (HTML allows one heading there) → heading navigation lands on the toggle.
 */
function WikiDisclosureW({
	label,
	count,
	bodyClassName = "px-3 pb-3",
	children,
}) {
	return (
		<details className="w-disclosure rounded-md border border-line bg-sunken">
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

// Notes by type — text rows; counts read as a list, not as a card grid.

function WikiNotesByTypeSection({ state, onRetry }) {
	const { RegionUnavailable, LoadingPlaceholder } = window.UI;
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
				<LoadingPlaceholder label="note types" />
			) : state.status === "error" ? (
				<RegionUnavailable
					source="notes by type"
					error={state.error}
					onRetry={onRetry}
				/>
			) : rows.length === 0 ? (
				<EmptyStateW message="No notes indexed yet." />
			) : (
				<ul className="w-type-list flex flex-col gap-1.5 m-0 p-0 list-none">
					{buildNoteTypeRowsW(rows).map((t) => (
						<li key={t.type} className="w-type-row fs-meta font-mono">
							<span className="text-dim break-words">{t.type}</span>
							<span className="w-type-track" aria-hidden="true">
								<span className="w-type-fill" style={{ width: `${t.share}%` }} />
							</span>
							<span className="text-ink text-right">{formatCountW(t.count)}</span>
						</li>
					))}
				</ul>
			)}
		</WikiDisclosureW>
	);
}

// Bar length = the count's share of the largest type.
function buildNoteTypeRowsW(rows) {
	const max = Math.max(0, ...rows.map((t) => Number(t.count) || 0));
	return rows.map((t) => {
		const count = Number(t.count) || 0;
		return {
			type: t.note_type,
			count,
			share: max > 0 ? Math.round((count / max) * 100) : 0,
		};
	});
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
	const sim =
		typeof proposal.similarity_score === "number"
			? `${Math.round(proposal.similarity_score * 100)}%`
			: "—";
	const action = proposal.suggested_action || proposal.llm_verdict || "";

	return (
		<li
			id={getProposalAnchorIdW(proposal.cluster_hash) || undefined}
			tabIndex={-1}
			className="rounded border border-line bg-card px-2.5 py-1.5"
		>
			<div className="flex items-baseline gap-2 flex-wrap fs-meta font-mono">
				<span className="text-ink font-medium break-words min-w-0">{target}</span>
				<span className="inline-flex items-center text-faint">
					<Icon name="arrow-left" size={12} />
				</span>
				<span className="text-dim break-words min-w-0">{sources}</span>
				<span className="ml-auto text-dim">sim {sim}</span>
			</div>
			{action && (
				<div className="fs-meta text-faint mt-1 leading-tight break-words whitespace-pre-wrap">
					{action}
				</div>
			)}
		</li>
	);
}

function WikiReportsBody({ state, days, onRetry }) {
	const { RegionUnavailable } = window.UI;
	if (state.status === "loading") {
		return <WikiReportsTable reports={[]} isLoading />;
	}
	if (state.status === "error") {
		return (
			<RegionUnavailable
				source="the run table"
				error={state.error}
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
				caption="Wiki compile runs, newest first; unchanged consecutive runs share a row"
				columns={WIKI_REPORT_COLUMNS}
				className="w-report-tbl"
			>
				{isLoading ? (
					<SkeletonRows rows={5} columns={WIKI_REPORT_COLUMNS.length} rowHeight={36} />
				) : (
					groupConstantRunsW(reports).map((group) => (
						<WikiReportRow key={group.key} group={group} Badge={Badge} />
					))
				)}
			</Table>
		</div>
	);
}

// The status badge carries the tone; the row takes no stripe.
function WikiReportRow({ group, Badge }) {
	const report = group.newest;
	const tone = wikiStatusToneW(report.status);
	const range =
		group.count > 1
			? `${group.oldest.run_date} – ${report.run_date}`
			: report.run_date;

	return (
		<tr>
			<td>
				<span className="font-mono text-ink font-medium">
					{range}
					{group.count > 1 && (
						<span className="text-faint font-normal">{` · ${group.count} runs`}</span>
					)}
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
			groups.push({ key: report.run_date, newest: report, oldest: report, count: 1 });
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
//   sparse → TrendChart 대신 compact stat(최신/대표값) + "no activity in range" 빈상태로 대체.
//   충분히 채워진 시리즈(비0 ≥ SPARSE_MIN_NONZERO) → 패널 폭 TrendChart(막대별 날짜·값 readout).
function SparseTrendW({ label, series, dates, stat }) {
	const { TrendChart } = window.UI;
	const sparse = series.filter((v) => v > 0).length < SPARSE_MIN_NONZERO;
	const caption = [describePeakW(series, dates), stat].filter(Boolean).join(" · ");

	return (
		<div>
			<div className="card-sub mb-1.5">{label}</div>
			{sparse ? (
				<div className="rounded-md border border-line bg-sunken px-3 py-2.5 flex items-baseline justify-between gap-3">
					<span className="fs-body text-dim">{caption}</span>
					<span className="fs-meta text-faint">
						no activity in range
					</span>
				</div>
			) : (
				<>
					<TrendChart
						label={label}
						kind="bars"
						tone="info"
						points={series.map((value, i) => ({ label: dates[i] || "", value }))}
						formatValue={formatCountW}
					/>
					<div className="fs-meta text-dim mt-1">{caption}</div>
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
