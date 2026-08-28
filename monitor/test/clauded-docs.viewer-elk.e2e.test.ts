// E2E chromium harness — document diagrams under the shared ELK config (plan D5-2 P1-3).
// Runner: npx tsx --test test/clauded-docs.viewer-elk.e2e.test.ts
//
// P1-1 promoted `layout:'elk'` into public/mermaid-config.js, so every document
// diagram lays out through ELK without asking for it. This harness is the floor
// under that promotion: three sample documents go through the real viewer path
// (row click → ViewerBodyCD → normalizeMermaidSource → mermaid.render) and are
// measured for orthogonal edges against a dagre control, a silent fallback, the
// cycle-A width contract, and a per-block dagre opt-out.
//
// The samples are shaped after the live corpus rather than after one convenient
// case — a flowchart-heavy HTML document, a document carrying all six adopted
// non-flowchart types, and a document carrying an excluded type (gantt) beside an
// adopted one. A single-flowchart sample would stay green while every other type
// broke, so the type coverage is asserted against diagram-types.json rather than
// left to whichever fixtures happen to be here (AC1).
//
// App: stripped Fastify (fastify-static over public/ + two hand-written fixture
// routes) on an ephemeral port. registerClaudedDocsRoutes is NOT called — it needs
// Postgres and on-disk bodies, neither of which this measurement wants, and the
// fixture bodies are the point.
// Browser: Playwright chromium headless, NO mocking. Page-level network
// prerequisite: React/mermaid load from CDN, so the run REQUIRES outbound network
// and an installed chromium — an unmet prerequisite fails RED in before.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import {
	assertFallbackWarningVisible,
	assertLayoutsDiffer,
	assertOrthogonalLinks,
	createFallbackWatch,
	findDiagonalSegments,
	getProbe,
	type RenderProbe,
} from "./lib/mermaid-elk-probe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_ROOT = resolve(HERE, "..");
const PUBLIC_ROOT = resolve(MONITOR_ROOT, "public");
const DECLARATION_PATH = resolve(MONITOR_ROOT, "src/server/clauded-docs/diagram-types.json");

// 벤더 IIFE 요청 식별자 — 파일명 일부. 경로가 바뀌면 개수 판정이 조용히 0 이 되므로
// 아래 "요청 1건" 단언이 그 변화를 붉게 만든다.
const VENDOR_REQUEST_MARK = "mermaid-layout-elk";

// 곡선 명령 — ELK 렌더러는 M/L/Q 만 낸다. 하나라도 나오면 dagre 로 떨어진 것.
const CUBIC_COMMAND = /[CcSs]/;

interface DiagramTypesDeclaration {
	adopted: { type: string }[];
	excluded: { type: string }[];
}

const DECLARATION = JSON.parse(
	readFileSync(DECLARATION_PATH, "utf8"),
) as DiagramTypesDeclaration;
const ADOPTED_TYPES = new Set(DECLARATION.adopted.map((entry) => entry.type));
const EXCLUDED_TYPES = new Set(DECLARATION.excluded.map((entry) => entry.type));

interface DiagramFixture {
	/** data-probe 값 — 렌더 후 블록을 되찾는 열쇠. */
	probe: string;
	/** diagram-types.json 의 타입 토큰. 채택/제외 판정의 근거. */
	type: string;
	/** 폭 프리셋 클래스 — 본문폭 · 넓게 · 전폭. */
	preset: string;
	source: string;
}

interface DocFixture {
	id: number;
	title: string;
	diagrams: DiagramFixture[];
}

// 대조군 짝의 원본 — 같은 소스를 두 레이아웃으로 그려야 좌표 차이가 의미를 가진다.
const CONTROL_FLOWCHART = [
	"flowchart TD",
	"  Root[Plan direction gate] --> Reviewer[Reviewer verdict]",
	"  Root --> Dev[DEV feasibility verdict]",
	"  Reviewer --> Entry[Implementation entry]",
	"  Dev --> Entry",
].join("\n");

