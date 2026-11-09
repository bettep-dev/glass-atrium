// Learning 화면의 계기판(instrumentation) 뷰 — 루프 자체가 아니라 루프의 측정 장치를 읽는
// 두 번째 독자용 패널 묶음. 운영 독자가 쓰는 표면(알람 레인 · 상태 밴드 · 제안 보드 · 패턴
// 원장)은 improvement.jsx 에 남고, 이 파일은 그 화면 안에서 전환되는 뷰이지 별도 nav 항목이
// 아니다. 데이터는 화면이 이미 받은 fetch-state 를 props 로 받는다 — 같은 payload 를 두 번
// 받으면 두 뷰가 서로 다른 시점을 보여준다.

const formatIntI = window.UI.formatInt;

// improvement.jsx 가 window.ImprovementShared 로 공개하는 화면 공용 원자. 렌더 시점에 풀어야
// 번들 로드 순서에 묶이지 않는다 — 배지/기호 판정은 원본 한 곳에만 둔다.
function SymI(props) {
	return React.createElement(window.ImprovementShared.SymI, props);
}

const confidenceBadgeMetaI = (value) =>
	window.ImprovementShared.confidenceBadgeMetaI(value);

// Slot wrappers outlive the error ↔ card swap → a Retry unmounting on recovery hands focus to its own slot
const PAYLOAD_SLOT_ID_I = Object.freeze({
	flaggedResults: "improvement-flagged-results",
	corpusGrowth: "improvement-corpus-growth",
	correctionSignals: "improvement-correction-signals",
	proposalMeasurements: "improvement-proposal-measurements",
});

// One banner per failed payload, in place of the group that payload owns.
// `source` = the page's region name, so a shared outage banner naming it quiets this card
function PayloadErrorCardI({ title, source, state, onRetry, failures, focusTargetId }) {
	const { Card, RegionFailure } = window.UI;
	return (
		<Card title={title}>
			<RegionFailure
				source={source}
				error={state.error}
				isBusy={state.busy}
				failures={failures}
				focusTargetId={focusTargetId}
				onRetry={onRetry}
			/>
		</Card>
	);
}

// 플래그된 결과 — 운영 밴드가 아니라 계기판에 산다. 이 수는 루프가 무엇을 내놓았는지가
// 아니라 판정기가 무엇을 걸렀는지를 말하고, 걸린 행 자체는 Task results 가 소유한다.
function FlaggedResultsCardI({ state, reviewReasons, onNav }) {
	const { Card, Icon, LoadingPlaceholder, Stack, StatRow } = window.UI;
	const title = "Flagged results (7 days)";

	if (state.status === "error") return null;
	if (state.status === "loading" || !state.data) {
		return (
			<Card title={title}>
				<LoadingPlaceholder label="flagged results" minHeight={60} />
			</Card>
		);
	}

	return (
		<Card
			title={title}
			sub="Quarantined rows excluded"
			right={
					<button
						className="btn ghost sm"
						onClick={() => {
							if (typeof onNav === "function") onNav("outcomes");
						}}
						aria-label="Open the flagged rows on the Task results screen"
					>
						Task results <Icon name="arrow-right" size={14} />
					</button>
			}
		>
			<Stack gap="block">
				<StatRow stats={[{ key: "flagged", label: "Flagged rows", value: formatIntI(Number(state.data.review_flag_last_7d ?? 0)) }]} />
				<FlaggedReasonBarsI segments={reviewReasons} />
			</Stack>
		</Card>
	);
}

// Ranked reason bars — the dominant reason leads; bar length relative to the largest.
function FlaggedReasonBarsI({ segments }) {
	const { Bar } = window.UI;
	const ranked = getRankedReasonsI(segments);

	if (ranked.length === 0) {
		return (
			<div className="card-sub fs-meta">
				Outcomes flagged in the last 7 days
			</div>
		);
	}

	return (
		<ul
			className="stack stack--list"
			aria-label={`Why results were flagged — ${segments.classifiedTotal} rows classified`}
		>
			{ranked.map((s) => (
				<li
					key={s.key}
					className="grid grid-cols-[minmax(0,14rem)_1fr_3.5rem] gap-x-control items-center fs-meta"
					title={s.title}
				>
					<span className="truncate">{s.label}</span>
					<Bar
						value={s.count}
						max={ranked[0].count}
						ariaLabel={`${s.label} ${formatIntI(s.count)}`}
					/>
					<span className="tnum text-right">
						{formatIntI(s.count)}
					</span>
				</li>
			))}
		</ul>
	);
}

// Stable sort → ties keep the shared REVIEW_FLAG_REASON_ORDER the segments arrive in.
function getRankedReasonsI(segments) {
	if (!segments) return [];
	return [...segments.items].sort((a, b) => b.count - a.count);
}

