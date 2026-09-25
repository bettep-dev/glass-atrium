// E2E chromium FIT harness for the system map (screens/architecture.jsx).
// Runner: npx tsx --test test/architecture.map-fit.e2e.test.ts
//
// Asserts the one property nothing else measured: at a real viewport, every drawn
// node and zone is INSIDE the canvas. The map shipped clipped twice — once vertically
// under `TD`, once horizontally under `LR` — because the budget counts content and the
// structure harness counts DOM, and neither can see a box that fell off the pane. The
// retired "rendered-pixel legibility proxy" measured scale alone, which is the half of
// the trade that a wider graph does not move.
//
// Two halves, asserted together on purpose — each alone is satisfiable by wrecking the
// other. Fit alone passes by shrinking the map until the text is unreadable; the scale
// floor alone passes by drawing at the floor and letting the overflow be cut.
//   1. containment — every `.node` / `.cluster` client rect within the canvas rect.
//   2. legibility  — applied scale >= LEGIBLE_FIT_FLOOR, and the resulting rendered
//      label size >= MIN_RENDERED_LABEL_PX.
//
// Viewport table: 1396 is the width the user actually runs (their screenshot); 1512 and
// 1920 are the two the fit was previously reasoned about. Heights are the window heights
// those widths plausibly come with — the pane is the viewport height minus a fixed 158px of
// chrome (measured identical at all three: 800→642, 850→692, 1080→922), and the map is
// width-bound at all three, so the exact height is not load-bearing. The height is a constant
// subtraction rather than a fraction because the chrome above it is pixel-fixed; the earlier
// ~0.68 fraction was the shared `.card-body { max-height: 70vh }` cap, since released by the
// screen. The 158 counts this harness's health-store alert strip (45px), which its fixture
// raises — without that strip the same viewports give 687 / 737 / 967.
//
// A dagre fallback (the ELK loader losing its race) lays the same source ~44% wider and
// is caught here as a containment failure — no separate layout-engine guard is needed.
//
// App: stripped Fastify (fastify-static + two hand-registered routes) on an ephemeral
// port, matching architecture.render-structure.e2e. Page-level network prerequisite:
// React + mermaid come from CDN, so the run REQUIRES outbound network and an installed
// chromium. An unmet prerequisite fails RED — no skip guard absorbs it.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser } from "playwright";
import { chromium } from "playwright";

import { getArchitecture } from "../src/server/architecture/parser.js";
import {
	DAEMON_NODE_BINDINGS,
	PART_NODE_BINDINGS,
} from "../src/server/architecture/diagrams-source.js";
import type { ArchitectureLiveResponse } from "../src/server/types/architecture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");

// architecture.jsx 의 LEGIBLE_FIT_FLOOR 사본 — 화면이 상수를 내보내지 않으므로 하네스가 값을 소유함.
// 화면 쪽 값을 내리는 "수정"은 이 단언을 통과하지 못함: 두 값이 갈라지면 여기가 먼저 붉어짐.
const LEGIBLE_FIT_FLOOR = 0.6;

// 라벨 렌더 하한(px) = mermaid-config.js 의 themeVariables.fontSize(14px) × 하한 배율.
// 폭을 줄이는 대신 글자를 줄이는 맞바꿈을 막는 다리 — 배율만 재면 이 값이 조용히 내려감.
const MIN_RENDERED_LABEL_PX = 14 * LEGIBLE_FIT_FLOOR;

// a floor-clamped scale read back from the CTM carries float noise (0.59999…) → compare within it
const CTM_FLOAT_TOLERANCE = 1e-6;

// 서브픽셀 여유. 링(stroke-width 2.5 사용자 단위)까지 client rect 에 들어오므로
// 실측 여유는 이 값보다 훨씬 커야 정상이고, 1px 은 반올림만 흡수함.
const EPS_PX = 1;

// 사용자가 실제로 쓰는 폭(1396)을 첫 행으로 두고 앞선 논의의 두 폭을 뒤에 둠.
const VIEWPORTS = [
	{ width: 1396, height: 800 },
	{ width: 1512, height: 850 },
	{ width: 1920, height: 1080 },
];

// 1024 is kept out of VIEWPORTS on purpose — AC-FIT-1024 below pins why.
const NARROW_VIEWPORT = { width: 1024, height: 768 };

const BOUND_DAEMON = "autoagent";

interface FitReading {
	paneWidth: number;
	paneHeight: number;
	scale: number;
	labelPx: number;
	boxCount: number;
	drawnWidthPx: number;
	drawnHeightPx: number;
	worstOverflowPx: number;
	worstId: string;
}

