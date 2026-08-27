// P0-1 — vendored ELK layout loader proof.
// Runner: npx tsx --test test/mermaid-elk.loader.test.ts
//
// Three claims, none of which the others cover: the vendored bundle on disk is the
// one the provenance sidecar describes; a `layout: elk` directive actually reaches
// ELK (proved by a dagre control, since an unregistered layout renders fine on the
// dagre fallback); and the console watch that certifies "no fallback warning" is
// itself capable of catching one.
//
// App: stripped Fastify (fastify-static over public/) on an ephemeral port —
// index.html is loaded as shipped, so the registration wiring under test is the
// production one. Page-level network prerequisite: mermaid comes from CDN, so the
// run REQUIRES outbound network and an installed chromium; an unmet prerequisite
// fails RED in before.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
	findNonOrthogonalPairs,
	getFlatPoints,
	getRenderProbe,
	type FallbackWatch,
	type RenderProbe,
} from "./lib/mermaid-elk-probe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const VENDOR_ROOT = resolve(PUBLIC_ROOT, "assets", "vendor");
const PROVENANCE_PATH = resolve(VENDOR_ROOT, "mermaid-layout-elk.provenance.json");
const INDEX_PATH = resolve(PUBLIC_ROOT, "index.html");

interface VendorProvenance {
	package: string;
	version: string;
	bundle_file: string;
	bundle_sha256: string;
	bundle_bytes: number;
	tarball_sha512: string;
	build_command: string;
	global_name: string;
}

// 3노드 스모크 — 갈래가 있어야 두 레이아웃의 배치 차이가 좌표에 남음.
const SMOKE_GRAPH = ["flowchart TD", "  A[Alpha] --> B[Bravo]", "  A --> C[Charlie]"].join("\n");

// ADR-2 한 줄 지시자 형식(물리적 1줄 · JSON 인용 키) — P0-2 가 canonical map 에 쓸 경로와 동일.
function getSmokeSource(layout: string): string {
	return `%%{init: {"layout": "${layout}"}}%%\n${SMOKE_GRAPH}`;
}

async function getProvenance(): Promise<VendorProvenance> {
	return JSON.parse(await readFile(PROVENANCE_PATH, "utf8")) as VendorProvenance;
}

interface PageContext {
	app: FastifyInstance;
	browser: Browser;
	page: Page;
	watch: FallbackWatch;
}

async function openPageContext(): Promise<PageContext> {
	const app = Fastify({ logger: false });
	await app.register(fastifyStatic, {
		root: PUBLIC_ROOT,
		prefix: "/",
		index: ["index.html"],
	});
	await app.ready();
	const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });

	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	// 감시는 첫 렌더보다 먼저 붙어야 함 — goto 이후에 붙이면 초기 경고를 놓침.
	const watch = createFallbackWatch(page);
	await page.goto(`${serverUrl}/`, { waitUntil: "load" });

	const runtimeReady = await page
		.waitForFunction(
			() => Boolean((window as never as { mermaid?: unknown }).mermaid),
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
		"page-level network prerequisite unmet — the mermaid CDN runtime did not load",
	);

	return { app, browser, page, watch };
}

