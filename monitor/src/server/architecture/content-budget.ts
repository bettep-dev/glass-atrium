// 콘텐츠 예산 단일 SoT — mermaid 문자열 하나를 인자로 받아 계수하고(계수 규칙 1벌) 등급 상한과 대조함.
// 예산 테스트(architecture.budget)와 health 표면이 같은 함수를 호출 → 계수 규칙과 상한 표가 두 곳에 존재하지 않음.

export type DetailGrade = "faithful" | "balanced" | "simplified";

export interface MermaidNode {
	id: string;
	// 마크업(따옴표·HTML 태그·shape 구분자) 제거 후의 라벨 문자열.
	label: string;
	// `[/ … /]` 평행사변형 shape = 다른 다이어그램으로 넘어가는 경계 노드.
	boundary: boolean;
}

export interface MermaidCensus {
	nodes: MermaidNode[];
	nodeCount: number;
	edgeCount: number;
	maxSubgraphDepth: number;
	maxLabelChars: number;
}

const OPENERS: Readonly<Record<string, string>> = { "[": "]", "(": ")", "{": "}" };
// 라벨 안의 인용 구간을 지운 뒤 남는 화살표 토큰 — 한 줄 = 한 엣지.
const ARROW = /-->|\.->|--[->]|===?>|---/;
const NODE_DEF = /(^|[\s;])([A-Za-z0-9_-]+)([[({])/g;

/** opener 위치에서 대응 closer 까지 읽어 라벨 원문과 종료 위치를 돌려줌. */
function getBracketSpan(line: string, openIdx: number): { text: string; end: number } {
	const open = line[openIdx] as string;
	const close = OPENERS[open] as string;
	let depth = 0;
	for (let i = openIdx; i < line.length; i += 1) {
		if (line[i] === open) depth += 1;
		else if (line[i] === close) {
			depth -= 1;
			if (depth === 0) return { text: line.slice(openIdx + 1, i), end: i };
		}
	}
	return { text: line.slice(openIdx + 1), end: line.length };
}

/** 마크업 제거 — shape 구분자(`/`), 감싸는 따옴표, HTML 태그. 공백은 라벨 문자로 셈. */
function getLabelText(raw: string): string {
	let text = raw.trim();
	if (text.startsWith("/") && text.endsWith("/")) text = text.slice(1, -1);
	text = text.trim();
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
	return text.replace(/<[^>]*>/g, "").trim();
}

/**
 * 계수 규칙(단일 경로) — 어떤 mermaid 문자열에도 동일하게 적용됨.
 * 노드 = shape opener 를 동반한 선언 1건(`subgraph` 존 선언과 엣지 전용 참조는 제외 · 중복 id 는 1회).
 * 엣지 = 인용 구간 제거 후 화살표 토큰이 남는 줄 수.
 */
export function getMermaidCensus(mermaid: string): MermaidCensus {
	const byId = new Map<string, MermaidNode>();
	let edgeCount = 0;
	let depth = 0;
	let maxSubgraphDepth = 0;

	for (const rawLine of mermaid.split("\n")) {
		const line = rawLine.trim();
		if (line === "") continue;
		if (line.startsWith("subgraph")) {
			depth += 1;
			if (depth > maxSubgraphDepth) maxSubgraphDepth = depth;
			continue;
		}
		if (line === "end") {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (ARROW.test(line.replace(/"[^"]*"/g, ""))) edgeCount += 1;

		NODE_DEF.lastIndex = 0;
		let match = NODE_DEF.exec(line);
		while (match !== null) {
			const id = match[2] as string;
			const openIdx = match.index + match[1].length + id.length;
			const span = getBracketSpan(line, openIdx);
			const inner = span.text;
			if (!byId.has(id)) {
				byId.set(id, {
					id,
					label: getLabelText(inner),
					boundary: line[openIdx] === "[" && inner.trim().startsWith("/"),
				});
			}
			NODE_DEF.lastIndex = span.end;
			match = NODE_DEF.exec(line);
		}
	}

	const nodes = [...byId.values()];
	return {
		nodes,
		nodeCount: nodes.length,
		edgeCount,
		maxSubgraphDepth,
		maxLabelChars: nodes.reduce((max, n) => Math.max(max, n.label.length), 0),
	};
}

export interface BudgetCaps {
	nodes: number;
	edges: number;
	labelChars: number;
	subgraphDepth: number;
}

// 등급별 상한 — T2 census(7편 노드 중앙값 14 · 엣지 18 · 최장 라벨 50)에서 파생함.
// 오늘 소비되는 행은 canonical 맵이 배정받은 balanced 한 줄뿐이며 나머지 두 행은 선언만 되어 있음(집행 없음).
// balanced 파생 근거 — canonical source 계수(노드 11 · 엣지 8 · 라벨 69)보다 작고(a) 코퍼스 중앙값 이하(b)를 동시에 만족함.
export const BUDGET_CAPS: Readonly<Record<DetailGrade, BudgetCaps>> = {
	faithful: { nodes: 14, edges: 18, labelChars: 50, subgraphDepth: 1 },
	balanced: { nodes: 9, edges: 6, labelChars: 45, subgraphDepth: 1 },
	simplified: { nodes: 6, edges: 5, labelChars: 35, subgraphDepth: 1 },
};

// 라벨 상한 예외를 허용받는 노드 id 리터럴 목록 — 비어 있으면 예외 없음.
export const LABEL_CAP_EXEMPT_NODE_IDS: readonly string[] = [];

export type BudgetState = "pass" | "warn" | "fail";

export interface BudgetMeasure {
	// 위반 명명 단위 = (지표명, 실측치, 상한) 3튜플.
	metric: string;
	measured: number;
	cap: number;
	ratio: number;
	state: BudgetState;
}

export interface BudgetReport {
	state: BudgetState;
	grade: DetailGrade;
	measures: BudgetMeasure[];
	violations: BudgetMeasure[];
	// 예산이 대리 지표라는 사실 — 출력 표면에 함께 실려야 커버 범위 이상으로 신뢰되지 않음.
	note: string;
}

const PROXY_NOTE =
	"Proxy metric: node/edge/label counts are the upstream lever of legibility, not legibility itself " +
	"(on-screen readability is judged by human review). The omitted_node_ids ledger is checked for " +
	"existence/absence of each listed id, never for completeness of the list.";

/** 비율 밴드 — ratio > 1.0 fail · 0.9 ≤ ratio ≤ 1.0 warn · ratio < 0.9 pass. */
function getRatioState(ratio: number): BudgetState {
	if (ratio > 1) return "fail";
	if (ratio >= 0.9) return "warn";
	return "pass";
}

function getMeasure(metric: string, measured: number, cap: number): BudgetMeasure {
	const ratio = cap === 0 ? Number.POSITIVE_INFINITY : measured / cap;
	return { metric, measured, cap, ratio, state: getRatioState(ratio) };
}

// subgraph 깊이는 볼륨이 아니라 회귀 잠금 불변식 — 비율 밴드에 넣으면 상한과 같은 정상값이 영구 warn 이 됨.
function getDepthMeasure(measured: number, cap: number): BudgetMeasure {
	return { metric: "subgraph_depth", measured, cap, ratio: measured / cap, state: measured > cap ? "fail" : "pass" };
}

const STATE_RANK: Readonly<Record<BudgetState, number>> = { pass: 0, warn: 1, fail: 2 };

/** 그려지는 문자열 하나를 자기 등급의 상한 행으로 판정함. */
export function getBudgetReport(mermaid: string, grade: DetailGrade): BudgetReport {
	const caps = BUDGET_CAPS[grade];
	const census = getMermaidCensus(mermaid);
	const labelChars = census.nodes
		.filter((n) => !LABEL_CAP_EXEMPT_NODE_IDS.includes(n.id))
		.reduce((max, n) => Math.max(max, n.label.length), 0);

	const measures = [
		getMeasure("nodes", census.nodeCount, caps.nodes),
		getMeasure("edges", census.edgeCount, caps.edges),
		getMeasure("label_chars", labelChars, caps.labelChars),
		getDepthMeasure(census.maxSubgraphDepth, caps.subgraphDepth),
	];
	const state = measures.reduce<BudgetState>(
		(worst, m) => (STATE_RANK[m.state] > STATE_RANK[worst] ? m.state : worst),
		"pass",
	);
	return { state, grade, measures, violations: measures.filter((m) => m.state !== "pass"), note: PROXY_NOTE };
}
