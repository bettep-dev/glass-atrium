// Screen — 학습/자가개선 통합 SPA.
// API: `/api/improvement` + `/stats` 단일 endpoint (2-tier auto · safety).
// safety 정의: high-impact actions 재사용.
// 시각 정합: dual-encoding · WCAG AA · Skim-Scan-Read · prefers-reduced-motion.
// public/ 는 tsconfig include 밖 → TS const import 불가.
// greenfield 비교 식별자는 STYLE_REF_GREENFIELD symbolic reference 로만.
const {
	useState: useSI,
	useEffect: useEI,
	useRef: useRI,
	useCallback: useCI,
	useMemo: useMI,
} = React;

const IMPROVEMENT_LIST_URL = "/api/improvement?limit=50";
const IMPROVEMENT_STATS_URL = "/api/improvement/stats";
// orphan 학습 endpoint surface (canonical learning-aggregator) — 집계 학습 신호만.
//   learning-log: learning-aggregator 패턴 원천 (화면 CTM/EPM 재유도의 실제 source)
// per-event raw 운영 로그(loop-events)는 Task results 화면 소유 (집계 신호 아님 → operational data) → outcomes.jsx.
const LEARNING_LOG_URL = "/api/improvement/learning-log?limit=50";
// loop-events 는 per-event raw 운영 로그가 outcomes 소유 (line 13 경계). 본 화면은 AGGREGATE
// 만 소비 — 사이클 변경량 합계(self-improvement 적용 효과) + verified/reject 날짜 추세.
// raw event 행은 렌더하지 않음 → 집계 학습 신호만 유지 (경계 위반 아님).
const LOOP_EVENTS_URL = "/api/improvement/loop-events?limit=200";
// correction_signals AGGREGATE — stage1-vs-stage2 검출 일치 + revision_count delta.
// 집계 필드만 소비(list 는 미렌더) → 최소 limit.
const CORRECTION_SIGNALS_URL = "/api/improvement/correction-signals?limit=1";
// corpus-audits — cycle_date UPSERT 라 사이클당 1행. 최신 판독 + 스파크만 소비 → 60사이클 창.
const CORPUS_AUDITS_URL = "/api/improvement/corpus-audits?limit=60";
// verified = 적용/검증 성공(CTM 인접) · reject 계열 = 반려/실패(EPM 인접) → 추세 2-시리즈 분류.
const TREND_REJECT_RESULTS = new Set([
	"reject",
	"fail",
	"all-reject-alert",
	"reject-streak-snooze",
]);
// 검토 필요 KPI 사유 세그먼트 (F12) — outcomes /search 직접 소비, 분류 SoT =
// window.UI.reviewFlagReasons (outcomes 행 배지와 동일 버킷 강제).
// KPI(review_flag_last_7d) 와 동일 모집단: days=7 + review_flag=true · 오염 행은
// 클라이언트 제외 (search 는 오염 행을 배지와 함께 노출하는 설계 — 서버 필터 없음).
const REVIEW_REASON_ROWS_URL =
	"/api/outcomes/search?days=7&review_flag=true&limit=200";
const TOAST_DURATION_MS = 3200;

// 칸반 3-column — 신규(New suggestions) 폐지.
//   auto-tier 는 생성 시점에 종결 (resolve_floor_terminalization) → auto+pending limbo
//   소멸 → "New suggestions" 컬럼은 empty-by-construction → 제거. 인간 승인 대상인
//   safety-tier pending/snoozed 만 actionable.
//   Awaiting approval (safety pending/snoozed) · Applied (terminal) · Rejected (terminal).
// snoozed 는 non-terminal + actionable → safety actionable 컬럼에 라우팅
// (terminal 컬럼 오염 방지) · 카드에 snoozed 마커.
// variant — 레인별 카드 밀도 (T1). full = ProposalCardI 전체 카드 · compact =
// CompactProposalCardI 단일행. applied/safety=full, rejected=compact.
// rejected.tone='crit' 유지 — 심볼-전용 착색용(✕·count·스파크에만, T7 색상 예약).
const KANBAN_COLUMNS = [
	{
		key: "safety",
		label: "Awaiting approval",
		tone: "warn",
		symbol: "⚠",
		variant: "full",
	},
	{
		key: "applied",
		label: "Applied",
		tone: "ok",
		symbol: "✓",
		variant: "full",
	},
	{
		key: "rejected",
		label: "Rejected",
		tone: "crit",
		symbol: "✕",
		variant: "compact",
	},
];

// AWAITING(safety) 은 그리드 밖 ROW-1 배너/스트립으로 이관 (T2) → 종결 그리드는
// applied·rejected 2트랙만 순회 (T3). safety 엔트리 label/symbol 은 ROW-1 이 소비.
const SAFETY_COLUMN = KANBAN_COLUMNS.find((col) => col.key === "safety");
const TERMINAL_COLUMNS = KANBAN_COLUMNS.filter((col) => col.key !== "safety");
// REJECTED 컴팩션 — 최근 N행 표시 후 나머지는 '＋N more' 요약으로 접음 (T5).
const REJECTED_RECENT_CAP = 8;

// 카드 액션 가능 status (mutation 엔드포인트 actionable set 미러 — routes/improvement.ts
// ACTIONABLE_PROPOSAL_STATUSES). pending/snoozed 만 허용/거절 버튼 노출.
const ACTIONABLE_STATUSES_FE = new Set(["pending", "snoozed"]);

const APPROVE_URL = (id) => `/api/improvement/${id}/approve`;
const REJECT_URL = (id) => `/api/improvement/${id}/reject`;

// tone → text class · 기호 매핑 (dual-encoding).
const TONE_TEXT_CLASS = {
	ok: "text-ok",
	warn: "text-warn",
	crit: "text-crit",
	info: "text-info",
};
// crit 을 ✕ 로 정합(reconcile) — DESIGN.md §4.2 severity 표준(crit=✕) + ui.jsx TONE_GLYPH/TONE_ICON 일치.
// ⛔(ban) 은 별도 semantic 로 예약 (styleRefGradeBadgeI 의 'block' 게이트에만 잔류).
const TONE_SYMBOL = { ok: "✓", warn: "⚠", crit: "✕", info: "ℹ" };

// 'text-ok' → 'ok' — 배지 헬퍼(confidenceBadgeMetaI/preVerifyBadgeI)의 tone 문자열을 canonical
// Badge 의 tone prop(prefix 없는 키)로 변환. 매핑 미스 → 'neutral'(shell neutral 유지).
const toneKeyI = (t) => String(t || "").replace(/^text-/, "") || "neutral";

// 렌더-컨텍스트 심볼 문자 → Icon 이름 (FIX-D/E 중앙화) — 상태 글리프 SoT.
// 대상 아님(의도적 제외): 주석 화살표(→) · outcomes 페이지네이션 dash · diff-line(+/−) vocabulary
//   · DetailBodyI 가 String() 강제하는 drawer 텍스트 필드(Icon 삽입 시 "[object Object]" 회귀, FIX-A).
const SYMBOL_ICON_I = {
	"✓": "check",
	"⚠": "warn",
	"✕": "x",
	"×": "x",
	"⛔": "ban",
	ℹ: "info",
	"⏸": "pause",
	"↻": "refresh",
	"○": "circle",
	"＋": "plus",
	"−": "minus",
};

// 심볼 → Icon 렌더 (색+기호+텍스트 3중 인코딩 유지 · aria-hidden 장식은 Icon 기본값).
// tone 색은 className(currentColor)로 상속 · align-middle 로 텍스트흐름/flex 양쪽 수직정렬.
// 맵 미스 → 원문 글리프 span 폴백(회귀 안전 — 미등록 기호도 깨지지 않음).
function SymI({ s, size = 13, className = "" }) {
	const { Icon } = window.UI;
	const name = SYMBOL_ICON_I[s];
	if (!name)
		return (
			<span aria-hidden="true" className={className}>
				{s}
			</span>
		);
	return (
		<Icon
			name={name}
			size={size}
			className={`align-middle ${className}`.trim()}
		/>
	);
}

// 통합 endpoint 활성 라벨 (단일 source).
const SRC_LABEL_UNIFIED = { t: "ok", s: "✓", x: "Unified endpoint" };
const SRC_LABEL_LOADING = { t: "info", s: "ℹ", x: "Loading…" };

