// Architecture 설계도 화면 (Mermaid native rendering) — window.ScreenArchitecture 등록.
// Data: /api/architecture/diagrams · Live: /api/architecture/live (마운트/Refresh 시 1회 fetch) · diagram-dominant 단일 컬럼 레이아웃.

const {
	useState: useStateAR,
	useEffect: useEffectAR,
	useRef: useRefAR,
	useCallback: useCallbackAR,
	useMemo: useMemoAR,
} = React;

// Constants

// 가독 하한 — 그래프 크기와 무관한 고정 상수. 폭-fit 이 더 작아도 이 아래로 내려가지 않음.
const LEGIBLE_FIT_FLOOR = 0.6;

// svg-pan-zoom 라이브러리 minZoom — LEGIBLE_FIT_FLOOR 보다 낮아야 zoom() 이 minZoom 으로 되끌어올려지지 않음.
const PAN_ZOOM_MIN = 0.2;

// 존 제목 띠 높이(SVG 사용자 단위) — 렌더 후 조정이라 지시자의 diagramPadding 여유 안이어야 viewBox 를 넘지 않음.
const ZONE_TITLE_BAND = 8;

const NODE_TYPE_LABEL = {
	agent: "Agent",
	hook: "Hook",
	script: "Script",
	daemon: "Background job",
	store: "Storage",
	external: "External",
	gateway: "Gateway",
};

const EDGE_COLORS = {
	control_flow: "#94a3b8",
	data_flow: "#38bdf8",
	fires_event: "#a78bfa",
	writes_to: "#fbbf24",
	reads_from: "#facc15",
	monitors: "#f87171",
	escalates_to: "#f472b6",
	triggers: "#4ade80",
};

// 화면이 선호하는 canonical 맵 id — 서버 CANONICAL_MAP.slug 와 같은 값이지만, 불일치는 payload 로 흡수함.
const CANONICAL_DIAGRAM_ID = "v2-overview-entry";

// 캔버스·탭 컨트롤 셀렉터 SoT — 구조 하네스가 window.ARCH_SELECTORS 로 같은 문자열을 읽음.
const ARCH_DESC_ID = "arch-svg-desc";
const ARCH_SELECTORS = {
	canvas: ".arch-mermaid-canvas",
	tabControl: '[role="tab"], .arch-tab-btn',
	desc: `#${ARCH_DESC_ID}`,
};

// 결함 tone → 캔버스 노드 링 클래스. ok 와 info(no data)는 항목이 없음 — 결함만 짚는 노출이고,
// 정상 전역 점등은 되돌림 폭이 과함(계획 Non-Goal). 정상 명부는 라이브 상태 표가 냄.
const FAULT_RING_CLASS = {
	warn: "arch-node-live-warn",
	crit: "arch-node-live-crit",
};
const FAULT_RING_CLASSES = Object.values(FAULT_RING_CLASS);

// 자기개선 학습 로그 — limit 는 improvement 화면과 같은 슬라이스.
// 최다 빈도는 표 전체가 아니라 이 슬라이스 안에서 고름 — 읽기 경로가 표 전체 최댓값을 내주지 않음.
const LEARNING_LOG_URL = "/api/improvement/learning-log?limit=50";

// 두 저장소의 표시 이름 — 사실 행과 로드 실패 경보가 같은 이름을 부르게 묶어 둠.
const QUEUE_PROPOSALS_LABEL = "Approval queue";
const QUEUE_LEARNING_LABEL = "Top learned signal";

// ── health 응답 흡수 (ADR-B1 R2) ────────────────────────────────────────────
// health.jsx 가 읽던 다섯 응답을 맵이 그대로 읽음 — 서버 계약 무변경, 요청 자리만 옮김.
// 카드/KPI 모델(window.HealthModel)은 index.html 이 화면과 무관하게 싣고 있어
// health 화면이 사라져도 고아가 되지 않음.

// 로딩 초기 상태 — 다섯 응답이 같은 모양을 씀. 상태 객체는 교체만 하고 변형하지 않으므로
// 참조를 공유해도 안전하고, 재요청 시 같은 참조를 다시 넣으면 불필요한 렌더가 생기지 않음.
const INITIAL_FETCH_STATE_AR = { status: "loading", data: null, error: null };

// 페이로드 드릴다운 기본 데몬 — payload 를 실제로 기록하는 데몬(autoagent/wiki) 중 첫째.
// daily-restart-* 는 run status 만 남기고 payload 를 쓰지 않아 항상 빈 entries 임.
const MAP_PAYLOAD_DAEMON = "autoagent";

// health 폴링 주기 — 장애 대응 표면이라 수동 Refresh 만으로는 늦음.
// 설계도/live/큐 fetch 는 이 틱을 타지 않음: 준정적 데이터를 60s 마다 다시 끌 이유가 없음.
const HEALTH_POLL_MS = 60_000;

// 맵의 health fetch 표 — health.jsx:42-47 의 다섯 URL 과 같은 집합.
// 함수로 둠: 페이로드 URL 이 선택 데몬을 달고 나가야 하고(T9c 드릴다운),
// 목록이 코드 안에 흩어지면 흡수 완결성을 셀 자리가 없어짐.
// 데몬 이름은 응답에서 온 값이라 인코딩해 실음 — 이름 안의 `&`/공백이 그냥 붙으면 질의가
// 한 칸 더 생기거나 잘려 다른 요청이 됨. 서버가 이름을 허용목록으로 거르지만(health-detail.ts),
// 그건 서버의 방어지 이 URL 을 조립하는 쪽의 근거가 아님.
function getMapHealthEndpoints(payloadDaemon) {
	return [
		"/api/health/daemons",
		"/api/health/hook-chain",
		"/api/health",
		`/api/health/daemon-payload?daemon=${encodeURIComponent(payloadDaemon)}&limit=10`,
		"/api/health/hook-failures?days=30&limit=50",
	];
}

// 표에서 페이로드 URL 이 앉은 자리 — 다섯 중 드릴다운 데몬을 따라 움직이는 유일한 항목이고,
// 두 요청 무리(머리글이 서 있는 넷 · 드릴다운 하나)를 가르는 기준임. 목록은 언제나 위 표에서
// 파생시킴: URL 을 effect 안에 다시 적으면 흡수 표(T7)와 갈라져 한쪽만 고쳐지는 자리가 생김.
const MAP_PAYLOAD_URL_INDEX = 3;

// KPI 집계는 공용 모델에 위임 — 맵이 카드 목록을 다시 적지 않음.
// 분모(정상 N/M 의 M)가 HEALTH_CARD_DEFS 를 따라 움직여야 정의가 늘거나 줄 때
// 화면이 조용히 옛 총계를 들고 있지 않음 (F02 불변식의 화면 몫 · T14).
// 모델 미적재 시 null — 가짜 0 을 그리는 대신 KPI 행 자체를 비움.
function getMapHealthKpis(states) {
	const model = window.HealthModel;
	if (!model || typeof model.computeOverviewKpis !== "function") return null;
	return model.computeOverviewKpis(states);
}

// 스트립이 tone 한 줄로 내는 카드 — 정의(kind · 표시 이름)는 공용 카드 목록에서 찾음 (T10).
// 목록에서 사라지면 줄도 사라짐: 맵이 없는 카드의 판정을 지어내지 않음.
const MAP_STRIP_CARD_IDS = ["pg", "browser"];

// 카드 id → 스트립 한 줄. 판정(tone)은 health-model 의 resolveCardFacts 가, 표시 문장은 ui.jsx 의
// 배지 표가 냄 — 맵은 어느 쪽도 다시 적지 않음. 둘째 tone 표를 들이면 KPI 분자와 이 줄이 갈라짐.
// 문장은 tone 기본값(BADGE_TONE_META)을 씀: 카드별 오버라이드('Disconnected' 등)의 선택 로직은
// 카드 격자의 것이고, 한 줄 요약이 그 분기를 복제하면 같은 판정을 두 곳에서 말하게 됨.
// 모르는 tone 은 resolveBadge 가 info 로 떨어뜨림 — 가짜 ok 를 만들지 않음.
// ready 가 아닌 응답은 줄을 내지 않음: 못 읽은 저장소는 아래 로드 실패 경보가 이름으로 부르고
// (getHealthStoreErrorsAR), KPI fold 도 같은 규칙으로 ready 아닌 카드를 분모에서 뺌.
function getMapStripReadings(states) {
	const model = window.HealthModel;
	if (!model || typeof model.resolveCardFacts !== "function") return [];

	return MAP_STRIP_CARD_IDS.map((id) =>
		(model.HEALTH_CARD_DEFS || []).find((def) => def.id === id),
	)
		.filter((def) => Boolean(def))
		.map((def) => {
			const facts = model.resolveCardFacts(def, states);
			if (facts.status !== "ready") return null;

			return {
				id: def.id,
				name: def.name,
				tone: facts.tone,
				statusLabel: window.UI.resolveBadge(facts.tone).label,
			};
		})
		.filter((reading) => Boolean(reading));
}

// 전역 확장 블록 레지스트리 — 맵 하단의 화면-폭 상세 블록. T11(Hook chain) 이 첫 항목이고
// T12c(Hook failure log) 가 뒤를 이음. 접힘/펼침은 항목이 아니라 컨테이너가 관리함.
const GLOBAL_DETAIL_BLOCKS = [
	{
		id: "hook-chain",
		title: "Hook chain",
		render: (states) => <HookChainDetail state={states.hookState} />,
	},
	{
		id: "hook-failures",
		title: "Hook failure log",
		render: (states) => <HookFailureDetail state={states.hookFailState} />,
	},
];

// render 를 갖춘 항목만 통과 — 반쯤 등록된 블록이 컨테이너를 열어 빈 상자를 남기지 않게 함.
function getGlobalDetailBlocks() {
	return GLOBAL_DETAIL_BLOCKS.filter(
		(block) => block && typeof block.render === "function",
	);
}

// 이름을 id 조각으로 — id 문법을 벗어나는 문자만 하이픈으로 접음 (명부의 daily-restart-* 는
// 이미 합법이라 그대로 통과). 두 펼침 영역이 같은 규칙을 써야 한쪽만 문법을 바꿔 어긋나지 않음.
function toDetailIdPart(name) {
	return String(name || "").replace(/[^A-Za-z0-9_-]/g, "-");
}

// 확장 행 상세의 DOM id — 행 컨트롤의 aria-controls 가 가리키는 값.
// 접힌 문자만 다른 두 이름(`a b` 와 `a-b`)은 같은 id 로 떨어짐. 지금 중복 id 가 생기지 않는 것은
// 이름이 유일해서가 아니라 펼쳐진 행이 한 번에 하나이기 때문임(LiveDaemonTable 의 expandedDaemon
// 은 값 하나만 듦). 동시 펼침을 들이는 변경은 이 전제를 깨므로 그때는 행을 구별하는 값(자리 등)을
// id 에 함께 실어야 함 — aria-controls 가 엉뚱한 영역을 가리키게 됨.
function getDaemonDetailId(daemonName) {
	return `arch-daemon-detail-${toDetailIdPart(daemonName)}`;
}

// 전역 블록 펼침 영역의 DOM id — 블록 컨트롤의 aria-controls 가 가리키는 값 (T11).
function getGlobalBlockDetailId(blockId) {
	return `arch-global-detail-${toDetailIdPart(blockId)}`;
}

// hook-chain 응답 → 이벤트 한 줄씩 (T11). 훅 수는 그 이벤트의 모든 matcher 를 합친 값임.
// null = 응답이 아직 없음(로딩/실패) · [] = 응답은 왔고 설정된 이벤트가 없음 — 다른 문장임.
function getHookChainRows(state) {
	if (!state || state.status !== "ready") return null;

	return (state.data?.events || []).map((event) => {
		const groups = (event.groups || []).map((group) => ({
			matcher: group.matcher,
			hooks: group.hooks || [],
		}));

		return {
			event: event.event,
			groups,
			hookCount: groups.reduce((sum, group) => sum + group.hooks.length, 0),
		};
	});
}

// error_kind → 표시 라벨. 라벨 자체가 신호라서 색은 보조임 — 색맹 안전(듀얼 인코딩).
// 서버 union 5종을 모두 적음: 빠진 종류는 아래 폴백이 원문 문자열을 그대로 부르므로
// 화면이 모르는 실패를 'Unknown' 으로 접어 없애지 않음.
const HOOK_FAIL_KIND = {
	connection_refused: { tone: "crit", label: "Connection refused" },
	timeout: { tone: "warn", label: "Timed out" },
	constraint_violation: { tone: "warn", label: "Data conflict" },
	identifier_rejected: { tone: "warn", label: "Identifier rejected" },
	unknown: { tone: "info", label: "Unknown" },
};

