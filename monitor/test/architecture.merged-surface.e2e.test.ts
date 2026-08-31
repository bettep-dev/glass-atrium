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
		getNormalized(desc.text).length,
		expectedDescription.length,
		`target #${desc.id} exposes ${getNormalized(desc.text).length} chars vs payload ${expectedDescription.length}`,
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

// 데몬 넷 밖의 부품 — 이 셋은 부품 경로가 없으면 어떤 링도 받지 못함.
const VERDICT_PART_IDS = ["pg", "browser", "hook-chain"] as const;

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

// 부품 노드가 기대 클래스를 들 때까지 대기 — 응답 도착과 DOM 반영 사이의 틈만 흡수함.
// 시간이 다하면 마지막 판독을 그대로 돌려줌: 단언은 호출부가 하고, 여기서 초록을 만들지 않음.
async function waitForPartRing(partId: string, expected: string): Promise<RingProbe> {
	const deadline = Date.now() + 10_000;
	let probe = await getRingProbe();
	while (Date.now() < deadline) {
		const nodes = getRenderedPart(probe.rendered, partId);
		if (nodes.length > 0 && nodes.every((id) => (probe.classByNode[id] || []).includes(expected)))
			return probe;
		await new Promise((resolve) => setTimeout(resolve, 200));
		probe = await getRingProbe();
	}
	return probe;
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
 * AC-B2-3d — 부품 판정이 자기 바인딩 노드를 켬.
 * 데몬 넷 밖의 세 부품(PG · Chromium export · hook chain)은 이 경로가 없으면 영영 판정 없이 남음.
 */
test("AC-B2-3d healthy part verdicts light their bound nodes", async () => {
	await openMapWithHealth(getHealthFixture());
	const probe = await getRingProbe();

	for (const partId of VERDICT_PART_IDS) assertPartRing(probe, partId, RING_OK_CLASS);
});

test("AC-B2-3d an unreachable PG and a failed export probe light theirs crit", async () => {
	await openMapWithHealth(
		getHealthFixture({ pg: { status: "degraded", db: "closed", browser: "failed" } }),
	);
	const probe = await getRingProbe();

	assertPartRing(probe, "pg", RING_CRIT_CLASS);
	assertPartRing(probe, "browser", RING_CRIT_CLASS);
});

/**
 * AC-B2-3e — health 폴링만 도착하고 캔버스 재렌더가 없는 상황에서 부품 링이 갱신됨.
 * 폴링 한 틱을 실제로 기다림(HEALTH_POLL_MS).
 * 수동 Refresh 로 대신하면 live 응답까지 다시 와 데몬 원천의 참조가 바뀜.
 * 그러면 부품 tone 이 효과 deps 에 없어도 초록이 되어 재는 것이 사라짐.
 * SVG 노드 동일성을 함께 잼 — 재렌더가 끼면 '재렌더 없이' 라는 전제 자체가 무너짐.
 */
test("AC-B2-3e a health poll with no canvas re-render repaints the part ring", async () => {
	await openMapWithHealth(getHealthFixture());
	assertPartRing(await getRingProbe(), "pg", RING_OK_CLASS);

	const svgIdBefore = await getCanvasSvgId();
	const pollsBefore = getHealthCounts()[PG_HEALTH_PATH] || 0;

	// 라우트가 요청마다 이 모듈 변수를 읽으므로, 화면을 다시 세우지 않고 응답만 갈아끼움.
	healthFixture = getHealthFixture({ pg: { status: "degraded", db: "closed", browser: "ok" } });
	assert.equal(
		await waitForHealthPoll(PG_HEALTH_PATH, pollsBefore + 1),
		true,
		`the 60s health poll must re-request ${PG_HEALTH_PATH} — without a second arrival the repaint is untested`,
	);

	const probe = await waitForPartRing("pg", RING_CRIT_CLASS);
	assert.equal(
		await getCanvasSvgId(),
		svgIdBefore,
		"the canvas must not have re-rendered — a re-render repaints the ring for the wrong reason",
	);
	assertPartRing(probe, "pg", RING_CRIT_CLASS);
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

// AC-B2-5c: 지도 아래의 화면-폭 상세 블록은 사라졌음 — 펼칠 것은 이제 표의 행뿐임.
// 이름이 아니라 자리로 잼: 다른 클래스를 달고 돌아온 전역 블록도 표 밖의 컨트롤이므로 붉어짐.
// 죽은 토큰으로 재지 않는 이유 — 그 이름들은 원장(architecture.removal-ledger.static.test.ts)의
// 것이고, 여기 다시 적으면 원장이 제 파일 밖에서 그 이름을 보고 붉어짐.
test("AC-B2-5c every expansion control on the map belongs to a health row", async () => {
	await openMapWithHealth(getHookChainFixture());
	await waitForDaemonRows();

	const toggles = await page.evaluate(() => {
		const all = [...document.querySelectorAll("button[aria-expanded]")];
		return { total: all.length, inTable: all.filter((el) => el.closest(".arch-live-table")).length };
	});

	assert.ok(toggles.total > 0, "fixture precondition: the map must render at least one expandable row");
	assert.equal(
		toggles.total,
		toggles.inTable,
		"an expansion control outside the health table is a screen-wide detail block returning under the map",
	);

	// 컨트롤만 세는 절은 컨트롤 없이 늘 펼쳐진 채 돌아온 화면-폭 상세를 못 봄 — 그런 블록은
	// 컨트롤이 0 건이라 위 절을 초록으로 통과함. 그래서 그 블록들이 들고 있던 내용 자체를
	// 자리로 잼: 훅 구성과 실패 이력은 행 확장 안에서만 나옴. 안쪽이 0 이면 선택자가 죽어
	// 단언이 공허해지므로 그 방향도 함께 잼.
	await expandHookRow(HOOK_FIXTURE_EVENTS[0].groups[0].hooks[0].command);

	const detail = await page.evaluate(() => {
		const all = [...document.querySelectorAll(".arch-hook-chain, .arch-hook-fails")];
		return { total: all.length, inTable: all.filter((el) => el.closest(".arch-live-table")).length };
	});

	assert.ok(detail.total > 0, "fixture precondition: the expanded hook row must render the hook detail");
	assert.equal(
		detail.total,
		detail.inTable,
		"hook detail outside the health table is a screen-wide block returning under the map — with a control of its own or without one",
	);
});

// --- T11: the hook chain configuration in the hook row's expansion ---------

// 표의 hook 행 — 부품 명부(HEALTH_CARD_DEFS)의 id 이고, 확장 영역이 그 id 로 달림.
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

// hook 행을 펼치고 확장 영역 텍스트를 냄. 응답 왕복이 끝나야 채워지므로 기한을 두고 기다림 —
// 초과하면 마지막으로 읽은 텍스트를 그대로 돌려 단언이 무엇을 봤는지 메시지에 남게 함.
async function expandHookRow(needle: string): Promise<string> {
	await page.waitForSelector(`[data-health-row="${HOOK_ROW_ID}"] button[aria-expanded]`, { timeout: 30_000 });
	await page.click(`[data-health-row="${HOOK_ROW_ID}"] button[aria-expanded]`);

	const deadline = Date.now() + 15_000;
	let text = "";
	while (Date.now() < deadline) {
		text = await getHookRowText();
		if (text.includes(needle)) return text;
		await new Promise((r) => setTimeout(r, 50));
	}
	return text;
}

test("T11 the hook row stays collapsed until its control is pressed", async () => {
	await openMapWithHealth(getHookChainFixture());
	await page.waitForSelector(`[data-health-row="${HOOK_ROW_ID}"] button[aria-expanded]`, { timeout: 30_000 });

	const control = page.locator(`[data-health-row="${HOOK_ROW_ID}"] button[aria-expanded]`);
	assert.equal(
		await control.getAttribute("aria-expanded"),
		"false",
		"the row must start collapsed — the map is not a settings dump",
	);
	const collapsed = await getHookRowText();
	assert.ok(
		!collapsed.includes(HOOK_FIXTURE_EVENTS[0].groups[0].hooks[0].command),
		`a collapsed row must not render its body, but it read: ${collapsed}`,
	);

	await control.click();
	assert.equal(await control.getAttribute("aria-expanded"), "true");

	// aria-controls 가 실제 요소를 가리켜야 함 — 가리키는 곳이 없으면 스크린리더에 관계가 안 남음.
	const controlled = await page.evaluate((id) => {
		const btn = document.querySelector(`[data-health-row="${id}"] button[aria-expanded]`);
		const target = btn ? document.getElementById(btn.getAttribute("aria-controls") || "") : null;
		return { hasTarget: Boolean(target) };
	}, HOOK_ROW_ID);
	assert.ok(controlled.hasTarget, "aria-controls must resolve to the expanded region");

	const expanded = await getHookRowText();
	for (const group of HOOK_FIXTURE_EVENTS[0].groups) {
		assert.ok(expanded.includes(group.matcher), `the expanded row must name the ${group.matcher} matcher`);
		for (const hook of group.hooks) {
			assert.ok(expanded.includes(hook.command), `the expanded row must name ${hook.command}`);
		}
	}
	assert.ok(expanded.includes("PreToolUse"), "the expanded row must name the event the hooks fire on");
	assert.ok(
		expanded.includes(HOOK_FIXTURE_SOURCE),
		"the expanded row must name the file the configuration was read from",
	);
});

// AC-B2-5a: 한 확장 영역이 구성과 실패 이력을 함께 냄 — 훅 신고 하나를 가르는 두 반쪽이
// 화면 두 곳에 흩어져 있으면 조작자가 그 둘을 손으로 맞춰야 함.
// 두 사실을 한 영역 안에서 잼: 각각이 어딘가에 있음이 아니라 '같은 자리에 있음' 이 계약임.
test("AC-B2-5a the hook row expansion carries the configuration and the failure log together", async () => {
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

	const text = await expandHookRow(FAIL_HOOK_NAME);

	const group = HOOK_FIXTURE_EVENTS[0].groups[0];
	assert.ok(text.includes(group.matcher), `one expansion must carry the matcher, but it read: ${text}`);
	assert.ok(
		text.includes(group.hooks[0].command),
		`one expansion must carry the hook the matcher fires, but it read: ${text}`,
	);
	assert.ok(text.includes(FAIL_HOOK_NAME), `one expansion must carry the failing hook, but it read: ${text}`);

	// 실패 항목은 날짜를 실은 기계값이어야 함 — 표시 문장이 아니라 그 값으로 잼.
	const rowStamps = await page.evaluate(
		(id) =>
			[...document.querySelectorAll(`[data-health-detail="${id}"] [data-hook-fail-row] time`)].map(
				(el) => el.getAttribute("datetime") || "",
			),
		HOOK_ROW_ID,
	);
	assert.deepEqual(rowStamps, [FAIL_WINDOW_TS], "the same expansion must carry the dated failure entry");
});

// --- T8 · T9c: the daemon row expands to its last failure -------------------

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
	tag: string;
	type: string | null;
	name: string;
	expanded: string | null;
	controls: string;
	regionFound: boolean;
	regionText: string;
}

/**
 * 확장 컨트롤에서 출발해 aria-controls 가 가리키는 id 를 실제로 되짚어 읽음.
 * 하네스가 id 상수를 다시 적으면 배선이 끊겨도 초록이 되므로 컨트롤에서 출발함.
 */
async function getRowExpansionProbe(daemon: string): Promise<RowExpansionProbe> {
	return await page.evaluate((name) => {
		const row = document.querySelector(`[data-daemon-row="${name}"]`);
		const control = row?.querySelector("[aria-expanded]") as HTMLElement | null;
		const controls = control?.getAttribute("aria-controls") || "";
		const region = controls ? document.getElementById(controls) : null;
		return {
			rowFound: Boolean(row),
			tag: control ? control.tagName : "",
			type: control ? control.getAttribute("type") : null,
			name: control ? (control as HTMLElement).innerText.replace(/\s+/g, " ").trim() : "",
			expanded: control ? control.getAttribute("aria-expanded") : null,
			controls,
			regionFound: Boolean(region),
			regionText: region
				? (region as HTMLElement).innerText.replace(/\s+/g, " ").trim()
				: "",
		};
	}, daemon);
}

async function waitForDaemonRows(): Promise<void> {
	await page.waitForSelector(".arch-live-table tbody tr", { timeout: 30_000 });
}

// 표가 선언하는 열 — AC-T8 첫 절("접힘 상태 행에 4열")이 재는 값. 첫 열 이름은 B2-4 에서
// job → HEALTH 로 옮겼음: 행 원천이 데몬 응답에서 부품 명부로 갔으므로 데몬 아닌 행까지
// 일감이라 부르던 이름이 더는 이 표가 세는 것을 부르지 않음.
// 이름까지 고정함: 개수만 세면 열 하나가 다른 사실로 바뀌어도 초록이 됨.
const LIVE_TABLE_HEADERS = ["HEALTH", "Status", "Last run", "Nodes"];

interface LiveTableShape {
	headers: string[];
	rowCells: number;
	detailColSpan: number | null;
}

// 표의 '모양'을 한 번에 읽음 — 머리글 · 행의 칸 수 · 상세 칸이 가로지르는 폭.
// 셋을 따로 재면 "열은 넷인데 colSpan 은 여전히 4" 같은 어긋남을 아무 단언도 보지 못함.
async function getLiveTableShape(daemon: string): Promise<LiveTableShape> {
	return await page.evaluate((name) => {
		const table = document.querySelector(".arch-live-table");
		// textContent 로 읽음 — innerText 는 스타일시트의 text-transform 까지 반영해서
		// 열 이름이 아니라 대소문자 규칙을 재게 됨. 여기서 잴 것은 마크업이 쓴 이름임.
		const headers = [...(table?.querySelectorAll("thead th") || [])].map((el) =>
			(el.textContent || "").replace(/\s+/g, " ").trim(),
		);
		const row = table?.querySelector(`[data-daemon-row="${name}"]`);
		const detailCell = table?.querySelector(`[data-daemon-detail="${name}"] td`);
		return {
			headers,
			// 행 없음(-1)과 칸 0개를 갈라 부름 — 둘 다 0 으로 접으면 픽스처 붕괴가 결함으로 읽힘.
			rowCells: row ? row.querySelectorAll("th, td").length : -1,
			detailColSpan: detailCell ? Number(detailCell.getAttribute("colspan")) : null,
		};
	}, daemon);
}

// 확장 영역은 페이로드 왕복이 끝나야 채워짐 — 기한을 두고 기다리되 초과는 붉어짐.
async function waitForRegionText(daemon: string, needle: string): Promise<string> {
	const deadline = Date.now() + 15_000;
	let text = "";
	while (Date.now() < deadline) {
		text = (await getRowExpansionProbe(daemon)).regionText;
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

test("AC-T8 each daemon row carries a real expand control wired by aria", async () => {
	await openMap(getLiveFixture());
	await waitForDaemonRows();

	const probe = await getRowExpansionProbe(BOUND_DAEMON);
	assert.equal(probe.rowFound, true, `the live table must carry a row for ${BOUND_DAEMON}`);
	assert.equal(
		probe.tag,
		"BUTTON",
		"the expand control must be a real button — a click-only cell is unreachable by keyboard",
	);
	assert.equal(probe.type, "button", "the control must not submit a form");
	assert.equal(probe.expanded, "false", "a collapsed row must report aria-expanded=false");
	assert.ok(probe.controls, "the control must name the region it opens via aria-controls");
	assert.match(
		probe.name,
		new RegExp(BOUND_DAEMON),
		"the control's accessible name must be the job it opens",
	);
	assert.equal(
		probe.regionFound,
		false,
		"a collapsed row must leave no region in the tree — aria-controls names what expanding creates",
	);
});

// AC-T8 첫 절이 사는 자리 — 표를 flatMap 으로 다시 쓴 자리(architecture.jsx)가 열을 하나
// 떨어뜨려도, 열 수만 바꾸고 상세 칸의 colSpan 을 그대로 두어도 여기서 붉어짐.
// 접힘/펼침 양쪽을 다 잼: 펼침이 요약 행의 칸을 건드리면 표가 한 행만 다른 폭이 됨.
test("AC-T8 a collapsed row carries the four columns the header names", async () => {
	await openMap(getLiveFixture());
	await waitForDaemonRows();

	const collapsed = await getLiveTableShape(BOUND_DAEMON);
	assert.deepEqual(
		collapsed.headers,
		LIVE_TABLE_HEADERS,
		`the live table must name ${LIVE_TABLE_HEADERS.join("/")} — dropping or renaming a column changes this list`,
	);
	assert.equal(
		collapsed.rowCells,
		LIVE_TABLE_HEADERS.length,
		`a collapsed row must fill every column the header declares — read ${collapsed.rowCells} cells against ${LIVE_TABLE_HEADERS.length} headers`,
	);
	assert.equal(
		collapsed.detailColSpan,
		null,
		"fixture precondition: nothing is expanded yet, so no detail cell exists",
	);

	await page.click(`[data-daemon-row="${BOUND_DAEMON}"] [aria-expanded]`);

	const expanded = await getLiveTableShape(BOUND_DAEMON);
	assert.equal(
		expanded.rowCells,
		LIVE_TABLE_HEADERS.length,
		"expanding must not change the summary row's own cells",
	);
	assert.equal(
		expanded.detailColSpan,
		expanded.headers.length,
		`the detail cell must span exactly the columns the header declares — read colSpan ${expanded.detailColSpan} against ${expanded.headers.length} headers`,
	);
});

test("AC-T8 clicking the control expands the row and the region it names appears", async () => {
	await openMap(getLiveFixture());
	await waitForDaemonRows();
	await page.click(`[data-daemon-row="${BOUND_DAEMON}"] [aria-expanded]`);

	const probe = await getRowExpansionProbe(BOUND_DAEMON);
	assert.equal(probe.expanded, "true", "an expanded row must report aria-expanded=true");
	assert.equal(
		probe.regionFound,
		true,
		`aria-controls target #${probe.controls} must exist once the row is open`,
	);
});

// 키보드만으로 여닫는지 재는 반증 케이스 — tabindex 없는 div 에 onClick 만 단 구현은 여기서 붉어짐.
test("AC-T8 the keyboard alone opens and closes the row", async () => {
	await openMap(getLiveFixture());
	await waitForDaemonRows();

	const control = `[data-daemon-row="${BOUND_DAEMON}"] [aria-expanded]`;
	await page.focus(control);
	assert.equal(
		await page.evaluate(
			(sel) => document.activeElement === document.querySelector(sel),
			control,
		),
		true,
		"the control must be focusable",
	);

	await page.keyboard.press("Enter");
	assert.equal(
		(await getRowExpansionProbe(BOUND_DAEMON)).expanded,
		"true",
		"Enter on the focused control must open the row",
	);

	await page.keyboard.press("Space");
	const collapsed = await getRowExpansionProbe(BOUND_DAEMON);
	assert.equal(collapsed.expanded, "false", "Space must close the row again");
	assert.equal(
		collapsed.regionFound,
		false,
		"closing must take the region back out of the a11y tree, not merely restyle it",
	);
});

test("AC-T9 the expanded region names the failure date and the reason behind it", async () => {
	await openMapWithHealth(getHealthFixture({ payload: getFailingPayload() }));
	await waitForDaemonRows();
	await page.click(`[data-daemon-row="${BOUND_DAEMON}"] [aria-expanded]`);

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

// 드릴다운이 고른 행을 따라가는지 재는 반증 케이스 — 고정 리터럴 구현은 여기서 붉어짐.
test("AC-T9 expanding a second daemon drills the payload request into THAT daemon", async () => {
	await openMap(
		getLiveFixture({
			daemons: [getDaemon(BOUND_DAEMON, "ok"), getDaemon(DRILLDOWN_DAEMON, "ok")],
		}),
	);
	await waitForDaemonRows();
	assert.equal(
		await waitForHealthHit(`/api/health/daemon-payload?daemon=${BOUND_DAEMON}`),
		true,
		"fixture precondition: the map drills into its default daemon on mount",
	);

	await page.click(`[data-daemon-row="${DRILLDOWN_DAEMON}"] [aria-expanded]`);
	assert.equal(
		await waitForHealthHit(`/api/health/daemon-payload?daemon=${DRILLDOWN_DAEMON}`),
		true,
		`expanding ${DRILLDOWN_DAEMON} must move the drilldown — a frozen literal keeps asking for ${BOUND_DAEMON}`,
	);
});

// 표의 판정이 서 있는 네 응답 — 드릴다운은 이들을 건드리면 안 됨.
const TABLE_BACKING_PATHS = [
	"/api/health",
	"/api/health/daemons",
	"/api/health/hook-chain",
	"/api/health/hook-failures",
];

// 다섯 응답을 한 effect 에 묶고 payloadDaemon 을 그 deps 에 넣은 구현은 여기서 붉어짐:
// 행 하나를 펼치면 네 응답이 함께 다시 나가고, 왕복이 끝날 때까지 표의 PG·브라우저 판정이
// 빈 칸으로 떨어짐. 표는 드릴다운을 따라 흔들리면 안 됨.
test("AC-T9 drilling into another daemon re-requests the payload alone", async () => {
	await openMap(
		getLiveFixture({
			daemons: [getDaemon(BOUND_DAEMON, "ok"), getDaemon(DRILLDOWN_DAEMON, "ok")],
		}),
	);
	await waitForDaemonRows();
	assert.equal(
		await waitForHealthHit(`/api/health/daemon-payload?daemon=${BOUND_DAEMON}`),
		true,
		"fixture precondition: the map drills into its default daemon on mount",
	);
	// 첫 왕복이 다 앉은 뒤에 세어야 함 — 마운트분이 클릭분으로 새면 아무것도 재지 못함.
	await page.waitForTimeout(500);

	const before = getHealthCounts();
	await page.click(`[data-daemon-row="${DRILLDOWN_DAEMON}"] [aria-expanded]`);
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
		"expanding a row must not re-fire the four responses the table's verdicts stand on",
	);
});

// 못 읽은 응답과 아직 안 온 응답을 화면이 갈라 부르는지 재는 반증 케이스 — 형제 블록
// (HookChainDetail · HookFailureDetail)이 이미 그렇게 함. 둘을 한 문장으로 접은 구현은
// 끊긴 응답에도 "Loading …" 을 남겨 조작자가 기다릴지 고칠지 못 정하게 만듦.
test("AC-T9 an errored payload response says it could not be read, not that it is loading", async () => {
	await openMapWithHealth(getHealthFixture({ payloadFails: true }));
	await waitForDaemonRows();
	await page.click(`[data-daemon-row="${BOUND_DAEMON}"] [aria-expanded]`);

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
	await waitForDaemonRows();
	// 아직 한 번도 응답이 오지 않은 데몬으로 드릴다운함 — 기본 데몬은 마운트분이 이미 앉았을 수 있음.
	await page.click(`[data-daemon-row="${DRILLDOWN_DAEMON}"] [aria-expanded]`);

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

// 판정 앵커 — 행의 '등장' 이 아니라 tone 이 붙은 것을 기다림. 행은 부품 명부로 서므로 health 응답
// 없이도 마운트 시점에 그려짐: 등장을 기다리면 마운트를 기다린 것이지 판정을 기다린 것이 아님.
async function waitForPartVerdict(partId: string): Promise<void> {
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

async function getPartRowIds(): Promise<string[]> {
	return await page.evaluate(() =>
		[...document.querySelectorAll("[data-health-row]")].map(
			(row) => row.getAttribute("data-health-row") || "",
		),
	);
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

// 행 하나가 내는 판정 두 갈래 — tone 속성과 Status 칸의 글자. 둘을 함께 읽는 이유는
// 속성만 재면 글자로 지어낸 판정('Healthy')을 못 보고, 글자만 재면 앵커 계약이 안 걸리기 때문임.
async function getDaemonRowVerdicts(): Promise<{ id: string; tone: string | null; status: string }[]> {
	return await page.evaluate(
		(ids) =>
			ids.map((id) => {
				const row = document.querySelector(`[data-health-row="${id}"]`);
				const cell = row ? row.querySelectorAll("td")[0] : null;
				return {
					id,
					tone: row ? row.getAttribute("data-health-tone") : "<the row did not render>",
					status: cell ? (cell.textContent || "").replace(/\s+/g, " ").trim() : "<no status cell>",
				};
			}),
		DAEMON_PART_IDS,
	);
}

// 끊긴 health 저장소를 부르는 경보 — 이름·자리·복구 컨트롤을 함께 읽음.
// 셋을 따로 재면 '경보는 떴는데 되돌릴 길이 없음' 이나 '표 밖에 떴음' 이 초록으로 지나감.
async function getStoreAlerts(): Promise<{ text: string; inTable: boolean; retries: number }[]> {
	return await page.evaluate(() =>
		[...document.querySelectorAll('[role="alert"]')]
			.filter((el) => (el.textContent || "").includes("system health"))
			.map((el) => ({
				text: (el.textContent || "").replace(/\s+/g, " ").trim(),
				inTable: Boolean(el.closest(".arch-live-table-wrap")),
				retries: el.querySelectorAll("button").length,
			})),
	);
}

test("AC-B2-6b a health store that failed is named by an alert standing in the table", async () => {
	await openMapWithHealth(getHealthFixture({ failedStores: ["health"] }));
	// 끊긴 저장소의 행은 tone 을 못 받으므로 판정 앵커를 쓸 수 없음 — 경보 자체를 기다림.
	// 부재는 아래 단언이 문장으로 보고함(여기서 던지면 붉은 이유가 타임아웃으로 바뀜).
	await page.waitForSelector(".arch-live-table-wrap .arch-queue-error", { timeout: 15_000 }).then(
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
			inTable: alerts[0].inTable,
			namesStore: alerts[0].text.includes("PostgreSQL"),
			retries: alerts[0].retries,
		},
		{ inTable: true, namesStore: true, retries: 1 },
		`the alert must name the store that failed, stand with the table, and carry a way back — read: "${alerts[0].text}"`,
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

test("AC-B2-6f a daemon row with no response carries no verdict, never a fabricated one", async () => {
	await openMapWithHealth(getHealthFixture({ failedStores: ["daemons"] }));
	// 데몬 응답만 끊었으므로 PG 행은 판정을 받음 — 표가 실제로 섰음을 그 앵커로 확인함.
	await waitForPartVerdict("pg");

	const unread = await getDaemonRowVerdicts();
	assert.deepEqual(
		unread.filter((row) => row.tone !== null || row.status !== "—"),
		[],
		"a daemon row whose response never arrived must carry no tone and no status word — either one is an invented verdict",
	);

	// 대조군 — 응답이 오면 같은 넷이 판정을 실음. 없으면 위 절은 '행이 없어서' 초록일 수 있음.
	await openMap(getLiveFixture());
	await waitForPartVerdict("daemon-cycle");

	const read = await getDaemonRowVerdicts();
	assert.deepEqual(
		read.filter((row) => row.tone === null),
		[],
		"the daemon rows must carry a tone once the response arrives, or the reading above measured absent rows",
	);
});

test("AC-B2-4a the table stands one row per roster part under a HEALTH header", async () => {
	await openMap(getLiveFixture());
	await waitForPartVerdict("pg");

	// textContent 로 읽음 — innerText 는 스타일시트의 text-transform 을 반영하므로 마크업이 쓴
	// 이름이 아니라 대소문자 규칙을 재게 됨.
	const firstHeader = await page.evaluate(() => {
		const th = document.querySelector(".arch-live-table thead th");
		return th ? (th.textContent || "").replace(/\s+/g, " ").trim() : "";
	});
	assert.equal(
		firstHeader,
		LIVE_TABLE_HEADERS[0],
		`the first column must name the health part it stands for — read "${firstHeader}"`,
	);

	const roster = await getRosterPartIds();
	assert.equal(
		roster.length,
		HEALTH_EXPECTED_TOTAL,
		`fixture precondition: the shared roster must carry ${HEALTH_EXPECTED_TOTAL} parts`,
	);
	assert.deepEqual(
		await getPartRowIds(),
		roster,
		"the rows must be the roster itself, in its order — a daemon-response source drops every part that answers no daemon",
	);
	assert.match(
		await getPartRowText("pg"),
		/PostgreSQL/,
		"the PostgreSQL part must stand as a row of its own, named",
	);
});

test("AC-B2-4b the row count follows the roster, and an empty roster leaves no rows", async () => {
	await openMap(getLiveFixture());
	await waitForPartVerdict("pg");
	assert.equal(
		(await getPartRowIds()).length,
		HEALTH_EXPECTED_TOTAL,
		"fixture precondition: the untouched roster must fill every row",
	);

	const remaining = await spliceRoster(1);
	await refreshMap();
	assert.equal(
		await waitForRowCount(remaining),
		remaining,
		`dropping one part must drop exactly one row — a map-local row source keeps the old ${HEALTH_EXPECTED_TOTAL}`,
	);

	await spliceRoster(remaining);
	await refreshMap();
	assert.equal(
		await waitForRowCount(0),
		0,
		"an empty roster must leave no rows — a surviving row is the map stating a total its source no longer states",
	);
});

test("AC-B2-4c an unreachable database turns the PostgreSQL row, not only the strip", async () => {
	await openMapWithHealth(
		getHealthFixture({ pg: { status: "degraded", db: "closed", browser: "ok" } }),
	);
	await waitForPartVerdict("pg");

	assert.equal(
		await getPartTone("pg"),
		"crit",
		"an unreachable database must turn its own row crit — a verdict that lives only in the strip dies with the strip",
	);
	// 색만으로 판정을 말하면 색을 못 읽는 조작자와 하네스가 같은 문장을 못 읽음.
	const text = await getPartRowText("pg");
	assert.match(text, /PostgreSQL/, `the row must name the part it judges — read "${text}"`);
	assert.match(text, /\bDown\b/, `the row must state the verdict in words — read "${text}"`);
});

test("AC-B2-4d only a row with something to open carries an expand control", async () => {
	await openMap(getLiveFixture());
	await waitForPartVerdict("browser");

	const expandable = await page.evaluate(() =>
		[...document.querySelectorAll("[data-health-row]")]
			.filter((row) => row.querySelector("[aria-expanded]"))
			.map((row) => row.getAttribute("data-health-row") || ""),
	);

	assert.ok(
		!expandable.includes("browser"),
		"the Chromium export row opens onto nothing — a control there promises a detail that does not exist",
	);
	assert.deepEqual(
		[...expandable].sort(),
		[...EXPANDABLE_PART_IDS].sort(),
		"exactly the four daemon rows and the hook chain row may open — nothing else has a detail to show",
	);
});

test("AC-B2-4e the Chromium export row's tone follows the launch probe through all three of its values", async () => {
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
		"an unprobed browser must leave no row in crit",
	);
});

// --- B2-4 guard: what the Nodes column reads --------------------------------

// B2-4 는 Nodes 열의 원천을 /live 의 `daemons[].node_ids` 에서 같은 응답의 `part_bindings` 로
// 옮겼는데, 옮긴 자리에 칸 '내용' 을 재는 단언이 없었음 — getLiveTableShape 는 칸 '수' 만 세므로
// 표가 사라지거나 키가 어긋나 전 칸이 '—' 로 떨어져도 초록이 남음. 아래 두 절은 서로 다른 결함을
// 잡음: 1절은 응답이 준 값을 그대로 싣는지, 2절은 그 값을 정말 응답에서 읽는지(제 사본이 아닌지).

const NODES_HEADER = LIVE_TABLE_HEADERS[3];
const LAST_RUN_HEADER = LIVE_TABLE_HEADERS[2];

// 부품 id → 그 열의 칸 글.
async function getPartCells(header: string): Promise<Record<string, string>> {
	return await page.evaluate((headerName) => {
		const table = document.querySelector(".arch-live-table");
		const headers = [...(table?.querySelectorAll("thead th") || [])].map((el) =>
			(el.textContent || "").replace(/\s+/g, " ").trim(),
		);
		// 칸 자리를 머리글에서 찾음 — 상수 3 으로 세면 열이 하나 끼어들 때 조용히 옆 칸을 읽어
		// 다른 사실을 재게 됨. 머리글이 없으면 -1 이라 모든 칸이 빈 글로 떨어져 붉어짐.
		const col = headers.indexOf(headerName);
		return Object.fromEntries(
			[...(table?.querySelectorAll("[data-health-row]") || [])].map((row): [string, string] => [
				row.getAttribute("data-health-row") || "",
				(row.querySelectorAll("th, td")[col]?.textContent || "")
					.replace(/\s+/g, " ")
					.trim(),
			]),
		);
	}, header);
}

test("B2-4 guard the Nodes column carries the served part_bindings, not a map-local copy", async () => {
	await openMap(getLiveFixture());
	await waitForPartVerdict("pg");

	// 기대값은 서버 상수에서 뽑음 — 하네스가 목록을 다시 적으면 두 사본이 함께 틀린 채 초록이 됨.
	const roster = await getRosterPartIds();
	const expected = Object.fromEntries(
		roster.map((id): [string, string] => [
			id,
			(PART_NODE_BINDINGS[id] ?? []).join(", ") || "—",
		]),
	);
	assert.equal(
		roster.length,
		HEALTH_EXPECTED_TOTAL,
		`fixture precondition: the shared roster must carry ${HEALTH_EXPECTED_TOTAL} parts`,
	);
	assert.ok(
		!Object.values(expected).includes("—"),
		"fixture precondition: the served table binds every roster part, so a blanket em dash is the map failing to read it, never the data",
	);
	assert.deepEqual(
		await getPartCells(NODES_HEADER),
		expected,
		"every Nodes cell must carry the binding the response served — an absent or re-keyed table empties them all, and counting cells alone stays green through it",
	);

	// 2절 — 응답을 갈아끼우면 칸이 따라가야 함. 1절은 화면이 마침 같은 값을 든 제 사본을 읽어도
	// 통과하므로, 응답만 아는 값을 심어야 원천이 어디인지가 갈림.
	await openMap(getLiveFixture({ part_bindings: { pg: ["injected_a", "injected_b"] } }));
	await waitForPartVerdict("pg");

	const injected = await getPartCells(NODES_HEADER);
	assert.equal(
		injected.pg,
		"injected_a, injected_b",
		"a re-keyed table must move the cell with it — a cell holding a value this response never sent is the map reading a copy of its own",
	);
	assert.equal(
		injected.browser,
		"—",
		"a part the served table no longer binds must read empty, not the nodes it used to carry",
	);
});

// 응답이 실행을 실어 준 데몬 행 — 명부에 있는 둘. 나머지 부품은 낼 실행이 없음.
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

// 부품 id → Last run 칸 글. 판정이 도착한 뒤에 읽음 — 실행 시각과 tone 이 같은 응답에서 오므로
// 데몬 행의 tone 이 붙었다는 것이 그 응답이 화면에 닿았다는 뜻임.
async function getLastRunCells(runTs: string): Promise<Record<string, string>> {
	await openMap(getLiveFixture(), getQueueFixture(), getRanDaemonFixture(runTs));
	await waitForPartVerdict(RAN_PART_IDS[0]);
	await waitForPartVerdict("pg");

	return await getPartCells(LAST_RUN_HEADER);
}

// B2-4 는 Nodes 열에 두 절짜리 계기를 남겼지만 Last run 열에는 남기지 않았음. 그 칸의 '비어 있음'
// 은 부품 대부분에서 정답이라 상수를 실은 구현이 눈에 띄지 않고 통과함 — 널 검사만 남기고 값을
// 지어낸 구현(`row.lastRunAt ? "moments ago" : "—"`)은 '비어 있지 않음' 만 재는 단언 아래에서
// 초록임. 그래서 두 절로 잼: 1절은 그 칸이 경과 판독으로 읽히고 보고할 실행이 없는 행만 비어
// 있음을, 2절은 다른 순간을 실어 보내면 그 칸이 따라 움직임을 잼. 상수는 2절에서 붉어짐.
test("B2-5 guard the Last run column tracks the served instant and empties only the rows without one", async () => {
	const served = await getLastRunCells(DAEMON_RUN_TS);
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
	assert.deepEqual(
		roster.filter((id) => !RAN_PART_IDS.includes(id) && served[id] !== "—"),
		[],
		"a part with no run to report must read empty — a filled cell there is the column inventing a run",
	);

	// 2절 — 값의 방향. 같은 행에 다른 순간을 실어 보내면 그 칸의 글이 달라져야 함.
	const moved = await getLastRunCells(DAEMON_RUN_ALT_TS);
	for (const id of RAN_PART_IDS) {
		assert.match(
			moved[id] || "",
			/^\d+[smhd] ago$/,
			`the second serving must read as an elapsed time too, but ${id} read "${moved[id]}"`,
		);
		assert.notEqual(
			moved[id],
			served[id],
			`${id} read "${moved[id]}" for both instants — the cell carries a map-local constant, not the run the response served`,
		);
	}
	assert.deepEqual(
		roster.filter((id) => !RAN_PART_IDS.includes(id) && moved[id] !== "—"),
		[],
		"the rows without a run must stay empty across both servings",
	);
});

// --- T12c: the hook failure log, in the same hook row expansion -------------

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

test("AC-T12 the hook row expansion lists the failures the window actually returned", async () => {
	await openMapWithHealth(
		getFailuresFixture({
			count_24h: 1,
			failures: [getHookFailureEntry()],
			last_failure_ts: FAIL_WINDOW_TS,
		}),
	);

	const text = await expandHookRow(FAIL_HOOK_NAME);
	assert.ok(text.includes(FAIL_HOOK_NAME), `the expansion must name the failing hook, but it read: ${text}`);
	assert.ok(text.includes(FAIL_TABLE), `the expansion must name the table the write targeted, but it read: ${text}`);
	assert.ok(
		text.includes(String(HOOK_FAIL_WINDOW_DAYS)),
		`the expansion must state the window it counted over, but it read: ${text}`,
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

	const text = await expandHookRow("Last failure");
	assert.equal(
		await getLastFailureStamp(),
		FAIL_STALE_TS,
		`the expansion must carry the whole-table last failure even with an empty window, but it read: ${text}`,
	);
	assert.equal(
		await page.evaluate(
			(id) => document.querySelectorAll(`[data-health-detail="${id}"] [data-hook-fail-row]`).length,
			HOOK_ROW_ID,
		),
		0,
		"fixture precondition: the window returned no rows, so the expansion must render none",
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
	await expandHookRow("never");
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
