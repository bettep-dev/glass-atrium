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

import Fastify, {
	type FastifyInstance,
	type FastifyReply,
	type FastifyRequest,
} from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { getArchitecture } from "../src/server/architecture/parser.js";
import { DAEMON_NODE_BINDINGS } from "../src/server/architecture/diagrams-source.js";
import type {
	ArchitectureLiveResponse,
	ArchDriftDiff,
	DaemonLiveStatus,
	WriterLiveStatus,
} from "../src/server/types/architecture.js";
import type {
	ImprovementLearningLogRow,
	ImprovementProposalRow,
} from "../src/server/types/improvement.js";

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

/**
 * 자기개선 큐 픽스처 — 화면이 실제로 읽는 필드만 담음.
 * 전체 응답 타입은 화면이 보지 않는 수십 개 필드를 요구하므로, Pick 으로 읽기 계약만 묶어 둠.
 * 필드명이 바뀌면 컴파일에서 걸림.
 */
type ProposalStub = Pick<ImprovementProposalRow, "id" | "status">;
type PatternStub = Pick<
	ImprovementLearningLogRow,
	"pattern_signature" | "frequency" | "last_updated"
>;

// 화면이 두 저장소를 각각 읽으므로 실패도 각각 심을 수 있어야 함.
type QueueStore = "improvement" | "learningLog";

interface QueueFixture {
	improvement: { proposals: ProposalStub[]; actionable_proposals: ProposalStub[] };
	learningLog: { patterns: PatternStub[] };
	// 라우트가 500 으로 끊을 저장소 — 화면 fetch 를 중단이 아닌 거부로 만듦.
	failedStores: QueueStore[];
}

// 화면이 두 사실에 붙이는 출처 표식 — 조인이 아니라 나란히 놓았음을 DOM 에서 읽는 키.
const QUEUE_SOURCE_PROPOSALS = "autoagent-proposals";
const QUEUE_SOURCE_LEARNING = "learning-log";

// 큐 실패 경보가 스스로를 부르는 이름 — 총 alert 수는 트리에 다른 경보가 많아 아무것도 재지 못함.
const QUEUE_ALERT_NEEDLE = "self-improvement queue";

const QUEUE_PENDING = 3;
const QUEUE_SIGNATURE = "T27_TOP_SIGNAL";
const QUEUE_FREQUENCY = 73;
const QUEUE_RECENT_SIGNATURE = "T27_RECENT_SIGNAL";
// formatRelativeTime(ui.jsx)이 2시간 전 instant 에 붙이는 라벨.
const QUEUE_UPDATED_LABEL = "2h ago";

function getQueueFixture(overrides: Partial<QueueFixture> = {}): QueueFixture {
	return {
		improvement: { proposals: [], actionable_proposals: [] },
		learningLog: { patterns: [] },
		failedStores: [],
		...overrides,
	};
}

/**
 * AC-T27 픽스처. pending 3건은 두 배열에 걸쳐 있고 id 1 이 겹침 — 단순 합산이면 4 가 나옴.
 * 빈도 최댓값 행을 응답 정렬(last_updated DESC)의 둘째에 둠 — 첫 행을 집으면 붉어짐.
 */
function getQueueLoadedFixture(): QueueFixture {
	const now = Date.now();
	return {
		failedStores: [],
		improvement: {
			proposals: [
				{ id: 1, status: "pending" },
				{ id: 2, status: "applied" },
			],
			actionable_proposals: [
				{ id: 1, status: "pending" },
				{ id: 3, status: "pending" },
				{ id: 4, status: "pending" },
				{ id: 5, status: "snoozed" },
			],
		},
		learningLog: {
			patterns: [
				{
					pattern_signature: QUEUE_RECENT_SIGNATURE,
					frequency: 4,
					last_updated: new Date(now - 60_000).toISOString(),
				},
				{
					pattern_signature: QUEUE_SIGNATURE,
					frequency: QUEUE_FREQUENCY,
					last_updated: new Date(now - 2 * 3_600_000).toISOString(),
				},
			],
		},
	};
}