function getHookFailKind(kind) {
	return HOOK_FAIL_KIND[kind] || { tone: "info", label: String(kind || "—") };
}

// hook-failures 응답 → 실패 한 줄씩 (T12c). 창(days) 안의 목록이고, 창 밖 최종기록은
// 이 목록이 아니라 응답의 last_failure_ts 가 냄 — 둘은 다른 사실이라 여기서 섞지 않음.
// null = 응답이 아직 없음(로딩/실패) · [] = 응답은 왔고 창 안에 실패가 없음 — 다른 문장임.
function getHookFailureRows(state) {
	if (!state || state.status !== "ready") return null;

	return (state.data?.failures || []).map((failure, index) => ({
		key: failure?.id ?? `${failure?.failure_ts}-${index}`,
		failureTs: failure?.failure_ts || null,
		hookName: failure?.hook_name || "—",
		targetTable: failure?.target_table || "—",
		kind: getHookFailKind(failure?.error_kind),
		retryAttempted: Boolean(failure?.retry_attempted),
	}));
}

// 확장 영역의 실행 줄 — 선택 데몬의 payload 응답을 날짜 + 사유로 접음.
// 응답이 든 daemon 이름을 대조함: 드릴다운 재요청이 도는 동안 이전 데몬의 실패를 새로 펼친 행
// 아래 그리면 화면이 다른 작업의 장애를 이 작업의 것으로 말하게 됨.
// null = 이 데몬의 응답이 아직 없음(로딩/실패) · [] = 응답은 왔고 실행 기록이 없음 — 둘은 다른 문장임.
function getDaemonRunRows(payloadState, daemonName) {
	if (!payloadState || payloadState.status !== "ready") return null;

	const data = payloadState.data;
	if (!data || data.daemon !== daemonName) return null;

	// key 는 fold 가 냄 — 실패 로그 줄과 같은 방식. 날짜도 사유 문장도 로그에서 온 값이라
	// 한 응답 안에서 되풀이될 수 있고, 겹친 key 는 React 경고에 더해 편집 중인 두 줄을
	// 서로 섞음. 자리(index)를 붙여 응답 안에서 유일하게 만듦.
	return (data.entries || []).map((entry, index) => ({
		key: `${entry?.run_date}-${index}`,
		runDate: entry?.run_date || "—",
		verdict: entry?.summary?.verdict || "unknown",
		reasons: (entry?.summary?.error_signatures || []).map((signature, sigIndex) => ({
			key: `${signature?.message}-${sigIndex}`,
			message: signature?.message || "—",
			count: Number(signature?.count) || 0,
		})),
	}));
}

// 사유가 없는 실행이 스스로를 설명하는 문장 — 빈 자리는 '실패 없음'과 '읽을 payload 없음'을 구별하지 못함.
const RUN_VERDICT_NOTE = {
	ok: "No failures recorded",
	unknown: "No readable payload",
};

// Top-level Screen

