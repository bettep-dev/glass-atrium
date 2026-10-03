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
// The default view is an overview: the drawing at 90% of the contain fit, centred, with every label
// at the 13px meta floor or more. Readings asserted together:
//   1. containment — every `.node` / `.cluster` client rect within the canvas rect.
//   2. overview share — the drawing spans ~90% of its frame on the binding axis, centred on both axes.
//   3. legibility — every label at >= MIN_RENDERED_LABEL_PX in the default view, and still within the zoom-in press budget.
//   4. reset — the Reset control returns a zoomed-in map to the same default view.
//   5. shape — two columns read top to bottom: Inputs | Daemons, Orchestrator, Agents on the left; Safety, Store, Documents on the right.
//
// Viewport table: 1024 and 1440 are the widths the evaluators scored; 1396 is the width the user
// actually runs; 1512 and 1920 are the two the fit was first reasoned about. Heights are the window heights
// those widths plausibly come with. The pane shares the viewport with the Part health block under
// the map: `.arch-main` keeps a 62vh floor and the block takes the rest, so the pane height is no
// longer a fixed subtraction. The fill reading takes whichever axis binds, so the exact height is not
// load-bearing.
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
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { getArchitecture } from "../src/server/architecture/parser.js";
import {
	CANONICAL_MAP,
	DAEMON_NODE_BINDINGS,
	DIAGRAMS,
	PART_NODE_BINDINGS,
} from "../src/server/architecture/diagrams-source.js";
import type { ArchitectureLiveResponse } from "../src/server/types/architecture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");

// the 13px meta floor every drawn label must reach — owned here, never read from the screen
const MIN_RENDERED_LABEL_PX = 13;

// the default view's share of the contain fit
const DEFAULT_VIEW_SHARE = 0.9;

// parallel runs of different edges sit at least this far apart (layout units) — closer, two lanes read as one line
const MIN_LANE_GAP_UNITS = 24;

// a screen-drawn edge label keeps this clearance (layout units) from every edge but its own
const LABEL_CLEARANCE_UNITS = 16;

// an arrowhead under this length (CSS px) reads as a dot, not a direction
const MIN_ARROWHEAD_PX = 6;

// drawn boxes span at least this share of the viewBox on its binding axis (the rest is diagramPadding)
const MIN_BINDING_AXIS_FILL = 0.9;

// zoom-in presses from the default view within which every label reaches MIN_RENDERED_LABEL_PX
const ZOOM_IN_PRESS_BUDGET = 3;

// presses that take the map well past the default view before Reset — far enough to move the library's zoom base
const ZOOM_IN_PRESSES_BEFORE_RESET = 8;

// slack difference between opposite sides of a centred drawing — viewBox padding asymmetry plus rounding
const MAX_CENTRING_SKEW_PX = 8;

// CTM-derived reads (labelPx, scale) carry float noise → the zoomed-in label floor and the natural-size default share compare within it
const CTM_FLOAT_TOLERANCE = 1e-6;

// 서브픽셀 여유. 링(stroke-width 2.5 사용자 단위)까지 client rect 에 들어오므로
// 실측 여유는 이 값보다 훨씬 커야 정상이고, 1px 은 반올림만 흡수함.
const EPS_PX = 1;

const VIEWPORTS = [
	{ width: 1024, height: 768 },
	{ width: 1396, height: 800 },
	{ width: 1440, height: 900 },
	{ width: 1512, height: 850 },
	{ width: 1920, height: 1080 },
];

const BOUND_DAEMON = "autoagent";

interface FitReading {
	paneWidth: number;
	paneHeight: number;
	// pane width left of the zoom controls — the area the drawing is fitted and centred in
	drawableWidth: number;
	scale: number;
	labelPx: number;
	boxCount: number;
	drawnWidthPx: number;
	drawnHeightPx: number;
	gapPx: { above: number; below: number; left: number; right: number };
	worstOverflowPx: number;
	worstId: string;
	// the drawn box reaching deepest under the zoom controls — a positive 2D overlap depth means a box sits under a button
	controls: { intrusionPx: number; intruderId: string };
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
async function readFit(width: number, height: number, extraSource?: string): Promise<FitReading> {
	const { page, canvasSelector } = await openFittedPage(width, height, extraSource);
	try {
		return await measureFit(page, canvasSelector);
	} finally {
		await page.close();
	}
}

// page at the map's default view — the fit mark is set and its scale has reached the CTM
async function openFittedPage(width: number, height: number, extraSource?: string): Promise<{ page: Page; canvasSelector: string }> {
	assert.ok(browser, "browser must be up");
	const page = await browser.newPage({ viewport: { width, height } });
	try {
		if (extraSource) await addDiagramSource(page, extraSource);
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
		// 1024 에서 기본 보기 배율과 어긋나게 읽힘. 그래서 fit 표식 + 그 배율이 CTM 에 실린 것까지 기다림.
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
		return { page, canvasSelector };
	} catch (e) {
		await page.close();
		throw e;
	}
}

async function measureFit(page: Page, canvasSelector: string): Promise<FitReading> {
	return await page.evaluate((sel) => {
			const canvas = document.querySelector(sel) as HTMLElement;
			const pane = canvas.getBoundingClientRect();
			const vp = canvas.querySelector(".svg-pan-zoom_viewport") as SVGGraphicsElement;
			const scale = vp.getCTM()?.a ?? 0;

			// smallest drawn label of any kind — one small zone title or edge label is enough to fail
			const labels = Array.from(canvas.querySelectorAll("svg .nodeLabel, svg .edgeLabel")).filter(
				(el) => (el.textContent || "").trim() !== "",
			);
			const declared = labels.length
				? Math.min(...labels.map((el) => Number.parseFloat(getComputedStyle(el).fontSize)))
				: 0;

			// 노드와 존 상자 전부 — 존이 잘리면 그 안의 제목이 잘림.
			const boxes = Array.from(canvas.querySelectorAll("svg g.node, svg g.cluster"));
			let worstOverflowPx = Number.NEGATIVE_INFINITY;
			let worstId = "";
			const controls = canvas.querySelector(".arch-zoom-controls")?.getBoundingClientRect();
			let controlsIntrusionPx = Number.NEGATIVE_INFINITY;
			let controlsIntruderId = "";
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
				const intrusion = controls
					? Math.min(r.right - controls.left, controls.right - r.left, r.bottom - controls.top, controls.bottom - r.top)
					: Number.NEGATIVE_INFINITY;
				if (intrusion > controlsIntrusionPx) {
					controlsIntrusionPx = intrusion;
					controlsIntruderId = box.getAttribute("data-arch-node-id") || box.id || "(unnamed)";
				}
				if (overflow > worstOverflowPx) {
					worstOverflowPx = overflow;
					worstId = box.getAttribute("data-arch-node-id") || box.id || "(unnamed)";
				}
			}

			// edges and their labels are part of the drawing too — a lane or label right of the spine widens it past every box
			for (const el of Array.from(canvas.querySelectorAll("svg path.flowchart-link, svg g.edgeLabel foreignObject"))) {
				const r = el.getBoundingClientRect();
				if (r.width === 0 && r.height === 0) continue;
				drawn.left = Math.min(drawn.left, r.left);
				drawn.right = Math.max(drawn.right, r.right);
				drawn.top = Math.min(drawn.top, r.top);
				drawn.bottom = Math.max(drawn.bottom, r.bottom);
			}
			const drawableRight = controls ? Math.min(pane.right, controls.left) : pane.right;

			return {
				paneWidth: pane.width,
				paneHeight: pane.height,
				drawableWidth: drawableRight - pane.left,
				scale,
				labelPx: declared * scale,
				boxCount: boxes.length,
				drawnWidthPx: drawn.right - drawn.left,
				drawnHeightPx: drawn.bottom - drawn.top,
				gapPx: {
					above: drawn.top - pane.top,
					below: pane.bottom - drawn.bottom,
					left: drawn.left - pane.left,
					right: drawableRight - drawn.right,
				},
				worstOverflowPx,
				worstId,
				controls: { intrusionPx: controlsIntrusionPx, intruderId: controlsIntruderId },
			};
		}, canvasSelector);
}