// 계기판 뷰 — 패널 순서는 relocate 이전 화면 순서를 그대로 보존한다.
function ImprovementInstrumentationViewI({
	statsState,
	listState,
	correctionState,
	corpusAuditState,
	styleRef,
	proseOnlyAdd,
	tierBreakdown,
	confidenceDist,
	reviewReasons,
	onNav,
	onRetry,
	failures,
}) {
	const { SplitRow, SplitColumn, getRegionView } = window.UI;

	return (
		<div className="space-sections">
			<div id={PAYLOAD_SLOT_ID_I.flaggedResults}>
				{getRegionView(statsState) === "error" ? (
					<PayloadErrorCardI
						focusTargetId={PAYLOAD_SLOT_ID_I.flaggedResults}
						title="Flagged results"
						source="loop stats"
						failures={failures}
						state={statsState}
						onRetry={onRetry}
					/>
				) : (
					<FlaggedResultsCardI
						state={statsState}
						reviewReasons={reviewReasons}
						onNav={onNav}
					/>
				)}
			</div>
			<SplitRow ratio="1:1" layout="equal">
				<div id={PAYLOAD_SLOT_ID_I.corpusGrowth}>
					{getRegionView(corpusAuditState) === "error" ? (
						<PayloadErrorCardI
							focusTargetId={PAYLOAD_SLOT_ID_I.corpusGrowth}
							title="Corpus growth"
							source="corpus audits"
							failures={failures}
							state={corpusAuditState}
							onRetry={onRetry}
						/>
					) : (
						<CorpusGrowthCardI state={corpusAuditState} />
					)}
				</div>
				<div id={PAYLOAD_SLOT_ID_I.correctionSignals}>
					{getRegionView(correctionState) === "error" ? (
						<PayloadErrorCardI
							focusTargetId={PAYLOAD_SLOT_ID_I.correctionSignals}
							title="Correction signals"
							source="correction signals"
							failures={failures}
							state={correctionState}
							onRetry={onRetry}
						/>
					) : (
						<CorrectionSignalsCardI state={correctionState} />
					)}
				</div>
			</SplitRow>
			<div id={PAYLOAD_SLOT_ID_I.proposalMeasurements} className="space-sections">
				{getRegionView(listState) === "error" ? (
					<PayloadErrorCardI
						focusTargetId={PAYLOAD_SLOT_ID_I.proposalMeasurements}
						title="Proposal measurements"
						source="suggestions"
						failures={failures}
						state={listState}
						onRetry={onRetry}
					/>
				) : (
					<>
						<StyleRefCardI state={listState} styleRef={styleRef} />
						{/* two short gauges stack → the pair fills Confidence's height instead of stretching one half-empty */}
						<SplitRow ratio="1:1" layout="equal">
							<SplitColumn>
								<ProseOnlyAddCardI state={listState} summary={proseOnlyAdd} />
								<TierBreakdownCardI state={listState} tierBreakdown={tierBreakdown} />
							</SplitColumn>
							<ConfidenceDistCardI
								state={listState}
								confidenceDist={confidenceDist}
							/>
						</SplitRow>
					</>
				)}
			</div>
		</div>
	);
}

// ----- TierBreakdown card ------------------
//
// 3-Tier Eval Grader rollout baseline cohort split. Fixed 30d window.
// one stat row, a hairline between stats:
//   - Code-Based PASS  (metric_pass=TRUE  AND baseline IS NULL)
//   - Code-Based FAIL  (metric_pass=FALSE AND baseline IS NULL)
//   - Pre-3Tier baseline (baseline_pre_3tier=TRUE)
//   - Total cohort = sum
//
// 데이터 부재 분기:
//   - 모든 카운트 0 → "데이터 부재" 회색 indicator (migration 미적용 OR 30d 빈 cohort)
//   - error 상태 → 뷰가 카드 대신 목록 payload 오류 배너 1개를 렌더

const TIER_BREAKDOWN_SUB_I = "30 days · self-reported";

function TierBreakdownCardI({ state, tierBreakdown }) {
	const { Card, EmptyState, LoadingPlaceholder, StatRow } = window.UI;
	const title = "Results by check status";
	if (state.status === "error") return null;
	if (state.status === "loading" || !tierBreakdown) {
		return (
			<Card title={title} sub={TIER_BREAKDOWN_SUB_I}>
				<LoadingPlaceholder label="check-status results" minHeight={68} />
			</Card>
		);
	}

	const passCnt = Number(tierBreakdown.code_based_pass_30d ?? 0);
	const failCnt = Number(tierBreakdown.code_based_fail_30d ?? 0);
	const baselineCnt = Number(tierBreakdown.pre_3tier_baseline_count ?? 0);
	const totalCnt = passCnt + failCnt + baselineCnt;
	const windowDays = Number(tierBreakdown.window_days ?? 30);

	// 데이터 부재 — migration 미적용 OR 30d 빈 cohort → 안내 indicator.
	if (totalCnt === 0) {
		return (
			<Card title={title} sub={TIER_BREAKDOWN_SUB_I}>
				<EmptyState message={`No tasks in the last ${windowDays} days`} />
			</Card>
		);
	}

	// Pass-rate denominator는 baseline 제외 (code-based 만 의미 있는 비율).
	const codeBasedTotal = passCnt + failCnt;
	const passRatePct =
		codeBasedTotal === 0 ? null : (passCnt / codeBasedTotal) * 100;

	const stats = [
		{
			key: "pass",
			label: <><SymI s="✓" className="text-ok" size={12} /> Pass</>,
			value: formatIntI(passCnt),
			context: passRatePct === null ? "nothing checked" : `pass rate ${passRatePct.toFixed(1)}%`,
		},
		{
			key: "fail",
			label: <><SymI s="✕" className="text-crit" size={12} /> Fail</>,
			value: formatIntI(failCnt),
			context: `${formatIntI(codeBasedTotal)} checked`,
		},
		{ key: "legacy", label: "Legacy", value: formatIntI(baselineCnt) },
		{ key: "total", label: "Total", value: formatIntI(totalCnt) },
	];

	return (
		<Card
			title={title}
			sub={TIER_BREAKDOWN_SUB_I}
			info="Pass and Fail are each task's self-reported result, recorded since automatic checking began; the pass rate uses these two only. Legacy counts tasks recorded before automatic checking."
		>
			<StatRow stats={stats} />
		</Card>
	);
}