function ScreenArchitecture(
	/* { onNav } unused — uniform Screen signature per app.jsx */
) {
	const { Icon, Badge, PageHeader, TypeScaleStyle } = window.UI;

	const [diagState, setDiagState] = useStateAR({
		status: "loading",
		data: null,
		error: null,
	});
	const [liveState, setLiveState] = useStateAR({
		status: "loading",
		data: null,
		error: null,
	});

	// 자기개선 큐 두 사실 — 각각 독립적으로 null 가능. 한 저장소가 실패해도 다른 쪽은 그대로 보임.
	// errors 가 그 실패를 들고 있음 — 값 없음과 못 읽음을 화면에서 구별하는 유일한 자리임.
	const [queueState, setQueueState] = useStateAR({
		pendingCount: null,
		topSignal: null,
		errors: [],
	});

	// health 응답 5종 — 각각 독립적으로 실패 가능. 한 응답이 죽어도 나머지 사실은 그대로 보임.
	const [daemonHealthState, setDaemonHealthState] = useStateAR(INITIAL_FETCH_STATE_AR);
	const [hookState, setHookState] = useStateAR(INITIAL_FETCH_STATE_AR);
	const [pgState, setPgState] = useStateAR(INITIAL_FETCH_STATE_AR);
	const [payloadState, setPayloadState] = useStateAR(INITIAL_FETCH_STATE_AR);
	const [hookFailState, setHookFailState] = useStateAR(INITIAL_FETCH_STATE_AR);

	// 페이로드 드릴다운 대상 — 확장 행이 고름 (T9c). 접어도 되돌리지 않음: 되돌리면 다섯 응답이
	// 한 번 더 나가고 방금 읽은 실패가 스트립에서도 지워짐.
	const [payloadDaemon, setPayloadDaemon] = useStateAR(MAP_PAYLOAD_DAEMON);

	const [refreshTick, setRefreshTick] = useStateAR(0);

	// health 전용 틱 — 60s 폴링이 설계도/live/큐 재요청까지 끌고 가지 않게 분리함.
	const [healthTick, setHealthTick] = useStateAR(0);

	// 노드 상세 modal — null 이면 닫힘. payload = { kind, payload, diagramId }
	const [detail, setDetail] = useStateAR(null);

	const diagAbortRef = useRefAR(null);
	const liveAbortRef = useRefAR(null);
	const healthAbortRef = useRefAR(null);
	const payloadAbortRef = useRefAR(null);

	const triggerRefresh = useCallbackAR(() => setRefreshTick((t) => t + 1), []);

	// /api/architecture/diagrams — one-shot per refreshTick. doc-derived 라 폴링 불요.
	useEffectAR(() => {
		const ctrl = new AbortController();
		diagAbortRef.current?.abort();
		diagAbortRef.current = ctrl;

		setDiagState({ status: "loading", data: null, error: null });

		fetchJsonAR("/api/architecture/diagrams", ctrl.signal)
			.then((data) => {
				setDiagState({ status: "ready", data, error: null });
			})
			.catch((err) => handleErrorAR(err, setDiagState));

		return () => ctrl.abort();
	}, [refreshTick]);

	// /api/architecture/live — refreshTick 당 1회 fetch. 데이터가 서비스 부팅 간 준정적이라 폴링 불요 (수동 Refresh 로 갱신).
	useEffectAR(() => {
		const ctrl = new AbortController();
		liveAbortRef.current?.abort();
		liveAbortRef.current = ctrl;

		fetchJsonAR("/api/architecture/live", ctrl.signal)
			.then((data) => {
				if (!ctrl.signal.aborted) setLiveState({ status: "ready", data, error: null });
			})
			.catch((err) => handleErrorAR(err, setLiveState));

		return () => ctrl.abort();
	}, [refreshTick]);

	// 자기개선 큐 — 두 저장소를 각각 읽어 각각 담음.
	// 잇는 키(pattern_label ↔ pattern_signature)의 대응이 확인되지 않아 조인하지 않음.
	// allSettled 라 한쪽 실패가 다른 쪽 값을 지우지 않음.
	useEffectAR(() => {
		const ctrl = new AbortController();

		Promise.allSettled([
			fetchJsonAR("/api/improvement", ctrl.signal),
			fetchJsonAR(LEARNING_LOG_URL, ctrl.signal),
		]).then(([queue, log]) => {
			if (ctrl.signal.aborted) return;
			setQueueState({
				pendingCount:
					queue.status === "fulfilled" ? getPendingCountAR(queue.value) : null,
				topSignal: log.status === "fulfilled" ? getTopSignalAR(log.value) : null,
				errors: [
					getStoreErrorAR(QUEUE_PROPOSALS_LABEL, queue),
					getStoreErrorAR(QUEUE_LEARNING_LABEL, log),
				].filter(Boolean),
			});
		});

		return () => ctrl.abort();
	}, [refreshTick]);

	// 머리글이 서 있는 health 응답 4종 — 병렬 발화. 수동 Refresh(refreshTick)와 60s 폴링(healthTick)
	// 에서만 다시 나감. 드릴다운(payloadDaemon)은 일부러 deps 에 없음: 행 하나를 펼쳤다고 이 넷이
	// 다시 나가면 왕복 동안 스트립의 PG·브라우저 줄이 DOM 에서 사라지고 KPI 가 —/— 로 떨어져,
	// 방금 읽은 실패를 조작자가 다시 못 봄. 세터 순서는 아래 URL 순서와 짝임.
	useEffectAR(() => {
		const ctrl = new AbortController();
		healthAbortRef.current?.abort();
		healthAbortRef.current = ctrl;

		const setters = [setDaemonHealthState, setHookState, setPgState, setHookFailState];
		// 표에서 페이로드 자리만 덜어냄. 데몬 이름을 싣는 URL 은 방금 덜어낸 그 하나뿐이라
		// 어느 이름으로 표를 세우든 남는 넷은 같음 — 그래서 payloadDaemon 이 여기 필요 없음.
		const urls = getMapHealthEndpoints(MAP_PAYLOAD_DAEMON).filter(
			(_url, index) => index !== MAP_PAYLOAD_URL_INDEX,
		);

		urls.forEach((url, i) => {
			const setter = setters[i];
			setter(INITIAL_FETCH_STATE_AR);
			fetchJsonAR(url, ctrl.signal)
				.then((data) => {
					if (!ctrl.signal.aborted) setter({ status: "ready", data, error: null });
				})
				.catch((err) => handleErrorAR(err, setter));
		});

		return () => ctrl.abort();
	}, [refreshTick, healthTick]);

	// 드릴다운 응답 1종 — 위 넷과 달리 선택 데몬을 따라 다시 나감 (T9c). 자기 요청만 중단함:
	// 머리글의 넷과 abort 컨트롤러를 함께 쓰면 행을 펼칠 때 그쪽 왕복까지 끊겨 같은 공백이 생김.
	useEffectAR(() => {
		const ctrl = new AbortController();
		payloadAbortRef.current?.abort();
		payloadAbortRef.current = ctrl;

		const url = getMapHealthEndpoints(payloadDaemon)[MAP_PAYLOAD_URL_INDEX];

		setPayloadState(INITIAL_FETCH_STATE_AR);
		fetchJsonAR(url, ctrl.signal)
			.then((data) => {
				if (!ctrl.signal.aborted) setPayloadState({ status: "ready", data, error: null });
			})
			.catch((err) => handleErrorAR(err, setPayloadState));

		return () => ctrl.abort();
	}, [refreshTick, healthTick, payloadDaemon]);

	// 60s 자동 새로고침 — health 는 장애 대응 표면이라 수동 Refresh 만으로는 늦음.
	useEffectAR(() => {
		const intervalId = setInterval(() => setHealthTick((t) => t + 1), HEALTH_POLL_MS);
		return () => clearInterval(intervalId);
	}, []);

	// ── derived data ──────────────────────────────────────────────────────────

	// 화면은 canonical 맵 한 장만 그림 — 나머지 여섯은 미렌더 source 레코드로 서버에 남음.
	const activeDiagram = useMemoAR(() => {
		const all = diagState.status === "ready" ? diagState.data?.diagrams || [] : [];
		// 서버가 canonical slug 를 바꾸면 id 매칭이 비므로 payload 첫 장으로 낙하 → 빈 화면 대신 지도를 유지함.
		return all.find((d) => d.id === CANONICAL_DIAGRAM_ID) || all[0] || null;
	}, [diagState.status, diagState.data]);

	// node.id → info (탐색용 — 상세 패널이 from/to 노드 라벨을 표시할 때 사용).
	const nodeIndex = useMemoAR(() => {
		const idx = new Map();
		if (!activeDiagram) return idx;
		for (const layer of activeDiagram.layers || []) {
			for (const node of layer.nodes || []) {
				idx.set(node.id, {
					...node,
					layer_id: layer.id,
					layer_label: layer.label,
					layer_role: layer.role,
				});
			}
		}
		return idx;
	}, [activeDiagram]);

	// 라벨 → node.id (mermaid SVG 의 텍스트 라벨로 backend node 를 fuzzy match 할 때 사용).
	// mermaid 가 노드 라벨을 임의로 줄바꿈/공백 변환할 수 있어 정규화 후 매칭.
	const nodeByLabel = useMemoAR(() => {
		const m = new Map();
		if (!activeDiagram) return m;
		for (const layer of activeDiagram.layers || []) {
			for (const node of layer.nodes || []) {
				const norm = normalizeLabelAR(node.label);
				if (norm) m.set(norm, node.id);
				// 라벨의 첫 segment (·, — 분리 전)로도 색인 — mermaid 가 메타를 잘라낸 경우 대비
				const head = normalizeLabelAR(node.label.split(/\s[·—]\s/)[0]);
				if (head && !m.has(head)) m.set(head, node.id);
			}
		}
		return m;
	}, [activeDiagram]);

	// unscoped mermaid node id → daemon 목록 — 서버 DAEMON_NODE_BINDINGS(node_ids) 기반. 소비자는 노드 상세 드로어의 daemon pill.
	//   한 노드에 복수 daemon 바인딩 가능(cron: daily-restart-autoagent/-wiki) → id 당 목록 보존, last-writer-wins 드롭 방지 (F39).
	const liveDaemonsByNodeId = useMemoAR(() => {
		if (liveState.status !== "ready") return new Map();
		return buildLiveDaemonsByNodeId(liveState.data?.daemons);
	}, [liveState.status, liveState.data]);

	const handleSelectNode = useCallbackAR((nodeId) => {
		if (!nodeId) return;
		setDetail({
			kind: "node",
			payload: { id: nodeId },
			diagramId: CANONICAL_DIAGRAM_ID,
		});
	}, []);

	const closeDetail = useCallbackAR(() => setDetail(null), []);

	// 설계도 카운트 드리프트(구조 정합성) — daemon status(런타임 헬스)와 별개 신호.
	//   live 응답 ready 시점에만 신뢰. diffs = [{ key, claimed, actual }].
	const driftStale =
		liveState.status === "ready" && liveState.data?.stale === true;
	const driftDiffs = driftStale ? liveState.data?.diffs || [] : [];

	// 이중기록이 끊긴 writer — 상시 칩을 대신하는 조건부 경보의 유일한 근거.
	//   live 응답 ready 시점에만 신뢰. 빈 배열이면 배너가 DOM 에 없음.
	const offWriters =
		liveState.status === "ready"
			? (liveState.data?.writers || []).filter((w) => !w.dual_write_active)
			: [];

	// 거버넌스 멤버십 — 컴플라이언스 매트릭스가 이름 댄 문서의 부재 목록(총계 아님).
	const governance =
		liveState.status === "ready" ? liveState.data?.governance : null;
	const absentDocs = governance?.absent || [];

	return (
		<div className="h-full flex flex-col min-h-0">
			<TypeScaleStyle />
			<style>
				{"@keyframes skelPulseAR { 0%,100%{opacity:.7} 50%{opacity:.35} } " +
					// arch-page: h-full flex 컨텍스트 안에서 부모 100% 차지 (viewport fit).
					".arch-page { display: flex; flex-direction: column; height: 100%; min-height: 0; flex: 1; gap: 8px; } " +
					// 다이어그램 본체 = 단일 컬럼, 가용 폭 100% 회수. 부수 패널은 가로 스트립/접이식으로 외부 배치.
					".arch-main { display: flex; flex-direction: column; min-height: 0; flex: 1; } " +
					".arch-col-card { display: flex; flex-direction: column; min-height: 0; flex: 1; } " +
					".arch-col-card .card-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; } " +
					// 라이브 상태 상단 스트립 — 가로 스크롤 1줄 (좌측 컬럼 폭 미점유).
					".arch-live-strip { display: flex; align-items: center; gap: 14px; flex-wrap: nowrap; overflow-x: auto; " +
					"padding: 6px 10px; background: rgb(var(--sunken)); border: 1px solid rgb(var(--line)); border-radius: 6px; flex-shrink: 0; } " +
					// 사실 스트립 두 줄(자기개선 큐 · health 요약) — 상시 노출, 같은 면.
					// 좁은 폭에서는 사실들이 줄바꿈으로 쌓임. 한 규칙에 둘을 묶어 둠: 면이 갈라지면
					// 지도 위 두 줄이 서로 다른 상자로 읽힘.
					".arch-queue-strip, .arch-health-strip { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; " +
					"padding: 6px 10px; background: rgb(var(--sunken)); border: 1px solid rgb(var(--line)); border-radius: 6px; flex-shrink: 0; } " +
					// 전역 확장 블록 — 지도 아래 화면-폭 상세. 블록이 없으면 컨테이너 자체가 렌더되지 않음.
					".arch-global-blocks { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; } " +
					".arch-global-block { background: rgb(var(--sunken)); border: 1px solid rgb(var(--line)); border-radius: 6px; } " +
					// 블록 머리 = 펼침 컨트롤. 표 행과 같은 button 클래스를 쓰되 블록 폭을 다 차지해 클릭 면이 넓음.
					".arch-global-block > .arch-row-toggle { width: 100%; padding: 6px 10px; } " +
					".arch-global-block-body { padding: 0 10px 8px 22px; } " +
					// 훅 구성 — 이벤트 > matcher > 훅 3단 들여쓰기. 목록 표식 없이 들여쓰기만으로 계층을 냄.
					".arch-hook-events, .arch-hook-groups, .arch-hook-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; } " +
					".arch-hook-groups, .arch-hook-list { padding-left: 14px; } " +
					".arch-hook-event, .arch-hook-group { display: flex; flex-direction: column; gap: 2px; min-width: 0; } " +
					".arch-hook-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; } " +
					".arch-queue-fact { display: flex; align-items: baseline; gap: 6px; min-width: 0; flex-wrap: wrap; } " +
					".arch-queue-error { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; } " +
					// svg-pan-zoom: overflow:hidden 으로 viewBox 밖 클리핑, svg 100%×100% + max-width none.
					// 캔버스 면은 surface — 소스 지시자의 background·edgeLabelBackground 와 같은 토큰이어야 엣지 라벨 마스크가 드러나지 않음.
					// 세 톤(캔버스 < 존 < 노드)의 맨 아래 칸 — 여기만 바꾸면 사다리가 어긋난다.
					".arch-mermaid-canvas { width: 100%; flex: 1; min-height: 0; background: rgb(var(--surface)); border-radius: 6px; overflow: hidden; position: relative; padding: 0; } " +
					".arch-mermaid-canvas svg { width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important; display: block; font-family: Pretendard, system-ui, sans-serif !important; } " +
					// 노드 라벨 — 색만 보정한다.
					// mermaid 는 이 규칙이 걸리지 않는 캔버스 밖에서 라벨을 재고 그 폭으로 foreignObject 를 자름.
					// 서체(size·weight·family)를 건드리면 잰 상자보다 넓은 글리프 런이 그려져 끝 글자가 잘린다.
					".arch-mermaid-canvas svg .nodeLabel, .arch-mermaid-canvas svg .node text, .arch-mermaid-canvas svg .node .label, .arch-mermaid-canvas svg .node foreignObject span { fill: rgb(var(--ink)) !important; color: rgb(var(--ink)) !important; } " +
					// 잰 상자와 그린 글리프 런의 잔여 오차(서브픽셀·힌팅)는 자르지 말고 흘려보냄 — 노드 rect 안쪽 패딩(12) 안이라 레이아웃 불변.
					".arch-mermaid-canvas svg .node foreignObject { overflow: visible; } " +
					// 모서리 — 업스트림 독트린 r=8. mermaid 가 rx 를 표현 속성으로 찍으므로 CSS 기하 속성이 이김
					// (소스 shape 를 바꾸는 대안은 content-budget 계수와 존 rect 를 동시에 흔들어 기각).
					".arch-mermaid-canvas svg :is(.node, .cluster) rect { rx: 8px; ry: 8px; } " +
					// pan-drag 중 SVG 텍스트 select 차단 (클릭/줌/팬 보존).
					".arch-mermaid-canvas { user-select: none; -webkit-user-select: none; } " +
					// 줌 floor 힌트 — 캔버스 우하단 작은 안내 (가독 fit 적용됨 = 휠/드래그로 탐색).
					".arch-canvas-hint { position: absolute; right: 8px; bottom: 6px; font-size: var(--fs-micro); " +
					'color: rgb(var(--faint)); font-family: "JetBrains Mono", monospace; pointer-events: none; ' +
					"background: rgb(var(--surface) / 0.7); padding: 1px 6px; border-radius: 4px; } " +
					".arch-mermaid-canvas .node { cursor: pointer; transition: opacity .12s; } " +
					".arch-mermaid-canvas .node:hover { opacity: 0.78; } " +
					// 결함 링 — fault 판정 데몬의 바인딩 노드만 점등. ok/no-data 는 규칙 자체가 없음.
					// focus-visible 규칙보다 앞에 둠 — 특이도가 같아 나중 규칙이 이기고, 포커스 표식이 링을 덮어야 함.
					".arch-mermaid-canvas .node.arch-node-live-warn rect, .arch-mermaid-canvas .node.arch-node-live-warn polygon { stroke: rgb(var(--warn)) !important; stroke-width: 2.5 !important; } " +
					".arch-mermaid-canvas .node.arch-node-live-crit rect, .arch-mermaid-canvas .node.arch-node-live-crit polygon { stroke: rgb(var(--crit)) !important; stroke-width: 2.5 !important; } " +
					// 줌/팬/맞춤 컨트롤 클러스터 — 캔버스 우하단, hint 위. 불투명 면(상시 chrome) → blur 금지.
					".arch-zoom-controls { position: absolute; right: 8px; bottom: 28px; display: flex; flex-direction: column; gap: 4px; z-index: 2; } " +
					".arch-zoom-btn { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; " +
					"background: rgb(var(--elev)); border: 1px solid rgb(var(--line)); border-radius: 6px; color: rgb(var(--dim)); " +
					'cursor: pointer; font-family: "JetBrains Mono", monospace; font-size: 16px; line-height: 1; padding: 0; transition: all .12s; } ' +
					".arch-zoom-btn:hover { color: rgb(var(--ink)); border-color: rgb(var(--faint)); background: rgb(var(--surface-raised-2, var(--elev))); } " +
					".arch-zoom-btn:focus-visible { outline: 2px solid rgb(var(--accent)); outline-offset: 1px; } " +
					// 키보드 포커스 노드 ring — 클릭 가능 노드의 a11y focus 표식.
					".arch-mermaid-canvas .node:focus-visible rect, .arch-mermaid-canvas .node:focus-visible polygon { stroke: rgb(var(--accent)) !important; stroke-width: 2.5 !important; } " +
					// 라이브 상태 표 — 전체 데몬 명부를 읽는 표면. 캔버스 링은 결함만 짚으므로 정상분은 여기서만 보임.
					".arch-live-table-wrap { flex-shrink: 0; max-height: 220px; overflow: auto; background: rgb(var(--sunken)); border: 1px solid rgb(var(--line)); border-radius: 6px; } " +
					".arch-live-table { width: 100%; border-collapse: collapse; font-size: var(--fs-meta); } " +
					".arch-live-table th, .arch-live-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid rgb(var(--line)); white-space: nowrap; } " +
					".arch-live-table thead th { color: rgb(var(--faint)); font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em; } " +
					".arch-live-table tbody td { color: rgb(var(--dim)); } " +
					// 확장 컨트롤 — 표 셀 안에서 서체를 물려받아 행 그대로 보이되 진짜 button 으로 남음.
					".arch-row-toggle { display: inline-flex; align-items: baseline; gap: 6px; background: none; " +
					"border: 0; margin: 0; padding: 0; color: inherit; font: inherit; cursor: pointer; text-align: left; } " +
					".arch-row-toggle:hover { color: rgb(var(--ink)); } " +
					".arch-row-toggle:focus-visible { outline: 2px solid rgb(var(--accent)); outline-offset: 2px; } " +
					".arch-row-caret { color: rgb(var(--faint)); font-size: var(--fs-micro); } " +
					// 상세 셀만 줄바꿈 허용 — 표 본문의 nowrap 이 걸리면 사유 문장이 가로로 흘러 표를 벌림.
					".arch-live-table td.arch-run-cell { white-space: normal; padding: 6px 8px 8px 22px; } " +
					".arch-run-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; } " +
					".arch-run-entry { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; min-width: 0; } " +
					".arch-run-reasons { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; min-width: 0; } " +
					// aria-describedby 타깃 — 클립으로 가리되 렌더 트리에는 남김. display:none 은 노드를 렌더에서 빼 innerText 계측을 잃음.
					".arch-desc-a11y { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; " +
					"overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; } " +
					// 신규 모션 게이트 — skeleton pulse + 노드/줌 컨트롤 transition 정지 (§8.4 계약).
					"@media (prefers-reduced-motion: reduce) { " +
					"[style*=\"skelPulseAR\"], .arch-mermaid-canvas .node, .arch-zoom-btn { animation: none !important; transition: none !important; } }"}
			</style>

			<div className="flex-shrink-0">
				<PageHeader
					title="System map"
					sub="Live system architecture"
					right={
						<>
							<button
								className="btn ghost sm"
								onClick={triggerRefresh}
								aria-label="Refresh system map"
							>
								<Icon name="refresh" size={14} />
								Refresh
							</button>
						</>
					}
				/>
			</div>

			<div className="arch-page">
				{/* 구조 드리프트 배너(설계도 카운트 mismatch) — daemon LiveStrip(런타임 헬스)과
            별개 영역. stale 일 때만 노출, info-tone 으로 daemon-down warn-tone 과 구별. */}
				{offWriters.length > 0 && <DualWriteBannerAR writers={offWriters} />}

				{driftStale && <DriftBannerAR diffs={driftDiffs} />}

				{/* 거버넌스 문서 부재 — 이름을 부르는 경고. 카운트 드리프트보다 상위 심각도(warn-tone). */}
				{(absentDocs.length > 0 || governance?.sourceMissing) && (
					<MembershipBannerAR
						absent={absentDocs}
						sourceMissing={governance?.sourceMissing}
					/>
				)}

				<LiveStrip state={liveState} onRetry={triggerRefresh} />

				<QueueStrip
					pendingCount={queueState.pendingCount}
					topSignal={queueState.topSignal}
					errors={queueState.errors}
					onRetry={triggerRefresh}
				/>

				{/* health 요약 — 이관된 health 화면의 KPI 가 지도 상단에 앉는 자리 (ADR-B1). */}
				<HealthStrip
					daemonState={daemonHealthState}
					pgState={pgState}
					hookState={hookState}
					hookFailState={hookFailState}
					payloadState={payloadState}
					payloadDaemon={payloadDaemon}
					onRetry={triggerRefresh}
				/>

				{/* 본체: 단일 canonical Mermaid 캔버스 (가용 폭 100%) */}
				<div className="arch-main">
					<div className="card arch-col-card">
						<div className="card-body" style={{ padding: 10 }}>
							<DiagramBody
								diagState={diagState}
								activeDiagram={activeDiagram}
								nodeByLabel={nodeByLabel}
								liveDaemonsByNodeId={liveDaemonsByNodeId}
								onSelectNode={handleSelectNode}
								onRetry={triggerRefresh}
							/>
						</div>
					</div>
				</div>

				<div id={ARCH_DESC_ID} className="arch-desc-a11y">
					{activeDiagram?.description || "No description available."}
				</div>

				<LiveDaemonTable
					state={liveState}
					payloadState={payloadState}
					onSelectDaemon={setPayloadDaemon}
				/>

				{/* 전역 확장 블록 — 명부(GLOBAL_DETAIL_BLOCKS)가 채움: Hook chain · Hook failure log. */}
				<GlobalDetailRegion
					states={{
						daemonState: daemonHealthState,
						pgState,
						hookState,
						hookFailState,
						payloadState,
					}}
				/>
			</div>

			{/* 노드 클릭 → 중앙 modal (파일명 / 설명 / 연결 flows) */}
			{detail && (
				<DetailModal
					detail={detail}
					nodeIndex={nodeIndex}
					activeDiagram={activeDiagram}
					liveDaemonsByNodeId={liveDaemonsByNodeId}
					onClose={closeDetail}
				/>
			)}
		</div>
	);
}

