// E2E chromium STRUCTURE harness for the system map (screens/architecture.jsx).
// Runner: npx tsx --test test/architecture.render-structure.e2e.test.ts
//
// Asserts DOM-structure facts only — the aria-describedby target's exposed
// description length, rendered SVG count + tab-control absence, and the live fault
// ring's two-sided behaviour. No size/scale/width assertion lives here: the
// rendered-pixel legibility proxy was retired.
//
// TWO render contexts, one per live fixture (healthy · fault). The ring is a function
// of the server verdict, so a single shared context can only ever measure one side of
// it. Each context owns its app, browser and page, so neither can contaminate the
// other and either runs alone.
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

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { getArchitecture } from "../src/server/architecture/parser.js";
import {
	DAEMON_NODE_BINDINGS,
	PART_NODE_BINDINGS,
} from "../src/server/architecture/diagrams-source.js";
import type { ArchitectureLiveResponse } from "../src/server/types/architecture.js";
import { buildScreenSandbox } from "./client-sandbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const UI_SRC = fileURLToPath(new URL("../public/src/ui.jsx", import.meta.url));

// 화면이 고르는 canonical 맵 id — screens/architecture.jsx 의 같은 상수와 짝.
const CANONICAL_DIAGRAM_ID = "v2-overview-entry";

// 링이 켜지는 tone 클래스 — 화면이 공유 상수로 내보내지 않으므로 하네스가 목록을 소유함.
// 한계: SoT 결합이 없는 하네스 리터럴이라 이름이 바뀐 링은 잡지 못함. 그래서 아래 두
// 단언은 접두사 패턴 다리를 함께 검사함 — 그 다리도 `arch-node-live-` 접두사 유지에
// 의존하므로, 접두사까지 바꾼 복원은 두 다리 모두 통과함(잔여 한계).
const LIVE_TONE_CLASS = {
	ok: "arch-node-live-ok",
	warn: "arch-node-live-warn",
	crit: "arch-node-live-crit",
};
const LIVE_TONE_CLASSES = Object.values(LIVE_TONE_CLASS);

// 값은 DAEMON_NODE_BINDINGS 의 실제 키여야 함 — 키가 아니면 node_ids 가 비어 전제가 무너짐.
const BOUND_DAEMON = "autoagent";

// 픽스처가 싣는 판정값 — 두 값 모두 ui.jsx 의 DAEMON_STATUS_TONE 실제 키여야 함.
// 그 전제는 각 컨텍스트의 before 에서 화면과 같은 테이블을 불러 직접 잼(getDaemonStatusTone).
// 키가 아닌 값은 tone 이 info 로 떨어져 링이 꺼지고, fault 픽스처가 조용히 no-data 픽스처가 됨.
const HEALTHY_VERDICT = "ok";
const FAULT_VERDICT = "stale";

function getLiveFixture(
	verdict: string,
	stalenessMinutes: number,
): ArchitectureLiveResponse {
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
				// status 는 effective_status 의 과도기 사본이고 판정의 기준 필드는
				// effective_status 임(types/architecture.ts) — 화면의 링도 그 필드만 읽음.
				status: verdict,
				effective_status: verdict,
				last_run_at: null,
				staleness_minutes: stalenessMinutes,
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
		// 서버 표 그대로 각인함 — `{}` 로 두면 AC-B2-3c 가 공허해짐. 그 AC 는 `pg_db` 와
		// `hook_pipeline` 이 비어 있지 않게 각인된 것을 먼저 단언한 뒤 그 두 노드에 링이
		// 없음을 재는데, 각인이 없으면 "바인딩이 없어서 링이 없다"와 구별되지 않음.
		// 이 하네스는 health 라우트를 스텁하지 않으므로 각인은 있고 판정만 비는 상태가 됨.
		part_bindings: PART_NODE_BINDINGS,
	};
}

// 공백 정규화 — 연속 공백·개행을 단일 공백으로 접고 양끝 trim (AC-11 비교 전제).
function getNormalized(s: string): string {
	return (s || "").replace(/\s+/g, " ").trim();
}

// architecture.jsx 의 unscopedNodeIdAR 사본 — 스키마 node id(`${diagramId}.${mermaidId}`)를 mermaid id 로 되돌림.
// 화면이 내보내지 않는 함수라 하네스가 규칙을 복제함(결합 없음).
function getUnscopedNodeId(nodeId: string): string {
	const idx = nodeId.lastIndexOf(".");
	return idx >= 0 ? nodeId.slice(idx + 1) : nodeId;
}

interface ArchSelectors {
	canvas: string;
	tabControl: string;
	desc: string;
}