async function readViewportScale(page: Page, canvasSelector: string): Promise<number> {
	return page.evaluate((sel) => {
		const vp = document.querySelector(`${sel} .svg-pan-zoom_viewport`);
		return vp instanceof SVGGraphicsElement ? (vp.getCTM()?.a ?? 0) : 0;
	}, canvasSelector);
}

// clicks a zoom control and waits until the library has flushed a different scale into the CTM
async function pressZoomControl(page: Page, canvasSelector: string, name: string): Promise<void> {
	const before = await readViewportScale(page, canvasSelector);
	await page.getByRole("button", { name }).click();
	await page.waitForFunction(
		({ sel, prev }) => {
			const vp = document.querySelector(`${sel} .svg-pan-zoom_viewport`);
			const m = vp instanceof SVGGraphicsElement ? vp.getCTM() : null;
			return Boolean(m && Math.abs(m.a - prev) > 1e-6);
		},
		{ sel: canvasSelector, prev: before },
		{ timeout: 10_000 },
	);
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

// smallest label size at the default view, then after each zoom-in press up to the budget
async function readZoomInLabelPx(width: number, height: number): Promise<number[]> {
	const { page, canvasSelector } = await openFittedPage(width, height);
	try {
		const sizes = [(await measureFit(page, canvasSelector)).labelPx];
		for (let press = 1; press <= ZOOM_IN_PRESS_BUDGET; press += 1) {
			await pressZoomControl(page, canvasSelector, "Zoom in");
			sizes.push((await measureFit(page, canvasSelector)).labelPx);
		}
		return sizes;
	} finally {
		await page.close();
	}
}

// default-view scale, the scale after zooming well in, and the scale the Reset control returns to
async function readResetAfterZoomIn(width: number, height: number, extraSource?: string) {
	const { page, canvasSelector } = await openFittedPage(width, height, extraSource);
	try {
		const defaultScale = await readViewportScale(page, canvasSelector);
		for (let press = 0; press < ZOOM_IN_PRESSES_BEFORE_RESET; press += 1) {
			await pressZoomControl(page, canvasSelector, "Zoom in");
		}
		const zoomedScale = await readViewportScale(page, canvasSelector);
		await pressZoomControl(page, canvasSelector, "Reset diagram view");
		return { defaultScale, zoomedScale, resetScale: await readViewportScale(page, canvasSelector) };
	} finally {
		await page.close();
	}
}

// default-view scale, and where Reset lands when it follows a zoom-in inside one frame — before the library flushes that zoom into the CTM
async function readResetInZoomFrame(width: number, height: number) {
	const { page, canvasSelector } = await openFittedPage(width, height);
	try {
		const defaultScale = await readViewportScale(page, canvasSelector);
		await page.evaluate((sel) => {
			const canvas = document.querySelector(sel);
			for (const key of ["+", "0"]) canvas?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
		}, canvasSelector);
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		return { defaultScale, resetScale: await readViewportScale(page, canvasSelector) };
	} finally {
		await page.close();
	}
}

interface ZoneReading {
	overlaps: string[];
	occludedTitles: string[];
	titleBands: string[];
	hiddenTitleCount: number;
	zoneCount: number;
}

// a zone whose title repeats its lone member's label — the drawn map holds none, so the hidden-title trim needs one supplied
const REDUNDANT_TITLE_ZONE = [
	'    subgraph fitprobe["Probe store"]',
	'        fitprobe_store[("Probe store (fixture)")]',
	"    end",
].join("\n");

// a short chain ending in a fan — a wider and taller part set than the served map, shrunk hardest by the contain fit at the narrow widths
const WIDE_TALL_PROBE = [
	'    fitwide0["Wide probe step"] --> fitwide1["Wide probe step 1"]',
	...Array.from({ length: 4 }, (_, i) => `    fitwide1 --> fittall${i}["Tall probe leaf ${i}"]`),
].join("\n");

// serves the drawn diagrams with extra source lines appended to the map the screen opens on
async function addDiagramSource(page: Page, extraSource: string): Promise<void> {
	await page.route("**/api/architecture/diagrams", async (route) => {
		const response = await route.fetch();
		const payload = (await response.json()) as { diagrams: { id: string; mermaid_source: string }[] };
		const drawn = payload.diagrams.find((diagram) => diagram.id === "v2-overview-entry");
		assert.ok(drawn, "fixture precondition: the overview map is served");
		drawn.mermaid_source += `\n${extraSource}\n`;
		await route.fulfill({ response, json: payload });
	});
}

// 존 상자끼리의 겹침과, 보이는 존 제목의 양 끝이 제 존 위에서 읽히는지를 잼.
async function readZones(width: number, height: number, extraSource?: string): Promise<ZoneReading> {
	assert.ok(browser, "browser must be up");
	const page = await browser.newPage({ viewport: { width, height } });
	try {
		if (extraSource) await addDiagramSource(page, extraSource);
		await page.goto(`${serverUrl}/#architecture`, { waitUntil: "load" });
		await page.waitForFunction(
			() => Number(document.querySelector(".svg-pan-zoom_viewport")?.getAttribute("data-arch-fit-scale")) > 0,
			null,
			{ timeout: 60_000 },
		);
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));

		return await page.evaluate(() => {
			const zones = Array.from(document.querySelectorAll(".arch-mermaid-canvas svg g.cluster")).map((el) => {
				const box = (el.querySelector(":scope > rect") as SVGRectElement).getBoundingClientRect();
				const title = el.querySelector(":scope > .cluster-label");
				const titleBox = title && getComputedStyle(title).display !== "none" ? title.getBoundingClientRect() : null;
				return { el, name: (title?.textContent || el.id).trim(), box, titleBox };
			});

			const overlaps: string[] = [];
			for (let i = 0; i < zones.length; i++)
				for (let j = i + 1; j < zones.length; j++) {
					const a = zones[i].box;
					const b = zones[j].box;
					const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
					const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
					if (overlapX > 0 && overlapY > 0)
						overlaps.push(`${zones[i].name} ∩ ${zones[j].name} ${overlapX.toFixed(0)}x${overlapY.toFixed(0)}px`);
				}

			// 제목의 첫 글자와 끝 글자 자리에서 맨 위에 그려진 것이 제 존이어야 함 — 이웃 존이 덮으면 잘려 읽힘.
			const occludedTitles = zones
				.filter((zone) => zone.titleBox && zone.titleBox.width > 0)
				.filter((zone) => {
					const t = zone.titleBox as DOMRect;
					const midY = (t.top + t.bottom) / 2;
					return [t.left + 2, t.right - 2].some((x) => {
						const owner = document.elementFromPoint(x, midY)?.closest("g.cluster");
						return owner !== zone.el || t.left < zone.box.left || t.right > zone.box.right;
					});
				})
				.map((zone) => zone.name);

			// a zone whose title is hidden keeps no band for it — its members sit as close to the top edge as to the bottom
			const nodeBoxes = Array.from(document.querySelectorAll(".arch-mermaid-canvas svg g.node")).map((node) =>
				node.getBoundingClientRect(),
			);
			const hiddenTitleZones = zones.filter((zone) => !zone.titleBox);
			const titleBands = hiddenTitleZones
				.flatMap((zone) => {
					const b = zone.box;
					const members = nodeBoxes.filter((n) => {
						const cx = (n.left + n.right) / 2;
						const cy = (n.top + n.bottom) / 2;
						return cx > b.left && cx < b.right && cy > b.top && cy < b.bottom;
					});
					if (members.length === 0) return [];
					const topGap = Math.min(...members.map((n) => n.top)) - b.top;
					const bottomGap = b.bottom - Math.max(...members.map((n) => n.bottom));
					return topGap > bottomGap + 2 ? [`${zone.name} top ${topGap.toFixed(1)}px vs bottom ${bottomGap.toFixed(1)}px`] : [];
				});

			return { overlaps, occludedTitles, titleBands, hiddenTitleCount: hiddenTitleZones.length, zoneCount: zones.length };
		});
	} finally {
		await page.close();
	}
}