describe("vendored ELK layout loader", () => {
	let ctx: PageContext;
	let elk: RenderProbe;
	let dagre: RenderProbe;

	before(async () => {
		ctx = await openPageContext();
		// 전제 먼저 — logLevel 이 3 을 넘으면 아래 경고 단언 전부가 공허해짐.
		await assertFallbackWarningVisible(ctx.page);
		elk = await getRenderProbe(ctx.page, "smoke-elk", getSmokeSource("elk"));
		dagre = await getRenderProbe(ctx.page, "smoke-dagre", getSmokeSource("dagre"));
	});

	after(async () => {
		await ctx?.browser?.close();
		await ctx?.app?.close();
	});

	test("AC-1 vendored bundle sha256 matches its provenance sidecar", async () => {
		const provenance = await getProvenance();
		const bundle = await readFile(resolve(VENDOR_ROOT, provenance.bundle_file));
		assert.equal(
			createHash("sha256").update(bundle).digest("hex"),
			provenance.bundle_sha256,
			`${provenance.bundle_file} content does not match the sha256 its sidecar pins`,
		);
		assert.equal(bundle.byteLength, provenance.bundle_bytes, "bundle byte length vs sidecar");
	});

	test("AC-1 index.html loads exactly the vendored file the sidecar names", async () => {
		const provenance = await getProvenance();
		const html = await readFile(INDEX_PATH, "utf8");
		const vendorSrc = `assets/vendor/${provenance.bundle_file}`;
		assert.ok(
			html.includes(vendorSrc),
			`index.html must load ${vendorSrc} — a renamed bundle with a stale sidecar would otherwise pass AC-1`,
		);
		// 문서 순서 — mermaid 전역이 먼저 있어야 동기 등록이 성립(ADR-1).
		assert.ok(
			html.indexOf("mermaid@11/dist/mermaid.min.js") < html.indexOf(vendorSrc),
			"the vendored loader must be loaded after the mermaid UMD script",
		);
		assert.ok(
			html.indexOf(vendorSrc) < html.indexOf("registerLayoutLoaders"),
			"registration must follow the vendored loader in document order",
		);
	});

	test("AC-2 an elk directive renders with zero fallback warnings", () => {
		assert.deepStrictEqual(
			ctx.watch.messages,
			[],
			"mermaid logged a layout fallback — the ELK loaders were not registered",
		);
		assert.ok(Object.keys(elk.nodes).length === 3, `rendered nodes: ${Object.keys(elk.nodes).join(", ")}`);
	});

	test("AC-3 the same source under dagre yields different node coordinates", () => {
		assertLayoutsDiffer(elk, dagre);
	});

	test("AC-3 ELK edges are orthogonal under the ADR-3 verdict", () => {
		assertOrthogonalLinks(elk.links, "smoke flowchart under layout: elk");
	});

	// 감시기 자체의 반증 가능성 — 등록될 리 없는 레이아웃을 요청해 경고가 실제로 잡히는지 잰다.
	// 이게 없으면 위 "경고 0건" 은 문자열이 영영 안 맞아도 초록임.
	test("AC-2 the fallback watch catches a genuinely unregistered layout", async () => {
		ctx.watch.clear();
		await getRenderProbe(ctx.page, "smoke-unregistered", getSmokeSource("no-such-layout"));
		assert.ok(
			ctx.watch.messages.length > 0,
			"an unregistered layout produced no captured warning — the watch cannot certify anything",
		);
		ctx.watch.clear();
	});
});

describe("orthogonality verdict (ADR-3)", () => {
	test("a rounded orthogonal path passes", () => {
		const points = getFlatPoints("M 10,10 L 10,40 Q 10,45 15,45 L 60,45 L 90,45");
		assert.deepStrictEqual(findNonOrthogonalPairs(points), []);
	});

	test("a diagonal interior segment is caught", () => {
		const points = getFlatPoints("M 10,10 L 10,40 L 60,90 L 60,120 L 60,150");
		assert.deepStrictEqual(findNonOrthogonalPairs(points), [1]);
	});

	test("first and last segments are exempt from the axis check", () => {
		const points = getFlatPoints("M 10,10 L 14,40 L 14,80 L 18,110");
		assert.deepStrictEqual(findNonOrthogonalPairs(points), []);
	});

	test("an unsupported command throws instead of passing silently", () => {
		assert.throws(
			() => getFlatPoints("M 10,10 C 20,20 30,30 40,40"),
			/unsupported path command 'C'/,
		);
	});
});

// 대조군을 "대각을 가졌다" 로 세우는 쪽의 판정. 통과 실패와 파싱 실패가 갈라지는지가 요점.
describe("positive diagonal count over curve commands", () => {
	test("a dagre-style cubic is counted as diagonal, not merely unparseable", () => {
		const hits = findDiagonalSegments(["M100,50C100,75 140,90 180,110C220,130 260,145 300,170"], "cubic");
		assert.ok(hits.length > 0, `expected diagonal control-point pairs, got ${JSON.stringify(hits)}`);
	});

	test("an orthogonal path counts zero under the same rule", () => {
		assert.deepStrictEqual(
			findDiagonalSegments(["M 10,10 L 10,40 Q 10,45 15,45 L 60,45 L 90,45"], "orthogonal"),
			[],
		);
	});

	test("a truly unknown command throws rather than counting as diagonal", () => {
		assert.throws(
			() => findDiagonalSegments(["M 10,10 A 5,5 0 0 1 20,20"], "arc"),
			/unsupported path command 'A'/,
		);
	});

	test("an empty link list is refused instead of counting zero", () => {
		assert.throws(() => findDiagonalSegments([], "empty"), /diagonal count would be vacuous/);
	});
});