interface RenderContext {
	app: FastifyInstance;
	browser: Browser;
	page: Page;
	selectors: ArchSelectors;
	expectedDescription: string;
}

// 픽스처 하나 = 렌더 컨텍스트 하나.
// 서버·브라우저·페이지를 모두 새로 세우므로 두 컨텍스트는 서로의 DOM 도 폴링 상태도 보지 못함.
async function openRenderContext(
	liveFixture: ArchitectureLiveResponse,
): Promise<RenderContext> {
	const app = Fastify({ logger: false });
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
	const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });

	// 라우트 왕복 대신 같은 생산자를 직접 부름 — 위 라우트가 쓰는 진입점과 동일.
	const { doc } = await getArchitecture(app.log);
	const canonical =
		doc.diagrams.diagrams.find((d) => d.id === CANONICAL_DIAGRAM_ID) ??
		doc.diagrams.diagrams[0];
	assert.ok(canonical, "diagrams payload must carry the canonical entry");
	const expectedDescription = getNormalized(canonical.description || "");

	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(`${serverUrl}/#architecture`, { waitUntil: "load" });

	// 페이지 수준 네트워크 전제 — CDN 런타임이 실제로 로드돼야 아래 단언들이 성립함.
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

	const selectors = await page.evaluate(
		() => (window as never as { ARCH_SELECTORS: ArchSelectors }).ARCH_SELECTORS,
	);
	assert.ok(
		selectors && selectors.canvas && selectors.tabControl && selectors.desc,
		"screen must expose window.ARCH_SELECTORS (canvas + tabControl + desc SoT)",
	);

	// 렌더 완료 대기 — canvas 안에 svg 가 붙을 때까지.
	await page.waitForSelector(`${selectors.canvas} svg`, { timeout: 30_000 });
	// 링 효과의 선행 효과(라벨→node id 각인)까지 대기. 링 효과는 같은 commit 에서
	// 그 뒤에 도므로, 각인이 보이면 링 판정도 끝난 뒤임 — 링 유무를 미리 전제하지 않고
	// 타이밍만 고정함. 동시에 "링 0개" 가 각인 0개의 부작용이 아님을 여기서 성립시킴.
	await page.waitForSelector(`${selectors.canvas} svg g.node[data-arch-node-id]`, {
		timeout: 30_000,
	});

	return { app, browser, page, selectors, expectedDescription };
}

async function closeRenderContext(ctx: RenderContext | undefined): Promise<void> {
	await ctx?.browser?.close();
	await ctx?.app?.close();
}

// 리터럴 tone 클래스 한 종의 캔버스 내 개수.
function countLiveToneClass(
	page: Page,
	canvas: string,
	cls: string,
): Promise<number> {
	return page.evaluate(
		(args) => document.querySelectorAll(`${args.canvas} svg .${args.cls}`).length,
		{ canvas, cls },
	);
}

// 리터럴 tone 클래스 3종의 캔버스 내 개수 합.
async function countLiveToneClasses(page: Page, canvas: string): Promise<number> {
	const counts = await Promise.all(
		LIVE_TONE_CLASSES.map((cls) => countLiveToneClass(page, canvas, cls)),
	);
	return counts.reduce((sum, n) => sum + n, 0);
}

// 이름이 바뀐 링까지 잡는 두 번째 다리 — 리터럴 목록이 아니라 접두사 패턴.
// SVG 요소의 className 은 SVGAnimatedString 이므로 class 속성을 직접 읽음.
function countLiveClassPattern(page: Page, canvas: string): Promise<number> {
	return page.evaluate((sel) => {
		const els = Array.from(document.querySelectorAll(`${sel} svg *`));
		return els.filter((el) => /arch-node-live-/.test(el.getAttribute("class") || ""))
			.length;
	}, canvas);
}

// 캔버스가 실제로 각인한 node id 전수 (스키마 id 그대로).
function getStampedNodeIds(page: Page, canvas: string): Promise<string[]> {
	return page.evaluate(
		(sel) =>
			Array.from(
				document.querySelectorAll(`${sel} svg g.node[data-arch-node-id]`),
			).map((el) => el.getAttribute("data-arch-node-id") || ""),
		canvas,
	);
}

// 링이 실제로 켜진 노드의 node id 전수 — 개수만이 아니라 "어느 노드인가" 를 잼.
function getLitNodeIds(page: Page, canvas: string): Promise<string[]> {
	return page.evaluate((sel) => {
		const els = Array.from(document.querySelectorAll(`${sel} svg *`));
		return els
			.filter((el) => /arch-node-live-/.test(el.getAttribute("class") || ""))
			.map((el) => el.getAttribute("data-arch-node-id") || "");
	}, canvas);
}

