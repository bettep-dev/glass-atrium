// E2E chromium MERGED-SURFACE harness for the system map (screens/architecture.jsx).
// Runner: npx tsx --test test/architecture.merged-surface.e2e.test.ts
//
// Multi-fixture by construction: the live payload is injectable per test case via
// openMap(getLiveFixture(overrides)), so a single file can assert both halves of a
// two-state claim. A single frozen fixture cannot. Every ArchitectureLiveResponse
// field is overridable — writers takes an ARRAY of writer objects
// ({ writer_name, dual_write_active, recent_failures_24h }), not a scalar flag.
//
// App: stripped Fastify (fastify-static + two hand-registered routes) on an
// ephemeral port. registerArchitectureRoutes is NOT called — it stands up the real
// /live handler (Prisma + home-directory drift read), which would redden this
// harness on daemon/settings state and would collide with the fixture route.
// Browser: Playwright chromium headless, NO mocking.
//
// Page-level network prerequisite: the page pulls React + mermaid from CDN, so the
// run REQUIRES outbound network and an installed chromium. An unmet prerequisite
// fails RED (asserted in openMap) — no skip guard absorbs it.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { getArchitecture } from "../src/server/architecture/parser.js";
import { DAEMON_NODE_BINDINGS } from "../src/server/architecture/diagrams-source.js";
import type {
	ArchitectureLiveResponse,
	ArchDriftDiff,
} from "../src/server/types/architecture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");

// 화면이 고르는 canonical 맵 id — screens/architecture.jsx 의 같은 상수와 짝.
const CANONICAL_DIAGRAM_ID = "v2-overview-entry";

// 링 조건을 급전하는 기본 daemon — 값은 DAEMON_NODE_BINDINGS 의 실제 키여야 함.
// 키가 아니면 node_ids 가 비어 픽스처 전제가 무너짐.
const BOUND_DAEMON = "autoagent";

// 시각 은닉 노드의 렌더 박스 상한(px) — 1px/clip 기법은 통과, 산문 블록은 초과.
const HIDDEN_BOX_MAX_PX = 2;

type LiveOverrides = Partial<ArchitectureLiveResponse>;