// ----- ConfidenceDist card -------------------
//
// confidence_observed × promotion_tier 분포. 사용자 선택 window (proposal-side).
// headline stat + 척도 bar:
//   - Overall confidence_observed (전체 가중 평균 · NULL → "미산정")
// + per-lane 분포 표 (행=lane / 열=3: lane · proposal_count · confidence_avg).
//
// 데이터 부재 분기:
//   - buckets 비어있음 → "데이터 부재" 회색 indicator (daemon-wiring 미적용 OR window 0건)
//   - error 상태 → 뷰가 카드 대신 목록 payload 오류 배너 1개를 렌더

function ConfidenceDistCardI({ state, confidenceDist }) {
	const { Card, BulletBar, EmptyState, LoadingPlaceholder, StatRow } = window.UI;
	const title = "Suggestion confidence";
	const sub = "Measured · 30 days";
	if (state.status === "error") return null;
	if (state.status === "loading" || !confidenceDist) {
		return (
			<Card title={title} sub={sub}>
				<LoadingPlaceholder label="suggestion confidence" minHeight={68} />
			</Card>
		);
	}

	const buckets = Array.isArray(confidenceDist.buckets)
		? confidenceDist.buckets
		: [];
	const overallAvg = confidenceDist.overall_confidence_observed_avg;
	const totalProposals = buckets.reduce(
		(sum, b) => sum + Number(b.proposal_count ?? 0),
		0,
	);
	// 측정분 분모 — overall avg 는 confidence_observed_avg 가 non-null 인 lane 만 가중
	// (NULL-avg lane 제외). 측정분 = 해당 lane proposal_count 합 → 라벨에 측정분/전체 병기.
	const measuredProposals = buckets.reduce(
		(sum, b) =>
			sum +
			(b.confidence_observed_avg === null ||
			b.confidence_observed_avg === undefined
				? 0
				: Number(b.proposal_count ?? 0)),
		0,
	);

	// 데이터 부재 — window 내 proposal 0건 (실측 신뢰도 산정은 활성 상태).
	// 카드 숨김 대신 "데이터 없음" 명시 (proposal 발생 시 자동 데이터 표시).
	if (buckets.length === 0 || totalProposals === 0) {
		return (
			<Card title={title} sub={sub}>
				<EmptyState message="No suggestions in the last 30 days" />
			</Card>
		);
	}

	const overallBadge = confidenceBadgeMetaI(overallAvg);
	// C5: 실측 신뢰도(0-1 empirical posterior)를 척도상 위치(BulletBar)로 표시 — 숫자는 유지.
	// zone 밴드 = confidenceBadgeMetaI 의 0.4/0.7 cut-point 와 동일(low/medium/high).
	const hasOverall =
		overallAvg !== null &&
		overallAvg !== undefined &&
		!Number.isNaN(Number(overallAvg));
	const stats = [
		{
			key: "overall",
			label: <><SymI s={overallBadge.symbol} className={overallBadge.tone} size={12} /> Avg confidence (measured)</>,
			value: hasOverall ? formatRateI(overallAvg) : null,
			context: `Measured ${formatIntI(measuredProposals)}/${formatIntI(totalProposals)}`,
		},
	];

	return (
		<Card title={title} sub={sub} isFlush>
			<TableBodyI
				lead={<>
					<StatRow stats={stats} />
					{hasOverall && (
						<BulletBar
							value={Number(overallAvg)}
							showValue
							zones={[
								{ upTo: 0.4, tone: "crit" },
								{ upTo: 0.7, tone: "warn" },
								{ upTo: 1, tone: "ok" },
							]}
							ariaLabel={`Average measured confidence ${(Number(overallAvg) * 100).toFixed(0)}%`}
						/>
					)}
				</>}
			>
				<ConfidenceLaneTableI buckets={buckets} />
			</TableBodyI>
		</Card>
	);
}

// flush body for a table under lead blocks — the leads take the card-pad inset, the table's edge cells already carry it
function TableBodyI({ lead, children }) {
	const { Stack } = window.UI;
	return (
		<Stack gap="block" className="pt-card-pad">
			<Stack gap="block" className="px-card-pad">{lead}</Stack>
			{children}
		</Stack>
	);
}