// drawn node-label, zone-title or edge-label lines, words grouped by rendered line top
const LABEL_SELECTORS = {
	node: { group: "g.node", label: ".nodeLabel" },
	zone: { group: "g.cluster", label: ":scope > .cluster-label" },
	edge: { group: "g.edgeLabel", label: ".edgeLabel" },
};

async function readLabelLines(width: number, height: number, of: keyof typeof LABEL_SELECTORS = "node"): Promise<{ id: string; lines: string[]; tooltip: string; name: string }[]> {
	assert.ok(browser, "browser must be up");
	const page = await browser.newPage({ viewport: { width, height } });
	try {
		await page.goto(`${serverUrl}/#architecture`, { waitUntil: "load" });
		await page.waitForFunction(
			() => Number(document.querySelector(".svg-pan-zoom_viewport")?.getAttribute("data-arch-fit-scale")) > 0,
			null,
			{ timeout: 60_000 },
		);
		return await page.evaluate((selectors) =>
			Array.from(document.querySelectorAll(`.arch-mermaid-canvas svg ${selectors.group}`)).map((node) => {
				const label = node.querySelector(selectors.label) ?? node;
				const lineByTop: [number, string[]][] = [];
				const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
				for (let text = walker.nextNode(); text; text = walker.nextNode()) {
					for (const word of (text.textContent || "").matchAll(/\S+/g)) {
						const range = document.createRange();
						range.setStart(text, word.index ?? 0);
						range.setEnd(text, (word.index ?? 0) + word[0].length);
						const top = range.getClientRects()[0]?.top ?? 0;
						const line = lineByTop.find(([lineTop]) => Math.abs(lineTop - top) <= 2);
						if (line) line[1].push(word[0]);
						else lineByTop.push([top, [word[0]]]);
					}
				}
				return {
					id: node.getAttribute("data-arch-node-id") || node.id,
					lines: lineByTop.map(([, words]) => words.join(" ")),
					tooltip: node.querySelector(":scope > title")?.textContent ?? "",
					name: node.getAttribute("aria-label") ?? "",
				};
			}),
			LABEL_SELECTORS[of],
		);
	} finally {
		await page.close();
	}
}

