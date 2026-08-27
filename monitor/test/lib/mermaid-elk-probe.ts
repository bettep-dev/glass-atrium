// Shared ELK-proof probes for the mermaid layout work (plan D5-2 §7 공용 판정 도구).
// Three tools, each closing one hole the others leave open: a dagre control (a layout
// claim is empty without one), an orthogonality verdict over a flat coordinate
// sequence (ADR-3), and a console watch whose zero-count only means something while
// the page carries logLevel <= 3.

import assert from "node:assert/strict";

import type { Page } from "playwright";

export interface Point {
	x: number;
	y: number;
}

export interface RenderProbe {
	// 라벨 → 노드 변환 원점. DOM id 는 렌더마다 카운터가 붙어 대조군과 키가 어긋남.
	nodes: Record<string, Point>;
	links: string[];
}

// 원문: `Layout algorithm <x> is not registered. Using <y> as fallback.`
const FALLBACK_MARKERS = ["Layout algorithm", "not registered"] as const;

// mermaid 기본 logLevel 5(fatal) 에서는 log.warn 이 no-op 으로 재바인딩돼 경고가 나오지 않음.
const WARN_LOG_LEVEL = 3;

// ADR-3 축 정렬 허용 오차.
const AXIS_TOLERANCE = 0.5;

export interface FallbackWatch {
	readonly messages: string[];
	clear(): void;
}

/** 도구 3 — 렌더 중 폴백 경고만 골라 모음. 다른 warn(설정 deprecation 등)은 문자열 불일치로 버림. */
export function createFallbackWatch(page: Page): FallbackWatch {
	const messages: string[] = [];
	page.on("console", (message) => {
		const text = message.text();
		if (FALLBACK_MARKERS.every((marker) => text.includes(marker))) messages.push(text);
	});
	return {
		messages,
		clear() {
			messages.length = 0;
		},
	};
}

/** 도구 3 의 전제 — 이걸 통과하지 못하면 "경고 0건" 은 공허함. */
export async function assertFallbackWarningVisible(page: Page): Promise<void> {
	const level = await page.evaluate(() => {
		const w = window as never as {
			mermaid?: { mermaidAPI?: { getConfig(): { logLevel?: unknown } } };
		};
		return w.mermaid?.mermaidAPI?.getConfig().logLevel ?? null;
	});
	assert.ok(
		level !== null && Number(level) <= WARN_LOG_LEVEL,
		`page initialize() must carry logLevel <= ${WARN_LOG_LEVEL} (measured ${String(level)}) — above it mermaid rebinds log.warn to a no-op, so a zero fallback-warning count proves nothing`,
	);
}

/** 페이지에서 소스를 렌더하고 노드 원점 + 엣지 path 를 걷어옴. */
export async function getRenderProbe(
	page: Page,
	id: string,
	source: string,
): Promise<RenderProbe> {
	const probe = await page.evaluate(
		async (args: { id: string; source: string }) => {
			const w = window as never as {
				mermaid: { render(id: string, text: string): Promise<{ svg: string }> };
			};
			const { svg } = await w.mermaid.render(args.id, args.source);
			const host = document.createElement("div");
			host.id = `probe-host-${args.id}`;
			host.innerHTML = svg;
			document.body.appendChild(host);

			const nodes: Record<string, Point> = {};
			const labels: string[] = [];
			for (const el of Array.from(host.querySelectorAll("g.node"))) {
				const label = (el.textContent || "").trim();
				labels.push(label);
				const matrix = (el as SVGGraphicsElement).transform.baseVal.consolidate()?.matrix;
				nodes[label] = {
					x: matrix ? matrix.e : Number.NaN,
					y: matrix ? matrix.f : Number.NaN,
				};
			}
			const links = Array.from(host.querySelectorAll("path.flowchart-link")).map(
				(path) => path.getAttribute("d") || "",
			);
			return { nodes, labels, links };
		},
		{ id, source },
	);

	assert.ok(probe.labels.length > 0, `${id}: rendered no g.node — the probe would be empty`);
	assert.equal(
		new Set(probe.labels).size,
		probe.labels.length,
		`${id}: node labels ${probe.labels.join(", ")} are not unique — the coordinate map would silently collapse`,
	);
	return { nodes: probe.nodes, links: probe.links };
}

/** 도구 1 — 대조군. 좌표가 같으면 ELK 요청이 조용히 dagre 로 떨어진 것과 구별되지 않음. */
export function assertLayoutsDiffer(elk: RenderProbe, dagre: RenderProbe): void {
	assert.deepStrictEqual(
		Object.keys(elk.nodes).sort(),
		Object.keys(dagre.nodes).sort(),
		"control must render the same node set as the ELK run",
	);
	assert.notDeepStrictEqual(
		elk.nodes,
		dagre.nodes,
		`elk and dagre produced identical node coordinates ${JSON.stringify(elk.nodes)} — the layout request never reached ELK`,
	);
}

/**
 * path `d` 를 평탄 좌표열로 (ADR-3).
 * Q 는 제어점(=모서리 꼭짓점)과 끝점(=다음 직선 시작점)을 순서대로 둘 다 싣는다.
 * M/L/Q 밖의 명령은 판정이 정의되지 않으므로 조용히 통과시키지 않고 throw.
 */
export function getFlatPoints(d: string): Point[] {
	const points: Point[] = [];
	for (const group of d.match(/[A-Za-z][^A-Za-z]*/g) ?? []) {
		const command = group[0];
		const nums = (group.slice(1).match(/-?\d*\.?\d+/g) ?? []).map(Number);
		if (command === "M" || command === "L") {
			assert.equal(nums.length, 2, `${command} takes 2 operands, got ${nums.length} in "${d}"`);
			points.push({ x: nums[0], y: nums[1] });
		} else if (command === "Q") {
			assert.equal(nums.length, 4, `Q takes 4 operands, got ${nums.length} in "${d}"`);
			points.push({ x: nums[0], y: nums[1] }, { x: nums[2], y: nums[3] });
		} else {
			throw new Error(
				`unsupported path command '${command}' in "${d}" — the orthogonality verdict is defined over M/L/Q only`,
			);
		}
	}
	return points;
}

/** 축 정렬을 어긴 인접 쌍의 시작 인덱스. 첫/끝 세그먼트는 마커 오프셋 때문에 예외(ADR-3). */
export function findNonOrthogonalPairs(points: Point[]): number[] {
	const offending: number[] = [];
	for (let i = 0; i + 1 < points.length; i += 1) {
		if (i === 0 || i + 2 === points.length) continue;
		const dx = Math.abs(points[i + 1].x - points[i].x);
		const dy = Math.abs(points[i + 1].y - points[i].y);
		if (dx >= AXIS_TOLERANCE && dy >= AXIS_TOLERANCE) offending.push(i);
	}
	return offending;
}

/** 도구 2 — 엣지 전수 직교성 판정. */
export function assertOrthogonalLinks(links: string[], context: string): void {
	assert.ok(
		links.length > 0,
		`${context}: no flowchart-link path to judge — the orthogonality verdict would be vacuous`,
	);
	const violations = links.flatMap((d, index) => {
		const points = getFlatPoints(d);
		return findNonOrthogonalPairs(points).map(
			(pair) =>
				`link[${index}] pair ${pair}: ${JSON.stringify(points[pair])} -> ${JSON.stringify(points[pair + 1])}`,
		);
	});
	assert.deepStrictEqual(violations, [], `${context}: diagonal edge segments present`);
}