// raw COALESCE fallback 'unassigned'(promotion_tier NULL) → 사용자친화 라벨.
// 원시문자열 노출 차단 · 그 외 tier 는 원형 유지.
function laneLabelI(promotionTier) {
	if (promotionTier === "unassigned") return "Unassigned";
	return promotionTier;
}

// per-lane 분포 표 — 행=lane (가변) / 열=3 (lane · proposal_count · confidence_avg).
const LANE_COLUMNS_I = Object.freeze([
	{ key: "group", label: "Group" },
	{ key: "suggestions", label: "Suggestions", isNumeric: true },
	{ key: "avg", label: "Avg confidence", isNumeric: true },
]);

function ConfidenceLaneTableI({ buckets }) {
	const { Table, TableRow, TableCell } = window.UI;
	return (
		<Table caption="Suggestion confidence by group" columns={LANE_COLUMNS_I}>
			{(view) => buckets.map((b) => {
				const avg = b.confidence_observed_avg;
				const isMeasured = avg !== null && avg !== undefined;
				const badge = confidenceBadgeMetaI(avg);
				return (
					<TableRow key={b.promotion_tier} view={view}>
						<TableCell view={view}>{laneLabelI(b.promotion_tier)}</TableCell>
						<TableCell view={view} textRole="meta" label="Suggestions" isNumeric>
							{formatIntI(Number(b.proposal_count ?? 0))}
						</TableCell>
						<TableCell view={view} textRole="meta" label="Avg confidence" isNumeric>
							{isMeasured ? (
								<><SymI s={badge.symbol} className={badge.tone} size={11} /> {formatRateI(avg)}</>
							) : (
								<NoneCellI />
							)}
						</TableCell>
					</TableRow>
				);
			})}
		</Table>
	);
}

// an empty cell reads None in faint ink, never blank or a dash
function NoneCellI() {
	return <span className="text-faint">None</span>;
}

// Add-only patches stacks with Results by check status beside Suggestion confidence → a short S slot keeps that pair level
const PROSE_ONLY_ADD_CARD_SIZE_I = "S";

// prose-only-add per-agent rolling count. 카드가 항상 존재해야 하는 이유: 0 건은
// "추가만 하는 패치가 없었다"는 판독이고, 카드 부재는 "측정하지 않는다"이다 — 다른 뜻이다.
const ADD_ONLY_COLUMNS_I = Object.freeze([
	{ key: "agent", label: "Agent" },
	{ key: "count", label: "Add-only", isNumeric: true },
]);

function ProseOnlyAddCardI({ state, summary }) {
	const { Card, CARD_SLOTS, EmptyState, QuietButton, Table, TableRow, TableCell, getSlotRows, hasRegionRows } = window.UI;
	const [isShowingAll, setShowingAll] = React.useState(false);
	if (state.status === "error") return null;
	if (state.status === "loading" || !summary) return null;
	// server orders by agent name → rank by count before the slot cut, so the collapsed rows are the top ones
	const agents = (Array.isArray(summary.agents) ? [...summary.agents] : []).sort(
		(a, b) =>
			Number(b.count ?? 0) - Number(a.count ?? 0) ||
			String(a.agent).localeCompare(String(b.agent)),
	);
	const total = Number(summary.total ?? 0);
	// S slot → the stacked column stays bounded whatever the roster length
	const { rows: slotRows, hiddenCount } = getSlotRows(agents, PROSE_ONLY_ADD_CARD_SIZE_I);
	const rows = isShowingAll ? agents : slotRows;
	const foot = (hiddenCount > 0 || isShowingAll) ? (
		<QuietButton className="ml-auto shrink-0" aria-expanded={isShowingAll} onClick={() => setShowingAll((v) => !v)}>
			{isShowingAll ? `Show top ${CARD_SLOTS[PROSE_ONLY_ADD_CARD_SIZE_I].rowCount}` : `Show all ${agents.length}`}
		</QuietButton>
	) : null;
	return (
		<Card
			size={PROSE_ONLY_ADD_CARD_SIZE_I}
			title="Add-only patches"
			sub={`${formatIntI(Number(summary.window_days ?? 0))} days`}
			info={summary.truncation_caveat || null}
			foot={foot}
			isFlush={hasRegionRows(state, rows)}
		>
			{rows.length === 0 ? (
				<EmptyState message="No add-only patches in this window" />
			) : (
				<Table
					caption="Add-only patches by agent"
					columns={ADD_ONLY_COLUMNS_I}
					foot={(view) => (
						<TableRow view={view}>
							<TableCell view={view} kind="row-header">Total</TableCell>
							<TableCell view={view} textRole="meta" label="Add-only" isNumeric>{formatIntI(total)}</TableCell>
						</TableRow>
					)}
				>
					{(view) => rows.map((r) => (
						<TableRow key={r.agent} view={view}>
							<TableCell view={view}>{r.agent}</TableCell>
							<TableCell view={view} textRole="meta" label="Add-only" isNumeric>
								{formatIntI(Number(r.count ?? 0))}
							</TableCell>
						</TableRow>
					))}
				</Table>
			)}
		</Card>
	);
}

