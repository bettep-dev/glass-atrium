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

function ReviewReasonSegmentsI(props) {
	return React.createElement(
		window.ImprovementShared.ReviewReasonSegmentsI,
		props,
	);
}

// One banner per failed payload, in place of the group that payload owns.
function PayloadErrorCardI({ title, state, onRetry }) {
	const { CardHead, RegionUnavailable } = window.UI;
	return (
		<div className="card">
			<CardHead title={title} />
			<div className="p-4">
				<RegionUnavailable
					source={title.toLowerCase()}
					error={state.error}
					onRetry={onRetry}
				/>
			</div>
		</div>
	);
}

// 플래그된 결과 — 운영 밴드가 아니라 계기판에 산다. 이 수는 루프가 무엇을 내놓았는지가
// 아니라 판정기가 무엇을 걸렀는지를 말하고, 걸린 행 자체는 Task results 가 소유한다.
function FlaggedResultsCardI({ state, reviewReasons, onNav }) {
	const { CardHead, Icon, LoadingPlaceholder } = window.UI;
	const title = "Flagged results (7 days)";

	if (state.status === "error") return null;
	if (state.status === "loading" || !state.data) {
		return (
			<div className="card">
				<CardHead title={title} />
				<div className="p-3">
					<LoadingPlaceholder label="flagged results" minHeight={60} />
				</div>
			</div>
		);
	}

	return (
		<div className="card">
			<CardHead
				title={title}
				sub="Outcomes flagged in the last 7 days · quarantined excluded"
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
			/>
			<div className="px-3 pb-3">
				<div className="fs-body font-mono text-ink tnum">
					{formatIntI(Number(state.data.review_flag_last_7d ?? 0))}
				</div>
				{/* is-wrap 필수 — 사유 세그먼트가 잘리면 수만 남고 모집단이 사라진다. */}
				<div className="card-sub is-wrap fs-meta mt-1">
					<ReviewReasonSegmentsI
						segments={reviewReasons}
						fallback="Outcomes flagged in the last 7 days"
					/>
				</div>
			</div>
		</div>
	);
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
}) {
	return (
		<div className="space-sections">
			{statsState.status === "error" ? (
				<PayloadErrorCardI
					title="Flagged results"
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
			{corpusAuditState.status === "error" ? (
				<PayloadErrorCardI
					title="Corpus growth"
					state={corpusAuditState}
					onRetry={onRetry}
				/>
			) : (
				<CorpusGrowthCardI state={corpusAuditState} />
			)}
			{correctionState.status === "error" ? (
				<PayloadErrorCardI
					title="Correction signals"
					state={correctionState}
					onRetry={onRetry}
				/>
			) : (
				<CorrectionSignalsCardI state={correctionState} />
			)}
			{listState.status === "error" ? (
				<PayloadErrorCardI
					title="Proposal measurements"
					state={listState}
					onRetry={onRetry}
				/>
			) : (
				<>
					<StyleRefCardI state={listState} styleRef={styleRef} />
					<ProseOnlyAddCardI state={listState} summary={proseOnlyAdd} />
					<TierBreakdownCardI state={listState} tierBreakdown={tierBreakdown} />
					<ConfidenceDistCardI
						state={listState}
						confidenceDist={confidenceDist}
					/>
				</>
			)}
		</div>
	);
}

// ----- TierBreakdown card ------------------
//
// 3-Tier Eval Grader rollout baseline cohort split. Fixed 30d window.
// 4-tile KPI grid (≤5-col safe):
//   - Code-Based PASS  (metric_pass=TRUE  AND baseline IS NULL)
//   - Code-Based FAIL  (metric_pass=FALSE AND baseline IS NULL)
//   - Pre-3Tier baseline (baseline_pre_3tier=TRUE)
//   - Total cohort = sum
//
// 데이터 부재 분기:
//   - 모든 카운트 0 → "데이터 부재" 회색 indicator (migration 미적용 OR 30d 빈 cohort)
//   - error 상태 → 뷰가 카드 대신 목록 payload 오류 배너 1개를 렌더

function TierBreakdownCardI({ state, tierBreakdown }) {
	const { CardHead, LoadingPlaceholder } = window.UI;
	if (state.status === "error") return null;
	if (state.status === "loading" || !tierBreakdown) {
		return (
			<div className="card">
				<CardHead title="Results by check status (30 days)" />
				<div className="p-3">
					<LoadingPlaceholder label="check-status results" minHeight={68} />
				</div>
			</div>
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
			<div className="card">
				<CardHead title="Results by check status (30 days)" />
				<div className="px-3 pb-3">
					<div
						className="placeholder"
					>
						No tasks in the last {windowDays} days
					</div>
				</div>
			</div>
		);
	}

	// Pass-rate denominator는 baseline 제외 (code-based 만 의미 있는 비율).
	const codeBasedTotal = passCnt + failCnt;
	const passRatePct =
		codeBasedTotal === 0 ? null : (passCnt / codeBasedTotal) * 100;

	const cards = [
		[
			"✓",
			"text-ok",
			"Self-reported pass",
			formatIntI(passCnt),
			passRatePct === null
				? "nothing checked"
				: `pass rate ${passRatePct.toFixed(1)}%`,
		],
		[
			"✕",
			"text-crit",
			"Self-reported fail",
			formatIntI(failCnt),
			`${formatIntI(codeBasedTotal)} checked`,
		],
		[
			"ℹ",
			"text-info",
			"Before auto-checking (old)",
			formatIntI(baselineCnt),
			"",
		],
		["ℹ", "text-info", "Total", formatIntI(totalCnt), ""],
	];

	return (
		<div className="card">
			<CardHead title="Results by check status (30 days)" />
			<div className="grid grid-cols-4 gap-2 p-3">
				{cards.map(([sym, tone, label, value, hint]) => (
					<div
						key={label}
						className="i-card-shadow bg-elev rounded-md p-2.5 min-w-0"
					>
						<div className="flex items-center gap-1.5 fs-meta font-mono">
							<SymI s={sym} className={tone} size={12} />
							<span className={tone}>{label}</span>
						</div>
						<div className="fs-stat font-semibold text-ink mt-1 font-mono">
							{value}
						</div>
						<div
							className="card-sub fs-meta mt-1"
							title={window.UI.titleOf(hint)}
						>
							{hint}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

// ----- ConfidenceDist card -------------------
//
// confidence_observed × promotion_tier 분포. 사용자 선택 window (proposal-side).
// 3-tile headline KPI (≤5-col safe):
//   - Overall confidence_observed (전체 가중 평균 · NULL → "미산정")
//   - Lane 수 (promotion_tier 구분 수 · 'unassigned' 포함)
//   - 총 proposal 수 (window 내)
// + per-lane 분포 표 (행=lane / 열=3: lane · proposal_count · confidence_avg).
//
// 데이터 부재 분기:
//   - buckets 비어있음 → "데이터 부재" 회색 indicator (daemon-wiring 미적용 OR window 0건)
//   - error 상태 → 뷰가 카드 대신 목록 payload 오류 배너 1개를 렌더

function ConfidenceDistCardI({ state, confidenceDist }) {
	const { CardHead, BulletBar, LoadingPlaceholder } = window.UI;
	if (state.status === "error") return null;
	if (state.status === "loading" || !confidenceDist) {
		return (
			<div className="card">
				<CardHead title="Suggestion confidence (measured)" sub="30 days" />
				<div className="p-3">
					<LoadingPlaceholder label="suggestion confidence" minHeight={68} />
				</div>
			</div>
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
			<div className="card">
				<CardHead title="Suggestion confidence (measured)" sub="30 days" />
				<div className="px-3 pb-3">
					<div
						className="placeholder"
					>
						No suggestions in the last 30 days
					</div>
				</div>
			</div>
		);
	}

	const overallBadge = confidenceBadgeMetaI(overallAvg);
	// C5: 실측 신뢰도(0-1 empirical posterior)를 척도상 위치(BulletBar)로 표시 — 숫자는 유지.
	// zone 밴드 = confidenceBadgeMetaI 의 0.4/0.7 cut-point 와 동일(low/medium/high).
	const hasOverall =
		overallAvg !== null &&
		overallAvg !== undefined &&
		!Number.isNaN(Number(overallAvg));
	const overallBar = hasOverall ? (
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
	) : null;
	const cards = [
		[
			overallBadge.symbol,
			overallBadge.tone,
			"Avg confidence (measured)",
			formatRateI(overallAvg),
			`Measured ${formatIntI(measuredProposals)}/${formatIntI(totalProposals)}`,
			overallBar,
		],
	];

	return (
		<div className="card">
			<CardHead title="Suggestion confidence (measured)" sub="30 days" />
			<div className="grid grid-cols-1 gap-2 p-3">
				{cards.map(([sym, tone, label, value, hint, bar]) => (
					<div
						key={label}
						className="i-card-shadow bg-elev rounded-md p-2.5 min-w-0"
					>
						<div className="flex items-start gap-1.5 fs-meta font-mono min-h-[2.4em]">
							<SymI s={sym} className={tone} size={12} />
							<span className={tone}>{label}</span>
						</div>
						<div className="fs-stat font-semibold text-ink mt-1 font-mono">
							{value}
						</div>
						{bar && <div className="mt-1.5">{bar}</div>}
						<div
							className="card-sub fs-meta mt-1"
							title={window.UI.titleOf(hint)}
						>
							{hint}
						</div>
					</div>
				))}
			</div>
			<ConfidenceLaneTableI buckets={buckets} />
		</div>
	);
}

// raw COALESCE fallback 'unassigned'(promotion_tier NULL) → 사용자친화 라벨.
// 원시문자열 노출 차단 · 그 외 tier 는 원형 유지.
function laneLabelI(promotionTier) {
	if (promotionTier === "unassigned") return "Unassigned";
	return promotionTier;
}

// per-lane 분포 표 — 행=lane (가변) / 열=3 (lane · proposal_count · confidence_avg).
// confidence_avg NULL → "—" (formatRateI null-safe).
function ConfidenceLaneTableI({ buckets }) {
	return (
		<div className="px-3 pb-3">
			<table className="w-full fs-meta font-mono">
				<thead>
					<tr className="text-faint uppercase tracking-wider">
						<th className="text-left py-1.5 pl-1.5">Group</th>
						<th className="text-right py-1.5">Suggestions</th>
						<th className="text-right py-1.5 pr-1.5">Avg confidence</th>
					</tr>
				</thead>
				<tbody>
					{buckets.map((b) => {
						const avg = b.confidence_observed_avg;
						const badge = confidenceBadgeMetaI(avg);
						return (
							<tr key={b.promotion_tier} className="border-t border-line/50">
								<td className="text-left py-1.5 pl-1.5 text-ink">
									{laneLabelI(b.promotion_tier)}
								</td>
								<td className="text-right py-1.5 text-dim">
									{formatIntI(Number(b.proposal_count ?? 0))}
								</td>
								<td
									className={`py-1.5 pr-1.5 ${badge.tone} flex items-center justify-end gap-1.5`}
								>
									<SymI
										s={avg === null || avg === undefined ? "ℹ" : badge.symbol}
										size={11}
									/>{" "}
									{formatRateI(avg)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

// prose-only-add per-agent rolling count. 카드가 항상 존재해야 하는 이유: 0 건은
// "추가만 하는 패치가 없었다"는 판독이고, 카드 부재는 "측정하지 않는다"이다 — 다른 뜻이다.
function ProseOnlyAddCardI({ state, summary }) {
	const { CardHead } = window.UI;
	if (state.status === "error") return null;
	if (state.status === "loading" || !summary) return null;
	const rows = Array.isArray(summary.agents) ? summary.agents : [];
	const total = Number(summary.total ?? 0);
	return (
		<div className="card">
			<CardHead
				title={`Add-only patches (${formatIntI(Number(summary.window_days ?? 0))} days)`}
			/>
			{rows.length === 0 ? (
				<div className="px-3 pb-3">
					<div className="placeholder">
						No add-only patches in this window
					</div>
				</div>
			) : (
				<div className="px-3 pb-3">
					<table className="w-full fs-meta font-mono">
						<thead>
							<tr className="text-faint uppercase tracking-wider">
								<th className="text-left py-1.5 pl-1.5">Agent</th>
								<th className="text-right py-1.5 pr-1.5">Add-only</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.agent} className="border-t border-line/50">
									<td className="text-left py-1.5 pl-1.5 text-ink">
										{r.agent}
									</td>
									<td className="text-right py-1.5 pr-1.5 text-ink">
										{formatIntI(Number(r.count ?? 0))}
									</td>
								</tr>
							))}
							<tr className="border-t border-line">
								<td className="text-left py-1.5 pl-1.5 text-dim">Total</td>
								<td className="text-right py-1.5 pr-1.5 text-ink">
									{formatIntI(total)}
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			)}
			<div className="px-3 pb-3 card-sub fs-meta">
				{summary.truncation_caveat}
			</div>
		</div>
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
	const { CardHead, BulletBar, LoadingPlaceholder } = window.UI;
	if (state.status === "error") return null;
	if (state.status === "loading" || !styleRef) {
		return (
			<div className="card">
				<CardHead
					title="Style-check rate (7 days)"
					sub="Agents that checked existing files before coding"
				/>
				<div className="p-3">
					<LoadingPlaceholder label="style-check rates" minHeight={68} />
				</div>
			</div>
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

	const headlineCards = [
		[
			gradeBadge.symbol,
			gradeBadge.tone,
			"Threshold met",
			gradeBadge.label,
			gradeBadge.hint,
			null,
		],
		[
			"ℹ",
			"text-info",
			"Reported rate (overall)",
			formatRateI(overallEmission),
			"",
			emissionBar,
		],
		[
			"ℹ",
			"text-info",
			"Uncorroborated share",
			formatRateI(overallUncorroborated),
			"of adjudicated rows only",
			uncorroboratedBar,
		],
	];

	return (
		<div className="card">
			<CardHead
				title="Style-check rate (7 days)"
				sub="Agents that checked existing files before coding"
			/>
			<div className="grid grid-cols-3 gap-2 p-3">
				{headlineCards.map(([sym, tone, label, value, hint, bar]) => (
					<div
						key={label}
						className="i-card-shadow bg-elev rounded-md p-2.5 min-w-0"
					>
						<div className="flex items-start gap-1.5 fs-meta font-mono min-h-[2.4em]">
							<SymI s={sym} className={tone} size={12} />
							<span className={tone}>{label}</span>
						</div>
						<div className="fs-stat font-semibold text-ink mt-1 font-mono">
							{value}
						</div>
						{bar && <div className="mt-1.5">{bar}</div>}
						<div
							className="card-sub fs-meta mt-1"
							title={window.UI.titleOf(hint)}
						>
							{hint}
						</div>
					</div>
				))}
			</div>
			{/* 3-count partition + greenfield (P13) — 데이터 부재 시 미렌더(placeholder 로 위임). */}
			{hasData && (
				<StyleRefSplitI
					corroborated={styleRef.overall_corroborated_count}
					uncorroborated={styleRef.overall_uncorroborated_count}
					unverifiable={styleRef.overall_unverifiable_count}
					greenfield={styleRef.overall_greenfield_count}
					uncorroboratedRate={styleRef.overall_uncorroborated_rate}
				/>
			)}
			{/* per-agent breakdown — 데이터 부재 시 "누적 중" 안내. */}
			{hasData ? (
				<StyleRefAgentTableI rows={agentRows} />
			) : (
				<div className="px-3 pb-3">
					<div
						className="placeholder"
					>
						Collecting data
					</div>
				</div>
			)}
		</div>
	);
}

function StyleRefAgentTableI({ rows }) {
	// 행=agent (가변) / 열=6 (agent · reported · rate · corroborated · uncorroborated · unverifiable)
	// per-agent rate 열은 없다 — 세 bucket 을 하나의 비율로 접으면 adjudicated 여부가 사라진다.
	// 헤더는 dim text + uppercase tracking · 본문은 mono.
	return (
		<div className="px-3 pb-3">
			<table className="w-full fs-meta font-mono">
				<thead>
					<tr className="text-faint uppercase tracking-wider">
						<th className="text-left py-1.5 pl-1.5">Agent</th>
						<th className="text-right py-1.5">Reported</th>
						<th className="text-right py-1.5">Rate</th>
						<th className="text-right py-1.5">Corrob.</th>
						<th className="text-right py-1.5">Uncorrob.</th>
						<th className="text-right py-1.5 pr-1.5">Unverifiable</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => {
						const emCount = Number(r.emission_count ?? 0);
						const emTotal = Number(r.emission_total ?? 0);
						const corroborated = Number(r.corroborated_count ?? 0);
						const uncorroborated = Number(r.uncorroborated_count ?? 0);
						const unverifiable = Number(r.unverifiable_count ?? 0);
						const eligible = Number(r.eligible_count ?? 0);
						return (
							<tr key={r.agent} className="border-t border-line/50">
								<td className="text-left py-1.5 pl-1.5 text-ink">{r.agent}</td>
								<td className="text-right py-1.5 text-dim">
									{formatIntI(emCount)} / {formatIntI(emTotal)}
								</td>
								<td className="text-right py-1.5 text-ink">
									{formatRateI(r.emission_rate)}
								</td>
								<td className="text-right py-1.5 text-ok">
									{formatIntI(corroborated)} / {formatIntI(eligible)}
								</td>
								<td className="text-right py-1.5 text-warn">
									{formatIntI(uncorroborated)}
								</td>
								<td className="text-right py-1.5 pr-1.5 text-faint">
									{formatIntI(unverifiable)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

// corroborated/uncorroborated/unverifiable 3-count + greenfield 도표 (P13).
// 비율 하나로 접지 않는다 — 판정 가능했던 row 와 아예 보지 못한 row 가 한 숫자에 섞인다.
function StyleRefSplitI({
	corroborated,
	uncorroborated,
	unverifiable,
	greenfield,
	uncorroboratedRate,
}) {
	const cells = [
		["Corroborated", corroborated, "text-ok"],
		["Uncorroborated", uncorroborated, "text-warn"],
		["Unverifiable", unverifiable, "text-faint"],
		["Greenfield", greenfield, "text-info"],
	];
	return (
		<div className="px-3 pb-1">
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 fs-meta font-mono">
				{cells.map(([label, count, tone]) => (
					<span key={label} className="inline-flex items-baseline gap-1">
						<span className={tone}>{label}</span>
						<span className="text-ink font-semibold">
							{formatIntI(Number(count ?? 0))}
						</span>
					</span>
				))}
				<span className="inline-flex items-baseline gap-1 ml-auto">
					<span
						className="text-faint uppercase tracking-wider"
						title="Uncorroborated / (corroborated + uncorroborated) — adjudicated rows only, unverifiable excluded (graduation gate < 10%)">
						Uncorroborated share
					</span>
					<span className="text-ink font-semibold">
						{formatRateI(uncorroboratedRate)}
					</span>
				</span>
			</div>
		</div>
	);
}

// v1.1 격상 게이트 dual-encoded badge — null-safe.
// PASS: emission ≥ 0.50 AND uncorroborated < 0.10 → ✓ + text-ok
// WARN: emission ≥ 0.50 AND uncorroborated ≥ 0.10 → ⚠ + text-warn
// BLOCK: emission < 0.50 (데이터 부족 외)              → ⛔ + text-crit
// PEND: 전체 NULL (데이터 부재)                          → ℹ + text-info
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
			symbol: "⛔",
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
	const { CardHead, formatKstDate, LoadingPlaceholder } = window.UI;
	const title = "Detection agreement (correction signals)";

	if (state.status === "error") return null;
	if (state.status === "loading" || !state.data) {
		return (
			<div className="card">
				<CardHead title={title} />
				<div className="p-3">
					<LoadingPlaceholder label="correction signals" minHeight={60} />
				</div>
			</div>
		);
	}

	const d = state.data;
	// 빈 테이블 → 정직한 빈 상태 (다음 단계 힌트 동반). 가짜 0% 미표기.
	if (!d.total_signals) {
		return (
			<div className="card">
				<CardHead title={title} />
				<div className="px-3 pb-3">
					<div className="placeholder">
						No correction signals recorded yet — appears once a run logs a
						stage1/stage2 detection.
					</div>
				</div>
			</div>
		);
	}

	const agr = d.agreement;
	const total = agr.total || 0;
	// stage1·stage2 가 concur 한 비율(both OR neither) — 검출기 합의도.
	const agreePct = total > 0 ? ((agr.agreement_count / total) * 100).toFixed(1) : "0.0";
	const latest = d.latest_event_ts ? formatKstDate(d.latest_event_ts) : null;

	return (
		<div className="card">
			<CardHead
				title={title}
				sub={`${formatIntI(total)} signals${latest ? ` · latest ${latest}` : ""}`}
			/>
			<div className="px-3 pb-3 space-y-2">
				<div className="fs-body">
					<span className="font-mono text-ink">{agreePct}%</span>{" "}
					<span className="text-faint">stage1/stage2 agreement</span>
				</div>
				{/* 4-way disjoint 분해 — both / stage1-only / stage2-only / neither. */}
				<div className="flex items-center gap-4 fs-meta font-mono text-faint flex-wrap">
					<span>
						<span className="text-ok">both</span> {formatIntI(agr.both_matched)}
					</span>
					<span>
						<span className="text-warn">stage1 only</span>{" "}
						{formatIntI(agr.stage1_only)}
					</span>
					<span>
						<span className="text-warn">stage2 only</span>{" "}
						{formatIntI(agr.stage2_only)}
					</span>
					<span>
						<span className="text-faint">neither</span>{" "}
						{formatIntI(agr.neither_matched)}
					</span>
				</div>
				<div className="fs-meta font-mono text-faint">
					revision delta Σ {formatIntI(d.revision_delta_sum)} · peak{" "}
					{formatIntI(d.revision_delta_max)}
				</div>
			</div>
		</div>
	);
}

// 코퍼스 성장 카드 — core.autoagent_corpus_audits 시리즈(cycle_date 당 1행).
// null 은 "판독 불가", 0 은 "측정된 0" 으로 서로 다른 판독 → null 을 0 으로 접지 않는다.
function CorpusGrowthCardI({ state }) {
	const { CardHead, Sparkline, LoadingPlaceholder } = window.UI;
	const title = "Corpus growth (per-cycle audit)";

	if (state.status === "error") return null;
	if (state.status === "loading" || !state.data) {
		return (
			<div className="card">
				<CardHead title={title} />
				<div className="p-3">
					<LoadingPlaceholder label="corpus audits" minHeight={60} />
				</div>
			</div>
		);
	}

	const rows = Array.isArray(state.data.audits) ? state.data.audits : [];
	const latest = rows[0];
	if (!latest) {
		return (
			<div className="card" data-testid="corpus-growth-card">
				<CardHead title={title} />
				<div className="px-3 pb-3">
					<div className="placeholder">
						No corpus readings yet — appears once a daemon cycle writes one.
					</div>
				</div>
			</div>
		);
	}

	// 응답은 cycle_date DESC → 스파크는 시간순으로 뒤집는다.
	const wordSeries = rows.map((r) => Number(r.word_count ?? 0)).reverse();
	const delta = latest.trend_delta;
	const hasDelta = typeof delta === "number";
	// 색 단독 인코딩 금지 — ▲/▼/= 기호가 1차 신호, tone 은 보조.
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
	const alerts = [
		latest.trend_alert ? "trend" : null,
		latest.absolute_alert ? "absolute" : null,
	].filter(Boolean);

	return (
		<div className="card" data-testid="corpus-growth-card">
			<CardHead
				title={title}
				sub={`${formatIntI(Number(state.data.total_audits ?? 0))} readings · latest ${latest.cycle_date}`}
			/>
			<div className="px-3 pb-3 space-y-2">
				<div className="flex items-center gap-3 flex-wrap">
					<span className="fs-display font-mono text-ink">
						{formatIntI(Number(latest.word_count ?? 0))}
					</span>
					<span className="fs-meta text-faint">words</span>
					<span className={`fs-meta font-mono ${deltaTone}`}>
						{deltaSymbol} {deltaLabel}
					</span>
					{/* 스파크는 텍스트 수치의 중복 표현 → 스크린리더에서 제외. */}
					{wordSeries.length > 1 && (
						<span className="ml-auto" aria-hidden="true">
							<Sparkline
								data={wordSeries}
								w={90}
								h={26}
								color="rgb(var(--accent))"
							/>
						</span>
					)}
				</div>
				<div className="flex items-center gap-4 fs-meta font-mono text-faint flex-wrap">
					<span>{formatIntI(Number(latest.file_count ?? 0))} files</span>
					<span>~{formatIntI(Number(latest.token_estimate ?? 0))} tokens</span>
					<span>
						threshold {formatIntI(Number(latest.seeded_threshold ?? 0))}
					</span>
					{alerts.length > 0 && (
						<span className="text-warn">⚠ {alerts.join(" + ")} alert</span>
					)}
				</div>
				<div className="flex items-center gap-4 fs-meta font-mono text-faint flex-wrap">
					<span>
						gate{" "}
						<span className="text-ok">
							{formatIntI(Number(latest.gate_pass_count ?? 0))}
						</span>{" "}
						pass ·{" "}
						<span className="text-warn">
							{formatIntI(Number(latest.gate_trip_count ?? 0))}
						</span>{" "}
						trip / {formatIntI(Number(latest.gate_total_count ?? 0))}
					</span>
					<span>compliance {compliance}</span>
					<span>override {override}</span>
				</div>
				{(latest.compliance_rate === null || latest.override_rate === null) && (
					<div className="card-sub fs-meta">
						— = insufficient data, never a measured zero.
					</div>
				)}
			</div>
		</div>
	);
}

window.ImprovementInstrumentationView = ImprovementInstrumentationViewI;
