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

// 가독 fit floor — 초기 줌의 선호 하한 (작은 그래프를 너무 작게 굳히지 않음) · widthFit 보다 클 땐 widthFit 으로 상한 클램프되어 우측 클리핑 0.
const LEGIBLE_FIT_FLOOR = 0.6;

// svg-pan-zoom 라이브러리 minZoom — LEGIBLE_FIT_FLOOR 보다 낮아야 함. 넓은 LR 그래프의 전폭 fit 비율이 floor 미만일 때
//   라이브러리가 zoom() 호출을 minZoom 으로 되끌어올려 우측이 다시 잘리는 것을 차단 (전폭 fit 우선, 과도한 사용자 줌아웃만 방지).
const PAN_ZOOM_MIN = 0.2;

const ROLE_LABEL = {
	entry: "Entry",
	orchestration: "Coordination",
	execution: "Execution",
	data: "Data",
	feedback: "Feedback",
	monitoring: "Monitoring",
	gateway: "Gateway",
};

const ROLE_BORDER = {
	entry: "#38bdf8",
	orchestration: "#a78bfa",
	execution: "#4ade80",
	data: "#fbbf24",
	feedback: "#f472b6",
	monitoring: "#f87171",
	gateway: "#94a3b8",
};

const NODE_TYPE_BG = {
	agent: "#1e293b",
	hook: "#312e81",
	script: "#1e3a8a",
	daemon: "#7c2d12",
	store: "#713f12",
	external: "#374151",
	gateway: "#1f2937",
};

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

const EDGE_TYPE_LABEL = {
	control_flow: "Controls",
	data_flow: "Data",
	fires_event: "Event",
	writes_to: "Writes",
	reads_from: "Reads",
	monitors: "Watches",
	escalates_to: "Escalates",
	triggers: "Triggers",
};

// tone → SVG node 라이브 ring 클래스. daemonEffectiveTone 결과를 그대로 키로 사용 (neutral/info = ring 없음).
const LIVE_TONE_CLASS = {
	ok: "arch-node-live-ok",
	warn: "arch-node-live-warn",
	crit: "arch-node-live-crit",
};

// ring tone severity 순위 — 복수 daemon fold 시 최악값 선택용. neutral/info = ring 없음(0).
const LIVE_TONE_RANK = { crit: 3, warn: 2, ok: 1 };

// 탭 정의 (백엔드 diagram id 와 매칭) — order = 사용자 멘탈 모델 순서.
const TAB_ORDER = [
	"v2-overview-entry",
	"v2-overview-data",
	"v2-hooks",
	"v2-loops-learn",
	"v2-loops-autoagent",
	"v2-team-orchestration",
	"v2-team-docs",
];
const TAB_LABEL_FALLBACK = {
	"v2-overview-entry": "Entry & coordination",
	"v2-overview-data": "Data, docs & learning",
	"v2-hooks": "Hook pipeline",
	"v2-loops-learn": "Learning loop",
	"v2-loops-autoagent": "Self-improvement loop",
	"v2-team-orchestration": "Team coordination",
	"v2-team-docs": "Team & doc storage",
};

// 다이어그램별 1줄 목적 — 탭 tooltip + 활성 탭 하단 목적 라인. API description 부재 시 fallback.
const TAB_PURPOSE = {
	"v2-overview-entry": "How external input wakes the orchestrator and reaches the agent team.",
	"v2-overview-data": "Where hook signals land and how data, docs and learning are stored.",
	"v2-hooks": "The serial PreTool gate family that guards every tool call.",
	"v2-loops-learn": "Four stages that accumulate task outcomes into reusable patterns.",
	"v2-loops-autoagent": "How accumulated patterns promote into applied self-improvements.",
	"v2-team-orchestration": "The orchestrator's 4-phase workflow and verification gates.",
	"v2-team-docs": "Document authoring, completion and storage after coordination.",
};