// ADR-5 의 문서별 opt-out — 물리적 한 줄 지시자. 뷰어의 normalizeMermaidSource 를
// 그대로 통과해야 하므로 하네스가 아니라 본문 안에 둔다.
const DAGRE_OPT_OUT = '%%{init: {"layout":"dagre"}}%%';

const FLOWCHART_HEAVY: DocFixture = {
	id: 5001,
	title: "P1-3 sample — flowchart-heavy HTML document",
	diagrams: [
		{
			probe: "fc-gate",
			type: "flowchart",
			preset: "doc-diagram-body",
			source: [
				"flowchart TD",
				"  Intake[Delegation intake] --> Gate{Scope declared}",
				"  Gate -->|yes| Impl[Implementation entry]",
				"  Gate -->|no| Halt[Halt and report]",
			].join("\n"),
		},
		{
			probe: "fc-wide",
			type: "flowchart",
			preset: "doc-diagram-wide",
			source: [
				"flowchart LR",
				"  A[Orchestrator delegation gate decision] --> B[Reviewer verdict aggregation step]",
				"  B --> C[Implementation entry with acceptance criteria]",
				"  C --> D[Reconciliation across both directions]",
			].join("\n"),
		},
		{
			probe: "fc-full",
			type: "flowchart",
			preset: "doc-diagram-full",
			source: [
				"flowchart LR",
				"  Author[Planner authors the persisted plan] --> Verify[Reviewer and DEV direction verdicts]",
				"  Verify --> Build[Domain agents implement the verified tasks]",
				"  Build --> Reconcile[Coverage and excess reconciliation]",
				"  Reconcile --> Deploy[Combined tree deploy and empirical probes]",
				"  Deploy --> Probe[Live rule and behaviour probes on the install]",
				"  Probe --> Merge[Pull request, continuous integration and merge]",
			].join("\n"),
		},
		{
			probe: "fc-control",
			type: "flowchart",
			preset: "doc-diagram-body",
			source: CONTROL_FLOWCHART,
		},
		{
			probe: "fc-optout",
			type: "flowchart",
			preset: "doc-diagram-body",
			source: `${DAGRE_OPT_OUT}\n${CONTROL_FLOWCHART}`,
		},
	],
};

const NON_FLOWCHART: DocFixture = {
	id: 5002,
	title: "P1-3 sample — adopted types that are not flowcharts",
	diagrams: [
		{
			probe: "seq-delegation",
			type: "sequenceDiagram",
			preset: "doc-diagram-body",
			source: [
				"sequenceDiagram",
				"  participant Orchestrator as Orchestrator control plane",
				"  participant Reviewer as Reviewer verdict producer",
				"  Orchestrator->>Reviewer: request plan direction verification",
				"  Reviewer-->>Orchestrator: pass with unmet item list",
			].join("\n"),
		},
		{
			probe: "state-lifecycle",
			type: "stateDiagram-v2",
			preset: "doc-diagram-wide",
			source: [
				"stateDiagram-v2",
				"  direction LR",
				"  [*] --> AwaitingVerification",
				"  AwaitingVerification --> ImplementationEntry",
				"  ImplementationEntry --> Reconciliation",
				"  Reconciliation --> [*]",
			].join("\n"),
		},
		{
			probe: "er-outcome",
			type: "erDiagram",
			preset: "doc-diagram-body",
			source: [
				"erDiagram",
				'  OUTCOME_RECORD ||--o{ CORRECTION_SIGNAL : "produces on revision"',
				'  OUTCOME_RECORD }o--|| AGENT_REGISTRY_ENTRY : "emitted by agent"',
			].join("\n"),
		},
		{
			probe: "class-writer",
			type: "classDiagram",
			preset: "doc-diagram-body",
			source: [
				"classDiagram",
				"  direction LR",
				"  class OutcomeRecordWriter {",
				"    +getCompletionBlock(): CompletionBlock",
				"  }",
				"  class CorrectionSignalAggregator {",
				"    +putDirectiveHint(hint: DistilledLesson)",
				"  }",
				"  OutcomeRecordWriter --> CorrectionSignalAggregator : emits distilled lesson",
			].join("\n"),
		},
		{
			probe: "gitgraph-waves",
			type: "gitGraph",
			preset: "doc-diagram-wide",
			source: [
				"gitGraph",
				'  commit id: "wave-one-integration-landed"',
				"  branch feature/plan-direction-gate",
				'  commit id: "stage-two-verify-team"',
				"  checkout main",
				"  merge feature/plan-direction-gate",
			].join("\n"),
		},
		{
			probe: "c4-boundary",
			type: "C4",
			preset: "doc-diagram-body",
			source: [
				"C4Context",
				"  title Document export boundary",
				'  Person(operator, "Monitor operator", "Reads exported documents offline")',
				'  System(monitor, "Monitor service", "Serves stored documents and diagrams")',
				'  Rel(operator, monitor, "reads exported documents")',
			].join("\n"),
		},
	],
};