function ScreenImprovement({ onNav }) {
	const { Icon, PageHeader, Pill, TypeScaleStyle } = window.UI;

	const [listState, setListState] = useSI({
		status: "loading",
		data: null,
		error: null,
		source: null,
	});
	const [statsState, setStatsState] = useSI({
		status: "loading",
		data: null,
		error: null,
	});
	// Attribution Health 포인터 — Outcome 화면의 canonical 카드와 동일 endpoint 직접 fetch
	// (single SoT).
	const [attributionState, setAttributionState] = useSI({
		status: "loading",
		data: null,
		error: null,
	});
	// orphan endpoint — 독립 fetch-state (loading/ready/error · 부분 실패 격리).
	const [learningLogState, setLearningLogState] = useSI({
		status: "loading",
		data: null,
		error: null,
	});
	// 검토 필요 사유 세그먼트 행 (F12) — 독립 fetch-state (실패 시 KPI 는 plain count 로 degrade).
	const [reviewReasonState, setReviewReasonState] = useSI({
		status: "loading",
		data: null,
		error: null,
	});
	// loop-events 집계 fetch-state — 부분 실패 격리 (실패 시 변경량/추세 카드만 생략).
	const [loopEventsState, setLoopEventsState] = useSI({
		status: "loading",
		data: null,
		error: null,
	});
	// correction_signals 집계 fetch-state — 부분 실패 격리 (실패 시 해당 카드만 생략).
	const [correctionState, setCorrectionState] = useSI({
		status: "loading",
		data: null,
		error: null,
	});
	// corpus-audit fetch-state — 부분 실패 격리 (실패 시 성장 카드만 생략).
	const [corpusAuditState, setCorpusAuditState] = useSI({
		status: "loading",
		data: null,
		error: null,
	});
	const [drawerRow, setDrawerRow] = useSI(null);
	const [toast, setToast] = useSI(null);
	// 허용/거절 in-flight 카드 id (scalar — 카드 액션은 직렬 1건 · Set 불필요).
	// null = 진행 중 액션 없음 · row.id 일치 시 해당 카드 버튼 비활성 + 스피너.
	const [pendingActionId, setPendingActionId] = useSI(null);
	const [refreshTick, setRefreshTick] = useSI(0);

	const listAbortRef = useRI(null);
	const attributionAbortRef = useRI(null);
	const orphanAbortRef = useRI(null);
	const reviewReasonAbortRef = useRI(null);
	const loopEventsAbortRef = useRI(null);
	const correctionAbortRef = useRI(null);
	const corpusAuditAbortRef = useRI(null);
	const toastTimerRef = useRI(null);

	const triggerRefresh = useCI(() => setRefreshTick((t) => t + 1), []);

	const showToast = useCI((tone, message) => {
		setToast({ tone, message });
		if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		toastTimerRef.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
	}, []);

	// 허용(approve)/거절(reject) 카드 액션.
	// 성공 → toast + triggerRefresh (재fetch 로 카드가 applied/rejected 컬럼으로 이동).
	// 실패 → status 코드별 명시 toast (silent fallback 금지). approve 는 high-impact
	// (daemon-apply 가 agents .md mutation) 이므로 응답까지 카드 비활성 (중복 클릭 차단).
	// in-flight → pendingActionId 로 해당 카드 버튼 disable + 스피너.
	// finally 로 해제 — try 내 성공 return (res.ok) 이 inline clear 를 건너뛰므로 finally 필수.
	const runAction = useCI(
		async (action, row) => {
			const id = row?.id;
			if (id === undefined || id === null) return;
			setPendingActionId(id);
			const url = action === "approve" ? APPROVE_URL(id) : REJECT_URL(id);
			try {
				const res = await fetch(url, {
					method: "POST",
					headers: { Accept: "application/json" },
				});
				const body = await res.json().catch(() => ({}));
				if (res.ok) {
					showToast(
						"ok",
						action === "approve"
							? `Suggestion #${id} approved and applied (applied)`
							: `Suggestion #${id} rejected (rejected)`,
					);
					triggerRefresh();
					return;
				}
				// 비-2xx — body.reason 우선, 없으면 HTTP status.
				const reason =
					body && body.reason ? String(body.reason) : `HTTP ${res.status}`;
				const tone = res.status === 409 ? "warn" : "crit";
				showToast(
					tone,
					`Couldn't ${action} suggestion #${id}: ${reason.slice(0, 80)}`,
				);
				// 409 (already terminal / noop) → 서버 상태가 이미 변했을 수 있으니 refresh.
				if (res.status === 409) triggerRefresh();
			} catch (err) {
				const detail = err?.message || String(err);
				showToast(
					"crit",
					`Suggestion #${id} ${action} request error: ${detail.slice(0, 80)}`,
				);
			} finally {
				setPendingActionId(null);
			}
		},
		[showToast, triggerRefresh],
	);

	useEI(
		() => () => {
			if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		},
		[],
	);

	useEI(() => {
		const ctrl = new AbortController();
		listAbortRef.current?.abort();
		listAbortRef.current = ctrl;
		setListState({ status: "loading", data: null, error: null, source: null });
		setStatsState({ status: "loading", data: null, error: null });

		fetchUnifiedI(ctrl.signal)
			.then(({ list, stats, source }) => {
				if (ctrl.signal.aborted) return;
				setListState({ status: "ready", data: list, error: null, source });
				setStatsState({ status: "ready", data: stats, error: null });
			})
			.catch((err) => {
				if (ctrl.signal.aborted || err?.name === "AbortError") return;
				const detail = err?.message || String(err);
				setListState({
					status: "error",
					data: null,
					error: detail,
					source: null,
				});
				setStatsState({ status: "error", data: null, error: detail });
				showToast("crit", `Couldn't load data: ${detail.slice(0, 80)}`);
			});

		return () => ctrl.abort();
	}, [refreshTick, showToast]);

	// Attribution Health 포인터 fetch — Outcome 화면 canonical 카드와 동일 endpoint (single SoT).
	// 7일 window 만 필요 (포인터 headline) → days=7. AbortController 는 unified 와 분리.
	useEI(() => {
		const ctrl = new AbortController();
		attributionAbortRef.current?.abort();
		attributionAbortRef.current = ctrl;
		setAttributionState({ status: "loading", data: null, error: null });

		fetch("/api/outcomes/attribution-daily?days=7", {
			signal: ctrl.signal,
			headers: { Accept: "application/json" },
		})
			.then((res) => {
				if (!res.ok) throw new Error(`attribution-daily HTTP ${res.status}`);
				return res.json();
			})
			.then((data) => {
				if (ctrl.signal.aborted) return;
				setAttributionState({ status: "ready", data, error: null });
			})
			.catch((err) => {
				if (ctrl.signal.aborted || err?.name === "AbortError") return;
				setAttributionState({
					status: "error",
					data: null,
					error: err?.message || String(err),
				});
			});

		return () => ctrl.abort();
	}, [refreshTick]);

	// 검토 필요 사유 세그먼트 fetch (F12) — KPI 집계값의 행 단위 재분류용.
	// 실패는 세그먼트만 생략 (부분 실패 격리 — KPI plain count 유지, 0 조작 금지).
	useEI(() => {
		const ctrl = new AbortController();
		reviewReasonAbortRef.current?.abort();
		reviewReasonAbortRef.current = ctrl;
		setReviewReasonState({ status: "loading", data: null, error: null });

		fetch(REVIEW_REASON_ROWS_URL, {
			signal: ctrl.signal,
			headers: { Accept: "application/json" },
		})
			.then((res) => {
				if (!res.ok) throw new Error(`outcomes search HTTP ${res.status}`);
				return res.json();
			})
			.then((data) => {
				if (ctrl.signal.aborted) return;
				setReviewReasonState({ status: "ready", data, error: null });
			})
			.catch((err) => {
				if (ctrl.signal.aborted || err?.name === "AbortError") return;
				setReviewReasonState({
					status: "error",
					data: null,
					error: err?.message || String(err),
				});
			});

		return () => ctrl.abort();
	}, [refreshTick]);

	// orphan endpoint — AbortController 로 묶은 fetch wave.
	// 응답은 독립 state 로 분기 (부분 실패 격리 — 5xx 가 나머지 카드를 막지 않음).
	// unified/attribution wave 와 별도 ref → 상호 abort 간섭 없음.
	useEI(() => {
		const ctrl = new AbortController();
		orphanAbortRef.current?.abort();
		orphanAbortRef.current = ctrl;
		setLearningLogState({ status: "loading", data: null, error: null });

		fetchOrphanI(LEARNING_LOG_URL, ctrl.signal, setLearningLogState);

		return () => ctrl.abort();
	}, [refreshTick]);

	// loop-events 집계 fetch — orphan helper 재사용 (5xx → error state · 부분 실패 격리).
	// 집계만 소비 (변경량 합계 + 날짜 추세) → raw event 행 미렌더 (outcomes 경계 유지).
	useEI(() => {
		const ctrl = new AbortController();
		loopEventsAbortRef.current?.abort();
		loopEventsAbortRef.current = ctrl;
		setLoopEventsState({ status: "loading", data: null, error: null });

		fetchOrphanI(LOOP_EVENTS_URL, ctrl.signal, setLoopEventsState);

		return () => ctrl.abort();
	}, [refreshTick]);

	// correction_signals 집계 fetch — orphan helper 재사용 (5xx/미배포 → error state · 카드 숨김).
	useEI(() => {
		const ctrl = new AbortController();
		correctionAbortRef.current?.abort();
		correctionAbortRef.current = ctrl;
		setCorrectionState({ status: "loading", data: null, error: null });

		fetchOrphanI(CORRECTION_SIGNALS_URL, ctrl.signal, setCorrectionState);

		return () => ctrl.abort();
	}, [refreshTick]);

	// corpus-audits fetch — orphan helper 재사용 (미배포 테이블/5xx → error state · 카드 숨김).
	useEI(() => {
		const ctrl = new AbortController();
		corpusAuditAbortRef.current?.abort();
		corpusAuditAbortRef.current = ctrl;
		setCorpusAuditState({ status: "loading", data: null, error: null });

		fetchOrphanI(CORPUS_AUDITS_URL, ctrl.signal, setCorpusAuditState);

		return () => ctrl.abort();
	}, [refreshTick]);

	const columnRows = useMI(() => {
		if (listState.status !== "ready" || !listState.data)
			return { safety: [], applied: [], rejected: [] };
		// 액션 컬럼(Awaiting approval)은 actionable fetch 소비 (status pending/snoozed · recency 무제한)
		// · terminal 컬럼(Applied/Rejected)은 recency-bounded proposals 유지.
		// proposals 만 group 하면 최신 50행이 전부 terminal → 액션 컬럼 영구 공백.
		// actionable_proposals 부재 → || [] 가드로 빈 컬럼.
		const actionable = groupByColumnI(
			listState.data.actionable_proposals || [],
		);
		const terminal = groupByColumnI(listState.data.proposals || []);
		return {
			safety: actionable.safety,
			applied: terminal.applied,
			rejected: terminal.rejected,
		};
	}, [listState]);

	// 학습 chain (CTM/EPM) + outcome_summary + join_meta 추출.
	const buckets = useMI(() => {
		if (listState.status !== "ready" || !listState.data) return null;
		return {
			ctm: Number(listState.data.ctm_epm_buckets?.ctm_count ?? 0),
			epm: Number(listState.data.ctm_epm_buckets?.epm_count ?? 0),
			outcome: listState.data.outcome_summary || null,
			joinMeta: listState.data.join_meta || null,
		};
	}, [listState]);

	// 정지(parked) 루프 상태 — capped_patterns>0 일 때만 배너. K=0 은 배너 자체가 없어야 하므로
	// 상수 문자열이 아니라 payload 의 rearm_hint 로 렌더한다.
	const applyCapState = useMI(() => {
		if (learningLogState.status !== "ready" || !learningLogState.data)
			return null;
		return learningLogState.data.apply_cap_state || null;
	}, [learningLogState]);

	// 루프 억제 분해 — 배너와 같은 payload 에서 뽑되 별도 상태다. 배너는 cap 하나를 경고하고,
	// 이 값은 다섯 경로 전체를 분해한다.
	const loopSuppression = useMI(() => {
		if (learningLogState.status !== "ready" || !learningLogState.data)
			return null;
		return learningLogState.data.loop_suppression_state || null;
	}, [learningLogState]);

	// prose-only-add per-agent rolling count — null-safe (verdict 없는 구간에선 빈 배열).
	const proseOnlyAdd = useMI(() => {
		if (listState.status !== "ready" || !listState.data) return null;
		return listState.data.prose_only_add_summary || null;
	}, [listState]);

	// style_ref telemetry 추출 — null-safe (OPTIONAL 단계에서는 모든 row 가 NULL 일 수 있음).
	const styleRef = useMI(() => {
		if (listState.status !== "ready" || !listState.data) return null;
		return listState.data.style_ref_summary || null;
	}, [listState]);

	// 3-Tier baseline cohort split 추출 — fixed 30d window.
	// Pre-migration-apply 상태 (column 부재) → API 503 → listState.error 분기에서 카드 자동 숨김.
	const tierBreakdown = useMI(() => {
		if (listState.status !== "ready" || !listState.data) return null;
		return listState.data.tier_breakdown_30d || null;
	}, [listState]);

	// confidence_observed × promotion_tier 분포 추출 — null-safe (모든 row NULL 가능).
	const confidenceDist = useMI(() => {
		if (listState.status !== "ready" || !listState.data) return null;
		return listState.data.confidence_distribution || null;
	}, [listState]);

	// 사유 partition — 행별 reviewFlagReasons[0](우선순위 1순위) 기준 1행 1세그먼트
	// (복수 사유 행의 이중 집계 방지). 오염 행 제외 → KPI 모집단(오염 구간 제외) 정합.
	const reviewReasonSegments = useMI(() => {
		if (reviewReasonState.status !== "ready" || !reviewReasonState.data)
			return null;
		const fetchedRows = reviewReasonState.data.rows || [];
		const rows = fetchedRows.filter((r) => r.poisoned_window !== true);
		const byKey = new Map();
		for (const row of rows) {
			const first = window.UI.reviewFlagReasons(row)[0];
			if (!first) continue;
			const entry = byKey.get(first.key) || { ...first, count: 0 };
			entry.count += 1;
			byKey.set(first.key, entry);
		}
		const items = window.UI.REVIEW_FLAG_REASON_ORDER.map((key) =>
			byKey.get(key),
		).filter(Boolean);
		// limit=200 캡 절단 시 부분 표본 → 세그먼트에 표본 기준 고지.
		const isTruncated =
			Number(reviewReasonState.data.total ?? 0) > fetchedRows.length;
		return { items, classifiedTotal: rows.length, isTruncated };
	}, [reviewReasonState]);

	// loop-events 집계 유도 — 변경량 합계(T-IMP-1) + 날짜 추세 2-시리즈(T-IMP-4)
	// + 윈도우 전/후반 reject 비율(T-IMP-6). 모두 실데이터 (가짜 채움 없음).
	const loopAggregate = useMI(() => {
		if (loopEventsState.status !== "ready" || !loopEventsState.data)
			return null;
		return deriveLoopAggregateI(loopEventsState.data);
	}, [loopEventsState]);

	const srcMeta =
		listState.source === "unified" ? SRC_LABEL_UNIFIED : SRC_LABEL_LOADING;

	return (
		<div className="h-full flex flex-col min-h-0">
			{/* 타입 스케일 토큰 (ui.jsx SoT) — 멱등 마운트. .fs-* 유틸 + --fs-* CSS var 공급. */}
			<TypeScaleStyle />
			<style>{`
        @keyframes skelPulseI { 0%,100%{opacity:.7} 50%{opacity:.35} }
        @keyframes toastInI   { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spinI { from{transform:rotate(0)} to{transform:rotate(360deg)} }
        @media (prefers-reduced-motion: reduce) { [class*="i-anim-"], .i-act-spin { animation-duration:0.01ms !important; } }
        /* inset ring — column overflow-y-auto 클리핑 회피 (outset ring 잘림 방지). */
        .i-card-shadow { box-shadow:0 1px 2px rgba(0,0,0,0.04), inset 0 0 0 1px rgb(var(--line)); }
        .i-card-shadow:hover { box-shadow:0 2px 8px rgba(0,0,0,0.08), inset 0 0 0 1px rgb(var(--accent) / 0.4); }
        .i-row-card { transition:box-shadow 120ms, transform 120ms; cursor:pointer; }
        .i-row-card:hover { transform:translateY(-1px); }
        .i-row-card:focus-visible { outline:2px solid rgb(var(--accent)); outline-offset:2px; }
        .i-anim-skel { animation:skelPulseI 1.4s ease-in-out infinite; }
        .i-anim-toast { animation:toastInI 180ms ease-out; }
        /* 카드 메타 배지 — 전부 canonical window.UI.Badge(.pill family)로 이관 (screen-local 배지 CSS 폐지).
           tone 은 status Badge 의 내부 Icon(text-{tone})이 운반 · shell 은 항상 neutral(loud fill 금지 · dual-encode 보존). */
        /* 시그니처 셀 — 2줄 클램프 + 셀 최소폭(crush 방지) + 행 최소높이(1↔2줄 점프 차단). */
        /* line-clamp-2 = webkit box · word-break 으로 긴 단일 토큰도 줄바꿈 → 가로 overflow 방지. */
        .i-sig-cell { min-width:200px; max-width:0; width:60%; }
        .i-sig-clamp { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; word-break:break-word; line-height:1.4; min-height:2.8em; }
        /* 허용/거절 액션 버튼 — dual-encoded (색 + ✓/✕ 기호) · WCAG AA contrast. */
        .i-act-btn { flex:1; display:inline-flex; align-items:center; justify-content:center; gap:4px; font-family:'JetBrains Mono',monospace; font-size:var(--fs-meta); font-weight:600; padding:5px 8px; border-radius:6px; border:1px solid transparent; cursor:pointer; transition:background 120ms, border-color 120ms; }
        .i-act-btn:focus-visible { outline:2px solid rgb(var(--accent)); outline-offset:1px; }
        /* RC4 in-flight — opacity 둔감화 + pointer-events:none 가 실제 중복 클릭 게이트. */
        .i-act-btn:disabled { opacity:.55; cursor:progress; pointer-events:none; }
        /* 스피너 — 텍스트 글리프(↻)에서 인라인 <svg>(Icon 'refresh')로 교체됨. svg 루트는
           transform-origin/transform-box 기본값이 브라우저별로 갈려 off-center wobble 위험 →
           fill-box + center 로 아이콘 자기 중심 회전 고정(제자리 스핀 보장). reduced-motion 시 정지. */
        .i-act-spin { display:inline-block; transform-box:fill-box; transform-origin:center; animation:spinI 0.7s linear infinite; }
        .i-act-approve { color:rgb(var(--ok)); border-color:rgb(var(--ok) / 0.45); background:rgb(var(--ok) / 0.1); }
        .i-act-approve:hover { background:rgb(var(--ok) / 0.2); border-color:rgb(var(--ok) / 0.7); }
        .i-act-reject { color:rgb(var(--crit)); border-color:rgb(var(--crit) / 0.45); background:rgb(var(--crit) / 0.1); }
        .i-act-reject:hover { background:rgb(var(--crit) / 0.2); border-color:rgb(var(--crit) / 0.7); }
        /* T3 — 종결 그리드 비대칭(applied 2fr : rejected 1fr). 인라인 gridTemplateColumns 금지
           (미디어쿼리가 인라인 스타일을 못 이김) → 클래스 선언 + <640px 단일 컬럼 붕괴를 같은
           블록에서 직접 출하(base.css L607 은 drawer 전용 → 보드 붕괴 미담당 · 검증 완료). */
        .board-terminal-grid { display:grid; grid-template-columns:2fr 1fr; gap:12px; }
        @media (max-width:640px) { .board-terminal-grid { grid-template-columns:1fr; } }
        /* T2 — AWAITING 존. 0건 = 슬림 idle 스트립(amber 없음, --sunken/--line 중립).
           ≥1건 = 상단 full-width --warn 배너(populated-대기에만 amber 소비 · T7). */
        .i-await-strip { display:flex; align-items:center; gap:6px; min-height:30px; padding:0 12px;
          background:rgb(var(--sunken)); border:1px solid rgb(var(--line)); border-radius:8px;
          color:rgb(var(--faint)); font-family:'JetBrains Mono',monospace; font-size:var(--fs-micro); }
        .i-await-banner { border:1px solid rgb(var(--warn) / 0.45); border-radius:10px;
          background:rgb(var(--warn) / 0.08); padding:10px 12px; animation:iAwaitInI 200ms ease-out; }
        .i-await-head { display:flex; align-items:center; gap:8px; font-family:'JetBrains Mono',monospace;
          text-transform:uppercase; letter-spacing:0.05em; color:rgb(var(--warn)); font-size:var(--fs-meta); }
        .i-await-body { display:flex; flex-direction:column; gap:8px; margin-top:8px;
          max-height:40vh; overflow-y:auto; }
        @keyframes iAwaitInI { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
        /* T8 — reduced-motion: 공간 오버슈트 제거, opacity-only 전이(keyframe 재정의). */
        @media (prefers-reduced-motion: reduce) {
          @keyframes iAwaitInI { from { opacity:0; } to { opacity:1; } }
        }
        /* T6 — APPLIED/REJECTED 종결-컬럼 헤더 공용 밴드. 두 헤더 동일 min-height + 세로중앙 정렬 →
           헤더 아래 리스트 시작 Y 일치(컬럼 간 top/height 동기화). 26px = fs-display 22px count 를 담는 높이. */
        .i-col-header { min-height:26px; display:flex; align-items:center; }
        /* T6 — APPLIED hero. 큰 22px --ok count 는 hero 축 세로중앙(.i-col-header) · ✓+APPLIED 라벨은
           별도 inline-flex 그룹으로 묶어 자기들끼리 세로중앙(✓ mid = 라벨 mid) → 붕 뜸 제거. gap 만 담당. */
        .i-applied-hero { gap:6px; }
        /* T5 — REJECTED 컴팩트 행(단일행 · rationale 숨김 · 중립 chrome). --crit 는 ✕ 심볼에만. */
        .i-compact-row { display:flex; align-items:center; gap:6px; padding:5px 8px; }
        .i-compact-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        /* T5/T8 — '＋N more' 실제 포커스 가능 버튼(요약 토글). 중립 chrome. */
        .i-more-btn { display:flex; align-items:center; justify-content:center; gap:4px; width:100%;
          padding:6px 8px; border:1px dashed rgb(var(--line)); border-radius:8px; background:transparent;
          color:rgb(var(--faint)); font-family:'JetBrains Mono',monospace; font-size:var(--fs-micro); cursor:pointer; }
        .i-more-btn:hover { color:rgb(var(--dim)); border-color:rgb(var(--faint) / 0.5); }
        .i-more-btn:focus-visible { outline:2px solid rgb(var(--accent)); outline-offset:2px; }
      `}</style>

			<div className="flex-shrink-0">
				<PageHeader
					sub="Self-improvement loop"
					title="Learning & self-improvement"
					right={
						<button
							className="btn ghost sm"
							onClick={triggerRefresh}
							aria-label="Refresh learning data"
						>
							<Icon name="refresh" size={14} />
							Refresh
						</button>
					}
				/>
			</div>

			{/* 순서 — 1차 액션 surface 인 칸반을 최상단으로, KPI/통계 카드는 그 아래로.
          제안 허용/거절 행위 빈도가 KPI 조회보다 훨씬 높음 → 칸반 우선.
          .space-sections(24px) — 독립 통계 섹션을 16px 카드 채널보다 한 단 넓게 분리(W1-T3 · C-REGION). */}
			<div className="space-sections flex-1 min-h-0">
				<ParkedLoopBannerI applyCap={applyCapState} />
				<LoopSuppressionCardI
					state={learningLogState}
					suppression={loopSuppression}
				/>
				<div className="flex-1 min-h-0">
					<KanbanCardI
						state={listState}
						columnRows={columnRows}
						loopAggregate={loopAggregate}
						onRowClick={setDrawerRow}
						onAction={runAction}
						pendingActionId={pendingActionId}
						onRetry={triggerRefresh}
					/>
				</div>
				<KpiRowI
					state={statsState}
					reviewReasons={reviewReasonSegments}
					onRetry={triggerRefresh}
				/>
				<ChangeSummaryCardI
					state={loopEventsState}
					aggregate={loopAggregate}
					onRetry={triggerRefresh}
				/>
				<BucketRowI state={listState} buckets={buckets} />
				<RankedCandidateCardI
					state={learningLogState}
					onRowClick={setDrawerRow}
					onRetry={triggerRefresh}
				/>
				<AttributionPointerCardI state={attributionState} onNav={onNav} />
				<LearningLogCardI state={learningLogState} onRetry={triggerRefresh} />
				<InstrumentationViewI
					listState={listState}
					loopEventsState={loopEventsState}
					loopAggregate={loopAggregate}
					correctionState={correctionState}
					corpusAuditState={corpusAuditState}
					styleRef={styleRef}
					proseOnlyAdd={proseOnlyAdd}
					tierBreakdown={tierBreakdown}
					confidenceDist={confidenceDist}
				/>
			</div>

			{drawerRow && (
				<DetailDrawerI row={drawerRow} onClose={() => setDrawerRow(null)} />
			)}
			{toast && <ToastI tone={toast.tone} message={toast.message} />}
		</div>
	);
}