// 활성 다이어그램의 1줄 목적 — API description 첫 문장 우선, 부재 시 정적 맵.
function diagramPurposeAR(diagram) {
	if (!diagram) return "";
	const desc = typeof diagram.description === "string" ? diagram.description.trim() : "";
	if (desc) {
		const firstSentence = desc.split(/(?<=[.。])\s/)[0];
		return truncateText(firstSentence || desc, 140);
	}
	return TAB_PURPOSE[diagram.id] || "";
}

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

	const [refreshTick, setRefreshTick] = useStateAR(0);

	// 활성 탭 (diagram.id) — 첫 fetch 후 첫 다이어그램으로 자동 설정.
	const [activeId, setActiveId] = useStateAR(null);

	// 노드 상세 modal — null 이면 닫힘. payload = { kind, payload, diagramId }
	const [detail, setDetail] = useStateAR(null);

	// 범례 포커스 — { dim: "role"|"type", key } 또는 null. 클릭 시 해당 분류 노드 강조·나머지 dim.
	const [legendFocus, setLegendFocus] = useStateAR(null);

	const diagAbortRef = useRefAR(null);
	const liveAbortRef = useRefAR(null);

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

	// ── derived data ──────────────────────────────────────────────────────────

	const diagrams = useMemoAR(() => {
		const all =
			diagState.status === "ready" ? diagState.data?.diagrams || [] : [];
		// TAB_ORDER 우선 정렬, 그 외는 끝에 부착
		const indexed = new Map(all.map((d) => [d.id, d]));
		const ordered = [];
		for (const id of TAB_ORDER) {
			if (indexed.has(id)) {
				ordered.push(indexed.get(id));
				indexed.delete(id);
			}
		}
		for (const d of indexed.values()) ordered.push(d);
		return ordered;
	}, [diagState.status, diagState.data]);

	// 첫 fetch 후 activeId 미설정 → 첫 다이어그램으로 자동 설정.
	useEffectAR(() => {
		if (activeId) return;
		if (diagrams.length === 0) return;
		setActiveId(diagrams[0].id);
	}, [activeId, diagrams]);

	const activeDiagram = useMemoAR(
		() => diagrams.find((d) => d.id === activeId) || null,
		[diagrams, activeId],
	);

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

	// 활성 diagram 에 실제 존재하는 role/node-type/edge-type 집합 — 범례를 실제 사용분으로만 노출.
	const legendUsedSets = useMemoAR(() => {
		const roles = new Set();
		const nodeTypes = new Set();
		const edgeTypes = new Set();
		if (!activeDiagram) return { roles, nodeTypes, edgeTypes };
		for (const layer of activeDiagram.layers || []) {
			if (layer.role) roles.add(layer.role);
			for (const node of layer.nodes || []) if (node.type) nodeTypes.add(node.type);
		}
		for (const flow of activeDiagram.flows || [])
			if (flow.edge_type) edgeTypes.add(flow.edge_type);
		return { roles, nodeTypes, edgeTypes };
	}, [activeDiagram]);

	// unscoped mermaid node id → daemon 목록 — 서버 DAEMON_NODE_BINDINGS(node_ids) 가 ring 점등의 유일 근거 (F32).
	//   한 노드에 복수 daemon 바인딩 가능(cron: daily-restart-autoagent/-wiki) → id 당 목록 보존, last-writer-wins 드롭 방지 (F39).
	const liveDaemonsByNodeId = useMemoAR(() => {
		if (liveState.status !== "ready") return new Map();
		return buildLiveDaemonsByNodeId(liveState.data?.daemons);
	}, [liveState.status, liveState.data]);

	const handleSelectNode = useCallbackAR(
		(nodeId) => {
			if (!nodeId) return;
			setDetail({ kind: "node", payload: { id: nodeId }, diagramId: activeId });
		},
		[activeId],
	);

	const closeDetail = useCallbackAR(() => setDetail(null), []);

	const handleTabChange = useCallbackAR(
		(id) => {
			if (id === activeId) return;
			setDetail(null); // 탭 변경 시 상세 자동 닫기 (서로 다른 다이어그램이라 컨텍스트 끊김)
			setLegendFocus(null); // 탭 변경 시 범례 포커스 해제 (노드 집합이 달라져 무효)
			setActiveId(id);
		},
		[activeId],
	);

	// 범례 항목 토글 — 같은 항목 재클릭 시 해제, 다른 항목 클릭 시 교체.
	const toggleLegendFocus = useCallbackAR((dim, key) => {
		setLegendFocus((prev) =>
			prev && prev.dim === dim && prev.key === key ? null : { dim, key },
		);
	}, []);

	// 설계도 카운트 드리프트(구조 정합성) — daemon status(런타임 헬스)와 별개 신호.
	//   live 응답 ready 시점에만 신뢰. diffs = [{ key, claimed, actual }].
	const driftStale =
		liveState.status === "ready" && liveState.data?.stale === true;
	const driftDiffs = driftStale ? liveState.data?.diffs || [] : [];

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
					".arch-live-strip-group { display: flex; align-items: center; gap: 6px; flex-shrink: 0; } " +
					".arch-live-strip-sep { width: 1px; height: 16px; background: rgb(var(--line)); flex-shrink: 0; } " +
					".arch-live-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border-radius: 999px; " +
					'background: rgb(var(--elev)); font-size: var(--fs-meta); font-family: "JetBrains Mono", monospace; white-space: nowrap; } ' +
					// 범례 접이식 — 기본 닫힘. summary 클릭으로 노출, 캔버스 폭 미점유.
					".arch-legend-details { flex-shrink: 0; background: rgb(var(--sunken)); border: 1px solid rgb(var(--line)); border-radius: 6px; } " +
					".arch-legend-details > summary { cursor: pointer; padding: 6px 10px; font-size: var(--fs-meta); color: rgb(var(--dim)); " +
					"list-style: none; user-select: none; display: flex; align-items: center; gap: 8px; } " +
					".arch-legend-details > summary::-webkit-details-marker { display: none; } " +
					".arch-legend-details[open] > summary { border-bottom: 1px solid rgb(var(--line)); } " +
					// 펼친 범례 = 3그룹 가로 분배 (캔버스 높이 미잠식, 하단 1회성 노출).
					".arch-legend-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px 18px; padding: 10px; align-items: start; } " +
					// svg-pan-zoom: overflow:hidden 으로 viewBox 밖 클리핑, svg 100%×100% + max-width none.
					".arch-mermaid-canvas { width: 100%; flex: 1; min-height: 0; background: rgb(var(--sunken)); border-radius: 6px; overflow: hidden; position: relative; padding: 0; } " +
					".arch-mermaid-canvas svg { width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important; display: block; font-family: Pretendard, system-ui, sans-serif !important; } " +
					// 노드 라벨 — fill/weight 만 가독 보정. font-size 는 mermaid init(index.html, 14px)이 노드 박스 폭을 산정한 값과 일치시켜야 라벨이 박스를 넘쳐 단어 중간 잘림이 발생하지 않음 (15px 강제는 박스보다 넓어 클리핑 원인 → 14px 로 정렬).
					".arch-mermaid-canvas svg .nodeLabel, .arch-mermaid-canvas svg .node text, .arch-mermaid-canvas svg .node .label, .arch-mermaid-canvas svg .node foreignObject span { fill: rgb(var(--ink)) !important; color: rgb(var(--ink)) !important; font-size: 14px !important; font-weight: 500 !important; } " +
					// pan-drag 중 SVG 텍스트 select 차단 (클릭/줌/팬 보존).
					".arch-mermaid-canvas { user-select: none; -webkit-user-select: none; } " +
					// 줌 floor 힌트 — 캔버스 우하단 작은 안내 (가독 fit 적용됨 = 휠/드래그로 탐색).
					".arch-canvas-hint { position: absolute; right: 8px; bottom: 6px; font-size: var(--fs-micro); " +
					'color: rgb(var(--faint)); font-family: "JetBrains Mono", monospace; pointer-events: none; ' +
					"background: rgb(var(--surface) / 0.7); padding: 1px 6px; border-radius: 4px; } " +
					".arch-mermaid-canvas .node { cursor: pointer; transition: opacity .12s; } " +
					".arch-mermaid-canvas .node:hover { opacity: 0.78; } " +
					// 라이브 ring stroke 은 severity 토큰 소비 — !important 는 mermaid 주입 SVG 노드 스타일 override 위해 보존 필수.
					".arch-mermaid-canvas .node.arch-node-live-ok rect, .arch-mermaid-canvas .node.arch-node-live-ok polygon { stroke: rgb(var(--ok)) !important; stroke-width: 2.5 !important; } " +
					".arch-mermaid-canvas .node.arch-node-live-warn rect, .arch-mermaid-canvas .node.arch-node-live-warn polygon { stroke: rgb(var(--warn)) !important; stroke-width: 2.5 !important; } " +
					".arch-mermaid-canvas .node.arch-node-live-crit rect, .arch-mermaid-canvas .node.arch-node-live-crit polygon { stroke: rgb(var(--crit)) !important; stroke-width: 2.5 !important; } " +
					// 탭은 단일 스크롤 행 — 줄바꿈(wrap) 시 캔버스 높이 잠식 → nowrap + 가로 스크롤. inactive=--dim(아래), active 반전(아래).
					".arch-tabs-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: nowrap; overflow-x: auto; } " +
					".arch-tab-btn { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 6px; " +
					"background: rgb(var(--sunken)); border: 1px solid rgb(var(--line)); color: rgb(var(--dim)); " +
					"font-size: var(--fs-body); cursor: pointer; transition: all .12s; font-family: Pretendard, system-ui, sans-serif; } " +
					".arch-tab-btn:hover { color: rgb(var(--ink)); background: rgb(var(--elev)); } " +
					".arch-tab-btn.active { background: rgb(var(--ink)); color: rgb(var(--surface)); border-color: rgb(var(--ink)); font-weight: 600; } " +
					'.arch-tab-btn .arch-tab-counts { font-family: "JetBrains Mono", monospace; font-size: var(--fs-micro); opacity: 0.75; } ' +
					".arch-legend-swatch-box { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; } " +
					".arch-legend-swatch-line { width: 16px; height: 2px; flex-shrink: 0; } " +
					// 활성 탭 1줄 목적 — 탭 스트립 바로 아래, 캔버스 폭 미점유.
					".arch-tab-purpose { flex-shrink: 0; margin-bottom: 6px; font-size: var(--fs-meta); color: rgb(var(--dim)); line-height: 1.4; } " +
					// 줌/팬/맞춤 컨트롤 클러스터 — 캔버스 우하단, hint 위. 불투명 면(상시 chrome) → blur 금지.
					".arch-zoom-controls { position: absolute; right: 8px; bottom: 28px; display: flex; flex-direction: column; gap: 4px; z-index: 2; } " +
					".arch-zoom-btn { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; " +
					"background: rgb(var(--elev)); border: 1px solid rgb(var(--line)); border-radius: 6px; color: rgb(var(--dim)); " +
					'cursor: pointer; font-family: "JetBrains Mono", monospace; font-size: 16px; line-height: 1; padding: 0; transition: all .12s; } ' +
					".arch-zoom-btn:hover { color: rgb(var(--ink)); border-color: rgb(var(--faint)); background: rgb(var(--surface-raised-2, var(--elev))); } " +
					".arch-zoom-btn:focus-visible { outline: 2px solid rgb(var(--accent)); outline-offset: 1px; } " +
					// 범례 항목 = focusable 버튼. 클릭/Enter → 해당 role 강조, 나머지 노드 dim (context-dim).
					".arch-legend-item { width: 100%; min-width: 0; text-align: left; background: none; border: none; padding: 1px 2px; border-radius: 4px; cursor: pointer; transition: background-color .12s; } " +
					".arch-legend-item:hover { background: rgb(var(--elev)); } " +
					".arch-legend-item:focus-visible { outline: 2px solid rgb(var(--accent)); outline-offset: 1px; } " +
					".arch-legend-item.active { background: rgb(var(--accent) / 0.12); } " +
					// 범례 포커스 시 비대상 노드 dim — 색 정보는 유지, 대비만 낮춤 (severity flood 아님).
					".arch-mermaid-canvas.legend-focus .node:not(.legend-hit) { opacity: 0.28; } " +
					".arch-mermaid-canvas.legend-focus .node.legend-hit { opacity: 1; } " +
					// 키보드 포커스 노드 ring — 클릭 가능 노드의 a11y focus 표식.
					".arch-mermaid-canvas .node:focus-visible rect, .arch-mermaid-canvas .node:focus-visible polygon { stroke: rgb(var(--accent)) !important; stroke-width: 2.5 !important; } " +
					// 신규 모션 게이트 — skeleton pulse + 노드/범례 transition 정지 (§8.4 계약).
					"@media (prefers-reduced-motion: reduce) { " +
					"[style*=\"skelPulseAR\"], .arch-mermaid-canvas .node, .arch-zoom-btn, .arch-legend-item, .arch-tab-btn { animation: none !important; transition: none !important; } }"}
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
				{driftStale && <DriftBannerAR diffs={driftDiffs} />}

				{/* 상단: 라이브 상태 가로 컴팩트 스트립 (좌측 컬럼 폐기 → 캔버스 폭 회수) */}
				<LiveStrip state={liveState} onRetry={triggerRefresh} />

				{/* 본체: 탭 + Mermaid 캔버스 (가용 폭 100%) */}
				<div className="arch-main">
					<DiagramTabs
						diagrams={diagrams}
						activeId={activeId}
						activeDiagram={activeDiagram}
						onChange={handleTabChange}
					/>
					<DiagramCanvasCard
						diagState={diagState}
						activeDiagram={activeDiagram}
						nodeByLabel={nodeByLabel}
						nodeIndex={nodeIndex}
						liveDaemonsByNodeId={liveDaemonsByNodeId}
						legendFocus={legendFocus}
						onSelectNode={handleSelectNode}
						onRetry={triggerRefresh}
					/>
				</div>

				{/* 하단: 범례 접이식 (기본 닫힘 → 캔버스 폭/높이 미점유) */}
				<LegendDetails
					activeDiagram={activeDiagram}
					legendUsedSets={legendUsedSets}
					legendFocus={legendFocus}
					onToggleFocus={toggleLegendFocus}
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

