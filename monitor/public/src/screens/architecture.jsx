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

	const [refreshTick, setRefreshTick] = useStateAR(0);

	// 노드 상세 modal — null 이면 닫힘. payload = { kind, payload, diagramId }
	const [detail, setDetail] = useStateAR(null);

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
					// 자기개선 큐 스트립 — 상시 노출. 좁은 폭에서는 두 사실이 줄바꿈으로 쌓임.
					".arch-queue-strip { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; " +
					"padding: 6px 10px; background: rgb(var(--sunken)); border: 1px solid rgb(var(--line)); border-radius: 6px; flex-shrink: 0; } " +
					".arch-queue-fact { display: flex; align-items: baseline; gap: 6px; min-width: 0; flex-wrap: wrap; } " +
					".arch-queue-error { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; } " +
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

				<LiveDaemonTable state={liveState} />
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

// 라이브 상태 표 — 노드 링 점등을 대체함. daemon 1개 = 1행.

function LiveDaemonTable({ state }) {
	const { StatusDot, formatRelativeTime } = window.UI;
	// 파일 관례대로 메모 — 범례 토글/드로어 개폐/새로고침 틱마다 daemon 배열을 다시 훑지 않음.
	const rows = useMemoAR(
		() => (state.status === "ready" ? getLiveDaemonRows(state.data?.daemons) : []),
		[state.status, state.data],
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
					{rows.map((row) => (
						<tr key={row.name}>
							<th scope="row" className="text-ink font-mono">
								{row.name}
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
					))}
				</tbody>
			</table>
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

// 거버넌스 멤버십 배너 — 매트릭스가 선언한 scope/rule 문서가 사라졌을 때 그 이름을 부른다.
// 총계 배지는 무엇이 없어졌는지 말하지 못하므로 이름 목록이 곧 신호다.
// 경보 배너 셸 — 세 배너(거버넌스 warn · 이중기록 crit · 드리프트 info)가 tone 과 아이콘,
// 문구, 배지 목록만 달리한 같은 상자임. tone 은 CSS 변수명으로 그대로 들어가므로
// 새 tone 은 그 이름의 변수가 tokens.css 에 있어야 함. 아이콘 색 클래스는 리터럴 표로 둠 —
// 조립한 클래스명은 클래스 스캐너가 보지 못함.
const BANNER_TONE_TEXT_CLASS = {
	warn: "text-warn",
	crit: "text-crit",
	info: "text-info",
};

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
				className={`${BANNER_TONE_TEXT_CLASS[tone]} mt-0.5`}
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