// Diagram canvas card (Mermaid native rendering)

function DiagramBody({
	diagState,
	activeDiagram,
	nodeByLabel,
	liveDaemonsByNodeId,
	onSelectNode,
	onRetry,
}) {
	// mermaid CDN polling — 외부 스크립트 로딩 완료 대기 (최대 5s).
	const [mermaidReady, setMermaidReady] = useStateAR(() =>
		Boolean(window.mermaid),
	);
	useEffectAR(() => {
		if (mermaidReady) return;
		const tick = setInterval(() => {
			if (window.mermaid) {
				setMermaidReady(true);
				clearInterval(tick);
			}
		}, 100);
		const stop = setTimeout(() => clearInterval(tick), 5_000);
		return () => {
			clearInterval(tick);
			clearTimeout(stop);
		};
	}, [mermaidReady]);

	if (diagState.status === "loading") return <ChartSkeletonAR />;
	if (diagState.status === "error") {
		return (
			<ErrorBannerAR
				title="Couldn't load the system map"
				detail={diagState.error}
				onRetry={onRetry}
			/>
		);
	}
	if (!activeDiagram) {
		return <EmptyStateAR message="No diagrams to show." />;
	}
	const source = activeDiagram.mermaid_source;
	if (!source || typeof source !== "string" || source.trim().length === 0) {
		return (
			<EmptyStateAR message="This diagram has an empty mermaid_source." />
		);
	}
	if (!mermaidReady) {
		return <ChartSkeletonAR />;
	}
	return (
		<MermaidCanvas
			diagramId={activeDiagram.id}
			source={source}
			diagramTitle={activeDiagram.title || activeDiagram.id}
			nodeByLabel={nodeByLabel}
			liveDaemonsByNodeId={liveDaemonsByNodeId}
			onSelectNode={onSelectNode}
		/>
	);
}

// MermaidCanvas — window.mermaid.render 로 SVG 생성 → 컨테이너 주입 → svg-pan-zoom 활성화.
// SECURITY: source 는 internal trusted 다이어그램 소스 → DOMPurify sanitize 생략 (외부 입력 노출 시 재검토 필수).
// drag/click 구분: mousedown 좌표 추적 → 4px 이상 이동 시 drag (click 무시).
function MermaidCanvas({
	diagramId,
	source,
	diagramTitle,
	nodeByLabel,
	liveDaemonsByNodeId,
	onSelectNode,
}) {
	const containerRef = useRefAR(null);
	const panZoomRef = useRefAR(null);
	// handleClick 의 drag 임계 검사용 (mousedown 시점 좌표).
	const dragStartRef = useRefAR(null);
	const [renderState, setRenderState] = useStateAR({
		status: "idle",
		error: null,
		svgHtml: null,
	});

	// 줌/팬/맞춤 컨트롤 — panZoomRef 인스턴스 위임. 인스턴스 부재 시 no-op (정적 폴백 안전).
	const zoomBy = useCallbackAR((factor) => {
		const inst = panZoomRef.current;
		if (inst) inst.zoomBy(factor);
	}, []);
	const fitToView = useCallbackAR(() => {
		const inst = panZoomRef.current;
		if (inst) applyLegibleFitAR(inst, containerRef.current);
	}, []);
	const panBy = useCallbackAR((dx, dy) => {
		const inst = panZoomRef.current;
		if (inst) inst.panBy({ x: dx, y: dy });
	}, []);

	useEffectAR(() => {
		if (!source || !window.mermaid) return;

		let cancelled = false;
		setRenderState({ status: "rendering", error: null, svgHtml: null });

		// mermaid.render unique id (diagram + timestamp 로 충돌 회피).
		const renderId = `mermaid-${diagramId}-${Date.now()}`;

		// 웹폰트(Pretendard) 도착 전에 재면 mermaid 는 fallback 서체 폭으로 상자를 자름 — 뒤이어 swap 된 더 넓은 서체가 끝 글자를 넘긴다.
		// fonts.ready 이후에 재게 해서 잰 서체 = 그린 서체를 만든다.
		const fontsReady = document.fonts?.ready ?? Promise.resolve();

		// ELK 레이아웃 준비(public/mermaid-elk-loader.js) — 벤더 번들은 이제 이 호출이 처음 부를 때
		// 도착하므로, 기다리지 않고 그리면 등록 전이라 layout:'elk' 가 조용히 dagre 로 눕는다.
		// 준비 함수가 아예 없으면(로더 스크립트 자체가 404) 폴백을 감수하고 그린다 — 다이어그램을
		// 통째로 잃는 것보다는 dagre 로라도 보이는 편이 낫다는 판단은 대체된 인라인 등록의 `?? []` 와 같다.
		const elkReady = window.ensureElkLayout ? window.ensureElkLayout() : Promise.resolve();

		Promise.all([fontsReady, elkReady])
			.then(() => (cancelled ? null : window.mermaid.render(renderId, source)))
			.then((result) => {
				if (cancelled || !result) return;
				setRenderState({ status: "ready", error: null, svgHtml: result.svg });
			})
			.catch((err) => {
				if (cancelled) return;
				const msg = err && err.message ? err.message : String(err);
				setRenderState({ status: "error", error: msg, svgHtml: null });
			});

		return () => {
			cancelled = true;
		};
	}, [source, diagramId]);

	// SVG 가 DOM 에 들어간 직후 — 라벨 매칭으로 backend node id 를 dataset 에 저장 (노드 클릭 → 상세).
	useEffectAR(() => {
		if (renderState.status !== "ready") return;
		const root = containerRef.current;
		if (!root) return;

		const svgNodes = root.querySelectorAll("g.node");
		svgNodes.forEach((el) => {
			const labelText = extractMermaidNodeLabelAR(el);
			if (!labelText) return;
			const norm = normalizeLabelAR(labelText);
			const matchedId = nodeByLabel.get(norm) || null;
			if (matchedId) el.setAttribute("data-arch-node-id", matchedId);
		});
	}, [renderState.status, renderState.svgHtml, nodeByLabel]);

	// 결함 링 — 서버 판정이 fault 인 데몬의 바인딩 노드에만 클래스를 붙임 (정상 명부는 라이브 표가 맡음).
	//   위 효과가 심은 data-arch-node-id 를 되읽으므로 선언 순서가 곧 실행 순서임 — 앞으로 옮기면 첫 렌더에서 빈다.
	//   폴링 tick 마다 다시 도는 유일한 캔버스 효과 — 재렌더 없이 판정만 바뀌는 경로가 여기임.
	useEffectAR(() => {
		if (renderState.status !== "ready") return;
		const root = containerRef.current;
		if (!root) return;

		root.querySelectorAll("g.node").forEach((el) => {
			el.classList.remove(...FAULT_RING_CLASSES);
			const nodeId = el.getAttribute("data-arch-node-id");
			if (!nodeId) return;

			const ringClass = getFaultRingClassAR(
				liveDaemonsByNodeId.get(unscopedNodeIdAR(nodeId)),
			);
			if (ringClass) el.classList.add(ringClass);
		});
	}, [renderState.status, renderState.svgHtml, nodeByLabel, liveDaemonsByNodeId]);

	// SVG a11y — root <svg> 에 role/aria-label + 내장 <title> + aria-describedby(외부 description) 부여.
	//   mermaid 가 자체 생성한 <title>/aria-* 를 우리 의미값으로 덮어씀 (스크린리더가 다이어그램 목적 판독).
	useEffectAR(() => {
		if (renderState.status !== "ready") return;
		const root = containerRef.current;
		if (!root) return;
		const svgEl = root.querySelector("svg");
		if (!svgEl) return;

		svgEl.setAttribute("role", "img");
		svgEl.setAttribute("aria-label", `${diagramTitle} architecture diagram`);
		svgEl.setAttribute("aria-describedby", ARCH_DESC_ID);

		// 내장 <title> 갱신 — 호버 tooltip + 보조 a11y 채널.
		let titleEl = svgEl.querySelector(":scope > title");
		if (!titleEl) {
			titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
			svgEl.insertBefore(titleEl, svgEl.firstChild);
		}
		titleEl.textContent = diagramTitle;
	}, [renderState.status, renderState.svgHtml, diagramTitle]);

	/**
	 * 존 제목 여백 — rect 를 위로만 늘려 띠를 만든다.
	 * mermaid+ELK 는 존 rect 상단에서 첫 노드까지 (제목 높이 + 15) 만 비우고 제목은 그 안에서 테두리에 붙음.
	 * subGraphTitleMargin 은 그 15 안에서 제목을 밀 뿐이고 ELK padding 키는 지시자에서 살아남지 못함.
	 * 위로만 늘리므로 아래 모서리·노드 좌표는 불변 — 직교성/폭 계약 유지.
	 * pan-zoom 이 bbox 를 읽기 전에 돌아야 함.
	 */
	useEffectAR(() => {
		if (renderState.status !== "ready") return;
		const root = containerRef.current;
		if (!root) return;
		root.querySelectorAll("svg g.cluster rect").forEach((rect) => {
			if (rect.dataset.archTitleBand === "1") return;
			const y = Number.parseFloat(rect.getAttribute("y"));
			const height = Number.parseFloat(rect.getAttribute("height"));
			if (!Number.isFinite(y) || !Number.isFinite(height)) return;
			rect.setAttribute("y", String(y - ZONE_TITLE_BAND));
			rect.setAttribute("height", String(height + ZONE_TITLE_BAND));
			rect.dataset.archTitleBand = "1";
		});
	}, [renderState.status, renderState.svgHtml]);

	// svg-pan-zoom 활성화 — diagramId 변경 → cleanup → 신규 SVG 재초기화 + 가독 fit.
	useEffectAR(() => {
		if (renderState.status !== "ready") return;
		if (!window.svgPanZoom) return;
		const root = containerRef.current;
		if (!root) return;

		const svgEl = root.querySelector("svg");
		if (!svgEl) return;

		// mermaid 의 인라인 max-width/height 제거 (CSS !important 와 중복 안전망).
		svgEl.style.maxWidth = "none";
		svgEl.style.maxHeight = "none";

		let instance = null;
		let raf1 = 0;
		let raf2 = 0;
		try {
			instance = window.svgPanZoom(svgEl, {
				// 컨트롤 아이콘 제거 — 마우스 휠/드래그/더블클릭만 사용.
				controlIconsEnabled: false,
				// 라이브러리 줌 하한 — 전폭 fit 비율이 LEGIBLE_FIT_FLOOR 미만이어도 zoom() 을 되끌어올리지 않도록 더 낮게 (PAN_ZOOM_MIN).
				minZoom: PAN_ZOOM_MIN,
				maxZoom: 5,
				zoomScaleSensitivity: 0.3,
				panEnabled: true,
				zoomEnabled: true,
				dblClickZoomEnabled: true,
				mouseWheelZoomEnabled: true,
				// false → 단일 클릭은 React onClick 으로 정상 버블링 → 노드 클릭 → 상세 모달 보존.
				preventMouseEventsDefault: false,
				// 자동 fit/center 비활성 — 라이브러리 fit 는 폭 기준 으깸·floor 무시 →
				// applyLegibleFitAR 가 절대 행렬 스케일을 직접 계산.
				fit: false,
				center: false,
				contain: false,
			});
			panZoomRef.current = instance;

			// 초기 동기 호출은 flex 레이아웃 미해결 → SVG 측정폭이 작아 fit 가 너무 작게 굳음.
			//   double-rAF 로 레이아웃 정착 후 resize()→측정폭 갱신→fit 적용.
			raf1 = requestAnimationFrame(() => {
				raf2 = requestAnimationFrame(() => {
					if (panZoomRef.current !== instance) return; // 그새 교체됨
					applyLegibleFitAR(instance, root);
				});
			});
		} catch (_e) {
			// 초기화 실패 → 정적 SVG 폴백 (pan/zoom 손실, 화면은 살아있음).
			instance = null;
			panZoomRef.current = null;
		}

		return () => {
			if (raf1) cancelAnimationFrame(raf1);
			if (raf2) cancelAnimationFrame(raf2);
			if (panZoomRef.current) {
				try {
					panZoomRef.current.destroy();
				} catch (_e) {
					/* DOM 교체 직전 destroy 실패 무시 */
				}
				panZoomRef.current = null;
			}
			// 정리되는 렌더의 short-graph clamp 가 재사용 캔버스 DOM 에 잔존 → 다음 그래프 측정 오염 차단.
			clearCanvasSizingAR(root);
		};
	}, [renderState.status, renderState.svgHtml]);

	// 노드 클릭 — SVG event delegation (.node 셀렉터 closest 매칭, drag 는 무시).
	const handleMouseDown = useCallbackAR((e) => {
		dragStartRef.current = { x: e.clientX, y: e.clientY };
	}, []);

	const handleClick = useCallbackAR(
		(e) => {
			const nodeEl = e.target.closest("g.node");
			if (!nodeEl) return;
			// drag 였으면 무시 (pan 동작이지 노드 선택 아님).
			const start = dragStartRef.current;
			if (start) {
				const dx = e.clientX - start.x;
				const dy = e.clientY - start.y;
				if (dx * dx + dy * dy > 16) return; // 4px 이상 이동 → drag
			}
			const matchedId = nodeEl.getAttribute("data-arch-node-id");
			if (matchedId) onSelectNode(matchedId);
		},
		[onSelectNode],
	);

	// 키보드 탐색 — +/- 줌, 화살표 팬, 0 맞춤. 캔버스 포커스 시 동작 (touch/mouse 동등 a11y).
	const handleKeyDown = useCallbackAR(
		(e) => {
			const PAN_STEP = 40;
			switch (e.key) {
				case "+":
				case "=":
					zoomBy(1.25);
					break;
				case "-":
				case "_":
					zoomBy(0.8);
					break;
				case "0":
					fitToView();
					break;
				case "ArrowUp":
					panBy(0, PAN_STEP);
					break;
				case "ArrowDown":
					panBy(0, -PAN_STEP);
					break;
				case "ArrowLeft":
					panBy(PAN_STEP, 0);
					break;
				case "ArrowRight":
					panBy(-PAN_STEP, 0);
					break;
				default:
					return;
			}
			e.preventDefault();
		},
		[zoomBy, fitToView, panBy],
	);

	if (renderState.status === "rendering" || renderState.status === "idle") {
		return <ChartSkeletonAR />;
	}
	if (renderState.status === "error") {
		return (
			<ErrorBannerAR title="Diagram failed to render" detail={renderState.error} />
		);
	}
	return (
		<>
			<div
				className="arch-mermaid-canvas"
				role="group"
				aria-label={`${diagramTitle} — pan and zoom diagram`}
				tabIndex={0}
				onKeyDown={handleKeyDown}
			>
				<div
					ref={containerRef}
					style={{ width: "100%", height: "100%" }}
					onMouseDown={handleMouseDown}
					onClick={handleClick}
					// SECURITY: internal trusted source — 위 SECURITY 주석 참조 (sanitize 생략).
					dangerouslySetInnerHTML={{ __html: renderState.svgHtml }}
				/>

				{/* 줌/팬/맞춤 컨트롤 클러스터 — 우하단. 터치/마우스/키보드 동등 진입점. */}
				<div
					className="arch-zoom-controls"
					role="group"
					aria-label="Diagram zoom controls"
				>
					<button
						type="button"
						className="arch-zoom-btn"
						onClick={() => zoomBy(1.25)}
						aria-label="Zoom in"
						title="Zoom in (+)"
					>
						+
					</button>
					<button
						type="button"
						className="arch-zoom-btn"
						onClick={() => zoomBy(0.8)}
						aria-label="Zoom out"
						title="Zoom out (−)"
					>
						−
					</button>
					<button
						type="button"
						className="arch-zoom-btn"
						onClick={fitToView}
						aria-label="Fit diagram to view"
						title="Fit to view (0)"
					>
						<ArchIconTargetAR />
					</button>
				</div>

				{/* 가독 fit 안내 — 넓은 LR 그래프는 휠/+−·드래그/화살표·키보드로 탐색 */}
				<div className="arch-canvas-hint" aria-hidden="true">
					Click a box for details
				</div>
			</div>
		</>
	);
}