// Tabs row

function DiagramTabs({ diagrams, activeId, activeDiagram, onChange }) {
	if (diagrams.length === 0) {
		return (
			<div className="arch-tabs-row">
				<span className="fs-meta text-faint">Loading diagrams…</span>
			</div>
		);
	}
	return (
		<>
			<div
				className="arch-tabs-row"
				role="tablist"
				aria-label="Select a diagram"
			>
				{diagrams.map((d) => {
					const active = d.id === activeId;
					const label = d.title || TAB_LABEL_FALLBACK[d.id] || d.id;
					return (
						<button
							key={d.id}
							type="button"
							role="tab"
							aria-selected={active}
							title={diagramPurposeAR(d) || label}
							className={`arch-tab-btn ${active ? "active" : ""}`}
							onClick={() => onChange(d.id)}
						>
							<span>{label}</span>
						</button>
					);
				})}
			</div>
		</>
	);
}

// Diagram canvas card (Mermaid native rendering)

function DiagramCanvasCard({
	diagState,
	activeDiagram,
	nodeByLabel,
	nodeIndex,
	liveDaemonsByNodeId,
	legendFocus,
	onSelectNode,
	onRetry,
}) {
	return (
		<div className="card arch-col-card">
			<div className="card-body" style={{ padding: 10 }}>
				<DiagramBody
					diagState={diagState}
					activeDiagram={activeDiagram}
					nodeByLabel={nodeByLabel}
					nodeIndex={nodeIndex}
					liveDaemonsByNodeId={liveDaemonsByNodeId}
					legendFocus={legendFocus}
					onSelectNode={onSelectNode}
					onRetry={onRetry}
				/>
			</div>
		</div>
	);
}

