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

// map-only label size — the shared 14px renders under 12px once the wide LR graph is fitted to a 1024 pane
const MAP_LABEL_FONT_PX = 30;

// word-level label wrap — narrower nodes are what let the larger labels fit; the flow itself stays left to right
const MAP_LABEL_WRAP_PX = 90;

// smallest rendered label (the 12px meta step) — the fit never shrinks the map below it
const MIN_RENDERED_LABEL_PX = 12;

// scale floor derived from the two above, so the floor is a rendered size rather than a bare ratio
const LEGIBLE_FIT_FLOOR = MIN_RENDERED_LABEL_PX / MAP_LABEL_FONT_PX;

// map-only override at render time — layout engine, spacing and theme stay in the shared mermaid-config.js
const MAP_LABEL_DIRECTIVE =
	`%%{init: {"themeVariables": {"fontSize": "${MAP_LABEL_FONT_PX}px"}, ` +
	`"flowchart": {"wrappingWidth": ${MAP_LABEL_WRAP_PX}}}}%%\n`;

// svg-pan-zoom 라이브러리 minZoom — LEGIBLE_FIT_FLOOR 보다 낮아야 zoom() 이 minZoom 으로 되끌어올려지지 않음.
const PAN_ZOOM_MIN = 0.2;

// zone inset around its members (SVG user units) — the gap ELK itself leaves under the last member
const ZONE_PAD = 12;

// 존 제목 띠 높이(SVG 사용자 단위) — 렌더 후 조정이라 지시자의 diagramPadding 여유 안이어야 viewBox 를 넘지 않음.
const ZONE_TITLE_BAND = 8;

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
// 캔버스 element id — 링 규칙의 특이도를 mermaid 의 classDef 규칙 위로 올리는 유일한 용도.
// mermaid 가 `#<renderId> .security>*{…!important}` 꼴로 찍으므로(특이도 1,1,0) 클래스만으로는
// 무엇을 적어도 못 이김 — 여기 id 하나가 그 한 칸을 벌어 줌. 하네스 셀렉터는 클래스 그대로임.
const ARCH_CANVAS_ID = "arch-map-canvas";
const ARCH_SELECTORS = {
	canvas: ".arch-mermaid-canvas",
	tabControl: '[role="tab"], .arch-tab-btn',
	desc: `#${ARCH_DESC_ID}`,
};

// 판정 tone → 캔버스 노드 링 클래스.
// info(no data)만 항목이 없음 — 판정을 못 받은 노드는 정상으로도 결함으로도 꾸미지 않음.
// 링을 켜는 근거는 데몬 판정 ∪ 부품 판정.
const LIVE_RING_CLASS = {
	ok: "arch-node-live-ok",
	warn: "arch-node-live-warn",
	crit: "arch-node-live-crit",
};
const LIVE_RING_CLASSES = Object.values(LIVE_RING_CLASS);

// 판정 tone → 존 상자 링 클래스. 노드 쪽과 접두사를 가른 이유는 계수임 — `arch-node-live-` 를
// 세는 다리가 여럿이라(render-structure 의 접두사 다리) 존 링이 그 총계에 섞이면 노드 계약이 흐려짐.
const ZONE_RING_CLASS = {
	ok: "arch-zone-live-ok",
	warn: "arch-zone-live-warn",
	crit: "arch-zone-live-crit",
};
const ZONE_RING_CLASSES = Object.values(ZONE_RING_CLASS);

const NODE_UNVERIFIED_CLASS = "arch-node-unverified";
const ZONE_UNVERIFIED_CLASS = "arch-zone-unverified";

// 모서리 글리프 — 링 색만으로 tone 을 내면 색각 이상에서 판정이 통째로 사라짐.
const RING_GLYPH_CLASS = "arch-ring-glyph";
const RING_GLYPH_MARK = { warn: "!", crit: "!!" };

// 링을 그리는 사각형의 클래스 — 상태용과 포커스용 둘. 클래스가 켜고 끄고, 이 사각형이 그림.
const RING_STATE_CLASS = "arch-ring-state";
const RING_FOCUS_CLASS = "arch-ring-focus";
// one health vocabulary for node accessible names and the caption's ring key.
const HEALTH_WORD_AR = { ok: "ok", info: "not verified", warn: "needs attention", crit: "critical" };
const UNVERIFIED_WORD_AR = "not verified";
// border colours copy the drawn map's classDef strokes (diagrams-source.ts) — a unit test holds the pair together
const MAP_BORDER_KEY_AR = [
	{ key: "focal", color: "#60a5fa", label: "Orchestrator" },
	{ key: "security", color: "#a78bfa80", label: "Safety checks" },
];
// a group whose title only repeats its single box's label — the title is hidden, the box stays
const ZONE_TITLE_REDUNDANT_CLASS = "arch-zone-title-redundant";

// 링 반경 가족 — 도형 모서리(스타일시트의 r=8)에 링 간격을 더해야 동심으로 읽힘.
// 두 값을 여기 두고 rx 를 표현 속성으로 찍음: 스타일시트의 `rx: 8px` 가 심은 사각형을 되누르지
// 않도록 그쪽 선택자에서 이 클래스를 뺐고, 그래서 반경의 SoT 가 여기 하나임.
const NODE_CORNER_RADIUS = 8;
const RING_GAP = 3;
// focus ring one band outside the health ring's stroke → health ring keeps its colour, width and place.
const FOCUS_RING_GAP = RING_GAP + 5;
const RING_GAP_BY_CLASS = { [RING_FOCUS_CLASS]: FOCUS_RING_GAP };

// 한 노드에 여러 판정이 겹칠 때 남길 하나 — 테두리는 한 겹뿐이라 최악이 이김.
// cron 처럼 재시작 데몬 둘이 같은 노드를 짚는 자리에서 한쪽 결함이 다른 쪽 정상에 덮이지 않게 함.
// info ('No data') outranks ok — a part with no data must not read as all-clear under an ok neighbour.
const RING_TONE_RANK = { ok: 1, info: 2, warn: 3, crit: 4 };

// ── health 응답 흡수 (ADR-B1 R2) ────────────────────────────────────────────
// health.jsx 가 읽던 다섯 응답을 맵이 그대로 읽음 — 서버 계약 무변경, 요청 자리만 옮김.
// 카드/KPI 모델(window.HealthModel)은 index.html 이 화면과 무관하게 싣고 있어
// health 화면이 사라져도 고아가 되지 않음.

// error-copy source names — the banner, the region card and the lane row name one outage alike
const DIAGRAM_SOURCE_AR = "the system map";
const LIVE_SOURCE_AR = "the live overlay";

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