// OPTIONAL 단계 — 모든 row NULL 가능:
//   - 전체 NULL 시 "데이터 누적 중" 안내 → NaN%/0/0 렌더 차단
//   - per-agent rate null 시 "—" 표시 (denominator = 0)
//
// graduation gate: overall_emission_rate ≥ 0.50 AND
//   overall_uncorroborated_rate < 0.10 — the uncorroborated share of the rows the
//   cross-check ADJUDICATED. Route-side denominator excludes the unverifiable rows,
//   so this gate cannot be passed by widening the blind spot; the unverifiable count
//   is rendered beside it as the coverage reading.
// dual-encoded indicator.

// ----- StyleRef telemetry card ----------------
//
// Surfaces Project Convention Probe telemetry:
//   - per-agent emission rate (sibling Read 의무 준수율, 7d rolling)
//   - per-agent verified rate (Gaming-the-Judge cross-verify pass rate)
//   - 전체 rollup → MANDATORY 격상 조건 충족 indicator
//
// 헤드라인은 "Loop parked" 가 아니라 메커니즘 이름이다. cap 은 억제 다섯 경로 중 하나이고
// 측정상 가장 드물다(비율은 routes/improvement.ts 헤더). 그 하나를 "루프가 멈췄다"로 쓰면
// 나머지 넷이 조용히 억제되는 동안 배너는 이미 경고 상태라 아무도 다시 보지 않는다. 전체

function StyleRefCardI({ state, styleRef }) {
	const { Card, BulletBar, EmptyState, LoadingPlaceholder, Stack, StatRow } = window.UI;
	const title = "Style-check rate";
	const sub = "7 days · checked before coding";
	if (state.status === "error") return null;
	if (state.status === "loading" || !styleRef) {
		return (
			<Card title={title} sub={sub}>
				<LoadingPlaceholder label="style-check rates" minHeight={68} />
			</Card>
		);
	}

	const overallEmission = styleRef.overall_emission_rate;
	const overallUncorroborated = styleRef.overall_uncorroborated_rate;
	const agentRows = Array.isArray(styleRef.agents) ? styleRef.agents : [];
	const hasData = agentRows.some((r) => Number(r.emission_count ?? 0) > 0);

	// 격상 게이트 — null-safe (데이터 부재 → 회색 pending indicator).
	const gradeBadge = styleRefGradeBadgeI(overallEmission, overallUncorroborated);

	// C3: 격상 임계치 대비 rate 를 BulletBar(척도상 위치 + target 마커)로 — % 텍스트는 유지.
	//   - emission: target=0.5 (격상 게이트 ≥50%) · ≥0.5 구간을 ok 밴드로.
	//   - uncorroborated: target=0.1 (격상 게이트 < 10%) · <0.1 이 ok 밴드, 이상은 warn.
	//     verified 로 뒤집지 않는다 — 뒤집은 값은 adjudicated 분모를 숨겨 unverifiable 을 함께 읽게 만든다.
	const hasEmission =
		overallEmission !== null &&
		overallEmission !== undefined &&
		!Number.isNaN(Number(overallEmission));
	const hasUncorroborated =
		overallUncorroborated !== null &&
		overallUncorroborated !== undefined &&
		!Number.isNaN(Number(overallUncorroborated));
	const emissionBar = hasEmission ? (
		<BulletBar
			value={Number(overallEmission)}
			target={0.5}
			showValue
			zones={[
				{ upTo: 0.5, tone: "crit" },
				{ upTo: 1, tone: "ok" },
			]}
			ariaLabel={`Reported rate ${(Number(overallEmission) * 100).toFixed(0)}% (graduation target 50%)`}
		/>
	) : null;
	const uncorroboratedBar = hasUncorroborated ? (
		<BulletBar
			value={Number(overallUncorroborated)}
			target={0.1}
			showValue
			zones={[
				{ upTo: 0.1, tone: "ok" },
				{ upTo: 1, tone: "warn" },
			]}
			ariaLabel={`Uncorroborated share ${(Number(overallUncorroborated) * 100).toFixed(0)}% of adjudicated rows (graduation target under 10%)`}
		/>
	) : null;

	const stats = [
		{
			key: "gate",
			label: <><SymI s={gradeBadge.symbol} className={gradeBadge.tone} size={12} /> Graduation gate</>,
			value: gradeBadge.label,
			context: gradeBadge.hint,
		},
		{ key: "reported", label: "Reported rate (overall)", value: hasEmission ? formatRateI(overallEmission) : null, context: emissionBar },
		{
			key: "uncorroborated",
			label: "Uncorroborated share",
			value: hasUncorroborated ? formatRateI(overallUncorroborated) : null,
			context: <>{uncorroboratedBar}<div>of adjudicated rows only</div></>,
		},
	];

	const statRow = <StatRow stats={stats} />;
	// no data → "Collecting data" instead of the 3-count split and table; no table, so a padded body
	return (
		<Card
			title={title}
			sub={sub}
			info="Uncorroborated share = uncorroborated ÷ (corroborated + uncorroborated) — adjudicated rows only, unverifiable excluded (graduation gate under 10%)."
			isFlush={hasData}
		>
			{hasData ? (
				<TableBodyI
					lead={<>
						{statRow}
						<StyleRefSplitI
							corroborated={styleRef.overall_corroborated_count}
							uncorroborated={styleRef.overall_uncorroborated_count}
							unverifiable={styleRef.overall_unverifiable_count}
							greenfield={styleRef.overall_greenfield_count}
						/>
					</>}
				>
					<StyleRefAgentTableI rows={agentRows} />
				</TableBodyI>
			) : (
				<Stack gap="block">
					{statRow}
					<EmptyState message="Collecting data" />
				</Stack>
			)}
		</Card>
	);
}