function DiagramBody({
	diagState,
	activeDiagram,
	nodeByLabel,
	nodeIndex,
	liveDaemonsByNodeId,
	legendFocus,
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
			diagramDescription={activeDiagram.description || ""}
			nodeByLabel={nodeByLabel}
			nodeIndex={nodeIndex}
			liveDaemonsByNodeId={liveDaemonsByNodeId}
			legendFocus={legendFocus}
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
	diagramDescription,
	nodeByLabel,
	nodeIndex,
	liveDaemonsByNodeId,
	legendFocus,
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

		window.mermaid
			.render(renderId, source)
			.then(({ svg }) => {
				if (cancelled) return;
				setRenderState({ status: "ready", error: null, svgHtml: svg });
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

	// SVG 가 DOM 에 들어간 직후 — 라이브 상태 클래스 부착 + 라벨 매칭으로 backend node id 를 dataset 에 저장.
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
			if (matchedId) {
				el.setAttribute("data-arch-node-id", matchedId);
				// 스키마 node id = `${diagramId}.${mermaidId}` · 바인딩 키 = unscoped mermaid id → suffix 매칭 (F32).
				const daemons = liveDaemonsByNodeId.get(unscopedNodeIdAR(matchedId));
				// 이전 폴링 tick 의 ring 잔존 제거 후 현재 tone 재부착.
				el.classList.remove(...Object.values(LIVE_TONE_CLASS));
				// 복수 daemon 바인딩 시 최악 severity 를 ring 근거로 채택 (F39).
				const tone = worstDaemonTone(daemons);
				const liveClass = tone ? LIVE_TONE_CLASS[tone] : null;
				if (liveClass) el.classList.add(liveClass);
			}
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
		svgEl.setAttribute("aria-describedby", "arch-svg-desc");

		// 내장 <title> 갱신 — 호버 tooltip + 보조 a11y 채널.
		let titleEl = svgEl.querySelector(":scope > title");
		if (!titleEl) {
			titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
			svgEl.insertBefore(titleEl, svgEl.firstChild);
		}
		titleEl.textContent = diagramTitle;
	}, [renderState.status, renderState.svgHtml, diagramTitle]);

	// 범례 포커스 — 선택된 분류(role/type)에 속한 노드만 강조, 나머지 dim. legendFocus 변동마다 재적용.
	useEffectAR(() => {
		if (renderState.status !== "ready") return;
		const root = containerRef.current;
		if (!root) return;
		const canvas = root.closest(".arch-mermaid-canvas");
		if (!canvas) return;

		const svgNodes = root.querySelectorAll("g.node");
		if (!legendFocus) {
			canvas.classList.remove("legend-focus");
			svgNodes.forEach((el) => el.classList.remove("legend-hit"));
			return;
		}

		canvas.classList.add("legend-focus");
		svgNodes.forEach((el) => {
			const id = el.getAttribute("data-arch-node-id");
			const info = id ? nodeIndex.get(id) : null;
			const value =
				legendFocus.dim === "role" ? info?.layer_role : info?.type;
			el.classList.toggle("legend-hit", value === legendFocus.key);
		});
	}, [
		renderState.status,
		renderState.svgHtml,
		legendFocus,
		nodeIndex,
	]);

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
			// destroy 되는 탭의 short-graph clamp 가 재사용 캔버스 DOM 에 잔존 → 다음 그래프 측정 오염 차단.
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

			{/* SVG aria-describedby 타깃 — 다이어그램 목적 설명. <details> 로 시각 노출 겸함. */}
			<details className="arch-legend-details" style={{ marginTop: 6 }}>
				<summary>
					<span className="fs-micro font-mono text-faint uppercase tracking-wider">
						About this diagram
					</span>
				</summary>
				<div
					id="arch-svg-desc"
					className="fs-meta text-dim leading-snug"
					style={{ padding: "8px 10px" }}
				>
					{diagramDescription ||
						diagramPurposeAR({ id: diagramId }) ||
						"No description available."}
				</div>
			</details>
		</>
	);
}