function getLiveFixture(): ArchitectureLiveResponse {
	const nodeIds = [...(DAEMON_NODE_BINDINGS[BOUND_DAEMON] ?? [])];
	assert.ok(nodeIds.length > 0, `fixture precondition: ${BOUND_DAEMON} must carry node bindings`);
	return {
		computed_at: new Date().toISOString(),
		// 링이 켜진 상태로 잼 — 링은 stroke 를 넓혀 상자를 키우므로 링 없는 픽스처보다 보수적임.
		daemons: [
			{
				daemon_name: BOUND_DAEMON,
				effective_status: "ok",
				last_run_at: null,
				staleness_minutes: 0,
				node_ids: nodeIds,
				expected_cadence_minutes: 60,
			},
		],
		writers: [],
		recent_activity: {
			cost_events_last_hour: 0,
			agent_events_last_hour: 0,
			last_outcome_at: null,
		},
		governance: { absent: [], sourceMissing: false },
		part_bindings: PART_NODE_BINDINGS,
	};
}

let app: FastifyInstance | undefined;
let browser: Browser | undefined;
let serverUrl = "";

before(async () => {
	app = Fastify({ logger: false });
	await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
	app.get("/api/architecture/diagrams", async (request: FastifyRequest) => {
		const { doc } = await getArchitecture(request.log);
		return doc.diagrams;
	});
	const fixture = getLiveFixture();
	app.get("/api/architecture/live", async () => fixture);
	await app.ready();
	serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
	browser = await chromium.launch({ headless: true });
});

after(async () => {
	await browser?.close();
	await app?.close();
});

// 뷰포트 하나를 열어 실측 한 벌을 돌려줌.
// 화면에 resize 리스너가 없어 fit 은 최초 렌더에서 한 번만 적용됨 — 그래서 뷰포트마다 새 페이지를 염
// (이미 뜬 페이지의 크기를 바꾸면 fit 이 다시 걸리지 않아 이전 폭의 배율을 재게 됨).
async function readFit(width: number, height: number): Promise<FitReading> {
	assert.ok(browser, "browser must be up");
	const page = await browser.newPage({ viewport: { width, height } });
	try {
		await page.goto(`${serverUrl}/#architecture`, { waitUntil: "load" });
		const runtimeReady = await page
			.waitForFunction(
				() => {
					const w = window as never as { mermaid?: unknown; React?: unknown };
					return Boolean(w.mermaid && w.React);
				},
				null,
				{ timeout: 30_000 },
			)
			.then(
				() => true,
				() => false,
			);
		assert.equal(
			runtimeReady,
			true,
			"page-level network prerequisite unmet — React/mermaid CDN runtime did not load",
		);

		const canvasSelector = await page.evaluate(
			() => (window as never as { ARCH_SELECTORS: { canvas: string } }).ARCH_SELECTORS.canvas,
		);
		// 미적용 상태는 배율 1 이 아니라 svg-pan-zoom 초기화의 viewBox meet 배율 — 각인 뒤 두 프레임가량 남아
		// 1024 에서 floor 미만으로 읽힘. 그래서 fit 표식 + 그 배율이 CTM 에 실린 것까지 기다림.
		await page.waitForSelector(`${canvasSelector} svg g.node[data-arch-node-id]`, {
			timeout: 30_000,
		});
		await page.waitForFunction(
			(sel) => {
				const vp = document.querySelector(`${sel} .svg-pan-zoom_viewport`);
				const m = vp instanceof SVGGraphicsElement ? vp.getCTM() : null;
				const fitScale = Number(vp?.getAttribute("data-arch-fit-scale"));
				return Boolean(m && fitScale > 0 && Math.abs(m.a - fitScale) < 1e-3);
			},
			canvasSelector,
			{ timeout: 30_000 },
		);
		// 배율이 meet 과 같은 뷰포트는 위 대조로 pan 반영을 못 가림 — 라이브러리의 다음 프레임 반영을 한 프레임 넘겨 보장.
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));

		return await page.evaluate((sel) => {
			const canvas = document.querySelector(sel) as HTMLElement;
			const pane = canvas.getBoundingClientRect();
			const vp = canvas.querySelector(".svg-pan-zoom_viewport") as SVGGraphicsElement;
			const scale = vp.getCTM()?.a ?? 0;

			const label = canvas.querySelector("svg .nodeLabel, svg .node .label, svg .node text");
			const declared = label ? Number.parseFloat(getComputedStyle(label).fontSize) : 0;

			// 노드와 존 상자 전부 — 존이 잘리면 그 안의 제목이 잘림.
			const boxes = Array.from(canvas.querySelectorAll("svg g.node, svg g.cluster"));
			let worstOverflowPx = Number.NEGATIVE_INFINITY;
			let worstId = "";
			const drawn = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
			for (const box of boxes) {
				const r = box.getBoundingClientRect();
				if (r.width === 0 && r.height === 0) continue;
				drawn.left = Math.min(drawn.left, r.left);
				drawn.right = Math.max(drawn.right, r.right);
				drawn.top = Math.min(drawn.top, r.top);
				drawn.bottom = Math.max(drawn.bottom, r.bottom);
				// 네 변 각각이 pane 안쪽으로 얼마나 들어와 있는지 — 음수면 그만큼 밖으로 나감.
				const inset = Math.min(
					r.left - pane.left,
					pane.right - r.right,
					r.top - pane.top,
					pane.bottom - r.bottom,
				);
				const overflow = -inset;
				if (overflow > worstOverflowPx) {
					worstOverflowPx = overflow;
					worstId = box.getAttribute("data-arch-node-id") || box.id || "(unnamed)";
				}
			}

			return {
				paneWidth: pane.width,
				paneHeight: pane.height,
				scale,
				labelPx: declared * scale,
				boxCount: boxes.length,
				drawnWidthPx: drawn.right - drawn.left,
				drawnHeightPx: drawn.bottom - drawn.top,
				worstOverflowPx,
				worstId,
			};
		}, canvasSelector);
	} finally {
		await page.close();
	}
}