function getLiveFixture(overrides: LiveOverrides = {}): ArchitectureLiveResponse {
	const nodeIds = [...(DAEMON_NODE_BINDINGS[BOUND_DAEMON] ?? [])];
	assert.ok(
		nodeIds.length > 0,
		`fixture precondition: ${BOUND_DAEMON} must carry node bindings`,
	);
	return {
		computed_at: new Date().toISOString(),
		daemons: [
			{
				daemon_name: BOUND_DAEMON,
				status: "critical",
				last_run_at: null,
				staleness_minutes: 999,
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
		stale: false,
		diffs: [],
		governance: { absent: [], sourceMissing: false },
		...overrides,
	};
}

function getDriftDiff(key: string): ArchDriftDiff {
	return { key, claimed: 1, actual: 2 };
}

// 공백 정규화 — 연속 공백·개행을 단일 공백으로 접고 양끝 trim (길이 비교 전제).
function getNormalized(s: string): string {
	return (s || "").replace(/\s+/g, " ").trim();
}

let app: FastifyInstance;
let serverUrl: string;
let browser: Browser;
let page: Page;
let expectedDescription: string;
let selectors: { canvas: string; tabControl: string; desc: string };

// 라이브 라우트가 요청 시점에 읽는 가변 픽스처 — openMap 이 케이스별로 갈아끼움.
let liveFixture: ArchitectureLiveResponse;

// 케이스별 live 픽스처를 심고 화면을 다시 세움. about:blank 경유는 같은 URL 재방문이
// same-document 로 흡수되어 재요청이 일어나지 않는 경우를 막기 위함.
async function openMap(live: ArchitectureLiveResponse): Promise<void> {
	liveFixture = live;
	await page.goto("about:blank");
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

	selectors = await page.evaluate(
		() =>
			(
				window as never as {
					ARCH_SELECTORS: { canvas: string; tabControl: string; desc: string };
				}
			).ARCH_SELECTORS,
	);
	assert.ok(
		selectors && selectors.canvas && selectors.tabControl && selectors.desc,
		"screen must expose window.ARCH_SELECTORS (canvas + tabControl + desc SoT)",
	);

	await page.waitForSelector(`${selectors.canvas} svg`, { timeout: 30_000 });
}

// aria-describedby 타깃을 SVG 에서 출발해 실제로 되짚어 읽음 — id 상수를 하네스가
// 다시 적으면 배선이 끊겨도 초록이 됨.
async function getDescProbe() {
	return await page.evaluate((canvas) => {
		const svgEl = document.querySelector(`${canvas} svg`);
		const id = svgEl?.getAttribute("aria-describedby") || "";
		const target = id ? document.getElementById(id) : null;
		if (!target) return { id, found: false, text: "", width: -1, height: -1, inProse: false };

		const rect = target.getBoundingClientRect();
		return {
			id,
			found: true,
			text: target.innerText,
			width: rect.width,
			height: rect.height,
			inProse: target.closest(".arch-prose") !== null,
		};
	}, selectors.canvas);
}

before(async () => {
	// 라우트 핸들러 안에서 만들면 전제 위반이 500 으로 바뀌어 테스트가 초록으로 통과함 — before 에서 한 번만 만듦.
	liveFixture = getLiveFixture();
	app = Fastify({ logger: false });
	await app.register(fastifyStatic, {
		root: PUBLIC_ROOT,
		prefix: "/",
		index: ["index.html"],
	});
	// 다이어그램 라우트 손수 등록 — 사설 handleDiagrams 를 흉내내는 것이 아니라
	// 그 핸들러가 쓰는 내보내진 진입점을 같이 씀.
	app.get("/api/architecture/diagrams", async (request: FastifyRequest) => {
		const { doc } = await getArchitecture(request.log);
		return doc.diagrams;
	});
	app.get("/api/architecture/live", async () => liveFixture);
	await app.ready();
	serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });

	// 라우트 왕복 대신 같은 생산자를 직접 부름 — 위 라우트가 쓰는 진입점과 동일.
	const { doc } = await getArchitecture(app.log);
	const canonical =
		doc.diagrams.diagrams.find((d) => d.id === CANONICAL_DIAGRAM_ID) ??
		doc.diagrams.diagrams[0];
	assert.ok(canonical, "diagrams payload must carry the canonical entry");
	expectedDescription = getNormalized(canonical.description || "");

	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
});

after(async () => {
	await browser?.close();
	await app?.close();
});

test("AC-T15 aria-describedby target holds the full description", async () => {
	await openMap(getLiveFixture());
	const probe = await getDescProbe();

	assert.ok(probe.id, "rendered svg must carry aria-describedby");
	assert.equal(probe.found, true, `aria-describedby target #${probe.id} must exist in the document`);
	assert.ok(expectedDescription.length > 0, "payload description must be non-empty");
	assert.equal(
		getNormalized(probe.text).length,
		expectedDescription.length,
		`target #${probe.id} exposes ${getNormalized(probe.text).length} chars vs payload ${expectedDescription.length}`,
	);
});

test("AC-T15 description node survives prose removal — it is not a prose child", async () => {
	await openMap(getLiveFixture());
	const probe = await getDescProbe();

	// 산문 섹션 안에 있으면 T17 의 섹션 제거가 aria-describedby 를 끊음.
	// T17 이 .arch-prose 를 지우고 나면 이 다리는 자명하게 참이 되어 변별력을 잃음 —
	// 그때부터 이전을 재는 것은 아래 은닉 다리임.
	assert.equal(probe.inProse, false, `target #${probe.id} must live outside .arch-prose`);
});