const EXCLUDED_BESIDE_ADOPTED: DocFixture = {
	id: 5003,
	title: "P1-3 sample — excluded gantt beside an adopted flowchart",
	diagrams: [
		{
			probe: "gantt-phases",
			type: "gantt",
			preset: "doc-diagram-body",
			source: [
				"gantt",
				"  title Cycle phases",
				"  dateFormat YYYY-MM-DD",
				"  section Proof",
				"  Phase zero proof gate :done, p0, 2026-08-01, 5d",
				"  section Rollout",
				"  Phase one rollout :active, p1, after p0, 6d",
			].join("\n"),
		},
		{
			probe: "fc-beside-gantt",
			type: "flowchart",
			preset: "doc-diagram-body",
			source: [
				"flowchart TD",
				"  Proof[Proof gate] --> Rollout[Rollout wave]",
				"  Rollout --> Close[Cycle close]",
			].join("\n"),
		},
	],
};

const DOC_FIXTURES = [FLOWCHART_HEAVY, NON_FLOWCHART, EXCLUDED_BESIDE_ADOPTED];

/** 본문 HTML — 실제 문서와 같은 모양(프리셋 클래스를 단 pre.mermaid)으로 조립. */
function getDocBody(doc: DocFixture): string {
	const blocks = doc.diagrams
		.map(
			(diagram) =>
				`<section><h2>${diagram.probe}</h2>` +
				`<pre class="mermaid ${diagram.preset}" data-probe="${diagram.probe}"` +
				` data-diagram-type="${diagram.type}">${diagram.source}</pre></section>`,
		)
		.join("\n");
	return (
		'<!doctype html><html lang="en"><head><meta charset="utf-8">' +
		`<title>${doc.title}</title></head><body class="bg-zinc-950">` +
		`<h1>${doc.title}</h1>${blocks}</body></html>`
	);
}

function getDocDetail(doc: DocFixture): Record<string, unknown> {
	return {
		id: doc.id,
		title: doc.title,
		author: "p1-3-harness",
		created_at: "2026-08-27T00:00:00.000Z",
		content_hash: `hash-${doc.id}`,
		html_path: `/fixture/${doc.id}.html`,
		md_copy_path: null,
		last_synced_at: null,
		audience: "exposed",
		format: "html",
		supersedes_id: null,
		superseded_by_id: null,
		doc_status: "progress",
		folder_id: null,
		display_order: null,
		body: getDocBody(doc),
	};
}

function getDocGroups(): Record<string, unknown> {
	return {
		total: DOC_FIXTURES.length,
		doc_total: DOC_FIXTURES.length,
		hidden_doc_total: 0,
		groups: DOC_FIXTURES.map((doc) => ({
			folder_id: null,
			representative_id: doc.id,
			representative_title: doc.title,
			representative_author: "p1-3-harness",
			representative_doc_status: "progress",
			representative_audience: "exposed",
			representative_format: "html",
			representative_created_at: "2026-08-27T00:00:00.000Z",
			representative_supersedes_id: null,
			member_count: 1,
			group_latest_at: "2026-08-27T00:00:00.000Z",
		})),
		filter: { doc_status: null, author: null, limit: 50, offset: 0 },
		fetched_at: "2026-08-27T00:00:00.000Z",
	};
}