for (const { width, height } of VIEWPORTS) {
	test(`AC-FIT-1 the whole map is inside the pane at ${width}x${height}`, async (t) => {
		const r = await readFit(width, height);
		// 통과했을 때의 여유를 남김 — 다음 사람이 "얼마나 아슬아슬한가" 를 다시 재지 않아도 됨.
		t.diagnostic(
			`pane ${r.paneWidth.toFixed(0)}x${r.paneHeight.toFixed(0)} · scale ${r.scale.toFixed(4)} · ` +
				`labels ${r.labelPx.toFixed(2)}px · drawn ${r.drawnWidthPx.toFixed(0)}x${r.drawnHeightPx.toFixed(0)} · closest box \`${r.worstId}\` clears the edge by ` +
				`${(-r.worstOverflowPx).toFixed(1)}px`,
		);
		assert.ok(r.boxCount > 0, "no node or zone boxes were measured — the map did not render");
		assert.ok(
			r.worstOverflowPx <= EPS_PX,
			`\`${r.worstId}\` hangs ${r.worstOverflowPx.toFixed(1)}px outside the pane ` +
				`(${r.paneWidth.toFixed(0)}x${r.paneHeight.toFixed(0)} at scale ${r.scale.toFixed(4)}, ` +
				`${r.boxCount} boxes measured)`,
		);
	});

	test(`AC-FIT-2 it fits without shrinking the text at ${width}x${height}`, async () => {
		const r = await readFit(width, height);
		assert.ok(
			r.scale >= LEGIBLE_FIT_FLOOR - CTM_FLOAT_TOLERANCE,
			`applied scale ${r.scale.toFixed(4)} is under the legibility floor ${LEGIBLE_FIT_FLOOR}`,
		);
		assert.ok(
			r.labelPx >= MIN_RENDERED_LABEL_PX - CTM_FLOAT_TOLERANCE,
			`labels render at ${r.labelPx.toFixed(2)}px, under the ${MIN_RENDERED_LABEL_PX}px floor`,
		);
	});
}

// The map is width-bound (graph ~3.9:1 against a ~2:1 pane), so it fills ~half the pane height
// and at 1024 fitting the width needs a scale under the floor. Both would take a relayout, which
// the standing System map decision forbids, or smaller labels → the floor wins and the overflow pans.
// A layout that fits at 1024 turns this red → move 1024 into VIEWPORTS.
test(`AC-FIT-1024 at ${NARROW_VIEWPORT.width}x${NARROW_VIEWPORT.height} the labels stay legible, and containment would need a sub-floor scale`, async (t) => {
	const r = await readFit(NARROW_VIEWPORT.width, NARROW_VIEWPORT.height);
	const graphWidthAtOne = r.drawnWidthPx / r.scale;
	const containScale = r.paneWidth / graphWidthAtOne;
	t.diagnostic(
		`pane ${r.paneWidth.toFixed(0)}x${r.paneHeight.toFixed(0)} · scale ${r.scale.toFixed(4)} · ` +
			`drawn ${r.drawnWidthPx.toFixed(0)}x${r.drawnHeightPx.toFixed(0)} · width-fit would be ${containScale.toFixed(4)}`,
	);
	assert.ok(r.boxCount > 0, "no node or zone boxes were measured — the map did not render");
	assert.ok(r.scale >= LEGIBLE_FIT_FLOOR - CTM_FLOAT_TOLERANCE, `applied scale ${r.scale.toFixed(4)} is under the floor ${LEGIBLE_FIT_FLOOR}`);
	assert.ok(r.labelPx >= MIN_RENDERED_LABEL_PX - CTM_FLOAT_TOLERANCE, `labels render at ${r.labelPx.toFixed(2)}px`);
	assert.ok(
		containScale < LEGIBLE_FIT_FLOOR,
		`width-fit ${containScale.toFixed(4)} now clears the floor — the map fits at 1024, assert AC-FIT-1 there`,
	);
});