// ----- KPI row (Skim) — dual-encoding label (색상 + 기호). -----------

function KpiRowI({ state, reviewReasons, onRetry }) {
	const { KPI } = window.UI;

	if (state.status === "loading") {
		return (
			<div
				className="grid grid-cols-4 gap-3 mb-3"
				aria-busy="true"
				aria-label="Loading KPIs"
			>
				{Array.from({ length: 4 }).map((_, i) => (
					<div
						key={i}
						className="i-anim-skel"
						style={{
							height: 86,
							borderRadius: 8,
							background: "rgb(var(--sunken))",
							opacity: 0.7,
						}}
					/>
				))}
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div className="mb-3">
				<ErrorBannerI
					title="Couldn't load KPI data"
					detail={state.error}
					onRetry={onRetry}
				/>
			</div>
		);
	}

	const s = state.data || {};
	const td = s.tier_distribution || {};
	const autoCnt = Number(td.auto ?? 0),
		safetyCnt = Number(td.safety ?? 0);
	const applied7d = Number(s.applied_last_7d ?? 0);
	const rejected7d = Number(s.rejected_last_7d ?? 0);
	// 무윈도 lifetime 적용량 — 7d/30d 윈도가 구조적으로 숨기는 이력 적용 버스트를 노출.
	// apply_rate = applied/(applied+rejected) → 분자·분모 모두 명시 (formatPctWithDenominator).
	const appliedAllTime = Number(s.applied_all_time ?? 0);
	const rejectedAllTime = Number(s.rejected_all_time ?? 0);
	const applyRateLifetime = window.UI.formatPctWithDenominator(
		appliedAllTime,
		appliedAllTime + rejectedAllTime,
	);
	const reviewFlag = Number(s.review_flag_last_7d ?? 0);
	// zero_apply_cycle_rate = 적용 0건 사이클 비율 — "제안 생성 실패" 아님 (생성은 성공했을 수 있음).
	const zeroApplyRate = Number(
		s.zero_apply_cycle_rate ?? s.haiku_skipped_rate ?? 0,
	);
	const cycleTotal = Number(s.cycle_total_7d ?? 0);
	// 무적용 = 생성-미적용 + 무생성 (적용 0건 partition 합) → 'N.N% (x/y)' headline (A5).
	// cycle_total_7d 미존재 (legacy payload) → 비율 단독 fallback.
	const zeroApplyCycles =
		Number(s.cycles_generated_not_applied_7d ?? 0) +
		Number(s.cycles_nothing_generated_7d ?? 0);
	const zeroApplyHeadline =
		cycleTotal > 0
			? window.UI.formatPctWithDenominator(zeroApplyCycles, cycleTotal)
			: `${(zeroApplyRate * 100).toFixed(1)}%`;

	return (
		<div className="mb-3">
			{/* tier KPI = 전체 누적 — 칸반 배지의 '최근 30일 전수'와 윈도우가 다름 → 라벨에 명시. */}
			<div className="grid grid-cols-4 gap-3">
				<KPI
					label={
						<span className="inline-flex items-center gap-1.5">
							<SymI s="✓" className="text-ok" size={12} />
							Suggestions by track (all time)
						</span>
					}
					value={`${formatIntI(autoCnt)} · ${formatIntI(safetyCnt)}`}
					hint={`auto ${formatIntI(autoCnt)} · needs approval ${formatIntI(safetyCnt)}`}
				/>
				<KPI
					label={
						<span className="inline-flex items-center gap-1.5">
							<SymI s="✓" className="text-ok" size={12} />
							Applied (7 days)
						</span>
					}
					value={formatIntI(applied7d)}
					hint={`apply rate ${applyRateLifetime}`}
				/>
				<KPI
					label={
						<span className="inline-flex items-center gap-1.5">
							<SymI s="⚠" className="text-warn" size={12} />
							Rejected (7 days)
						</span>
					}
					value={formatIntI(rejected7d)}
					hint="Auto-rejected by the loop"
				/>
				{/* 7d qualifier 를 label 에 명시 — 이 KPI=7d, BucketRow 검토필요=30d 가 한 화면 공존. */}
				<KPI
					label={
						<span className="inline-flex items-center gap-1.5">
							<SymI s="ℹ" className="text-info" size={12} />
							Flagged results (7 days)
						</span>
					}
					value={formatIntI(reviewFlag)}
					hint={
						<ReviewReasonSegmentsI
							segments={reviewReasons}
							fallback="Flagged outcomes"
						/>
					}
				/>
			</div>
			<CycleDecompositionRowI stats={s} />
		</div>
	);
}

// 검토 필요 사유 세그먼트 (F12) — 0건 버킷은 생략 (노이즈 억제), 정의는 title 로.
// 세그먼트 fetch 실패/로딩 → fallback 설명으로 degrade (가짜 0 금지, A7).
// 합 ≠ KPI 값 가능 (KPI=서버 집계 · 세그먼트=행 표본 분류, 30s 캐시 스큐) → title 에 표본 고지.
function ReviewReasonSegmentsI({ segments, fallback }) {
	if (!segments || segments.items.length === 0) return <>{fallback}</>;
	const title =
		`Why results were flagged — last 7 days · quarantined excluded · ${segments.classifiedTotal} rows classified: ` +
		segments.items.map((s) => `${s.label} ${s.count} (${s.title})`).join(" / ");
	return (
		<span title={title}>
			{segments.items.map((s, i) => (
				<span key={s.key}>
					{i > 0 && " · "}
					{s.label} {formatIntI(s.count)}
				</span>
			))}
		</span>
	);
}

// 사이클 3-분해 chip stat row — 생성+적용 / 생성-미적용 / 무생성 (≤3 카테고리 → 차트 대신 칩).
// 세 카운트는 cycle_total_7d 를 정확히 분할 (서버 partition 보장) → 합계 병기.
function CycleDecompositionRowI({ stats }) {
	const { Badge } = window.UI;
	const chips = [
		[
			"✓",
			"text-ok",
			"Created & applied",
			Number(stats.cycles_generated_applied_7d ?? 0),
		],
		[
			"⚠",
			"text-warn",
			"Created, not applied",
			Number(stats.cycles_generated_not_applied_7d ?? 0),
		],
		[
			"ℹ",
			"text-info",
			"Nothing created",
			Number(stats.cycles_nothing_generated_7d ?? 0),
		],
	];

	// 카테고리 = symbol+tone+label 로 dual-encode(색 단독 아님), 수량 = neutral count Badge(color≠count 규칙).
	return (
		<div className="flex items-center gap-2.5 mt-2 flex-wrap">
			<span className="fs-micro font-mono text-faint uppercase tracking-wider">
				Run breakdown (7 days)
			</span>
			{chips.map(([sym, tone, label, count]) => (
				<span key={label} className="fs-meta inline-flex items-center gap-1.5">
					<SymI s={sym} className={tone} size={12} />
					<span className={tone}>{label}</span>
					<Badge role="count">{formatIntI(count)}</Badge>
				</span>
			))}
		</div>
	);
}

// ----- Kanban (Scan) — 클릭 시 drawer 열림. -----------------------