/** 한 블록에서 잰 값 — 폭 계약 세 다리(인라인 max-width · overflow-x · 스크롤)와 렌더 여부. */
interface BlockMeasurement {
	probe: string;
	type: string;
	svgPresent: boolean;
	svgStyleAttr: string;
	svgWidth: number;
	overflowX: string;
	scrollWidth: number;
	clientWidth: number;
}

/** 문서 하나를 연 결과 — 페이지를 닫은 뒤에도 판정할 수 있도록 값만 남긴다. */
interface DocMeasurement {
	blocks: BlockMeasurement[];
	probes: Record<string, RenderProbe>;
	warnings: string[];
	vendorRequests: string[];
}

let app: FastifyInstance;
let serverUrl: string;
let browser: Browser;
const measured = new Map<number, DocMeasurement>();

async function measureBlocks(page: Page): Promise<BlockMeasurement[]> {
	return await page.evaluate(() => {
		// 콜백은 chromium 에서 돎 — tsconfig lib 이 ES2022(DOM 없음)라 브라우저 타입은 국소 선언으로 받음.
		type BlockNode = {
			getAttribute: (name: string) => string | null;
			querySelector: (sel: string) => {
				getAttribute: (name: string) => string | null;
				getBoundingClientRect: () => { width: number };
			} | null;
			scrollWidth: number;
			clientWidth: number;
		};
		const g = globalThis as unknown as {
			document: { querySelectorAll: (sel: string) => ArrayLike<BlockNode> };
			getComputedStyle: (el: BlockNode) => { overflowX: string };
		};
		return Array.from(g.document.querySelectorAll(".doc-body-isolation [data-probe]")).map(
			(node) => {
				const svg = node.querySelector("svg");
				return {
					probe: node.getAttribute("data-probe") || "",
					type: node.getAttribute("data-diagram-type") || "",
					svgPresent: svg !== null,
					svgStyleAttr: svg === null ? "" : svg.getAttribute("style") || "",
					svgWidth: svg === null ? 0 : svg.getBoundingClientRect().width,
					overflowX: g.getComputedStyle(node).overflowX,
					scrollWidth: node.scrollWidth,
					clientWidth: node.clientWidth,
				};
			},
		);
	});
}

/** 목록에서 문서를 열어 본문 다이어그램이 전부 SVG 가 될 때까지 기다린 뒤 잰다. */
async function measureDoc(doc: DocFixture): Promise<DocMeasurement> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	// 감시와 요청 수집은 첫 렌더보다 먼저 붙어야 함 — goto 이후면 초기 건을 놓친다.
	const watch = createFallbackWatch(page);
	const vendorRequests: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes(VENDOR_REQUEST_MARK)) vendorRequests.push(request.url());
	});

	await page.goto(`${serverUrl}/#clauded-docs`, { waitUntil: "load" });
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
		"page-level network prerequisite unmet — the React/mermaid CDN runtime did not load",
	);
	// 전제 먼저 — logLevel 이 3 을 넘으면 아래 "경고 0건" 이 공허해진다.
	await assertFallbackWarningVisible(page);

	await page.click(`tr.doc-row[aria-label="Open ${doc.title}"]`, { timeout: 30_000 });
	for (const diagram of doc.diagrams) {
		await page.waitForSelector(`.doc-body-isolation [data-probe="${diagram.probe}"] svg`, {
			timeout: 30_000,
		});
	}

	const blocks = await measureBlocks(page);
	const probes: Record<string, RenderProbe> = {};
	for (const diagram of doc.diagrams) {
		if (diagram.type !== "flowchart") continue;
		probes[diagram.probe] = await getProbe(
			page,
			`[data-probe="${diagram.probe}"]`,
			`${doc.title} / ${diagram.probe}`,
		);
	}

	const result = { blocks, probes, warnings: [...watch.messages], vendorRequests };
	await page.close();
	return result;
}