// fit-to-view 아이콘 — Icon SoT 의 'target' 마크업 재사용 (currentColor 상속).
function ArchIconTargetAR() {
	const { Icon } = window.UI;
	return <Icon name="target" size={15} />;
}

// Top live strip — live 페치의 상태 표면. 정상이면 비어 있고(칩 없음), 로딩/실패만 자리를 씀.
//   같은 페치가 드리프트·거버넌스·이중기록 배너를 함께 먹이므로 로딩 표시는 그 셋의 예고이기도 함.

// 스트립 로드 실패 줄 — live 와 큐가 같은 모양을 씀. 컨테이너 클래스는 호출부가 정함:
// 두 경보는 각자의 클래스(.arch-live-strip / .arch-queue-error)로 구별돼야 함.
// detail 은 끊긴 원인을 이름으로 부르는 자리 — 없으면 그 줄만 빠짐.
function StripAlertAR({ className, message, detail, onRetry }) {
	return (
		<div className={className} role="alert">
			<span className="fs-meta text-crit" style={{ flexShrink: 0 }}>
				{message}
			</span>
			{detail && (
				<span className="fs-meta font-mono text-dim truncate">{detail}</span>
			)}
			{onRetry && (
				<button className="btn ghost sm" onClick={onRetry}>
					Retry
				</button>
			)}
		</div>
	);
}

function LiveStrip({ state, onRetry }) {
	if (state.status === "loading") {
		return (
			<div className="arch-live-strip" aria-busy="true">
				<SkelAR w={120} h={16} />
				<SkelAR w={100} h={16} />
				<SkelAR w={140} h={16} />
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<StripAlertAR
				className="arch-live-strip"
				message="Couldn't load live data"
				detail={state.error}
				onRetry={onRetry}
			/>
		);
	}

	// ready 는 렌더할 것이 없음 — 칩이 사라졌고 이중기록 경보는 페이지 상단 배너로 나감.
	return null;
}

/**
 * 자기개선 큐 상태 — 두 저장소의 사실을 나란히 놓되 하나로 합치지 않음(잇는 키의 대응 미확인).
 * 접힘 컨트롤 없이 상시 노출.
 * 컨테이너를 .arch-live-strip 과 나눠 씀 — 그 클래스는 live 로드 실패 경보와 스켈레톤의 자리임.
 * 실패는 경보로 나감 — 값 없음을 못 읽음처럼 보이게 두면 조작자가 둘을 구별할 길이 없음.
 */
function QueueStrip({ pendingCount, topSignal, errors, onRetry }) {
	const { formatRelativeTime } = window.UI;

	if (pendingCount === null && topSignal === null && errors.length === 0) return null;

	return (
		<section className="arch-queue-strip" aria-label="Self-improvement queue">
			{pendingCount !== null && (
				<div className="arch-queue-fact" data-queue-source="autoagent-proposals">
					<span className="fs-micro text-faint">{QUEUE_PROPOSALS_LABEL}</span>
					<span className="fs-meta text-ink">{pendingCount} pending</span>
				</div>
			)}
			{topSignal && (
				<div className="arch-queue-fact" data-queue-source="learning-log">
					<span className="fs-micro text-faint">{QUEUE_LEARNING_LABEL}</span>
					<span className="fs-meta font-mono text-ink">{topSignal.signature}</span>
					<span className="fs-meta text-dim">seen {topSignal.frequency}×</span>
					<span className="fs-meta text-dim">
						updated {formatRelativeTime(topSignal.lastUpdated)}
					</span>
				</div>
			)}
			{/* 끊긴 저장소를 이름으로 부름 — 어느 쪽이 죽었는지가 복구의 첫 단서임 */}
			{errors.length > 0 && (
				<StripAlertAR
					className="arch-queue-error"
					message="Couldn't load the self-improvement queue"
					detail={errors.join(" · ")}
					onRetry={onRetry}
				/>
			)}
		</section>
	);
}

// 끊긴 health 응답의 표시 이름 — 사실 행과 로드 실패 경보가 같은 이름을 부르게 묶어 둠.
// 값 없음(빈 배열)과 못 읽음을 화면에서 구별하는 유일한 자리임.
const HEALTH_STORE_LABELS_AR = {
	daemonState: "Daemons",
	hookState: "Hook chain",
	pgState: "PostgreSQL",
	payloadState: "Run payloads",
	hookFailState: "Hook failures",
};

function getHealthStoreErrorsAR(states) {
	return Object.keys(HEALTH_STORE_LABELS_AR)
		.filter((key) => states[key] && states[key].status === "error")
		.map((key) => HEALTH_STORE_LABELS_AR[key]);
}

/**
 * health 응답 요약 스트립 — 이관된 health 화면의 KPI '정상 N/M' 이 앉는 지도 상단 한 줄.
 * 분모는 window.HealthModel 의 카드 정의 목록에서 나옴 — 맵이 총계를 자기 파일에 다시 적지
 * 않으므로 정의가 늘거나 줄면 분모가 따라 움직임 (F02 불변식의 화면 몫 · T14 가 잠금).
 * PG · Chromium 은 KPI 숫자에 접힌 채로도 각자의 tone 한 줄을 냄 (T10) — 분자가 하나 줄었다는
 * 사실만으로는 어느 부품이 죽었는지 대답하지 못함.
 */
