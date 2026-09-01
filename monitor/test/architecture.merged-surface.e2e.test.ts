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
import { existsSync } from "node:fs";
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
import {
	CANONICAL_MAP,
	DAEMON_NODE_BINDINGS,
	PART_NODE_BINDINGS,
} from "../src/server/architecture/diagrams-source.js";
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
import type {
	DaemonStatusCard,
	HealthDaemonPayloadResponse,
	HealthDaemonsResponse,
	HealthHookChainResponse,
	HealthHookFailuresResponse,
	HookFailureEntry,
} from "../src/server/types/health-detail.js";
import {
	assertFallbackWarningVisible,
	assertLayoutsDiffer,
	assertOrthogonalLinks,
	createFallbackWatch,
	findDiagonalSegments,
	getProbe,
	getRenderProbe,
	type FallbackWatch,
	type RenderProbe,
} from "./lib/mermaid-elk-probe.js";
import { compositeOver, contrastRatio, parseColor, type Rgba } from "./lib/wcag-contrast.js";

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
				// Required on DaemonLiveStatus and the field the screen actually reads; the
				// fixture omitted it. Mirroring `status` keeps the TONE where it already was —
				// "critical" is not a DAEMON_STATUS_TONE key, so it resolves through the same
				// `info` fallback that `undefined` did. The LABEL is not preserved: that fallback
				// is `{ tone: 'info', label: status || '—' }` (ui.jsx `daemonStatusLabel`), so the
				// pill text moves from `—` to `critical`. A later T7/T8 assertion on LiveStrip
				// text inherits `critical`, not the em dash this fixture used to render.
				effective_status: "critical",
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
		// 서버가 실제로 싣는 표 그대로 — 이 하네스의 기본 payload 는 /live 응답의 본이어야 함.
		// `{}` 면 부품 링을 재는 AC-B2-3d 가 바인딩 부재로 공허 통과함. overrides 뒤에 있으므로
		// 개별 케이스는 여전히 다른 표(또는 빈 표)로 덮어쓸 수 있음.
		part_bindings: PART_NODE_BINDINGS,
		...overrides,
	};
}

/**
 * 자기개선 큐 픽스처 — 지도는 이 둘을 읽지 않지만 라우트가 답할 본문은 있어야 함(AC-B2-6c).
 * 전체 응답 타입은 수십 개 필드를 요구하므로, Pick 으로 읽기 계약만 묶어 둠.
 * 필드명이 바뀌면 컴파일에서 걸림.
 */
type ProposalStub = Pick<ImprovementProposalRow, "id" | "status">;
type PatternStub = Pick<
	ImprovementLearningLogRow,
	"pattern_signature" | "frequency" | "last_updated"
>;

interface QueueFixture {
	improvement: { proposals: ProposalStub[]; actionable_proposals: ProposalStub[] };
	learningLog: { patterns: PatternStub[] };
}

function getQueueFixture(overrides: Partial<QueueFixture> = {}): QueueFixture {
	return {
		improvement: { proposals: [], actionable_proposals: [] },
		learningLog: { patterns: [] },
		...overrides,
	};
}

// ── health 픽스처 (T7: 맵이 흡수한 다섯 응답) ───────────────────────────────
// 화면이 실제로 읽는 필드만 담되 타입으로 묶음 — 서버 계약이 움직이면 컴파일에서 걸림.
// /api/health 의 응답 타입은 라우트 파일 안에 갇혀 있어 읽기 계약만 여기서 다시 묶음.
type PgHealthStub = { status: "ok" | "degraded"; db: "open" | "closed"; browser: "ok" | "failed" | "unprobed" };
type DaemonCardStub = Pick<DaemonStatusCard, "daemon_name" | "effective_status" | "last_run_at">;

// 500 으로 끊을 수 있는 health 저장소 — 페이로드는 자기 손잡이(payloadFails)를 이미 가짐.
type HealthStore = "health" | "daemons" | "hookChain" | "hookFailures";

interface HealthFixture {
	daemons: DaemonCardStub[];
	pg: PgHealthStub;
	// source_* 까지 담음 — T11 의 전역 블록이 "이 구성이 어느 파일에서 왔는가" 를 냄.
	hookChain: Pick<HealthHookChainResponse, "events" | "source_path" | "source_mtime">;
	payload: Pick<HealthDaemonPayloadResponse, "entries">;
	// 창 안 목록(failures)과 창 밖 최종기록(last_failure_ts)을 따로 실음 — T12c 가 재는 것이
	// 정확히 그 둘이 다른 사실이라는 점이고, 한 값으로 접으면 빈 창 케이스를 세울 자리가 없어짐.
	hookFailures: Pick<
		HealthHookFailuresResponse,
		"count_24h" | "unretried_count_24h" | "failures" | "error_kind_breakdown" | "last_failure_ts"
	>;
	// 페이로드 응답을 500 으로 끊음 — 화면 fetch 를 중단이 아닌 거부로 만듦.
	// 못 읽음과 늦음을 따로 심는 두 손잡이라 하나로 접지 않음: 한 값으로는
	// "끊긴 응답이 로딩으로 읽힌다" 는 결함을 세울 자리가 없어짐.
	payloadFails: boolean;
	// 페이로드 응답을 이만큼 늦춤 — 아직 안 온 응답이 실제로 로딩으로 읽히는지 재는 자리.
	payloadDelayMs: number;
	// 500 으로 끊을 저장소 — 표가 못 읽은 응답을 판정으로 꾸미지 않는지(AC-B2-6f), 그리고
	// 끊긴 저장소를 이름으로 부르는지(AC-B2-6b) 재려면 하나씩 끊을 수 있어야 함.
	failedStores: HealthStore[];
}

// HEALTH_CARD_DEFS 의 daemon 카드 이름 — 이 둘만 명부에 두고 daily-restart-* 는 뺌.
// 빠진 둘은 '못 찾음' 경로로 info 버킷에 들어가므로 분자/분모가 서로 다른 수가 됨:
// 총계만 세는 픽스처는 버킷 배분이 뒤집혀도 초록이 됨.
const HEALTH_OK_DAEMONS = ["autoagent", "wiki"];

// 응답이 내는 마지막 실행 시각 — 명부에 있는 데몬만 이 값을 받고, 나머지 부품은 낼 실행이 없음.
const DAEMON_RUN_TS = "2026-08-20T09:10:11.000Z";

// 부품 명부의 크기 — HEALTH_CARD_DEFS 7종(PG · Chromium · daemon×4 · hook chain).
// 표의 행 수가 이 명부를 따르는지 재는 자리라 화면이 아니라 명부의 사실임.
const HEALTH_EXPECTED_TOTAL = 7;

// 페이로드 항목 수 — 맵은 도착 건수만 한 줄로 냄(날짜·사유 펼침은 T9c 몫).
const HEALTH_PAYLOAD_ENTRIES = 3;

// 실패가 하나도 없는 hook-failures 응답 — 기본 픽스처와 T12c 의 창 픽스처가 같은 바닥에서 출발함.
// 함수인 이유: 배열 두 개를 케이스마다 새로 냄(공유 참조면 한 케이스의 변형이 다음 케이스로 샘).
function getEmptyHookFailures(): HealthFixture["hookFailures"] {
	return {
		count_24h: 0,
		unretried_count_24h: 0,
		failures: [],
		error_kind_breakdown: [],
		last_failure_ts: null,
	};
}