function getMeasurement(doc: DocFixture): DocMeasurement {
	const result = measured.get(doc.id);
	assert.ok(result, `${doc.title}: measurement missing — before() did not run`);
	return result;
}

function getBlock(doc: DocFixture, probe: string): BlockMeasurement {
	const block = getMeasurement(doc).blocks.find((entry) => entry.probe === probe);
	assert.ok(block, `${doc.title}: block ${probe} was not rendered into the body`);
	return block;
}

before(async () => {
	app = Fastify({ logger: false });
	await app.register(fastifyStatic, {
		root: PUBLIC_ROOT,
		prefix: "/",
		index: ["index.html"],
	});
	app.get("/api/clauded-docs/groups", async () => getDocGroups());
	app.get<{ Params: { id: string } }>("/api/clauded-docs/:id", async (request, reply) => {
		const doc = DOC_FIXTURES.find((entry) => String(entry.id) === request.params.id);
		if (doc === undefined) return reply.code(404).send({ error: "not_found" });
		return getDocDetail(doc);
	});
	await app.ready();
	serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });

	browser = await chromium.launch({ headless: true });
	for (const doc of DOC_FIXTURES) measured.set(doc.id, await measureDoc(doc));
});

after(async () => {
	await browser?.close();
	await app?.close();
});