function HealthStrip({
	daemonState,
	pgState,
	hookState,
	hookFailState,
	payloadState,
	payloadDaemon,
	onRetry,
}) {
	const { StatusDot } = window.UI;

	// 카드 판정이 읽는 네 응답 — KPI 분자/분모와 부품 한 줄이 같은 묶음을 봐야 두 값이 갈라지지 않음.
	// 페이로드는 카드 정의에 없어 이 묶음 밖임: 로드 실패 경보에만 이름으로 참여함.
	const cardStates = { daemonState, pgState, hookState, hookFailState };

	const kpis = getMapHealthKpis(cardStates);

	const readings = getMapStripReadings(cardStates);

	const errors = getHealthStoreErrorsAR({ ...cardStates, payloadState });

	// 최근 실행 페이로드 도착 건수 — 확장 행이 날짜·사유로 펼치는 원자료(T9c)를 같은 응답에서 읽음.
	// 여기서는 도착 여부만 한 줄로 드러냄 (읽지 않는 상태로 두면 흡수가 아니라 적재일 뿐임).
	const payloadCount =
		payloadState.status === "ready"
			? (payloadState.data?.entries || []).length
			: null;

	if (kpis === null && payloadCount === null && readings.length === 0 && errors.length === 0)
		return null;

	// 정보 버킷 공개 — 정상도 장애도 아닌 카드(미수신/미검증/한도)의 분모 귀속을 밝힘.
	const infoHint = kpis && kpis.infoCount > 0 ? `${kpis.infoCount} informational` : "";

	return (
		<section className="arch-health-strip" aria-label="System health">
			{kpis && (
				<>
					<div className="arch-queue-fact" data-health-fact="healthy-parts">
						<span className="fs-micro text-faint">Healthy parts</span>
						<span className="fs-meta text-ink">
							{kpis.okCount}/{kpis.totalCount}
						</span>
						{infoHint && <span className="fs-meta text-dim">{infoHint}</span>}
					</div>
					<div className="arch-queue-fact" data-health-fact="needs-attention">
						<span className="fs-micro text-faint">Needs attention</span>
						<span className="fs-meta text-ink">{kpis.degradedCount}</span>
					</div>
					<div className="arch-queue-fact" data-health-fact="overdue-jobs">
						<span className="fs-micro text-faint">Overdue jobs</span>
						<span className="fs-meta text-ink">{kpis.staleCount}</span>
					</div>
				</>
			)}
			{/* 부품 한 줄 — tone 은 속성으로도 실림. 색만으로 판정을 말하면 색을 못 읽는 조작자와
			    하네스가 같은 문장을 못 읽음(문장은 statusLabel 이 냄). */}
			{readings.map((reading) => (
				<div
					key={reading.id}
					className="arch-queue-fact"
					data-health-fact={reading.id}
					data-health-tone={reading.tone}>
					<span className="fs-micro text-faint">{reading.name}</span>
					<span className="fs-meta text-ink inline-flex items-center gap-1.5">
						<StatusDot status={reading.tone} />
						{reading.statusLabel}
					</span>
				</div>
			))}
			{payloadCount !== null && (
				<div className="arch-queue-fact" data-health-fact="run-payloads">
					<span className="fs-micro text-faint">Run payloads</span>
					<span className="fs-meta font-mono text-ink">{payloadDaemon}</span>
					<span className="fs-meta text-dim">{payloadCount} recent</span>
				</div>
			)}
			{errors.length > 0 && (
				<StripAlertAR
					className="arch-queue-error"
					message="Couldn't load system health"
					detail={errors.join(" · ")}
					onRetry={onRetry}
				/>
			)}
		</section>
	);
}

/**
 * 전역 확장 블록 자리 — 지도 아래 화면-폭 상세. T11(Hook chain) · T12c(Hook failure log) 가 채움.
 * 등록된 블록이 없으면 null 을 냄: 빈 컨테이너가 지도와 표 사이에 여백만 남기지 않게 함.
 * blocks 를 인자로도 받음 — 레지스트리를 건드리지 않고 컨테이너 계약만 재는 자리를 남김.
 * 접힘/펼침은 여기가 관리함 — 블록마다 제 상태를 들면 같은 규율을 항목 수만큼 다시 적게 됨.
 */
function GlobalDetailRegion({ blocks = getGlobalDetailBlocks(), states }) {
	// 한 번에 한 블록 — 화면-폭 상세가 여럿 열리면 지도 아래가 세로로 길어져 비교가 스크롤이 됨
	// (확장 행과 같은 규율).
	const [expandedBlock, setExpandedBlock] = useStateAR(null);

	const toggleBlock = useCallbackAR((id) => {
		setExpandedBlock((current) => (current === id ? null : id));
	}, []);

	if (blocks.length === 0) return null;

	return (
		<section className="arch-global-blocks" aria-label="System detail">
			{blocks.map((block) => {
				const detailId = getGlobalBlockDetailId(block.id);
				const isExpanded = expandedBlock === block.id;

				return (
					<div
						key={block.id}
						className="arch-global-block"
						data-global-block={block.id}
					>
						{/* 진짜 button — 키보드 활성(Enter/Space)과 포커스 순서를 브라우저에서 그대로 받음 */}
						<button
							type="button"
							className="arch-row-toggle"
							aria-expanded={isExpanded}
							aria-controls={detailId}
							onClick={() => toggleBlock(block.id)}>
							<span className="arch-row-caret" aria-hidden="true">
								{isExpanded ? "▾" : "▸"}
							</span>
							{block.title || block.id}
						</button>
						{/* 접힌 블록은 본문을 아예 렌더하지 않음 — 숨긴 채 남기면 접근성 트리에 빈 영역이 남음 */}
						{isExpanded && (
							<div id={detailId} className="arch-global-block-body">
								{block.render(states)}
							</div>
						)}
					</div>
				);
			})}
		</section>
	);
}

/**
 * Hook chain 전역 블록 본문 — 이벤트 → matcher → 훅 (T11). 카드가 내던 요약(이벤트 수 · 훅 수)은
 * "어느 훅이 어느 matcher 에 걸렸는가" 를 대답하지 못하므로 그 관계를 그대로 폄.
 * 경로 · matcher · 명령 문자열은 settings.json 에서 읽어 온 서버 텍스트임. JSX 텍스트 자식으로만
 * 두어 React 가 이스케이프하게 함 — 이 경로에 raw-HTML 진입(dangerouslySetInnerHTML)을 들이면
 * 안 됨 (LLM01). 파일의 유일한 raw-HTML 자리는 mermaid 캔버스이고, 그쪽과 이 값은 만나지 않음.
 */