for (const { width, height } of VIEWPORTS.filter((viewport) => viewport.width === 1024 || viewport.width === 1440)) {
	test(`every node and edge label is drawn on one line at ${width}x${height}`, async () => {
		const nodes = await readLabelLines(width, height);
		const edges = (await readLabelLines(width, height, "edge")).filter((label) => label.lines.length > 0);
		const labels = [...nodes, ...edges];
		const drawn = labels.map((label) => `${label.id}: ${label.lines.join(" | ")}`).join("; ");
		// a multi-word label on both sides — one-word labels alone would pass the one-line check vacuously
		const hasMultiWord = (set: typeof labels) => set.some((label) => label.lines.join(" ").split(" ").length > 1);
		assert.ok(hasMultiWord(nodes) && hasMultiWord(edges), `no multi-word node and edge label to check: ${drawn}`);
		assert.deepEqual(
			labels.filter((label) => label.lines.length > 1).map((label) => `${label.id}: ${label.lines.join(" | ")}`),
			[],
			`labels drawn on more than one line: ${drawn}`,
		);
	});
}

// the two-column map — drawn zone ids in source order, each column's zones top to bottom, and the wrapper each column is laid out in
const ZONE_IDS = {
	DRAWN: [...CANONICAL_MAP.mermaid_drawn.matchAll(/subgraph\s+(\w+)/g)].map(([, id]) => id),
	SOURCES: ["entry", "daemon"],
	PIPELINE: ["orch", "agents", "hooks", "data", "export"],
	COLUMN: { sources: "map_col_sources", pipeline: "map_col_pipeline" },
};