const STYLE_REF_COLUMNS_I = Object.freeze([
	{ key: "agent", label: "Agent" },
	{ key: "reported", label: "Reported", isNumeric: true },
	{ key: "rate", label: "Rate", isNumeric: true },
	{ key: "corroborated", label: "Corrob.", isNumeric: true },
	{ key: "uncorroborated", label: "Uncorrob.", isNumeric: true },
	{ key: "unverifiable", label: "Unverifiable", isNumeric: true },
]);

function StyleRefAgentTableI({ rows }) {
	// 행=agent (가변) / 열=6 (agent · reported · rate · corroborated · uncorroborated · unverifiable)
	// per-agent rate 열은 없다 — 세 bucket 을 하나의 비율로 접으면 adjudicated 여부가 사라진다.
	const { Table, TableRow, TableCell } = window.UI;
	return (
		<Table caption="Style-check rate by agent" columns={STYLE_REF_COLUMNS_I}>
			{(view) => rows.map((r) => {
				const emCount = Number(r.emission_count ?? 0);
				const emTotal = Number(r.emission_total ?? 0);
				const corroborated = Number(r.corroborated_count ?? 0);
				const uncorroborated = Number(r.uncorroborated_count ?? 0);
				const unverifiable = Number(r.unverifiable_count ?? 0);
				const eligible = Number(r.eligible_count ?? 0);
				const hasRate = r.emission_rate !== null && r.emission_rate !== undefined;
				return (
					<TableRow key={r.agent} view={view}>
						<TableCell view={view}>{r.agent}</TableCell>
						<TableCell view={view} textRole="meta" label="Reported" isNumeric>
							{formatIntI(emCount)} / {formatIntI(emTotal)}
						</TableCell>
						<TableCell view={view} textRole="meta" label="Rate" isNumeric>
							{hasRate ? formatRateI(r.emission_rate) : <NoneCellI />}
						</TableCell>
						<TableCell view={view} textRole="meta" label="Corrob." isNumeric>
							{formatIntI(corroborated)} / {formatIntI(eligible)}
						</TableCell>
						<TableCell view={view} textRole="meta" label="Uncorrob." isNumeric>
							{formatIntI(uncorroborated)}
						</TableCell>
						<TableCell view={view} textRole="meta" label="Unverifiable" isNumeric>
							{formatIntI(unverifiable)}
						</TableCell>
					</TableRow>
				);
			})}
		</Table>
	);
}

// corroborated/uncorroborated/unverifiable 3-count + greenfield 도표 (P13).
// 비율 하나로 접지 않는다 — 판정 가능했던 row 와 아예 보지 못한 row 가 한 숫자에 섞인다.
// 비율은 헤드라인 stat 이 한 번만 보인다.
function StyleRefSplitI({ corroborated, uncorroborated, unverifiable, greenfield }) {
	const { Cluster } = window.UI;
	const cells = [
		["Corroborated", corroborated, "✓", "text-ok"],
		["Uncorroborated", uncorroborated, "⚠", "text-warn"],
		["Unverifiable", unverifiable, "○", "text-faint"],
		["Greenfield", greenfield, "ℹ", "text-info"],
	];
	return (
		<Cluster gap="control-group" className="items-baseline fs-meta">
			{cells.map(([label, count, symbol, tone]) => (
				<span key={label}>
					<SymI s={symbol} className={tone} size={11} />{" "}
					<span className="text-dim">{label}</span>{" "}
					<span className="text-ink tnum">{formatIntI(Number(count ?? 0))}</span>
				</span>
			))}
		</Cluster>
	);
}