function HookChainDetail({ state }) {
	const { formatRelativeTime } = window.UI;
	const rows = getHookChainRows(state);

	// 못 읽음과 로딩을 갈라 부름 — 한 문장으로 접으면 조작자가 기다릴지 고칠지 못 정함.
	if (state && state.status === "error")
		return (
			<span className="fs-meta text-dim">
				Couldn't read the hook configuration: {state.error}
			</span>
		);

	if (rows === null)
		return <span className="fs-meta text-dim">Loading the hook chain…</span>;

	if (rows.length === 0)
		return <span className="fs-meta text-dim">This settings file configures no hooks.</span>;

	const sourceMtime = state.data?.source_mtime;

	return (
		<div className="arch-hook-chain">
			{/* 어느 파일에서 읽었는지 — 훅이 안 돈다는 신고의 첫 확인 지점이 이 경로임 */}
			<div className="arch-hook-head fs-meta text-dim">
				<span className="font-mono text-ink">{state.data?.source_path || "—"}</span>
				{sourceMtime && <span>edited {formatRelativeTime(sourceMtime)}</span>}
			</div>
			<ul className="arch-hook-events">
				{rows.map((row) => (
					<li key={row.event} className="arch-hook-event">
						<div className="arch-hook-head">
							<span className="fs-meta font-mono text-ink">{row.event}</span>
							{/* 0 도 사실로 냄 — 이벤트는 있는데 훅이 없다는 것이 조사할 상태임 */}
							<span className="fs-micro text-faint">{row.hookCount} hooks</span>
						</div>
						{row.groups.length > 0 && (
							<ul className="arch-hook-groups">
								{row.groups.map((group) => (
									<li key={group.matcher} className="arch-hook-group">
										<span className="fs-meta font-mono text-dim">{group.matcher}</span>
										<ul className="arch-hook-list">
											{group.hooks.map((hook, index) => (
												<li
													key={`${group.matcher}-${index}`}
													className="arch-hook-head fs-meta text-dim">
													<span className="font-mono text-ink">{hook.command}</span>
													{hook.type && <span className="fs-micro text-faint">{hook.type}</span>}
													{hook.timeout !== null && hook.timeout !== undefined && (
														<span className="fs-micro text-faint">timeout {hook.timeout}s</span>
													)}
												</li>
											))}
										</ul>
									</li>
								))}
							</ul>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * Hook failure log 전역 블록 본문 — 창 안 실패 목록 + 창 무관 최종기록 (T12c).
 * 두 사실을 따로 부름: 목록은 days 창에 매인 값이라 창이 비면 사라지지만, 마지막으로 실패한
 * 시각은 창 밖 MAX 이므로 남음. 빈 창을 '한 번도 실패한 적 없음'으로 읽히게 두면 조작자가
 * 조사할 사건을 조사하지 않게 됨 — 서버가 그 둘을 갈라 주는 이유가 여기임.
 * 최종기록은 응답 필드에서만 읽음: 목록 최댓값으로 유도하면 빈 창에서 값이 사라짐.
 * hook 이름 · 테이블 · error_kind 는 실패 로그에서 온 서버 텍스트임. JSX 텍스트 자식과
 * dateTime/title 속성으로만 두어 React 가 이스케이프하게 함 — 이 경로에 raw-HTML
 * 진입(dangerouslySetInnerHTML)을 들이면 안 됨 (LLM01). 파일의 유일한 raw-HTML 자리는
 * mermaid 캔버스이고, 그쪽과 이 값은 만나지 않음.
 */
function HookFailureDetail({ state }) {
	const { formatRelativeTime, formatKstFull } = window.UI;
	const rows = getHookFailureRows(state);

	// 못 읽음과 로딩을 갈라 부름 — 한 문장으로 접으면 조작자가 기다릴지 고칠지 못 정함.
	if (state && state.status === "error")
		return (
			<span className="fs-meta text-dim">
				Couldn't read the hook failures: {state.error}
			</span>
		);

	if (rows === null)
		return <span className="fs-meta text-dim">Loading the hook failure log…</span>;

	const days = state.data?.days;
	const lastFailure = state.data?.last_failure_ts || null;

	return (
		<div className="arch-hook-fails">
			<div className="arch-hook-head fs-meta text-dim">
				{/* 0 도 사실로 냄 — 창이 비었다는 것 자체가 아래 최종기록과 짝을 이루는 문장임 */}
				<span className="text-ink">
					{rows.length} {rows.length === 1 ? "failure" : "failures"} in the last{" "}
					{days ?? "—"} days
				</span>
				{lastFailure ? (
					<span>
						Last failure{" "}
						<time
							data-hook-fail-last=""
							dateTime={lastFailure}
							title={formatKstFull(lastFailure)}>
							{formatRelativeTime(lastFailure)}
						</time>
					</span>
				) : (
					<span>This log has never held a hook failure.</span>
				)}
			</div>
			{rows.length > 0 && (
				<ul className="arch-hook-fail-list">
					{rows.map((row) => (
						<li
							key={row.key}
							data-hook-fail-row=""
							className="arch-hook-head fs-meta text-dim">
							<time
								className="font-mono"
								dateTime={row.failureTs}
								title={formatKstFull(row.failureTs)}>
								{formatRelativeTime(row.failureTs)}
							</time>
							<span className="font-mono text-ink">{row.hookName}</span>
							<span className="font-mono">{row.targetTable}</span>
							{/* 라벨이 신호이고 색은 보조 — 색만으로 실패 종류를 가르지 않음 */}
							<span className={TONE_TEXT_CLASS[row.kind.tone] || "text-dim"}>
								{row.kind.label}
							</span>
							{row.retryAttempted && (
								<span className="fs-micro text-faint">retried</span>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

// 라이브 상태 표 — 노드 링 점등을 대체함. daemon 1개 = 1행.

function LiveDaemonTable({ state, payloadState, onSelectDaemon }) {
	const { StatusDot, formatRelativeTime } = window.UI;
	// 파일 관례대로 메모 — 범례 토글/드로어 개폐/새로고침 틱마다 daemon 배열을 다시 훑지 않음.
	const rows = useMemoAR(
		() => (state.status === "ready" ? getLiveDaemonRows(state.data?.daemons) : []),
		[state.status, state.data],
	);

	// 한 번에 한 행만 펼침 — 여럿이 열리면 표가 세로로 길어져 실패 비교가 아니라 스크롤이 됨.
	const [expandedDaemon, setExpandedDaemon] = useStateAR(null);

	const toggleRow = useCallbackAR(
		(name) => {
			setExpandedDaemon((current) => (current === name ? null : name));
			// 접을 때도 같은 이름을 올림 — 값이 그대로라 재요청은 없고, 방금 읽은 실패가 남음.
			onSelectDaemon?.(name);
		},
		[onSelectDaemon],
	);

	if (state.status !== "ready") return null;
	if (rows.length === 0) return null;

	return (
		<div className="arch-live-table-wrap">
			<table className="arch-live-table">
				<thead>
					<tr>
						<th scope="col">Job</th>
						<th scope="col">Status</th>
						<th scope="col">Last run</th>
						<th scope="col">Nodes</th>
					</tr>
				</thead>
				<tbody>
					{rows.flatMap((row) => {
						const detailId = getDaemonDetailId(row.name);
						const isExpanded = expandedDaemon === row.name;

						const summaryRow = (
							<tr key={row.name} data-daemon-row={row.name}>
								<th scope="row" className="text-ink font-mono">
									{/* 진짜 button — 키보드 활성(Enter/Space)과 포커스 순서를 브라우저에서 그대로 받음 */}
									<button
										type="button"
										className="arch-row-toggle"
										aria-expanded={isExpanded}
										aria-controls={detailId}
										onClick={() => toggleRow(row.name)}>
										<span className="arch-row-caret" aria-hidden="true">
											{isExpanded ? "▾" : "▸"}
										</span>
										{row.name}
									</button>
								</th>
								<td>
									<span className="inline-flex items-center gap-1.5">
										<StatusDot status={row.tone} />
										{row.statusLabel}
									</span>
								</td>
								<td>{row.lastRunAt ? formatRelativeTime(row.lastRunAt) : "—"}</td>
								<td className="font-mono">{row.nodeIds.join(", ") || "—"}</td>
							</tr>
						);

						// 접힌 행은 상세를 아예 렌더하지 않음 — 숨긴 채 남기면 접근성 트리에 빈 영역이 남음.
						if (!isExpanded) return [summaryRow];

						return [
							summaryRow,
							<tr key={`${row.name}-detail`} data-daemon-detail={row.name}>
								<td id={detailId} colSpan={4} className="arch-run-cell">
									<DaemonRunDetail daemon={row.name} state={payloadState} />
								</td>
							</tr>,
						];
					})}
				</tbody>
			</table>
		</div>
	);
}

/**
 * 확장 영역 본문 — 선택 데몬의 최근 실행을 날짜 + 사유로 나열함 (T9c).
 * 사유 문자열도 못 읽음 사유(state.error)도 서버에서 온 텍스트임. JSX 텍스트 자식으로만 두어 React 가
 * 이스케이프하게 함 — 이 경로에 raw-HTML 진입(dangerouslySetInnerHTML)을 들이면 안 됨 (LLM01).
 * 파일의 유일한 raw-HTML 자리는 mermaid 캔버스이고, 그쪽과 이 값은 만나지 않음.
 */
function DaemonRunDetail({ daemon, state }) {
	const runs = getDaemonRunRows(state, daemon);

	// 못 읽음과 로딩을 갈라 부름 — 한 문장으로 접으면 조작자가 기다릴지 고칠지 못 정함.
	// fold 는 두 경우 모두 null 을 내므로(응답 없음 · 이름 불일치) 상태를 여기서 직접 읽어야 함.
	if (state && state.status === "error")
		return (
			<span className="fs-meta text-dim">
				Couldn't read the recent runs: {state.error}
			</span>
		);

	if (runs === null)
		return (
			<span className="fs-meta text-dim">Loading recent runs for {daemon}…</span>
		);

	if (runs.length === 0)
		return <span className="fs-meta text-dim">No stored runs for {daemon}.</span>;

	return (
		<ul className="arch-run-list">
			{runs.map((run) => (
				<li key={run.key} className="arch-run-entry">
					<span className="fs-meta font-mono text-ink">{run.runDate}</span>
					{run.reasons.length === 0 ? (
						<span className="fs-meta text-dim">
							{RUN_VERDICT_NOTE[run.verdict] || `Verdict: ${run.verdict}`}
						</span>
					) : (
						<ul className="arch-run-reasons">
							{run.reasons.map((reason) => (
								<li key={reason.key} className="fs-meta text-dim">
									{reason.message}
									{/* 한 사이클에 반복된 서명은 횟수까지 밝힘 — 단발 장애와 반복 장애는 다른 사건임 */}
									{reason.count > 1 && (
										<span className="text-faint"> ×{reason.count}</span>
									)}
								</li>
							))}
						</ul>
					)}
				</li>
			))}
		</ul>
	);
}

// Node detail drawer — node 만 처리 (layer/edge 클릭 없음). 오버레이/계약은 DetailSurface 위임.

function DetailModal({
	detail,
	nodeIndex,
	activeDiagram,
	liveDaemonsByNodeId,
	onClose,
}) {
	// detail undefined 시 React state batching edge case 방어.
	if (!detail) return null;

	const nodeId = detail?.payload?.id;
	const info = nodeId ? nodeIndex.get(nodeId) : null;

	let body;
	if (!info)
		body = <EmptyStateAR message="No node matches this label." />;
	else
		body = (
			<NodeDetailBody
				info={info}
				flows={activeDiagram?.flows || []}
				nodeIndex={nodeIndex}
				liveDaemonsByNodeId={liveDaemonsByNodeId}
			/>
		);

	const sub = info?.type ? NODE_TYPE_LABEL[info.type] || info.type : "—";

	const { DetailSurface } = window.UI;

	return (
		<DetailSurface
			open
			onClose={onClose}
			variant="drawer"
			title="Node"
			sub={sub}
			labelledBy="ar-node-detail-title"
			bodyClassName="space-y-3"
		>
			{body}
		</DetailSurface>
	);
}

function NodeDetailBody({ info, flows, nodeIndex, liveDaemonsByNodeId }) {
	const { Pill, formatRelativeTime, daemonStatusLabel, daemonStatusTone } =
		window.UI;
	// node_ids 바인딩 기반 — 라벨/이름 fuzzy 매칭 폐기 (F32). 한 노드에 복수 daemon 바인딩 시 각각 pill (F39).
	const daemons = liveDaemonsByNodeId.get(unscopedNodeIdAR(info.id)) || [];

	const inbound = flows.filter((f) => f.to === info.id);
	const outbound = flows.filter((f) => f.from === info.id);

	return (
		<>
			<FieldBlock label="Name" value={info.label || info.id} />
			<div className="flex flex-wrap items-center gap-1.5">
				{info.type && <Pill>{NODE_TYPE_LABEL[info.type] || info.type}</Pill>}
				{info.layer_label && <Pill>Layer: {info.layer_label}</Pill>}
				{daemons.map((daemon) => (
					<Pill
						key={daemon.daemon_name}
						tone={daemonStatusTone(daemon.effective_status)}>
						{`live: ${daemon.daemon_name} ${daemonStatusLabel(daemon.effective_status)}${daemon.last_run_at ? ` · ${formatRelativeTime(daemon.last_run_at)}` : ""}`}
					</Pill>
				))}
			</div>
			{info.path && <FieldBlock label="File path" value={info.path} mono />}
			{info.description && (
				<FieldBlock label="Description" value={info.description} mono={false} />
			)}
			<FlowSummary
				inbound={inbound}
				outbound={outbound}
				nodeIndex={nodeIndex}
			/>
		</>
	);
}

function FieldBlock({ label, value, mono = false }) {
	return (
		<div>
			<div className="fs-micro font-mono text-faint uppercase tracking-wider mb-1">
				{label}
			</div>
			<div
				className={`fs-body ${mono ? "font-mono text-dim" : "text-ink"} break-all`}
			>
				{value}
			</div>
		</div>
	);
}

function FlowSummary({ inbound, outbound, nodeIndex }) {
	const total = inbound.length + outbound.length;
	if (total === 0)
		return <div className="fs-meta text-faint">No connections</div>;
	return (
		<div>
			<div className="fs-micro font-mono text-faint uppercase tracking-wider mb-1">
				Connections ({total})
			</div>
			<div className="space-y-2">
				{inbound.length > 0 && (
					<FlowList
						title="Incoming"
						items={inbound}
						nodeIndex={nodeIndex}
					/>
				)}
				{outbound.length > 0 && (
					<FlowList
						title="Outgoing"
						items={outbound}
						nodeIndex={nodeIndex}
					/>
				)}
			</div>
		</div>
	);
}

function FlowList({ title, items, nodeIndex }) {
	const { Icon } = window.UI;
	return (
		<div>
			<div className="fs-meta font-mono text-dim mb-0.5">{title}</div>
			<div
				className="fs-meta font-mono text-dim space-y-0.5"
				style={{ maxHeight: 160, overflowY: "auto" }}
			>
				{items.map((f) => {
					const fromLabel = nodeIndex.get(f.from)?.label || f.from;
					const toLabel = nodeIndex.get(f.to)?.label || f.to;
					return (
						<div key={f.id} className="break-all">
							<span style={{ color: EDGE_COLORS[f.edge_type] || "#94a3b8" }}>
								●
							</span>{" "}
							<span className="text-faint">[{f.edge_type}]</span> {fromLabel}{" "}
							<Icon name="arrow-right" size={11} /> {toLabel}
							{f.label && <span className="text-faint"> · {f.label}</span>}
						</div>
					);
				})}
			</div>
		</div>
	);
}

// Shared chrome (AR-suffixed: 다른 screen 의 helper 와 충돌 방지)

function EmptyStateAR({ message }) {
	return (
		<div className="placeholder" style={{ padding: 20 }}>
			{message}
		</div>
	);
}

function ErrorBannerAR({ title, detail, onRetry }) {
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

// tone → 글자색 클래스. 리터럴 표인 이유: 조립한 클래스명은 클래스 스캐너가 보지 못함.
// 배너 아이콘과 실패 로그의 error_kind 라벨이 같은 표를 씀 — 둘째 표를 들이면 같은 tone 이
// 화면 자리마다 다른 색으로 갈라짐.
const TONE_TEXT_CLASS = {
	warn: "text-warn",
	crit: "text-crit",
	info: "text-info",
};

/**
 * 경보 배너 셸 — 세 배너(거버넌스 warn · 이중기록 crit · 드리프트 info)가 tone·아이콘·문구·배지만 달리한 같은 상자라서 한 몸으로 둠.
 * tone 은 CSS 변수명으로 그대로 들어가므로, 새 tone 은 같은 이름의 변수가 tokens.css 에 있어야 함.
 */
function AlertBannerAR({ tone, icon, title, note, badges }) {
	const { Icon, Badge } = window.UI;
	const items = badges || [];
	return (
		<div
			role="alert"
			className="rounded-md border p-3 flex items-start gap-3"
			style={{
				background: `rgb(var(--${tone}) / 0.08)`,
				borderColor: `rgb(var(--${tone}) / 0.4)`,
			}}
		>
			<Icon
				name={icon}
				size={16}
				className={`${TONE_TEXT_CLASS[tone]} mt-0.5`}
			/>
			<div className="flex-1 min-w-0">
				<div className="fs-body font-medium text-ink">{title}</div>
				<div className="fs-meta text-dim mt-1">{note}</div>
				{items.length > 0 && (
					<div className="flex flex-wrap gap-1.5 mt-2">
						{items.map((it) => (
							<Badge key={it.key} role="status" tone={tone} glyph={false}>
								{it.label}
							</Badge>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * 거버넌스 멤버십 배너 — 매트릭스가 선언한 scope/rule 문서가 사라졌을 때 그 이름을 부른다.
 * 총계 배지는 무엇이 없어졌는지 말하지 못하므로 이름 목록이 곧 신호다.
 */
function MembershipBannerAR({ absent, sourceMissing }) {
	const names = (absent || []).map((name) => ({ key: name, label: name }));
	return (
		<AlertBannerAR
			tone="warn"
			icon="warn"
			title={
				sourceMissing
					? "Governance membership unverifiable — compliance matrix unreadable"
					: "Governance document missing"
			}
			note="The compliance matrix names these files; they are not on disk."
			badges={names}
		/>
	);
}

/**
 * 이중기록 중단 배너 — role=alert 재사용 · crit-tone(런타임 결함)으로 드리프트 info-tone 과 구별.
 * 상시 칩을 대신함 — 정상이면 DOM 에 없고, 끊긴 writer 가 있을 때만 그 이름을 부름.
 */
function DualWriteBannerAR({ writers }) {
	const names = (writers || []).map((w) => ({
		key: w.writer_name,
		label: w.writer_name,
	}));
	return (
		<AlertBannerAR
			tone="crit"
			icon="warn"
			title="Dual-write stopped — these writers are not recording"
			/* 스캔 실패도 같은 false 로 떨어짐(live-overlay 의 fail-loud 기본값) — 두 원인을 함께 적음. */
			note="Marker scan found no dual-write block, or could not read the file."
			badges={names}
		/>
	);
}

// 설계도 카운트 드리프트 배너 — role=alert 재사용 · info-tone(구조 정합성 nudge)으로 daemon-down crit/warn(런타임 헬스)과 시각 분리.
// diffs = [{ key, claimed, actual }] — mismatch 항목별 주장↔실측 노출.
function DriftBannerAR({ diffs }) {
	const items = (diffs || []).map((d) => ({
		key: d.key,
		label: `${d.key} ${d.claimed}→${d.actual}`,
	}));
	return (
		<AlertBannerAR
			tone="info"
			icon="git"
			title="Map out of date — live counts don't match"
			note={
				<>
					Run{" "}
					<span className="font-mono">/glass-atrium-ops-verify-arch</span> for a deeper check.
				</>
			}
			badges={items}
		/>
	);
}

function ChartSkeletonAR() {
	return (
		<div
			aria-busy="true"
			style={{
				width: "100%",
				height: "100%",
				minHeight: 240,
				borderRadius: 8,
				background: "rgb(var(--sunken))",
				opacity: 0.7,
				animation: "skelPulseAR 1.4s ease-in-out infinite",
			}}
		/>
	);
}

function SkelAR({ w = "100%", h = 14, style }) {
	return (
		<span
			aria-hidden="true"
			style={{
				display: "inline-block",
				width: w,
				height: h,
				background: "rgb(var(--sunken))",
				borderRadius: 4,
				opacity: 0.7,
				animation: "skelPulseAR 1.4s ease-in-out infinite",
				...style,
			}}
		/>
	);
}

// Pure helpers

async function fetchJsonAR(url, signal) {
	const res = await fetch(url, {
		signal,
		headers: { Accept: "application/json" },
	});
	if (!res.ok) {
		let body = "";
		try {
			body = await res.text();
		} catch (_e) {
			/* body parse 실패는 무시 */
		}
		throw new Error(
			`HTTP ${res.status} ${res.statusText}${body ? " — " + body.slice(0, 120) : ""}`,
		);
	}
	return res.json();
}

/**
 * pending 수 — 두 배열의 합집합을 id 로 중복 제거함.
 * proposals 는 limit 로 잘리고 actionable_proposals 는 safety tier 만 담아,
 * 한쪽만으로는 pending 을 과소 계수함.
 */
function getPendingCountAR(data) {
	const rows = [
		...(Array.isArray(data?.proposals) ? data.proposals : []),
		...(Array.isArray(data?.actionable_proposals) ? data.actionable_proposals : []),
	];
	const ids = new Set();
	for (const row of rows) {
		if (row && row.status === "pending") ids.add(row.id);
	}
	return ids.size;
}

/**
 * allSettled 결과 1건을 경보 문구로 — 거부만 문구가 되고 이행은 null 임.
 * 중단(AbortError)은 실패가 아니라 화면 교체이므로 걸러냄.
 */
function getStoreErrorAR(label, settled) {
	if (settled.status !== "rejected") return null;

	const err = settled.reason;
	if (err && err.name === "AbortError") return null;

	return `${label}: ${err && err.message ? err.message : String(err)}`;
}

// 최다 빈도 패턴 1건 — 응답은 last_updated DESC 정렬이라 빈도 최댓값은 직접 훑어야 나옴.
function getTopSignalAR(data) {
	const rows = Array.isArray(data?.patterns) ? data.patterns : [];
	let top = null;
	for (const row of rows) {
		if (!row || !row.pattern_signature) continue;
		if (!top || Number(row.frequency || 0) > Number(top.frequency || 0)) top = row;
	}
	if (!top) return null;

	return {
		signature: top.pattern_signature,
		frequency: Number(top.frequency || 0),
		lastUpdated: top.last_updated || null,
	};
}

function handleErrorAR(err, setter) {
	if (err && err.name === "AbortError") return;
	setter({
		status: "error",
		data: null,
		error: err && err.message ? err.message : String(err),
	});
}

// 초기 줌 절대 스케일 — 인자만으로 계산(DOM·instance 미참조). 하한은 폭-fit 으로 내려 클램프되지 않음.
function getLegibleFitScaleAR(paneW, paneH, graphW, graphH) {
	if (!(paneW > 0 && paneH > 0 && graphW > 0 && graphH > 0)) return LEGIBLE_FIT_FLOOR;
	const containFit = Math.min(paneW / graphW, paneH / graphH);
	return Math.max(Math.min(containFit, 1), LEGIBLE_FIT_FLOOR);
}

// svg-pan-zoom 초기 줌을 절대 스케일로 직접 적용 (라이브러리 fit:true 는 하한을 무시함).
// 단계: resize() pane 갱신 → targetAbs = getLegibleFitScaleAR → 상대 zoom(R) → pan(viewBox 원점 상쇄 + 정렬).
function applyLegibleFitAR(instance, root) {
	// 직전 렌더의 short-graph clamp 를 측정 전 제거 → getSizes() 가 실제 전체 pane 측정 (early-return 가드보다 위 배치 필수).
	clearCanvasSizingAR(root);
	if (!instance || typeof instance.getSizes !== "function") return;
	// pane 측정 dims 강제 갱신 (init 시점 stale 폭 방어).
	try {
		instance.resize();
	} catch (_e) {
		/* resize 실패 시 stale dims 로라도 진행 */
	}

	const s = instance.getSizes();
	const realW = s.viewBox?.width || 0;
	const realH = s.viewBox?.height || 0;
	if (realW <= 0 || realH <= 0 || s.width <= 0 || s.height <= 0) return;

	const targetAbs = getLegibleFitScaleAR(s.width, s.height, realW, realH);

	// 공개 zoom 은 상대(=절대/originalState) · init 직후 현재 절대행렬 = viewport CTM .a → relative = targetAbs / 현재절대.
	const curAbs = readViewportScaleAR(root) || s.realZoom || 1;
	const relative = curAbs > 0 ? targetAbs / curAbs : targetAbs;

	instance.zoom(relative);

	// 캔버스는 flex:1 로 pane 전체 높이 유지 (축소 안 함) → 짧은 그래프는 pan 으로 세로 가운데 정렬.
	const fittedGraphH = realH * targetAbs;
	const fittedGraphW = realW * targetAbs;

	// pan({x,y}) 는 viewport CTM 의 e/f(화면픽셀 평행이동) 직접 설정 · 콘텐츠 viewBox.x/y 시작 → 좌상단(0,0) 정렬에 -origin*scale 필요 (fit/center:false 라 라이브러리 미보정).
	const baseX = -(s.viewBox.x || 0) * targetAbs;
	const baseY = -(s.viewBox.y || 0) * targetAbs;
	// 가로·세로 동일 slack 패턴 — 그래프가 pane 보다 좁으면 가운데, 넓으면 0(좌상단 시작). clamp 로 큰(=높은/넓은) 그래프는 slack=0 → 좌상단 정렬 (회귀 없음).
	const slackX = Math.max(0, (s.width - fittedGraphW) / 2);
	const slackY = Math.max(0, (s.height - fittedGraphH) / 2);
	instance.pan({ x: baseX + slackX, y: baseY + slackY });
}

// .svg-pan-zoom_viewport 의 실제 변환행렬 스케일(.a) = 사용자가 측정하는 절대 스케일.
function readViewportScaleAR(root) {
	if (!root) return 0;
	const vp = root.querySelector(".svg-pan-zoom_viewport");
	if (!vp || typeof vp.getCTM !== "function") return 0;
	const m = vp.getCTM();
	return m ? m.a : 0;
}

// 캔버스 인라인 sizing (short-graph clamp) 제거 → CSS 기본 flex-fill 복원 (이전 그래프 height/flex 잔존이 다음 측정 오염 차단).
// root 는 컨테이너 또는 캔버스 자신 어디든 허용.
function clearCanvasSizingAR(root) {
	if (!root) return;
	const canvas = root.classList?.contains("arch-mermaid-canvas")
		? root
		: root.closest?.(".arch-mermaid-canvas");
	if (!canvas) return;
	canvas.style.height = "";
	canvas.style.flex = "";
}

// 서버 daemon 목록 → unscoped mermaid node id 별 daemon 배열 (F39).
//   한 노드에 복수 daemon 바인딩 시(cron) last-writer-wins 로 하나가 유실되지 않도록 id 당 목록 축적.
function buildLiveDaemonsByNodeId(daemons) {
	const m = new Map();
	for (const d of daemons || []) {
		for (const nid of d.node_ids || []) {
			const list = m.get(nid);
			if (list) list.push(d);
			else m.set(nid, [d]);
		}
	}
	return m;
}

// 라이브 상태 표의 행 목록 — daemon 1개 = 1행. 표현 계층과 무관한 순수 파생.
function getLiveDaemonRows(daemons) {
	return (daemons || []).map((d) => {
		// 서버가 임계를 적용해 낸 판정만 읽음 — 화면이 다시 재면 같은 입력에 답이 둘이 됨.
		const verdict = d?.effective_status;
		return {
			name: d?.daemon_name || "—",
			tone: window.UI.daemonStatusTone(verdict),
			statusLabel: window.UI.daemonStatusLabel(verdict),
			nodeIds: Array.isArray(d?.node_ids) ? d.node_ids : [],
			lastRunAt: d?.last_run_at || null,
		};
	});
}

// 한 노드에 걸린 daemon 목록 → 링 클래스. 결함이 없으면 null (클래스 자체가 안 붙음).
//   cron 노드처럼 복수 바인딩인 자리는 최악 severity 하나만 링 근거로 삼음 — 두 겹을 칠할 수 없음.
function getFaultRingClassAR(daemons) {
	let hasWarn = false;
	for (const d of daemons || []) {
		const tone = window.UI.daemonStatusTone(d?.effective_status);
		if (tone === "crit") return FAULT_RING_CLASS.crit;
		if (tone === "warn") hasWarn = true;
	}
	return hasWarn ? FAULT_RING_CLASS.warn : null;
}

// 스키마 node id (`${diagramId}.${mermaidId}`) → unscoped mermaid id (마지막 '.' 뒤 segment).
function unscopedNodeIdAR(nodeId) {
	if (typeof nodeId !== "string") return "";
	const idx = nodeId.lastIndexOf(".");
	return idx >= 0 ? nodeId.slice(idx + 1) : nodeId;
}

// 라벨 정규화 — mermaid SVG 텍스트와 backend node label 간 fuzzy 매칭용.
//   공백/줄바꿈/탭 → 단일 공백 1개로, 양끝 trim, lowercase.
function normalizeLabelAR(s) {
	if (typeof s !== "string") return "";
	return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// mermaid SVG 노드 element 에서 라벨 텍스트 추출.
//   mermaid 11 은 노드 안에 .nodeLabel / foreignObject / text 등 다양한 형식으로 라벨을 넣음.
//   가장 일반적인 셀렉터를 우선 적용 → 없으면 g.node 의 textContent fallback.
function extractMermaidNodeLabelAR(nodeEl) {
	if (!nodeEl) return "";
	// 1) htmlLabels:true 인 경우 — foreignObject > div.nodeLabel
	const htmlLabel = nodeEl.querySelector("foreignObject .nodeLabel");
	if (htmlLabel && htmlLabel.textContent) return htmlLabel.textContent;
	// 2) htmlLabels:false 인 경우 — text.nodeLabel
	const svgLabel = nodeEl.querySelector("text.nodeLabel");
	if (svgLabel && svgLabel.textContent) return svgLabel.textContent;
	// 3) fallback — 노드 전체 textContent (label 외에 svg 노이즈가 섞일 수 있음)
	return (nodeEl.textContent || "").trim();
}

window.ScreenArchitecture = ScreenArchitecture;
window.ARCH_SELECTORS = ARCH_SELECTORS;