describe("document diagrams under the shared ELK config", () => {
	// 픽스처가 조용히 한쪽으로 쏠리는 것을 막는 다리 — 이게 없으면 flowchart 만 남아도 초록이다.
	// AC1 이 요구하는 것은 "채택 타입 중 몇 개" 가 아니라 전부이므로, 선언(diagram-types.json)을
	// 기준으로 빠진 타입을 이름으로 부른다. 채택 목록이 늘면 이 다리가 먼저 붉어진다.
	test("P1-3 the sample set covers every adopted type and an excluded one", () => {
		const types = new Set(DOC_FIXTURES.flatMap((doc) => doc.diagrams.map((d) => d.type)));
		const missing = [...ADOPTED_TYPES].filter((type) => !types.has(type));
		assert.deepStrictEqual(
			missing,
			[],
			`adopted types with no sample block: ${missing.join(", ")} — they render in no measured document`,
		);
		assert.ok(
			[...types].some((type) => EXCLUDED_TYPES.has(type)),
			`samples carry no excluded type: ${[...types].join(", ")}`,
		);
	});

	test("P1-3 every sample block renders to an SVG", () => {
		for (const doc of DOC_FIXTURES) {
			for (const diagram of doc.diagrams) {
				const block = getBlock(doc, diagram.probe);
				assert.equal(
					block.svgPresent,
					true,
					`${doc.title} / ${diagram.probe}: the source stayed as raw <pre> text`,
				);
			}
		}
	});

	test("P1-3 no sample produced a layout fallback warning", () => {
		for (const doc of DOC_FIXTURES) {
			assert.deepStrictEqual(
				getMeasurement(doc).warnings,
				[],
				`${doc.title}: mermaid logged a layout fallback — the diagrams did not lay out through ELK`,
			);
		}
	});

	test("P1-3 flowchart links carry no cubic command and stay orthogonal", () => {
		for (const doc of DOC_FIXTURES) {
			const probes = getMeasurement(doc).probes;
			for (const [probe, rendered] of Object.entries(probes)) {
				if (probe === "fc-optout") continue;
				const cubic = rendered.links.filter((d) => CUBIC_COMMAND.test(d));
				assert.deepStrictEqual(
					cubic,
					[],
					`${doc.title} / ${probe}: cubic path commands present — dagre drew these edges`,
				);
				assertOrthogonalLinks(rendered.links, `${doc.title} / ${probe}`);
			}
		}
	});

	// 대조군 없는 "ELK 로 그렸다" 는 공허함 — 미등록 레이아웃도 dagre 로 조용히 그려지기 때문.
	test("P1-3 a one-line dagre opt-out directive still overrides the global default", () => {
		const probes = getMeasurement(FLOWCHART_HEAVY).probes;
		const elk = probes["fc-control"];
		const dagre = probes["fc-optout"];
		assert.ok(elk && dagre, "the control pair did not render");
		assertLayoutsDiffer(elk, dagre);
		assert.ok(
			findDiagonalSegments(dagre.links, "fc-optout").length > 0,
			`the opt-out block drew no diagonal segment — the directive did not reach the renderer: ${JSON.stringify(dagre.links)}`,
		);
	});

	// 폭 계약(cycle A) — 정적 useMaxWidth:false 는 mermaid-config.tokens.test.ts 소유,
	// 여기서는 그 설정이 실제 산출 SVG 에 남긴 결과만 잰다.
	test("P1-3 adopted-type blocks keep the cycle-A width contract", () => {
		for (const doc of DOC_FIXTURES) {
			for (const diagram of doc.diagrams) {
				if (!ADOPTED_TYPES.has(diagram.type)) continue;
				const block = getBlock(doc, diagram.probe);
				assert.ok(
					!block.svgStyleAttr.includes("max-width"),
					`${doc.title} / ${diagram.probe}: inline max-width survived — ${block.svgStyleAttr}`,
				);
				assert.equal(
					block.overflowX,
					"auto",
					`${doc.title} / ${diagram.probe}: the container does not take the overflow as scroll`,
				);
			}
		}
	});

	// 제외 타입은 타입별 useMaxWidth 해제를 받지 못해 mermaid 가 인라인 max-width 를 찍는다.
	// 위 계약의 양성 대조군 — 이게 없으면 "인라인 max-width 없음" 은 측정이 항상 빈 문자열이어도 초록이다.
	test("P1-3 the excluded type shows the inline max-width the adopted contract removes", () => {
		const gantt = getBlock(EXCLUDED_BESIDE_ADOPTED, "gantt-phases");
		assert.ok(
			gantt.svgStyleAttr.includes("max-width"),
			`the excluded gantt carried no inline max-width (${gantt.svgStyleAttr}) — the measurement cannot see one, so the adopted-type verdict is vacuous`,
		);
	});

	// 위 계약이 "아무것도 넘치지 않아서" 통과하는 경우를 배제 — 넘치는 표본이 최소 하나 있어야 한다.
	test("P1-3 the widest sample overflows its container and scrolls instead of clipping", () => {
		const wide = getBlock(FLOWCHART_HEAVY, "fc-wide");
		assert.ok(
			wide.scrollWidth > wide.clientWidth,
			`fc-wide did not overflow: scrollWidth ${wide.scrollWidth} vs clientWidth ${wide.clientWidth}`,
		);
	});

	// 벤더 IIFE 는 5MB 짜리 단일 파일 — 문서를 여는 동안 두 번 실려서는 안 되고,
	// 0 건이면 위 "폴백 경고 0건" 이 등록 없이 통과한 것이다.
	//
	// 이 단언은 "미뤄서 받는가" 를 재지 않는다: 청취기가 #clauded-docs 로 가는 goto 에 붙어 있어,
	// 모든 라우트에서 동기로 받던 예전 <script src> 배치도 여기서는 똑같이 1 건으로 보인다.
	// 그 구별(다이어그램 없는 라우트 0 건 · 다이어그램 라우트 1 건)은 AC-후속-4a(i) 의 몫이고
	// test/architecture.merged-surface.e2e.test.ts 에 산다.
	test("P1-3 opening a document pulls the vendor loader exactly once", () => {
		for (const doc of DOC_FIXTURES) {
			assert.equal(
				getMeasurement(doc).vendorRequests.length,
				1,
				`${doc.title}: vendor loader requests ${JSON.stringify(getMeasurement(doc).vendorRequests)}`,
			);
		}
	});
});