// graduation-gate verdict, null-safe — symbol = the shared severity glyph of its tone
// PASS: emission ≥ 0.50 AND uncorroborated < 0.10 → ✓ + text-ok
// WARN: emission ≥ 0.50 AND uncorroborated ≥ 0.10 → ⚠ + text-warn
// BLOCK: emission < 0.50                          → ✕ + text-crit
// PEND: no reading                                → ℹ + text-info
function styleRefGradeBadgeI(emissionRate, uncorroboratedRate) {
	if (emissionRate === null && uncorroboratedRate === null) {
		return {
			symbol: "ℹ",
			tone: "text-info",
			label: "pending",
			hint: "Collecting data (7 d window)",
		};
	}
	if (emissionRate === null) {
		return {
			symbol: "ℹ",
			tone: "text-info",
			label: "pending",
			hint: "No outcomes in 7 d",
		};
	}
	if (emissionRate < 0.5) {
		return {
			symbol: "✕",
			tone: "text-crit",
			label: "block",
			hint: `emission ${formatRateI(emissionRate)} < 50%`,
		};
	}
	// emission ≥ 50% — uncorroborated share 평가.
	if (uncorroboratedRate === null) {
		// adjudicated = 0 · 모든 emission 이 STYLE_REF_GREENFIELD (cross-layer SoT — routes/improvement.ts)
		// 이거나 전부 unverifiable → 판정 근거 없음 · 격상 보류.
		return {
			symbol: "ℹ",
			tone: "text-info",
			label: "pending",
			hint: "Adjudicated: 0 (greenfield or unverifiable)",
		};
	}
	if (uncorroboratedRate < 0.1) {
		return {
			symbol: "✓",
			tone: "text-ok",
			label: "pass",
			hint: `emission ${formatRateI(emissionRate)} · uncorroborated ${formatRateI(uncorroboratedRate)}`,
		};
	}
	return {
		symbol: "⚠",
		tone: "text-warn",
		label: "warn",
		hint: `uncorroborated ${formatRateI(uncorroboratedRate)} ≥ 10%`,
	};
}

// Null-safe rate render — null → "—" (NaN% / 0/0 차단).
function formatRateI(rate) {
	if (rate === null || rate === undefined || Number.isNaN(Number(rate)))
		return "—";
	return `${(Number(rate) * 100).toFixed(1)}%`;
}

// correction_signals AGGREGATE 카드 — stage1(regex) vs stage2(agent-emit) 검출 일치율
// + revision_count delta. orphan 테이블(미배포/빈 데이터)은 정직한 빈 상태로 노출 —
// 가짜 0 금지. error(503/테이블 부재) → 뷰가 카드 대신 재시도 가능한 오류 배너를 렌더.
function CorrectionSignalsCardI({ state }) {
	const { Card, Cluster, EmptyState, formatKstDate, LoadingPlaceholder, Stack, StatRow } = window.UI;
	const title = "Detection agreement";

	if (state.status === "error") return null;
	if (state.status === "loading" || !state.data) {
		return (
			<Card title={title} sub="Correction signals">
				<LoadingPlaceholder label="correction signals" minHeight={60} />
			</Card>
		);
	}

	const d = state.data;
	// 빈 테이블 → 정직한 빈 상태 (다음 단계 힌트 동반). 가짜 0% 미표기.
	if (!d.total_signals) {
		return (
			<Card title={title} sub="Correction signals">
				<EmptyState
					message="No correction signals recorded yet"
					hint="Appears once a run logs a stage1/stage2 detection."
				/>
			</Card>
		);
	}

	const agr = d.agreement;
	const total = agr.total || 0;
	// stage1·stage2 가 concur 한 비율(both OR neither) — 검출기 합의도.
	const agreePct = total > 0 ? ((agr.agreement_count / total) * 100).toFixed(1) : "0.0";
	const latest = d.latest_event_ts ? formatKstDate(d.latest_event_ts) : null;

	return (
		<Card
			title={title}
			sub={`${formatIntI(total)} signals${latest ? ` · latest ${latest}` : ""}`}
			info="Agreement = both + neither (the two stages concur) ÷ all signals."
		>
			<Stack gap="label">
				<StatRow stats={[{ key: "agreement", label: "Stage1/stage2 agreement", value: `${agreePct}%` }]} />
				{/* 4-way disjoint 분해 — both / stage1-only / stage2-only / neither. */}
				<Cluster gap="control-group" className="fs-meta text-faint tnum">
					<span>
						<SymI s="✓" className="text-ok" size={11} /> <span className="text-dim">both</span>{" "}
						{formatIntI(agr.both_matched)}
					</span>
					<span>
						<SymI s="⚠" className="text-warn" size={11} /> <span className="text-dim">stage1 only</span>{" "}
						{formatIntI(agr.stage1_only)}
					</span>
					<span>
						<SymI s="⚠" className="text-warn" size={11} /> <span className="text-dim">stage2 only</span>{" "}
						{formatIntI(agr.stage2_only)}
					</span>
					<span>
						<span className="text-faint">neither</span>{" "}
						{formatIntI(agr.neither_matched)}
					</span>
				</Cluster>
				<div className="fs-meta text-faint tnum">
					revision delta Σ {formatIntI(d.revision_delta_sum)} · peak{" "}
					{formatIntI(d.revision_delta_max)}
				</div>
			</Stack>
		</Card>
	);
}