function getHealthFixture(overrides: Partial<HealthFixture> = {}): HealthFixture {
	return {
		daemons: HEALTH_OK_DAEMONS.map((daemon_name) => ({
			daemon_name,
			effective_status: "ok",
			last_run_at: DAEMON_RUN_TS,
		})),
		pg: { status: "ok", db: "open", browser: "ok" },
		hookChain: {
			events: [{ event: "PreToolUse", groups: [] }],
			source_path: "/fixture/.claude/settings.json",
			source_mtime: "2026-08-20T04:05:06.000Z",
		},
		payload: {
			entries: Array.from({ length: HEALTH_PAYLOAD_ENTRIES }, (_v, i) => ({
				run_date: `2026-08-${String(20 + i).padStart(2, "0")}`,
				daemon_name: "autoagent",
				payload: {},
				payload_size_bytes: 128,
				summary: { verdict: "ok" as const, error_signatures: [] },
			})),
		},
		hookFailures: getEmptyHookFailures(),
		payloadFails: false,
		payloadDelayMs: 0,
		failedStores: [],
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
let queueFixture: QueueFixture;
let healthFixture: HealthFixture;

// 자기개선 두 경로의 요청 '횟수' — 0 을 재는 계기이므로 집합이 아니라 수여야 함.
// (집합은 '한 번도 안 옴' 과 '왔다가 지워짐' 을 같은 크기로 냄)
const queueCounts = new Map<string, number>();

function recordQueueHit(path: string): void {
	queueCounts.set(path, (queueCounts.get(path) || 0) + 1);
}

// 맵이 실제로 요청한 health 경로 — 라우트 핸들러가 스스로 기록함.
// 흡수 완결성(다섯 응답)을 소스 grep 이 아니라 브라우저 왕복으로 잼.
const healthHits = new Set<string>();

// 경로별 요청 '횟수' — 집합은 한 번 온 것과 네 번 온 것을 구별하지 못함.
// 드릴다운 한 번이 다섯 응답을 모두 다시 끌고 오는지는 그 차이에서만 보임.
const healthCounts = new Map<string, number>();

function recordHealthHit(path: string): void {
	healthHits.add(path);
	healthCounts.set(path, (healthCounts.get(path) || 0) + 1);
}

// 지금 시점의 횟수 사본 — 클릭 전후를 비교하려면 살아 있는 Map 이 아니라 스냅샷이어야 함.
function getHealthCounts(): Record<string, number> {
	return Object.fromEntries(healthCounts);
}

// 폴백 경고 감시 — 첫 렌더보다 먼저 붙어야 초기 경고를 놓치지 않으므로 페이지 생성 직후에 붙임.
let elkWatch: FallbackWatch;

// 케이스별 live 픽스처를 심고 화면을 다시 세움. about:blank 경유는 같은 URL 재방문이
// same-document 로 흡수되어 재요청이 일어나지 않는 경우를 막기 위함.
async function openMap(
	live: ArchitectureLiveResponse,
	queue: QueueFixture = getQueueFixture(),
	health: HealthFixture = getHealthFixture(),
): Promise<void> {
	liveFixture = live;
	queueFixture = queue;
	healthFixture = health;
	healthHits.clear();
	healthCounts.clear();
	queueCounts.clear();
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

// health 픽스처만 갈아끼우는 케이스용 — 큐를 기본값으로 다시 적는 자리 인자를 지움.
// 케이스가 무엇을 바꾸는지가 호출 한 줄에 남음.
async function openMapWithHealth(health: HealthFixture): Promise<void> {
	await openMap(getLiveFixture(), getQueueFixture(), health);
}

// 선택자 한 노드의 정규화된 innerText — 라벨과 값이 한 노드 안에 있는 표면을 이 함수로 읽음.
// page.evaluate 는 함수를 직렬화해 보내므로 브라우저 안에서 바깥 도우미를 부를 수 없음:
// 정규화식이 케이스마다 다시 적히지 않도록 읽는 자리를 하나로 둠.
async function getNodeText(selector: string): Promise<string> {
	return await page.evaluate((sel) => {
		const el = document.querySelector(sel);
		return el ? (el as HTMLElement).innerText.replace(/\s+/g, " ").trim() : "";
	}, selector);
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
	healthFixture = getHealthFixture();
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
	// 자기개선 두 저장소 — 지도는 더 이상 읽지 않지만 라우트는 남김.
	// 요청이 '일어나지 않았음' 은 응답하는 자리가 있어야만 셀 수 있음(AC-B2-6c).
	app.get("/api/improvement", async () => {
		recordQueueHit("/api/improvement");
		return queueFixture.improvement;
	});
	app.get("/api/improvement/learning-log", async () => {
		recordQueueHit("/api/improvement/learning-log");
		return queueFixture.learningLog;
	});
	// health 응답 5종 — 맵이 흡수한 뒤로 화면이 직접 읽는 경로 (ADR-B1 R2).
	// 진짜 health 라우트는 PG·chromium 프로브를 물고 있어 이 하네스를 호스트 상태에 묶으므로
	// live 라우트와 같은 방식으로 픽스처만 냄.
	app.get("/api/health", async (_req: FastifyRequest, reply: FastifyReply) => {
		recordHealthHit("/api/health");
		if (healthFixture.failedStores.includes("health"))
			return reply.code(500).send({ error: "health fixture failure" });
		return { ...healthFixture.pg, version: "test", timezone: "UTC" };
	});
	app.get("/api/health/daemons", async (_req: FastifyRequest, reply: FastifyReply) => {
		recordHealthHit("/api/health/daemons");
		if (healthFixture.failedStores.includes("daemons"))
			return reply.code(500).send({ error: "health fixture failure" });
		return { daemons: healthFixture.daemons as DaemonStatusCard[], timezone: "UTC" } satisfies Partial<HealthDaemonsResponse>;
	});
	app.get("/api/health/hook-chain", async (_req: FastifyRequest, reply: FastifyReply) => {
		recordHealthHit("/api/health/hook-chain");
		if (healthFixture.failedStores.includes("hookChain"))
			return reply.code(500).send({ error: "health fixture failure" });
		return healthFixture.hookChain;
	});
	app.get(
		"/api/health/daemon-payload",
		async (request: FastifyRequest, reply: FastifyReply) => {
			const daemon = (request.query as { daemon?: string } | undefined)?.daemon || "";
			// 질의 문자열까지 기록 — 선택 데몬이 URL 에 실려 나가는지가 T9c 드릴다운의 전제임.
			recordHealthHit(`/api/health/daemon-payload?daemon=${daemon}`);

			// 거부와 지연을 따로 냄 — 화면이 '못 읽음' 과 '아직 안 옴' 을 다른 문장으로 부르는지
			// 재려면 그 둘을 각각 심을 수 있어야 함.
			if (healthFixture.payloadFails)
				return reply.code(500).send({ error: "payload fixture failure" });

			if (healthFixture.payloadDelayMs > 0)
				await new Promise((resolve) => setTimeout(resolve, healthFixture.payloadDelayMs));

			return { daemon, ...healthFixture.payload, timezone: "UTC" };
		},
	);
	app.get("/api/health/hook-failures", async (_req: FastifyRequest, reply: FastifyReply) => {
		recordHealthHit("/api/health/hook-failures");
		if (healthFixture.failedStores.includes("hookFailures"))
			return reply.code(500).send({ error: "health fixture failure" });
		return { ...healthFixture.hookFailures, days: HOOK_FAIL_WINDOW_DAYS, timezone: "UTC" };
	});
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
	elkWatch = createFallbackWatch(page);
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
		getNormalized(probe.text),
		expectedDescription,
		`target #${probe.id} must expose the payload description verbatim`,
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

// 산문 섹션이 자기를 부르던 세 자리 — 섹션 클래스 · 접근성 라벨 · 눈에 보이던 헤딩 문구.
// 한 자리만 세면 나머지 둘이 남아도 초록이 됨.
const PROSE_SECTION_SELECTOR = ".arch-prose";
const PROSE_HEADING = "About this diagram";

test("AC-T17 the map renders no About this diagram prose section", async () => {
	await openMap(getLiveFixture());

	const probe = await page.evaluate(
		({ selector, heading }) => ({
			sections: document.querySelectorAll(selector).length,
			labelled: document.querySelectorAll(`[aria-label="${heading}"]`).length,
			// 대소문자를 접고 셈 — innerText 는 text-transform 을 반영하므로 uppercase 헤딩은 원문 리터럴과 안 맞음.
			headings:
				(document.body.innerText || "").toUpperCase().split(heading.toUpperCase()).length - 1,
		}),
		{ selector: PROSE_SECTION_SELECTOR, heading: PROSE_HEADING },
	);

	assert.deepEqual(
		probe,
		{ sections: 0, labelled: 0, headings: 0 },
		`prose section must be gone from all three of its surfaces — ${PROSE_SECTION_SELECTOR}, aria-label="${PROSE_HEADING}" and the visible heading text`,
	);

	// AC-T17 의 둘째 절 — 설명 전문은 T15 의 은닉 컨테이너에 남아야 함.
	// 산문과 함께 설명까지 지우면 aria-describedby 가 끊겨 AC-11 이 무너짐.
	const desc = await getDescProbe();

	assert.equal(desc.found, true, `aria-describedby target #${desc.id} must survive the prose removal`);
	assert.equal(
		getNormalized(desc.text),
		expectedDescription,
		`target #${desc.id} must still expose the payload description verbatim`,
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
 * AC-T5 — fault 데몬의 바인딩 노드에만 상태 링이 붙음 (ADR-4 의 fault 한정 되돌림).
 * 여기서는 어느 노드가 켜졌는지를 재고, 리터럴 톤 3종의 개수 대조는 T6 이 render-structure 에서 맡음.
 * 대조군 데몬을 함께 심는 이유: fault 하나만으로는 링이 자기 노드 밖으로 새지 않았음을 못 잼.
 */
const RING_CRIT_CLASS = "arch-node-live-crit";
const RING_OK_CLASS = "arch-node-live-ok";
const OK_DAEMON = "wiki";

// 데몬 원천과 부품 원천이 같은 노드에서 만나는 자리 — HEALTH_CARD_DEFS 의 autoagent 카드 id.
const DAEMON_PART_ID = "daemon-cycle";

// 데몬 넷 밖의 부품 셋(PG · Chromium export · hook chain) → 그 판정을 대신 내는 존.
// 화면은 이 짝을 리터럴로 갖지 않음 — 그려지는 소스의 subgraph 멤버십과 part_bindings 를 곱해
// "헬스 노드를 하나만 담은 존" 을 파생함. 여기 리터럴은 그 파생이 오늘 무엇을 내는지 못 박는 자리이고,
// 집합 동등(그 셋이 전부인가)은 AC-B2-3f 가 따로 잼.
const ZONE_REPRESENTED_PART_ZONE: Readonly<Record<string, string>> = {
	pg: "data",
	browser: "export",
	"hook-chain": "hooks",
};

// 존 링 클래스 — 노드 쪽 `arch-node-live-` 와 접두사를 가름(계수 다리가 섞이지 않게).
const ZONE_RING_OK_CLASS = "arch-zone-live-ok";
const ZONE_RING_CRIT_CLASS = "arch-zone-live-crit";

// 폴링 재도착을 재는 경로 — PG·Chromium 판정이 같은 응답에서 옴.
const PG_HEALTH_PATH = "/api/health";

// 화면의 HEALTH_POLL_MS(60s) 한 틱 + 왕복 여유. 상수를 내보내지 않으므로 하네스가 상한만 가짐.
const HEALTH_POLL_WAIT_MS = 100_000;

// 캔버스 SVG 의 element id — mermaid 가 렌더마다 새로 짓는 값이라 재렌더 여부의 지표가 됨.
async function getCanvasSvgId(): Promise<string> {
	return await page.evaluate((canvas) => {
		const svgEl = document.querySelector(`${canvas} svg`);
		return svgEl?.getAttribute("id") || "";
	}, selectors.canvas);
}

// 해당 경로의 누적 요청 수가 목표에 닿을 때까지 대기 — 폴링 한 틱이 실제로 나갔는지의 근거.
async function waitForHealthPoll(path: string, target: number): Promise<boolean> {
	const deadline = Date.now() + HEALTH_POLL_WAIT_MS;
	while (Date.now() < deadline) {
		if ((getHealthCounts()[path] || 0) >= target) return true;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

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

interface RingProbe {
	rendered: string[];
	ringed: string[];
	ringClasses: string[];
	// 노드 하나가 실제로 든 링 클래스 목록 — 총계만으로는 어느 노드가 어느 tone 인지 못 가름.
	// 두 원천이 같은 노드를 짚는 자리(autoagent_d · cron)의 최악-우선 결과를 재는 유일한 다리임.
	classByNode: Record<string, string[]>;
}

async function getRingProbe(): Promise<RingProbe> {
	return await page.evaluate((canvas) => {
		const rendered: string[] = [];
		const ringed: string[] = [];
		const ringClasses: string[] = [];
		const classByNode: Record<string, string[]> = {};

		for (const el of Array.from(document.querySelectorAll(`${canvas} g.node`))) {
			const nodeId = el.getAttribute("data-arch-node-id");
			if (nodeId) rendered.push(nodeId);

			// 접두사로 읽음 — 톤 이름을 바꿔 되살리는 경우까지 이 다리가 잡음.
			const hits = (el.getAttribute("class") || "")
				.split(/\s+/)
				.filter((c) => c.startsWith("arch-node-live-"));
			if (nodeId) classByNode[nodeId] = hits;
			if (hits.length === 0) continue;

			ringed.push(nodeId || "(unmatched node)");
			ringClasses.push(...hits);
		}
		return { rendered, ringed, ringClasses, classByNode };
	}, selectors.canvas);
}

// 부품 바인딩 중 이 캔버스가 실제로 그린 것들 — 데몬 쪽 getRenderedBound 의 부품 판임.
function getRenderedPart(rendered: string[], partId: string): string[] {
	const bound = new Set(PART_NODE_BINDINGS[partId] ?? []);
	return rendered.filter((id) => bound.has(id.slice(id.lastIndexOf(".") + 1)));
}

interface ZoneRingProbe {
	// 존 id → 그 존 g 가 든 존 링 클래스 목록. 모든 존을 실음(안 켜진 존은 빈 배열) —
	// 켜져야 할 존만 담으면 "엉뚱한 존이 켜졌다" 를 못 잼.
	zoneClasses: Record<string, string[]>;
	// 존 링 사각형의 계산된 stroke — 클래스가 붙었는지가 아니라 실제로 그 색으로 그려지는지를 잼.
	zoneStroke: Record<string, string>;
}

// 존 id 는 cluster element id 의 마지막 '-' 뒤 segment 에서 뽑음. 화면 쪽은 아는 존 id 목록에
// 접미사를 맞대는 다른 방법을 쓰므로, 두 파생이 갈라지면 여기가 먼저 붉어짐.
async function getZoneRingProbe(): Promise<ZoneRingProbe> {
	return await page.evaluate((canvas) => {
		const zoneClasses: Record<string, string[]> = {};
		const zoneStroke: Record<string, string> = {};

		for (const el of Array.from(document.querySelectorAll(`${canvas} g.cluster`))) {
			const zoneId = (el.id || "").slice((el.id || "").lastIndexOf("-") + 1);
			if (!zoneId) continue;

			zoneClasses[zoneId] = (el.getAttribute("class") || "")
				.split(/\s+/)
				.filter((c) => c.startsWith("arch-zone-live-"));
			const ring = el.querySelector(":scope > rect.arch-ring-state");
			zoneStroke[zoneId] = ring ? getComputedStyle(ring).stroke : "(no ring rect)";
		}
		return { zoneClasses, zoneStroke };
	}, selectors.canvas);
}

// 존 하나가 정확히 이 클래스 하나만 들었는지 + 그 색으로 실제로 그려지는지.
// 색은 토큰에서 읽어 대조함 — 리터럴을 적으면 토큰이 바뀔 때 화면과 갈라짐.
async function assertZoneRing(
	probe: ZoneRingProbe,
	zoneId: string,
	expectedClass: string,
	token: string,
): Promise<void> {
	assert.ok(
		Object.hasOwn(probe.zoneClasses, zoneId),
		`fixture precondition: the canvas draws no zone '${zoneId}' — the assertion below would be vacuous`,
	);
	assert.deepEqual(
		probe.zoneClasses[zoneId],
		[expectedClass],
		`zone '${zoneId}' must carry exactly ${expectedClass}`,
	);

	const colour = await getTokenColour(token);
	assert.equal(
		probe.zoneStroke[zoneId],
		colour,
		`zone '${zoneId}' must draw its ring in the ${token} the screen declares (${colour}) — a class with no paint is not a visible verdict`,
	);
}

// 존이 대표하는 노드에는 링이 남으면 안 됨 — 같은 판정이 두 겹으로 읽힘.
function assertNodeUnringed(probe: RingProbe, partId: string, zoneId: string): void {
	const nodes = getRenderedPart(probe.rendered, partId);
	assert.ok(
		nodes.length > 0,
		`fixture precondition: none of part '${partId}' bound ids is drawn — the assertion below would be vacuous`,
	);
	for (const nodeId of nodes) {
		assert.deepEqual(
			probe.classByNode[nodeId],
			[],
			`${nodeId} is represented by zone '${zoneId}' — the same verdict must not also ring the node`,
		);
	}
}

// 존 링이 기대 클래스를 들 때까지 대기 — 응답 도착과 DOM 반영 사이의 틈만 흡수함 (부품 링 대기의 존 판).
async function waitForZoneRing(zoneId: string, expected: string): Promise<ZoneRingProbe> {
	const deadline = Date.now() + 10_000;
	let probe = await getZoneRingProbe();
	while (Date.now() < deadline) {
		if ((probe.zoneClasses[zoneId] || []).includes(expected)) return probe;
		await new Promise((resolve) => setTimeout(resolve, 200));
		probe = await getZoneRingProbe();
	}
	return probe;
}

// 부품 하나의 그려진 노드 전원이 정확히 이 클래스 하나만 들었는지 — 전제(그려짐)까지 함께 잼.
// 전제를 빼면 "노드가 없어서 어긋남이 없다" 가 초록으로 지나감.
function assertPartRing(probe: RingProbe, partId: string, expected: string): void {
	const nodes = getRenderedPart(probe.rendered, partId);
	assert.ok(
		nodes.length > 0,
		`fixture precondition: none of part '${partId}' bound ids (${(PART_NODE_BINDINGS[partId] ?? []).join(", ")}) is drawn — the ring assertion below would be vacuous`,
	);
	for (const nodeId of nodes) {
		assert.deepEqual(
			probe.classByNode[nodeId],
			[expected],
			`part '${partId}' node ${nodeId} must carry exactly ${expected}`,
		);
	}
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
	// 정상 판정도 링을 켜므로 '켜진 노드 전체' 는 결함 집합이 아님.
	// 새는지를 재는 자리는 crit 클래스를 든 노드 집합.
	const critNodes = probe.ringed.filter((id) =>
		(probe.classByNode[id] || []).includes(RING_CRIT_CLASS),
	);
	assert.deepEqual(
		critNodes.slice().sort(),
		faultNodes.slice().sort(),
		"the crit ring must land on exactly the fault daemon's rendered bound nodes",
	);
});

/**
 * AC-B2-3b — 결함 판정이 같은 노드의 정상 부품 판정에 덮이지 않음 (최악-우선).
 * 두 원천이 실제로 겹치는 유일한 종류의 노드 — /live 는 autoagent 를 stale 로, health 명부는 같은 데몬을 ok 로 냄.
 * 겹침이 비면 단언이 공허해지므로 먼저 잼.
 */
test("AC-B2-3b a fault daemon verdict outranks the healthy part verdict on the same node", async () => {
	const health = getHealthFixture();
	assert.ok(
		health.daemons.some((d) => d.daemon_name === BOUND_DAEMON && d.effective_status === "ok"),
		`fixture precondition: the health roster must call ${BOUND_DAEMON} healthy — otherwise no ok verdict competes for the node`,
	);

	// 대조군 — 데몬 명부를 비워 부품 판정만 남김.
	// 겹침 노드가 여기서 ok 로 켜져야 아래 crit 이 '경쟁에서 이겼다' 가 됨.
	// 부품 판정이 아예 없으면 단언이 공허해짐.
	await openMap(getLiveFixture({ daemons: [] }), getQueueFixture(), health);
	assertPartRing(await getRingProbe(), DAEMON_PART_ID, RING_OK_CLASS);

	await openMap(
		getLiveFixture({ daemons: [getDaemon(BOUND_DAEMON, "stale")] }),
		getQueueFixture(),
		health,
	);
	const probe = await getRingProbe();

	const daemonNodes = new Set(getRenderedBound(probe.rendered, BOUND_DAEMON));
	const contested = getRenderedPart(probe.rendered, DAEMON_PART_ID).filter((id) =>
		daemonNodes.has(id),
	);
	assert.ok(
		contested.length > 0,
		`fixture precondition: no drawn node is bound by both ${BOUND_DAEMON} and part '${DAEMON_PART_ID}' — nothing competes, so the assertion below is vacuous`,
	);

	for (const nodeId of contested) {
		assert.deepEqual(
			probe.classByNode[nodeId],
			[RING_CRIT_CLASS],
			`${nodeId} carries both a fault daemon verdict and a healthy part verdict — only the worst may be painted`,
		);
	}
});

/**
 * AC-B2-3d — 부품 판정이 자기 자리를 켬. 데몬 넷 밖의 세 부품(PG · Chromium export · hook chain)은
 * 이 경로가 없으면 영영 판정 없이 남음.
 * 그 셋은 저마다 헬스 노드를 하나만 담은 존에 있어, 판정이 노드가 아니라 존 상자에 걸림 —
 * 그래서 존이 켜졌는지와 노드가 안 켜졌는지를 함께 잼. 앞만 재면 판정이 두 겹으로 읽히는 회귀가 지나감.
 */
test("AC-B2-3d healthy part verdicts light the zone that represents them", async () => {
	await openMapWithHealth(getHealthFixture());
	const nodeProbe = await getRingProbe();
	const zoneProbe = await getZoneRingProbe();

	for (const [partId, zoneId] of Object.entries(ZONE_REPRESENTED_PART_ZONE)) {
		await assertZoneRing(zoneProbe, zoneId, ZONE_RING_OK_CLASS, "--ok");
		assertNodeUnringed(nodeProbe, partId, zoneId);
	}
});

test("AC-B2-3d an unreachable PG and a failed export probe light their zones crit", async () => {
	await openMapWithHealth(
		getHealthFixture({ pg: { status: "degraded", db: "closed", browser: "failed" } }),
	);
	const zoneProbe = await getZoneRingProbe();

	await assertZoneRing(zoneProbe, ZONE_REPRESENTED_PART_ZONE.pg, ZONE_RING_CRIT_CLASS, "--crit");
	await assertZoneRing(
		zoneProbe,
		ZONE_REPRESENTED_PART_ZONE.browser,
		ZONE_RING_CRIT_CLASS,
		"--crit",
	);
});

/**
 * AC-B2-3f — 존이 판정을 대신 내는 자리는 오늘 정확히 셋임.
 * 화면은 이름 셋을 갖고 있지 않고 소스의 subgraph 멤버십 × part_bindings 로 파생하므로, 존이 갈리거나
 * 부품 바인딩이 옮겨 가면 파생 결과가 조용히 움직임 — 그 움직임을 여기서 붙잡음.
 * 데몬 존이 빠져 있는 것이 이 단언의 반쪽임: 헬스 노드 셋을 담은 존은 노드마다 다른 판정을 내야 하므로
 * 존 하나로 접으면 그 세 판정이 하나로 뭉개짐.
 */
test("AC-B2-3f exactly the zones with a single health node carry the verdict", async () => {
	await openMapWithHealth(getHealthFixture());
	const zoneProbe = await getZoneRingProbe();

	const lit = Object.entries(zoneProbe.zoneClasses)
		.filter(([, classes]) => classes.length > 0)
		.map(([zoneId]) => zoneId)
		.sort();
	assert.deepEqual(
		lit,
		[...new Set(Object.values(ZONE_REPRESENTED_PART_ZONE))].sort(),
		"the screen derives zone representation from subgraph membership x part_bindings — the derived set moved",
	);

	// 데몬 존은 노드 셋이 저마다 판정을 내는 자리 — 존이 켜지면 그 셋이 하나로 접힌 것임.
	const daemonNodes = getRenderedBound((await getRingProbe()).rendered, BOUND_DAEMON);
	assert.ok(
		daemonNodes.length > 0,
		`fixture precondition: the map must draw ${BOUND_DAEMON} nodes — the daemon-zone leg is vacuous without them`,
	);
});

/**
 * AC-B2-3e — health 폴링만 도착하고 캔버스 재렌더가 없는 상황에서 링이 갱신됨.
 * 폴링 한 틱을 실제로 기다림(HEALTH_POLL_MS).
 * 수동 Refresh 로 대신하면 live 응답까지 다시 와 데몬 원천의 참조가 바뀜.
 * 그러면 부품 tone 이 효과 deps 에 없어도 초록이 되어 재는 것이 사라짐.
 * SVG 노드 동일성을 함께 잼 — 재렌더가 끼면 '재렌더 없이' 라는 전제 자체가 무너짐.
 */
test("AC-B2-3e a health poll with no canvas re-render repaints the zone ring", async () => {
	const pgZone = ZONE_REPRESENTED_PART_ZONE.pg;
	await openMapWithHealth(getHealthFixture());
	await assertZoneRing(await getZoneRingProbe(), pgZone, ZONE_RING_OK_CLASS, "--ok");

	const svgIdBefore = await getCanvasSvgId();
	const pollsBefore = getHealthCounts()[PG_HEALTH_PATH] || 0;

	// 라우트가 요청마다 이 모듈 변수를 읽으므로, 화면을 다시 세우지 않고 응답만 갈아끼움.
	healthFixture = getHealthFixture({ pg: { status: "degraded", db: "closed", browser: "ok" } });
	assert.equal(
		await waitForHealthPoll(PG_HEALTH_PATH, pollsBefore + 1),
		true,
		`the 60s health poll must re-request ${PG_HEALTH_PATH} — without a second arrival the repaint is untested`,
	);

	const probe = await waitForZoneRing(pgZone, ZONE_RING_CRIT_CLASS);
	assert.equal(
		await getCanvasSvgId(),
		svgIdBefore,
		"the canvas must not have re-rendered — a re-render repaints the ring for the wrong reason",
	);
	await assertZoneRing(probe, pgZone, ZONE_RING_CRIT_CLASS, "--crit");
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


// ── P0-2 ELK 증명 (clauded-docs/26410 §7) ──────────────────────────────────────
// 화면이 실제로 그린 캔버스를 재는 것이 요점 — 같은 소스를 옆에서 다시 렌더하면
// 지시자가 화면 경로를 통과했는지는 못 잰다.

function getCanvasProbe(): Promise<RenderProbe> {
	return getProbe(page, selectors.canvas, "canonical map canvas");
}

// 대조군 — 같은 소스에 layout opt-out 지시자 한 줄만 앞세운 것. 테마·간격·라벨은 공유 설정에서
// 그대로 오므로(지시자는 설정과 깊은 병합) 남는 차이가 레이아웃 엔진뿐이다
// (테마를 함께 잃으면 노드 크기가 달라져 좌표 차이가 공허해짐).
function getLayoutControl(id: string, layout: string): Promise<RenderProbe> {
	assert.equal(
		CANONICAL_MAP.mermaid_drawn.includes("%%{init"),
		false,
		"canonical mermaid_drawn must carry no %%{init}%% directive — the layout comes from the shared config",
	);
	return getRenderProbe(page, id, `%%{init: {"layout": "${layout}"}}%%\n${CANONICAL_MAP.mermaid_drawn}`);
}

test("P0-2 the map canvas is laid out by ELK, not by the silent dagre fallback", async () => {
	await openMap(getLiveFixture());
	// 전제 먼저 — logLevel 이 3 을 넘으면 아래 경고 단언 전부가 공허해짐.
	await assertFallbackWarningVisible(page);

	const canvas = await getCanvasProbe();
	const control = await getLayoutControl("d52-layout-control", "dagre");

	assertLayoutsDiffer(canvas, control);
});

test("P0-2 every canvas edge is axis-aligned while the dagre control is not", async () => {
	await openMap(getLiveFixture());
	const canvas = await getCanvasProbe();

	assertOrthogonalLinks(canvas.links, "canonical map canvas");

	// 대조군은 대각을 실제로 가졌음을 양성으로 세워야 한다.
	// 파싱 실패를 "직교 아님" 으로 세면 dagre 가 C 를 그린다는 사실만으로 초록이 되고, 대각 0 개와 구별되지 않는다.
	const control = await getLayoutControl("d52-orthogonality-control", "dagre");
	const controlDiagonals = findDiagonalSegments(control.links, "layout control");
	assert.ok(
		controlDiagonals.length > 0,
		`the dagre control drew no diagonal segment — the verdict discriminates nothing (links: ${control.links.join(" | ")})`,
	);
	// 같은 규칙을 캔버스에 그대로 돌려 반대 판정을 받는다 — 대조군의 대각이 규칙의 산물이 아님을 잠근다.
	assert.deepStrictEqual(
		findDiagonalSegments(canvas.links, "canonical map canvas"),
		[],
		`canvas carries diagonal segments under the same rule that counted ${controlDiagonals.length} in the dagre control`,
	);
});

test("P0-2 the canvas logs no layout fallback, and this harness would catch one", async () => {
	await openMap(getLiveFixture());
	assert.deepStrictEqual(
		elkWatch.messages,
		[],
		"mermaid logged a layout fallback — the map rendered on dagre while asking for ELK",
	);

	// 감시기 반증 — 이 하네스에서 실제로 잡히는지 재지 않으면 위 0건은 문자열이 영영 안 맞아도 초록임.
	await getLayoutControl("d52-unregistered-control", "no-such-layout");
	assert.ok(
		elkWatch.messages.length > 0,
		"an unregistered layout produced no captured warning — the watch certifies nothing",
	);
	elkWatch.clear();
});

// 벤더 번들은 두 번째 mermaid 런타임(mermaid.core 11.17.0, startOnLoad 기본 참)을 통째로 안고 있다 —
// 사이드카 embedded 목록과 번들 안 version 문자열이 근거. 정적 판독으로는 그 사본의 load 훅이 실제로
// 발화하는지 가릴 수 없어서, 화면이 뜬 상태의 관측으로 가른다.
//
// 실측(이 하네스에서 잰 값): 플러그인의 지연 임포트 render 청크가 평가된 뒤에 load 를 인위로 다시 쏘면
// 심어 둔 <div class="mermaid"> 가 실제로 렌더된다. 그때 CDN 인스턴스의 contentLoaded 는 한 번도 불리지
// 않으므로(래핑해서 0회 확인) 그린 쪽은 임베드 사본이다. 생산 경로에서 잠잠한 이유는 순서 하나뿐이다:
// 그 청크는 첫 ELK 레이아웃 중에 평가되고, 문서의 유일한 자연 load 는 그보다 먼저 지나간다. 그래서 아래는
// 인위 이벤트를 쏘지 않고 생산 수명주기 그대로를 잰다.
// Phase 1 이 이 번들을 지연 로드로 돌리면 다이어그램 없는 경로에서는 사본 자체가 사라진다 — 그게 구조적
// 보장이고, 그 전까지는 이 관측이 유일한 근거다.
test("P0-2 the embedded second mermaid runtime owns no global and renders nothing", async () => {
	await openMap(getLiveFixture());

	const probe = await page.evaluate(async () => {
		const w = window as never as {
			mermaid: {
				initialize: (config: unknown) => void;
				contentLoaded: () => Promise<void> | void;
				mermaidAPI?: { getConfig?: () => Record<string, unknown> };
			};
			__esbuild_esm_mermaid_nm?: { mermaid?: unknown };
		};

		const config = w.mermaid.mermaidAPI?.getConfig?.() ?? {};
		const observed = {
			elkGlobals: Object.keys(window).filter((key) => /layoutelk/i.test(key)),
			embeddedIsPageMermaid: w.__esbuild_esm_mermaid_nm?.mermaid === w.mermaid,
			securityLevel: config.securityLevel ?? null,
			startOnLoad: config.startOnLoad ?? null,
			autoRendered: document.querySelectorAll(".mermaid[data-processed]").length,
		};

		// 검출기 반증 — 진짜 auto-render 를 한 번 일으켜 같은 셀렉터가 잡는지 잰다. 이게 없으면 위 0건은
		// 셀렉터가 영영 안 맞아도 초록이다. data-processed 는 어느 사본이 그리든 같은 렌더 경로가 찍는다.
		const planted = document.createElement("div");
		planted.className = "mermaid";
		planted.textContent = "graph TD; Z-->Y";
		document.body.appendChild(planted);
		w.mermaid.initialize({ startOnLoad: true });
		await w.mermaid.contentLoaded();
		await new Promise((resolve) => setTimeout(resolve, 800));

		return {
			...observed,
			detectorCatches: document.querySelectorAll(".mermaid[data-processed]").length,
		};
	});

	// 전역은 플러그인 하나뿐 — esbuild --global-name 이 심는 이름이 정확히 하나여야 한다.
	assert.deepStrictEqual(
		probe.elkGlobals,
		["mermaidLayoutElk"],
		`expected exactly one ELK plugin global, got: ${probe.elkGlobals.join(", ")}`,
	);
	// 페이지의 mermaid 는 index.html 이 설정한 CDN 인스턴스다. CDN UMD 는 버전 문자열을 노출하지 않아
	// (window.mermaid.version 은 undefined) 버전으로는 못 가른다 — 대신 설정값이 index.html 것임을 재고,
	// 임베드 네임스페이스와 동일 객체가 아님을 함께 잠근다.
	assert.equal(probe.embeddedIsPageMermaid, false, "the embedded mermaid copy became window.mermaid");
	assert.equal(probe.securityLevel, "antiscript", "window.mermaid does not carry the config index.html initialized");
	assert.equal(probe.startOnLoad, false, "window.mermaid does not carry the config index.html initialized");
	// 생산 수명주기에서는 임베드 사본의 startOnLoad 경로가 아무것도 그리지 않는다.
	assert.equal(
		probe.autoRendered,
		0,
		"something auto-rendered a .mermaid element on the map route — the embedded copy's startOnLoad hook fired",
	);
	assert.ok(
		probe.detectorCatches > 0,
		"a deliberate auto-render was not caught by the same selector — the zero above certifies nothing",
	);
});

// ── P0-2 fix: 세 톤 분리 · 둥근 모서리 · 라벨 클리핑 (사용자 판정 3건) ──────────
// 색 판정은 문자열 비교가 아니라 상대휘도 대비로 함 — "값이 서로 다르다" 는 1 단위
// 차이도 만족시키므로, 사용자가 본 "구분되지 않는 검정 셋" 을 반증하지 못한다.

// 노드 fill : 존 fill — 박스가 존 위로 떠올라 보이는 최소 단차.
const ZONE_TONE_MIN = 1.3;
// 노드 stroke : 자기 fill — 테두리가 면에서 떨어져 보이는 최소 단차.
const EDGE_TONE_MIN = 1.5;
// 존 stroke : 캔버스 — 존을 캔버스에서 떼어내는 일은 테두리가 한다(독트린상 면은 2%, 선은 10%).
const ZONE_EDGE_TONE_MIN = 1.5;
// 존 fill : 캔버스 — 면은 은근해야 하므로 "다르다" 보다 약간 위, 단차 요구는 stroke 쪽에 둠.
const ZONE_FILL_TONE_MIN = 1.05;
// 업스트림 독트린 r=8 의 하한.
const CORNER_RADIUS_MIN = 6;
// 라벨 넘침 허용 오차(px).
const LABEL_OVERFLOW_TOLERANCE = 0.5;
// 존 rect 상단 → 제목 상단, 제목 하단 → 첫 노드 상단 (SVG 사용자 단위).
const TITLE_TOP_MIN = 6;
const TITLE_GAP_MIN = 12;

interface ProbeRect {
	top: number;
	right: number;
	bottom: number;
	left: number;
	width: number;
	height: number;
}

interface NodeVisual {
	text: string;
	fill: string;
	stroke: string;
	rxAttr: string | null;
	rxComputed: string;
	foRect: ProbeRect | null;
	foAttrWidth: number;
	labelRangeRect: ProbeRect | null;
	fontSize: string;
	fontWeight: string;
	fontFamily: string;
	// 이 요소에 실제로 걸린 확대율. 루트 <svg> 의 CTM 은 1 로 나온다 — svg-pan-zoom 이
	// viewBox 대신 내부 <g> 변환을 쓰므로 확대율은 요소 자신의 화면 CTM 에서만 읽힌다.
	scale: number;
}

interface ClusterVisual {
	text: string;
	fill: string;
	stroke: string;
	rxAttr: string | null;
	rxComputed: string;
	rectBox: ProbeRect | null;
	labelBox: ProbeRect | null;
	firstNodeTop: number | null;
	scale: number;
}

interface VisualProbe {
	canvasBg: string;
	nodes: NodeVisual[];
	clusters: ClusterVisual[];
}

// 화면이 실제로 그린 캔버스 한 장에서 색·모서리·라벨 상자를 한 번에 걷어옴.
// 페이지 안에서는 이름 붙은 함수를 쓰지 않는다 — 번들러의 keepNames 가 주입하는
// __name 심볼이 페이지에 없어 evaluate 가 통째로 죽는다.
async function getVisualProbe(): Promise<VisualProbe> {
	return await page.evaluate((canvas) => {
		const root = document.querySelector(canvas) as HTMLElement;
		const svg = root.querySelector("svg") as SVGSVGElement;
		const nodeEls = Array.from(svg.querySelectorAll("g.node"));
		const nodes = nodeEls.map((g) => {
			const rect = g.querySelector("rect") as SVGRectElement | null;
			const fo = g.querySelector("foreignObject") as SVGForeignObjectElement | null;
			const label = g.querySelector(".nodeLabel") as HTMLElement | null;
			let labelRangeRect: DOMRect | null = null;
			if (label) {
				const range = document.createRange();
				range.selectNodeContents(label);
				labelRangeRect = range.getBoundingClientRect();
			}
			const rcs = rect ? (getComputedStyle(rect) as unknown as Record<string, string>) : null;
			const lcs = label ? getComputedStyle(label) : null;
			return {
				text: (g.textContent || "").trim(),
				fill: rcs ? rcs.fill : "",
				stroke: rcs ? rcs.stroke : "",
				rxAttr: rect ? rect.getAttribute("rx") : null,
				rxComputed: rcs ? rcs.rx : "",
				foRect: fo ? (fo.getBoundingClientRect().toJSON() as ProbeRect) : null,
				foAttrWidth: fo ? Number(fo.getAttribute("width")) : Number.NaN,
				labelRangeRect: labelRangeRect ? (labelRangeRect.toJSON() as ProbeRect) : null,
				fontSize: lcs ? lcs.fontSize : "",
				fontWeight: lcs ? lcs.fontWeight : "",
				fontFamily: lcs ? lcs.fontFamily : "",
				scale: fo ? (fo.getScreenCTM()?.a ?? Number.NaN) : Number.NaN,
			};
		});
		const nodeBoxes = nodeEls
			.map((g) => (g.querySelector("rect") as SVGRectElement | null)?.getBoundingClientRect())
			.filter((box): box is DOMRect => box !== undefined);
		const clusters = Array.from(svg.querySelectorAll("g.cluster")).map((g) => {
			const rect = g.querySelector("rect") as SVGRectElement | null;
			const label = g.querySelector("foreignObject") as SVGForeignObjectElement | null;
			const rcs = rect ? (getComputedStyle(rect) as unknown as Record<string, string>) : null;
			const box = rect ? rect.getBoundingClientRect() : null;
			// 존은 노드의 DOM 조상이 아니라 형제이므로 포함 관계는 기하로만 판정된다.
			let firstNodeTop: number | null = null;
			if (box) {
				for (const nb of nodeBoxes) {
					if (nb.left >= box.left && nb.right <= box.right && nb.top >= box.top && nb.bottom <= box.bottom) {
						if (firstNodeTop === null || nb.top < firstNodeTop) firstNodeTop = nb.top;
					}
				}
			}
			return {
				text: (g.textContent || "").trim(),
				fill: rcs ? rcs.fill : "",
				stroke: rcs ? rcs.stroke : "",
				rxAttr: rect ? rect.getAttribute("rx") : null,
				rxComputed: rcs ? rcs.rx : "",
				rectBox: box ? (box.toJSON() as ProbeRect) : null,
				labelBox: label ? (label.getBoundingClientRect().toJSON() as ProbeRect) : null,
				firstNodeTop,
				scale: rect ? (rect.getScreenCTM()?.a ?? Number.NaN) : Number.NaN,
			};
		});
		return {
			canvasBg: getComputedStyle(root).backgroundColor,
			nodes,
			clusters,
		};
	}, selectors.canvas);
}

function toKey(c: Rgba): string {
	return `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`;
}

/** rx 는 속성으로도 CSS 기하 속성으로도 설정될 수 있어 둘 다 읽고 큰 쪽을 쓴다. */
function readEffectiveRadius(rxAttr: string | null, rxComputed: string): number {
	const fromAttr = rxAttr === null ? 0 : Number.parseFloat(rxAttr);
	const fromCss = Number.parseFloat(rxComputed);
	return Math.max(Number.isFinite(fromAttr) ? fromAttr : 0, Number.isFinite(fromCss) ? fromCss : 0);
}

test("P0-2-fix the canvas, its zones and its boxes read as three separate tones", async () => {
	await openMap(getLiveFixture());
	const probe = await getVisualProbe();
	assert.ok(probe.nodes.length > 0 && probe.clusters.length > 0, "probe found no nodes or zones");

	const canvas = parseColor(probe.canvasBg);
	const clusterFills = probe.clusters.map((c) => parseColor(c.fill));
	const clusterKeys = new Set(clusterFills.map(toKey));

	// 존 면은 캔버스와 구별만 되면 됨 — 여기에 단차를 요구하면 은근해야 할 면이 밝아진다.
	const dimZoneFills = probe.clusters
		.map((c) => ({ text: c.text, fill: c.fill, ratio: contrastRatio(parseColor(c.fill), canvas) }))
		.filter((t) => t.ratio < ZONE_FILL_TONE_MIN);
	assert.deepStrictEqual(
		dimZoneFills.map((t) => `${t.text} (${t.fill}) ${t.ratio.toFixed(3)}`),
		[],
		`zone fill vs the canvas ${probe.canvasBg} below ${ZONE_FILL_TONE_MIN} — the zone surface is invisible`,
	);

	// 존을 캔버스에서 떼어내는 단차는 테두리가 진다. 반투명 stroke 는 캔버스 위에 합성한 뒤라야 대비를 말할 수 있음.
	const dimZoneEdges = probe.clusters
		.map((c) => {
			const stroke = compositeOver(parseColor(c.stroke), canvas);
			return { text: c.text, stroke: c.stroke, ratio: contrastRatio(stroke, canvas) };
		})
		.filter((t) => t.ratio < ZONE_EDGE_TONE_MIN);
	assert.deepStrictEqual(
		dimZoneEdges.map((t) => `${t.text} (${t.stroke}) ${t.ratio.toFixed(3)}`),
		[],
		`zone stroke vs the canvas ${probe.canvasBg} below ${ZONE_EDGE_TONE_MIN}`,
	);

	const nodeKeys = new Set(probe.nodes.map((n) => toKey(parseColor(n.fill))));
	const collision = [...nodeKeys].filter((k) => clusterKeys.has(k));
	assert.deepStrictEqual(
		collision,
		[],
		`node fill(s) ${collision.join(" | ")} are identical to a zone fill — those boxes have no box`,
	);
	assert.equal(
		nodeKeys.has(toKey(canvas)),
		false,
		`a node fill equals the canvas ${probe.canvasBg}`,
	);

	const zoneTone = probe.nodes.map((n) => {
		const fill = parseColor(n.fill);
		const worst = Math.min(...clusterFills.map((z) => contrastRatio(fill, z)));
		return { label: n.text, fill: n.fill, ratio: worst };
	});
	const dimBoxes = zoneTone.filter((t) => t.ratio < ZONE_TONE_MIN);
	assert.deepStrictEqual(
		dimBoxes.map((t) => `${t.label} (${t.fill}) ${t.ratio.toFixed(3)}`),
		[],
		`node fill vs zone fill below ${ZONE_TONE_MIN}`,
	);

	const edgeTone = probe.nodes.map((n) => {
		const fill = parseColor(n.fill);
		const stroke = compositeOver(parseColor(n.stroke), fill);
		return { label: n.text, stroke: n.stroke, ratio: contrastRatio(stroke, fill) };
	});
	const dimEdges = edgeTone.filter((t) => t.ratio < EDGE_TONE_MIN);
	assert.deepStrictEqual(
		dimEdges.map((t) => `${t.label} (${t.stroke}) ${t.ratio.toFixed(3)}`),
		[],
		`node stroke vs its own fill below ${EDGE_TONE_MIN}`,
	);
});

test("P0-2-fix every box and every zone is drawn with rounded corners", async () => {
	await openMap(getLiveFixture());
	const probe = await getVisualProbe();

	const square = [
		...probe.nodes.map((n) => ({
			what: `node ${n.text}`,
			r: readEffectiveRadius(n.rxAttr, n.rxComputed),
		})),
		...probe.clusters.map((c) => ({
			what: `zone ${c.text}`,
			r: readEffectiveRadius(c.rxAttr, c.rxComputed),
		})),
	].filter((x) => x.r < CORNER_RADIUS_MIN);

	assert.deepStrictEqual(
		square.map((x) => `${x.what} r=${x.r}`),
		[],
		`rect corner radius below ${CORNER_RADIUS_MIN}px`,
	);
});

test("P0-2-fix no node label overruns the box mermaid sized for it", async () => {
	await openMap(getLiveFixture());
	const probe = await getVisualProbe();

	// span 자체의 bbox 는 넘침을 보고하지 않는다(상자에 맞춰 보고됨) — 실제 글리프 런을 Range 로 잼.
	// 자명성 방지 — foreignObject 가 내용에 맞춰 커지는 상자라면 아래 비교는 항진명제다.
	const overrun = probe.nodes
		.map((n) => {
			const fo = n.foRect;
			const run = n.labelRangeRect;
			assert.ok(fo && run, `node ${n.text} rendered no foreignObject/label`);
			assert.ok(
				Math.abs(fo.width - n.foAttrWidth * n.scale) < 1,
				`node ${n.text}: foreignObject box ${fo.width.toFixed(2)}px does not match its declared width ${n.foAttrWidth} x scale ${n.scale.toFixed(4)} — the containment check would be vacuous`,
			);
			return { label: n.text, right: run.right - fo.right, bottom: run.bottom - fo.bottom };
		})
		.filter((o) => o.right > LABEL_OVERFLOW_TOLERANCE || o.bottom > LABEL_OVERFLOW_TOLERANCE);

	assert.deepStrictEqual(
		overrun.map((o) => `${o.label} right+${o.right.toFixed(2)}px bottom+${o.bottom.toFixed(2)}px`),
		[],
		"label glyph run overflows its foreignObject — the last glyph is cut",
	);
});

test("P0-2-fix labels render in the same font mermaid measured them with", async () => {
	await openMap(getLiveFixture());
	const probe = await getVisualProbe();

	// 측정 조건의 실측치 — 같은 소스를 캔버스 CSS 밖(document.body)에 렌더하면 mermaid 자신의
	// 스타일만 걸린 라벨이 나온다. 그것이 mermaid 가 상자 크기를 잰 서체다.
	await getRenderProbe(page, "d52-font-baseline", CANONICAL_MAP.mermaid_drawn);
	const baseline = await page.evaluate(() => {
		const label = document.querySelector("#probe-host-d52-font-baseline .nodeLabel") as HTMLElement | null;
		if (!label) return null;
		const cs = getComputedStyle(label);
		return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily };
	});
	assert.ok(baseline, "baseline render produced no .nodeLabel — the parity claim would be empty");

	const mismatched = probe.nodes.filter(
		(n) =>
			n.fontSize !== baseline.fontSize ||
			n.fontWeight !== baseline.fontWeight ||
			n.fontFamily !== baseline.fontFamily,
	);

	assert.deepStrictEqual(
		mismatched.map((m) => `${m.text}: ${m.fontWeight} ${m.fontSize} ${m.fontFamily}`),
		[],
		`canvas labels render in a different font than mermaid measured with (${baseline.fontWeight} ${baseline.fontSize} ${baseline.fontFamily}) — a wider run than the box it sized`,
	);
});

test("P0-2-fix zone titles clear the zone edge and the first box below", async () => {
	await openMap(getLiveFixture());
	const probe = await getVisualProbe();

	// 여백은 확대율과 무관한 주장이므로 사용자 단위로 판정하고 화면 px 은 기록만 한다.
	const crowded = probe.clusters
		.map((c) => {
			const rect = c.rectBox;
			const title = c.labelBox;
			assert.ok(rect && title, `zone ${c.text} rendered no rect/title`);
			assert.ok(c.firstNodeTop !== null, `zone ${c.text} encloses no node — the gap claim is empty`);
			return {
				zone: c.text,
				top: (title.top - rect.top) / c.scale,
				gap: (c.firstNodeTop - title.bottom) / c.scale,
			};
		})
		.filter((c) => c.top < TITLE_TOP_MIN || c.gap < TITLE_GAP_MIN);

	assert.deepStrictEqual(
		crowded.map((c) => `${c.zone} top+${c.top.toFixed(2)} gap+${c.gap.toFixed(2)}`),
		[],
		`zone title must sit >= ${TITLE_TOP_MIN} below the zone edge and >= ${TITLE_GAP_MIN} above the first box (user units)`,
	);
});

// --- T7: the map absorbs the five health responses -------------------------

// 맵이 흡수한 다섯 경로. 페이로드는 질의 문자열까지 잼 — 선택 데몬이 URL 에 실려야
// T9c 가 그 자리에서 드릴다운을 걸 수 있음.
const ABSORBED_HEALTH_PATHS = [
	"/api/health",
	"/api/health/daemons",
	"/api/health/hook-chain",
	"/api/health/daemon-payload?daemon=autoagent",
	"/api/health/hook-failures",
];

test("T7 the map requests all five health responses it absorbed", async () => {
	await openMap(getLiveFixture());
	await waitForPartVerdict("pg");
	// 앵커는 판정 넷으로 서므로 페이로드 왕복이 아직 안 끝났을 수 있음 — 기한을 두고 기다림.
	// 기한 초과는 흡수 누락으로 붉어짐(조용한 통과 없음).
	const deadline = Date.now() + 10_000;
	while (healthHits.size < ABSORBED_HEALTH_PATHS.length && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	assert.deepEqual(
		ABSORBED_HEALTH_PATHS.filter((path) => !healthHits.has(path)),
		[],
		"every health response health.jsx read must now be requested by the map itself",
	);
});

// --- B2-6a: the two always-on strips above the map are gone ----------------

// 캔버스 앞에 서 있는 상자들 — 이름이 아니라 자리로 잼. 죽은 클래스 이름으로 재지 않는 이유는
// AC-B2-5c 와 같음: 그 이름들은 원장의 것이고, 여기 다시 적으면 원장이 제 파일 밖에서 그것을 봄.
// 클래스명을 값으로 내는 것은 붉을 때 무엇이 서 있는지 메시지에 남기기 위함임.
async function getPreCanvasBoxes(): Promise<string[]> {
	return await page.evaluate(() => {
		const surface = document.querySelector(".arch-page");
		const main = document.querySelector(".arch-main");
		if (!surface || !main) return ["<the map surface did not render>"];

		const boxes: string[] = [];
		for (const el of [...surface.children]) {
			if (el === main || el.contains(main)) break;
			boxes.push(el.className || el.tagName.toLowerCase());
		}
		return boxes;
	});
}

test("AC-B2-6a no always-on fact strip stands between the page top and the map", async () => {
	await openMap(getLiveFixture());
	await waitForPartVerdict("pg");

	assert.deepEqual(
		await getPreCanvasBoxes(),
		[],
		"a strip is standing above the map again — the map's own surfaces are the canvas and the table under it",
	);

	// 계기가 그 자리를 정말 보는지 반증 — 배너 하나를 심으면 같은 계기에 잡혀야 함.
	// 없으면 위의 빈 읽기는 '아무것도 못 보는 탐침' 의 산물일 수 있음.
	await openMap(getLiveFixture({ stale: true, diffs: [getDriftDiff("B2_6A_DRIFT")] }));
	await waitForPartVerdict("pg");

	assert.equal(
		(await getPreCanvasBoxes()).length,
		1,
		"the probe must catch a box that really does stand above the map, or its empty reading proves nothing",
	);
});

// 자기개선 두 경로의 요청 횟수 사본 — 살아 있는 Map 이 아니라 스냅샷이어야 비교가 시점에 묶임.
function getQueueCounts(): Record<string, number> {
	return Object.fromEntries(queueCounts);
}

test("AC-B2-6c the map requests neither self-improvement store", async () => {
	await openMap(getLiveFixture());
	// 판정이 채워진 것을 기다림 — 행의 등장은 마운트 시점이라 앵커가 못 되고, '요청이 일어나지
	// 않았음' 은 마운트 효과가 전부 발화할 기회를 가진 뒤라야 시점 문제가 아닌 사실이 됨.
	await waitForPartVerdict("pg");

	assert.deepEqual(
		getQueueCounts(),
		{},
		"the map must read neither self-improvement store — the queue strip's fetch is gone with the strip",
	);

	// 계기가 살아 있는지 — 세지 않는 계수기 위의 0 은 아무것도 증명하지 않음.
	await page.evaluate(() => fetch("/api/improvement").then(() => undefined));

	const deadline = Date.now() + 10_000;
	while (!queueCounts.has("/api/improvement") && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	assert.deepEqual(
		getQueueCounts(),
		{ "/api/improvement": 1 },
		"the counter must catch a request that really was made, or the zero above is vacuous",
	);
});

// AC-B2-5c: 지도 아래의 화면-폭 상세 블록은 사라졌음 — 표까지 걷어낸 지금 펼칠 것은 노드 상세뿐임.
// 이름이 아니라 자리로 잼: 다른 클래스를 달고 돌아온 전역 블록도 패널 밖의 상세이므로 붉어짐.
// 죽은 토큰으로 재지 않는 이유 — 그 이름들은 원장(architecture.removal-ledger.static.test.ts)의
// 것이고, 여기 다시 적으면 원장이 제 파일 밖에서 그 이름을 보고 붉어짐.
test("AC-B2-5c the hook detail exists only inside the node panel", async () => {
	await openMapWithHealth(getHookChainFixture());
	await page.waitForSelector("svg g.node[data-arch-node-id]", { timeout: 30_000 });

	// 노드를 누르기 전 — 훅 구성은 화면 어디에도 없어야 함. 지도는 설정 덤프가 아님.
	// 컨트롤만 세는 절은 컨트롤 없이 늘 펼쳐진 채 돌아온 화면-폭 상세를 못 봄(그런 블록은
	// 컨트롤이 0 건이라 초록으로 통과함) — 그래서 내용 자체를 자리로 잼.
	assert.equal(
		await page.evaluate(() => document.querySelectorAll(".arch-hook-chain, .arch-hook-fails").length),
		0,
		"the map must render no hook configuration before a node is opened — a block standing there is the screen-wide detail returning",
	);

	await openHookHealth(HOOK_FIXTURE_EVENTS[0].groups[0].hooks[0].command);

	const detail = await page.evaluate(() => {
		const all = [...document.querySelectorAll(".arch-hook-chain, .arch-hook-fails")];
		return {
			total: all.length,
			inPanel: all.filter((el) => el.closest("[data-node-health]")).length,
		};
	});
	assert.ok(detail.total > 0, "fixture precondition: the opened hook part must render the hook detail");
	assert.equal(
		detail.total,
		detail.inPanel,
		"hook detail outside the node panel is a screen-wide block returning under the map — with a control of its own or without one",
	);

	// 패널을 닫으면 상세도 트리에서 나가야 함 — 숨긴 채 남기면 접근성 트리에 빈 영역이 남음.
	await closePanel();
	assert.equal(
		await page.evaluate(() => document.querySelectorAll(".arch-hook-chain, .arch-hook-fails").length),
		0,
		"closing the panel must take the detail out of the tree, not merely restyle it",
	);
});

// --- T11: the hook chain configuration in the hook row's expansion ---------

// hook 부품 — 명부(HEALTH_CARD_DEFS)의 id 이고, 패널의 상세 영역이 그 id 로 달림.
const HOOK_ROW_ID = "hook-chain";

// 훅 구성 픽스처 — 화면이 지어낼 수 없는 값들. 이벤트 2종 · matcher 2종 · 훅 3개.
const HOOK_FIXTURE_EVENTS: HealthHookChainResponse["events"] = [
	{
		event: "PreToolUse",
		groups: [
			{
				matcher: "Write|Edit",
				hooks: [
					{ command: "hooks/enforce-harness-critical.sh", type: "command", timeout: 5 },
					{ command: "hooks/enforce-delegation.sh", type: "command", timeout: null },
				],
			},
			{
				matcher: "Bash",
				hooks: [{ command: "hooks/advisory-raw-store-read.sh", type: "command", timeout: 3 }],
			},
		],
	},
	{ event: "SubagentStop", groups: [] },
];

const HOOK_FIXTURE_SOURCE = "/Users/fixture/.claude/settings.json";

function getHookChainFixture(): HealthFixture {
	return getHealthFixture({
		hookChain: {
			events: HOOK_FIXTURE_EVENTS,
			source_path: HOOK_FIXTURE_SOURCE,
			source_mtime: "2026-08-20T04:05:06.000Z",
		},
	});
}

async function getHookRowText(): Promise<string> {
	return await getNodeText(`[data-health-detail="${HOOK_ROW_ID}"]`);
}

// hook 부품의 노드를 열고 상세 영역 텍스트를 냄. 응답 왕복이 끝나야 채워지므로 기한을 두고
// 기다림 — 초과하면 마지막으로 읽은 텍스트를 그대로 돌려 단언이 무엇을 봤는지 메시지에 남게 함.
async function openHookHealth(needle: string): Promise<string> {
	await openPartHealth(HOOK_ROW_ID);

	const deadline = Date.now() + 15_000;
	let text = "";
	while (Date.now() < deadline) {
		text = await getHookRowText();
		if (text.includes(needle)) return text;
		await new Promise((r) => setTimeout(r, 50));
	}
	return text;
}

// 접힘/펼침을 재던 절은 접을 것과 함께 사라졌음 — 패널은 노드 하나로 이미 좁혀져 있어 접어 둘
// 비교 대상이 없음. 그 자리에 남는 계약은 '열면 서버가 준 구성이 빠짐없이 온다' 이고, '열기 전에는
// 어디에도 없다' 는 AC-B2-5c 가 자리로 잼.
test("T11 opening the hook part renders the whole configuration it was served", async () => {
	await openMapWithHealth(getHookChainFixture());

	const expanded = await openHookHealth(HOOK_FIXTURE_EVENTS[0].groups[0].hooks[0].command);
	for (const group of HOOK_FIXTURE_EVENTS[0].groups) {
		assert.ok(expanded.includes(group.matcher), `the detail must name the ${group.matcher} matcher`);
		for (const hook of group.hooks) {
			assert.ok(expanded.includes(hook.command), `the detail must name ${hook.command}`);
		}
	}
	assert.ok(expanded.includes("PreToolUse"), "the detail must name the event the hooks fire on");
	assert.ok(
		expanded.includes(HOOK_FIXTURE_SOURCE),
		"the detail must name the file the configuration was read from",
	);
});

// AC-B2-5a: 한 상세 영역이 구성과 실패 이력을 함께 냄 — 훅 신고 하나를 가르는 두 반쪽이
// 화면 두 곳에 흩어져 있으면 조작자가 그 둘을 손으로 맞춰야 함.
// 두 사실을 한 영역 안에서 잼: 각각이 어딘가에 있음이 아니라 '같은 자리에 있음' 이 계약임.
test("AC-B2-5a the hook part detail carries the configuration and the failure log together", async () => {
	await openMapWithHealth(
		{
			...getHookChainFixture(),
			hookFailures: {
				...getEmptyHookFailures(),
				count_24h: 1,
				failures: [getHookFailureEntry()],
				last_failure_ts: FAIL_WINDOW_TS,
			},
		},
	);

	const text = await openHookHealth(FAIL_HOOK_NAME);

	const group = HOOK_FIXTURE_EVENTS[0].groups[0];
	assert.ok(text.includes(group.matcher), `one detail region must carry the matcher, but it read: ${text}`);
	assert.ok(
		text.includes(group.hooks[0].command),
		`one detail region must carry the hook the matcher fires, but it read: ${text}`,
	);
	assert.ok(text.includes(FAIL_HOOK_NAME), `one detail region must carry the failing hook, but it read: ${text}`);

	// 실패 항목은 날짜를 실은 기계값이어야 함 — 표시 문장이 아니라 그 값으로 잼.
	const rowStamps = await page.evaluate(
		(id) =>
			[...document.querySelectorAll(`[data-health-detail="${id}"] [data-hook-fail-row] time`)].map(
				(el) => el.getAttribute("datetime") || "",
			),
		HOOK_ROW_ID,
	);
	assert.deepEqual(rowStamps, [FAIL_WINDOW_TS], "the same detail region must carry the dated failure entry");
});

// --- T8 · T9c: the daemon part detail carries its last failure ---------------

// 드릴다운을 옮겨 볼 둘째 데몬 — 바인딩 키여야 node_ids 가 비지 않음.
const DRILLDOWN_DAEMON = "wiki";

// 실패 픽스처의 값들 — 어느 것도 화면이 지어낼 수 없는 값임(플레이스홀더면 붉어짐).
// 사유 둘: 여러 패치에 반복된 한도 초과 서명(count > 1) + 사이클 단위 doctor 판정.
const PAYLOAD_FAIL_DATE = "2026-08-22";
const PAYLOAD_OK_DATE = "2026-08-19";
const PAYLOAD_QUOTA_MESSAGE = "haiku classify failed: quota exceeded";
const PAYLOAD_QUOTA_COUNT = 4;
// health-detail.ts 의 getDoctorFailureMessage 가 rc 를 읽어 내는 문장 그대로.
const PAYLOAD_DOCTOR_MESSAGE = "doctor verdict: fail (rc=1)";

// 실패 사이클 하나 + 정상 사이클 하나 — 둘 다 날짜를 내야 확장 영역이 '실패만' 이 아니라
// 최근 실행을 읽고 있음이 드러남.
function getFailingPayload(): Pick<HealthDaemonPayloadResponse, "entries"> {
	return {
		entries: [
			{
				run_date: PAYLOAD_FAIL_DATE,
				daemon_name: BOUND_DAEMON,
				payload: {},
				payload_size_bytes: 512,
				summary: {
					verdict: "fail",
					error_signatures: [
						{ message: PAYLOAD_QUOTA_MESSAGE, count: PAYLOAD_QUOTA_COUNT },
						{ message: PAYLOAD_DOCTOR_MESSAGE, count: 1 },
					],
				},
			},
			{
				run_date: PAYLOAD_OK_DATE,
				daemon_name: BOUND_DAEMON,
				payload: {},
				payload_size_bytes: 256,
				summary: { verdict: "ok", error_signatures: [] },
			},
		],
	};
}

interface RowExpansionProbe {
	rowFound: boolean;
	regionFound: boolean;
	regionNames: string;
	regionInsidePart: boolean;
	regionText: string;
}

// 데몬 이름 → 그 데몬을 실은 부품 id. 패널은 부품 단위이고 픽스처는 데몬 이름으로 말하므로
// 둘 사이를 옮기는 자리가 필요함. 명부(health-model.js)와 같은 짝이지만 여기서 다시 적지 않고
// 하네스가 쓰는 넷만 이름으로 고정함 — 유도하면 구현의 규칙을 되읽어 무엇을 세든 초록이 됨.
const DAEMON_PART_BY_NAME: Record<string, string> = {
	autoagent: "daemon-cycle",
	wiki: "glass-atrium-wiki-curator",
	"daily-restart-autoagent": "daily-restart-autoagent",
	"daily-restart-wiki": "daily-restart-wiki",
};

/**
 * 부품 항목에서 출발해 그 안의 상세 영역을 읽음. 표 시절에는 확장 컨트롤의 aria-controls 를
 * 되짚었으나 패널에는 접을 것이 없어 컨트롤이 없음 — 대신 영역이 제 부품 '안에' 있고 제
 * 데몬을 이름으로 실었는지를 잼. 자리와 이름을 함께 재지 않으면, 아무 데나 떠 있는 영역
 * 하나로도 단언이 통과함.
 */
async function getPanelDetailProbe(daemon: string): Promise<RowExpansionProbe> {
	return await page.evaluate((name) => {
		const row = document.querySelector(`[data-daemon-row="${name}"]`);
		const region = document.querySelector(`[data-daemon-detail="${name}"]`) as HTMLElement | null;
		return {
			rowFound: Boolean(row),
			regionFound: Boolean(region),
			regionNames: region?.getAttribute("data-daemon-detail") || "",
			regionInsidePart: Boolean(region && row && row.contains(region)),
			regionText: region ? region.innerText.replace(/\s+/g, " ").trim() : "",
		};
	}, daemon);
}

// 부품 → 그 부품을 켜는 노드를 열어 상세 패널을 세움. 표를 걷어낸 뒤로 헬스 단언은 전부 이 문을
// 지남: 명부 일곱을 한 화면에 펴던 표 대신 부품은 제 노드의 패널에서만 보임. 짝은 서버 상수에서
// 뽑음 — 하네스가 부품↔노드를 다시 적으면 바인딩이 어긋나도 두 사본이 함께 틀린 채 초록이 됨.
async function openPartHealth(partId: string): Promise<void> {
	const [nodeId] = PART_NODE_BINDINGS[partId] ?? [];
	assert.ok(nodeId, `fixture precondition: part '${partId}' binds no node, so no panel can carry it`);

	// 드로어는 모달이라 열린 채로는 오버레이가 지도의 클릭을 가로챔 — 조작자도 닫고 다시 눌러야
	// 함(표는 일곱을 한 화면에 폈으므로 그 왕복이 없었음). 하네스가 그 순서를 그대로 밟음.
	await closePanelIfOpen();

	const selector = `svg g.node[data-arch-node-id$=".${nodeId}"]`;
	await page.waitForSelector(selector, { timeout: 30_000 });
	await waitForFittedCanvas();

	await clickNodeAt(selector, `${nodeId}' for part '${partId}`);
	await page.waitForSelector(`[data-health-row="${partId}"]`, { timeout: 30_000 });
}

// 노드가 그려진 자리를 재고 그 좌표를 직접 누름 — locator.click 을 쓰지 않는 이유가 있음.
// 드라이버는 누르기 전에 대상을 시야로 끌어오려 스크롤하는데, 캔버스의 휠 확대(svg-pan-zoom,
// 기본 감도 0.1)가 그 스크롤을 확대로 읽어 배율이 틱마다 1.1 배씩 올라감. 한 번 커지면 노드는
// 더 밖으로 나가 스크롤이 다시 일어나고, 상한에 걸릴 때까지 되풀이됨
// (실측: 0.6566 → 1.7071 = 0.6566 × 1.1^10, 그 뒤 어떤 노드도 못 누름).
// 좌표로 누르면 스크롤이 아예 없고, 노드가 정말 그 자리에 그려졌는지까지 함께 재게 됨.
// 노드를 누르는 자리는 전부 이 문을 지남 — 한 곳이라도 locator.click 으로 남으면 그 한 번이
// 배율을 올려 놓고, 그 뒤의 모든 누르기가 실패함.
async function clickNodeAt(selector: string, describe: string): Promise<void> {
	let box = await readNodeBox(selector);
	// 자리를 못 잡았으면 맞춤을 한 번 되밀고 다시 잼. 배율은 재는 순간과 누르는 순간 사이에도
	// 밀릴 수 있어(부하가 높으면 자동 맞춤이 늦게 앉음) 미리 재는 것만으로는 경합이 남음.
	// 되민 뒤에도 밖이면 그때는 진짜 결함이므로 아래 단언이 붉어짐 — 자가 치유가 실패를 삼키지 않음.
	if (box && !box.inside) {
		await forceRefitCanvas();
		box = await readNodeBox(selector);
	}

	assert.ok(box, `fixture precondition: node '${describe}' and the canvas must both be in the tree`);
	assert.ok(
		box.inside,
		`node '${describe}' is drawn outside the pane, so no click can reach it — ` +
			`node ${box.node} · pane ${box.pane} · scale ${box.scale} · ${box.overlays} overlay(s) standing`,
	);

	await page.mouse.click(box.x, box.y);
}

async function readNodeBox(selector: string) {
	return await page.evaluate((sel) => {
		const el = document.querySelector(sel);
		const canvas = document.querySelector(".arch-mermaid-canvas");
		if (!el || !canvas) return null;
		const r = el.getBoundingClientRect();
		const c = canvas.getBoundingClientRect();
		const vp = canvas.querySelector(".svg-pan-zoom_viewport");
		const m = vp instanceof SVGGraphicsElement ? vp.getCTM() : null;
		return {
			x: r.left + r.width / 2,
			y: r.top + r.height / 2,
			inside:
				r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom,
			node: `${r.left.toFixed(0)},${r.top.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)}`,
			pane: `${c.left.toFixed(0)},${c.top.toFixed(0)} ${c.width.toFixed(0)}x${c.height.toFixed(0)}`,
			scale: m ? m.a.toFixed(4) : "(no transform)",
			overlays: document.querySelectorAll(".detail-overlay").length,
		};
	}, selector);
}

// 지도를 맞춤 배율에 세움. 노드가 그려진 것과 맞춤이 걸린 것은 다른 순간이고, openMap 은 SVG 가
// 나타나면 돌아오므로 그 사이에 재면 원래 배율의 자리를 재게 됨 — 그 상태에서는 지도가 pane 을
// 넘어 가장자리 노드가 아예 못 눌림(실측: 맞춤 전 1.7071 · 맞춤 후 0.6566, pane 1150x610).
// 자동 맞춤이 앉기를 기다리는 대신 화면의 맞춤 컨트롤(캔버스 포커스 + `0` = fitToView)을 눌러
// 결정적으로 세움 — 언제 앉는지에 기대지 않게 됨. 하네스가 변환행렬을 직접 쓰지는 않음:
// 그러면 제품이 그리는 자리가 아니라 하네스가 정한 자리를 재게 됨.
// 화면의 맞춤 컨트롤(캔버스 포커스 + `0` = fitToView)을 눌러 배율을 되돌림.
// 하네스가 변환행렬을 직접 쓰지는 않음: 그러면 제품이 그리는 자리가 아니라 하네스가 정한 자리를 재게 됨.
async function forceRefitCanvas(): Promise<void> {
	const canvas = page.locator(".arch-mermaid-canvas");
	if ((await canvas.count()) === 0) return;
	await canvas.focus();
	await page.keyboard.press("0");
	await page.waitForFunction(
		() => {
			const vp = document.querySelector(".arch-mermaid-canvas .svg-pan-zoom_viewport");
			const m = vp instanceof SVGGraphicsElement ? vp.getCTM() : null;
			return Boolean(m && m.a > 0 && m.a <= 1);
		},
		null,
		{ timeout: 30_000 },
	);
}

async function isCanvasFitted(): Promise<boolean> {
	return await page.evaluate(() => {
		const vp = document.querySelector(".arch-mermaid-canvas .svg-pan-zoom_viewport");
		const m = vp instanceof SVGGraphicsElement ? vp.getCTM() : null;
		return Boolean(m && m.a > 0 && m.a <= 1);
	});
}

async function waitForFittedCanvas(): Promise<void> {
	const canvas = page.locator(".arch-mermaid-canvas");
	if ((await canvas.count()) === 0) return;

	// 변환행렬이 붙기 전에는 누를 것도 없음 — svg-pan-zoom 이 붙기를 먼저 기다림.
	await page.waitForFunction(
		() => {
			const vp = document.querySelector(".arch-mermaid-canvas .svg-pan-zoom_viewport");
			const m = vp instanceof SVGGraphicsElement ? vp.getCTM() : null;
			return Boolean(m && m.a > 0);
		},
		null,
		{ timeout: 30_000 },
	);

	// 이미 맞춰져 있으면 그대로 둠 — 부품 일곱을 순회하는 절은 여기를 열네 번 지나는데, 매번
	// 포커스 + 키 + 폴링을 다시 돌리면 전체 스위트를 함께 돌릴 때 그 값이 기한을 넘겼음(실측 30.5초).
	// 여기서 놓친 밀림은 clickNodeAt 이 누르기 직전에 다시 재어 되밀음.
	if (await isCanvasFitted()) return;

	await forceRefitCanvas();

	// 화면의 상한이 1 이므로 그것을 앵커로 씀 — 안 내려오면 맞춤이 걸리지 않은 것이고,
	// 그 사실 자체가 결함이라 여기서 붉어져야 함.
	await page.waitForFunction(
		() => {
			const vp = document.querySelector(".arch-mermaid-canvas .svg-pan-zoom_viewport");
			const m = vp instanceof SVGGraphicsElement ? vp.getCTM() : null;
			return Boolean(m && m.a > 0 && m.a <= 1);
		},
		null,
		{ timeout: 30_000 },
	);
}

async function closePanelIfOpen(): Promise<void> {
	if ((await page.locator(".detail-overlay").count()) === 0) return;
	await closePanel();
}

// 데몬 부품의 노드를 엶 — 걷어낸 표에서 행 등장을 기다리던 자리. 드릴다운은 패널이 열릴 때
// 그 데몬으로 옮겨가므로(architecture.jsx handleSelectNode) 여는 것과 드릴다운이 한 동작임.
async function openDaemonHealth(daemonName: string): Promise<void> {
	const partId = DAEMON_PART_BY_NAME[daemonName];
	assert.ok(partId, `fixture precondition: no roster part carries daemon '${daemonName}'`);
	await openPartHealth(partId);
}

// 패널을 닫음 — 부품마다 노드가 다르므로 표에서 한 번에 읽던 것을 여기서는 순회로 읽음.
async function closePanel(): Promise<void> {
	await page.keyboard.press("Escape");
	// 헬스 구획이 아니라 오버레이의 사라짐을 기다림 — 헬스를 싣지 않은 노드를 연 경우
	// 구획이 애초에 없어 detached 를 영원히 기다리게 됨.
	// 기한은 파일의 다른 요소 대기와 같은 30초 — 브라우저 스위트 셋이 동시에 도는 조합 실행에서
	// 15초는 한 번 걸렸음(맵 렌더 + 맞춤이 그만큼 늦어짐). 붉게 실패하므로 위험은 flake 뿐이지만,
	// 흔들리는 스위트는 이 시험들이 내는 신호 자체를 깎음.
	await page.waitForSelector(".detail-overlay", { state: "detached", timeout: 30_000 });
}

// 부품 하나를 그 노드에서 읽어 오고 패널을 닫음.
async function readPart<T>(partId: string, read: () => Promise<T>): Promise<T> {
	await openPartHealth(partId);
	const value = await read();
	await closePanel();
	return value;
}

/**
 * 표의 네 열이 실어 나르던 사실 — 이름 · 판정 · 마지막 실행 · 바인딩. 열은 사라졌지만 사실은
 * 사라지면 안 됨(그 조용한 소실이 이 작업의 실패 형태임)이라, 표의 모양을 재던 자리가 이제
 * 사실의 이사를 잼. `nodes` 는 형태만 바뀜: 연 노드는 여는 행위가 이미 말했으므로 남은
 * 바인딩만 부르고, 1:1 부품은 낼 것이 없어 빈 문자열임.
 */
interface PartFacts {
	found: boolean;
	name: string;
	tone: string | null;
	status: string;
	lastRun: string;
	alsoLights: string;
	hasDetail: boolean;
	// 드릴다운 응답은 한 번에 한 데몬 것임 — 한 노드에 데몬 부품이 둘이면(cron) 한쪽은 상세를,
	// 다른 쪽은 그 상세를 불러오는 컨트롤을 냄. 둘 중 하나는 반드시 있어야 함.
	hasDrill: boolean;
}

async function getPartFacts(partId: string): Promise<PartFacts> {
	return await page.evaluate((id) => {
		const row = document.querySelector(`[data-health-row="${id}"]`);
		if (!row)
			return {
				found: false,
				name: "",
				tone: null,
				status: "",
				lastRun: "",
				alsoLights: "",
				hasDetail: false,
				hasDrill: false,
			};

		// 머리글이 없으므로 자리로 읽음 — 이름 · 판정 · 마지막 실행이 head 안에서 이 순서임.
		// 안쪽에 이름 붙은 함수를 두지 않음: 번들러가 keepNames 도우미(`__name`)를 끼워 넣는데
		// 그 도우미는 페이지 문맥에 없어 evaluate 가 통째로 던짐.
		const head = [...(row.querySelector(".arch-part-head")?.children || [])].map((el) =>
			(el.textContent || "").replace(/\s+/g, " ").trim(),
		);
		const also =
			[...row.children]
				.map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
				.find((t) => t.startsWith("Also lights:")) || "";

		return {
			found: true,
			name: head[0] || "",
			tone: row.getAttribute("data-health-tone"),
			status: head[1] || "",
			// 데몬 부품만 갖는 사실 — 없는 자리는 칸 자체가 없음이 정답임.
			lastRun: (head[2] || "").replace(/^Last run\s*/, ""),
			alsoLights: also.replace(/^Also lights:\s*/, ""),
			hasDetail: Boolean(row.querySelector("[data-health-detail]")),
			hasDrill: Boolean(row.querySelector(".arch-part-drill")),
		};
	}, partId);
}

// 상세 영역은 페이로드 왕복이 끝나야 채워짐 — 기한을 두고 기다리되 초과는 붉어짐.
async function waitForRegionText(daemon: string, needle: string): Promise<string> {
	const deadline = Date.now() + 15_000;
	let text = "";
	while (Date.now() < deadline) {
		text = (await getPanelDetailProbe(daemon)).regionText;
		if (text.includes(needle)) return text;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return text;
}

async function waitForHealthHit(path: string): Promise<boolean> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (healthHits.has(path)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

test("AC-T8 a daemon part's detail stands open in the panel, named by the part it belongs to", async () => {
	await openMap(getLiveFixture());
	await openDaemonHealth(BOUND_DAEMON);

	const probe = await getPanelDetailProbe(BOUND_DAEMON);
	assert.equal(probe.rowFound, true, `the panel must carry an entry for ${BOUND_DAEMON}`);
	assert.equal(
		probe.regionFound,
		true,
		"the detail region must stand open — the panel is already scoped to one node, so there is nothing to collapse it against",
	);
	assert.equal(
		probe.regionNames,
		BOUND_DAEMON,
		`the region must name the daemon it belongs to — read "${probe.regionNames}"`,
	);
	assert.ok(
		probe.regionInsidePart,
		"the region must sit inside its own part entry — a region hanging outside it belongs to no part in particular",
	);
});

/**
 * 이 작업의 지배 단언 — 표의 네 열이 나르던 사실이 전부 패널에 있는지.
 * 표가 사라지면 어느 열이 조용히 빠져도 지금 도는 어떤 테스트도 붉어지지 않음(열을 세던 계기가
 * 열과 함께 사라졌으므로). 그래서 사실 넷을 이름으로 고정해 여기서 잼:
 *   HEALTH → 이름 · Status → 판정(속성 + 글자) · Last run → 경과 판독 · Nodes → 남은 바인딩.
 * 넷째만 형태가 바뀜(연 노드는 빼고 남은 것만 부름) — 그 규칙 자체를 아래 마지막 절이 잼.
 */
test("AC-T8 the panel entry carries every fact the table's four columns named", async () => {
	await openMap(getLiveFixture(), getQueueFixture(), getRanDaemonFixture(DAEMON_RUN_TS));
	await openDaemonHealth(BOUND_DAEMON);

	const facts = await getPartFacts(DAEMON_PART_BY_NAME[BOUND_DAEMON]);
	assert.equal(facts.found, true, "fixture precondition: the panel must carry the daemon part");
	assert.equal(facts.name, BOUND_DAEMON, `HEALTH column → the entry must name the part — read "${facts.name}"`);
	assert.ok(facts.tone, `Status column → the entry must carry the verdict as an attribute — read ${facts.tone}`);
	assert.ok(
		facts.status.length > 0 && facts.status !== "—",
		`Status column → the entry must state the verdict in words too — read "${facts.status}"`,
	);
	assert.match(
		facts.lastRun,
		/^\d+[smhd] ago$/,
		`Last run column → the entry must read the served instant as an elapsed time — read "${facts.lastRun}"`,
	);

	// Nodes 열 — 연 노드는 빼고 남은 바인딩만. autoagent 는 노드 하나뿐이라 낼 것이 없음.
	assert.equal(
		facts.alsoLights,
		"",
		`Nodes column → a part bound to only the node you opened has no residual binding to name — read "${facts.alsoLights}"`,
	);
	await closePanel();

	// 반증 방향 — 응답이 노드를 더 실어 주면 그 나머지가 이름으로 나와야 함. 이 절이 없으면
	// 위의 빈 문자열은 '규칙대로 비었음' 과 '칸이 아예 없음' 을 구별하지 못함.
	await openMap(
		getLiveFixture({ part_bindings: { ...PART_NODE_BINDINGS, pg: ["pg_db", "injected_b"] } }),
	);
	await openPartHealth("pg");
	const spread = await getPartFacts("pg");
	assert.equal(
		spread.alsoLights,
		"injected_b",
		`Nodes column → the bindings other than the opened node must be named — read "${spread.alsoLights}"`,
	);
});

test("AC-T8 opening another node moves the panel to that node's parts alone", async () => {
	await openMap(getLiveFixture());
	await openDaemonHealth(BOUND_DAEMON);
	assert.equal(
		(await getPartFacts(DAEMON_PART_BY_NAME[BOUND_DAEMON])).found,
		true,
		"fixture precondition: the first node's part must stand",
	);

	// 드로어가 모달이라 다른 노드를 열려면 먼저 닫아야 함 — openPartHealth 가 그 순서를 밟음.
	await openPartHealth("hook-chain");
	assert.equal(
		(await getPartFacts(DAEMON_PART_BY_NAME[BOUND_DAEMON])).found,
		false,
		"the panel must carry only the opened node's parts — a part from the previous node is the panel keeping stale content",
	);
	assert.equal((await getPartFacts("hook-chain")).found, true, "the newly opened node's part must stand");
});

/**
 * ADR-20 — 상태 링과 포커스 표식이 아홉 노드 전부에서 실제로 보이는지. 둘은 같은 채널을 쓰므로
 * 한 시험이 함께 잼.
 *
 * 이 자리가 비어 있어서 두 결함이 초록으로 지나갔음:
 *  ① mermaid 는 classDef 를 도형의 인라인 style 로 찍고 거기에 !important 를 붙임. 인라인
 *     !important 는 스타일시트의 !important 보다 세므로 stroke 로는 이길 수 없음
 *     (focal=main_session · security=hook_pipeline · external=user).
 *  ② 선택자가 rect/polygon 만 짚어 원통(path)으로 그려지는 pg_db 를 놓쳤음.
 * 그 결과 판정을 받는 여섯 중 둘(pg_db · hook_pipeline)에 상태 링이 아예 안 떴음 — 표를 걷어낸
 * 근거("지도가 이미 상태를 보여 줌")가 그 둘에서는 거짓이었고, 포커스는 키보드가 헬스 상세로 가는
 * 유일한 길이라 안 보이는 포커스 자리는 WCAG 2.4.7 위반임.
 *
 * 노드 목록은 DOM 에서 뽑음 — 하네스가 이름을 다시 적으면 노드가 하나 늘 때 그 노드는 안 재짐.
 * 그리고 두 원인이 픽스처에 실제로 있는지를 먼저 못 박음(공허 방지): classDef 인라인
 * !important 를 단 도형이 최소 하나, rect 아닌 도형이 최소 하나 있어야 이 시험이 무언가를 잼.
 */
interface RingProbeStyle {
	id: string;
	shapeTag: string;
	inlineImportant: boolean;
	// 심은 링 사각형의 계산값 — 클래스가 붙었는지가 아니라 그 사각형이 실제로 그려지는지를 잼.
	ringDisplay: string;
	ringStroke: string;
	// 모서리 반경(표현 속성). 0 이면 각진 링 — outline 시절의 회귀가 되돌아온 것임.
	ringRadius: number;
}

// 디자인 토큰(`--accent` 등, `r g b` 3원소)을 computed 색 문자열로 — 기대색을 하네스가 다시
// 적지 않게 함. 토큰이 바뀌면 화면과 시험이 함께 따라감.
async function getTokenColour(token: string): Promise<string> {
	return await page.evaluate((name) => {
		const probe = document.createElement("span");
		probe.style.color = `rgb(var(${name}))`;
		document.body.appendChild(probe);
		const colour = getComputedStyle(probe).color;
		probe.remove();
		return colour;
	}, token);
}

// 노드 하나하나에 상태/포커스를 걸어 두고 그때의 링 사각형을 읽음.
// 값은 클래스를 떼기 전에 객체로 옮김 — getComputedStyle 은 살아 있는 선언이라, 떼고 나서 읽으면
// 원상태를 다시 재게 됨(실측으로 한 번 속았음).
async function readNodeRings(applyState: "focus" | "crit"): Promise<RingProbeStyle[]> {
	return await page.evaluate((mode) => {
		const out = [];
		for (const g of document.querySelectorAll("svg g.node[data-arch-node-id]")) {
			const el = g as SVGGElement;
			const shape = el.querySelector(
				":scope > :is(rect, polygon, path, circle, ellipse):not(.arch-ring)",
			) as SVGElement | null;
			for (const c of ["arch-node-live-ok", "arch-node-live-warn", "arch-node-live-crit"])
				el.classList.remove(c);
			if (mode === "focus") el.focus();
			else el.classList.add("arch-node-live-crit");

			const ring = el.querySelector(
				mode === "focus" ? ":scope > rect.arch-ring-focus" : ":scope > rect.arch-ring-state",
			) as SVGElement | null;
			const cs = ring ? getComputedStyle(ring) : null;
			out.push({
				id: el.getAttribute("data-arch-node-id") || "",
				shapeTag: shape ? shape.tagName : "(none)",
				// classDef 가 인라인으로 찍은 !important — 스타일시트가 이길 수 없는 채널의 표식.
				inlineImportant: /!important/i.test(shape?.getAttribute("style") || ""),
				ringDisplay: cs ? cs.display : "(no ring rect)",
				ringStroke: cs ? cs.stroke : "(no ring rect)",
				ringRadius: ring ? Number.parseFloat(ring.getAttribute("rx") || "0") : 0,
			});

			if (mode === "focus") el.blur();
			else el.classList.remove("arch-node-live-crit");
		}
		return out;
	}, applyState);
}

test("ADR-20 every node shows its focus position, whatever classDef or shape it has", async () => {
	await openMap(getLiveFixture());
	await waitForFittedCanvas();

	// 키보드 모달리티를 먼저 세움 — 프로그램 focus() 만으로는 Chromium 이 :focus-visible 을 안 물릴 수 있고,
	// 그러면 앞선 시험이 눌러 둔 키에 이 시험이 얹혀 도는 순서 의존이 됨.
	await page.keyboard.press("Tab");

	const focused = await readNodeRings("focus");
	assert.ok(focused.length > 0, "fixture precondition: the map must have imprinted nodes");
	assert.ok(
		focused.some((n) => n.inlineImportant),
		"fixture precondition: at least one node must carry a classDef inline !important, or this measures nothing",
	);
	assert.ok(
		focused.some((n) => n.shapeTag !== "rect"),
		"fixture precondition: at least one node must be drawn with a non-rect shape, or the shape half measures nothing",
	);

	const invisible = focused.filter((n) => n.ringDisplay !== "inline");
	assert.deepEqual(
		invisible.map((n) => `${n.id} (${n.shapeTag}${n.inlineImportant ? ", classDef !important" : ""})`),
		[],
		"a focused node with no visible marker is unreachable by sight — the keyboard is the only path to health detail",
	);

	// 색까지, 그것도 '우리가 정한 색' 인지 잼. 존재만 재면 이 절은 아무것도 못 잡음: 노드가
	// 포커스를 받는 순간 Chromium 이 UA 기본 포커스 링(`auto 5px rgb(0,95,204)`)을 그리므로,
	// 우리 규칙이 통째로 안 걸려도 아홉 개 모두 '표식 있음' 으로 균일하게 통과함(실측 — 종전의
	// stroke 규칙은 classDef 인라인 !important 에 막혀 네 노드에서 안 걸렸는데, 그 자리를 UA 링이
	// 덮고 있었음). 그래서 토큰에서 기대색을 읽어 대조함 — 리터럴을 적으면 토큰이 바뀔 때 갈라짐.
	const accent = await getTokenColour("--accent");
	const wrongColour = focused.filter((n) => n.ringStroke !== accent);
	assert.deepEqual(
		wrongColour.map((n) => `${n.id}: ${n.ringStroke}`),
		[],
		`every node must mark focus in the accent the screen declares (${accent}) — another colour is the browser's own ring standing in for a rule that did not apply`,
	);

	// 상태 링과 같은 반경 가족이어야 함 — 한 화면에서 굴린 표식과 각진 표식이 섞이면 둘이 다른 뜻으로 읽힘.
	const square = focused.filter((n) => !(n.ringRadius > 0));
	assert.deepEqual(
		square.map((n) => `${n.id}: rx=${n.ringRadius}`),
		[],
		"a focus marker with square corners is the outline-era regression — outline could not round, which is why the marker moved to an injected rect",
	);
});

test("ADR-20 every node can carry a state ring, whatever classDef or shape it has", async () => {
	await openMap(getLiveFixture());
	await waitForFittedCanvas();

	const unlit = await readNodeRings("crit");
	const missing = unlit.filter((n) => n.ringDisplay !== "inline");
	assert.deepEqual(
		missing.map((n) => `${n.id} (${n.shapeTag}${n.inlineImportant ? ", classDef !important" : ""})`),
		[],
		"a node whose verdict cannot be drawn breaks the reason the health table was removed — the map does not show its state",
	);

	// 판정도 '우리가 정한 색' 이어야 함 — 존재만 재면 mermaid 의 classDef 색(`.security>*` 는
	// !important 로 stroke 와 점선까지 찍음)이 대신 서 있어도 통과함. 그리고 판정 색과 포커스 색은
	// 달라야 함: 같으면 둘을 구별할 수 없음.
	const crit = await getTokenColour("--crit");
	const wrongColour = unlit.filter((n) => n.ringStroke !== crit);
	assert.deepEqual(
		wrongColour.map((n) => `${n.id}: ${n.ringStroke}`),
		[],
		`every verdict must read in the crit token the screen declares (${crit}) — another colour is not this verdict`,
	);
	assert.notEqual(
		crit,
		await getTokenColour("--accent"),
		"the verdict and the focus position must not read as the same colour",
	);

	const square = unlit.filter((n) => !(n.ringRadius > 0));
	assert.deepEqual(
		square.map((n) => `${n.id}: rx=${n.ringRadius}`),
		[],
		"a square state ring is the outline-era regression — outline squares the corners of every shape it wraps",
	);
});

// 키보드만으로 상세에 닿는지 재는 반증 케이스. 표의 행은 진짜 button 이라 탭으로 닿았음 —
// 표를 걷어내며 노드가 그 유일한 문이 됐으므로, 노드가 포커스를 못 받으면 마우스 없는
// 조작자에게서 헬스 상세가 통째로 사라짐. 그 손실은 어떤 필드 단언에도 걸리지 않음.
test("AC-T8 the keyboard alone reaches a node and opens its health detail", async () => {
	await openMap(getLiveFixture());
	const [nodeId] = PART_NODE_BINDINGS["hook-chain"];
	const selector = `svg g.node[data-arch-node-id$=".${nodeId}"]`;
	await page.waitForSelector(selector, { timeout: 30_000 });

	const affordance = await page.evaluate((sel) => {
		const nodes = [...document.querySelectorAll("svg g.node[data-arch-node-id]")];
		const target = document.querySelector(sel);
		return {
			total: nodes.length,
			focusable: nodes.filter((n) => n.getAttribute("tabindex") === "0").length,
			roled: nodes.filter((n) => n.getAttribute("role") === "button").length,
			named: nodes.filter((n) => (n.getAttribute("aria-label") || "").trim().length > 0).length,
			targetName: target?.getAttribute("aria-label") || "",
		};
	}, selector);
	assert.ok(affordance.total > 0, "fixture precondition: the map must have imprinted nodes");
	assert.deepEqual(
		{ focusable: affordance.focusable, roled: affordance.roled, named: affordance.named },
		{ focusable: affordance.total, roled: affordance.total, named: affordance.total },
		`every imprinted node must be focusable, roled and named — read ${JSON.stringify(affordance)}`,
	);
	assert.ok(affordance.targetName.length > 0, "the node must carry an accessible name, not only a tab stop");

	await page.focus(selector);
	assert.equal(
		await page.evaluate((sel) => document.activeElement === document.querySelector(sel), selector),
		true,
		"the node must actually take focus — a tabindex the browser refuses is not a keyboard path",
	);

	await page.keyboard.press("Enter");
	await page.waitForSelector('[data-health-row="hook-chain"]', { timeout: 30_000 });
	assert.equal((await getPartFacts("hook-chain")).found, true, "Enter on a focused node must open its detail");

	await closePanel();
	await page.focus(selector);
	await page.keyboard.press(" ");
	await page.waitForSelector('[data-health-row="hook-chain"]', { timeout: 30_000 });
	assert.equal((await getPartFacts("hook-chain")).found, true, "Space must open it too");
});

test("AC-T9 the expanded region names the failure date and the reason behind it", async () => {
	await openMapWithHealth(getHealthFixture({ payload: getFailingPayload() }));
	await openDaemonHealth(BOUND_DAEMON);

	const text = await waitForRegionText(BOUND_DAEMON, PAYLOAD_FAIL_DATE);
	assert.ok(
		text.includes(PAYLOAD_FAIL_DATE),
		`the region must carry the failing run's date — read "${text}"`,
	);
	assert.ok(
		text.includes(PAYLOAD_QUOTA_MESSAGE),
		`the region must carry the reason the run failed — read "${text}"`,
	);
	assert.ok(
		text.includes(PAYLOAD_DOCTOR_MESSAGE),
		"a second signature in the same run must not be dropped",
	);
	// 횟수 표기까지 잼 — 맨 숫자만 찾으면 픽스처의 어느 날짜에 우연히 그 자리가 들어와도 초록이 됨.
	assert.ok(
		text.includes(`×${PAYLOAD_QUOTA_COUNT}`),
		`a reason repeated across the cycle must carry its count, not read as a single event — read "${text}"`,
	);
	assert.ok(
		text.includes(PAYLOAD_OK_DATE),
		"a run with no signatures must still state its date — the region lists runs, not only failures",
	);
});

// 드릴다운이 연 노드를 따라가는지 재는 반증 케이스 — 고정 리터럴 구현은 여기서 붉어짐.
test("AC-T9 opening a second daemon's node drills the payload request into THAT daemon", async () => {
	await openMap(
		getLiveFixture({
			daemons: [getDaemon(BOUND_DAEMON, "ok"), getDaemon(DRILLDOWN_DAEMON, "ok")],
		}),
	);
	await page.waitForSelector("svg g.node[data-arch-node-id]", { timeout: 30_000 });
	assert.equal(
		await waitForHealthHit(`/api/health/daemon-payload?daemon=${BOUND_DAEMON}`),
		true,
		"fixture precondition: the map drills into its default daemon on mount",
	);

	await openDaemonHealth(DRILLDOWN_DAEMON);
	assert.equal(
		await waitForHealthHit(`/api/health/daemon-payload?daemon=${DRILLDOWN_DAEMON}`),
		true,
		`opening ${DRILLDOWN_DAEMON}'s node must move the drilldown — a frozen literal keeps asking for ${BOUND_DAEMON}`,
	);
});

// 부품 판정이 서 있는 네 응답 — 드릴다운은 이들을 건드리면 안 됨.
const TABLE_BACKING_PATHS = [
	"/api/health",
	"/api/health/daemons",
	"/api/health/hook-chain",
	"/api/health/hook-failures",
];

// 다섯 응답을 한 effect 에 묶고 payloadDaemon 을 그 deps 에 넣은 구현은 여기서 붉어짐:
// 노드 하나를 열면 네 응답이 함께 다시 나가고, 왕복이 끝날 때까지 PG·브라우저 판정이 빈 칸으로
// 떨어짐 — 그 넷은 드릴다운을 따라 흔들리면 안 됨. 노드를 여는 것이 곧 드릴다운이 된 지금
// (handleSelectNode) 이 절이 재는 위험은 오히려 커졌음.
test("AC-T9 opening another daemon's node re-requests the payload alone", async () => {
	await openMap(
		getLiveFixture({
			daemons: [getDaemon(BOUND_DAEMON, "ok"), getDaemon(DRILLDOWN_DAEMON, "ok")],
		}),
	);
	await page.waitForSelector("svg g.node[data-arch-node-id]", { timeout: 30_000 });
	assert.equal(
		await waitForHealthHit(`/api/health/daemon-payload?daemon=${BOUND_DAEMON}`),
		true,
		"fixture precondition: the map drills into its default daemon on mount",
	);
	// 첫 왕복이 다 앉은 뒤에 세어야 함 — 마운트분이 클릭분으로 새면 아무것도 재지 못함.
	await page.waitForTimeout(500);

	const before = getHealthCounts();
	await openDaemonHealth(DRILLDOWN_DAEMON);
	assert.equal(
		await waitForHealthHit(`/api/health/daemon-payload?daemon=${DRILLDOWN_DAEMON}`),
		true,
		"fixture precondition: the drilldown moved to the row that was expanded",
	);
	// 결함 있는 구현이 나머지 넷을 마저 보낼 시간을 줌 — 안 기다리면 경합으로 조용히 초록이 됨.
	await page.waitForTimeout(500);

	const after = getHealthCounts();
	assert.deepEqual(
		TABLE_BACKING_PATHS.filter((path) => after[path] !== before[path]),
		[],
		"opening a node must not re-fire the four responses the part verdicts stand on",
	);
});

// 못 읽은 응답과 아직 안 온 응답을 화면이 갈라 부르는지 재는 반증 케이스 — 형제 블록
// (HookChainDetail · HookFailureDetail)이 이미 그렇게 함. 둘을 한 문장으로 접은 구현은
// 끊긴 응답에도 "Loading …" 을 남겨 조작자가 기다릴지 고칠지 못 정하게 만듦.
test("AC-T9 an errored payload response says it could not be read, not that it is loading", async () => {
	await openMapWithHealth(getHealthFixture({ payloadFails: true }));
	await openDaemonHealth(BOUND_DAEMON);

	const text = await waitForRegionText(BOUND_DAEMON, "Couldn't read");
	assert.ok(
		text.includes("Couldn't read the recent runs"),
		`an errored payload response must name itself unreadable — read "${text}"`,
	);
	assert.ok(
		!text.includes("Loading recent runs"),
		`an unreadable response must not read as a slow one — read "${text}"`,
	);
});

// 반대 방향 — 진짜로 늦은 응답은 여전히 로딩으로 읽혀야 함. 에러 분기를 너무 넓게 잡아
// 응답 없음까지 '못 읽음' 으로 부르는 구현은 여기서 붉어짐.
test("AC-T9 a payload response still on its way reads as loading, not as unreadable", async () => {
	await openMap(
		getLiveFixture({
			daemons: [getDaemon(BOUND_DAEMON, "ok"), getDaemon(DRILLDOWN_DAEMON, "ok")],
		}),
		getQueueFixture(),
		getHealthFixture({ payloadDelayMs: 5_000 }),
	);
	// 아직 한 번도 응답이 오지 않은 데몬으로 드릴다운함 — 기본 데몬은 마운트분이 이미 앉았을 수 있음.
	await openDaemonHealth(DRILLDOWN_DAEMON);

	const text = await waitForRegionText(DRILLDOWN_DAEMON, "Loading recent runs");
	assert.ok(
		text.includes(`Loading recent runs for ${DRILLDOWN_DAEMON}`),
		`a pending payload must read as loading — read "${text}"`,
	);
	assert.ok(
		!text.includes("Couldn't read"),
		`a slow response must not be reported as an unreadable one — read "${text}"`,
	);
});

// --- AC-B2-4: the health table stands on the part roster ---------------------

// 확장 컨트롤을 내야 하는 행 — 데몬 넷 + Hook Chain (AC-B2-4d). 명부에서 유도하지 않고 이름으로
// 고정함: 유도하면 구현의 규칙을 그대로 되읽어 무엇을 세든 초록이 됨. 부품이 하나 늘면 여기가
// 붉어지는 것이 맞음 — 새 부품은 '펼칠 것이 있는가' 를 스스로 밝혀야 함.
const EXPANDABLE_PART_IDS = [
	"daemon-cycle",
	"glass-atrium-wiki-curator",
	"daily-restart-autoagent",
	"daily-restart-wiki",
	"hook-chain",
];

// 판정 앵커 — 항목의 '등장' 이 아니라 tone 이 붙은 것을 기다림. 항목은 부품 명부로 서므로 health
// 응답 없이도 패널을 여는 순간 그려짐: 등장을 기다리면 여는 것을 기다린 것이지 판정을 기다린 것이
// 아님. 패널이 먼저 서야 하므로 여는 것과 기다리는 것이 여기서 한 동작임.
async function waitForPartVerdict(partId: string): Promise<void> {
	await openPartHealth(partId);
	await page.waitForSelector(`[data-health-row="${partId}"][data-health-tone]`, {
		timeout: 30_000,
	});
}

async function getPartTone(partId: string): Promise<string | null> {
	return await page.evaluate((id) => {
		const row = document.querySelector(`[data-health-row="${id}"]`);
		return row ? row.getAttribute("data-health-tone") : null;
	}, partId);
}

async function getPartRowText(partId: string): Promise<string> {
	return await getNodeText(`[data-health-row="${partId}"]`);
}

// 지금 열려 있는 패널이 내는 부품 id 들.
async function getPartRowIds(): Promise<string[]> {
	return await page.evaluate(() =>
		[...document.querySelectorAll("[data-health-row]")].map(
			(row) => row.getAttribute("data-health-row") || "",
		),
	);
}

// 그려지는 노드를 전부 열어 거기서 나온 부품 id 를 모음 — 표가 한 화면에 펴던 '명부 전원'을
// 패널에서 재는 방법. 노드 목록은 화면이 실제로 각인한 것에서 뽑음: 하네스가 짝을 다시 적으면
// 지도가 부품을 잃어도 두 사본이 함께 틀린 채 초록이 됨.
async function sweepPartIdsAcrossNodes(): Promise<string[]> {
	await page.waitForSelector("svg g.node[data-arch-node-id]", { timeout: 30_000 });
	const nodeIds: string[] = await page.evaluate(() =>
		[...document.querySelectorAll("svg g.node[data-arch-node-id]")].map(
			(el) => el.getAttribute("data-arch-node-id") || "",
		),
	);

	const seen: string[] = [];
	for (const nodeId of nodeIds) {
		await closePanelIfOpen();
		await waitForFittedCanvas();
		await clickNodeAt(`svg g.node[data-arch-node-id="${nodeId}"]`, nodeId);
		// 드로어가 선 것을 기다림 — 헬스를 실은 노드만 구획을 내므로(빈 제목을 그리지 않는 것이
		// 계약임) 구획의 등장을 기다릴 수는 없고, 드로어는 어느 노드를 눌러도 서므로 그것이 앵커임.
		// 고정 sleep 을 쓰면 느린 기계에서 아직 안 선 패널을 '부품 없음' 으로 읽어 조용히 통과함.
		await page.waitForSelector(".detail-overlay", { timeout: 30_000 });
		for (const id of await getPartRowIds()) if (!seen.includes(id)) seen.push(id);
		await closePanel();
	}
	return seen;
}

// 화면이 읽는 그 명부를 브라우저 안에서 그대로 읽음 — 하네스가 id 목록을 다시 적으면
// 표가 명부를 떠나도 두 사본이 함께 틀린 채 초록이 됨.
async function getRosterPartIds(): Promise<string[]> {
	return await page.evaluate(
		() =>
			(
				window as never as { HealthModel: { HEALTH_CARD_DEFS: { id: string }[] } }
			).HealthModel.HEALTH_CARD_DEFS.map((def) => def.id),
	);
}

// 명부에서 앞의 n 항목을 덜어냄 — `HEALTH_CARD_DEFS` 는 동결되지 않은 채 참조로 내보내지므로
// 행 수가 명부를 따르는지 반증할 수 있음. 케이스마다 페이지를 다시 여므로 되돌릴 필요가 없음.
async function spliceRoster(count: number): Promise<number> {
	return await page.evaluate((n) => {
		const defs = (
			window as never as { HealthModel: { HEALTH_CARD_DEFS: { id: string }[] } }
		).HealthModel.HEALTH_CARD_DEFS;
		defs.splice(0, n);
		return defs.length;
	}, count);
}

// 수동 새로고침 — health 응답 넷이 다시 나가 새 상태 객체가 오므로 표가 명부를 다시 읽음.
async function refreshMap(): Promise<void> {
	await page.click('[aria-label="Refresh system map"]');
}

// 기한을 두고 행 수가 기대값에 닿기를 기다림 — 초과하면 마지막으로 읽은 수를 그대로 돌려
// 단언 메시지가 무엇을 봤는지 남기게 함.
async function waitForRowCount(expected: number): Promise<number> {
	const deadline = Date.now() + 15_000;
	let count = -1;
	while (Date.now() < deadline) {
		count = (await getPartRowIds()).length;
		if (count === expected) return count;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return count;
}

// 데몬 행 — 확장 컨트롤을 갖는 다섯 중 hook 행을 뺀 넷. 이 넷만 데몬 응답을 원천으로 삼음.
const DAEMON_PART_IDS = EXPANDABLE_PART_IDS.filter((id) => id !== "hook-chain");

// 항목 하나가 내는 판정 두 갈래 — tone 속성과 판정 글자. 둘을 함께 읽는 이유는 속성만 재면
// 글자로 지어낸 판정('Healthy')을 못 보고, 글자만 재면 앵커 계약이 안 걸리기 때문임.
// 데몬 넷은 서로 다른 노드에 묶여 있으므로 표에서 한 번에 읽던 것을 노드 순회로 읽음.
async function getDaemonRowVerdicts(): Promise<{ id: string; tone: string | null; status: string }[]> {
	const out: { id: string; tone: string | null; status: string }[] = [];
	for (const id of DAEMON_PART_IDS) {
		const facts = await readPart(id, () => getPartFacts(id));
		out.push({
			id,
			// 항목 자체가 안 선 경우와 판정이 없는 경우를 갈라 부름 — 둘 다 null 로 접으면
			// 픽스처 붕괴가 결함으로 읽힘.
			tone: facts.found ? facts.tone : "<the part did not render>",
			status: facts.found ? facts.status : "<the part did not render>",
		});
	}
	return out;
}

// 끊긴 health 저장소를 부르는 경보 — 이름·자리·복구 컨트롤을 함께 읽음.
// 셋을 따로 재면 '경보는 떴는데 되돌릴 길이 없음' 이나 '노드를 눌러야 보임' 이 초록으로 지나감.
// 경보는 표 안에 서 있었고 표가 사라지며 페이지로 올라왔음 — `onPage` 가 그 이사를 잼.
async function getStoreAlerts(): Promise<
	{ text: string; onPage: boolean; inPanel: boolean; retries: number }[]
> {
	return await page.evaluate(() =>
		[...document.querySelectorAll('[role="alert"]')]
			.filter((el) => (el.textContent || "").includes("system health"))
			.map((el) => ({
				text: (el.textContent || "").replace(/\s+/g, " ").trim(),
				onPage: Boolean(el.closest(".arch-health-alert-wrap")),
				// 패널 안에 서면 노드를 눌러야 보임 — 헬스를 통째로 못 읽었다는 사실이
				// 클릭 뒤에 숨는 것이 이 절이 막는 결함임.
				inPanel: Boolean(el.closest("[data-node-health]")),
				retries: el.querySelectorAll("button").length,
			})),
	);
}

test("AC-B2-6b a health store that failed is named by an alert standing on the page", async () => {
	await openMapWithHealth(getHealthFixture({ failedStores: ["health"] }));
	// 끊긴 저장소의 부품은 tone 을 못 받으므로 판정 앵커를 쓸 수 없음 — 경보 자체를 기다림.
	// 부재는 아래 단언이 문장으로 보고함(여기서 던지면 붉은 이유가 타임아웃으로 바뀜).
	await page.waitForSelector(".arch-health-alert-wrap .arch-queue-error", { timeout: 15_000 }).then(
		() => true,
		() => false,
	);

	const alerts = await getStoreAlerts();
	assert.equal(
		alerts.length,
		1,
		`a failed health store must raise exactly one alert — read ${alerts.length}`,
	);
	assert.deepEqual(
		{
			onPage: alerts[0].onPage,
			inPanel: alerts[0].inPanel,
			namesStore: alerts[0].text.includes("PostgreSQL"),
			retries: alerts[0].retries,
		},
		{ onPage: true, inPanel: false, namesStore: true, retries: 1 },
		`the alert must name the store that failed, stand on the page where no click is needed to find it, and carry a way back — read: "${alerts[0].text}"`,
	);

	// 실패 표면이 성공 경로로 새지 않음 — 다섯이 모두 답하면 경보가 없어야 함.
	await openMap(getLiveFixture());
	await waitForPartVerdict("pg");
	assert.deepEqual(
		await getStoreAlerts(),
		[],
		"every store answered, so an alert here would call a live store dead",
	);
});

test("AC-B2-6f a daemon part with no response carries no verdict, never a fabricated one", async () => {
	await openMapWithHealth(getHealthFixture({ failedStores: ["daemons"] }));
	// 데몬 응답만 끊었으므로 PG 부품은 판정을 받음 — 패널이 실제로 섰음을 그 앵커로 확인함.
	await waitForPartVerdict("pg");
	await closePanel();

	const unread = await getDaemonRowVerdicts();
	assert.deepEqual(
		unread.filter((row) => row.tone !== null || row.status !== "—"),
		[],
		"a daemon part whose response never arrived must carry no tone and no status word — either one is an invented verdict",
	);

	// 대조군 — 응답이 오면 같은 넷이 판정을 실음. 없으면 위 절은 '항목이 없어서' 초록일 수 있음.
	await openMap(getLiveFixture());
	await waitForPartVerdict("daemon-cycle");
	await closePanel();

	const read = await getDaemonRowVerdicts();
	assert.deepEqual(
		read.filter((row) => row.tone === null),
		[],
		"the daemon parts must carry a tone once the response arrives, or the reading above measured absent entries",
	);
});

/**
 * 표가 명부 전원을 한 화면에 펴던 자리를 패널이 대신함 — 그런데 패널은 연 노드의 부품만 냄.
 * 그래서 '전원이 여전히 닿는가' 를 화면 한 장이 아니라 노드 순회로 잼: 그려지는 노드를 전부 열어
 * 나온 부품의 합집합이 명부와 같아야 함. 어느 부품이 그려지지 않는 노드 뒤에 숨는 순간 이 절이
 * 붉어지고, 그 상황 자체는 바인딩 계기(architecture.health-binding AC-B2-2a/2b)가 따로 막음.
 */
test("AC-B2-4a every roster part is reachable by opening its node", async () => {
	await openMap(getLiveFixture());

	const roster = await getRosterPartIds();
	assert.equal(
		roster.length,
		HEALTH_EXPECTED_TOTAL,
		`fixture precondition: the shared roster must carry ${HEALTH_EXPECTED_TOTAL} parts`,
	);

	const reached = await sweepPartIdsAcrossNodes();
	assert.deepEqual(
		[...reached].sort(),
		[...roster].sort(),
		"opening every drawn node must reach every roster part — a part reachable nowhere is one the map no longer states",
	);

	assert.match(
		(await readPart("pg", () => getPartFacts("pg"))).name,
		/PostgreSQL/,
		"the PostgreSQL part must stand as an entry of its own, named",
	);
});

test("AC-B2-4b the entries follow the roster, and an empty roster leaves none", async () => {
	await openMap(getLiveFixture());
	await waitForPartVerdict("pg");
	assert.deepEqual(
		await getPartRowIds(),
		["pg"],
		"fixture precondition: the pg node carries exactly its own part",
	);
	await closePanel();

	// 명부에서 pg 를 덜어냄 — 같은 노드를 열어도 낼 부품이 없으므로 구획 자체가 서지 않아야 함.
	await spliceRoster(1);
	await refreshMap();
	const [pgNode] = PART_NODE_BINDINGS.pg;
	await closePanelIfOpen();
	await waitForFittedCanvas();
	await clickNodeAt(`svg g.node[data-arch-node-id$=".${pgNode}"]`, pgNode);
	assert.equal(
		await waitForRowCount(0),
		0,
		"dropping a part must drop its entry — a surviving entry is the map stating a part its source no longer states",
	);
	assert.equal(
		await page.evaluate(() => document.querySelectorAll("[data-node-health]").length),
		0,
		"a node with no roster part left must render no health section at all — an empty heading claims a verdict is missing",
	);
});

test("AC-B2-4c an unreachable database turns the PostgreSQL entry, not only the strip", async () => {
	await openMapWithHealth(
		getHealthFixture({ pg: { status: "degraded", db: "closed", browser: "ok" } }),
	);
	await waitForPartVerdict("pg");

	assert.equal(
		await getPartTone("pg"),
		"crit",
		"an unreachable database must turn its own entry crit — a verdict that lives only in the strip dies with the strip",
	);
	// 색만으로 판정을 말하면 색을 못 읽는 조작자와 하네스가 같은 문장을 못 읽음.
	const text = await getPartRowText("pg");
	assert.match(text, /PostgreSQL/, `the entry must name the part it judges — read "${text}"`);
	assert.match(text, /\bDown\b/, `the entry must state the verdict in words — read "${text}"`);
});

// 확장 컨트롤은 접을 것과 함께 사라졌음 — 남은 계약은 '읽을 것이 있는 부품만 상세를 낸다' 이고,
// 그것이 원래 그 컨트롤이 지키던 약속임(빈 영역을 여는 자리는 읽을 것이 있다고 거짓말함).
// 다만 한 노드에 데몬 부품이 둘이면(cron) 드릴다운 응답이 한 데몬 것뿐이라 한쪽은 상세를,
// 다른 쪽은 그것을 불러오는 컨트롤을 냄 — 둘 다 '읽을 것이 있음' 이므로 함께 셈. 그 대신
// '같은 노드에서 상세는 한 번에 하나' 를 아래 마지막 절이 따로 못 박음.
test("AC-B2-4d only a part with something to show offers a detail or a way to load one", async () => {
	await openMap(getLiveFixture(), getQueueFixture(), getHookChainFixture());

	const offering: string[] = [];
	for (const partId of await getRosterPartIds()) {
		const facts = await readPart(partId, () => getPartFacts(partId));
		assert.equal(facts.found, true, `fixture precondition: part '${partId}' must stand in its node's panel`);
		if (facts.hasDetail || facts.hasDrill) offering.push(partId);
	}

	assert.ok(
		!offering.includes("browser"),
		"the Chromium export part opens onto nothing — a region or a control there promises a detail that does not exist",
	);
	assert.deepEqual(
		[...offering].sort(),
		[...EXPANDABLE_PART_IDS].sort(),
		"exactly the four daemon parts and the hook chain part have something to show — nothing else does",
	);

	// 한 노드에 묶인 데몬 부품 둘 — 상세는 한쪽에만, 컨트롤은 다른 쪽에만. 둘 다 상세를 그리면
	// 한 데몬의 실행 목록이 다른 데몬의 것으로 읽히고, 둘 다 컨트롤이면 열자마자 비어 있음.
	const shared = ["daily-restart-autoagent", "daily-restart-wiki"];
	await openPartHealth(shared[0]);
	const both = [await getPartFacts(shared[0]), await getPartFacts(shared[1])];
	assert.deepEqual(
		both.map((f) => f.hasDetail),
		[true, false],
		"two daemon parts on one node must not both render a detail — the payload response carries one daemon",
	);
	assert.deepEqual(
		both.map((f) => f.hasDrill),
		[false, true],
		"the part whose runs are not loaded must carry the control that loads them, or its log is unreachable",
	);

	// 그 컨트롤을 누르면 드릴다운이 옮겨가고 둘의 역할이 맞바뀜.
	await page.click(`[data-health-row="${shared[1]}"] .arch-part-drill`);
	await page.waitForSelector(`[data-health-row="${shared[1]}"] [data-health-detail]`, { timeout: 30_000 });
	const swapped = [await getPartFacts(shared[0]), await getPartFacts(shared[1])];
	assert.deepEqual(
		swapped.map((f) => f.hasDetail),
		[false, true],
		"pressing the control must move the drilldown to that daemon, not add a second one",
	);
});

test("AC-B2-4e the Chromium export entry's tone follows the launch probe through all three of its values", async () => {
	await openMap(getLiveFixture());
	await waitForPartVerdict("browser");
	assert.equal(await getPartTone("browser"), "ok", "a launching browser must read ok");

	await openMapWithHealth(
		getHealthFixture({ pg: { status: "ok", db: "open", browser: "failed" } }),
	);
	await waitForPartVerdict("browser");
	assert.equal(
		await getPartTone("browser"),
		"crit",
		"a browser that cannot launch must read crit — every HTML export is failing",
	);

	// 미프로브는 실패가 아님 — 정상으로 꾸미지도, 장애로 부르지도 않는 셋째 값.
	await openMapWithHealth(
		getHealthFixture({ pg: { status: "ok", db: "open", browser: "unprobed" } }),
	);
	await waitForPartVerdict("browser");
	assert.equal(
		await getPartTone("browser"),
		"info",
		"an unprobed browser must read info — calling it a failure invents a verdict the probe never gave",
	);
	assert.deepEqual(
		await page.evaluate(() =>
			[...document.querySelectorAll('[data-health-row][data-health-tone="crit"]')].map(
				(row) => row.getAttribute("data-health-row") || "",
			),
		),
		[],
		"an unprobed browser must leave no entry in crit",
	);
});

// --- B2-4 / B2-5 guards: what the two moved columns read ---------------------

// B2-4 는 Nodes 열의 원천을 /live 의 `daemons[].node_ids` 에서 같은 응답의 `part_bindings` 로
// 옮겼고, 이번 작업은 그 열을 통째로 패널의 'Also lights' 로 옮겼음. 옮긴 자리에 값을 재는 단언이
// 없으면 두 이사 모두 조용히 빈 칸으로 떨어질 수 있음 — 아래 두 절은 서로 다른 결함을 잡음:
// 1절은 응답이 준 값을 그대로 싣는지, 2절은 그 값을 정말 응답에서 읽는지(제 사본이 아닌지).
//
// 형태가 하나 바뀐 것을 여기 못 박음: 패널은 '연 노드를 뺀 나머지' 만 부름. 연 노드는 패널을
// 여는 행위가 이미 말했으므로 다시 부르면 같은 사실이 두 번 서고, 1:1 부품은 낼 것이 없어 빔.
// 그 규칙 자체는 AC-T8 의 필드 이사 단언이 양방향으로 잼.

// 부품 id → 그 부품의 남은 바인딩 글(패널을 열어 읽음).
async function getAlsoLightsByPart(): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const partId of await getRosterPartIds()) {
		out[partId] = (await readPart(partId, () => getPartFacts(partId))).alsoLights;
	}
	return out;
}

test("B2-4 guard the residual bindings come from the served part_bindings, not a map-local copy", async () => {
	await openMap(getLiveFixture());

	// 기대값은 서버 상수에서 뽑음 — 하네스가 목록을 다시 적으면 두 사본이 함께 틀린 채 초록이 됨.
	// 연 노드를 뺀 나머지가 기대값이고, 오늘 일곱 부품은 모두 노드 하나에만 묶여 있으므로 전부 빔.
	const roster = await getRosterPartIds();
	assert.equal(
		roster.length,
		HEALTH_EXPECTED_TOTAL,
		`fixture precondition: the shared roster must carry ${HEALTH_EXPECTED_TOTAL} parts`,
	);
	const expected = Object.fromEntries(
		roster.map((id): [string, string] => [id, (PART_NODE_BINDINGS[id] ?? []).slice(1).join(", ")]),
	);
	assert.deepEqual(
		await getAlsoLightsByPart(),
		expected,
		"the residual binding of every part must follow the table the response served",
	);

	// 2절 — 응답을 갈아끼우면 글이 따라가야 함. 1절은 오늘의 기대값이 전부 빈 문자열이라
	// 아무것도 그리지 않는 구현으로도 통과하므로, 응답만 아는 값을 심어야 원천이 어디인지가 갈림.
	await openMap(
		getLiveFixture({
			part_bindings: { ...PART_NODE_BINDINGS, pg: ["pg_db", "injected_a", "injected_b"] },
		}),
	);
	const injected = await readPart("pg", () => getPartFacts("pg"));
	assert.equal(
		injected.alsoLights,
		"injected_a, injected_b",
		"a re-keyed table must move the value with it — a value this response never sent is the map reading a copy of its own",
	);

	// 반대 방향 — 응답이 노드를 하나도 안 실으면 부품이 아예 닿지 않아야 함(빈 글이 아니라 부재).
	await openMap(getLiveFixture({ part_bindings: { ...PART_NODE_BINDINGS, browser: [] } }));
	const [browserNode] = PART_NODE_BINDINGS.browser;
	await closePanelIfOpen();
	await waitForFittedCanvas();
	await clickNodeAt(`svg g.node[data-arch-node-id$=".${browserNode}"]`, browserNode);
	await page.waitForTimeout(300);
	assert.equal(
		(await getPartFacts("browser")).found,
		false,
		"a part the served table no longer binds must vanish from the node it used to light, not linger there empty",
	);
});

// 응답이 실행을 실어 준 데몬 부품 — 명부에 있는 둘. 나머지 부품은 낼 실행이 없음.
const RAN_PART_IDS = ["daemon-cycle", "glass-atrium-wiki-curator"];

// 대조 순간 — 첫 절이 실은 값과 자릿수까지 떨어뜨림. 상대시각은 버킷으로 접히므로 가까운 두 값은
// 같은 글로 접혀 '움직였는가' 를 못 재게 됨.
const DAEMON_RUN_ALT_TS = "2019-03-04T05:06:07.000Z";

// 명부에 있는 두 데몬이 같은 순간을 보고하는 health 픽스처 — 절마다 그 순간만 갈아끼움.
function getRanDaemonFixture(runTs: string): HealthFixture {
	return getHealthFixture({
		daemons: HEALTH_OK_DAEMONS.map((daemon_name) => ({
			daemon_name,
			effective_status: "ok" as const,
			last_run_at: runTs,
		})),
	});
}

// 부품 id → Last run 글. 판정이 도착한 뒤에 읽음 — 실행 시각과 tone 이 같은 응답에서 오므로
// 데몬 부품의 tone 이 붙었다는 것이 그 응답이 화면에 닿았다는 뜻임.
// 실행을 갖지 않는 부품은 칸 자체가 없음이 정답이라 빈 문자열로 떨어짐(표에서는 '—' 였음).
async function getLastRunByPart(runTs: string): Promise<Record<string, string>> {
	await openMap(getLiveFixture(), getQueueFixture(), getRanDaemonFixture(runTs));
	await waitForPartVerdict(RAN_PART_IDS[0]);
	await closePanel();

	const out: Record<string, string> = {};
	for (const partId of await getRosterPartIds()) {
		out[partId] = (await readPart(partId, () => getPartFacts(partId))).lastRun;
	}
	return out;
}

// B2-4 는 Nodes 열에 두 절짜리 계기를 남겼지만 Last run 열에는 남기지 않았음. 그 칸의 '비어 있음'
// 은 부품 대부분에서 정답이라 상수를 실은 구현이 눈에 띄지 않고 통과함 — 널 검사만 남기고 값을
// 지어낸 구현(`row.lastRunAt ? "moments ago" : "—"`)은 '비어 있지 않음' 만 재는 단언 아래에서
// 초록임. 그래서 두 절로 잼: 1절은 그 값이 경과 판독으로 읽히고 보고할 실행이 없는 부품만 비어
// 있음을, 2절은 다른 순간을 실어 보내면 그 값이 따라 움직임을 잼. 상수는 2절에서 붉어짐.
test("B2-5 guard the last-run reading tracks the served instant and empties only the parts without one", async () => {
	const served = await getLastRunByPart(DAEMON_RUN_TS);
	const roster = await getRosterPartIds();
	assert.equal(
		roster.length,
		HEALTH_EXPECTED_TOTAL,
		`fixture precondition: the shared roster must carry ${HEALTH_EXPECTED_TOTAL} parts`,
	);

	for (const id of RAN_PART_IDS) {
		assert.match(
			served[id] || "",
			/^\d+[smhd] ago$/,
			`a part whose response carried a run must read it as an elapsed time, but ${id} read "${served[id]}"`,
		);
	}
	// 실행을 보고하지 않은 데몬 부품은 '—' 로 남아야 함(없음이 보여야 하는 사실임).
	// 데몬이 아닌 부품은 그 칸 자체가 없음이 정답이라 빈 문자열임 — 둘을 갈라 잼.
	for (const id of roster) {
		if (RAN_PART_IDS.includes(id)) continue;
		const expected = DAEMON_PART_IDS.includes(id) ? "—" : "";
		assert.equal(
			served[id],
			expected,
			`a part with no run to report must read ${expected === "" ? "no last-run field at all" : 'an em dash'} — ${id} read "${served[id]}"`,
		);
	}

	// 2절 — 값의 방향. 같은 부품에 다른 순간을 실어 보내면 그 글이 달라져야 함.
	const moved = await getLastRunByPart(DAEMON_RUN_ALT_TS);
	for (const id of RAN_PART_IDS) {
		assert.match(
			moved[id] || "",
			/^\d+[smhd] ago$/,
			`the second serving must read as an elapsed time too, but ${id} read "${moved[id]}"`,
		);
		assert.notEqual(
			moved[id],
			served[id],
			`${id} read "${moved[id]}" for both instants — the reading carries a map-local constant, not the run the response served`,
		);
	}
	assert.deepEqual(
		roster.filter((id) => !RAN_PART_IDS.includes(id) && moved[id] !== served[id]),
		[],
		"the parts without a run must stay unchanged across both servings",
	);
});

// --- T12c: the hook failure log, in the same hook part detail --------------

// 하네스 라우트가 내는 창 폭 — 화면이 "지난 N일" 을 응답에서 읽는지 재는 값이라 상수로 둠.
const HOOK_FAIL_WINDOW_DAYS = 30;

// 창 안 실패 한 건의 값들 — 어느 것도 화면이 지어낼 수 없음(플레이스홀더 구현이면 붉어짐).
const FAIL_WINDOW_TS = "2026-08-24T11:22:33.000Z";
const FAIL_HOOK_NAME = "track-outcome.sh";
const FAIL_TABLE = "core.outcomes";

// 창 밖 최종기록 — 30일 창보다 오래된 날짜. 창이 비어도 남아 있어야 하는 사실이고,
// 창 안 목록에서는 절대 유도할 수 없는 값임(목록이 비어 있으므로).
const FAIL_STALE_TS = "2026-05-02T07:08:09.000Z";

function getHookFailureEntry(): HookFailureEntry {
	return {
		id: 1,
		failure_ts: FAIL_WINDOW_TS,
		hook_name: FAIL_HOOK_NAME,
		target_table: FAIL_TABLE,
		error_kind: "connection_refused",
		payload_ref: null,
		retry_attempted: true,
	};
}

function getFailuresFixture(
	overrides: Partial<HealthFixture["hookFailures"]> = {},
): HealthFixture {
	return getHealthFixture({
		hookFailures: { ...getEmptyHookFailures(), ...overrides },
	});
}

// 최종기록 줄이 실은 기계가 읽는 값 — 표시 문장은 tz/상대시간에 따라 흔들리지만 이 값은 안 흔들림.
// 없으면 null: '줄이 없음' 과 '값이 없음' 을 부르는 이름이 서로 다름.
async function getLastFailureStamp(): Promise<string | null> {
	return await page.evaluate((id) => {
		const el = document.querySelector(`[data-health-detail="${id}"] [data-hook-fail-last]`);
		return el ? el.getAttribute("datetime") : null;
	}, HOOK_ROW_ID);
}

test("AC-T12 the hook part detail lists the failures the window actually returned", async () => {
	await openMapWithHealth(
		getFailuresFixture({
			count_24h: 1,
			failures: [getHookFailureEntry()],
			last_failure_ts: FAIL_WINDOW_TS,
		}),
	);

	const text = await openHookHealth(FAIL_HOOK_NAME);
	assert.ok(text.includes(FAIL_HOOK_NAME), `the detail must name the failing hook, but it read: ${text}`);
	assert.ok(text.includes(FAIL_TABLE), `the detail must name the table the write targeted, but it read: ${text}`);
	assert.ok(
		text.includes(String(HOOK_FAIL_WINDOW_DAYS)),
		`the detail must state the window it counted over, but it read: ${text}`,
	);

	// 행의 시각은 응답 값에서 나와야 함 — 표시 문장이 아니라 기계값으로 잼.
	const rowStamps = await page.evaluate((id) => {
		return [...document.querySelectorAll(`[data-health-detail="${id}"] [data-hook-fail-row] time`)].map(
			(el) => el.getAttribute("datetime") || "",
		);
	}, HOOK_ROW_ID);
	assert.deepEqual(rowStamps, [FAIL_WINDOW_TS], "each rendered row must carry the failure instant the response served");
});

// AC-T12 의 화면 몫이 사는 자리 — 빈 창이 '실패가 한 번도 없었다' 로 읽히면 안 됨.
// 목록에서 최종기록을 유도하는 구현은 여기서 붉어짐: 목록이 비어 있어 유도할 값이 없음.
test("AC-B2-5b an empty window still names when the last failure was", async () => {
	await openMapWithHealth(getFailuresFixture({ failures: [], last_failure_ts: FAIL_STALE_TS }));

	const text = await openHookHealth("Last failure");
	assert.equal(
		await getLastFailureStamp(),
		FAIL_STALE_TS,
		`the detail must carry the whole-table last failure even with an empty window, but it read: ${text}`,
	);
	assert.equal(
		await page.evaluate(
			(id) => document.querySelectorAll(`[data-health-detail="${id}"] [data-hook-fail-row]`).length,
			HOOK_ROW_ID,
		),
		0,
		"fixture precondition: the window returned no rows, so the detail must render none",
	);

	// AC-T12 의 "둘 중 하나라도 빠지면 실패" 를 나머지 방향에서 잼 — 최종기록만으로는
	// 창을 얼마나 보고 비었다고 말하는지가 화면에 없음. 빈 창에서 개수 줄을 숨기는 구현은
	// 여기서 붉어짐(0 도 사실이고, 그 0 이 최종기록과 짝을 이루는 문장임).
	assert.ok(
		text.includes(`0 failures in the last ${HOOK_FAIL_WINDOW_DAYS} days`),
		`an empty window must state the count and the window alongside the last failure, but it read: ${text}`,
	);

	// 반증 방향 — 표가 정말 비어 있으면 최종기록 줄 자체가 없어야 함.
	// 이 줄이 상수라면 여기서도 나타나 붉어짐.
	await openMapWithHealth(getFailuresFixture({ last_failure_ts: null }));
	await openHookHealth("never");
	assert.equal(
		await getLastFailureStamp(),
		null,
		"a table that never held a failure must render no last-failure instant",
	);
});

// ── AC-후속-4a(i) 벤더 번들을 언제 몇 번 받는가 ──────────────────────────────
// 5 MB 벤더 IIFE 는 예전에 index.html 의 <script src> 였다 — 다이어그램이 하나도 없는
// 라우트도 그 바이트를 파서가 멈춘 채 동기로 받았다. 지금은 mermaid-elk-loader.js 가
// 첫 렌더 직전에 한 번만 들여온다. 그 차이는 "무엇이 그려졌나" 가 아니라 "언제 몇 번
// 받았나" 에만 남으므로 두 방향을 함께 잰다 — 다이어그램 없는 라우트 0 건 · 맵 1 건.
// 한쪽만으로는 배치를 구별하지 못한다: 0 건만 재면 아예 받지 않는 회귀(모든 다이어그램이
// dagre 로 눕는다)가 통과하고, 1 건만 재면 모든 라우트가 받던 예전 배치도 그대로 통과한다.

/** 사이드카가 이름을 적은 그 파일 하나 — mermaid-elk-loader.js 의 VENDOR_SRC 와 같은 경로. */
const VENDOR_BUNDLE_PATH = "assets/vendor/mermaid-layout-elk-0.2.3.min.js";

/**
 * 라우트 하나를 새 컨텍스트에서 열고 그 사이의 벤더 번들 요청을 모은다.
 *
 * 청취기는 goto 보다 먼저 붙는다 — 예전 <script src> 는 파서가 만드는 동기 스크립트라
 * load 이벤트가 서기 전에 끝난다. goto 뒤에 붙이면 바로 그 배치의 요청을 놓쳐, 0 건이
 * "미뤘다" 가 아니라 "늦게 봤다" 가 된다.
 *
 * 컨텍스트를 새로 여는 이유는 캐시다 — 앞 케이스가 받아 둔 5 MB 가 메모리 캐시에서
 * 나오면 요청 이벤트가 서지 않아 "1 건" 이 0 건으로 읽힌다.
 */
async function collectVendorRequests(
	hash: string,
	settle: (probe: Page) => Promise<void>,
): Promise<string[]> {
	const probe = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const requests: string[] = [];
	probe.on("request", (request) => {
		// 경로를 정확히 맞춤 — 부분 문자열이면 `…min.js.absent` 처럼 이름이 드리프트한 요청도
		// 세어, 배포되지 않는 경로를 받으러 간 회귀가 "1 건" 으로 통과한다.
		if (new URL(request.url()).pathname === `/${VENDOR_BUNDLE_PATH}`) requests.push(request.url());
	});
	try {
		await probe.goto(`${serverUrl}/#${hash}`, { waitUntil: "load" });

		const runtimeReady = await probe
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
			`#${hash}: page-level network prerequisite unmet — React/mermaid CDN runtime did not load`,
		);

		// 로더는 어느 라우트에서나 실려야 한다. 실리지 않았다면 0 건은 "받을 시점을 미룬 것" 이
		// 아니라 "받을 주체가 없는 것" 이라, 그 값으로는 배치를 증명하지 못한다.
		assert.equal(
			await probe.evaluate(
				() => typeof (window as never as { ensureElkLayout?: unknown }).ensureElkLayout,
			),
			"function",
			`#${hash}: public/mermaid-elk-loader.js did not run — window.ensureElkLayout is absent, so the request count says nothing about deferral`,
		);

		await settle(probe);
		return requests;
	} finally {
		await probe.close();
	}
}

test("AC-후속-4a(i) a diagram-free route pulls no vendor bundle", async () => {
	// 이름이 드리프트하면 0 건은 미룬 증거가 아니라 못 알아본 증거가 된다.
	assert.ok(
		existsSync(resolve(PUBLIC_ROOT, VENDOR_BUNDLE_PATH)),
		`${VENDOR_BUNDLE_PATH} is not under public/ — the counter would read 0 for a bundle that ships under another name`,
	);

	const requests = await collectVendorRequests("dashboard", async (probe) => {
		// 화면이 실제로 섰는지 — 서기 전이라면 아직 아무것도 요청하지 않은 순간을 잰 것이다.
		await probe.waitForSelector('[data-screen-label="Dashboard"]', { timeout: 30_000 });
		// 이 라우트에 다이어그램이 없다는 것은 요구의 전제다 — 생기면 0 건은 틀린 기대가 된다.
		assert.equal(
			await probe.evaluate(
				() =>
					document.querySelectorAll("pre.mermaid, [data-diagram-type], svg[id^='mermaid']")
						.length,
			),
			0,
			"#dashboard rendered a diagram — the route is no longer diagram-free, so expecting zero vendor requests is the wrong bar",
		);
	});

	assert.deepEqual(
		requests,
		[],
		`#dashboard pulled the vendor bundle ${requests.length} time(s) (${JSON.stringify(requests)}) — a route that draws nothing must not pay the 5 MB, which is exactly what the eager <script src> in index.html did`,
	);
});

test("AC-후속-4a(i) opening the map pulls the vendor bundle exactly once", async () => {
	// 앞 케이스가 갈아끼운 픽스처를 되돌림 — 맵은 live · queue · health 를 모두 읽는다.
	liveFixture = getLiveFixture();
	queueFixture = getQueueFixture();
	healthFixture = getHealthFixture();

	const requests = await collectVendorRequests("architecture", async (probe) => {
		const probeSelectors = await probe.evaluate(
			() => (window as never as { ARCH_SELECTORS?: { canvas: string } }).ARCH_SELECTORS,
		);
		assert.ok(
			probeSelectors && probeSelectors.canvas,
			"screen must expose window.ARCH_SELECTORS (canvas SoT)",
		);
		await probe.waitForSelector(`${probeSelectors.canvas} svg`, { timeout: 30_000 });
	});

	assert.equal(
		requests.length,
		1,
		`the map pulled the vendor bundle ${requests.length} time(s) (${JSON.stringify(requests)}) — 0 means the layout registered without the bundle and every diagram quietly lay on dagre, 2+ means the single-promise memo in mermaid-elk-loader.js stopped holding`,
	);
});