// 행 확장 본문 — 부품 명부의 kind 중 펼칠 내용이 있는 것만 등록함. 없는 kind(pg · browser)는
// 여기 없으므로 확장 컨트롤도 서지 않음: 빈 영역을 여는 버튼은 읽을 것이 있다고 거짓말함.
const HEALTH_ROW_DETAILS = {
	daemon: (row, states) => (
		<DaemonRunDetail daemon={row.daemonName} state={states.payloadState} />
	),
	// 구성과 실패 이력이 한 확장 영역에 같이 옴 — "무엇이 걸렸나" 와 "무엇이 실패했나" 는
	// 훅 신고 하나를 가르는 두 반쪽이라 떨어뜨려 두면 조작자가 화면 두 곳을 오가며 맞춰야 함.
	hook: (_row, states) => (
		<>
			<HookChainDetail state={states.hookState} />
			<HookFailureDetail state={states.hookFailState} />
		</>
	),
};

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
	const {
		PageHeader,
		TypeScaleStyle,
		FreshnessStamp,
		RefreshButton,
		PageErrorBanner,
		RegionUnavailable,
		INITIAL_REGION_STATE,
		putRegionRequest,
		putRegionData,
		putRegionFailure,
		getSharedFailure,
		getRegionSummary,
	} = window.UI;

	const [diagState, setDiagState] = useStateAR(INITIAL_REGION_STATE);
	const [liveState, setLiveState] = useStateAR(INITIAL_REGION_STATE);

	// health 응답 5종 — 각각 독립적으로 실패 가능. 한 응답이 죽어도 나머지 사실은 그대로 보임.
	const [daemonHealthState, setDaemonHealthState] = useStateAR(INITIAL_REGION_STATE);
	const [hookState, setHookState] = useStateAR(INITIAL_REGION_STATE);
	const [pgState, setPgState] = useStateAR(INITIAL_REGION_STATE);
	const [payloadState, setPayloadState] = useStateAR(INITIAL_REGION_STATE);
	const [hookFailState, setHookFailState] = useStateAR(INITIAL_REGION_STATE);

	// 페이로드 드릴다운 대상 — 확장 행이 고름 (T9c). 접어도 되돌리지 않음: 되돌리면 다섯 응답이
	// 한 번 더 나가고 방금 읽은 실패가 표에서도 지워짐.
	const [payloadDaemon, setPayloadDaemon] = useStateAR(MAP_PAYLOAD_DAEMON);

	const [refreshTick, setRefreshTick] = useStateAR(0);

	// health 전용 틱 — 60s 폴링이 설계도/live/큐 재요청까지 끌고 가지 않게 분리함.
	const [healthTick, setHealthTick] = useStateAR(0);

	// health 읽은 시각 — 머리글 넷 중 가장 늦게 도착한 응답의 시각. 판정 옆에 서는 유일한 신선도 사실임.
	const [healthAsOf, setHealthAsOf] = useStateAR(null);

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

		setDiagState((s) => putRegionRequest(s, refreshTick, ctrl));

		fetchJsonAR("/api/architecture/diagrams", ctrl.signal)
			.then((data) => setDiagState((s) => putRegionData(s, ctrl, data)))
			.catch((err) => setDiagState((s) => putRegionFailure(s, ctrl, err)));

		return () => ctrl.abort();
	}, [refreshTick]);

	// /api/architecture/live — refreshTick 당 1회 fetch. 데이터가 서비스 부팅 간 준정적이라 폴링 불요 (수동 Refresh 로 갱신).
	useEffectAR(() => {
		const ctrl = new AbortController();
		liveAbortRef.current?.abort();
		liveAbortRef.current = ctrl;

		setLiveState((s) => putRegionRequest(s, refreshTick, ctrl));

		fetchJsonAR("/api/architecture/live", ctrl.signal)
			.then((data) => setLiveState((s) => putRegionData(s, ctrl, data)))
			.catch((err) => setLiveState((s) => putRegionFailure(s, ctrl, err)));

		return () => ctrl.abort();
	}, [refreshTick]);

	// 머리글이 서 있는 health 응답 4종 — 병렬 발화. 수동 Refresh(refreshTick)와 60s 폴링(healthTick)
	// 에서만 다시 나감. 드릴다운(payloadDaemon)은 일부러 deps 에 없음: 행 하나를 펼쳤다고 이 넷이
	// 다시 나가면 왕복 동안 표의 PG·브라우저 판정이 빈 칸으로 떨어져 방금 읽은 실패를 조작자가
	// 다시 못 봄. 세터 순서는 아래 URL 순서와 짝임.
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
			setter((s) => putRegionRequest(s, url, ctrl));
			fetchJsonAR(url, ctrl.signal)
				.then((data) => {
					if (ctrl.signal.aborted) return;
					setter((s) => putRegionData(s, ctrl, data));
					// a failed read is no reading — the stamp keeps the last one that answered.
					setHealthAsOf(new Date().toISOString());
				})
				.catch((err) => setter((s) => putRegionFailure(s, ctrl, err)));
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

		// another daemon's runs never stand in for this one's while its answer is on the way
		setPayloadState((s) =>
			putRegionRequest(s.key === payloadDaemon ? s : INITIAL_REGION_STATE, payloadDaemon, ctrl),
		);
		fetchJsonAR(url, ctrl.signal)
			.then((data) => setPayloadState((s) => putRegionData(s, ctrl, data)))
			.catch((err) => setPayloadState((s) => putRegionFailure(s, ctrl, err)));

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

	// 링 근거원 — 데몬 판정 ∪ 부품 판정.
	// 데몬은 /live 의 node_ids 로, 부품은 같은 응답의 part_bindings 로 노드를 찾음.
	// 판정 자체는 부품 쪽만 health 응답에서 옴.
	// 두 원천을 한 Map 으로 접는 이유 — cron 처럼 양쪽이 같은 노드를 짚는 자리가 있고 테두리는 한 겹뿐임.
	// health 응답 넷이 deps 에 있어야 폴링 한 틱이 새 Map 이 됨.
	// 캔버스 효과는 이 참조가 바뀔 때만 다시 칠함 — 빼면 첫 렌더만 맞고 이후 조용히 낡음.
	const ringToneByNodeId = useMemoAR(
		() =>
			buildRingToneByNodeId(liveDaemonsByNodeId, liveState.data?.part_bindings, {
				daemonState: daemonHealthState,
				pgState,
				hookState,
				hookFailState,
			}),
		[
			liveDaemonsByNodeId,
			liveState.data,
			daemonHealthState,
			pgState,
			hookState,
			hookFailState,
		],
	);

	// 존 대표 계획 — 헬스 노드를 하나만 담은 존의 목록. 소스의 subgraph 멤버십과 part_bindings 로만 짜임.
	// 판정 자체는 안 들어옴(폴링마다 바뀌는 값) — 여기 들어오면 존과 노드 사이에서 링이 깜빡임.
	const zoneRingPlan = useMemoAR(
		() =>
			buildZoneRingPlanAR(
				activeDiagram?.mermaid_source,
				liveState.data?.part_bindings,
			),
		[activeDiagram, liveState.data],
	);

	const headlineHealthStates = {
		daemonState: daemonHealthState,
		pgState,
		hookState,
		hookFailState,
	};

	// 부품 행 — 표를 걷어낸 뒤로 상세 패널과 노드 클릭이 함께 읽으므로 화면 높이에서 한 번만 셈.
	// 판정(tone·문장)은 health 카드 모델이, 노드 목록은 /live 의 part_bindings 가 냄 (ADR-5).
	const healthPartRows = useMemoAR(
		() =>
			getHealthPartRows(
				headlineHealthStates,
				liveState.data?.part_bindings,
			),
		[daemonHealthState, pgState, hookState, hookFailState, liveState.data],
	);

	// 끊긴 응답을 이름으로 부름 — 빈 판정 칸만으로는 '아직 안 옴' 과 '못 읽음' 이 같은 문장임.
	// 표 안에 서 있던 경보인데 표가 사라졌으므로 페이지로 올림: 노드를 눌러야 보이는 자리에 두면
	// 헬스를 통째로 못 읽은 사실이 클릭 뒤에 숨음 — 그건 누르기 전에 알아야 하는 사실임.
	const healthStoreErrors = getHealthStoreErrorsAR(headlineHealthStates);

	// 판정을 못 받은 부품의 노드 — 링 tone 표와 반대 방향의 사실임. 그쪽은 판정이 온 노드만
	// 담으므로 '아직 안 옴' 과 '정상' 이 같은 빈칸으로 읽힘. 점선 링이 그 둘을 가름.
	const unverifiedNodeIds = useMemoAR(
		() =>
			buildUnverifiedNodeIds(liveState.data?.part_bindings, headlineHealthStates),
		[liveState.data, daemonHealthState, pgState, hookState, hookFailState],
	);

	// caption population per node — two parts can share one node (cron), so one glyph may stand for several.
	const attentionCountByNodeId = useMemoAR(
		() => buildAttentionCountByNodeIdAR(healthPartRows),
		[healthPartRows],
	);

	// 머리글 넷이 아직 오는 중 — 캔버스가 판정을 다 실은 척하지 않도록 busy 로 냄.
	// 모집단은 위 표 하나임 — 여기서 목록을 다시 적으면 저장소가 하나 늘 때 한쪽만 조용히 빠짐.
	const healthRegions = Object.values(headlineHealthStates);
	const healthPending = healthRegions.some((state) => state.status === "loading");

	// 머리글 문장 — 화면의 단 하나뿐인 harness health 수치. 부품 행이 곧 모집단임.
	const healthCaption = getHealthCaptionAR(
		healthPartRows,
		healthPending,
		healthStoreErrors.length,
	);

	const handleSelectNode = useCallbackAR(
		(nodeId) => {
			if (!nodeId) return;
			setDetail({
				kind: "node",
				payload: { id: nodeId },
				diagramId: CANONICAL_DIAGRAM_ID,
			});
			// 이 노드의 첫 데몬 부품으로 드릴다운을 옮김 — 패널이 열리는 순간 실행 목록이 차 있어야
			// 하고, 응답은 한 번에 한 데몬 것임. 세터는 바인딩이 있으면 언제나 부르되 함수형으로
			// 부름: 같은 이름이 돌아오면 React 가 동일값 bail-out 으로 리렌더를 접어 요청이 다시
			// 나가지 않음. 함수형을 벗기면 그 bail-out 이 사라져 왕복 동안 실행 목록이 비워짐.
			const unscoped = unscopedNodeIdAR(nodeId);
			const bound = healthPartRows.find(
				(row) => row.daemonName && row.nodeIds.includes(unscoped),
			);
			if (bound) setPayloadDaemon((current) => bound.daemonName || current);
		},
		[healthPartRows],
	);

	const closeDetail = useCallbackAR(() => setDetail(null), []);

	// 이중기록이 끊긴 writer — 상시 칩을 대신하는 조건부 경보의 유일한 근거.
	//   live 응답 ready 시점에만 신뢰. 빈 배열이면 배너가 DOM 에 없음.
	const offWriters =
		liveState.status === "ready"
			? (liveState.data?.writers || []).filter((w) => !w.dual_write_active)
			: [];

	// 거버넌스 멤버십 — 컴플라이언스 매트릭스가 이름 댄 문서의 부재 목록(총계 아님).
	const governance =
		liveState.status === "ready" ? liveState.data?.governance : null;

	// 경보 레인의 행 — 네 사실을 심각도 순으로 한 줄씩. 비면 레인이 DOM 에 없음.
	// one outage behind every failed read → one banner and one Retry instead of a card per region
	const sharedFailure = getSharedFailure([
		{ source: DIAGRAM_SOURCE_AR, error: getRegionErrorAR(diagState) },
		{ source: LIVE_SOURCE_AR, error: getRegionErrorAR(liveState) },
		...Object.keys(HEALTH_STORE_LABELS_AR).map((key) => ({
			source: HEALTH_STORE_LABELS_AR[key],
			error: getRegionErrorAR(headlineHealthStates[key]),
		})),
	]);

	const alarmRows = getAlarmRows({
		offWriters,
		healthStoreErrors,
		liveState,
		governance,
	}).filter((row) => !(sharedFailure && row.retry));

	const pageRegions = [diagState, liveState, ...healthRegions];
	const isRefreshBusy = getRegionSummary(pageRegions).isBusy;

	return (
		<div className="h-full flex flex-col min-h-0">
			<TypeScaleStyle />
			<style>
				{// arch-page: h-full flex 컨텍스트 안에서 부모 100% 차지 (viewport fit).
					".arch-page { display: flex; flex-direction: column; height: 100%; min-height: 0; flex: 1; gap: 8px; } " +
					// 다이어그램 본체 = 단일 컬럼, 가용 폭 100% 회수. 부수 패널은 가로 스트립/접이식으로 외부 배치.
					".arch-main { display: flex; flex-direction: column; min-height: 0; flex: 1; } " +
					".arch-col-card { display: flex; flex-direction: column; min-height: 0; flex: 1; } " +
					// max-height 를 여기서 풂 — styles/base.css 의 `.card-body { max-height: 70vh }` 는 무한히 긴
					// 페이지를 막는 공통 규칙인데, 이 카드는 flex 로 이미 제 높이가 정해져 있어 그 상한이
					// 죽은 여백으로만 남았음(실측 800px 뷰포트에서 카드 663.5 중 body 560 — 아래 103 이 빔).
					".arch-col-card .card-body { flex: 1; min-height: 0; max-height: none; overflow: hidden; display: flex; flex-direction: column; } " +
					// 훅 구성 — 이벤트 > matcher > 훅 3단 들여쓰기. 목록 표식 없이 들여쓰기만으로 계층을 냄.
					".arch-hook-events, .arch-hook-groups, .arch-hook-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; } " +
					".arch-hook-groups, .arch-hook-list { padding-left: 14px; } " +
					".arch-hook-event, .arch-hook-group { display: flex; flex-direction: column; gap: 2px; min-width: 0; } " +
					".arch-hook-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; } " +
					// 경보 레인 — 지도 위에 서는 단 하나의 상자. 행이 없으면 레인도 없음(빈 상태 없음).
					".arch-alarm-lane { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; } " +
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
					// 심은 링 사각형은 제 반경(getRingGeometryAR)을 표현 속성으로 가지므로 여기서 뺌 — CSS 기하
					// 속성이 표현 속성을 이기니, 안 빼면 링이 8 로 되눌려 도형과 동심이 아니게 됨.
					".arch-mermaid-canvas svg :is(.node, .cluster) rect:not(.arch-ring) { rx: 8px; ry: 8px; } " +
					// pan-drag 중 SVG 텍스트 select 차단 (클릭/줌/팬 보존).
					".arch-mermaid-canvas { user-select: none; -webkit-user-select: none; } " +
					// 줌 floor 힌트 — 캔버스 우하단 작은 안내 (가독 fit 적용됨 = 휠/드래그로 탐색).
					".arch-canvas-hint { position: absolute; right: 8px; bottom: 6px; font-size: var(--fs-meta); " +
					'color: rgb(var(--faint)); font-family: "JetBrains Mono", monospace; pointer-events: none; ' +
					"background: rgb(var(--surface) / 0.7); padding: 1px 6px; border-radius: 4px; } " +
					".arch-mermaid-canvas .node { cursor: pointer; transition: opacity .12s; } " +
					".arch-mermaid-canvas .node:hover { opacity: 0.78; } " +
					// 상태 링 — 판정을 받은 노드·존의 테두리. no-data 는 규칙 자체가 없음.
					// 채널은 mermaid 의 도형도 outline 도 아니고, 우리가 g 안에 심은 사각형임. 세 번 재서 여기까지 옴:
					//  ① mermaid 는 classDef 를 도형의 인라인 style 로 찍고 거기에 !important 를 붙임
					//     (`style="fill:… !important;stroke:… !important"`). 인라인 !important 는 스타일시트의
					//     !important 보다 세므로 도형의 stroke 로는 못 냄 — focal(main_session) · security(hook_pipeline) ·
					//     external(user) 세 노드가 그 자리임.
					//  ② 선택자가 rect/polygon 만 짚으면 원통(path)으로 그려지는 pg_db 를 통째로 놓침.
					//  ③ 그래서 g 하나에 outline 을 걸었는데, outline 은 SVG 에서 bbox 를 네모로 두를 뿐이라
					//     모서리를 못 굴림 — 굴린 도형 위에 각진 테두리가 서는 어긋남이 남았음.
					// 심은 사각형은 mermaid 가 만들지 않은 element 라 인라인 !important 와 겹치지 않고(①),
					// 도형 bbox 로 재므로 종류를 안 가리며(②), 제 rx 를 가져 굴림(③).
					// id 선택자와 !important 가 둘 다 필요한 이유 — mermaid 가 SVG 안에 스타일시트를 심고,
					// 거기에 (a) `#<renderId> .node rect { fill:…; stroke:…; stroke-width:1px }` 와
					// (b) classDef 마다 `#<renderId> .security>*{ stroke:…!important; stroke-dasharray:4,4!important }`
					// 가 있음. 심은 사각형은 `.node rect` 이면서 classDef 를 단 g 의 직계 자식이라 둘 다에 걸림 —
					// !important 만으로는 (b) 를 못 이기고(특이도 1,1,0), id 하나를 벌어야 넘어섬(실측: 안 붙이면
					// 링이 fill=#332e2a 를 물려 안 보이고, security 노드에서는 점선이 됨).
					// 도형 쪽 인라인 !important 와는 다른 자리임 — 심은 사각형에는 인라인 style 이 없음.
					// stroke-dasharray 를 명시로 되돌리는 것도 (b) 때문임: 우리가 안 적은 속성은 그쪽이 그대로 이김.
					// 선택자에 `rect` 를 붙여 두는 것도 같은 이유임 — (b) 는 (1,1,0) 이라 클래스 하나짜리
					// `#… .arch-ring` 과 동점이 되고, 동점이면 나중에 선언된 쪽이 이기는데 mermaid 의 스타일시트는
					// SVG 안에 있어 항상 나중임(실측: focal 노드 두께 2px · security 노드 점선).
					// display 에는 !important 를 안 붙임: 아래 tone 규칙이 같은 속성을 특이도로 이겨야 링이 켜짐.
					`#${ARCH_CANVAS_ID} rect.arch-ring { display: none; fill: none !important; ` +
					"stroke-width: 2.5 !important; stroke-dasharray: none !important; " +
					"vector-effect: non-scaling-stroke; pointer-events: none; } " +
					// ok 는 테두리를 그리지 않음 — 아홉 노드가 다 둘리면 손댈 곳이 테두리로 구별되지 않음.
					// 클래스는 남김: 판정이 왔다는 사실의 유일한 표식이고, 링은 그 사실의 표현일 뿐임.
					`#${ARCH_CANVAS_ID} .arch-node-unverified > rect.arch-ring-state, #${ARCH_CANVAS_ID} .arch-zone-unverified > rect.arch-ring-state { display: inline; stroke: rgb(var(--faint)) !important; stroke-dasharray: 4 3 !important; } ` +
					// dashed is reserved for the unverified ring — the security classDef's dashed amber stroke would read as a second meaning.
					`#${ARCH_CANVAS_ID} .node.security > :is(rect, path, polygon, circle, ellipse):not(.arch-ring) { stroke-dasharray: none !important; } ` +
					".arch-canvas-busy { position: absolute; left: 8px; top: 6px; font-size: var(--fs-meta); " +
					'color: rgb(var(--dim)); font-family: "JetBrains Mono", monospace; pointer-events: none; ' +
					"background: rgb(var(--surface) / 0.7); padding: 1px 6px; border-radius: 4px; } " +
					`#${ARCH_CANVAS_ID} text.arch-ring-glyph { display: none; font-family: "JetBrains Mono", monospace; font-size: 16px; font-weight: 700; pointer-events: none; } ` +
					`#${ARCH_CANVAS_ID} .arch-node-live-warn > text.arch-ring-glyph, #${ARCH_CANVAS_ID} .arch-zone-live-warn > text.arch-ring-glyph { display: inline; fill: rgb(var(--warn)); } ` +
					`#${ARCH_CANVAS_ID} .arch-node-live-crit > text.arch-ring-glyph, #${ARCH_CANVAS_ID} .arch-zone-live-crit > text.arch-ring-glyph { display: inline; fill: rgb(var(--crit)); } ` +
					`#${ARCH_CANVAS_ID} .arch-node-live-warn > rect.arch-ring-state, #${ARCH_CANVAS_ID} .arch-zone-live-warn > rect.arch-ring-state { display: inline; stroke: rgb(var(--warn)) !important; } ` +
					`#${ARCH_CANVAS_ID} .arch-node-live-crit > rect.arch-ring-state, #${ARCH_CANVAS_ID} .arch-zone-live-crit > rect.arch-ring-state { display: inline; stroke: rgb(var(--crit)) !important; } ` +
					// 줌/팬/맞춤 컨트롤 클러스터 — 캔버스 우하단, hint 위. 불투명 면(상시 chrome) → blur 금지.
					".arch-zoom-controls { position: absolute; right: 8px; bottom: 28px; display: flex; flex-direction: column; gap: 4px; z-index: 2; } " +
					".arch-zoom-btn { min-width: 32px; height: 32px; display: inline-flex; gap: 4px; align-items: center; justify-content: center; " +
					"background: rgb(var(--elev)); border: 1px solid rgb(var(--line)); border-radius: 6px; color: rgb(var(--dim)); " +
					'cursor: pointer; font-family: "JetBrains Mono", monospace; font-size: 16px; line-height: 1; padding: 0; transition: all .12s; } ' +
					".arch-zoom-btn-labelled { padding: 0 8px; font-family: inherit; font-size: var(--fs-meta); } " +
					".arch-zoom-btn:hover { color: rgb(var(--ink)); border-color: rgb(var(--faint)); background: rgb(var(--surface-raised-2, var(--elev))); } " +
					// 키보드 포커스 노드 ring — 클릭 가능 노드의 a11y focus 표식.
					// 상태 링과 같은 사각형 채널·같은 반경 가족이되 그 바깥 한 겹에 섬 — 상태 링의 색·두께·자리는 포커스와 무관함.
					// 키보드가 헬스 상세로 가는 유일한 길이라(ADR-20) 포커스 자리는 아홉 노드에서 똑같이 보여야 함.
					// UA 기본 포커스 링은 여기서 끔 — 안 끄면 Chromium 이 `auto 5px rgb(0,95,204)` 를 네모로
					// 덧그려, 굴린 표식 옆에 각진 표식이 하나 더 섬. 종전 stroke 규칙이 네 노드에서 안 걸렸을 때
					// 그 자리를 대신 채우고 있던 것이 이 UA 링이었음(실측).
					`#${ARCH_CANVAS_ID} .node:focus-visible { outline: none; } ` +
					`#${ARCH_CANVAS_ID} .node:focus-visible > rect.arch-ring-focus { display: inline; stroke: rgb(var(--focus-ring)) !important; } ` +
					// 노드 상세의 부품 목록 — 드로어 폭 안이라 표의 nowrap 대신 줄바꿈이 기본임.
					".arch-part-list { display: flex; flex-direction: column; gap: 10px; } " +
					".arch-part-entry { display: flex; flex-direction: column; gap: 4px; min-width: 0; } " +
					".arch-part-entry + .arch-part-entry { border-top: 1px solid rgb(var(--line)); padding-top: 10px; } " +
					".arch-part-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; min-width: 0; } " +
					// 로그 목록은 부품 이름 아래로 한 칸 들여씀 — 어느 부품의 로그인지 들여쓰기만으로 냄.
					".arch-part-detail { padding-left: 10px; display: flex; flex-direction: column; gap: 8px; } " +
					// 드릴다운 전환 — 한 노드에 데몬 부품이 둘 이상일 때만 섬(cron). 진짜 button 이라
					// 키보드 활성과 포커스 순서를 브라우저에서 그대로 받음.
					".arch-part-drill { align-self: flex-start; min-height: 32px; margin: 0 0 0 10px; padding: 0 10px; " +
					"background: rgb(var(--elev)); border: 1px solid rgb(var(--line)); border-radius: 6px; " +
					"color: rgb(var(--dim)); font: inherit; font-size: var(--fs-meta); cursor: pointer; text-align: left; } " +
					".arch-part-drill:hover { color: rgb(var(--ink)); border-color: rgb(var(--faint)); } " +
					".arch-caption { display: flex; flex-direction: column; gap: 6px; margin: -8px 0 12px; } " +
					".arch-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 0; list-style: none; } " +
					".arch-legend-item { display: inline-flex; align-items: center; gap: 6px; } " +
					".arch-legend-swatch { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 14px; " +
					'border: 2px solid rgb(var(--faint)); border-radius: 4px; font-family: "JetBrains Mono", monospace; font-size: 12px; font-weight: 700; line-height: 1; } ' +
					".arch-legend-swatch-warn { border-color: rgb(var(--warn)); color: rgb(var(--warn)); } " +
					".arch-legend-swatch-crit { border-color: rgb(var(--crit)); color: rgb(var(--crit)); } " +
					".arch-legend-swatch-dashed { border-style: dashed; } " +
					`#${ARCH_CANVAS_ID} .${ZONE_TITLE_REDUNDANT_CLASS} > .cluster-label { display: none; } ` +
					".arch-run-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; } " +
					".arch-run-entry { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; min-width: 0; } " +
					".arch-run-reasons { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; min-width: 0; } " +
					// aria-describedby 타깃 — 클립으로 가리되 렌더 트리에는 남김. display:none 은 노드를 렌더에서 빼 innerText 계측을 잃음.
					".arch-desc-a11y { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; " +
					"overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; } " +
					// 모션 게이트 — 노드/줌 컨트롤 transition 정지 (§8.4 계약).
					"@media (prefers-reduced-motion: reduce) { " +
					".arch-mermaid-canvas .node, .arch-zoom-btn { animation: none !important; transition: none !important; } }"}
			</style>

			<div className="flex-shrink-0">
				<PageHeader
					title="System map"
					right={
						<>
							<FreshnessStamp
								{...getFreshnessInputAR(healthAsOf, pageRegions)}
							/>
							<RefreshButton
								isBusy={isRefreshBusy}
								hasRead={diagState.data != null}
								onRefresh={triggerRefresh}
								label="Refresh system map"
							/>
						</>
					}
				/>
				<MapCaptionAR caption={healthCaption} />
			</div>

			<div className="arch-page">
				{sharedFailure && (
					<PageErrorBanner
						sources={sharedFailure.sources}
						error={sharedFailure.error}
						onRetry={triggerRefresh}
					/>
				)}
				<AlarmLaneAR rows={alarmRows} onRetry={triggerRefresh} />

				{/* 본체: 단일 canonical Mermaid 캔버스 (가용 폭 100%) — 못 읽으면 빈 캔버스 대신 조용한 카드 하나 */}
				<div className="arch-main">
					{diagState.status === "error" ? (
						<RegionUnavailable
							source={DIAGRAM_SOURCE_AR}
							error={diagState.error}
							onRetry={sharedFailure ? undefined : triggerRefresh}
						/>
					) : (
						<div className="card arch-col-card" aria-busy={diagState.busy ? "true" : undefined}>
							<div
								className="card-body"
								style={{ padding: 10, opacity: diagState.busy && diagState.data ? 0.6 : 1 }}
							>
								<DiagramBody
									diagState={diagState}
									activeDiagram={activeDiagram}
									nodeByLabel={nodeByLabel}
									ringToneByNodeId={ringToneByNodeId}
									unverifiedNodeIds={unverifiedNodeIds}
									healthPending={healthPending}
									zoneRingPlan={zoneRingPlan}
									attentionCountByNodeId={attentionCountByNodeId}
									onSelectNode={handleSelectNode}
								/>
							</div>
						</div>
					)}
				</div>

				{activeDiagram && (
					<div id={ARCH_DESC_ID} className="arch-desc-a11y">
						{activeDiagram.description || "No description available."}
					</div>
				)}

			</div>

			{/* 노드 클릭 → 드로어 (이름 / 설명 / 이 노드에 묶인 부품 헬스 + 그 로그 / 연결 flows) */}
			{detail && (
				<DetailModal
					detail={detail}
					nodeIndex={nodeIndex}
					activeDiagram={activeDiagram}
					liveDaemonsByNodeId={liveDaemonsByNodeId}
					healthPartRows={healthPartRows}
					zoneIdByMemberId={zoneRingPlan.zoneIdByMemberId}
					payloadDaemon={payloadDaemon}
					onSelectDaemon={setPayloadDaemon}
					payloadState={payloadState}
					hookState={hookState}
					hookFailState={hookFailState}
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
	ringToneByNodeId,
	unverifiedNodeIds,
	healthPending,
	zoneRingPlan,
	attentionCountByNodeId,
	onSelectNode,
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

	if (diagState.status === "loading") return <MapLoadingAR />;
	if (!activeDiagram) {
		return <EmptyStateAR message="No diagrams to show." />;
	}
	const source = activeDiagram.mermaid_source;
	if (!source || typeof source !== "string" || source.trim().length === 0) {
		return (
			<EmptyStateAR message="This diagram has an empty mermaid_source." />
		);
	}
	if (!mermaidReady) return <MapLoadingAR />;
	return (
		<MermaidCanvas
			diagramId={activeDiagram.id}
			source={source}
			diagramTitle={activeDiagram.title || activeDiagram.id}
			nodeByLabel={nodeByLabel}
			ringToneByNodeId={ringToneByNodeId}
			unverifiedNodeIds={unverifiedNodeIds}
			healthPending={healthPending}
			zoneRingPlan={zoneRingPlan}
			attentionCountByNodeId={attentionCountByNodeId}
			onSelectNode={onSelectNode}
		/>
	);
}

function MapLoadingAR() {
	const { LoadingPlaceholder } = window.UI;
	return <LoadingPlaceholder label={DIAGRAM_SOURCE_AR} minHeight={240} className="h-full" />;
}

// MermaidCanvas — window.mermaid.render 로 SVG 생성 → 컨테이너 주입 → svg-pan-zoom 활성화.
// SECURITY: source 는 internal trusted 다이어그램 소스 → DOMPurify sanitize 생략 (외부 입력 노출 시 재검토 필수).
// drag/click 구분: mousedown 좌표 추적 → 4px 이상 이동 시 drag (click 무시).
function MermaidCanvas({
	diagramId,
	source,
	diagramTitle,
	nodeByLabel,
	ringToneByNodeId,
	unverifiedNodeIds,
	healthPending,
	zoneRingPlan,
	attentionCountByNodeId,
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
			.then(() => (cancelled ? null : window.mermaid.render(renderId, MAP_LABEL_DIRECTIVE + source)))
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
			// classDef writes its dash inline with !important — only removing it lets the rule above win.
			if (el.classList.contains("security"))
				el.querySelectorAll(":scope > :is(rect, path, polygon, circle, ellipse)").forEach((shape) =>
					shape.style.removeProperty("stroke-dasharray"),
				);

			const labelText = extractMermaidNodeLabelAR(el);
			if (!labelText) return;
			const norm = normalizeLabelAR(labelText);
			const matchedId = nodeByLabel.get(norm) || null;
			if (!matchedId) return;

			el.setAttribute("data-arch-node-id", matchedId);
			el.setAttribute("data-arch-label", labelText.replace(/\s+/g, " ").trim());
			// 키보드 진입 — 표를 걷어내며 노드가 헬스 상세로 가는 유일한 문이 됐음 (ADR-20).
			// 표의 행은 진짜 button 이라 탭으로 닿았는데 노드는 캔버스만 포커스를 받아
			// (tabIndex 는 캔버스에 있고 키 핸들러는 줌/팬뿐임) 마우스 없이는 상세에 닿을 길이
			// 사라짐. 파일에 이미 `.node:focus-visible` 규칙이 있으나 포커스를 받을 수 있는
			// 노드가 없어 죽어 있었음 — 여기서 살아남.
			el.setAttribute("tabindex", "0");
			el.setAttribute("role", "button");
			// 접근명은 라벨 그대로 — 화면이 읽은 그 글자여야 스크린리더와 보이는 것이 갈라지지 않음.
			el.setAttribute("aria-label", labelText.replace(/\s+/g, " ").trim());
		});
		setFlowTabOrderAR(root);
	}, [renderState.status, renderState.svgHtml, nodeByLabel]);

	// 상태 링 — 판정(데몬 ∪ 부품) 하나를 테두리로 냄. 클래스만 켜고, 그리는 것은 심어 둔 사각형임.
	//   위 효과가 심은 data-arch-node-id 를 되읽으므로 선언 순서가 곧 실행 순서임 — 앞으로 옮기면 첫 렌더에서 빈다.
	//   폴링 tick 마다 다시 도는 유일한 캔버스 효과 — 재렌더 없이 판정만 바뀌는 경로가 여기임.
	//   그래서 ringToneByNodeId 가 deps 에 있어야 함: 빼면 health 폴링이 와도 다시 칠하지 않음.
	//   헬스 노드를 하나만 담은 존은 그 존 상자가 판정을 대신 냄 — 존이 낸 판정을 노드가 또 내면
	//   같은 사실이 두 겹으로 읽히므로, 그 노드는 여기서 건너뜀.
	useEffectAR(() => {
		if (renderState.status !== "ready") return;
		const root = containerRef.current;
		if (!root) return;

		root.querySelectorAll("g.node").forEach((el) => {
			el.classList.remove(...LIVE_RING_CLASSES, NODE_UNVERIFIED_CLASS);
			const nodeId = el.getAttribute("data-arch-node-id");
			if (!nodeId) return;

			const unscoped = unscopedNodeIdAR(nodeId);
			const tone = ringToneByNodeId.get(unscoped);
			const isUnverified = !unverifiedNodeIds || unverifiedNodeIds.has(unscoped);
			el.setAttribute(
				"aria-label",
				getNodeAccessibleNameAR(el.getAttribute("data-arch-label") || "", tone, isUnverified),
			);
			if (zoneRingPlan.zoneByNodeId.has(unscoped)) return;

			const ringClass = getRingClassAR(tone, LIVE_RING_CLASS, isUnverified, NODE_UNVERIFIED_CLASS);
			if (ringClass) el.classList.add(ringClass);

			setCornerGlyphAR(el, tone, attentionCountByNodeId.get(unscoped));
		});

		root.querySelectorAll("g.cluster").forEach((el) => {
			el.classList.remove(...ZONE_RING_CLASSES, ZONE_UNVERIFIED_CLASS);
			const zoneId = matchZoneIdAR(el.id || "", zoneRingPlan.zoneIds);
			if (!zoneId) return;

			const nodeId = zoneRingPlan.nodeIdByZoneId.get(zoneId);
			if (!nodeId) return;

			const tone = ringToneByNodeId.get(nodeId);
			const isUnverified = Boolean(unverifiedNodeIds?.has(nodeId));
			const ringClass = getRingClassAR(tone, ZONE_RING_CLASS, isUnverified, ZONE_UNVERIFIED_CLASS);
			if (ringClass) el.classList.add(ringClass);

			setCornerGlyphAR(el, tone, attentionCountByNodeId.get(nodeId));
		});
	}, [
		renderState.status,
		renderState.svgHtml,
		nodeByLabel,
		ringToneByNodeId,
		unverifiedNodeIds,
		zoneRingPlan,
		attentionCountByNodeId,
	]);

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
			titleEl = document.createElementNS(SVG_NS_AR, "title");
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
		const redundantZoneIds = [...buildRedundantZoneIdsAR(source)];
		root.querySelectorAll("svg g.cluster").forEach((el) => {
			el.classList.toggle(ZONE_TITLE_REDUNDANT_CLASS, Boolean(matchZoneIdAR(el.id || "", redundantZoneIds)));
		});
		fitZoneBoxesAR(root, source);
		root.querySelectorAll(`svg g.cluster:not(.${ZONE_TITLE_REDUNDANT_CLASS}) > rect:first-of-type`).forEach((rect) => {
			if (rect.dataset.archTitleBand === "1") return;
			const y = Number.parseFloat(rect.getAttribute("y"));
			const height = Number.parseFloat(rect.getAttribute("height"));
			if (!Number.isFinite(y) || !Number.isFinite(height)) return;
			rect.setAttribute("y", String(y - ZONE_TITLE_BAND));
			rect.setAttribute("height", String(height + ZONE_TITLE_BAND));
			rect.dataset.archTitleBand = "1";
		});
		growViewBoxToContentAR(root.querySelector("svg"));
	}, [renderState.status, renderState.svgHtml, source]);

	/**
	 * 링 사각형 심기 — 노드와 존마다 자리를 하나씩 만들어 둠. 켜고 끄는 것은 위 tone 효과의 클래스이고
	 * 여기서는 기하만 정함, 그래서 폴링 tick 에는 다시 돌지 않음(deps 가 렌더에만 매임).
	 * 존 제목 띠 효과 뒤에 서야 함 — 띠가 존 rect 를 위로 늘리므로, 먼저 재면 링이 옛 높이를 두름.
	 * 판정을 못 받는 노드에도 심음: 심는 값은 기하뿐이고 display:none 이라 bbox 에 들어가지 않으므로
	 * 맞춤 계산이 흔들리지 않고, "어느 노드든 판정을 그릴 수 있다" 는 성질이 클래스 하나로 성립함.
	 */
	useEffectAR(() => {
		if (renderState.status !== "ready") return;
		const root = containerRef.current;
		if (!root) return;

		root.querySelectorAll("svg g.node").forEach((el) => {
			ensureRingRectAR(el, RING_STATE_CLASS);
			ensureRingRectAR(el, RING_FOCUS_CLASS);
		});
		root
			.querySelectorAll("svg g.cluster")
			.forEach((el) => ensureRingRectAR(el, RING_STATE_CLASS));
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

	// 포커스된 노드에서의 Enter/Space — 클릭과 같은 문. 캔버스의 줌/팬 키와 한 핸들러에 섞지
	// 않음: 그쪽은 캔버스가 포커스일 때 도는 것이고 이쪽은 노드가 포커스일 때만 돌아야 함.
	// Space 는 기본 스크롤을 막음 — 안 막으면 상세가 열리면서 페이지가 함께 내려감.
	const handleNodeKeyDown = useCallbackAR(
		(e) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			const nodeEl = e.target.closest("g.node");
			if (!nodeEl) return;
			const matchedId = nodeEl.getAttribute("data-arch-node-id");
			if (!matchedId) return;

			e.preventDefault();
			e.stopPropagation();
			onSelectNode(matchedId);
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
		return <MapLoadingAR />;
	}
	if (renderState.status === "error") {
		const { RegionUnavailable } = window.UI;
		return <RegionUnavailable source={DIAGRAM_SOURCE_AR} error={renderState.error} />;
	}
	return (
		<>
			<div
				id={ARCH_CANVAS_ID}
				className="arch-mermaid-canvas"
				role="group"
				aria-busy={healthPending || undefined}
				aria-label={`${diagramTitle} — pan and zoom diagram`}
				tabIndex={0}
				onKeyDown={handleKeyDown}
			>
				<div
					ref={containerRef}
					style={{ width: "100%", height: "100%" }}
					onMouseDown={handleMouseDown}
					onClick={handleClick}
					onKeyDown={handleNodeKeyDown}
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
						className="arch-zoom-btn arch-zoom-btn-labelled"
						onClick={fitToView}
						aria-label="Fit diagram to view"
						title="Fit to view (0)"
					>
						<ArchIconTargetAR />
						Fit
					</button>
				</div>

				{/* 가독 fit 안내 — 넓은 LR 그래프는 휠/+−·드래그/화살표·키보드로 탐색 */}
				{healthPending && (
					<div className="arch-canvas-busy" role="status">
						Loading health…
					</div>
				)}
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

// 끊긴 health 응답의 표시 이름 — 사실 행과 로드 실패 경보가 같은 이름을 부르게 묶어 둠.
// 값 없음(빈 배열)과 못 읽음을 화면에서 구별하는 유일한 자리임.
// 머리글이 서 있는 응답 넷만 둠 — 드릴다운 응답(payloadState)은 노드 하나를 연 뒤의 사실이라
// 여기 들면 행을 펼쳤다는 이유로 지도 전체가 '못 읽음' 이 됨.
const HEALTH_STORE_LABELS_AR = {
	daemonState: "Daemons",
	hookState: "Hook chain",
	pgState: "PostgreSQL",
	hookFailState: "Hook failures",
};

// held data keeps showing on a failed re-read — only a region with nothing to show counts as down
function getRegionErrorAR(state) {
	return state.status === "error" ? state.error : null;
}

function getHealthStoreErrorsAR(states) {
	return Object.keys(HEALTH_STORE_LABELS_AR)
		.filter((key) => states[key] && states[key].status === "error")
		.map((key) => HEALTH_STORE_LABELS_AR[key]);
}

/**
 * Hook chain 상세 — 이벤트 → matcher → 훅 (T11). 카드가 내던 요약(이벤트 수 · 훅 수)은
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
							<span className="fs-meta text-faint">{row.hookCount} hooks</span>
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
													{hook.type && <span className="fs-meta text-faint">{hook.type}</span>}
													{hook.timeout !== null && hook.timeout !== undefined && (
														<span className="fs-meta text-faint">timeout {hook.timeout}s</span>
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
 * Hook failure log 상세 — 창 안 실패 목록 + 창 무관 최종기록 (T12c).
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
	const { StatusDot, formatRelativeTime, formatKstFull } = window.UI;
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
							{/* 라벨이 신호이고 tone 은 점이 실음 — meta 크기 글자에 심각도 색을
							    얹으면 AA 대비에 못 미치고, 색만으로 실패 종류를 가르지도 않음 */}
							<span className="inline-flex items-center">
								<StatusDot status={row.kind.tone} />
								{row.kind.label}
							</span>
							{row.retryAttempted && (
								<span className="fs-meta text-faint">retried</span>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

// 노드 상세의 헬스 구획 — 걷어낸 표가 서던 자리 (ADR-20). 표는 부품 명부 전체를 한 화면에
// 폈고 이쪽은 클릭한 노드에 묶인 부품만 냄. 일곱 전원이 여전히 닿는 근거는 화면이 아니라
// 바인딩 계기임: 모든 부품이 노드를 최소 하나 갖고(AC-B2-2b) 그 노드가 전부 그려지므로
// (AC-B2-2a) 그려지지 않는 노드 뒤에 숨는 부품이 있을 수 없음 — 그 조합은 붉은 테스트임.
// 표가 내던 네 열 중 Nodes 만 형태가 바뀜: 클릭한 노드는 여는 행위가 이미 말했으므로 나머지
// 바인딩만 남겨 부름(1:1 부품은 낼 것이 없어 아무것도 그리지 않음).

function NodePartHealth({
	nodeId,
	partRows,
	daemons,
	payloadDaemon,
	onSelectDaemon,
	payloadState,
	hookState,
	hookFailState,
}) {
	const { Badge, StatusDot, formatRelativeTime, daemonStatusLabel, daemonStatusTone } =
		window.UI;

	const unscoped = unscopedNodeIdAR(nodeId);
	const rows = partRows.filter((row) => row.nodeIds.includes(unscoped));

	// 부품 행이 이미 부르는 데몬은 여기서 빼냄 — 같은 데몬이 두 줄로 서면 판정이 두 겹으로 읽힘.
	const namedDaemons = new Set(rows.map((row) => row.daemonName).filter(Boolean));
	const looseDaemons = (daemons || []).filter(
		(daemon) => !namedDaemons.has(daemon.daemon_name),
	);

	// 이 노드에 묶인 판정이 하나도 없으면 구획 자체가 없음 — 빈 제목은 판정이 비었다고 거짓말함.
	if (rows.length === 0 && looseDaemons.length === 0) return null;

	return (
		<div data-node-health={unscoped}>
			<div className="fs-meta font-mono text-faint uppercase tracking-wider mb-1">
				Health ({rows.length + looseDaemons.length})
			</div>
			<div className="arch-part-list">
				{rows.map((row) => {
					const renderDetail = HEALTH_ROW_DETAILS[row.kind];
					// 드릴다운 응답은 한 번에 한 데몬 것임 — 다른 데몬의 실행 목록을 이 데몬의 것으로
					// 그리지 않도록 이름이 맞을 때만 상세를 폄 (cron 은 데몬 부품 둘이 같은 노드에 묶임).
					const isDrilled = !row.daemonName || row.daemonName === payloadDaemon;
					// 남은 바인딩만 부름 — 클릭한 노드는 패널을 연 행위가 이미 말했음.
					const alsoLights = row.nodeIds.filter((id) => id !== unscoped);

					return (
						<div
							key={row.id}
							className="arch-part-entry"
							data-health-row={row.id}
							data-health-tone={row.tone || undefined}
							data-daemon-row={row.daemonName || undefined}>
							<div className="arch-part-head">
								<span className="fs-meta font-mono text-ink">{row.name}</span>
								{row.tone ? (
									<span className="fs-meta inline-flex items-center gap-1.5 text-dim">
										<StatusDot status={row.tone} />
										{getPartStatusTextAR(row)}
									</span>
								) : (
									<span className="fs-meta text-dim">{getPartStatusTextAR(row)}</span>
								)}
								{/* 마지막 실행은 데몬 부품만 갖는 사실임 — 나머지 부품에서는 빈 값이 정답이라
								    칸을 아예 두지 않음. 데몬인데 값이 없으면 그 없음은 보여야 하므로 '—' 로 냄. */}
								{row.daemonName && (
									<span className="fs-meta text-dim">
										Last run{" "}
										{row.lastRunAt ? formatRelativeTime(row.lastRunAt) : "—"}
									</span>
								)}
							</div>

							{alsoLights.length > 0 && (
								<div className="fs-meta font-mono text-faint">
									Also lights: {alsoLights.join(", ")}
								</div>
							)}

							{/* 펼칠 것이 없는 kind(pg · browser)는 아무것도 그리지 않음 — 빈 영역을 여는
							    자리는 읽을 것이 있다고 거짓말함. 있는 kind 는 접지 않고 바로 폄:
							    패널이 이미 노드 하나로 좁혀져 있어 접어 둘 비교 대상이 없음. */}
							{renderDetail &&
								(isDrilled ? (
									<div
										className="arch-part-detail"
										data-health-detail={row.id}
										data-daemon-detail={row.daemonName || undefined}>
										{renderDetail(row, { payloadState, hookState, hookFailState })}
									</div>
								) : (
									<button
										type="button"
										className="arch-part-drill"
										onClick={() => onSelectDaemon?.(row.daemonName)}>
										Show recent runs for {row.daemonName}
									</button>
								))}
						</div>
					);
				})}

				{/* 부품 표에 없는 데몬 — 종전에는 이름 옆 pill 줄이 실어 나르던 사실임. 같은 물음
				    ("이 노드는 지금 어떤가")의 답이므로 같은 목록에 섬. 부품 행의 data 속성은
				    쓰지 않음: 하네스가 그 이름으로 부품 판정을 세는데, 이 줄은 부품이 아님. */}
				{looseDaemons.map((daemon) => (
					<div
						key={daemon.daemon_name}
						className="arch-part-entry"
						data-live-daemon={daemon.daemon_name}
						data-live-tone={daemonStatusTone(daemon.effective_status) || undefined}>
						<div className="arch-part-head">
							<span className="fs-meta font-mono text-ink">
								{daemon.daemon_name}
							</span>
							<Badge role="status" tone={daemonStatusTone(daemon.effective_status)}>
								{daemonStatusLabel(daemon.effective_status)}
							</Badge>
							<span className="fs-meta text-dim">
								Last run{" "}
								{daemon.last_run_at ? formatRelativeTime(daemon.last_run_at) : "—"}
							</span>
						</div>
					</div>
				))}
			</div>
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
	healthPartRows,
	zoneIdByMemberId,
	payloadDaemon,
	onSelectDaemon,
	payloadState,
	hookState,
	hookFailState,
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
				healthPartRows={healthPartRows}
				zoneIdByMemberId={zoneIdByMemberId}
				payloadDaemon={payloadDaemon}
				onSelectDaemon={onSelectDaemon}
				payloadState={payloadState}
				hookState={hookState}
				hookFailState={hookFailState}
			/>
		);

	// kind comes from the layer — the node type reads "Agent" for the entry, orchestrator and scheduled jobs
	const { DetailSurface } = window.UI;

	return (
		<DetailSurface
			open
			onClose={onClose}
			variant="drawer"
			title={info ? info.label || info.id : "Node"}
			sub={info?.layer_label}
			labelledBy="ar-node-detail-title"
			bodyClassName="space-y-3"
		>
			{body}
		</DetailSurface>
	);
}

function NodeDetailBody({
	info,
	flows,
	nodeIndex,
	liveDaemonsByNodeId,
	healthPartRows,
	zoneIdByMemberId,
	payloadDaemon,
	onSelectDaemon,
	payloadState,
	hookState,
	hookFailState,
}) {
	const { DetailField } = window.UI;
	// node_ids 바인딩 기반 — 라벨/이름 fuzzy 매칭 폐기 (F32). 한 노드에 복수 daemon 바인딩 가능 (F39).
	//   판정은 pill 줄이 아니라 아래 health 행이 실음 — 한 노드의 상태를 한 자리에서 읽게 함.
	const daemons = liveDaemonsByNodeId.get(unscopedNodeIdAR(info.id)) || [];

	const endpointIds = getFlowEndpointIdsAR(info.id, zoneIdByMemberId);
	const inbound = flows.filter((f) => endpointIds.has(f.to));
	const outbound = flows.filter((f) => endpointIds.has(f.from));

	return (
		<>
			{/* 순서는 조작자의 물음 순서임 — 무엇인가 · 지금 어떤가 · 무엇에 닿는가 ·
			    어디를 여는가. 경로와 설명은 그 답을 고른 뒤에야 쓰이므로 뒤로 감. */}
			<NodePartHealth
				nodeId={info.id}
				partRows={healthPartRows}
				daemons={daemons}
				payloadDaemon={payloadDaemon}
				onSelectDaemon={onSelectDaemon}
				payloadState={payloadState}
				hookState={hookState}
				hookFailState={hookFailState}
			/>
			<FlowSummary
				inbound={inbound}
				outbound={outbound}
				nodeIndex={nodeIndex}
			/>
			<OwningScreenLinkAR nodeId={info.id} />
			<DetailField label="File path" value={info.path} mono />
			<DetailField label="Description" value={info.description} />
		</>
	);
}

// drawn node → the screen that reads that part's records (hash id = app.jsx NAV id). Unowned parts get no link.
const OWNING_SCREEN_BY_NODE_AR = {
	agent_layer: { id: "agents", label: "Agents" },
	hook_pipeline: { id: "outcomes", label: "Task results" },
	autoagent_d: { id: "improvement", label: "Learning" },
	wiki_d: { id: "wiki", label: "Wiki" },
	doc_export: { id: "clauded-docs", label: "Documents" },
};

function getOwningScreenAR(nodeId) {
	const bareId = unscopedNodeIdAR(nodeId);
	return Object.hasOwn(OWNING_SCREEN_BY_NODE_AR, bareId) ? OWNING_SCREEN_BY_NODE_AR[bareId] : null;
}

function OwningScreenLinkAR({ nodeId }) {
	const owner = getOwningScreenAR(nodeId);
	if (!owner) return null;
	return (
		<div>
			<div className="fs-meta font-mono text-faint uppercase tracking-wider mb-1">
				Records
			</div>
			<a className="fs-body" href={`#${owner.id}`}>
				Open {owner.label}
			</a>
		</div>
	);
}

function FlowSummary({ inbound, outbound, nodeIndex }) {
	const total = inbound.length + outbound.length;
	if (total === 0)
		return <div className="fs-meta text-faint">No connections</div>;
	return (
		<div>
			<div className="fs-meta font-mono text-faint uppercase tracking-wider mb-1">
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
	const { Icon, getDisplayName } = window.UI;
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
						<div key={f.id} className="break-words">
							<span style={{ color: EDGE_COLORS[f.edge_type] || "#94a3b8" }}>
								●
							</span>{" "}
							<span className="text-faint">{getDisplayName("edge", f.edge_type)}:</span> {fromLabel}{" "}
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

// tone → 글리프 색 클래스. 리터럴 표인 이유: 조립한 클래스명은 클래스 스캐너가 보지 못함.
// 읽는 쪽은 아이콘뿐임 — 글자에 얹으면 meta/micro 크기에서 AA 대비에 못 미침 (39578 §D).
// 둘째 표를 들이면 같은 tone 이 화면 자리마다 다른 색으로 갈라짐.
const TONE_GLYPH_CLASS = {
	warn: "text-warn",
	crit: "text-crit",
	info: "text-info",
};

/**
 * 경보 레인의 행 — 심각도별 tint · 아이콘 · 이름 배지를 한 상자로 실음.
 * tone 은 CSS 변수명으로 그대로 들어가므로, 새 tone 은 같은 이름의 변수가 tokens.css 에 있어야 함.
 * role=alert 는 행이 가짐 — 레인이 가지면 네 사실이 한 경보로 접혀 이름을 따로 셀 수 없음.
 */
function AlarmRowAR({ row, onRetry }) {
	const { Icon, Badge } = window.UI;
	return (
		<div
			role="alert"
			data-alarm={row.key}
			data-alarm-tone={row.tone}
			className="arch-alarm-row rounded-md border p-3 flex items-start gap-3"
			style={{
				background: `rgb(var(--${row.tone}) / 0.08)`,
				borderColor: `rgb(var(--${row.tone}) / 0.4)`,
			}}
		>
			<Icon
				name={row.icon}
				size={16}
				className={`${TONE_GLYPH_CLASS[row.tone]} mt-0.5`}
			/>
			<div className="flex-1 min-w-0">
				<div className="fs-body font-medium text-ink">{row.title}</div>
				<div className="fs-meta text-dim mt-1">{row.note}</div>
				{row.detail && (
					<details className="fs-meta text-faint mt-1">
						<summary className="cursor-pointer">Details</summary>
						<code className="block mt-1 font-mono break-all">{row.detail}</code>
					</details>
				)}
				{row.badges.length > 0 && (
					<div className="flex flex-wrap gap-1.5 mt-2">
						{row.badges.map((name) => (
							<Badge key={name}>
								{name}
							</Badge>
						))}
					</div>
				)}
			</div>
			{onRetry && row.retry && (
				<button className="btn sm" onClick={onRetry}>
					Retry
				</button>
			)}
		</div>
	);
}

/**
 * 경보 레인 — 조작자가 손을 대야 하는 사실만 심각도 순으로 폄.
 * 로딩도 빈 상태도 두지 않음: 둘 다 '문제 없음' 을 문제처럼 그림 — 행이 없으면 DOM 에 없음.
 */
function AlarmLaneAR({ rows, onRetry }) {
	if (!rows || rows.length === 0) return null;
	return (
		<div className="arch-alarm-lane">
			{rows.map((row) => (
				<AlarmRowAR key={row.key} row={row} onRetry={onRetry} />
			))}
		</div>
	);
}

// Pure helpers

async function fetchJsonAR(url, signal) {
	const res = await fetch(url, {
		signal,
		headers: { Accept: "application/json" },
	});
	if (!res.ok) throw await window.UI.getFetchError(res);
	return res.json();
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

	// fit-applied mark — until the library's next-frame CTM flush, the viewport still holds its viewBox meet scale
	root
		?.querySelector(".svg-pan-zoom_viewport")
		?.setAttribute("data-arch-fit-scale", String(targetAbs));
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

/**
 * 머리글 문장 — 손댈 곳의 수를 모집단과 함께 냄. 모집단은 헬스 모델의 부품 행 수이고,
 * 그려진 노드 수도 데몬 수도 아님 — 둘은 판정을 받지 않는 자리를 모집단에 섞음.
 * 로딩 · 못 읽음 · 미판정 · 정상이 저마다 다른 문장임: 하나로 접으면 안 읽힌 값이 0 으로 읽힘.
 */
function getHealthCaptionAR(partRows, busy, errored = 0) {
	const total = partRows.length;
	if (total === 0)
		return busy ? "Reading part health…" : "Part health unavailable";

	// 'No data' (info) is not a verdict — it rings dashed, so it counts as unverified, not attention.
	const judged = partRows.filter((row) => row.tone && row.tone !== "info");
	const attention = judged.filter((row) => row.tone !== "ok");
	const unverified = total - judged.length;
	// 끊긴 저장소가 있으면 남은 빈칸은 '아직' 이 아니라 '못 읽음' 임 — 두 낱말이 그 둘을 가름.
	const unjudgedWord = errored > 0 ? "unreadable" : "not verified";

	if (attention.length > 0)
		return `${attention.length} of ${total} parts need attention${getFlaggedNamesSuffixAR(attention)}`;
	if (judged.length === 0) return getNoVerdictCaptionAR(total, busy, errored);
	// first wave still out → no ok count yet; the early verdicts would read as the whole map
	if (busy && unverified > 0) return `Reading ${unverified} of ${total} parts…`;
	if (unverified > 0)
		return `${judged.length} of ${total} parts ok · ${unverified} ${unjudgedWord}`;

	return `All ${total} parts ok`;
}

// flagged parts by name — the caption answers 'what is wrong' before any click.
function getFlaggedNamesSuffixAR(rows) {
	const names = rows.map((row) => row.name).filter(Boolean);
	return names.length > 0 ? `: ${names.join(", ")}` : "";
}

// legend — ring marks and the dashed ring from the canvas's own vocabulary, then the role borders.
function getMapLegendItemsAR() {
	const rings = ["warn", "crit"].map((tone) => ({
		key: tone,
		kind: "ring",
		mark: getCornerGlyphTextAR(tone, 1),
		label: HEALTH_WORD_AR[tone],
	}));
	const dashed = { key: "unverified", kind: "dashed", label: UNVERIFIED_WORD_AR };
	const borders = MAP_BORDER_KEY_AR.map((item) => ({ ...item, kind: "border" }));
	return [...rings, dashed, ...borders];
}

// sentence-case status line over a swatch legend — the page header's sub line is uppercase 11px mono.
function MapCaptionAR({ caption }) {
	return (
		<div className="arch-caption">
			<p className="fs-meta text-dim m-0">{caption}</p>
			<ul className="arch-legend fs-meta text-dim" aria-label="Map legend">
				{getMapLegendItemsAR().map((item) => (
					<li key={item.key} className="arch-legend-item">
						<span
							aria-hidden="true"
							className={`arch-legend-swatch arch-legend-swatch-${item.kind === "ring" ? item.key : item.kind}`}
							style={item.color ? { borderColor: item.color } : undefined}>
							{item.mark || ""}
						</span>
						{item.kind === "border" ? `${item.label} border` : `Ring ${item.label}`}
					</li>
				))}
			</ul>
		</div>
	);
}

// accessible name = label + health word, so the verdict reaches a screen reader, not only the ring colour.
function getNodeAccessibleNameAR(label, tone, isUnverified) {
	// mirrors getRingClassAR — a flagged tone outranks unverified, which outranks ok.
	const isFlagged = tone === "warn" || tone === "crit";
	const word = !isFlagged && isUnverified ? UNVERIFIED_WORD_AR : HEALTH_WORD_AR[tone];
	return word ? `${label}, ${word}` : label;
}

// 판정이 하나도 안 선 상태 — 오는 중 · 못 읽음 · 미판정이 저마다 다른 문장임.
function getNoVerdictCaptionAR(total, busy, errored) {
	if (busy) return `Reading ${total} parts…`;
	if (errored > 0) return `Couldn't read health for ${total} parts`;
	return `No verdict yet for ${total} parts`;
}

// unscoped node id → attention parts bound there — the same population the caption counts.
function buildAttentionCountByNodeIdAR(partRows) {
	const counts = new Map();
	for (const row of partRows || []) {
		if (row.tone !== "warn" && row.tone !== "crit") continue;
		for (const nodeId of row.nodeIds || []) counts.set(nodeId, (counts.get(nodeId) || 0) + 1);
	}
	return counts;
}

// mark alone for one part; with a count once a node stands for several, so the caption tallies.
function getCornerGlyphTextAR(tone, attentionCount) {
	const mark = RING_GLYPH_MARK[tone];
	if (!mark) return "";
	return attentionCount > 1 ? `${mark}×${attentionCount}` : mark;
}

// every region the page reads → a re-read failing over held data keeps status 'ready', so only the stamp can show it
function getFreshnessInputAR(healthAsOf, regions) {
	return { at: healthAsOf, regions };
}

// 'Not loaded' (no verdict arrived) never shares a label with 'No data' (a verdict of absence).
function getPartStatusTextAR(row) {
	return row.tone ? row.statusLabel : "Not loaded";
}

// 레인 정렬 순위 — 심각도만으로 셈. 같은 tone 안의 순서는 조립 순서(안정 정렬)가 냄.
// 글리프 색 표의 모든 tone 이 여기 있어야 함 — 빠진 tone 은 NaN 비교로 제자리를 잃음.
const ALARM_TONE_RANK = { crit: 1, warn: 2, info: 3 };

/**
 * 경보 레인의 행 — 네 사실을 한 목록으로 접고 심각도로 세움.
 * 각 사실의 근거는 화면이 이미 들고 있는 값뿐임 — 여기서 다시 판정하지 않음.
 */
function getAlarmRows({ offWriters, healthStoreErrors, liveState, governance }) {
	const rows = [];

	if (offWriters.length > 0)
		rows.push({
			key: "dual-write",
			tone: "crit",
			icon: "warn",
			title: "Dual-write stopped — these writers are not recording",
			// 스캔 실패도 같은 false 로 떨어짐(live-overlay 의 fail-loud 기본값) — 두 원인을 함께 적음.
			note: "Marker scan found no dual-write block, or could not read the file.",
			badges: offWriters.map((w) => w.writer_name),
		});

	if (healthStoreErrors.length > 0)
		rows.push({
			key: "health-store",
			tone: "crit",
			icon: "warn",
			title: "Couldn't load system health",
			note: "These stores did not answer; the parts they judge carry no verdict.",
			badges: healthStoreErrors,
			retry: true,
		});

	if (liveState.status === "error")
		rows.push({
			key: "live-overlay",
			tone: "crit",
			icon: "warn",
			title: "Couldn't load the live overlay",
			note: "The live endpoint did not answer; ring verdicts and part bindings are missing.",
			detail: liveState.error,
			badges: [],
			retry: true,
		});

	const absent = governance?.absent || [];
	if (absent.length > 0 || governance?.sourceMissing)
		rows.push({
			key: "governance",
			tone: "warn",
			icon: "warn",
			title: governance?.sourceMissing
				? "Governance membership unverifiable — compliance matrix unreadable"
				: "Governance document missing",
			note: "The compliance matrix names these files; they are not on disk.",
			badges: absent,
		});

	return rows.sort((a, b) => ALARM_TONE_RANK[a.tone] - ALARM_TONE_RANK[b.tone]);
}

// 표 행 목록 — 부품 명부 한 항목 = 한 행 (ADR-5). 데몬 응답이 행 수를 정하지 않으므로 응답에 없는
// 데몬도 제 행으로 남고, 명부가 줄면 행도 같은 수만큼 줆.
//   판정(tone·문장)은 health 카드 모델이, 노드 목록은 /live 의 part_bindings 가 냄 — 어느 쪽도 여기서
//   다시 재지 않음. 판정을 못 받은 행은 tone 을 아예 싣지 않음: 미수신과 정상은 다른 사실임.
function getHealthPartRows(cardStates, partBindings) {
	const model = window.HealthModel;
	if (!model || typeof model.resolveCardFacts !== "function") return [];

	return (model.HEALTH_CARD_DEFS || []).map((def) => {
		const facts = model.resolveCardFacts(def, cardStates);
		const isReady = facts.status === "ready";

		return {
			id: def.id,
			name: def.name,
			kind: def.kind,
			// 데몬 행만 드릴다운 이름을 듦 — 나머지 행에는 부를 데몬이 없음.
			daemonName: def.kind === "daemon" ? def.daemonName : null,
			tone: isReady ? facts.tone : null,
			statusLabel: isReady ? getPartStatusLabel(def, facts) : null,
			// 마지막 실행은 데몬 행만 갖는 사실임 — 나머지 칸은 비어 있음이 정답임.
			lastRunAt: isReady && facts.daemon ? facts.daemon.last_run_at || null : null,
			nodeIds: partBindings?.[def.id] || [],
		};
	});
}

// 행의 상태 문장 — 데몬 행은 데몬 배지 표를 씀(stale 은 'Overdue' 라서 crit 의 기본 문장과 다름).
// 나머지는 tone 기본 문장을 씀. 어느 쪽도 이 파일이 새로 짓지 않음 (ui.jsx 단일 SoT).
function getPartStatusLabel(def, facts) {
	if (def.kind === "daemon" && facts.daemon)
		return window.UI.daemonStatusLabel(facts.daemon.effective_status);
	return window.UI.resolveBadge(facts.tone).label;
}

// unscoped mermaid node id → 링 tone — 데몬 판정과 부품 판정을 한 표로 접음.
//   데몬 tone 은 서버 effective_status 를, 부품 tone 은 health 카드 모델을 그대로 소비함.
//   어느 쪽도 여기서 다시 재지 않음 — 같은 입력에 답이 둘이 되면 링과 카드 격자가 갈라짐.
//   판정을 못 받은 부품(status !== 'ready')은 항목을 만들지 않음.
//   미도착과 정상은 다른 사실임.
function buildRingToneByNodeId(daemonsByNodeId, partBindings, cardStates) {
	const byNodeId = new Map();

	const putTone = (nodeId, tone) => {
		if (!nodeId || !RING_TONE_RANK[tone]) return;
		const prev = byNodeId.get(nodeId);
		if (prev && RING_TONE_RANK[prev] >= RING_TONE_RANK[tone]) return;
		byNodeId.set(nodeId, tone);
	};

	// daemons store not answered → the /live statuses carry no verdict the headline stands behind.
	if (cardStates?.daemonState?.status === "ready")
		for (const [nodeId, daemons] of daemonsByNodeId) {
			for (const d of daemons || [])
				putTone(nodeId, window.UI.daemonStatusTone(d?.effective_status));
		}

	const model = window.HealthModel;
	if (!model || typeof model.resolveCardFacts !== "function") return byNodeId;

	for (const def of model.HEALTH_CARD_DEFS || []) {
		const facts = model.resolveCardFacts(def, cardStates);
		if (facts.status !== "ready") continue;

		for (const nodeId of partBindings?.[def.id] || []) putTone(nodeId, facts.tone);
	}

	return byNodeId;
}

// the source draws arrows onto the enclosing zone, so a member's connections are its zone's.
function getFlowEndpointIdsAR(nodeId, zoneIdByMemberId) {
	const unscopedId = unscopedNodeIdAR(nodeId);
	const zoneId = zoneIdByMemberId?.get(unscopedId);
	const endpointIds = new Set([nodeId]);
	if (zoneId) endpointIds.add(nodeId.slice(0, nodeId.length - unscopedId.length) + zoneId);

	return endpointIds;
}

// warn/crit always shows; 'No data' (info) shares the dashed ring with a part that was never read.
function getRingClassAR(tone, ringClassByTone, isUnverified, unverifiedClass) {
	if (tone === "warn" || tone === "crit") return ringClassByTone[tone];
	if (isUnverified || tone === "info") return unverifiedClass;
	return ringClassByTone[tone] || null;
}

// 판정을 못 받은 부품의 바인딩 노드 — 머리글 넷 중 아직 답하지 않았거나 못 읽은 카드의 것.
// null = bindings not loaded — which nodes carry health is unknown, so no node may read as judged.
function buildUnverifiedNodeIds(partBindings, cardStates) {
	if (!partBindings) return null;

	const ids = new Set();

	// no health model → no part is judged, so every bound node is unverified.
	const model = window.HealthModel;
	if (!model || typeof model.resolveCardFacts !== "function") {
		for (const nodeIds of Object.values(partBindings)) for (const nodeId of nodeIds || []) ids.add(nodeId);
		return ids;
	}

	for (const def of model.HEALTH_CARD_DEFS || []) {
		const facts = model.resolveCardFacts(def, cardStates);
		if (facts.status === "ready") continue;

		for (const nodeId of partBindings?.[def.id] || []) ids.add(nodeId);
	}

	return ids;
}

// 존 하나가 헬스 노드를 정확히 하나만 담을 때, 그 판정은 노드가 아니라 존 상자가 냄.
//   근거는 이미 있는 자료 둘뿐임 — 그려지는 mermaid 소스의 subgraph 블록(어느 노드가 어느 존인가)과
//   /live 의 part_bindings(어느 노드가 판정을 받을 수 있는가). 존 이름을 여기 적어 두면 존이 늘거나
//   갈릴 때 지도만 조용히 어긋나므로, 이름은 한 줄도 적지 않음.
//   기준이 '판정이 지금 와 있는가' 가 아니라 '판정을 받을 수 있는가' 인 이유: 앞의 것으로 재면
//   폴링이 한 번 늦을 때마다 같은 사실이 존과 노드 사이를 오가며 깜빡임.
//   subgraph 중첩은 다루지 않음 — content-budget 의 subgraphDepth 상한이 1 이라 중첩이 오면
//   그쪽이 먼저 붉어짐.
function buildZoneRingPlanAR(source, partBindings) {
	const healthNodeIds = new Set();
	for (const nodeIds of Object.values(partBindings || {}))
		for (const nodeId of nodeIds || []) healthNodeIds.add(nodeId);

	const nodeIdByZoneId = new Map();
	const zoneByNodeId = new Map();
	const zoneIdByMemberId = new Map();

	let zoneId = "";
	let inZone = [];
	for (const raw of String(source || "").split("\n")) {
		const line = raw.trim();

		const opened = /^subgraph\s+([A-Za-z_][\w-]*)/.exec(line);
		if (opened) {
			zoneId = opened[1];
			inZone = [];
			continue;
		}
		if (line === "end") {
			if (zoneId && inZone.length === 1) {
				nodeIdByZoneId.set(zoneId, inZone[0]);
				zoneByNodeId.set(inZone[0], zoneId);
			}
			zoneId = "";
			continue;
		}
		if (!zoneId) continue;

		// 선언 줄만 셈 — 여는 괄호가 붙은 첫 토큰. 엣지 줄과 `end` 는 여기서 걸러짐.
		const declared = /^([A-Za-z_][\w-]*)\s*[[({]/.exec(line);
		if (!declared) continue;

		zoneIdByMemberId.set(declared[1], zoneId);
		if (healthNodeIds.has(declared[1])) inZone.push(declared[1]);
	}

	return {
		zoneIds: [...nodeIdByZoneId.keys()],
		nodeIdByZoneId,
		zoneByNodeId,
		zoneIdByMemberId,
	};
}

// zones whose only member's label opens with the zone's own title — the title just repeats the box inside it
function buildRedundantZoneIdsAR(source) {
	const redundant = new Set();
	let zone = null;
	for (const raw of String(source || "").split("\n")) {
		const line = raw.trim();
		const opened = /^subgraph\s+([A-Za-z_][\w-]*)(?:\s*\["?(.*?)"?\])?/.exec(line);
		if (opened) {
			zone = { id: opened[1], title: getPlainLabelAR(opened[2] || opened[1]), labels: [] };
			continue;
		}
		if (line === "end") {
			if (zone && zone.labels.length === 1 && zone.labels[0].startsWith(zone.title)) redundant.add(zone.id);
			zone = null;
			continue;
		}
		const declared = zone && /^[A-Za-z_][\w-]*\s*[[({]+"?(.*?)"?[\])}]+\s*$/.exec(line);
		if (declared) zone.labels.push(getPlainLabelAR(declared[1]));
	}
	return redundant;
}

/**
 * Refits every zone box to its members.
 * ELK sizes a zone from its members alone; mermaid then widens the rect to the unwrapped title around the zone
 * centre, which can spill it into the next column — a zone that collides wraps its title inside the member width.
 * Zones clear of every other keep their one-line title: wrapping them only adds a line that grows into the zone above.
 */
function fitZoneBoxesAR(root, source) {
	const { zoneIdByMemberId } = buildZoneRingPlanAR(source, {});
	const zoneIds = [...new Set(zoneIdByMemberId.values())];
	const nodeEls = [...root.querySelectorAll("svg g.node")];
	const zoneEls = [...root.querySelectorAll("svg g.cluster")];
	const crowdedZoneEls = getCrowdedZonesAR(zoneEls);

	zoneEls.forEach((zoneEl) => {
		const zoneId = matchZoneIdAR(zoneEl.id || "", zoneIds);
		const rect = zoneEl.querySelector(":scope > rect");
		if (!zoneId || !rect || rect.dataset.archZoneFit === "1") return;
		const members = nodeEls.filter((el) => zoneIdByMemberId.get(getSourceNodeIdAR(el.id)) === zoneId);
		const memberBox = getUnionBoxAR(rect, members);
		if (!memberBox) return;

		rect.dataset.archZoneFit = "1";
		if (zoneEl.classList.contains(ZONE_TITLE_REDUNDANT_CLASS)) trimZoneTopAR(rect, memberBox);
		else if (crowdedZoneEls.has(zoneEl)) wrapZoneTitleAR(zoneEl, rect, memberBox);
	});
}

// zones whose drawn box runs into another zone's box — zone rects share one parent group, so their bboxes compare directly
function getCrowdedZonesAR(zoneEls) {
	const boxes = zoneEls.map((el) => el.querySelector(":scope > rect")?.getBBox());
	const crowded = new Set();
	boxes.forEach((a, i) =>
		boxes.forEach((b, j) => {
			if (i >= j || !a || !b) return;
			if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
				crowded.add(zoneEls[i]);
				crowded.add(zoneEls[j]);
			}
		}),
	);
	return crowded;
}

// a title line gained above a zone can pass the viewBox top → the fit reads the viewBox, so it grows to cover the drawing
function growViewBoxToContentAR(svgEl) {
	const view = svgEl?.viewBox?.baseVal;
	if (!view || !(view.width > 0)) return;
	const drawn = svgEl.getBBox();
	const left = Math.min(view.x, drawn.x - ZONE_TITLE_BAND);
	const top = Math.min(view.y, drawn.y - ZONE_TITLE_BAND);
	const right = Math.max(view.x + view.width, drawn.x + drawn.width + ZONE_TITLE_BAND);
	const bottom = Math.max(view.y + view.height, drawn.y + drawn.height + ZONE_TITLE_BAND);
	if (left === view.x && top === view.y && right === view.x + view.width && bottom === view.y + view.height) return;
	svgEl.setAttribute("viewBox", `${left} ${top} ${right - left} ${bottom - top}`);
}

// mermaid node element id `…flowchart-<sourceId>-<n>` → the source id
function getSourceNodeIdAR(elementId) {
	return /flowchart-(.+)-\d+$/.exec(elementId || "")?.[1] ?? "";
}

// members' union box in the frame's user space — nodes and zones sit in sibling groups with different CTMs
function getUnionBoxAR(frameEl, shapeEls) {
	const toFrame = frameEl.getCTM()?.inverse();
	if (!toFrame || shapeEls.length === 0) return null;

	const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
	for (const el of shapeEls) {
		const ctm = el.getCTM();
		if (!ctm) return null;
		const b = el.getBBox();
		const m = toFrame.multiply(ctm);
		box.left = Math.min(box.left, b.x * m.a + m.e);
		box.top = Math.min(box.top, b.y * m.d + m.f);
		box.right = Math.max(box.right, (b.x + b.width) * m.a + m.e);
		box.bottom = Math.max(box.bottom, (b.y + b.height) * m.d + m.f);
	}
	return box;
}

// hidden title → the band reserved for it goes too; the bottom edge stays
function trimZoneTopAR(rect, memberBox) {
	const bottom = Number.parseFloat(rect.getAttribute("y")) + Number.parseFloat(rect.getAttribute("height"));
	const top = memberBox.top - ZONE_PAD;
	rect.setAttribute("y", String(top));
	rect.setAttribute("height", String(bottom - top));
}

// title wrapped to the member width, box hugging members; a title line gained or lost moves the top edge only
function wrapZoneTitleAR(zoneEl, rect, memberBox) {
	const titleEl = zoneEl.querySelector(":scope > .cluster-label");
	const frameEl = titleEl?.querySelector("foreignObject");
	const textEl = frameEl?.firstElementChild;
	const at = /translate\(\s*([-\d.e]+)[\s,]+([-\d.e]+)\s*\)/.exec(titleEl?.getAttribute("transform") || "");
	if (!textEl || !at) return;

	const title = getWrappedTitleSizeAR(textEl, memberBox.right - memberBox.left);
	const addedHeight = title.height - Number.parseFloat(frameEl.getAttribute("height"));
	const centerX = (memberBox.left + memberBox.right) / 2;
	const zoneWidth = title.width + ZONE_PAD * 2;

	frameEl.setAttribute("width", String(title.width));
	frameEl.setAttribute("height", String(title.height));
	titleEl.setAttribute("transform", `translate(${centerX - title.width / 2}, ${Number(at[2]) - addedHeight})`);
	rect.setAttribute("x", String(centerX - zoneWidth / 2));
	rect.setAttribute("width", String(zoneWidth));
	rect.setAttribute("y", String(Number.parseFloat(rect.getAttribute("y")) - addedHeight));
	rect.setAttribute("height", String(Number.parseFloat(rect.getAttribute("height")) + addedHeight));
}

// mermaid pre-breaks the title for a narrower font → drop those breaks and let the drawn font wrap at word boundaries
function getWrappedTitleSizeAR(textEl, maxWidth) {
	textEl.querySelectorAll("br").forEach((br) => br.replaceWith(" "));
	Object.assign(textEl.style, { whiteSpace: "normal", width: `${maxWidth}px`, maxWidth: `${maxWidth}px` });
	// a word longer than the member width widens the box rather than being cut
	return { width: Math.max(maxWidth, textEl.offsetWidth), height: textEl.offsetHeight };
}

// source label → the words the map draws: line breaks as spaces, compared case-blind
function getPlainLabelAR(label) {
	return normalizeLabelAR(String(label).replace(/<br\s*\/?>/gi, " "));
}

// mermaid 가 존 g 에 붙이는 id 는 `${renderId}-${zoneId}` 이고 renderId 는 렌더마다 새로 지어짐 —
// 앞부분을 화면이 모르므로 뒤에서 맞춤. 하이픈 경계를 함께 봐서 `data` 가 `metadata` 를 물지 않게 하고,
// 가장 긴 일치를 골라 한 존 id 가 다른 존 id 의 꼬리인 경우까지 가름.
function matchZoneIdAR(elementId, zoneIds) {
	let matched = "";
	for (const zoneId of zoneIds) {
		if (elementId !== zoneId && !elementId.endsWith(`-${zoneId}`)) continue;
		if (zoneId.length > matched.length) matched = zoneId;
	}
	return matched;
}

const SVG_NS_AR = "http://www.w3.org/2000/svg";

// 도형 bbox 를 따 링 사각형 하나를 그 g 안에 심음 (없으면 만들고, 있으면 좌표만 갱신).
//   g 안에 두므로 그룹 transform 을 그대로 물려받아 도형과 같은 좌표계에서 잼.
//   mermaid 가 만들지 않은 element 라 classDef 인라인 !important 와 겹칠 자리가 없음.
//   이미 심은 링은 셈에서 뺌 — 안 빼면 두 번째 호출이 링의 bbox 를 재서 매번 한 겹씩 커짐.
function ensureRingRectAR(groupEl, ringClass) {
	const box = getShapeBoxAR(groupEl);
	if (!box) return null;

	let ring = groupEl.querySelector(`:scope > rect.${ringClass}`);
	if (!ring) {
		ring = document.createElementNS(SVG_NS_AR, "rect");
		ring.setAttribute("class", `arch-ring ${ringClass}`);
		groupEl.appendChild(ring);
	}
	const geometry = getRingGeometryAR(box, ringClass);
	for (const [attr, value] of Object.entries(geometry)) ring.setAttribute(attr, String(value));
	return ring;
}

// ring rect around a shape box — the focus ring takes a wider gap than the health ring.
function getRingGeometryAR(box, ringClass) {
	const gap = RING_GAP_BY_CLASS[ringClass] ?? RING_GAP;
	const radius = NODE_CORNER_RADIUS + gap;
	return { x: box.x - gap, y: box.y - gap, width: box.width + gap * 2, height: box.height + gap * 2, rx: radius, ry: radius };
}

/**
 * 모서리 글리프 — 링과 같은 g 안에 심어 한 좌표계를 씀. tone 이 없으면 지움:
 * 남겨 두면 판정이 바뀐 노드가 옛 표식을 계속 실어 색과 글리프가 서로 다른 말을 함.
 */
function setCornerGlyphAR(groupEl, tone, attentionCount) {
	const mark = getCornerGlyphTextAR(tone, attentionCount);
	const existing = groupEl.querySelector(`:scope > text.${RING_GLYPH_CLASS}`);

	if (!mark) {
		if (existing) existing.remove();
		return;
	}

	const box = getShapeBoxAR(groupEl);
	if (!box) return;

	const glyph =
		existing || document.createElementNS(SVG_NS_AR, "text");
	if (!existing) {
		glyph.setAttribute("class", RING_GLYPH_CLASS);
		groupEl.appendChild(glyph);
	}
	glyph.setAttribute("x", String(box.x + box.width + RING_GAP));
	glyph.setAttribute("y", String(box.y - RING_GAP));
	glyph.textContent = mark;
}

function getShapeBoxAR(groupEl) {
	const shape = groupEl.querySelector(
		":scope > :is(rect, path, polygon, circle, ellipse):not(.arch-ring)",
	);
	if (!shape) return null;

	let box = null;
	try {
		box = shape.getBBox();
	} catch {
		return null;
	}
	if (!box || !(box.width > 0) || !(box.height > 0)) return null;
	return box;
}

/**
 * Re-appends the focusable map nodes in flow order so Tab follows the left-to-right flow.
 * Each node moves only within its own parent group and keeps its transform → nothing moves on screen.
 */
function setFlowTabOrderAR(root) {
	const stops = [...root.querySelectorAll('svg g.node[tabindex="0"]')].map((el) => {
		const box = el.getBoundingClientRect();
		return { el, cx: box.left + box.width / 2, top: box.top, width: box.width };
	});
	if (stops.length < 2 || stops.some((stop) => !(stop.width > 0))) return;
	for (const { el } of getFlowOrderAR(stops)) el.parentNode.appendChild(el);
}

// column by column, top to bottom — a column = centres within half the narrowest node of its first node
function getFlowOrderAR(stops) {
	const tolerance = Math.min(...stops.map((stop) => stop.width)) / 2;
	const columns = [];
	for (const stop of [...stops].sort((a, b) => a.cx - b.cx)) {
		const column = columns.at(-1);
		if (column && stop.cx - column[0].cx <= tolerance) column.push(stop);
		else columns.push([stop]);
	}
	return columns.flatMap((column) => column.sort((a, b) => a.top - b.top));
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
// the font-parity harness renders its baseline with the same override the canvas measured with
window.ARCH_MAP_LABEL_DIRECTIVE = MAP_LABEL_DIRECTIVE;