// 바인딩 id 중 이 캔버스가 실제로 그린 것들 — 링이 켜져야 하는 정확한 집합.
// 캔버스가 그리는 것은 canonical 맵 한 장뿐이므로 바인딩 id 4개가 모두 나오지는 않음.
// 리터럴 상수로 박지 않고 매 실행 교집합으로 구함 — 바인딩 SoT 가 바뀌면 기대값이 같이 움직임.
async function getRenderedBoundNodeIds(
	page: Page,
	canvas: string,
): Promise<string[]> {
	const bound = new Set(DAEMON_NODE_BINDINGS[BOUND_DAEMON] ?? []);
	const stamped = await getStampedNodeIds(page, canvas);
	const rendered = new Set(
		stamped.map(getUnscopedNodeId).filter((id) => bound.has(id)),
	);
	return [...rendered].sort();
}

// 화면과 같은 tone 테이블을 vm 샌드박스로 불러 판정값→tone 을 직접 잼.
// 픽스처가 실은 판정값이 테이블의 실제 키인지 확인하는 유일한 결합점임.
async function getDaemonStatusTone(verdict: string): Promise<string> {
	const ui = await buildScreenSandbox<{
		window: { UI: { daemonStatusTone: (status: string) => string } };
	}>(UI_SRC);
	return ui.window.UI.daemonStatusTone(verdict);
}

describe("healthy live fixture", () => {
	let ctx: RenderContext;

	before(async () => {
		// 라우트 핸들러 안에서 만들면 전제 위반이 500 으로 바뀌어 테스트가 초록으로 통과함 — before 에서 한 번만 만듦.
		const tone = await getDaemonStatusTone(HEALTHY_VERDICT);
		assert.equal(
			tone,
			"ok",
			`fixture precondition: '${HEALTHY_VERDICT}' must read as the healthy tone in the shared status table`,
		);
		ctx = await openRenderContext(getLiveFixture(HEALTHY_VERDICT, 1));
	});

	after(async () => {
		await closeRenderContext(ctx);
	});

	// 셀렉터 상수가 아니라 렌더된 svg 의 aria-describedby 를 기점으로 잼 — 상수만 읽으면
	// 접근성 배선이 끊겨도 초록임(속성을 지우고 재어 확인).

	test("AC-11 full description lives on the rendered aria-describedby target", async () => {
		const probe = await ctx.page.evaluate((sel) => {
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
		}, ctx.selectors);

		assert.ok(ctx.expectedDescription.length > 0, "payload description must be non-empty");
		assert.equal(
			`#${probe.describedby}`,
			ctx.selectors.desc,
			`rendered svg aria-describedby="${probe.describedby}" must name the desc SoT ${ctx.selectors.desc}`,
		);
		assert.equal(probe.idCount, 1, `nodes carrying id ${probe.describedby}`);
		assert.ok(
			probe.boxCount > 0,
			`aria-describedby target <${probe.tagName}> has no layout box — innerText falls back to textContent and stops measuring exposed text`,
		);

		const normalized = getNormalized(probe.exposed);
		assert.equal(
			normalized.length,
			ctx.expectedDescription.length,
			`exposed ${normalized.length} chars from <${probe.tagName}> vs payload ${ctx.expectedDescription.length} — exposed="${normalized}"`,
		);
	});

	test("AC-18 exactly one rendered diagram SVG", async () => {
		// 계수 단위 = 캔버스 하위 svg 중 컨트롤 아이콘을 뺀 것 — 캔버스는 줌 버튼의
		// 15x15 아이콘 svg 도 품으므로 [measured: button.arch-zoom-btn > svg] 하위 svg
		// 전수는 정상 트리에서 2 임. 두 번째 맵은 버튼 밖에 그려지므로 이 제외가
		// "맵은 한 장" 이라는 사실을 약화시키지 않음.
		const svgCount = await ctx.page.evaluate((sel) => {
			const canvas = document.querySelector(sel.canvas);
			if (!canvas) return -1;
			return Array.from(canvas.querySelectorAll("svg")).filter(
				(s) => s.closest("button") === null,
			).length;
		}, ctx.selectors);
		assert.equal(svgCount, 1, `rendered diagram svg count inside ${ctx.selectors.canvas}`);
	});

	test("AC-18 no tab controls in the DOM", async () => {
		const tabCount = await ctx.page.evaluate(
			(sel) => document.querySelectorAll(sel.tabControl).length,
			ctx.selectors,
		);
		assert.equal(tabCount, 0, `tab control count for ${ctx.selectors.tabControl}`);
	});

	test("AC-15(b) rendered SVG carries no live ring tone class", async () => {
		const toneCount = await countLiveToneClasses(ctx.page, ctx.selectors.canvas);
		assert.equal(toneCount, 0, `live tone classes present: ${LIVE_TONE_CLASSES.join(", ")}`);

		const patternCount = await countLiveClassPattern(ctx.page, ctx.selectors.canvas);
		assert.equal(patternCount, 0, "arch-node-live-* class pattern present on a rendered node");
	});
});

