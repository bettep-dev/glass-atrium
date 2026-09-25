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
// /live handler (Prisma + home-directory reads), which would redden this
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
	CANONICAL_MAP,
	DAEMON_NODE_BINDINGS,
	DIAGRAMS,
	PART_NODE_BINDINGS,
} from "../src/server/architecture/diagrams-source.js";
import type { ArchitectureLiveResponse } from "../src/server/types/architecture.js";
import type { HealthDaemonsResponse } from "../src/server/types/health-detail.js";
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
		governance: { absent: [], sourceMissing: false },
		// 서버 표 그대로 각인함 — `{}` 로 두면 AC-B2-3c 가 공허해짐. 그 AC 는 `pg_db` 와
		// `hook_pipeline` 이 비어 있지 않게 각인된 것을 먼저 단언한 뒤 그 두 노드에 링이
		// 없음을 재는데, 각인이 없으면 "바인딩이 없어서 링이 없다"와 구별되지 않음.
		// 하네스는 데몬 health 만 세우므로 pg·hook 부품은 각인은 있고 판정만 비는 상태가 됨.
		part_bindings: PART_NODE_BINDINGS,
	};
}

// /api/health/daemons 픽스처 — 데몬 부품의 판정이 도착해야 그 노드가 unverified 를 벗고 판정 링을 닮.
function getDaemonHealthFixture(verdict: string): HealthDaemonsResponse {
	return {
		daemons: [
			{
				daemon_name: BOUND_DAEMON,
				last_run_at: null,
				last_status: null,
				effective_status: verdict,
				expected_next_at: null,
				cost_guard_state: null,
				staleness_minutes: null,
				needs_auth: false,
				needs_auth_remediation: null,
			},
		],
		computed_at: new Date().toISOString(),
		timezone: "UTC",
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
	daemonHealth?: HealthDaemonsResponse,
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
	if (daemonHealth) app.get("/api/health/daemons", async () => daemonHealth);
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

/**
 * Reloads with the diagrams read held open (or answered with `failure`), runs `body`, then restores the rendered map.
 * The real route still answers once released, so the context is back to its fixture state for the next test.
 */
async function withDiagramsHeld(
	ctx: RenderContext,
	body: () => Promise<void>,
	failure?: { status: number; body: string },
): Promise<void> {
	const pattern = "**/api/architecture/diagrams";
	let release: () => void = () => {};
	const gate = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	await ctx.page.route(pattern, async (route) => {
		if (failure) return route.fulfill({ status: failure.status, contentType: "application/json", body: failure.body });
		await gate;
		return route.continue();
	});
	try {
		await ctx.page.reload({ waitUntil: "load" });
		await body();
	} finally {
		// held read: let it land on this page before unrouting · failed read: reload onto the real route
		release();
		if (failure) {
			await ctx.page.unroute(pattern);
			await ctx.page.reload({ waitUntil: "load" });
		}
		await ctx.page.waitForSelector(`${ctx.selectors.canvas} svg g.node[data-arch-node-id]`, { timeout: 30_000 });
		if (!failure) await ctx.page.unroute(pattern);
	}
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

// 바인딩 id 중 이 캔버스가 실제로 그린 것들 — 링이 켜져야 하는(또는 켜지지 않아야 하는) 정확한 집합.
// 캔버스가 그리는 것은 canonical 맵 한 장뿐이므로 바인딩 id 전부가 나오지는 않음.
// 리터럴 상수로 박지 않고 매 실행 교집합으로 구함 — 바인딩 SoT 가 바뀌면 기대값이 같이 움직임.
async function getRenderedBoundIds(
	page: Page,
	canvas: string,
	boundIds: readonly string[],
): Promise<string[]> {
	const bound = new Set(boundIds);
	const stamped = await getStampedNodeIds(page, canvas);
	const rendered = new Set(
		stamped.map(getUnscopedNodeId).filter((id) => bound.has(id)),
	);
	return [...rendered].sort();
}

function getRenderedBoundNodeIds(page: Page, canvas: string): Promise<string[]> {
	return getRenderedBoundIds(page, canvas, DAEMON_NODE_BINDINGS[BOUND_DAEMON] ?? []);
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
		ctx = await openRenderContext(
			getLiveFixture(HEALTHY_VERDICT, 1),
			getDaemonHealthFixture(HEALTHY_VERDICT),
		);
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

	test("the first read of the map shows a named loading status and no description", async () => {
		await withDiagramsHeld(ctx, async () => {
			const status = ctx.page.getByRole("status").filter({ hasText: "Loading the system map" });
			await status.waitFor({ timeout: 10_000 });

			const probe = await ctx.page.evaluate((desc) => ({
				descCount: document.querySelectorAll(desc).length,
				text: document.body.innerText,
			}), ctx.selectors.desc);
			assert.equal(probe.descCount, 0, "the description target waits for the diagram");
			assert.ok(!probe.text.includes("No description available"), "no placeholder description while loading");
		});
	});

	test("one outage behind every failed read raises one banner with one Retry and no raw status text", async () => {
		// the harness leaves three health stores unrouted (404) — a 404 diagrams read joins that same outage
		await withDiagramsHeld(ctx, async () => {
			await ctx.page.getByRole("alert").first().waitFor({ timeout: 10_000 });
			const probe = await ctx.page.evaluate(() => ({
				retries: [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Retry").length,
				alerts: document.querySelectorAll('[role="alert"]').length,
				text: document.body.innerText,
			}));
			assert.equal(probe.retries, 1, "one Retry per outage");
			assert.equal(probe.alerts, 1, "one announced banner per outage");
			assert.ok(!/HTTP \d{3}/.test(probe.text), `raw status stays behind Details — read: ${probe.text.slice(0, 300)}`);
		}, { status: 404, body: '{"message":"Route not found"}' });
	});

	test("Refresh keeps the rendered map on screen until the new answer lands", async () => {
		const { page, selectors } = ctx;
		await page.evaluate((canvas) => {
			const w = window as never as { archSvgGap: boolean; archSvgObserver: MutationObserver };
			w.archSvgGap = false;
			w.archSvgObserver = new MutationObserver(() => {
				if (!document.querySelector(`${canvas} svg`)) w.archSvgGap = true;
			});
			w.archSvgObserver.observe(document.body, { childList: true, subtree: true });
		}, selectors.canvas);

		const landed = page.waitForResponse((r) => r.url().includes("/api/architecture/diagrams"), { timeout: 30_000 });
		await page.click('[aria-label="Refresh system map"]');
		await landed;
		await page.waitForFunction(
			() => document.querySelector('[aria-label="Refresh system map"]')?.getAttribute("aria-busy") !== "true",
			null,
			{ timeout: 30_000 },
		);

		const gap = await page.evaluate(() => {
			const w = window as never as { archSvgGap: boolean; archSvgObserver: MutationObserver };
			w.archSvgObserver.disconnect();
			return w.archSvgGap;
		});
		assert.equal(gap, false, "the map svg must never leave the canvas during a refresh");
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

	test("the caption is a sentence-case status line over a legend, all at 12px or larger", async () => {
		await ctx.page.waitForSelector(".arch-legend li", { timeout: 10_000 });
		// one inline mapper — tsx wraps a named inner function in __name, which the browser lacks
		const [status, ...legend] = await ctx.page.evaluate(() =>
			[...document.querySelectorAll(".arch-caption p, .arch-legend li")].map((el) => ({
				text: (el as HTMLElement).innerText,
				transform: getComputedStyle(el).textTransform,
				px: Number.parseFloat(getComputedStyle(el).fontSize),
			})),
		);
		const probe = { status, legend };

		assert.ok(probe.status, "a status line renders under the page title");
		for (const line of [probe.status, ...probe.legend]) {
			assert.notEqual(line.transform, "uppercase", `"${line.text}" renders uppercase`);
			assert.ok(line.px >= 12, `"${line.text}" renders at ${line.px}px`);
		}
		for (const word of ["needs attention", "critical", "not verified", "Orchestrator border", "Safety checks border"])
			assert.ok(probe.legend.some((line) => line.text.includes(word)), `legend lacks "${word}" — read: ${JSON.stringify(probe.legend)}`);
	});

	test("the Fit control shows its name and only a title repeating its one box is hidden", async () => {
		const fit = ctx.page.getByRole("button", { name: "Fit diagram to view" });
		assert.match(await fit.innerText(), /\bFit\b/);

		const titles = await ctx.page.evaluate((canvas) =>
			[...document.querySelectorAll(`${canvas} svg g.cluster`)].map((el) => {
				const label = el.querySelector(":scope > .cluster-label");
				return { id: el.id, shown: label ? label.getBoundingClientRect().width > 0 : false };
			}),
		ctx.selectors.canvas);
		const hidden = titles.filter((t) => !t.shown).map((t) => t.id.replace(/^.*-/, ""));
		// no drawn zone has a lone member whose label opens with the zone title, so every title shows
		assert.deepEqual(hidden.sort(), [], `hidden group titles — read: ${JSON.stringify(titles)}`);
	});

	test("the node drawer is named by the node, reads its kind from its layer and hides an unrecorded path", async () => {
		const { doc } = await getArchitecture(ctx.app.log);
		const diagram = doc.diagrams.diagrams.find((d) => d.id === CANONICAL_DIAGRAM_ID) ?? doc.diagrams.diagrams[0];
		const rendered = new Set(await getStampedNodeIds(ctx.page, ctx.selectors.canvas));
		const target = diagram.layers
			.flatMap((layer) => (layer.nodes ?? []).map((node) => ({ node, layer })))
			.find(({ node }) => !node.path && rendered.has(node.id) && diagram.flows.some((f) => f.from === node.id || f.to === node.id));
		assert.ok(target, "fixture precondition: a rendered node with connections and no recorded path");

		await ctx.page.locator(`${ctx.selectors.canvas} svg g.node[data-arch-node-id="${target.node.id}"]`).click();
		const dialog = ctx.page.getByRole("dialog");
		await dialog.waitFor({ timeout: 10_000 });
		try {
			const probe = await dialog.evaluate((el) => ({
				text: (el as HTMLElement).innerText,
				sub: el.querySelector(".detail-sub")?.textContent ?? "",
				brokenWords: [...el.querySelectorAll(".break-all")].length,
			}));
			assert.equal(await dialog.getAttribute("aria-labelledby").then((id) => ctx.page.locator(`#${id}`).innerText()), target.node.label);
			// the drawn zone title is one word → the drawer carries the canonical source's full zone wording
			const zoneId = target.layer.id.slice(target.layer.id.lastIndexOf(".") + 1);
			const sourceZoneTitle = (DIAGRAMS.find((d) => d.slug === CANONICAL_MAP.slug)?.mermaid_source ?? "").match(
				new RegExp(`subgraph\\s+${zoneId}\\["([^"]*)"\\]`),
			)?.[1];
			assert.ok(sourceZoneTitle, `fixture precondition: source zone title for ${zoneId}`);
			assert.equal(probe.sub, sourceZoneTitle);
			assert.ok(!/Not recorded|File path/i.test(probe.text), `an unrecorded path renders as a field — read: ${probe.text.slice(0, 300)}`);
			assert.ok(!/\[[a-z]+_[a-z_]+\]/.test(probe.text), `a raw bracketed edge type renders — read: ${probe.text.slice(0, 300)}`);
			assert.equal(probe.brokenWords, 0, "drawer text breaks words mid-word");
		} finally {
			await ctx.page.keyboard.press("Escape");
			await dialog.waitFor({ state: "detached", timeout: 10_000 });
		}
	});

	test("Tab moves through the map nodes in left-to-right flow order", async () => {
		// document order of tabindex=0 stops IS the Tab sequence; one inline mapper (tsx __name)
		const stops = await ctx.page.evaluate((canvas) =>
			[...document.querySelectorAll(`${canvas} svg g.node[tabindex="0"]`)].map((el) => {
				const r = el.getBoundingClientRect();
				return { id: el.getAttribute("data-arch-node-id"), cx: r.left + r.width / 2, top: r.top, width: r.width };
			}),
		ctx.selectors.canvas);
		assert.ok(stops.length > 3, `focusable node count ${stops.length}`);

		const minWidth = Math.min(...stops.map((s) => s.width));
		const leftmost = Math.min(...stops.map((s) => s.cx));
		assert.ok(stops[0].cx - leftmost <= minWidth / 2, `first stop ${stops[0].id} is not in the entry column`);
		for (let i = 1; i < stops.length; i++) {
			const [prev, next] = [stops[i - 1], stops[i]];
			const sameColumn = Math.abs(next.cx - prev.cx) <= minWidth / 2;
			assert.ok(sameColumn ? next.top >= prev.top : next.cx > prev.cx, `Tab steps back from ${prev.id} to ${next.id}`);
		}
	});

	test("AC-18 no tab controls in the DOM", async () => {
		const tabCount = await ctx.page.evaluate(
			(sel) => document.querySelectorAll(sel.tabControl).length,
			ctx.selectors,
		);
		assert.equal(tabCount, 0, `tab control count for ${ctx.selectors.tabControl}`);
	});

	/**
	 * AC-B2-3a — 정상 판정도 링을 켬.
	 * 링 근거원이 데몬 판정 ∪ 부품 판정이므로 '정상은 안 켠다' 는 계약이 아님.
	 * 하네스는 데몬 health 만 세우므로 도착하는 부품 판정은 데몬 부품뿐임.
	 * 여기서 켜지는 것은 데몬 원천뿐 — 기대 집합이 데몬 바인딩 ∩ 각인 id 로 정확히 닫힘.
	 */
	test("AC-B2-3a healthy verdict lights the ok ring on exactly the bound rendered nodes", async () => {
		const expectedIds = await getRenderedBoundNodeIds(ctx.page, ctx.selectors.canvas);
		assert.ok(
			expectedIds.length > 0,
			`fixture precondition: none of ${BOUND_DAEMON}'s bound ids (${(DAEMON_NODE_BINDINGS[BOUND_DAEMON] ?? []).join(", ")}) is rendered in ${CANONICAL_DIAGRAM_ID} — the assertion below would be vacuous`,
		);

		const okCount = await countLiveToneClass(
			ctx.page,
			ctx.selectors.canvas,
			LIVE_TONE_CLASS.ok,
		);
		assert.equal(
			okCount,
			expectedIds.length,
			`${LIVE_TONE_CLASS.ok} count vs bound rendered nodes ${expectedIds.join(", ")}`,
		);

		// 링 규칙 (39731 S2) — ok 는 판정 클래스를 달되 테두리를 그리지 않음. 클래스 수만 재면
		// '판정이 왔음' 과 '테두리가 섰음' 이 한 값으로 접혀, 아홉 노드가 다 둘린 지도도 초록임.
		// 링 사각형의 존재를 먼저 단언함 — 없으면 아래 읽기는 빈 목록 위의 공허한 초록임.
		const okRingDisplays = await ctx.page.evaluate(
			(sel) =>
				Array.from(
					document.querySelectorAll(
						`${sel} svg .arch-node-live-ok > rect.arch-ring-state`,
					),
				).map((el) => getComputedStyle(el).display),
			ctx.selectors.canvas,
		);
		assert.ok(
			okRingDisplays.length > 0,
			"an ok-toned node must still carry its ring rect, or the reading below measures nothing",
		);
		assert.deepStrictEqual(
			[...new Set(okRingDisplays)],
			["none"],
			`an ok part must read unringed — displays: ${okRingDisplays.join(", ")}`,
		);

		for (const cls of [LIVE_TONE_CLASS.warn, LIVE_TONE_CLASS.crit]) {
			const count = await countLiveToneClass(ctx.page, ctx.selectors.canvas, cls);
			assert.equal(count, 0, `${cls} present under a healthy verdict`);
		}

		// 접두사 다리 — 리터럴 3종 밖의 이름으로 켜진 링까지 총계에 포함시켜 잼.
		const patternCount = await countLiveClassPattern(ctx.page, ctx.selectors.canvas);
		assert.equal(
			patternCount,
			expectedIds.length,
			`arch-node-live-* pattern count vs bound rendered nodes ${expectedIds.join(", ")}`,
		);

		const litIds = await getLitNodeIds(ctx.page, ctx.selectors.canvas);
		assert.deepStrictEqual(
			[...new Set(litIds.map(getUnscopedNodeId))].sort(),
			expectedIds,
			"the lit nodes must be the daemon's bound nodes, not merely as many as them",
		);
	});

	/**
	 * AC-B2-3c — 각인된 부품 바인딩에 판정이 없으면 그 노드는 켜지지 않음.
	 * 각인 전제를 먼저 세우는 이유 — 각인이 없으면 "바인딩이 없어서 안 켜졌다" 와 구별되지 않음.
	 * 그래서 (1) 픽스처가 싣는 표가 두 부품을 비어 있지 않게 각인함.
	 * (2) 그 id 들이 실제로 그려졌음을 먼저 재고, 그 다음에야 링 부재를 잼.
	 * 하네스가 pg·hook health 라우트를 세우지 않으므로 각인은 있고 판정만 비는 상태가 성립함.
	 */
	const UNVERDICTED_PARTS = ["pg", "hook-chain"] as const;

	test("AC-B2-3c a stamped part binding with no verdict leaves its nodes unlit", async () => {
		const stampedIds = UNVERDICTED_PARTS.flatMap((part) => {
			const ids = PART_NODE_BINDINGS[part] ?? [];
			assert.ok(
				ids.length > 0,
				`fixture precondition: the stamped part table must bind '${part}' to a non-empty node list — an empty list makes the unlit assertion vacuous`,
			);
			return [...ids];
		});

		const renderedIds = await getRenderedBoundIds(
			ctx.page,
			ctx.selectors.canvas,
			stampedIds,
		);
		assert.deepStrictEqual(
			renderedIds,
			[...new Set(stampedIds)].sort(),
			`fixture precondition: every stamped node (${stampedIds.join(", ")}) must be drawn in ${CANONICAL_DIAGRAM_ID} — an undrawn node is unlit for the wrong reason`,
		);

		const litIds = new Set(
			(await getLitNodeIds(ctx.page, ctx.selectors.canvas)).map(getUnscopedNodeId),
		);
		const litStamped = renderedIds.filter((id) => litIds.has(id));
		assert.deepStrictEqual(
			litStamped,
			[],
			"a part with a stamped binding but no arrived verdict must stay unlit — an unresolved response is not a healthy one",
		);
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
		ctx = await openRenderContext(getLiveFixture(FAULT_VERDICT, 999), getDaemonHealthFixture(FAULT_VERDICT));
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
	for (const { width, height } of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
		test(`a counted fault badge sits at most half off its own node's bottom border, clear of every label, neighbour node and other zone, at ${width}x${height}`, async () => {
			const pattern = "**/api/health/daemons";
			// two more faulted parts bound to one node → the badge carries its widest text, the count
			const health = getDaemonHealthFixture(FAULT_VERDICT);
			for (const daemonName of ["daily-restart-autoagent", "daily-restart-wiki"]) health.daemons.push({ ...health.daemons[0], daemon_name: daemonName });
			await ctx.page.route(pattern, (route) => route.fulfill({ json: health }));
			try {
				await ctx.page.setViewportSize({ width, height });
				await ctx.page.reload({ waitUntil: "load" });
				await ctx.page.waitForFunction(
					(sel) => Array.from(document.querySelectorAll(`${sel} svg text.arch-ring-glyph`)).some((glyph) => (glyph.textContent || "").includes("×")),
					ctx.selectors.canvas,
					{ timeout: 30_000 },
				);
				const glyphs = await ctx.page.evaluate((sel) => {
					// no named inner functions — tsx keepNames wraps them in __name, which the page does not define
					const probe = document.createElement("style");
					probe.textContent = `${sel} svg :is(rect.arch-ring, text.arch-ring-glyph, rect.arch-ring-glyph-pill) { pointer-events: auto !important; }`;
					document.head.appendChild(probe);
					const shapes = new Map(
						Array.from(document.querySelectorAll(`${sel} svg :is(g.node, g.cluster)`)).map((group) => [
							group,
							(group.querySelector(":scope > :is(rect, path, polygon):not(.arch-ring)") as Element).getBoundingClientRect(),
						]),
					);
					const zones = Array.from(document.querySelectorAll(`${sel} svg g.cluster`)).map((group) => shapes.get(group) as DOMRect);
					// per-line text boxes, not the label's line box — the half-leading under the last line paints nothing
					const labels = Array.from(document.querySelectorAll(`${sel} svg :is(g.node .nodeLabel, g.cluster .cluster-label)`))
						.flatMap((label) => {
							const rects: DOMRect[] = [];
							const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
							for (let text = walker.nextNode(); text; text = walker.nextNode()) {
								const range = document.createRange();
								range.selectNodeContents(text);
								rects.push(...Array.from(range.getClientRects()));
							}
							return rects;
						})
						.filter((box) => box.width > 0 && box.height > 0);
					const readings = Array.from(document.querySelectorAll(`${sel} svg text.arch-ring-glyph`))
						.filter((glyph) => getComputedStyle(glyph).display !== "none")
						.map((glyph) => {
							glyph.scrollIntoView({ block: "center", inline: "center" });
							const owner = glyph.parentElement as Element;
							const pill = owner.querySelector(":scope > rect.arch-ring-glyph-pill") as Element;
							const g = glyph.getBoundingClientRect();
							const p = pill.getBoundingClientRect();
							const n = shapes.get(owner) as DOMRect;
							// other nodes only — a cluster box contains its members, so it is not a neighbour
							const neighbours = [...shapes].filter(([group]) => group !== owner && group.matches("g.node")).map(([, box]) => box);
							// a zone not holding the owner's centre — the pill crossing into it reads as that zone's badge
							const foreignZones = zones.filter((z) => !(z.left < (n.left + n.right) / 2 && (n.left + n.right) / 2 < z.right && z.top < (n.top + n.bottom) / 2 && (n.top + n.bottom) / 2 < z.bottom));
							// labels by the ink the pill paints over; nodes and zones with a 2px clearance, so a touching pill fails
							const covered = [
								...labels.map((b) => ({ b, gap: 0 })),
								...[...neighbours, ...foreignZones].map((b) => ({ b, gap: 2 })),
							]
								.filter(({ b, gap }) => Math.min(p.right, b.right) - Math.max(p.left, b.left) > -gap && Math.min(p.bottom, b.bottom) - Math.max(p.top, b.top) > -gap)
								.map(({ b }) => `${b.left.toFixed(0)},${b.top.toFixed(0)}-${b.right.toFixed(0)},${b.bottom.toFixed(0)}`);
							const onNode = Math.max(0, Math.min(p.right, n.right) - Math.max(p.left, n.left)) * Math.max(0, Math.min(p.bottom, n.bottom) - Math.max(p.top, n.top));
							// whole glyph box sampled — anything but the badge on top of a sample point occludes the text
							const occluders: string[] = [];
							for (let col = 0; col <= 6; col++)
								for (let row = 0; row <= 2; row++) {
									const x = g.left + 1 + ((g.width - 2) * col) / 6;
									const y = g.top + 1 + ((g.height - 2) * row) / 2;
									const hit = document.elementFromPoint(x, y);
									if (hit !== glyph && hit !== pill) occluders.push(`${hit?.tagName}.${hit?.getAttribute("class") || ""}@${x.toFixed(0)},${y.toFixed(0)}`);
								}
							return {
								id: owner.getAttribute("data-arch-node-id") || owner.id,
								text: glyph.textContent || "",
								// across its own node's bottom border, wholly within the node's sides → at most half the pill off the node
								attached: p.left >= n.left && p.right <= n.right && p.top < n.bottom && p.bottom > n.bottom,
								offShare: 1 - onNode / (p.width * p.height),
								covered,
								occluders,
								box:
									`glyph ${g.left.toFixed(0)},${g.top.toFixed(0)}-${g.right.toFixed(0)},${g.bottom.toFixed(0)} ` +
									`pill ${p.left.toFixed(0)},${p.top.toFixed(0)}-${p.right.toFixed(0)},${p.bottom.toFixed(0)} ` +
									`node ${n.left.toFixed(0)},${n.top.toFixed(0)}-${n.right.toFixed(0)},${n.bottom.toFixed(0)}`,
							};
						});
					probe.remove();
					return readings;
				}, ctx.selectors.canvas);
				assert.ok(glyphs.some((glyph) => glyph.text.includes("×2")), `no counted badge drawn: ${glyphs.map((g) => g.text).join(" ")}`);
				// half the pill below the border is the straddle itself; 0.55 leaves room for sub-pixel rounding only
				const loose = glyphs.filter((glyph) => !glyph.attached || glyph.offShare > 0.55);
				assert.deepEqual(loose, [], `badges off their node's bottom border: ${loose.map((g) => `${g.id} ${(g.offShare * 100).toFixed(0)}% off (${g.box})`).join("; ")}`);
				const covering = glyphs.filter((glyph) => glyph.covered.length > 0);
				assert.deepEqual(covering, [], `badges over a label, another node or another zone: ${covering.map((g) => `${g.id} (${g.box} · covers ${g.covered.join(" ")})`).join("; ")}`);
				const hidden = glyphs.filter((glyph) => glyph.occluders.length > 0);
				assert.deepEqual(hidden, [], `badge text painted over: ${hidden.map((g) => `${g.id} '${g.text}' (${g.box} · ${g.occluders.join(" ")})`).join("; ")}`);
			} finally {
				await ctx.page.unroute(pattern);
				await ctx.page.setViewportSize({ width: 1440, height: 900 });
				await ctx.page.reload({ waitUntil: "load" });
				await ctx.page.waitForSelector(`${ctx.selectors.canvas} svg g.node[data-arch-node-id]`, { timeout: 30_000 });
			}
		});
	}
});