/**
 * 로드 실패 픽스처 — 데이터는 loaded 와 같게 두고 끊을 저장소만 지정함.
 * 부분 실패에서 살아남은 쪽이 실제로 그려지는지 재려면 데이터가 있어야 함.
 */
function getQueueFailedFixture(
	failedStores: QueueStore[] = ["improvement", "learningLog"],
): QueueFixture {
	return { ...getQueueLoadedFixture(), failedStores };
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
let queueFixture: QueueFixture;

// 케이스별 live 픽스처를 심고 화면을 다시 세움. about:blank 경유는 같은 URL 재방문이
// same-document 로 흡수되어 재요청이 일어나지 않는 경우를 막기 위함.
async function openMap(
	live: ArchitectureLiveResponse,
	queue: QueueFixture = getQueueFixture(),
): Promise<void> {
	liveFixture = live;
	queueFixture = queue;
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
	queueFixture = getQueueFixture();
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
	// 자기개선 두 저장소 — 화면이 각각 따로 읽으므로 라우트도 따로 둠.
	app.get("/api/improvement", async (_req: FastifyRequest, reply: FastifyReply) =>
		queueFixture.failedStores.includes("improvement")
			? reply.code(500).send({ error: "queue fixture failure" })
			: queueFixture.improvement,
	);
	app.get(
		"/api/improvement/learning-log",
		async (_req: FastifyRequest, reply: FastifyReply) =>
			queueFixture.failedStores.includes("learningLog")
				? reply.code(500).send({ error: "queue fixture failure" })
				: queueFixture.learningLog,
	);
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

// 상시 칩이 렌더하던 정확한 라벨 — 기본 픽스처(writers 빈 배열 · 최근활동 0) 기준.
// 맨 단어(cost/agent/outcome)는 다이어그램 노드 라벨과 충돌하므로(diagrams-source 의
// outcome_block 등) 값까지 붙여 잼. 컨테이너 클래스는 세지 않음 — 로드 실패 경보와
// 로딩 스켈레톤이 같은 .arch-live-strip 을 쓰고 둘 다 남기 때문임.
const CHIP_LABELS = ["Writer 0/0", "cost 0", "agent 0", "outcome \u2014"];

// 실제 로스터 이름 — composeWriters(live-overlay.ts:383-387)가 내보내는 원소 모양과 같음.
// 마커 스캔 실패도 dual_write_active:false 로 떨어지므로 경보는 그 기본값에서도 떠야 함.
const OFF_WRITER = "outcome-record";
const ON_WRITER = "cost-tracker";

function getWriter(name: string, dualWriteActive: boolean): WriterLiveStatus {
	return {
		writer_name: name,
		dual_write_active: dualWriteActive,
		recent_failures_24h: 0,
	};
}

// 이름을 본문에 담은 alert 만 셈 — 트리에 role=alert 가 이미 여럿이라 총수는 무엇도 재지 못함.
async function countAlertsNaming(needle: string): Promise<number> {
	return await page.evaluate(
		(key) =>
			Array.from(document.querySelectorAll('[role="alert"]')).filter((el) =>
				(el.textContent || "").includes(key),
			).length,
		needle,
	);
}

test("AC-T18(a) the ready map renders no live chips", async () => {
	await openMap(getLiveFixture());

	// 두 사실을 한 단언으로 묶음 — 따로 세우면 앞 단언이 걸릴 때 뒤 다리가 측정되지 않음.
	const found = await page.evaluate((labels) => {
		const text = document.body.innerText || "";
		return {
			chips: document.querySelectorAll(".arch-live-chip").length,
			labels: labels.filter((label) => text.includes(label)),
		};
	}, CHIP_LABELS);

	assert.deepEqual(
		found,
		{ chips: 0, labels: [] },
		"live chip surface still rendered on the ready map",
	);
});

test("AC-T18(b) an inactive writer raises exactly one alert naming it", async () => {
	await openMap(
		getLiveFixture({
			writers: [getWriter(OFF_WRITER, false), getWriter(ON_WRITER, true)],
		}),
	);

	assert.equal(
		await countAlertsNaming(OFF_WRITER),
		1,
		`inactive ${OFF_WRITER} must be named by exactly one alert`,
	);
	// 정상 writer 까지 부르면 경보가 상시 칩으로 되돌아간 것임.
	assert.equal(
		await countAlertsNaming(ON_WRITER),
		0,
		`active ${ON_WRITER} must not be named by any alert`,
	);
});

test("AC-T18(b) no writer alert exists while dual-write is active", async () => {
	await openMap(
		getLiveFixture({
			writers: [getWriter(OFF_WRITER, true), getWriter(ON_WRITER, true)],
		}),
	);
	assert.equal(
		await countAlertsNaming(OFF_WRITER),
		0,
		`all-active roster must raise no alert naming ${OFF_WRITER}`,
	);

	await openMap(getLiveFixture({ writers: [] }));
	assert.equal(
		await countAlertsNaming(OFF_WRITER),
		0,
		`empty roster must raise no alert naming ${OFF_WRITER}`,
	);
});

// 새 경보가 기존 배너를 밀어내지 않았음을 잠금 — 둘이 동시에 뜨는 픽스처로 잼.
// 오늘 초록인 불변식 다리이고, 변위가 일어나야만 붉어짐.
test("AC-T18(c) the drift banner survives beside the writer alert", async () => {
	const driftKey = "T18_DRIFT_KEY";

	await openMap(
		getLiveFixture({
			stale: true,
			diffs: [getDriftDiff(driftKey)],
			writers: [getWriter(OFF_WRITER, false)],
		}),
	);

	assert.equal(
		await countAlertsNaming(driftKey),
		1,
		`writer alert must not displace the drift banner carrying ${driftKey}`,
	);
});

/**
 * 자기개선 큐 표면 탐침 — 출처 표식이 붙은 사실 요소만 읽음.
 * 컨테이너 클래스는 .arch-live-strip 이 아니어야 함 — 그 클래스는 AC-T18 의 칩 부재 단언과
 * live 로드 실패 경보의 자리임.
 */
async function getQueueProbe() {
	// 부재는 아래 단언이 문장으로 보고함 — 여기서 던지면 붉은 이유가 타임아웃으로 바뀜.
	await page
		.waitForSelector(".arch-queue-strip [data-queue-source]", { timeout: 10_000 })
		.then(
			() => true,
			() => false,
		);

	// evaluate 본문에 이름 붙은 내부 함수 금지 — tsx 의 keepNames 가 브라우저에 없는 __name 래퍼를 심음.
	// 접힘 판정을 루프로 편 이유임.
	return await page.evaluate(() => {
		const strip = document.querySelector(".arch-queue-strip");
		if (!strip) return { found: false, childCount: -1, nested: false, facts: [] };

		const facts = Array.from(
			strip.querySelectorAll<HTMLElement>("[data-queue-source]"),
		);

		const rows = [];
		for (const el of facts) {
			// 확장 조작이 필요한 상태인지 — 닫힌 details / hidden / aria-expanded=false 조상.
			let collapsed = false;
			for (let node: HTMLElement | null = el; node; node = node.parentElement) {
				if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open) {
					collapsed = true;
					break;
				}
				if (node.hasAttribute("hidden") || node.getAttribute("aria-expanded") === "false") {
					collapsed = true;
					break;
				}
			}

			const rect = el.getBoundingClientRect();
			rows.push({
				source: el.getAttribute("data-queue-source") || "",
				text: (el.innerText || "").replace(/\s+/g, " ").trim(),
				width: rect.width,
				height: rect.height,
				collapsed,
			});
		}

		let nested = false;
		for (const a of facts) {
			for (const b of facts) {
				if (a !== b && a.contains(b)) nested = true;
			}
		}

		return { found: true, childCount: strip.children.length, nested, facts: rows };
	});
}

test("AC-T27 pending count, top signal and its last update all show with nothing expanded", async () => {
	await openMap(getLiveFixture(), getQueueLoadedFixture());
	const probe = await getQueueProbe();

	assert.equal(
		probe.found,
		true,
		"map must render an always-on self-improvement queue surface (.arch-queue-strip)",
	);
	const pending = probe.facts.find((f) => f.source === QUEUE_SOURCE_PROPOSALS);
	const signal = probe.facts.find((f) => f.source === QUEUE_SOURCE_LEARNING);
	assert.ok(
		pending && signal,
		`both queue facts must render — got sources [${probe.facts.map((f) => f.source).join(", ")}]`,
	);

	// 세 정보를 한 단언으로 묶음 — 따로 세우면 앞이 걸릴 때 뒤 다리가 측정되지 않음.
	assert.deepEqual(
		{
			pendingCount: pending.text.includes(`${QUEUE_PENDING} pending`),
			signature: signal.text.includes(QUEUE_SIGNATURE),
			frequency: signal.text.includes(String(QUEUE_FREQUENCY)),
			lastUpdated: signal.text.includes(QUEUE_UPDATED_LABEL),
			// 최다 빈도가 아니라 최신 행을 집으면 이 이름이 나타남.
			pickedRecentInstead: signal.text.includes(QUEUE_RECENT_SIGNATURE),
			collapsed: pending.collapsed || signal.collapsed,
			zeroBox:
				pending.width <= 0 ||
				pending.height <= 0 ||
				signal.width <= 0 ||
				signal.height <= 0,
		},
		{
			pendingCount: true,
			signature: true,
			frequency: true,
			lastUpdated: true,
			pickedRecentInstead: false,
			collapsed: false,
			zeroBox: false,
		},
		`queue facts rendered as: pending="${pending.text}" · signal="${signal.text}"`,
	);
});

test("AC-T27 the two stores sit side by side, never merged into one claim", async () => {
	await openMap(getLiveFixture(), getQueueLoadedFixture());
	const probe = await getQueueProbe();

	assert.equal(probe.found, true, "queue surface must render before joint-ness can be judged");
	const pending = probe.facts.find((f) => f.source === QUEUE_SOURCE_PROPOSALS);
	const signal = probe.facts.find((f) => f.source === QUEUE_SOURCE_LEARNING);
	assert.ok(pending && signal, "both queue facts must render");

	// childCount === factCount 가 사이에 낀 연결 문구가 없음을 잠금 — 두 사실 외에
	// 아무 것도 스트립에 살지 않아야 조인된 서술이 끼어들 자리가 없음.
	assert.deepEqual(
		{
			factCount: probe.facts.length,
			childCount: probe.childCount,
			nested: probe.nested,
			sources: probe.facts.map((f) => f.source).sort(),
			pendingNamesSignature: pending.text.includes(QUEUE_SIGNATURE),
			signalNamesPending: /pending/i.test(signal.text),
		},
		{
			factCount: 2,
			childCount: 2,
			nested: false,
			sources: [QUEUE_SOURCE_LEARNING, QUEUE_SOURCE_PROPOSALS].sort(),
			pendingNamesSignature: false,
			signalNamesPending: false,
		},
		`queue strip rendered as: pending="${pending.text}" · signal="${signal.text}"`,
	);
});

/**
 * 큐 실패 표면 탐침 — 큐를 이름으로 부르는 alert 와 그 안의 복구 컨트롤을 함께 셈.
 * 둘을 따로 재면 경보만 있고 되돌릴 길이 없는 상태가 초록으로 지나감.
 */
async function getQueueFailureProbe() {
	return await page.evaluate((key) => {
		const alerts = Array.from(document.querySelectorAll('[role="alert"]')).filter((el) =>
			(el.textContent || "").includes(key),
		);
		let retries = 0;
		for (const el of alerts) retries += el.querySelectorAll("button").length;
		return { alerts: alerts.length, retries };
	}, QUEUE_ALERT_NEEDLE);
}

test("AC-T27 a rejected queue fetch raises exactly one alert naming the queue", async () => {
	await openMap(getLiveFixture(), getQueueFailedFixture());
	// 두 저장소가 모두 죽으면 사실 요소가 하나도 없어 getQueueProbe 의 대기가 걸리지 않음 —
	// 경보 등장을 여기서 기다려 붉은 이유가 경쟁이 되지 않게 함. 부재는 아래 단언이 문장으로 보고함.
	await page.waitForSelector(".arch-queue-error", { timeout: 10_000 }).then(
		() => true,
		() => false,
	);

	assert.deepEqual(
		await getQueueFailureProbe(),
		{ alerts: 1, retries: 1 },
		"both stores failing must name the queue in exactly one alert carrying a retry — a silent empty strip makes 'nothing pending' and 'could not load' indistinguishable",
	);

	// 부분 실패 — 살아남은 저장소는 그대로 보이고 경보는 여전히 한 건임.
	await openMap(getLiveFixture(), getQueueFailedFixture(["learningLog"]));
	const probe = await getQueueProbe();
	const pending = probe.facts.find((f) => f.source === QUEUE_SOURCE_PROPOSALS);

	assert.deepEqual(
		{
			alerts: (await getQueueFailureProbe()).alerts,
			pendingRendered: Boolean(pending?.text.includes(`${QUEUE_PENDING} pending`)),
			signalRendered: probe.facts.some((f) => f.source === QUEUE_SOURCE_LEARNING),
		},
		{ alerts: 1, pendingRendered: true, signalRendered: false },
		"one store's failure must raise the alert without erasing the store that answered",
	);
});

// 실패 표면이 성공 경로로 새지 않았음을 잠금 — AC-T18(c) 와 같은 성격의 불변식 다리라
// 오늘도 초록이고, 경보가 상시 노출로 바뀌어야만 붉어짐.
test("AC-T27 the loaded queue raises no failure alert", async () => {
	await openMap(getLiveFixture(), getQueueLoadedFixture());
	const probe = await getQueueProbe();

	assert.deepEqual(
		{
			alerts: (await getQueueFailureProbe()).alerts,
			factCount: probe.facts.length,
			childCount: probe.childCount,
		},
		{ alerts: 0, factCount: 2, childCount: 2 },
		"a fully loaded queue must render the two facts and nothing else — no error surface",
	);
});

/**
 * AC-T5 — fault 데몬의 바인딩 노드에만 상태 링이 붙음 (ADR-4 의 fault 한정 되돌림).
 * 여기서는 어느 노드가 켜졌는지를 재고, 리터럴 톤 3종의 개수 대조는 T6 이 render-structure 에서 맡음.
 * 대조군 데몬을 함께 심는 이유: fault 하나만으로는 링이 자기 노드 밖으로 새지 않았음을 못 잼.
 */
const RING_CRIT_CLASS = "arch-node-live-crit";
const OK_DAEMON = "wiki";

function getDaemon(name: string, effectiveStatus: string): DaemonLiveStatus {
	const nodeIds = [...(DAEMON_NODE_BINDINGS[name] ?? [])];
	assert.ok(
		nodeIds.length > 0,
		`fixture precondition: ${name} must carry node bindings`,
	);
	return {
		daemon_name: name,
		status: effectiveStatus,
		effective_status: effectiveStatus,
		last_run_at: null,
		staleness_minutes: null,
		node_ids: nodeIds,
		expected_cadence_minutes: 60,
	};
}

// 그려진 노드 중 해당 데몬에 바인딩된 것 — 캔버스는 canonical 맵 하나뿐이라
// 바인딩 id 전부가 렌더되지는 않음. 기대값을 상수로 적으면 맵 감축에 조용히 어긋남.
function getRenderedBound(rendered: string[], daemonName: string): string[] {
	const bound = new Set(DAEMON_NODE_BINDINGS[daemonName] ?? []);
	return rendered.filter((id) => bound.has(id.slice(id.lastIndexOf(".") + 1)));
}

async function getRingProbe(): Promise<{
	rendered: string[];
	ringed: string[];
	ringClasses: string[];
}> {
	return await page.evaluate((canvas) => {
		const rendered: string[] = [];
		const ringed: string[] = [];
		const ringClasses: string[] = [];

		for (const el of Array.from(document.querySelectorAll(`${canvas} g.node`))) {
			const nodeId = el.getAttribute("data-arch-node-id");
			if (nodeId) rendered.push(nodeId);

			// 접두사로 읽음 — 톤 이름을 바꿔 되살리는 경우까지 이 다리가 잡음.
			const hits = (el.getAttribute("class") || "")
				.split(/\s+/)
				.filter((c) => c.startsWith("arch-node-live-"));
			if (hits.length === 0) continue;

			ringed.push(nodeId || "(unmatched node)");
			ringClasses.push(...hits);
		}
		return { rendered, ringed, ringClasses };
	}, selectors.canvas);
}

test("AC-T5 a fault verdict lights that daemon's bound nodes and no others", async () => {
	await openMap(
		getLiveFixture({
			daemons: [getDaemon(BOUND_DAEMON, "stale"), getDaemon(OK_DAEMON, "ok")],
		}),
	);
	const probe = await getRingProbe();
	const faultNodes = getRenderedBound(probe.rendered, BOUND_DAEMON);

	assert.ok(
		faultNodes.length > 0,
		`canonical map must render at least one ${BOUND_DAEMON} node`,
	);
	assert.ok(
		getRenderedBound(probe.rendered, OK_DAEMON).length > 0,
		`canonical map must render at least one ${OK_DAEMON} node — the ok leg is vacuous without it`,
	);
	assert.deepEqual(
		probe.ringed.slice().sort(),
		faultNodes.slice().sort(),
		"the ring must land on exactly the fault daemon's rendered bound nodes",
	);
	assert.deepEqual(
		[...new Set(probe.ringClasses)],
		[RING_CRIT_CLASS],
		"a stale verdict must light the crit ring and nothing else",
	);
});

test("AC-T5 a healthy roster lights no node at all", async () => {
	await openMap(
		getLiveFixture({
			daemons: [getDaemon(BOUND_DAEMON, "ok"), getDaemon(OK_DAEMON, "ok")],
		}),
	);
	const probe = await getRingProbe();

	assert.ok(
		getRenderedBound(probe.rendered, BOUND_DAEMON).length > 0,
		"bound nodes must be rendered — otherwise the zero below counts nothing",
	);
	assert.deepEqual(
		probe.ringed,
		[],
		"a healthy roster must leave every node unlit — this is the un-reverted half of AC-15(b)",
	);
});

// 링이 기존 경보를 밀어내지 않았음을 잠금 — 셋이 동시에 뜨는 픽스처로 잼.
test("AC-T5 the ring displaces neither the drift banner nor the writer alert", async () => {
	const driftKey = "T5_DRIFT_KEY";

	await openMap(
		getLiveFixture({
			daemons: [getDaemon(BOUND_DAEMON, "stale")],
			stale: true,
			diffs: [getDriftDiff(driftKey)],
			writers: [getWriter(OFF_WRITER, false)],
		}),
	);

	assert.ok(
		(await getRingProbe()).ringed.length > 0,
		"fault fixture must light a node — otherwise the two legs below prove nothing",
	);
	assert.equal(
		await countAlertsNaming(driftKey),
		1,
		`drift banner carrying ${driftKey} must survive beside the ring`,
	);
	assert.equal(
		await countAlertsNaming(OFF_WRITER),
		1,
		`writer alert naming ${OFF_WRITER} must survive beside the ring`,
	);
});