// fit-to-view 아이콘 — Icon SoT 의 'target' 마크업 재사용 (currentColor 상속).
function ArchIconTargetAR() {
	const { Icon } = window.UI;
	return <Icon name="target" size={15} />;
}

// Top live strip — 데몬·Writer·최근활동 요약을 가로 1줄 칩으로 압축 (캔버스 가로폭 회수 목적).

function LiveStrip({ state, onRetry }) {
	const { formatRelativeTime } = window.UI;

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
			<div className="arch-live-strip" role="alert">
				<span className="fs-meta text-crit" style={{ flexShrink: 0 }}>
					Couldn't load live data
				</span>
				{/* 실제 에러 메시지 노출 — 원인 식별용 */}
				{state.error && (
					<span className="fs-meta font-mono text-dim truncate">
						{state.error}
					</span>
				)}
				{onRetry && (
					<button className="btn ghost sm" onClick={onRetry}>
						Retry
					</button>
				)}
			</div>
		);
	}

	const data = state.data;
	const daemons = data?.daemons || [];
	const writers = data?.writers || [];
	const recent = data?.recent_activity || {};

	const okWriters = writers.filter((w) => w.dual_write_active).length;
	const offWriters = writers.filter((w) => !w.dual_write_active);

	return (
		<div className="arch-live-strip">
			<div className="arch-live-strip-group">
				<LiveChip
					tone={offWriters.length === 0 ? "ok" : "crit"}
					label={`Writer ${okWriters}/${writers.length}`}
				/>
				{offWriters.map((w) => (
					<LiveChip key={w.writer_name} tone="crit" label={w.writer_name} />
				))}
			</div>

			<div className="arch-live-strip-sep" />

			<div className="arch-live-strip-group">
				<LiveChip
					tone="info"
					label={`cost ${recent.cost_events_last_hour ?? 0}`}
				/>
				<LiveChip
					tone="info"
					label={`agent ${recent.agent_events_last_hour ?? 0}`}
				/>
				<LiveChip
					tone="info"
					label={`outcome ${recent.last_outcome_at ? formatRelativeTime(recent.last_outcome_at) : "—"}`}
				/>
			</div>
		</div>
	);
}