describe("fault live fixture", () => {
	let ctx: RenderContext;

	before(async () => {
		const tone = await getDaemonStatusTone(FAULT_VERDICT);
		assert.equal(
			tone,
			"crit",
			`fixture precondition: '${FAULT_VERDICT}' must read as a fault tone in the shared status table`,
		);
		ctx = await openRenderContext(getLiveFixture(FAULT_VERDICT, 999));
	});

	after(async () => {
		await closeRenderContext(ctx);
	});

	/**
	 * AC-T6 — 링의 양면.
	 * 정상 픽스처에서 두 다리가 0 이고, 결함 픽스처에서는 같은 두 다리가 켜져야 할 노드 수만큼임을 잼.
	 *
	 * 왜 결함 쪽을 재는가: 서버 판정을 맵과 상태판이 하나로 통일했는지 눈으로 확인할 표면은
	 * 캔버스 링 하나뿐임. 링이 아예 없으면 그 통일은 화면에서 검증 불가능한 주장으로 남음.
	 *
	 * 왜 픽스처가 effective_status 를 실어야 하는가: 판정의 기준 필드가 그것이기 때문임
	 * (types/architecture.ts — status 는 과도기 사본). 키가 아닌 값은 tone 이 info 로 떨어지므로
	 * before 가 판정값이 tone 테이블의 실제 키인지부터 재고, 기대 개수는 리터럴이 아니라
	 * 바인딩 SoT ∩ 실제 각인 id 로 매번 구함 — 바인딩이 끊기거나 링이 사라지면 붉어짐.
	 *
	 * 켜지는 클래스는 crit 한 종뿐이어야 함 — 3종 합계만 재면 crit↔warn 뒤바뀜이 합계 안에서
	 * 상쇄되어 초록으로 지나가므로, 클래스별로 나눠 잼.
	 */
	test("AC-T6 fault verdict lights the ring on exactly the bound rendered nodes", async () => {
		const expectedIds = await getRenderedBoundNodeIds(ctx.page, ctx.selectors.canvas);
		assert.ok(
			expectedIds.length > 0,
			`fixture precondition: none of ${BOUND_DAEMON}'s bound ids (${(DAEMON_NODE_BINDINGS[BOUND_DAEMON] ?? []).join(", ")}) is rendered in ${CANONICAL_DIAGRAM_ID} — the assertion below would be vacuous`,
		);

		const critCount = await countLiveToneClass(
			ctx.page,
			ctx.selectors.canvas,
			LIVE_TONE_CLASS.crit,
		);
		assert.equal(
			critCount,
			expectedIds.length,
			`${LIVE_TONE_CLASS.crit} count vs bound rendered nodes ${expectedIds.join(", ")}`,
		);

		const okCount = await countLiveToneClass(
			ctx.page,
			ctx.selectors.canvas,
			LIVE_TONE_CLASS.ok,
		);
		assert.equal(okCount, 0, `${LIVE_TONE_CLASS.ok} present under a crit verdict`);

		const warnCount = await countLiveToneClass(
			ctx.page,
			ctx.selectors.canvas,
			LIVE_TONE_CLASS.warn,
		);
		assert.equal(warnCount, 0, `${LIVE_TONE_CLASS.warn} present under a crit verdict`);

		const patternCount = await countLiveClassPattern(ctx.page, ctx.selectors.canvas);
		assert.equal(
			patternCount,
			expectedIds.length,
			`arch-node-live-* pattern count vs bound rendered nodes ${expectedIds.join(", ")}`,
		);

		// 개수만 맞고 엉뚱한 노드가 켜진 경우를 가르는 다리.
		const litIds = await getLitNodeIds(ctx.page, ctx.selectors.canvas);
		assert.deepStrictEqual(
			[...new Set(litIds.map(getUnscopedNodeId))].sort(),
			expectedIds,
			"the lit nodes must be the daemon's bound nodes, not merely as many as them",
		);
	});
});