// drawn member ids per zone in declaration order, from the drawn source's subgraph blocks
const MEMBER_IDS = new Map(
	[...CANONICAL_MAP.mermaid_drawn.matchAll(/subgraph\s+(\w+)\[[^\]]*\]\n([\s\S]*?)\n\s*end/g)].map(([, zone, body]) => [
		zone,
		[...body.matchAll(/^\s*(\w+)[[("]/gm)].map(([, id]) => id),
	]),
);

type Box = { left: number; right: number; top: number; bottom: number };
type Point = { x: number; y: number };

interface MapShape {
	// CSS px per layout unit at the default view
	scale: number;
	zones: Record<string, Box>;
	// zone id → the column wrapper the screen laid it out in
	columns: Record<string, string>;
	members: { id: string; box: Box }[];
	// screen polylines of every drawn link, sampled along the path · kind is the screen-drawn edge kind ("" for ELK-routed) · headPx the arrowhead length
	links: { id: string; kind: string; points: Point[]; headPx: number }[];
	// screen-drawn edge labels and the `from>to` edge each one captions
	labels: { edge: string; box: Box }[];
}

// zone frames, member boxes, sampled link polylines and screen-drawn labels in client px at the default view
async function readMapShape(width: number, height: number): Promise<MapShape> {
	const { page, canvasSelector } = await openFittedPage(width, height);
	try {
		// inline mappers only — a named helper inside evaluate gains tsx's __name wrapper, which the page does not define
		return await page.evaluate((sel) => {
			const clusters = Array.from(document.querySelectorAll(`${sel} svg g.cluster`));
			const vp = document.querySelector(`${sel} .svg-pan-zoom_viewport`) as SVGGraphicsElement;
			return {
				scale: vp.getCTM()?.a ?? 0,
				zones: Object.fromEntries(
					clusters.map((el) => [el.id.slice(el.id.lastIndexOf("-") + 1), (el.querySelector(":scope > rect") ?? el).getBoundingClientRect().toJSON() as Box]),
				),
				columns: Object.fromEntries(clusters.map((el) => [el.id.slice(el.id.lastIndexOf("-") + 1), el.getAttribute("data-arch-column") ?? ""])),
				members: Array.from(document.querySelectorAll(`${sel} svg g.node`)).map((el) => ({
					id: /flowchart-(.+)-\d+$/.exec(el.id)?.[1] ?? el.id,
					box: el.getBoundingClientRect().toJSON() as Box,
				})),
				links: Array.from(document.querySelectorAll(`${sel} svg path.flowchart-link`)).map((el) => {
					const path = el as SVGPathElement;
					const ctm = path.getScreenCTM() as DOMMatrix;
					const length = path.getTotalLength();
					const count = Math.max(2, Math.ceil(length / 4));
					const markerId = /url\(["']?#([^"')]+)/.exec(path.getAttribute("marker-end") || getComputedStyle(path).markerEnd || "")?.[1];
					const marker = markerId ? document.getElementById(markerId) : null;
					return {
						id: path.getAttribute("data-id") || path.id,
						kind: path.getAttribute("data-arch-edge") ?? "",
						points: Array.from({ length: count + 1 }, (_, i) => {
							const p = path.getPointAtLength((length * i) / count).matrixTransform(ctm);
							return { x: p.x, y: p.y };
						}),
						headPx: marker && marker.getAttribute("markerUnits") === "userSpaceOnUse" ? Number(marker.getAttribute("markerWidth")) * ctm.a : 0,
					};
				}),
				labels: Array.from(document.querySelectorAll(`${sel} svg g.edgeLabel[data-arch-edge-label]`)).map((el) => ({
					edge: el.getAttribute("data-arch-edge-label") ?? "",
					box: (el.querySelector("foreignObject") ?? el).getBoundingClientRect().toJSON() as Box,
				})),
			};
		}, canvasSelector);
	} finally {
		await page.close();
	}
}

function getZoneBox(shape: MapShape, id: string): Box {
	const box = shape.zones[id];
	if (!box) throw new Error(`zone ${id} was not drawn: ${JSON.stringify(Object.keys(shape.zones))}`);
	return box;
}

function getUnion(boxes: Box[]): Box {
	return {
		left: Math.min(...boxes.map((b) => b.left)),
		right: Math.max(...boxes.map((b) => b.right)),
		top: Math.min(...boxes.map((b) => b.top)),
		bottom: Math.max(...boxes.map((b) => b.bottom)),
	};
}

// proper crossing of two segments — touching at an end does not count
function isCrossing(a: Point, b: Point, c: Point, d: Point): boolean {
	const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
	const [d1, d2, d3, d4] = [side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)];
	return d1 * d2 < 0 && d3 * d4 < 0;
}

type Run = { link: string; kind: string; axis: "x" | "y"; at: number; min: number; max: number };

// axis-aligned runs of a sampled polyline — consecutive steps on one x are a vertical run, on one y a horizontal one
function getRuns(link: MapShape["links"][number]): Run[] {
	const runs: (Run & { end: number })[] = [];
	link.points.slice(1).forEach((p, i) => {
		const q = link.points[i];
		const axis = Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) >= 0.5 ? "x" : Math.abs(p.y - q.y) < 0.5 && Math.abs(p.x - q.x) >= 0.5 ? "y" : null;
		if (!axis) return;
		const at = axis === "x" ? p.x : p.y;
		const [a, b] = axis === "x" ? [q.y, p.y] : [q.x, p.x];
		const last = runs.at(-1);
		if (last && last.axis === axis && last.end === i && Math.abs(last.at - at) < 0.5) {
			last.min = Math.min(last.min, a, b);
			last.max = Math.max(last.max, a, b);
			last.end = i + 1;
		} else runs.push({ link: link.id, kind: link.kind, axis, at, min: Math.min(a, b), max: Math.max(a, b), end: i + 1 });
	});
	return runs;
}

// gap from a box to the nearest sampled point of a link (0 when a point lies inside)
function getBoxGap(box: Box, points: Point[]): number {
	return Math.min(...points.map((q) => Math.hypot(Math.max(box.left - q.x, q.x - box.right, 0), Math.max(box.top - q.y, q.y - box.bottom, 0))));
}

// a link draws the `from>to` edge — an ELK edge keeps the source ids, a screen-drawn one adds its own suffix
function isLinkOf(linkId: string, edge: string): boolean {
	const [from, to] = edge.split(">");
	return linkId.startsWith(`L_${from}_${to}_`);
}

for (const { width, height } of VIEWPORTS) {
	test(`the sources column sits left of the spine, top-aligned with Orchestrator, each column read top to bottom at ${width}x${height}`, async () => {
		const shape = await readMapShape(width, height);
		const drawn = JSON.stringify(shape.zones);
		assert.deepEqual(Object.keys(shape.zones).sort(), [...ZONE_IDS.DRAWN].sort(), `drawn zones (the column frames must be gone): ${drawn}`);
		for (const [column, ids] of [[ZONE_IDS.COLUMN.sources, ZONE_IDS.SOURCES], [ZONE_IDS.COLUMN.pipeline, ZONE_IDS.PIPELINE]] as const)
			for (const id of ids) assert.equal(shape.columns[id], column, `${id} was not laid out in ${column}: ${JSON.stringify(shape.columns)}`);
		const box = (id: string) => getZoneBox(shape, id);
		const left = getUnion(ZONE_IDS.SOURCES.map(box));
		const right = getUnion(ZONE_IDS.PIPELINE.map(box));
		assert.ok(left.right <= right.left + EPS_PX, `the sources column overlaps the spine horizontally: ${drawn}`);
		assert.ok(left.bottom > right.top && right.bottom > left.top, `the columns do not share a vertical extent: ${drawn}`);
		assert.ok(Math.abs(left.top - box("orch").top) <= EPS_PX, `the sources column is not top-aligned with Orchestrator (${left.top.toFixed(1)} vs ${box("orch").top.toFixed(1)}): ${drawn}`);
		for (const ids of [ZONE_IDS.SOURCES, ZONE_IDS.PIPELINE])
			for (const [i, below] of ids.slice(1).entries())
				assert.ok(box(below).top >= box(ids[i]).bottom - EPS_PX, `${below} does not sit below ${ids[i]}: ${drawn}`);
	});

	test(`each column's stacked zone frames share one width and one left edge at ${width}x${height}`, async () => {
		const shape = await readMapShape(width, height);
		for (const ids of [ZONE_IDS.SOURCES, ZONE_IDS.PIPELINE]) {
			const frames = ids.map((id) => ({ id, box: getZoneBox(shape, id) }));
			const spans = frames.map(({ id, box }) => `${id} ${box.left.toFixed(1)}–${box.right.toFixed(1)}`).join(", ");
			const [first] = frames;
			for (const { box } of frames.slice(1)) {
				assert.ok(Math.abs(box.left - first.box.left) <= EPS_PX, `the frames do not share a left edge: ${spans}`);
				assert.ok(Math.abs(box.right - first.box.right) <= EPS_PX, `the frames do not share one width: ${spans}`);
			}
		}
	});

	test(`the Daemons members stack in declaration order and every member sits inside its own zone at ${width}x${height}`, async () => {
		const shape = await readMapShape(width, height);
		const declared = MEMBER_IDS.get("daemon") ?? [];
		const daemons = declared.map((id) => shape.members.find((m) => m.id === id)).filter((m) => m !== undefined);
		assert.equal(daemons.length, declared.length, `Daemons members drawn: ${JSON.stringify(shape.members.map((m) => m.id))}`);
		for (const [i, a] of daemons.entries())
			for (const b of daemons.slice(i + 1)) {
				assert.ok(Math.min(a.box.right, b.box.right) > Math.max(a.box.left, b.box.left), `${a.id} and ${b.id} do not overlap horizontally`);
				assert.ok(b.box.top >= a.box.bottom - EPS_PX, `${b.id} does not sit below ${a.id}, against the declaration order ${declared.join(", ")}`);
			}
		for (const [zone, ids] of MEMBER_IDS) {
			const frame = getZoneBox(shape, zone);
			for (const member of shape.members.filter((m) => ids.includes(m.id)))
				assert.ok(
					member.box.left >= frame.left - EPS_PX && member.box.right <= frame.right + EPS_PX && member.box.top >= frame.top - EPS_PX && member.box.bottom <= frame.bottom + EPS_PX,
					`${member.id} leaves its ${zone} frame: ${JSON.stringify({ member: member.box, frame })}`,
				);
		}
	});

	test(`every edge runs down or across without a crossing, and parallel lanes keep apart, at ${width}x${height}`, async (t) => {
		const shape = await readMapShape(width, height);
		const kinds = shape.links.map((l) => `${l.id}:${l.kind || "elk"}`).join(", ");
		assert.equal(shape.links.length, 7, `drawn links: ${kinds}`);
		assert.equal(shape.links.filter((l) => l.kind === "bus").length, 2, `bus edges into Orchestrator: ${kinds}`);
		assert.equal(shape.links.filter((l) => l.kind === "bypass").length, 1, `bypass edges: ${kinds}`);
		for (const link of shape.links) {
			const steps = link.points.slice(1).map((p, i) => ({ dx: p.x - link.points[i].x, dy: p.y - link.points[i].y }));
			const last = steps.at(-1) ?? { dx: 0, dy: 0 };
			if (link.kind === "bus") {
				// a bus climbs only on its vertical run and enters Orchestrator's left side
				const offBus = steps.filter((s) => s.dy < -EPS_PX && Math.abs(s.dx) >= 0.5);
				assert.deepEqual(offBus, [], `${link.id} climbs off its vertical run`);
				assert.ok(last.dx > Math.abs(last.dy), `${link.id} does not end pointing right`);
				continue;
			}
			const rise = Math.max(...steps.map((s) => -s.dy));
			assert.ok(rise <= EPS_PX, `${link.id} steps ${rise.toFixed(1)}px up`);
			if (link.kind === "bypass") assert.ok(-last.dx > Math.abs(last.dy), `${link.id} does not end pointing left into its target's right side`);
			else assert.ok(last.dy > Math.abs(last.dx), `${link.id} does not end pointing down`);
		}
		const crossings = shape.links.flatMap((a, i) =>
			shape.links.slice(i + 1).flatMap((b) =>
				a.points.slice(1).some((p, j) => b.points.slice(1).some((q, k) => isCrossing(a.points[j], p, b.points[k], q))) ? [`${a.id} × ${b.id}`] : [],
			),
		);
		assert.deepEqual(crossings, [], "edges cross");
		// facing parallel runs of different edges — only the two bus edges may coincide, on their designed merge into Orchestrator
		const runs = shape.links.flatMap(getRuns);
		const gaps = runs.flatMap((a, i) =>
			runs.slice(i + 1).flatMap((b) => {
				if (a.link === b.link || a.axis !== b.axis || (a.kind === "bus" && b.kind === "bus")) return [];
				if (Math.min(a.max, b.max) - Math.max(a.min, b.min) <= 2) return [];
				return [{ pair: `${a.link} ∥ ${b.link}`, units: Math.abs(a.at - b.at) / shape.scale }];
			}),
		);
		t.diagnostic(`closest parallel lanes: ${gaps.sort((a, b) => a.units - b.units).slice(0, 3).map((g) => `${g.pair} ${g.units.toFixed(1)}u`).join(" · ")}`);
		const close = gaps.filter((g) => g.units < MIN_LANE_GAP_UNITS - 0.5);
		assert.deepEqual(close.map((g) => `${g.pair} ${g.units.toFixed(1)}u`), [], `parallel lanes closer than ${MIN_LANE_GAP_UNITS} units`);
	});

	test(`every arrowhead reads as a direction, on a visible final leg, at ${width}x${height}`, async (t) => {
		const shape = await readMapShape(width, height);
		const legs = shape.links.map((link) => {
			const lastRun = getRuns(link).at(-1);
			return { id: link.id, headPx: link.headPx, legPx: lastRun ? lastRun.max - lastRun.min : 0 };
		});
		t.diagnostic(legs.map((l) => `${l.id}: head ${l.headPx.toFixed(1)}px on a ${l.legPx.toFixed(1)}px leg`).join(" · "));
		for (const leg of legs) {
			assert.ok(leg.headPx >= MIN_ARROWHEAD_PX, `${leg.id}: the arrowhead is ${leg.headPx.toFixed(1)}px long, under ${MIN_ARROWHEAD_PX}px`);
			assert.ok(leg.legPx > leg.headPx, `${leg.id}: the ${leg.legPx.toFixed(1)}px final leg is no longer than its ${leg.headPx.toFixed(1)}px head`);
		}
	});

	test(`each screen-drawn edge label sits nearer its own edge than any other and clear of every other edge at ${width}x${height}`, async (t) => {
		const shape = await readMapShape(width, height);
		const labelled = ["orch>agents", "agents>hooks", "agents>data", "hooks>data", "data>export"];
		assert.deepEqual(shape.labels.map((l) => l.edge).sort(), [...labelled].sort(), "the screen draws the spine and bypass labels");
		for (const label of shape.labels) {
			const own = shape.links.filter((l) => isLinkOf(l.id, label.edge));
			assert.equal(own.length, 1, `${label.edge}: own edge among ${shape.links.map((l) => l.id).join(", ")}`);
			const ownUnits = getBoxGap(label.box, own[0].points) / shape.scale;
			const foreign = shape.links.filter((l) => l !== own[0]).map((l) => ({ id: l.id, units: getBoxGap(label.box, l.points) / shape.scale }));
			const nearest = foreign.sort((a, b) => a.units - b.units)[0];
			t.diagnostic(`${label.edge}: own edge ${ownUnits.toFixed(0)}u · nearest other ${nearest.id} ${nearest.units.toFixed(0)}u`);
			assert.ok(ownUnits < nearest.units, `${label.edge} sits ${ownUnits.toFixed(0)}u from its own edge, nearer ${nearest.id} at ${nearest.units.toFixed(0)}u`);
			assert.ok(nearest.units >= LABEL_CLEARANCE_UNITS, `${label.edge} sits ${nearest.units.toFixed(0)}u from ${nearest.id}, inside its ${LABEL_CLEARANCE_UNITS}u band`);
		}
	});
}

// canonical source zone id → its full title; the drawn map shows a one-word display name instead
const SOURCE_ZONE_TITLES = new Map(
	[...(DIAGRAMS.find((diagram) => diagram.slug === CANONICAL_MAP.slug)?.mermaid_source ?? "").matchAll(/subgraph\s+(\w+)\["([^"]*)"\]/g)].map(
		([, id, title]) => [id, title],
	),
);

// cluster element id → its zone id, longest suffix match (mermaid prefixes the subgraph id)
function getZoneIdOf(elementId: string): string {
	return [...SOURCE_ZONE_TITLES.keys()].filter((id) => elementId === id || elementId.endsWith(`-${id}`)).sort((a, b) => b.length - a.length)[0] ?? "";
}

for (const { width, height } of VIEWPORTS) {
	test(`no zone title stacks one word per line at ${width}x${height}`, async () => {
		const titles = await readLabelLines(width, height, "zone");
		assert.ok(titles.length > 0, "no zone title was measured");
		// a bare symbol ('&') is not a word, so '& tracking' still reads as a one-word line
		const countWords = (line: string) => line.split(" ").filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
		const stacked = titles.filter((title) => {
			const words = countWords(title.lines.join(" "));
			return words > 1 && title.lines.length >= words;
		});
		assert.deepEqual(stacked.map((title) => `${title.id}: ${title.lines.join(" | ")}`), [], "zone titles drawn one word per line");
	});
}

test("every drawn zone carries its full source title as tooltip and accessible name", async () => {
	const zones = await readLabelLines(1440, 900, "zone");
	const drawnZoneIds = zones.map((zone) => getZoneIdOf(zone.id));
	assert.equal(drawnZoneIds.filter(Boolean).length, zones.length, `a drawn zone matched no source zone: ${zones.map((zone) => zone.id).join(", ")}`);
	const mismatched = zones
		.map((zone, index) => ({ zone, full: SOURCE_ZONE_TITLES.get(drawnZoneIds[index]) }))
		.filter(({ zone, full }) => zone.tooltip !== full || zone.name !== full)
		.map(({ zone, full }) => `${zone.id}: tooltip ${JSON.stringify(zone.tooltip)} name ${JSON.stringify(zone.name)} vs source ${JSON.stringify(full)}`);
	assert.deepEqual(mismatched, [], "zone full titles");
});

for (const { width, height } of VIEWPORTS) {
	test(`zone boxes never overlap and every zone title reads whole at ${width}x${height}`, async () => {
		const r = await readZones(width, height);
		assert.ok(r.zoneCount > 0, "no zone boxes were measured — the map did not render");
		assert.deepEqual(r.overlaps, [], `zone boxes overlap: ${r.overlaps.join("; ")}`);
		assert.deepEqual(r.occludedTitles, [], `zone titles covered or cut: ${r.occludedTitles.join("; ")}`);
	});

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

	for (const partSet of [
		{ name: "the served map", extraSource: undefined },
		{ name: "a wider and taller map", extraSource: WIDE_TALL_PROBE },
	]) {
		test(`no drawn box sits under the zoom controls with ${partSet.name} at ${width}x${height}`, async () => {
			const r = await readFit(width, height, partSet.extraSource);
			assert.ok(r.boxCount > 0, "no node or zone boxes were measured — the map did not render");
			assert.ok(
				r.controls.intrusionPx <= EPS_PX,
				`\`${r.controls.intruderId}\` reaches ${r.controls.intrusionPx.toFixed(1)}px under the zoom controls, so a click there presses a button ` +
					`(pane ${r.paneWidth.toFixed(0)}x${r.paneHeight.toFixed(0)} at scale ${r.scale.toFixed(4)})`,
			);
		});
	}

	test(`zooming in from the default view makes every label legible within ${ZOOM_IN_PRESS_BUDGET} presses at ${width}x${height}`, async () => {
		const sizes = await readZoomInLabelPx(width, height);
		assert.ok(sizes[0] > 0, "no drawn label was measured");
		const reached = sizes.findIndex((px) => px >= MIN_RENDERED_LABEL_PX - CTM_FLOAT_TOLERANCE);
		assert.ok(
			reached >= 0,
			`labels stay under ${MIN_RENDERED_LABEL_PX}px after ${ZOOM_IN_PRESS_BUDGET} zoom-in presses: ${sizes.map((px) => px.toFixed(2)).join(" → ")}`,
		);
	});

	test(`every label reaches the meta floor in the default view at ${width}x${height}`, async () => {
		const r = await readFit(width, height);
		assert.ok(r.labelPx > 0, "no drawn label was measured");
		assert.ok(r.labelPx >= MIN_RENDERED_LABEL_PX - CTM_FLOAT_TOLERANCE, `the smallest label is ${r.labelPx.toFixed(2)}px at scale ${r.scale.toFixed(4)}`);
	});

	test(`the default view spans 90% of its frame on the binding axis at ${width}x${height}`, async () => {
		const r = await readFit(width, height);
		const fill = Math.max(r.drawnWidthPx / r.drawableWidth, r.drawnHeightPx / r.paneHeight);
		const atNaturalShare = r.scale >= DEFAULT_VIEW_SHARE - CTM_FLOAT_TOLERANCE;
		assert.ok(
			fill <= DEFAULT_VIEW_SHARE + 0.01,
			`the map fills ${(fill * 100).toFixed(1)}% of its frame on the binding axis — more than the 90% overview`,
		);
		assert.ok(
			fill >= DEFAULT_VIEW_SHARE * MIN_BINDING_AXIS_FILL || atNaturalShare,
			`the map fills ${(fill * 100).toFixed(1)}% of its frame on the binding axis at scale ${r.scale.toFixed(4)} — less than the 90% overview`,
		);
	});
}

for (const { width, height } of VIEWPORTS) {
	test(`the default view is centred on both axes of its frame at ${width}x${height}`, async () => {
		const r = await readFit(width, height);
		const gaps = `pane ${r.paneWidth.toFixed(0)}x${r.paneHeight.toFixed(0)} · drawn ${r.drawnWidthPx.toFixed(0)}x${r.drawnHeightPx.toFixed(0)} · ` +
			`slack above ${r.gapPx.above.toFixed(1)} below ${r.gapPx.below.toFixed(1)} left ${r.gapPx.left.toFixed(1)} right ${r.gapPx.right.toFixed(1)}`;
		assert.ok(Math.abs(r.gapPx.above - r.gapPx.below) <= MAX_CENTRING_SKEW_PX, `not centred vertically: ${gaps}`);
		assert.ok(Math.abs(r.gapPx.left - r.gapPx.right) <= MAX_CENTRING_SKEW_PX, `not centred horizontally: ${gaps}`);
	});

	for (const partSet of [
		{ name: "the served map", extraSource: undefined },
		{ name: "a wider and taller map", extraSource: WIDE_TALL_PROBE },
	]) {
		test(`Reset returns a zoomed-in map to the default view with ${partSet.name} at ${width}x${height}`, async () => {
			const r = await readResetAfterZoomIn(width, height, partSet.extraSource);
			assert.ok(r.zoomedScale > r.defaultScale * 2, `zoom-in did not move past the default view: ${JSON.stringify(r)}`);
			assert.ok(Math.abs(r.resetScale - r.defaultScale) < 1e-3, `Reset landed at ${r.resetScale.toFixed(4)}, not the default ${r.defaultScale.toFixed(4)}`);
		});
	}
}

test("Reset pressed in the same frame as a zoom-in still lands on the default view", async () => {
	const { width, height } = VIEWPORTS[0];
	const r = await readResetInZoomFrame(width, height);
	assert.ok(Math.abs(r.resetScale - r.defaultScale) < 1e-3, `Reset landed at ${r.resetScale.toFixed(4)}, not the default ${r.defaultScale.toFixed(4)}`);
});

test("a zone whose title repeats its lone member hides the title and keeps no band for it", async () => {
	const r = await readZones(1440, 900, REDUNDANT_TITLE_ZONE);
	assert.ok(r.hiddenTitleCount > 0, "no hidden-title zone was measured — the band assertion below would be vacuous");
	assert.deepEqual(r.titleBands, [], `a zone with a hidden title keeps its title band: ${r.titleBands.join("; ")}`);
});

// below this width the map keeps a pane floor that wins over the part health peek band — owned here, never read from the screen
const PANE_FLOOR = { PX: 500, MAX_WIDTH_PX: 1280 };

// narrow windows, two of them short enough that the first-screen band alone would leave the map under the pane floor
const NARROW_VIEWPORTS = [
	{ width: 1024, height: 768 },
	{ width: 1024, height: 600 },
	{ width: 1180, height: 640 },
];

async function readPartHealthPlacement(width: number, height: number) {
	const { page, canvasSelector } = await openFittedPage(width, height);
	try {
		await page.waitForSelector(".arch-part-health", { timeout: 10_000 });
		const fit = await measureFit(page, canvasSelector);
		const placement = await page.evaluate((sel) => {
			const canvas = document.querySelector(sel) as HTMLElement;
			const block = document.querySelector(".arch-part-health") as HTMLElement;
			return {
				canvasBottom: canvas.getBoundingClientRect().bottom,
				blockTop: block.getBoundingClientRect().top,
				viewportHeight: window.innerHeight,
			};
		}, canvasSelector);
		return { fit, ...placement };
	} finally {
		await page.close();
	}
}

function isHeightBound(fit: FitReading): boolean {
	return fit.drawnHeightPx / fit.paneHeight >= fit.drawnWidthPx / fit.drawableWidth;
}

for (const { width, height } of [...VIEWPORTS, ...NARROW_VIEWPORTS.slice(1)]) {
	test(`the part health block starts under the map, never over it, at ${width}x${height}`, async () => {
		const r = await readPartHealthPlacement(width, height);
		assert.ok(r.blockTop >= r.canvasBottom - EPS_PX, `the block (top ${r.blockTop.toFixed(0)}) overlaps the map (bottom ${r.canvasBottom.toFixed(0)})`);
	});
}

for (const { width, height } of VIEWPORTS.filter((viewport) => viewport.width >= PANE_FLOOR.MAX_WIDTH_PX)) {
	test(`at ${PANE_FLOOR.MAX_WIDTH_PX}px wide or more the part health block starts on the first screen at ${width}x${height}`, async () => {
		const r = await readPartHealthPlacement(width, height);
		assert.ok(r.blockTop < r.viewportHeight, `the block starts at ${r.blockTop.toFixed(0)}px, below the ${r.viewportHeight}px screen`);
	});
}

test(`below ${PANE_FLOOR.MAX_WIDTH_PX}px wide the map keeps its ${PANE_FLOOR.PX}px pane floor on either binding axis, even when the part health block leaves the first screen`, async (t) => {
	const readings = [];
	for (const viewport of NARROW_VIEWPORTS) readings.push({ ...viewport, ...(await readPartHealthPlacement(viewport.width, viewport.height)) });

	for (const r of readings) {
		t.diagnostic(
			`${r.width}x${r.height}: pane ${r.fit.paneWidth.toFixed(0)}x${r.fit.paneHeight.toFixed(0)} · drawn ${r.fit.drawnWidthPx.toFixed(0)}x${r.fit.drawnHeightPx.toFixed(0)} · ` +
				`${isHeightBound(r.fit) ? "height" : "width"}-bound · block top ${r.blockTop.toFixed(0)} of ${r.viewportHeight}`,
		);
		// the short-graph clamp never takes the pane under the floor — a width-bound drawing keeps it too
		assert.ok(
			r.fit.paneHeight >= PANE_FLOOR.PX - EPS_PX,
			`${r.width}x${r.height}: the map pane is ${r.fit.paneHeight.toFixed(0)}px — under the ${PANE_FLOOR.PX}px floor`,
		);
	}
});