function LiveChip({ tone, label, title }) {
	const { StatusDot } = window.UI;
	// 공용 StatusDot 으로 통일 — 칩마다 ad-hoc 6px dot 발산 방지 (단일 크기/톤 SoT).
	return (
		<span className="arch-live-chip" title={title || undefined}>
			<StatusDot status={tone} />
			<span className="text-dim">{label}</span>
		</span>
	);
}

// Bottom legend — 접이식 (기본 닫힘). 레이어·노드·엣지 범례 + 설명.

function LegendDetails({
	activeDiagram,
	legendUsedSets,
	legendFocus,
	onToggleFocus,
}) {
	return (
		<details className="arch-legend-details">
			<summary>
				<span className="fs-micro font-mono text-faint uppercase tracking-wider">
					Legend
				</span>
			</summary>
			<div className="arch-legend-grid">
				{legendUsedSets.roles.size > 0 && (
					<LegendBlock
						title="Layers"
						dim="role"
						legendFocus={legendFocus}
						onToggleFocus={onToggleFocus}
						items={Object.keys(ROLE_BORDER)
							.filter((r) => legendUsedSets.roles.has(r))
							.map((r) => ({
								swatch: "box",
								color: ROLE_BORDER[r],
								label: ROLE_LABEL[r] || r,
								hint: r,
							}))}
					/>
				)}

				{legendUsedSets.nodeTypes.size > 0 && (
					<LegendBlock
						title="Node types"
						dim="type"
						legendFocus={legendFocus}
						onToggleFocus={onToggleFocus}
						items={Object.keys(NODE_TYPE_BG)
							.filter((t) => legendUsedSets.nodeTypes.has(t))
							.map((t) => ({
								swatch: "box",
								color: NODE_TYPE_BG[t],
								label: NODE_TYPE_LABEL[t] || t,
								hint: t,
							}))}
					/>
				)}

				{/* 엣지 타입은 노드가 아니므로 dim 대상 아님 — 정적 범례 (클릭 무동작). */}
				{legendUsedSets.edgeTypes.size > 0 && (
					<LegendBlock
						title="Edge types"
						items={Object.keys(EDGE_COLORS)
							.filter((e) => legendUsedSets.edgeTypes.has(e))
							.map((e) => ({
								swatch: "line",
								color: EDGE_COLORS[e],
								label: EDGE_TYPE_LABEL[e] || e,
								hint: e,
							}))}
					/>
				)}
			</div>
		</details>
	);
}