test("AC-T15 description node is visually hidden yet still rendered", async () => {
	await openMap(getLiveFixture());
	const probe = await getDescProbe();

	// 렌더 트리에서 빼면 innerText 가 계측을 잃음 — 화면 밖/1px/클립으로 은닉하되 렌더는 유지.
	assert.ok(
		probe.width >= 0 && probe.width <= HIDDEN_BOX_MAX_PX,
		`target #${probe.id} width ${probe.width}px must be visually hidden (<= ${HIDDEN_BOX_MAX_PX}px)`,
	);
	assert.ok(
		probe.height >= 0 && probe.height <= HIDDEN_BOX_MAX_PX,
		`target #${probe.id} height ${probe.height}px must be visually hidden (<= ${HIDDEN_BOX_MAX_PX}px)`,
	);
	assert.ok(
		getNormalized(probe.text).length > 0,
		`target #${probe.id} must stay rendered — innerText is empty, so the node left the render tree`,
	);
});

// 하네스 능력 증명 — 같은 파일 안에서 두 개의 서로 다른 live 픽스처를 심고 화면이
// 각각 다르게 반응함을 봄. 소재로 드리프트 배너를 고른 이유: AC-T18(c) 가 이 배너의
// 존속을 잠그므로 뒤 작업이 지우는 표면이 아님.
test("harness supports per-case live fixtures", async () => {
	const driftKey = "PROBE_DRIFT_KEY";

	await openMap(getLiveFixture({ stale: true, diffs: [getDriftDiff(driftKey)] }));
	const withDrift = await page.evaluate(
		(key) =>
			Array.from(document.querySelectorAll('[role="alert"]')).filter((el) =>
				(el.textContent || "").includes(key),
			).length,
		driftKey,
	);
	assert.equal(withDrift, 1, `drift fixture must render exactly one alert carrying ${driftKey}`);

	await openMap(getLiveFixture({ stale: false, diffs: [] }));
	const withoutDrift = await page.evaluate(
		(key) =>
			Array.from(document.querySelectorAll('[role="alert"]')).filter((el) =>
				(el.textContent || "").includes(key),
			).length,
		driftKey,
	);
	assert.equal(withoutDrift, 0, `clean fixture must render no alert carrying ${driftKey}`);
});

// 범례 표면 셀렉터 — 컴포넌트가 붙이던 클래스 전부. 하나라도 남으면 UI 가 살아 있음.
const LEGEND_SELECTORS = [
	".arch-legend-details",
	".arch-legend-grid",
	".arch-legend-item",
	".arch-legend-swatch-box",
	".arch-legend-swatch-line",
];

// 분류별 흐림이 노드에 남기던 클래스 — 캔버스의 legend-focus, 대상 노드의 legend-hit.
const NODE_DIM_SELECTOR = ".legend-focus, .legend-hit";

test("AC-T19 the map renders no legend surface", async () => {
	await openMap(getLiveFixture());

	const present = await page.evaluate(
		(selectors) =>
			selectors
				.map((sel) => [sel, document.querySelectorAll(sel).length] as const)
				.filter(([, count]) => count > 0),
		LEGEND_SELECTORS,
	);

	assert.deepEqual(
		present.map(([sel]) => sel),
		[],
		`legend surface still rendered: ${present.map(([s, c]) => `${s}×${c}`).join(", ")}`,
	);
});

test("AC-T19 no interaction attaches the node-dim classes", async () => {
	await openMap(getLiveFixture());

	// details 가 닫혀 있어도 자식은 DOM 에 있으므로 DOM click 은 도달함 — Playwright 의
	// 가시성 요구를 우회해야 "어떤 상호작용으로도" 를 실제로 잼.
	const clicked = await page.evaluate(() => {
		const root = document.querySelector(".arch-page");
		if (!root) return -1;
		const targets = Array.from(
			root.querySelectorAll<HTMLElement>("button, summary, [aria-pressed]"),
		);
		for (const el of targets) el.click();
		return targets.length;
	});
	assert.ok(clicked > 0, "map body must expose clickable controls — 0 clicks measures nothing");

	// 흐림은 React state → effect 경로라 클릭 직후 프레임에는 아직 없음.
	await page.waitForTimeout(500);
	const dimmed = await page.evaluate(
		(sel) => document.querySelectorAll(sel).length,
		NODE_DIM_SELECTOR,
	);
	assert.equal(dimmed, 0, `${clicked} clicks left ${dimmed} element(s) carrying ${NODE_DIM_SELECTOR}`);
});