function KanbanCardI({
	state,
	columnRows,
	loopAggregate,
	onRowClick,
	onAction,
	pendingActionId,
	onRetry,
}) {
	const { CardHead } = window.UI;
	const isLoading = state.status === "loading";
	const isError = state.status === "error";
	const rejectBuckets = state.data?.reject_bucket_summary || null;

	// 카드 max-h:70vh — 본문 페이지 무한 늘어남 차단 · 컬럼 내부만 자체 스크롤.
	// 레이아웃: ROW-1 = AWAITING 존(그리드 밖 배너/스트립, T2) · ROW-2 = 종결 그리드(2fr/1fr, T3).
	return (
		<div
			className="card flex flex-col"
			style={{ maxHeight: "70vh", overflow: "hidden" }}
		>
			<div className="flex-shrink-0">
				<CardHead title="Suggestion board" />
			</div>
			{isError ? (
				<div className="p-4">
					<ErrorBannerI
						title="Couldn't load the suggestion board"
						detail={state.error}
						onRetry={onRetry}
					/>
				</div>
			) : (
				<div className="flex flex-col gap-3 p-3 flex-1 min-h-0 overflow-hidden">
					{/* ROW-1 — AWAITING 존 (승인 대기, 유일한 행동 유발 레인 → 최상단 배치). */}
					{isLoading ? (
						<div
							className="i-anim-skel flex-shrink-0"
							style={{
								minHeight: 30,
								borderRadius: 8,
								background: "rgb(var(--sunken))",
								opacity: 0.7,
							}}
						/>
					) : (
						<AwaitingZoneI
							rows={columnRows.safety || []}
							onRowClick={onRowClick}
							onAction={onAction}
							pendingActionId={pendingActionId}
						/>
					)}
					{/* ROW-2 — 종결 그리드 (applied 2fr : rejected 1fr, safety 제외). */}
					<div className="board-terminal-grid flex-1 min-h-0 overflow-hidden">
						{TERMINAL_COLUMNS.map((col) =>
							isLoading ? (
								<div
									key={col.key}
									className="i-anim-skel"
									style={{
										borderRadius: 8,
										background: "rgb(var(--sunken))",
										opacity: 0.7,
									}}
								/>
							) : (
								<KanbanColumnI
									key={col.key}
									column={col}
									rows={columnRows[col.key] || []}
									loopAggregate={loopAggregate}
									rejectBuckets={rejectBuckets}
									onRowClick={onRowClick}
									onAction={onAction}
									pendingActionId={pendingActionId}
								/>
							),
						)}
					</div>
				</div>
			)}
		</div>
	);
}

// ROW-1 AWAITING 존 (T2/T8) — aria-live 래퍼는 count 무관 항상 DOM 상주(영속),
// 스트립 ↔ 배너 콘텐츠만 그 안에서 교체 → 마운트/언마운트 aria-live 레이스 회피.
function AwaitingZoneI({ rows, onRowClick, onAction, pendingActionId }) {
	const hasItems = rows.length > 0;
	return (
		<div role="status" aria-live="polite" className="flex-shrink-0">
			{hasItems ? (
				<AwaitingBannerI
					rows={rows}
					onRowClick={onRowClick}
					onAction={onAction}
					pendingActionId={pendingActionId}
				/>
			) : (
				<AwaitingStripI />
			)}
		</div>
	);
}

// ≥1건 — 상단 full-width amber 배너 (populated-대기에만 --warn 소비 · T7). maxHeight 40vh 스크롤.
function AwaitingBannerI({ rows, onRowClick, onAction, pendingActionId }) {
	return (
		<div className="i-await-banner">
			<div className="i-await-head">
				<SymI s={SAFETY_COLUMN.symbol} size={13} />
				<span>{SAFETY_COLUMN.label}</span>
				<span className="tnum">{formatIntI(rows.length)}</span>
				<span className="ml-auto fs-micro">Your call</span>
			</div>
			<div className="i-await-body">
				{rows.map((row) => (
					<ProposalCardI
						key={row.id}
						row={row}
						onClick={() => onRowClick(row)}
						onAction={onAction}
						pendingActionId={pendingActionId}
					/>
				))}
			</div>
		</div>
	);
}

// 0건 — 슬림 idle 스트립 (~30px, amber 없음 · --sunken/--line 중립 · ℹ dual-encode).
// 레이아웃에서 제거하지 않아 발견가능성 유지(collapse-not-hide, G3).
function AwaitingStripI() {
	return (
		<div className="i-await-strip">
			<SymI s="ℹ" size={12} />
			<span>No suggestions awaiting approval</span>
		</div>
	);
}

// 종결 레인 — variant 라우팅(T4): full → ProposalCardI · compact → CompactProposalCardI(폴백 full).
// 헤더는 레인별 분기(T6 APPLIED hero · Rejected 중립 헤더 + reject 스파크) · Bar 부피막대 폐기(DR-3).
function KanbanColumnI({
	column,
	rows,
	loopAggregate,
	rejectBuckets,
	onRowClick,
	onAction,
	pendingActionId,
}) {
	const { EmptyState } = window.UI;
	const isCompact = column.variant === "compact";
	// 빈-컬럼 안내 — 원인 한 줄 + 다음-단계 힌트 (bare "Empty" 대체, 공용 EmptyState atom SoT).
	const emptyMessage =
		column.key === "applied" ? "Nothing applied yet" : "Nothing rejected";
	const emptyHint =
		column.key === "applied"
			? "Approved suggestions move here once the loop applies them."
			: "Suggestions the loop or a reviewer turned down show up here.";
	// 헤더 sticky + --elev 배경 — 카드 본문 톤과 통일 · row scroll 시 헤더 비침 차단.
	return (
		<div className="flex flex-col min-h-0 gap-2">
			<div
				className="flex flex-col gap-1 flex-shrink-0"
				style={{
					position: "sticky",
					top: 0,
					zIndex: 1,
					background: "rgb(var(--elev))",
					paddingBottom: 4,
				}}
			>
				{column.key === "applied" ? (
					<AppliedHeroHeaderI
						count={rows.length}
						label={column.label}
						symbol={column.symbol}
					/>
				) : (
					<React.Fragment>
						<RejectedHeaderI
							count={rows.length}
							label={column.label}
							symbol={column.symbol}
							trend={loopAggregate?.trend}
						/>
						<RejectBucketSplitI summary={rejectBuckets} />
					</React.Fragment>
				)}
			</div>
			<div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
				{rows.length === 0 ? (
					<EmptyState message={emptyMessage} hint={emptyHint} />
				) : isCompact ? (
					<RejectedCompactListI rows={rows} onRowClick={onRowClick} />
				) : (
					rows.map((row) => (
						<ProposalCardI
							key={row.id}
							row={row}
							onClick={() => onRowClick(row)}
							onAction={onAction}
							pendingActionId={pendingActionId}
						/>
					))
				)}
			</div>
		</div>
	);
}

// T6 — APPLIED hero 헤더. 22px --ok tnum count + ✓ + 'APPLIED'(fs-micro 라벨 ≈ 2:1). 부피막대 없음.
function AppliedHeroHeaderI({ count, label, symbol }) {
	return (
		<div className="i-applied-hero i-col-header">
			<span
				className="fs-display tnum font-mono text-ok"
				style={{ lineHeight: 1 }}
			>
				{formatIntI(count)}
			</span>
			<span className="inline-flex items-center gap-1.5">
				<SymI s={symbol} className="text-ok" size={14} />
				<span className="fs-micro font-mono uppercase tracking-wider text-ok">
					{label}
				</span>
			</span>
		</div>
	);
}

// T5/T6/T7 — REJECTED 중립 헤더. --crit 는 ✕ 심볼·count·스파크에만, 라벨 chrome 은 그레이(--dim).
// reject 스파크는 헤더 우측(loopAggregate.trend reject 계열 · stroke --crit/0.6 ≠ --warn).
function RejectedHeaderI({ count, label, symbol, trend }) {
	return (
		<div className="i-col-header gap-1.5 fs-meta font-mono uppercase tracking-wider">
			<SymI s={symbol} className="text-crit" size={13} />
			<span className="text-dim">{label}</span>
			<span className="text-crit tnum">{formatIntI(count)}</span>
			<span className="ml-auto flex items-center">
				<RejectSparkI trend={trend} />
			</span>
		</div>
	);
}

// T7 — REJECTED 3분할(quality/infra/lifecycle) · 서버 집계(provenance 필터 포함)를 그대로 표시.
// 클라 재집계/재필터 금지 — 행 모집단이 서버 윈도우와 달라 수치가 어긋난다.
// summary 부재(구 payload) → null = 오늘과 동일 렌더 · chrome 중립(--crit 은 헤더 전용, T7 색상 예약).
function RejectBucketSplitI({ summary }) {
	if (!summary) return null;

	// quality 만 실질 반려 — infra/lifecycle 은 품질 판정에 도달조차 못한 건.
	const cells = [
		[
			"Quality",
			summary.quality_count,
			"A diff existed and was rejected on substance — the only bucket a reject rate may be read from",
		],
		[
			"Infra",
			summary.infra_count,
			"The model call yielded no usable diff (quota / transient / auth) — never judged",
		],
		[
			"Lifecycle",
			summary.lifecycle_count,
			"Superseded by a fresher same-agent proposal — terminated by the cycle, never judged",
		],
	];
	return (
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 fs-micro font-mono">
			{cells.map(([label, count, hint]) => (
				<span
					key={label}
					className="inline-flex items-baseline gap-1"
					title={hint}>
					<span className="text-faint uppercase tracking-wider">{label}</span>
					<span className="text-ink tnum">{formatIntI(Number(count ?? 0))}</span>
				</span>
			))}
		</div>
	);
}

