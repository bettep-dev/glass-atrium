// E2E chromium STRUCTURE harness for the system map (screens/architecture.jsx).
// Runner: npx tsx --test test/architecture.render-structure.e2e.test.ts
//
// Asserts DOM-structure facts only — the aria-describedby target's exposed
// description length, rendered SVG count + tab-control absence, live ring-tone
// absence. No size/scale/width assertion lives here: the rendered-pixel
// legibility proxy was retired.
//
// App: stripped Fastify (fastify-static + two hand-registered routes) on an
// ephemeral port. registerArchitectureRoutes is NOT called — it stands up the real
// /live handler (Prisma + home-directory drift read), which would redden this
// harness on daemon/settings state and would collide with the fixture route.
// Browser: Playwright chromium headless, NO mocking.
//
// Page-level network prerequisite: the page pulls React + mermaid from CDN, so the
// run REQUIRES outbound network and an installed chromium. An unmet prerequisite
// fails RED (asserted in before) — no skip guard absorbs it.

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
import type { ArchitectureLiveResponse } from "../src/server/types/architecture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");

// 화면이 고르는 canonical 맵 id — screens/architecture.jsx 의 같은 상수와 짝.
const CANONICAL_DIAGRAM_ID = "v2-overview-entry";

// 링이 켜졌던 tone 클래스 — 표현이 제거됐으므로 화면에 공유 상수가 없음.
// 이 목록은 "되살아나면 붉어진다" 는 회귀 자물쇠이며 하네스가 소유함.
// 한계: 목록은 SoT 결합이 없는 하네스 리터럴이라 이름이 바뀐 링은 잡지 못함.
// 그래서 아래 AC-15(b) 는 접두사 패턴 다리를 함께 검사함 — 그 다리도 `arch-node-live-`
// 접두사 유지에 의존하므로, 접두사까지 바꾼 복원은 두 다리 모두 통과함(잔여 한계).
const LIVE_TONE_CLASSES = [
	"arch-node-live-ok",
	"arch-node-live-warn",
	"arch-node-live-crit",
];

// 링 조건을 급전하는 고정 픽스처 — 바인딩된 daemon 이 critical.
// 링 부재가 데이터 부재의 부작용이 아니라 표현 제거의 결과임을 성립시킴.
// 값은 DAEMON_NODE_BINDINGS 의 실제 키여야 함 — 키가 아니면 node_ids 가 비어 전제가 무너짐.
const BOUND_DAEMON = "autoagent";

function getLiveFixture(): ArchitectureLiveResponse {
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
	};
}

// 공백 정규화 — 연속 공백·개행을 단일 공백으로 접고 양끝 trim (AC-11 비교 전제).
function getNormalized(s: string): string {
	return (s || "").replace(/\s+/g, " ").trim();
}

let app: FastifyInstance;
let serverUrl: string;
let browser: Browser;
let page: Page;
let expectedDescription: string;
let selectors: { canvas: string; tabControl: string; desc: string };
let liveFixture: ArchitectureLiveResponse;

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
	await page.goto(`${serverUrl}/#architecture`, { waitUntil: "load" });

	// 페이지 수준 네트워크 전제 — CDN 런타임이 실제로 로드돼야 세 단언이 성립함.
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

	// 렌더 완료 대기 — canvas 안에 svg 가 붙을 때까지.
	await page.waitForSelector(`${selectors.canvas} svg`, { timeout: 30_000 });
});

after(async () => {
	await browser?.close();
	await app?.close();
});

// 셀렉터 상수가 아니라 렌더된 svg 의 aria-describedby 를 기점으로 잼 — 상수만 읽으면
// 접근성 배선이 끊겨도 초록임(속성을 지우고 재어 확인).

test("AC-11 full description lives on the rendered aria-describedby target", async () => {
	const probe = await page.evaluate((sel) => {
		const svg = document.querySelector(`${sel.canvas} svg`);
		const describedby = svg ? svg.getAttribute("aria-describedby") : null;
		const target = describedby ? document.getElementById(describedby) : null;
		return {
			describedby,
			idCount: describedby ? document.querySelectorAll(`#${describedby}`).length : 0,
			tagName: target ? target.tagName.toLowerCase() : "",
			// 렌더 박스 수 — innerText 는 렌더 트리를 벗어난 노드에서 textContent 로 조용히 후퇴함.
			boxCount: target ? target.getClientRects().length : 0,
			exposed: target ? target.innerText : "",
		};
	}, selectors);

	assert.ok(expectedDescription.length > 0, "payload description must be non-empty");
	assert.equal(
		`#${probe.describedby}`,
		selectors.desc,
		`rendered svg aria-describedby="${probe.describedby}" must name the desc SoT ${selectors.desc}`,
	);
	assert.equal(probe.idCount, 1, `nodes carrying id ${probe.describedby}`);
	assert.ok(
		probe.boxCount > 0,
		`aria-describedby target <${probe.tagName}> has no layout box — innerText falls back to textContent and stops measuring exposed text`,
	);

	const normalized = getNormalized(probe.exposed);
	assert.equal(
		normalized.length,
		expectedDescription.length,
		`exposed ${normalized.length} chars from <${probe.tagName}> vs payload ${expectedDescription.length} — exposed="${normalized}"`,
	);
});

test("AC-18 exactly one rendered diagram SVG", async () => {
	// 계수 단위 = 캔버스 하위 svg 중 컨트롤 아이콘을 뺀 것 — 캔버스는 줌 버튼의
	// 15x15 아이콘 svg 도 품으므로 [measured: button.arch-zoom-btn > svg] 하위 svg
	// 전수는 정상 트리에서 2 임. 두 번째 맵은 버튼 밖에 그려지므로 이 제외가
	// "맵은 한 장" 이라는 사실을 약화시키지 않음.
	const svgCount = await page.evaluate((sel) => {
		const canvas = document.querySelector(sel.canvas);
		if (!canvas) return -1;
		return Array.from(canvas.querySelectorAll("svg")).filter(
			(s) => s.closest("button") === null,
		).length;
	}, selectors);
	assert.equal(svgCount, 1, `rendered diagram svg count inside ${selectors.canvas}`);
});

test("AC-18 no tab controls in the DOM", async () => {
	const tabCount = await page.evaluate(
		(sel) => document.querySelectorAll(sel.tabControl).length,
		selectors,
	);
	assert.equal(tabCount, 0, `tab control count for ${selectors.tabControl}`);
});

test("AC-15(b) rendered SVG carries no live ring tone class", async () => {
	const toneCount = await page.evaluate(
		(args) =>
			args.tones.reduce(
				(sum, cls) => sum + document.querySelectorAll(`${args.canvas} svg .${cls}`).length,
				0,
			),
		{ canvas: selectors.canvas, tones: LIVE_TONE_CLASSES },
	);
	assert.equal(toneCount, 0, `live tone classes present: ${LIVE_TONE_CLASSES.join(", ")}`);

	// 이름이 바뀐 링까지 잡는 두 번째 다리 — 리터럴 목록이 아니라 접두사 패턴.
	// SVG 요소의 className 은 SVGAnimatedString 이므로 class 속성을 직접 읽음.
	const patternCount = await page.evaluate((canvas) => {
		const els = Array.from(document.querySelectorAll(`${canvas} svg *`));
		return els.filter((el) => /arch-node-live-/.test(el.getAttribute("class") || ""))
			.length;
	}, selectors.canvas);
	assert.equal(patternCount, 0, "arch-node-live-* class pattern present on a rendered node");
});