function LegendBlock({ title, items, dim, legendFocus, onToggleFocus }) {
	// dim 미지정(엣지 타입) → 정적 행. dim 지정 → 클릭/Enter 로 해당 분류 노드 포커스 토글.
	const interactive = Boolean(dim);
	return (
		<div>
			<div className="fs-micro font-mono text-faint uppercase tracking-wider mb-1">
				{title}
			</div>
			<div className="flex flex-col gap-0.5">
				{items.map((it) => {
					const swatch =
						it.swatch === "line" ? (
							<span
								aria-hidden="true"
								className="arch-legend-swatch-line"
								style={{ background: it.color }}
							/>
						) : (
							<span
								aria-hidden="true"
								className="arch-legend-swatch-box"
								style={{ background: it.color }}
							/>
						);
					const rowContent = (
						<>
							{swatch}
							<span className="text-dim flex-1 truncate">{it.label}</span>
						</>
					);
					if (!interactive) {
						return (
							<div
								key={it.hint}
								className="flex items-center gap-2 fs-meta"
							>
								{rowContent}
							</div>
						);
					}
					const active =
						legendFocus &&
						legendFocus.dim === dim &&
						legendFocus.key === it.hint;
					return (
						<button
							key={it.hint}
							type="button"
							aria-pressed={Boolean(active)}
							className={`arch-legend-item flex items-center gap-2 fs-meta ${active ? "active" : ""}`}
							onClick={() => onToggleFocus(dim, it.hint)}
							title={`Focus ${it.label} nodes`}
						>
							{rowContent}
						</button>
					);
				})}
			</div>
		</div>
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
	const { Pill, formatRelativeTime, daemonStatusLabel } = window.UI;
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
					<Pill key={daemon.daemon_name} tone={daemonEffectiveTone(daemon)}>
						{`live: ${daemon.daemon_name} ${daemonStatusLabel(daemon.status)}${daemon.last_run_at ? ` · ${formatRelativeTime(daemon.last_run_at)}` : ""}`}
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

// 설계도 카운트 드리프트 배너 — role=alert 재사용 · info-tone(구조 정합성 nudge)으로 daemon-down crit/warn(런타임 헬스)과 시각 분리.
// diffs = [{ key, claimed, actual }] — mismatch 항목별 주장↔실측 노출.
function DriftBannerAR({ diffs }) {
	const { Icon, Badge } = window.UI;
	const items = diffs || [];
	return (
		<div
			role="alert"
			className="rounded-md border p-3 flex items-start gap-3"
			style={{
				background: "rgb(var(--info) / 0.08)",
				borderColor: "rgb(var(--info) / 0.4)",
			}}
		>
			<Icon name="git" size={16} className="text-info mt-0.5" />
			<div className="flex-1 min-w-0">
				<div className="fs-body font-medium text-ink">
					Map out of date — live counts don't match
				</div>
				<div className="fs-meta text-dim mt-1">
					Run{" "}
					<span className="font-mono">/glass-atrium-ops-verify-arch</span> for a deeper check.
				</div>
				{items.length > 0 && (
					<div className="flex flex-wrap gap-1.5 mt-2">
						{items.map((d) => (
							<Badge key={d.key} role="status" tone="info" glyph={false}>
								{`${d.key} ${d.claimed}→${d.actual}`}
							</Badge>
						))}
					</div>
				)}
			</div>
		</div>
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

function handleErrorAR(err, setter) {
	if (err && err.name === "AbortError") return;
	setter({
		status: "error",
		data: null,
		error: err && err.message ? err.message : String(err),
	});
}

// svg-pan-zoom 초기 줌을 contain-fit + floor 클램프 절대 스케일로 직접 적용 (라이브러리 fit:true 는 floor 무시 → 넓은 LR 그래프 과축소).
// 단계: resize() pane 갱신 → targetAbs = clamp(contain-fit, floor, 1) → 상대 zoom(R) → pan(viewBox 원점 상쇄 + 정렬) → 짧은 그래프는 컨테이너 높이 축소.
function applyLegibleFitAR(instance, root) {
	// 이전 탭의 short-graph clamp 를 측정 전 제거 → getSizes() 가 실제 전체 pane 측정 (early-return 가드보다 위 배치 필수).
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

	// contain-fit = 폭·높이 둘 다 들어가는 최대 비율. floor 로 가독 하한 보장, 1 로 과확대 차단.
	const widthFit = s.width / realW;
	const containFit = Math.min(widthFit, s.height / realH);
	// 가독 floor 가 widthFit 보다 크면 그래프가 pane 폭을 넘쳐 우측이 잘림 → floor 를 widthFit 으로 상한 클램프해
	//   targetAbs ≤ widthFit 보장 (전폭 항상 수용, 우측 클리핑 0). 넓은 LR 그래프는 floor 대신 전폭 fit 우선.
	const effectiveFloor = Math.min(LEGIBLE_FIT_FLOOR, widthFit);
	const targetAbs = Math.max(Math.min(containFit, 1), effectiveFloor);

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

// 데몬 표시 tone — 공유 SoT(window.UI.daemonStatusTone, A2) + 서버 선언 cadence 초과 시 ok→warn 격상 (F35).
function daemonEffectiveTone(d) {
	const base = window.UI.daemonStatusTone(d?.status);
	const cadence = Number(d?.expected_cadence_minutes);
	const staleness = Number(d?.staleness_minutes);
	if (
		base === "ok" &&
		Number.isFinite(cadence) &&
		Number.isFinite(staleness) &&
		staleness > cadence
	) {
		return "warn";
	}
	return base;
}

// 칩 상태 라벨 — status enum 라벨이 기본 · ok-이지만-stale 격상분은 'Overdue' 로 모순 라벨 차단.
function daemonChipLabelAR(daemon, tone) {
	if (daemon?.status === "ok" && tone === "warn") return "Overdue";
	return window.UI.daemonStatusLabel(daemon?.status);
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

// 노드에 바인딩된 daemon 들의 effective tone 중 최악 severity 반환 — ring 클래스 근거 (F39).
//   전부 neutral/info(ring 없음) 이거나 목록이 비면 null.
function worstDaemonTone(daemons) {
	let worst = null;
	let worstRank = 0;
	for (const d of daemons || []) {
		const tone = daemonEffectiveTone(d);
		const rank = LIVE_TONE_RANK[tone] || 0;
		if (rank > worstRank) {
			worstRank = rank;
			worst = tone;
		}
	}
	return worst;
}

// 스키마 node id (`${diagramId}.${mermaidId}`) → unscoped mermaid id (마지막 '.' 뒤 segment).
function unscopedNodeIdAR(nodeId) {
	if (typeof nodeId !== "string") return "";
	const idx = nodeId.lastIndexOf(".");
	return idx >= 0 ? nodeId.slice(idx + 1) : nodeId;
}

function truncateText(s, max) {
	if (typeof s !== "string") return "";
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "…";
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