// reject 단일-시리즈 소형 인라인 SVG 스파크 (T5). 출처 = loopAggregate.trend 의 reject 계열.
// stroke = --crit/0.6 (심볼 톤 · --warn 아님, T7). 데이터 2포인트 미만/null → 생략(카운트는 유지).
function RejectSparkI({ trend }) {
	const reject = Array.isArray(trend)
		? trend.map((d) => Number(d.reject) || 0)
		: [];
	if (reject.length < 2) return null;

	const w = 48,
		h = 14;
	const max = Math.max(1, ...reject);
	const path = reject
		.map((v, i) => {
			const x = (i / (reject.length - 1)) * w;
			const y = h - (v / max) * h * 0.85 - 1;
			return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
	return (
		<svg
			width={w}
			height={h}
			viewBox={`0 0 ${w} ${h}`}
			preserveAspectRatio="none"
			role="img"
			aria-label={`Rejection trend over ${reject.length} days — peak ${max} per day`}
		>
			<path
				d={path}
				fill="none"
				stroke="rgb(var(--crit) / 0.6)"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

// T5 — 최근 REJECTED_RECENT_CAP 행만 표시 + 나머지는 '＋N more' 요약(38 은 숫자로 인정).
// '＋N more' 는 실제 포커스 가능 버튼(T8) → in-place 확장 토글(전용 화면 없음, 볼륨은 숫자로만).
function RejectedCompactListI({ rows, onRowClick }) {
	const [isExpanded, setExpanded] = useSI(false);
	const shown = isExpanded ? rows : rows.slice(0, REJECTED_RECENT_CAP);
	const moreCount = rows.length - REJECTED_RECENT_CAP;

	return (
		<React.Fragment>
			{shown.map((row) => (
				<CompactProposalCardI
					key={row.id}
					row={row}
					onClick={() => onRowClick(row)}
				/>
			))}
			{moreCount > 0 && (
				<button
					type="button"
					className="i-more-btn"
					onClick={() => setExpanded((prev) => !prev)}
					aria-expanded={isExpanded}
					aria-label={
						isExpanded
							? "Show fewer declined suggestions"
							: `View all declined suggestions (${formatIntI(moreCount)} more)`
					}
				>
					{isExpanded ? (
						<>
							<SymI s="−" size={12} /> show less
						</>
					) : (
						<>
							<SymI s="＋" size={12} /> {formatIntI(moreCount)} more · view all
						</>
					)}
				</button>
			)}
		</React.Fragment>
	);
}

// T5/T7 — REJECTED 컴팩트 카드. 단일행 · rationale 숨김 · 배지 최소화. 중립 chrome(그레이).
// --crit 는 ✕ 심볼에만 (배경/테두리는 --line/--elev 중립 — 레인 wash 금지).
function CompactProposalCardI({ row, onClick }) {
	const title = row.pattern_label || `Proposal #${row.id}`;
	// USER: APPLIED 와 동일한 title-faint / content-bright 색 인버전 — rationale(content)이 primary bright(text-ink),
	//   반복 title 은 faint(text-faint) 로 후퇴 → REJECTED 행도 content-first 로 읽힘. rationale 부재 시
	//   title 이 primary bright 로 승격(graceful) 하고 하단 demoted 라인은 생략(중복 회피).
	const primary = row.rationale || title;
	return (
		<div className="i-card-shadow bg-elev rounded-md">
			<button
				type="button"
				onClick={onClick}
				className="i-row-card fs-micro font-mono w-full text-left px-2 py-1.5 block"
				aria-label={`View declined suggestion ${row.id} details`}
			>
				{/* 행별 ✕ 없음 — 열 헤더 ✕/--crit 가 rejected 상태를 이미 인코딩(중복 제거).
            primary = content-first(rationale bright, text-ink) 좌측 · id·date tiny/muted(--faint) 우측. */}
				<div className="flex items-center gap-2">
					<span className="i-compact-title text-ink" title={String(primary)}>
						{truncateI(primary, 80)}
					</span>
					<span className="text-faint shrink-0">#{row.id}</span>
					{row.cycle_date && (
						<span className="text-faint shrink-0">
							{formatDateI(row.cycle_date)}
						</span>
					)}
				</div>
				{/* 반복 title 을 faint 로 demote — 좌측 정렬 유지. rationale 이 primary 를 채운 경우에만 렌더
            (rationale 부재 시 title 이 이미 primary → 중복 방지). */}
				{row.rationale && (
					<div
						className="text-faint truncate mt-0.5 text-left"
						title={String(title)}
					>
						{truncateI(title, 80)}
					</div>
				)}
			</button>
		</div>
	);
}

function ProposalCardI({ row, onClick, onAction, pendingActionId }) {
	const { Icon, Badge } = window.UI;
	const isSafety = (row.approval_tier || "auto") !== "auto";
	const title = row.pattern_label || `Proposal #${row.id}`;
	const preVerify = preVerifyBadgeI(
		row.pre_verify_status,
		row.pre_verify_passed,
	);
	const status = row.status || "pending";
	// pending/snoozed 카드만 actionable (terminal 카드 버튼 숨김).
	const isActionable = ACTIONABLE_STATUSES_FE.has(status);
	// 이 카드의 액션이 in-flight 여부 (파생 boolean · raw pendingActionId 미전파).
	const isPending = pendingActionId === row.id;
	const isSnoozed = status === "snoozed";

	return (
		<div className="i-card-shadow bg-elev rounded-md">
			<button
				type="button"
				onClick={onClick}
				className="i-row-card text-left p-2.5 w-full block"
				aria-label={`View suggestion ${row.id} details`}
			>
				{/* 반복 메타를 단일 배지 행으로 통합(USER) — 전부 canonical window.UI.Badge(.pill family)로 렌더.
            순서 [agent][pre-check][NN%] … (ml-auto spacer) … [#id][date]. tone 은 status Badge 의
            내부 Icon(text-{tone})이 운반 · shell 은 항상 neutral(loud green fill 금지 · dual-encode 보존).
            중립 서술 배지(agent·#id·date·snoozed)=metadata role, tone 배지(pre-check·confidence)=status role. */}
				<div className="flex items-center gap-1.5 whitespace-nowrap overflow-hidden">
					{row.target_agent && (
						<Badge
							role="metadata"
							className="min-w-0 max-w-[10rem]"
							title={`Target agent: ${row.target_agent}`}
						>
							<span className="truncate min-w-0">{row.target_agent}</span>
						</Badge>
					)}
					<Badge
						role="status"
						tone={toneKeyI(preVerify.tone)}
						icon
						className="shrink-0"
						title={`Pre-check (dry-run before applying): ${preVerify.label} · ${preVerify.titleHint}`}
					>
						Pre-check
					</Badge>
					{/* confidence_observed(NN%) — NULL → "n/a" 폴백(confidenceBadgeMetaI guard, FIX-B).
              밴드 색은 status Badge 내부 Icon tone 에만. */}
					<ConfidenceBadgeI value={row.confidence_observed} />
					{isSnoozed && (
						<Badge
							role="metadata"
							className="shrink-0"
							title="Snoozed — awaiting decision"
						>
							<Icon name="pause" size={11} />
							snoozed
						</Badge>
					)}
					{/* project_key(프로젝트 파티션 해시, 예: 6af0700947f5)는 카드면 detail 로 판단 → 제거(USER).
              드로어에도 미표기 상태 유지. #id 우측 정렬(ml-auto 가 spacer) → 그 뒤 date. */}
					<Badge role="metadata" className="shrink-0 ml-auto">
						#{row.id}
					</Badge>
					{row.cycle_date && (
						<Badge role="metadata" className="shrink-0">
							{formatDateI(row.cycle_date)}
						</Badge>
					)}
				</div>
				{/* rationale = 1차 콘텐츠로 승격(USER) — fs-body · text-ink · medium weight · 2~3줄 clamp. 카드면에서 가장 강한 텍스트. 부재 시 graceful 미렌더. */}
				{row.rationale && (
					<div
						className="fs-body text-ink font-medium mt-1.5 line-clamp-3"
						title={String(row.rationale)}
					>
						{row.rationale}
					</div>
				)}
				{/* pattern_label = 반복성 높은 2차 카테고리 라벨 → rationale 아래 tiny/faint 태그로 후퇴(USER: de-emphasized, 경쟁 금지). */}
				<div
					className="fs-micro font-mono text-faint mt-1 line-clamp-1"
					title={String(title)}
				>
					{truncateI(title, 80)}
				</div>
			</button>
			{/* 허용/거절 액션 (pending/snoozed only · dual-encoded ✓/✕). */}
			{isActionable && onAction && (
				<ProposalActionsI
					row={row}
					isSafety={isSafety}
					onAction={onAction}
					isPending={isPending}
				/>
			)}
		</div>
	);
}

// 허용(approve)/거절(reject) 버튼 행 — dual-encoded (색 + 기호 ✓/✕).
// safety 카드는 "High-risk — your call" 라벨 추가 (안전 게이트 강조).
// 클릭 시 onAction 위임 → 부모가 fetch + toast + refresh 처리.
// isPending — 이 카드 액션 in-flight → 두 버튼 disable + aria-busy + 스피너
//   (응답까지 중복 클릭 차단 · .i-act-btn:disabled 가 실제 게이트).
function ProposalActionsI({ row, isSafety, onAction, isPending }) {
	const stop = (fn) => (e) => {
		e.stopPropagation();
		if (!isPending) fn();
	};
	return (
		<div className="px-2.5 pb-2.5 pt-0">
			{isSafety && (
				<div className="fs-micro font-mono text-warn mb-1.5 flex items-center gap-1">
					<SymI s="⚠" size={11} /> Your call
				</div>
			)}
			<div className="flex items-center gap-1.5">
				<button
					type="button"
					className="i-act-btn i-act-approve"
					onClick={stop(() => onAction("approve", row))}
					disabled={isPending}
					aria-busy={isPending}
					aria-label={`Approve suggestion ${row.id} (apply)`}
				>
					{isPending ? (
						<>
							<SymI s="↻" className="i-act-spin" size={13} /> Approving…
						</>
					) : (
						<>
							<SymI s="✓" size={13} /> Approve
						</>
					)}
				</button>
				<button
					type="button"
					className="i-act-btn i-act-reject"
					onClick={stop(() => onAction("reject", row))}
					disabled={isPending}
					aria-busy={isPending}
					aria-label={`Reject suggestion ${row.id}`}
				>
					{isPending ? (
						<>
							<SymI s="↻" className="i-act-spin" size={13} /> Rejecting…
						</>
					) : (
						<>
							<SymI s="✕" size={13} /> Reject
						</>
					)}
				</button>
			</div>
		</div>
	);
}

// confidence_observed(NN%) 배지 — empirical posterior (0.0-1.0).
// canonical status Badge(.pill)로 렌더 — 밴드 tone 은 선행 Icon(TONE_ICON[tone])이 운반, shell 은 neutral.
// guard 는 confidenceBadgeMetaI 재사용(NULL/NaN → "n/a" 폴백 보존) · label "Confidence " 접두 제거(percent/"n/a" 만).
function ConfidenceBadgeI({ value }) {
	const { Badge } = window.UI;
	const badge = confidenceBadgeMetaI(value);
	const short = badge.label.replace("Confidence ", "");
	return (
		<Badge
			role="status"
			tone={toneKeyI(badge.tone)}
			icon
			className="shrink-0"
			title={`Measured confidence: ${badge.titleHint}`}
		>
			{short}
		</Badge>
	);
}

// confidence_observed → canonical 4-badge dual-encoded mapping.
// NULL/undefined → ℹ "n/a" — 개별 proposal 의 실측 신뢰도 미산정분에 대한 방어 분기
// (daemon 이 대부분 채우지만 산정 전 row 존재 가능). `classes` = pill 배경 (proposal 카드 배지) · `tone` = text class (KPI tile · 표).
function confidenceBadgeMetaI(value) {
	const { TONE_GLYPH, TONE_ICON } = window.UI;
	// tone → symbol/icon 은 registry(TONE_GLYPH/TONE_ICON) 단일 출처 — 로컬 tone/symbol 맵 제거.
	const build = (tone, label, titleHint) => ({
		tone: `text-${tone}`,
		symbol: TONE_GLYPH[tone],
		icon: TONE_ICON[tone],
		label,
		titleHint,
	});
	if (value === null || value === undefined || Number.isNaN(Number(value))) {
		return build("info", "n/a", "Not measured for this suggestion");
	}
	const v = Number(value);
	const pct = `${(v * 100).toFixed(0)}%`;
	if (v >= 0.7) return build("ok", `Confidence ${pct}`, `${v.toFixed(4)} (high)`);
	if (v >= 0.4) return build("warn", `Confidence ${pct}`, `${v.toFixed(4)} (medium)`);
	return build("crit", `Confidence ${pct}`, `${v.toFixed(4)} (low)`);
}

// pre_verify_status → canonical 4-badge dual-encoded mapping.
// Inputs: status (string|null) · passed (boolean|null) — fail-safe to ℹ pending.
// `kind` = 안정 식별자 (로직 분기용 — 표시 문자열 변경이 로직을 깨뜨리지 않도록)
//   · `label` = 사용자 노출 라벨 · `titleHint` = 원본 status (진단값 verbatim).
function preVerifyBadgeI(status, passed) {
	const { TONE_GLYPH, TONE_ICON } = window.UI;
	// tone → symbol/icon 은 registry(TONE_GLYPH/TONE_ICON) 단일 출처 — 로컬 symbol 맵 + 하드코딩 Tailwind fill 제거
	// (confidenceBadgeMetaI/learningStatusBadgeI 형제와 동일 fold). kind/label/titleHint 만 로컬 매핑.
	const build = (kind, tone, label, titleHint) => ({
		kind,
		tone: `text-${tone}`,
		symbol: TONE_GLYPH[tone],
		icon: TONE_ICON[tone],
		label,
		titleHint,
	});
	if (passed === true) {
		return build("passed", "ok", "Pre-check passed", status || "passed");
	}
	if (typeof status === "string" && status.startsWith("error:")) {
		return build("budget-wall", "warn", "Budget hit", status);
	}
	if (passed === false || status === "failed") {
		return build("failed", "crit", "Pre-check failed", status || "failed");
	}
	return build("pending", "info", "Pending", status || "pending");
}

// ----- Bucket row (Read-bridge) — CTM/EPM + outcome_summary + join_meta 시각화. ---

function BucketRowI({ state, buckets }) {
	const { CardHead } = window.UI;
	if (state.status === "error") return null;
	if (state.status === "loading" || !buckets) {
		return (
			<div className="card">
				<CardHead title="Learning memory: wins & mistakes (CTM · EPM)" />
				<div className="grid grid-cols-2 gap-2 p-3">
					{Array.from({ length: 2 }).map((_, i) => (
						<div
							key={i}
							className="i-anim-skel"
							style={{
								height: 68,
								borderRadius: 8,
								background: "rgb(var(--sunken))",
								opacity: 0.7,
							}}
						/>
					))}
				</div>
			</div>
		);
	}

	const { ctm, epm, outcome, joinMeta } = buckets;
	// linked_agent_count = DISTINCT 연결 에이전트 수 (record-level 연결은 FK 부재로 측정 불가).
	const linkedAgents = Number(joinMeta?.linked_agent_count ?? 0);
	// accent (S5) = CTM/EPM 카드만 2px 좌측 보더 (--ok/--warn) — full-fill 금지·--cat-* 금지.
	// 나머지 진단 카드는 accent 없음 (중립 ring 유지 → 학습 메모리 두 카드만 시각 구분).
	const cards = [
		// CTM 실제 유도식 = confidence high + metric_pass + done — 학습 패턴 카드(learning_log)와 산출 기준이 다름.
		[
			"✓",
			"text-ok",
			"Confirmed wins",
			formatIntI(ctm),
			"Confidence high · check passed · done",
			"--ok",
		],
		[
			"⚠",
			"text-warn",
			"Mistake patterns (EPM)",
			formatIntI(epm),
			"Cases that failed or needed repeated rework",
			"--warn",
		],
	];
	return (
		<div className="card">
			<CardHead title="Learning memory: wins & mistakes (CTM · EPM)" />
			<div className="grid grid-cols-2 gap-2 p-3">
				{cards.map(([sym, tone, label, value, hint, accent]) => (
					<div
						key={label}
						className="i-card-shadow bg-elev rounded-md p-2.5 min-w-0"
						style={
							accent
								? { borderLeft: `2px solid rgb(var(${accent}))` }
								: undefined
						}
					>
						<div className="flex items-start gap-1.5 fs-micro font-mono min-h-[2.4em]">
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

// ----- Attribution Pointer card ----
//
// outcomes 화면의 canonical AttributionHealthCard 로 이동하는 순수 포인터 카드.
// healthy_rate / literal_omission_rate / 전체 attribution 분해는 모두 outcomes 화면이 호스팅
// (본 화면은 중복 타일 제거) → 헤더 + 이동 링크만 유지.

function AttributionPointerCardI({ onNav }) {
	const { CardHead, Icon } = window.UI;

	const navLink = (
		<button
			className="btn ghost sm"
			onClick={() => {
				if (typeof onNav === "function") onNav("outcomes");
			}}
			aria-label="Open the reporting-health card on the Task results screen"
		>
			Task results <Icon name="arrow-right" size={14} />
		</button>
	);

	return (
		<div className="card">
			<CardHead
				title="Reporting health (summary)"
				sub="How results were recorded"
				right={navLink}
			/>
		</div>
	);
}

// literal-omission 비율 → dual-encoded 심각도 배지 (낮을수록 좋음).
// null/undefined → ℹ "—" 회색 (denominator 0 — 데이터 부재). 값 존재 시 구간별:
//   < 3%  → ✓ ok (정상)  ·  3-8% → ⚠ warn (주의)  ·  ≥8% → ✕ crit (점검 필요)
// 색상 + 기호 + 텍스트 3중 부호화 (color-blind safety).
// Outcome 화면 attributionOmissionBadgeO 와 동일 밴드.
function attributionOmissionBadgeI(ratio) {
	if (ratio === null || ratio === undefined || Number.isNaN(Number(ratio))) {
		return {
			tone: "text-info",
			symbol: "ℹ",
			hint: "No data (no attributed runs in this period)",
		};
	}
	const pct = Number(ratio) * 100;
	if (pct < 3)
		return {
			tone: "text-ok",
			symbol: "✓",
			hint: `OK · ${pct.toFixed(2)}% (lower is better)`,
		};
	if (pct < 8)
		return {
			tone: "text-warn",
			symbol: "⚠",
			hint: `Watch · ${pct.toFixed(2)}% (check if rising)`,
		};
	return {
		tone: "text-crit",
		symbol: "✕",
		hint: `Investigate · ${pct.toFixed(2)}%`,
	};
}

// 분해는 LoopSuppressionCardI 담당.
//
// 정지(parked) 루프 배너 — repeat-apply cap 은 자가 re-arm 이 없고, learning_log status 를
// 되돌리는 방식으로도 풀리지 않는다(다음 사이클에 재정지 + park 이력 유실). apply evidence 를
// 정리하는 실제 re-arm 이 들어오기 전까지 루프는 멈춘 채로 남는다. K=0 이면 렌더 자체를 하지
// 않는다(운영 상태가 아닐 때 경고를 띄우면 배너가 무시된다). 문구는 payload 의 rearm_hint —
// 복구 안내가 아니라 그 복구가 듣지 않는다는 경고다. 화면 상수로 두면 K=0 에서도 존재하게
// 되므로 payload 에서 받는다.
function ParkedLoopBannerI({ applyCap }) {
	if (!applyCap) return null;
	const capped = Number(applyCap.capped_patterns ?? 0);
	if (capped <= 0) return null;
	const agents = Number(applyCap.capped_agents ?? 0);
	return (
		<div className="card" role="status" data-testid="parked-loop-banner">
			<div className="flex items-start gap-2 p-3">
				<SymI s="⚠" className="text-warn" size={14} />
				<div className="min-w-0">
					<div className="fs-meta font-mono text-warn">
						Repeat-apply cap — {formatIntI(capped)} parked{" "}
						{capped === 1 ? "pattern" : "patterns"} across {formatIntI(agents)}{" "}
						{agents === 1 ? "agent" : "agents"}
					</div>
					{/* is-wrap 필수 — .card-sub 기본값은 nowrap+ellipsis 1줄 클램프다. 이 경고는
					    500자대이고, 잘린 앞부분이 하필 되돌리기를 권하는 문장처럼 읽힌다.
					    title 툴팁만으로는 부족하다: 하지 말라는 경고를 hover 뒤에 둘 수 없다. */}
					<div className="card-sub is-wrap fs-meta mt-1">
						{applyCap.rearm_hint}
					</div>
				</div>
			</div>
		</div>
	);
}

// 루프 억제 분해 카드. 존재 이유는 배너가 답하지 못하는 질문 하나다: "루프의 얼마가, 왜
// 억제되어 있나".
//
// 두 population(parked / per-cycle) 은 분리해 렌더하고 절대 더하지 않는다 — 종결 row 와
// 재발 횟수라 합계는 둘 중 어느 것도 아니다(계약은 ImprovementLoopSuppressionState).
//
// pending split 이 먼저 오는 이유: status_distribution 의 identified 수는 처리 대기 backlog 로
// 읽히는데, 그중 상당수는 intake 에서 매번 버려지는 라벨이라 제안이 나올 수 없다. 억제된
// 패턴이 건강한 pending 처럼 보이는 지점이 정확히 여기다.
//
// K=0(전 항목 0) 이어도 카드는 남는다 — 0 은 "억제가 없다"는 판독이고, 카드 부재는
// "측정하지 않는다"이다(ProseOnlyAddCardI 와 같은 규칙).
function SuppressionBucketRowsI({ buckets, unitLabel }) {
	if (!Array.isArray(buckets) || buckets.length === 0) {
		return (
			<div className="placeholder">No {unitLabel} in this population</div>
		);
	}
	return (
		<table className="w-full fs-meta font-mono">
			<thead>
				<tr className="text-faint uppercase tracking-wider">
					<th className="text-left py-1.5 pl-1.5">Cause</th>
					<th className="text-right py-1.5">{unitLabel}</th>
					<th className="text-right py-1.5 pr-1.5">Agents</th>
				</tr>
			</thead>
			<tbody>
				{buckets.map((b) => (
					<tr key={b.cause} className="border-t border-line/50 align-top">
						<td className="text-left py-1.5 pl-1.5">
							<div className="text-ink">{b.label}</div>
							{/* is-wrap 필수 — .card-sub 는 1줄 클램프다. 원인별 hint 가 잘리면
							    "무엇이 이걸 푸는가"가 사라지고 숫자만 남는다. */}
							<div className="card-sub is-wrap fs-micro mt-0.5">{b.hint}</div>
						</td>
						<td className="text-right py-1.5 text-ink">
							{formatIntI(Number(b.count ?? 0))}
						</td>
						<td className="text-right py-1.5 pr-1.5 text-dim">
							{formatIntI(Number(b.agents ?? 0))}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function LoopSuppressionCardI({ state, suppression }) {
	const { CardHead } = window.UI;
	if (state.status === "error") return null;
	if (state.status === "loading" || !suppression) return null;
	const pendingTotal = Number(suppression.pending_total ?? 0);
	const pendingUnpromptable = Number(suppression.pending_unpromptable ?? 0);
	const windowDays = Number(suppression.per_cycle_window_days ?? 0);
	const offRegistry = Number(suppression.off_registry_parked ?? 0);
	return (
		<div className="card" data-testid="loop-suppression-card">
			<CardHead title="Loop suppression" />
			<div className="px-3 pb-3 space-y-3">
				<div>
					<div className="fs-meta font-mono text-ink">
						Pending patterns that can never propose —{" "}
						<span className={pendingUnpromptable > 0 ? "text-warn" : ""}>
							{formatIntI(pendingUnpromptable)}
						</span>{" "}
						of {formatIntI(pendingTotal)}
					</div>
					<div className="card-sub is-wrap fs-micro mt-1">
						These rows sit at status='identified' and are counted as pending
						backlog, but their label is one the daemon skips at intake every
						cycle, so no proposal can be generated from them. Counted across
						every agent — the intake skip reads the label, not
						agent-registry.json, so unlike the parked buckets below this pair
						is not registry-scoped.
					</div>
				</div>
				<div>
					<div className="fs-meta font-mono text-dim mb-1">
						Parked patterns (terminal rows)
					</div>
					<SuppressionBucketRowsI
						buckets={suppression.parked}
						unitLabel="Patterns"
					/>
				</div>
				<div>
					<div className="fs-meta font-mono text-dim mb-1">
						Per-cycle suppressions (last {formatIntI(windowDays)} days)
					</div>
					<SuppressionBucketRowsI
						buckets={suppression.per_cycle}
						unitLabel="Events"
					/>
					<div className="card-sub is-wrap fs-micro mt-1">
						Recurrences, not distinct patterns — these mechanisms write no
						lifecycle transition, so the same row is re-suppressed on every
						cycle.
					</div>
				</div>
				{offRegistry > 0 ? (
					<div className="card-sub is-wrap fs-micro text-warn">
						{formatIntI(offRegistry)} parked{" "}
						{offRegistry === 1 ? "pattern is" : "patterns are"} excluded from
						every count on this card: the agent is not in agent-registry.json.
						Still parked, still not proposing.
					</div>
				) : null}
			</div>
		</div>
	);
}

// ----- LearningLog card (P2-B · learning-aggregator 원천) -------------------
//
// 화면이 proposals 에서 CTM/EPM 을 재유도하던 것의 실제 source — learning-aggregator
// 패턴 테이블 직접 노출. status_distribution 요약 KPI 3-tile + 패턴 표(행=패턴 / 열=5).
// status → dual-encoded 배지 (identified ℹ · proposed ⚠ · applied ✓ · rejected ✕).
//
// 데이터 부재 분기:
//   - total_patterns === 0 → "데이터 부재" 회색 indicator
//   - error 상태 → ErrorBanner (재시도 가능)

function LearningLogCardI({ state, onRetry }) {
	const { CardHead } = window.UI;
	if (state.status === "error") {
		return (
			<div className="card">
				<CardHead title="Learned patterns" />
				<div className="p-4">
					<ErrorBannerI
						title="Couldn't load learned patterns"
						detail={state.error}
						onRetry={onRetry}
					/>
				</div>
			</div>
		);
	}
	if (state.status === "loading" || !state.data) {
		return (
			<div className="card">
				<CardHead title="Learned patterns" />
				<div className="grid grid-cols-3 gap-2 p-3">
					{Array.from({ length: 3 }).map((_, i) => (
						<div
							key={i}
							className="i-anim-skel"
							style={{
								height: 68,
								borderRadius: 8,
								background: "rgb(var(--sunken))",
								opacity: 0.7,
							}}
						/>
					))}
				</div>
			</div>
		);
	}

	const total = Number(state.data.total_patterns ?? 0);
	const patterns = Array.isArray(state.data.patterns)
		? state.data.patterns
		: [];
	const dist = Array.isArray(state.data.status_distribution)
		? state.data.status_distribution
		: [];

	if (total === 0) {
		return (
			<div className="card">
				<CardHead title="Learned patterns" />
				<div className="px-3 pb-3">
					<div
						className="placeholder"
					>
						No learned patterns yet
					</div>
				</div>
			</div>
		);
	}

	// status 별 합산 (approval_tier 분해는 묶어서 status 단위 KPI 로 — skim 우선).
	const statusSum = {};
	for (const d of dist) {
		const k = d.status || "unknown";
		statusSum[k] = (statusSum[k] || 0) + Number(d.count ?? 0);
	}
	const identifiedCnt = statusSum.identified || 0;
	const proposedCnt = statusSum.proposed || 0;
	const rejectedCnt = statusSum.rejected || 0;

	const cards = [
		["ℹ", "text-info", "Spotted patterns", formatIntI(identifiedCnt), ""],
		["⚠", "text-warn", "Proposed patterns", formatIntI(proposedCnt), ""],
		[
			"ℹ",
			"text-info",
			"All patterns",
			formatIntI(total),
			`${formatIntI(rejectedCnt)} declined`,
		],
	];

	return (
		<div className="card">
			<CardHead title="Learned patterns" />
			<div className="grid grid-cols-3 gap-2 p-3">
				{cards.map(([sym, tone, label, value, hint]) => (
					<div
						key={label}
						className="i-card-shadow bg-elev rounded-md p-2.5 min-w-0"
					>
						<div className="flex items-start gap-1.5 fs-micro font-mono min-h-[2.4em]">
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

// 패턴 표 — 행=패턴 (가변) / 열=5 (패턴 · 에이전트 · 빈도 · 상태 · 발견일).
// D8 P2 ≤5-col 정합. status → dual-encoded 배지 (색 + 기호 + 텍스트).
// 리스트는 최근 7일 윈도우 → 빈 경우 KPI 카드는 유지한 채 표 영역만 안내.
function LearningLogTableI({ patterns }) {
	if (patterns.length === 0) {
		return (
			<div className="px-3 pb-3">
				<div
					className="placeholder"
				>
					No new patterns in the last 7 days
				</div>
			</div>
		);
	}
	return (
		<div className="px-3 pb-3">
			<table className="w-full fs-meta font-mono">
				<thead>
					<tr className="text-faint uppercase tracking-wider">
						<th className="text-left py-1.5 pl-1.5">Pattern</th>
						<th className="text-left py-1.5">Agent</th>
						<th className="text-right py-1.5">Seen</th>
						<th className="text-left py-1.5 pl-3">Status</th>
						<th className="text-right py-1.5 pr-1.5">First seen</th>
					</tr>
				</thead>
				<tbody>
					{patterns.map((p) => {
						const badge = learningStatusBadgeI(p.status);
						return (
							<tr key={p.id} className="border-t border-line/50">
								<td
									className="text-left py-1.5 pl-1.5 text-ink i-sig-cell"
									title={String(p.pattern_signature || "")}
								>
									<div className="i-sig-clamp">
										{truncateI(p.pattern_signature, 120)}
									</div>
								</td>
								<td className="text-left py-1.5 text-dim">{p.agent || "—"}</td>
								<td className="text-right py-1.5 text-dim">
									{formatIntI(Number(p.frequency ?? 0))}
								</td>
								<td className={`text-left py-1.5 pl-3 ${badge.tone}`}>
									<SymI s={badge.symbol} size={11} /> {badge.label}
								</td>
								<td className="text-right py-1.5 pr-1.5 text-faint">
									{formatDateFullI(p.discovered_date)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

// learning-aggregator status → dual-encoded 배지 (canonical 4-badge palette).
//   applied/proposed=진행 · identified=초기 · rejected=반려 · 그 외 fallback ℹ.
function learningStatusBadgeI(status) {
	const { TONE_GLYPH } = window.UI;
	// symbol 은 registry(TONE_GLYPH) 단일 출처 — 로컬 tone→symbol 맵 제거. status → tone/label 만 로컬 매핑.
	const map = {
		applied: { tone: "ok", label: "Applied" },
		proposed: { tone: "warn", label: "Proposed" },
		rejected: { tone: "crit", label: "Declined" },
		identified: { tone: "info", label: "Spotted" },
	};
	const meta = map[status] || { tone: "info", label: status || "—" };
	return { tone: `text-${meta.tone}`, symbol: TONE_GLYPH[meta.tone], label: meta.label };
}

// ----- Detail drawer (Read) — 공용 DetailSurface(variant=drawer) 위임. -------
// presentation-only 인 shared surface 에 open/onClose/children 만 넘김 — 선택
// 상태(row)·내용(DetailBodyI)은 본 화면 소유. 공용 위임으로 focus-trap +
// scroll-lock 오버레이 계약을 단일 SoT 에서 상속 (화면별 재구현 금지).
function DetailDrawerI({ row, onClose }) {
	const { DetailSurface } = window.UI;

	// defensive guard — sister 모달 (architecture/outcomes DetailModal) 정합.
	if (!row) return null;

	const isPattern = row?.kind === "pattern";
	const title = isPattern ? "Pattern details" : `Suggestion #${row?.id ?? "?"}`;

	return (
		<DetailSurface open={true} onClose={onClose} variant="drawer" title={title}>
			<DetailBodyI {...buildDetailPropsI(row)} />
		</DetailSurface>
	);
}

// Detail body — fields grid + 0..N text sections + pre-verify keyed block (pattern / proposal 공용).
function DetailBodyI({ fields, sections, footnote, preVerify }) {
	const labelCls = "fs-micro font-mono text-faint uppercase tracking-wider";
	return (
		<div className="flex flex-col gap-3">
			<dl className="grid gap-1.5" style={{ gridTemplateColumns: "120px 1fr" }}>
				{fields.map(([k, v]) => (
					<React.Fragment key={k}>
						<dt className={labelCls}>{k}</dt>
						<dd className="fs-body text-ink font-mono break-words">
							{String(v)}
						</dd>
					</React.Fragment>
				))}
			</dl>
			{sections
				.filter(([, v]) => v)
				.map(([label, value, mono]) => (
					<div key={label}>
						<div className={`${labelCls} mb-1`}>{label}</div>
						{mono ? (
							<pre className="fs-meta font-mono text-dim bg-sunken p-2.5 rounded-md whitespace-pre-wrap break-words">
								{value}
							</pre>
						) : (
							<div className="fs-body text-ink whitespace-pre-wrap break-words">
								{value}
							</div>
						)}
					</div>
				))}
			{preVerify && <PreVerifyDetailI {...preVerify} labelCls={labelCls} />}
			{footnote && (
				<div className="fs-meta font-mono text-faint mt-2">{footnote}</div>
			)}
		</div>
	);
}

// PRE-VERIFY drawer 블록 — badge 헤더 + rationale + keyed axis 행 (P10 · 원시 JSON 대체).
// axis value boolean → PASS/FAIL 배지 · 그 외 → 문자열.
function PreVerifyDetailI({ badge, rationale, axes, labelCls }) {
	const { Badge } = window.UI;
	return (
		<div>
			<div className={`${labelCls} mb-1`}>PRE-VERIFY</div>
			<div className="bg-sunken p-2.5 rounded-md flex flex-col gap-2">
				<div className="flex items-center gap-1.5 fs-meta font-mono">
					<SymI s={badge.symbol} className={badge.tone} size={13} />
					<span className={badge.tone}>{badge.label}</span>
					{badge.titleHint && badge.titleHint !== badge.label && (
						<span className="text-faint">· {badge.titleHint}</span>
					)}
				</div>
				{rationale && (
					<div className="fs-body text-dim whitespace-pre-wrap break-words">
						{rationale}
					</div>
				)}
				{axes.length > 0 && (
					<dl
						className="grid gap-1 items-center"
						style={{ gridTemplateColumns: "1fr auto" }}>
						{axes.map(({ key, label, value }) => (
							<React.Fragment key={key}>
								<dt className="fs-meta font-mono text-dim">{label}</dt>
								<dd className="justify-self-end">
									{typeof value === "boolean" ? (
										<Badge
											role="status"
											tone={value ? "ok" : "crit"}
											icon
											title={`${label}: ${value ? "PASS" : "FAIL"}`}>
											{value ? "PASS" : "FAIL"}
										</Badge>
									) : (
										<span className="fs-meta font-mono text-ink">
											{String(value)}
										</span>
									)}
								</dd>
							</React.Fragment>
						))}
					</dl>
				)}
			</div>
		</div>
	);
}

function buildDetailPropsI(row) {
	// defensive guard — sister 모달 (architecture/outcomes DetailModal) 정합.
	if (row?.kind === "pattern") {
		// learning-log 패턴 (RankedCandidate) — pattern_signature/agent/status/discovered_date 노출.
		// 일부 필드(bucket/score/summary/example)는 learning-log 스키마에 없으므로 || '—' 폴백.
		const statusBadge = learningStatusBadgeI(row?.status);
		return {
			fields: [
				["ID", row?.id ?? row?.pattern_id ?? "—"],
				["Agent", row?.agent || "—"],
				[
					"Status",
					row?.status ? `${statusBadge.symbol} ${statusBadge.label}` : "—",
				],
				["Approval tier", row?.approval_tier || row?.bucket || "—"],
				["Frequency", row?.frequency ?? "—"],
				["First seen", row?.discovered_date || "—"],
				// last_updated = real-UTC ISO instant → formatKstFull (KST 상세 표기). last_seen fallback 동일.
				[
					"Last updated",
					row?.last_updated
						? window.UI.formatKstFull(row.last_updated)
						: row?.last_seen
							? window.UI.formatKstFull(row.last_seen)
							: "—",
				],
			],
			sections: [
				["PATTERN", row?.pattern_signature || row?.summary, false],
				["LAST TRANSITION", row?.last_transition_reason, false],
				["EXAMPLE", row?.example, true],
			],
		};
	}
	// Proposal schema — server emits 16 fields (routes/improvement.ts rowToProposalSummary).
	// provenance 5 cols (rationale + pre_verify_*) 포함.
	const tier = row?.approval_tier || "auto";
	const isSafety = tier !== "auto";
	const preVerify = preVerifyBadgeI(
		row?.pre_verify_status,
		row?.pre_verify_passed,
	);
	// pre-verify block: status badge + rationale + keyed axis 행 (원시 JSON 제거 · P10).
	const preVerifyDetail = composePreVerifyI(
		preVerify,
		row?.pre_verify_rationale,
		row?.pre_verify_axes,
	);

	return {
		fields: [
			["ID", row?.id ?? "—"],
			["Status", row?.status || "—"],
			["Approval tier", `${isSafety ? "⚠ safety" : "✓ auto"} (${tier})`],
			["Classification", row?.classification || "—"],
			["Target agent", row?.target_agent || "—"],
			["Target file", row?.target_file || "—"],
			["Cycle date", row?.cycle_date || "—"],
			["Haiku status", row?.haiku_status || "—"],
			["Cost guard", row?.cost_guard_state || "—"],
			// reviewed_at = real-UTC ISO instant → formatKstFull. cycle_date 는 date-only 문자열 → raw 유지(위).
			[
				"Reviewed at",
				row?.reviewed_at ? window.UI.formatKstFull(row.reviewed_at) : "—",
			],
		],
		sections: [
			["PATTERN LABEL", row?.pattern_label, false],
			["RATIONALE", row?.rationale, false],
		],
		preVerify: preVerifyDetail,
	};
}

// pre_verify_axes 4-axis compliance dict {C1..C4} → 사람이 읽는 라벨 (daemon_cycle 4-axis 게이트 원천).
const PRE_VERIFY_AXIS_LABELS = {
	C1: "Rule-loading policy",
	C2: "Global absolute rules",
	C3: "Scope absolute rules",
	C4: "Agent's own rules",
};

// snake/kebab key → Title Case 폴백 (미지의 axis 키 대비).
function humanizeAxisKeyI(key) {
	return String(key)
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

// axes JSON → [{key,label,value}] 행 배열. 객체 아님 → [] (원시 JSON 텍스트 렌더 차단).
function toAxisEntriesI(axes) {
	if (!axes || typeof axes !== "object" || Array.isArray(axes)) return [];
	return Object.keys(axes).map((k) => ({
		key: k,
		label: PRE_VERIFY_AXIS_LABELS[k] || humanizeAxisKeyI(k),
		value: axes[k],
	}));
}

// pre-verify drawer block 구조화 — badge + rationale + keyed axis 행 (원시 JSON blob 제거).
// 빈 status + 빈 rationale + 빈 axes → null (미렌더).
function composePreVerifyI(badge, rationale, axes) {
	const entries = toAxisEntriesI(axes);
	const hasContent =
		(badge && badge.kind !== "pending") || rationale || entries.length > 0;
	if (!hasContent) return null;
	return {
		badge,
		rationale: rationale ? String(rationale) : null,
		axes: entries,
	};
}

// ----- Change summary card (T-IMP-1 · T-IMP-6) -------------------------------
//
// Path A frontend-only summary — proposal 행에는 before/after 명령문도 라인-diff 본문도
// 없으므로(server/types ImprovementProposalRow), 적용 효과는 loop-events AGGREGATE 의
// 사이클 변경량 합계로만 정직하게 표현한다. .diff-line glyph+색 어휘를 add/remove COUNT
// 배지에만 재사용 (두-컬럼 라인-diff 아님). before/after fail_rate(T-IMP-6)는 윈도우
// 전/후반 reject 비율을 formatPctWithDenominator 로 — 분모 0 → '—' (가짜 0% 차단).

function ChangeSummaryCardI({ state, aggregate, onRetry }) {
	const { CardHead } = window.UI;
	if (state.status === "error") {
		return (
			<div className="card">
				<CardHead title="Self-improvement changes (applied)" />
				<div className="p-4">
					<ErrorBannerI
						title="Couldn't load change summary"
						detail={state.error}
						onRetry={onRetry}
					/>
				</div>
			</div>
		);
	}
	if (state.status === "loading" || !aggregate) {
		return (
			<div className="card">
				<CardHead title="Self-improvement changes (applied)" />
				<div className="grid grid-cols-3 gap-2 p-3">
					{Array.from({ length: 3 }).map((_, i) => (
						<div
							key={i}
							className="i-anim-skel"
							style={{
								height: 68,
								borderRadius: 8,
								background: "rgb(var(--sunken))",
								opacity: 0.7,
							}}
						/>
					))}
				</div>
			</div>
		);
	}

	const { added, removed, eventCount, failBefore, failAfter } = aggregate;

	// 데이터 부재 — 윈도우 내 사이클 이벤트 0건 → 안내 indicator (가짜 0 채움 금지).
	if (eventCount === 0) {
		return (
			<div className="card">
				<CardHead title="Self-improvement changes (applied)" />
				<div className="px-3 pb-3">
					<div
						className="placeholder"
					>
						No improvement cycles recorded yet
					</div>
				</div>
			</div>
		);
	}

	// T-IMP-6 — before/after fail_rate text (denominator 표기 · 분모 0 → '—').
	const failBeforeText = window.UI.formatPctWithDenominator(
		failBefore.count,
		failBefore.total,
	);
	const failAfterText = window.UI.formatPctWithDenominator(
		failAfter.count,
		failAfter.total,
	);
	const failTrend = failTrendMetaI(failBefore, failAfter);

	return (
		<div className="card">
			<CardHead title="Self-improvement changes (applied)" />
			<div className="px-3 pt-3 flex items-center gap-2 flex-wrap">
				<span className="fs-micro font-mono text-faint uppercase tracking-wider">
					Lines changed
				</span>
				{/* .diff-line glyph+색 어휘를 COUNT 배지에 재사용 (라인-diff 본문 없음 — Path A). */}
				<span
					className="diff-line diff-line--add rounded"
					style={{ display: "inline-flex" }}
					title={`${formatIntI(added)} rule/instruction lines added across ${formatIntI(eventCount)} cycles`}
				>
					<span className="diff-line__glyph" aria-hidden="true">
						+
					</span>
					<span>{formatIntI(added)} added</span>
				</span>
				<span
					className="diff-line diff-line--del rounded"
					style={{ display: "inline-flex" }}
					title={`${formatIntI(removed)} rule/instruction lines removed across ${formatIntI(eventCount)} cycles`}
				>
					<span className="diff-line__glyph" aria-hidden="true">
						−
					</span>
					<span>{formatIntI(removed)} removed</span>
				</span>
				<span className="fs-micro font-mono text-faint ml-auto">
					{formatIntI(eventCount)} cycles
				</span>
			</div>
			<div className="grid grid-cols-2 gap-2 p-3">
				<div className="i-card-shadow bg-elev rounded-md p-2.5 min-w-0">
					<div className="flex items-start gap-1.5 fs-micro font-mono min-h-[2.4em]">
						<SymI s="ℹ" className="text-info" size={12} />
						<span className="text-info">Reject rate — earlier half</span>
					</div>
					<div className="fs-stat font-semibold text-ink mt-1 font-mono">
						{failBeforeText}
					</div>
				</div>
				<div className="i-card-shadow bg-elev rounded-md p-2.5 min-w-0">
					<div className="flex items-start gap-1.5 fs-micro font-mono min-h-[2.4em]">
						<SymI s={failTrend.symbol} className={failTrend.tone} size={12} />
						<span className={failTrend.tone}>Reject rate — recent half</span>
					</div>
					<div className="fs-stat font-semibold text-ink mt-1 font-mono">
						{failAfterText}
					</div>
					<div
						className="card-sub fs-meta mt-1"
						title={window.UI.titleOf(failTrend.hint)}
					>
						{failTrend.hint}
					</div>
				</div>
			</div>
		</div>
	);
}

// before→after reject 비율 추이 → dual-encoded 배지 (낮을수록 좋음 = inverse).
// 분모 부족(둘 중 하나라도 0) → ℹ 중립 ('—' 비교 불가). 하락=✓ ok · 상승=⚠ warn · 동률=ℹ.
function failTrendMetaI(before, after) {
	if (!before.total || !after.total) {
		return {
			tone: "text-info",
			symbol: "ℹ",
			hint: "Rejected ÷ scored cycles (newer half) — not enough to compare",
		};
	}
	const bRate = before.count / before.total;
	const aRate = after.count / after.total;
	if (aRate < bRate)
		return {
			tone: "text-ok",
			symbol: "✓",
			hint: "Rejected ÷ scored cycles (newer half) — reject rate fell",
		};
	if (aRate > bRate)
		return {
			tone: "text-warn",
			symbol: "⚠",
			hint: "Rejected ÷ scored cycles (newer half) — reject rate rose",
		};
	return {
		tone: "text-info",
		symbol: "ℹ",
		hint: "Rejected ÷ scored cycles (newer half) — unchanged",
	};
}

// ----- Ranked candidate list (T-IMP-3 · T-IMP-5) -----------------------------
//
// learning-aggregator 패턴을 frequency 내림차순 ranked 후보 리스트로. StatusDot
// severity(빈도 밴드) + 클릭 → DetailSurface drawer (DetailDrawerI 의 pattern kind 재사용).
// rejected 후보(반려 백로그)는 T-IMP-5 의 collapsible <details> 로 기본 접힘 분리.

function RankedCandidateCardI({ state, onRowClick, onRetry }) {
	const { CardHead } = window.UI;
	if (state.status === "error") {
		return (
			<div className="card">
				<CardHead title="Top candidate patterns (ranked)" />
				<div className="p-4">
					<ErrorBannerI
						title="Couldn't load candidate patterns"
						detail={state.error}
						onRetry={onRetry}
					/>
				</div>
			</div>
		);
	}
	if (state.status === "loading" || !state.data) {
		return (
			<div className="card">
				<CardHead title="Top candidate patterns (ranked)" />
				<div className="p-3 flex flex-col gap-2">
					{Array.from({ length: 4 }).map((_, i) => (
						<div
							key={i}
							className="i-anim-skel"
							style={{
								height: 44,
								borderRadius: 8,
								background: "rgb(var(--sunken))",
								opacity: 0.7,
							}}
						/>
					))}
				</div>
			</div>
		);
	}

	const patterns = Array.isArray(state.data.patterns)
		? state.data.patterns
		: [];
	if (patterns.length === 0) {
		return (
			<div className="card">
				<CardHead title="Top candidate patterns (ranked)" />
				<div className="px-3 pb-3">
					<div
						className="placeholder"
					>
						No candidate patterns in the last 7 days
					</div>
				</div>
			</div>
		);
	}

	// frequency 내림차순 정렬 (동률 → discovered_date 최신 우선) — 상위 N 활성, rejected 는 백로그.
	const sorted = [...patterns].sort(
		(a, b) =>
			Number(b.frequency ?? 0) - Number(a.frequency ?? 0) ||
			String(b.discovered_date || "").localeCompare(
				String(a.discovered_date || ""),
			),
	);
	const active = sorted.filter((p) => p.status !== "rejected");
	const rejected = sorted.filter((p) => p.status === "rejected");
	// severity 밴드 = 최대 빈도 대비 — StatusDot 색 + 텍스트 빈도 동반 (dual-encode).
	const maxFreq = Math.max(1, ...sorted.map((p) => Number(p.frequency ?? 0)));

	return (
		<div className="card">
			<CardHead title="Top candidate patterns (ranked)" />
			<div className="px-3 pb-3 flex flex-col gap-1.5">
				{active.length === 0 ? (
					<div
						className="placeholder"
					>
						No active candidates — all declined (see
						backlog)
					</div>
				) : (
					active.map((p, i) => (
						<CandidateRowI
							key={p.id}
							rank={i + 1}
							pattern={p}
							maxFreq={maxFreq}
							onClick={() => onRowClick({ ...p, kind: "pattern" })}
						/>
					))
				)}
			</div>
			{/* T-IMP-5 — 반려 백로그 (long-term accumulation) collapsible, 기본 접힘. */}
			{rejected.length > 0 && (
				<details className="px-3 pb-3">
					<summary className="fs-meta font-mono text-dim cursor-pointer select-none">
						<SymI s="✕" size={11} /> Declined backlog (
						{formatIntI(rejected.length)})
					</summary>
					<div className="flex flex-col gap-1.5 mt-2">
						{rejected.map((p, i) => (
							<CandidateRowI
								key={p.id}
								rank={i + 1}
								pattern={p}
								maxFreq={maxFreq}
								onClick={() => onRowClick({ ...p, kind: "pattern" })}
							/>
						))}
					</div>
				</details>
			)}
		</div>
	);
}

function CandidateRowI({ rank, pattern, maxFreq, onClick }) {
	const { StatusDot } = window.UI;
	const freq = Number(pattern.frequency ?? 0);
	const status = candidateSeverityI(freq, maxFreq);
	const badge = learningStatusBadgeI(pattern.status);
	return (
		<button
			type="button"
			onClick={onClick}
			className="i-card-shadow i-row-card bg-elev rounded-md text-left p-2.5 w-full flex items-center gap-2"
			aria-label={`Candidate ${rank}: ${String(pattern.pattern_signature || "")} — seen ${freq} times`}
		>
			<span
				className="fs-micro font-mono text-faint"
				style={{ width: "2ch", textAlign: "right" }}
			>
				{rank}
			</span>
			<StatusDot status={status} />
			<span
				className="fs-body text-ink truncate flex-1 min-w-0"
				title={String(pattern.pattern_signature || "")}
			>
				{truncateI(pattern.pattern_signature, 120)}
			</span>
			{pattern.agent && (
				<span className="fs-micro font-mono text-dim shrink-0">
					{pattern.agent}
				</span>
			)}
			<span
				className={`fs-micro font-mono shrink-0 ${badge.tone}`}
				title={`Status: ${badge.label}`}
			>
				<SymI s={badge.symbol} size={11} />
			</span>
			<span
				className="fs-meta font-mono text-dim tnum shrink-0"
				title="Times this pattern was seen"
			>
				×{formatIntI(freq)}
			</span>
		</button>
	);
}

// 빈도 → severity 밴드 (StatusDot). 최대 대비 비율 — ≥66% crit · ≥33% warn · 그 외 info.
// 색 단독 아님 — 행에 ×빈도 텍스트 동반 (dual-encode).
function candidateSeverityI(freq, maxFreq) {
	const ratio = freq / Math.max(1, maxFreq);
	if (ratio >= 0.66) return "crit";
	if (ratio >= 0.33) return "warn";
	return "info";
}

// ----- Shared chrome --------------------------------------------------------

function ToastI({ tone, message }) {
	// tone 색상은 기호(✓/⚠/✕/ℹ)로 dual-encode — 왼쪽 보더 강조 효과 제거 (사용자 directive).
	const symbol = TONE_SYMBOL[tone] || TONE_SYMBOL.info;
	return (
		<div
			role="status"
			aria-live="polite"
			className="i-anim-toast"
			style={{
				position: "fixed",
				bottom: 24,
				right: 24,
				zIndex: 200,
				background: "rgb(var(--elev))",
				border: "1px solid rgb(var(--line))",
				borderRadius: 8,
				padding: "10px 16px",
				fontSize: "var(--fs-body)",
				fontFamily: "JetBrains Mono, monospace",
				color: "rgb(var(--ink))",
				boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
				maxWidth: 360,
			}}
		>
			<span style={{ marginRight: 8 }}>
				<SymI s={symbol} />
			</span>
			{message}
		</div>
	);
}

function ErrorBannerI({ title, detail, onRetry }) {
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
				<div className="fs-body font-medium text-ink">{title}</div>
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

// ----- Pure helpers ---------------------------------------------------------

// loop-events 응답 → 집계 유도 (T-IMP-1/4/6). raw event 행은 버림 (집계만).
//   added/removed  = 윈도우 내 changes_added/removed 합계 (적용 효과).
//   verifiedTotal/rejectTotal = eval_result 분류 합.
//   trend          = 날짜 오름차순 [{ date, verified, reject }] 2-시리즈.
//   failBefore/After = 날짜순 전/후반 split 의 reject ÷ (verified+reject) 분자/분모.
function deriveLoopAggregateI(data) {
	const events = Array.isArray(data.events) ? data.events : [];
	let added = 0,
		removed = 0;
	// 날짜별 verified/reject 버킷.
	const byDate = new Map();
	for (const e of events) {
		added += Number(e.changes_added ?? 0);
		removed += Number(e.changes_removed ?? 0);
		const day = String(e.event_ts ?? "").slice(0, 10);
		if (!day) continue;
		const bucket = byDate.get(day) || { date: day, verified: 0, reject: 0 };
		if (e.eval_result === "verified") bucket.verified += 1;
		else if (TREND_REJECT_RESULTS.has(e.eval_result)) bucket.reject += 1;
		byDate.set(day, bucket);
	}
	const trend = Array.from(byDate.values()).sort((a, b) =>
		a.date.localeCompare(b.date),
	);
	const verifiedTotal = trend.reduce((s, d) => s + d.verified, 0);
	const rejectTotal = trend.reduce((s, d) => s + d.reject, 0);

	// 전/후반 split — 날짜 시리즈 중앙 기준 (홀수 → 후반에 중앙 포함). scored = verified+reject.
	const mid = Math.floor(trend.length / 2);
	const sum = (slice) =>
		slice.reduce(
			(acc, d) => {
				acc.reject += d.reject;
				acc.total += d.verified + d.reject;
				return acc;
			},
			{ reject: 0, total: 0 },
		);
	const before = sum(trend.slice(0, mid));
	const after = sum(trend.slice(mid));

	return {
		added,
		removed,
		eventCount: events.length,
		verifiedTotal,
		rejectTotal,
		trend,
		failBefore: { count: before.reject, total: before.total },
		failAfter: { count: after.reject, total: after.total },
	};
}

// `/api/improvement` + `/stats` 동시 fetch · 5xx → 명시적 throw (silent fallback 금지).
async function fetchUnifiedI(signal) {
	const [listRes, statsRes] = await Promise.all([
		fetch(IMPROVEMENT_LIST_URL, {
			signal,
			headers: { Accept: "application/json" },
		}),
		fetch(IMPROVEMENT_STATS_URL, {
			signal,
			headers: { Accept: "application/json" },
		}),
	]);
	if (!listRes.ok) throw new Error(`improvement list HTTP ${listRes.status}`);
	if (!statsRes.ok)
		throw new Error(`improvement stats HTTP ${statsRes.status}`);
	const list = await listRes.json();
	const stats = await statsRes.json();
	return { list, stats, source: "unified" };
}

// P2-B orphan endpoint 단건 fetch — 5xx → 명시적 error state (silent fallback 금지).
// abort 는 조용히 무시 (refreshTick 재발화 OR unmount 시 정상 경로). 결과는 setter 위임
// → 각 카드 state 독립 (부분 실패 격리 — 한 endpoint 실패가 나머지 카드 미차단).
function fetchOrphanI(url, signal, setState) {
	fetch(url, { signal, headers: { Accept: "application/json" } })
		.then((res) => {
			if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
			return res.json();
		})
		.then((data) => {
			if (signal.aborted) return;
			setState({ status: "ready", data, error: null });
		})
		.catch((err) => {
			if (signal.aborted || err?.name === "AbortError") return;
			setState({
				status: "error",
				data: null,
				error: err?.message || String(err),
			});
		});
}

// APPLIED / REJECTED 분리 + snoozed 명시 라우팅.
//   applied / rejected → terminal 전용 컬럼 (혼합 폐지).
//   non-terminal (pending / snoozed / approved) → safety actionable 컬럼.
//     actionable feed 는 safety-tier only (auto 는 생성 시점 종결) → tier 분기 불필요.
//     snoozed 는 terminal 컬럼 오염 방지차 actionable 컬럼 유지 · 카드 버튼으로 종결 가능.
function groupByColumnI(proposals) {
	const out = { safety: [], applied: [], rejected: [] };
	for (const p of proposals) {
		const status = p.status || "pending";
		if (status === "applied") {
			out.applied.push(p);
			continue;
		}
		if (status === "rejected") {
			out.rejected.push(p);
			continue;
		}
		// pending / snoozed / approved (non-terminal) → safety actionable 컬럼.
		out.safety.push(p);
	}
	return out;
}

// 공용 formatInt 위임 (ui.jsx SoT) — 로컬 재구현 폐기. 음수/NaN → '—' 가드 승격 상속.
const formatIntI = window.UI.formatInt;
// date-only "YYYY-MM-DD" 문자열 전용 (cycle_date · discovered_date · window_start/end ·
// latest_window_end — 서버 formatDateOnly 직렬화). new Date 파싱 회피 → tz 일자 shift 차단
// (UTC 자정 문자열을 브라우저 로컬로 해석하면 음수 오프셋에서 전날로 밀림). 문자열에서 MM/DD 만 추출.
function formatDateI(iso) {
	const s = String(iso ?? "");
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	return m ? `${m[2]}/${m[3]}` : s;
}
// formatDateI 와 동일한 tz-safe 문자열 추출 — 연도까지 포함 (YYYY/MM/DD).
// discovered_date 표시 전용 (First seen 컬럼) → 연도 식별 필요.
function formatDateFullI(iso) {
	const s = String(iso ?? "");
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	return m ? `${m[1]}/${m[2]}/${m[3]}` : s;
}
function truncateI(s, n) {
	const str = String(s || "");
	return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// 계기판 뷰 브리지 — 뷰는 별도 번들(improvement-instrumentation.js)에 있고 window 로 만난다.
// 번들이 없으면 화면 전체가 죽는 대신 이 묶음만 빠진다(운영 표면은 이 파일이 전부 소유).
function InstrumentationViewI(props) {
	const View = window.ImprovementInstrumentationView;
	if (!View) return null;
	return <View {...props} />;
}

// 계기판 뷰가 소비하는 화면 공용 원자 — 두 번들이 한 화면을 이루므로 기호/배지 판정은 여기 하나뿐.
window.ImprovementShared = { SymI, confidenceBadgeMetaI };

window.ScreenImprovement = ScreenImprovement;