// 코퍼스 성장 카드 — core.autoagent_corpus_audits 시리즈(cycle_date 당 1행).
// null 은 "판독 불가", 0 은 "측정된 0" 으로 서로 다른 판독 → null 을 0 으로 접지 않는다.
function CorpusGrowthCardI({ state }) {
	const { Card, Cluster, EmptyState, Sparkline, LoadingPlaceholder, Stack, StatRow } = window.UI;
	const title = "Corpus growth";

	if (state.status === "error") return null;
	if (state.status === "loading" || !state.data) {
		return (
			<Card title={title} sub="Per-cycle audit">
				<LoadingPlaceholder label="corpus audits" minHeight={60} />
			</Card>
		);
	}

	const rows = Array.isArray(state.data.audits) ? state.data.audits : [];
	const latest = rows[0];
	if (!latest) {
		return (
			<Card title={title} sub="Per-cycle audit">
				<EmptyState
					message="No corpus readings yet"
					hint="Appears once a daemon cycle writes one."
				/>
			</Card>
		);
	}

	// 응답은 cycle_date DESC → 스파크는 시간순으로 뒤집는다.
	const wordSeries = rows.map((r) => Number(r.word_count ?? 0)).reverse();
	const delta = latest.trend_delta;
	const hasDelta = typeof delta === "number";
	// ▲/▼/= glyph carries the direction and the tone · the words stay dim
	const deltaSymbol = !hasDelta ? "·" : delta > 0 ? "▲" : delta < 0 ? "▼" : "=";
	const deltaTone =
		!hasDelta || delta === 0
			? "text-faint"
			: delta > 0
				? "text-warn"
				: "text-ok";
	const deltaLabel = hasDelta
		? `${delta > 0 ? "+" : ""}${formatIntI(delta)} words vs previous`
		: "no baseline yet";
	const compliance = formatRateI(latest.compliance_rate);
	const override = formatRateI(latest.override_rate);
	const verdict = getCorpusGrowthVerdictI(latest);
	const stats = [
		{
			key: "words",
			label: "Corpus size",
			value: formatIntI(Number(latest.word_count ?? 0)),
			unit: "words",
			context: <><SymI s={deltaSymbol} className={deltaTone} /> {deltaLabel}</>,
		},
	];

	return (
		<Card
			title={title}
			sub={`${formatIntI(Number(state.data.total_audits ?? 0))} audits · latest ${latest.cycle_date}`}
		>
			<Stack gap="label">
				<Cluster gap="control-group" className="items-end justify-between">
					<StatRow stats={stats} />
					{/* 스파크는 텍스트 수치의 중복 표현 → 스크린리더에서 제외. */}
					{wordSeries.length > 1 && (
						<span aria-hidden="true">
							<Sparkline
								data={wordSeries}
								w={90}
								h={26}
								color="rgb(var(--dim))"
							/>
						</span>
					)}
				</Cluster>
				<Cluster gap="control-group" className="fs-meta text-faint tnum">
					<span>{formatIntI(Number(latest.file_count ?? 0))} files</span>
					<span>~{formatIntI(Number(latest.token_estimate ?? 0))} tokens</span>
					<span>
						threshold {formatIntI(Number(latest.seeded_threshold ?? 0))}
					</span>
					{verdict.tone === "text-warn" && (
						<span className="text-dim">
							<SymI s={verdict.symbol} className={verdict.tone} size={11} /> {verdict.label}
						</span>
					)}
				</Cluster>
				<Cluster gap="control-group" className="fs-meta text-faint tnum">
					<span>
						gate{" "}
						<span className="text-ink">
							{formatIntI(Number(latest.gate_pass_count ?? 0))}
						</span>{" "}
						pass ·{" "}
						<span className="text-ink">
							{formatIntI(Number(latest.gate_trip_count ?? 0))}
						</span>{" "}
						trip / {formatIntI(Number(latest.gate_total_count ?? 0))}
					</span>
					<span>compliance {compliance}</span>
					<span>override {override}</span>
				</Cluster>
				{(latest.compliance_rate === null || latest.override_rate === null) && (
					<div className="card-sub fs-meta">
						— = insufficient data, never a measured zero.
					</div>
				)}
			</Stack>
		</Card>
	);
}

// Same shape as styleRefGradeBadgeI → the Operator view renders every gauge chip alike.
function getCorpusGrowthVerdictI(latest) {
	if (!latest) {
		return {
			symbol: "ℹ",
			tone: "text-info",
			label: "pending",
			hint: "No corpus reading yet",
		};
	}
	const hint = `threshold ${formatIntI(Number(latest.seeded_threshold ?? 0))} words`;
	const alerts = [
		latest.trend_alert ? "trend" : null,
		latest.absolute_alert ? "absolute" : null,
	].filter(Boolean);
	if (alerts.length > 0) {
		return {
			symbol: "⚠",
			tone: "text-warn",
			label: `${alerts.join(" + ")} alert`,
			hint,
		};
	}
	return {
		symbol: "✓",
		tone: "text-ok",
		label: "within threshold",
		hint,
	};
}

window.ImprovementInstrumentationView = ImprovementInstrumentationViewI;
// Per-gauge verdicts, read by improvement.jsx at render time instead of copying the rules.
window.ImprovementInstrumentationVerdicts = Object.freeze({
	styleRefGradeBadgeI,
	getCorpusGrowthVerdictI,
});
