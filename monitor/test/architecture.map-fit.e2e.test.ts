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
// The default view is an overview: the drawing at 70% of the contain fit, centred, with no label
// floor — detail is read by zooming in. Readings asserted together:
//   1. containment — every `.node` / `.cluster` client rect within the canvas rect.
//   2. overview share — the drawing spans ~70% of its frame on the binding axis, centred on both axes.
//   3. reach — zoom-in presses from the default view bring every label to >= MIN_RENDERED_LABEL_PX.
//   4. reset — the Reset control returns a zoomed-in map to the same default view.
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

// the 12px meta step the zoomed-in labels must reach, measured on the drawn labels — owned here, never read from the screen
const MIN_RENDERED_LABEL_PX = 12;

// the default view's share of the contain fit
const DEFAULT_VIEW_SHARE = 0.7;

// drawn boxes span at least this share of the viewBox on its binding axis (the rest is diagramPadding)
const MIN_BINDING_AXIS_FILL = 0.9;

// zoom-in presses from the default view within which every label reaches MIN_RENDERED_LABEL_PX
const ZOOM_IN_PRESS_BUDGET = 3;

// presses that take the map well past the default view before Reset — far enough to move the library's zoom base
const ZOOM_IN_PRESSES_BEFORE_RESET = 8;

// slack difference between opposite sides of a centred drawing — viewBox padding asymmetry at scale <= 0.7 plus rounding
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

// drawn zone boxes by zone id — the cluster id's last '-' segment
async function readZoneBoxes(width: number, height: number): Promise<Map<string, { left: number; right: number; top: number; bottom: number }>> {
	const { page } = await openFittedPage(width, height);
	try {
		const entries = await page.evaluate(() =>
			Array.from(document.querySelectorAll(".arch-mermaid-canvas svg g.cluster")).map((el) => {
				const r = el.getBoundingClientRect();
				return [el.id.slice(el.id.lastIndexOf("-") + 1), { left: r.left, right: r.right, top: r.top, bottom: r.bottom }] as const;
			}),
		);
		return new Map(entries);
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

// the ⊐ — drawn zone ids in source order; these three run back along the bottom row, Safety first
const DRAWN_ZONE_IDS = [...CANONICAL_MAP.mermaid_drawn.matchAll(/subgraph\s+(\w+)/g)].map(([, id]) => id);
const BOTTOM_ROW_ZONE_IDS = ["hooks", "data", "export"];

for (const { width, height } of VIEWPORTS) {
	test(`the bottom row runs right to left under the top row with Safety under Agents at ${width}x${height}`, async () => {
		const boxes = await readZoneBoxes(width, height);
		const drawn = JSON.stringify(Object.fromEntries(boxes));
		assert.deepEqual([...boxes.keys()].sort(), [...DRAWN_ZONE_IDS].sort(), `drawn zones: ${drawn}`);
		const getBox = (id: string) => {
			const box = boxes.get(id);
			if (!box) throw new Error(`zone ${id} was not drawn: ${drawn}`);
			return box;
		};
		const getCentreX = (id: string) => (getBox(id).left + getBox(id).right) / 2;
		const topRowBottom = Math.max(...DRAWN_ZONE_IDS.filter((id) => !BOTTOM_ROW_ZONE_IDS.includes(id)).map((id) => getBox(id).bottom));

		for (const id of BOTTOM_ROW_ZONE_IDS) assert.ok(getBox(id).top >= topRowBottom, `${id} does not sit below the top row: ${drawn}`);
		for (const [from, to] of [["entry", "orch"], ["daemon", "orch"], ["orch", "agents"], ["hooks", "data"], ["data", "export"]]) {
			const step = BOTTOM_ROW_ZONE_IDS.includes(from) ? -1 : 1;
			assert.ok((getCentreX(to) - getCentreX(from)) * step > 0, `${from} → ${to} runs against its row's direction: ${drawn}`);
		}
		assert.ok(Math.abs(getCentreX("hooks") - getCentreX("agents")) <= EPS_PX, `Safety is not centred under Agents: ${drawn}`);
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

	test(`the default view spans 70% of its frame on the binding axis at ${width}x${height}`, async () => {
		const r = await readFit(width, height);
		const fill = Math.max(r.drawnWidthPx / r.drawableWidth, r.drawnHeightPx / r.paneHeight);
		const atNaturalShare = r.scale >= DEFAULT_VIEW_SHARE - CTM_FLOAT_TOLERANCE;
		assert.ok(
			fill <= DEFAULT_VIEW_SHARE + 0.01,
			`the map fills ${(fill * 100).toFixed(1)}% of its frame on the binding axis — more than the 70% overview`,
		);
		assert.ok(
			fill >= DEFAULT_VIEW_SHARE * MIN_BINDING_AXIS_FILL || atNaturalShare,
			`the map fills ${(fill * 100).toFixed(1)}% of its frame on the binding axis at scale ${r.scale.toFixed(4)} — less than the 70% overview`,
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

// the part health block takes the band under the map — it has to start on the first screen, not after a scroll
async function readPartHealthPlacement(width: number, height: number) {
	assert.ok(browser, "browser must be up");
	const page = await browser.newPage({ viewport: { width, height } });
	try {
		await page.goto(`${serverUrl}/#architecture`, { waitUntil: "load" });
		await page.waitForFunction(
			() => Number(document.querySelector(".svg-pan-zoom_viewport")?.getAttribute("data-arch-fit-scale")) > 0,
			null,
			{ timeout: 60_000 },
		);
		await page.waitForSelector(".arch-part-health", { timeout: 10_000 });

		return await page.evaluate(() => {
			const canvas = document.querySelector(".arch-mermaid-canvas") as HTMLElement;
			const block = document.querySelector(".arch-part-health") as HTMLElement;
			return {
				canvasBottom: canvas.getBoundingClientRect().bottom,
				blockTop: block.getBoundingClientRect().top,
				viewportHeight: window.innerHeight,
			};
		});
	} finally {
		await page.close();
	}
}

for (const { width, height } of VIEWPORTS) {
	test(`the part health block starts under the map on the first screen at ${width}x${height}`, async () => {
		const r = await readPartHealthPlacement(width, height);
		assert.ok(r.blockTop >= r.canvasBottom - EPS_PX, `the block (top ${r.blockTop.toFixed(0)}) overlaps the map (bottom ${r.canvasBottom.toFixed(0)})`);
		assert.ok(r.blockTop < r.viewportHeight, `the block starts at ${r.blockTop.toFixed(0)}px, below the ${r.viewportHeight}px screen`);
	});
}
