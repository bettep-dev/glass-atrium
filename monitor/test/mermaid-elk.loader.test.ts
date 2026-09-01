// P0-1 — vendored ELK layout loader proof.
// Runner: npx tsx --test test/mermaid-elk.loader.test.ts
//
// Three claims, none of which the others cover: a `layout: elk` directive actually
// reaches ELK (proved by a dagre control, since an unregistered layout renders fine
// on the dagre fallback), the console watch that certifies "no fallback warning" is
// itself capable of catching one, and the awaited prep call is what removes that
// warning rather than the page having been quiet all along.
//
// The vendored bundle is no longer fetched by a tag in index.html; it arrives when
// window.ensureElkLayout() is first called, and the two viewer render paths await that
// promise before mermaid.render (asserted on their source in the vendor-pin harness).
// This file therefore awaits it too — a probe that renders without awaiting is measuring
// a page in a state the viewer never renders in, which is exactly what the control below
// renders on purpose.
//
// The supply-chain pins that used to live here — bundle sha256/bytes vs the sidecar,
// and the index.html load order — moved to mermaid-elk.vendor-pin.unit.test.ts. They
// sat under the before() below, so a leg without chromium or without network never
// ran them; browserless, they run everywhere.
//
// App: stripped Fastify (fastify-static over public/) on an ephemeral port —
// index.html is loaded as shipped, so the registration wiring under test is the
// production one. Page-level network prerequisite: mermaid comes from CDN, so the
// run REQUIRES outbound network and an installed chromium; an unmet prerequisite
// fails RED in before.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
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

// 3노드 스모크 — 갈래가 있어야 두 레이아웃의 배치 차이가 좌표에 남음.
const SMOKE_GRAPH = ["flowchart TD", "  A[Alpha] --> B[Bravo]", "  A --> C[Charlie]"].join("\n");

// ADR-2 한 줄 지시자 형식(물리적 1줄 · JSON 인용 키) — P0-2 가 canonical map 에 쓸 경로와 동일.
function getSmokeSource(layout: string): string {
	return `%%{init: {"layout": "${layout}"}}%%\n${SMOKE_GRAPH}`;
}

interface PageContext {
	app: FastifyInstance;
	browser: Browser;
	page: Page;
	watch: FallbackWatch;
	/** 준비 여부는 사실로만 싣는다 — 단정은 ctx 가 대입된 뒤 before() 가 한다(아래 누수 주석). */
	runtimeReady: boolean;
}

async function openPageContext(): Promise<PageContext> {
	const app = Fastify({ logger: false });
	let browser: Browser | undefined;
	try {
		await app.register(fastifyStatic, {
			root: PUBLIC_ROOT,
			prefix: "/",
			index: ["index.html"],
		});
		await app.ready();
		const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });

		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		// 감시는 첫 렌더보다 먼저 붙어야 함 — goto 이후에 붙이면 초기 경고를 놓침.
		const watch = createFallbackWatch(page);
		await page.goto(`${serverUrl}/`, { waitUntil: "load" });

		// 여기서 단정하지 않는 이유: 던지면 호출부의 ctx 가 영영 대입되지 않아 after() 의 `ctx?.…` 정리가
		// 통째로 건너뛰어지고, 살아남은 브라우저와 리스닝 서버가 이벤트 루프를 붙잡는다. node 는
		// --test-timeout=0 으로 도니 그 상태는 실패가 아니라 무한 대기 — CI 한 다리가 붉어지는 대신 멈춘다.
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

		return { app, browser, page, watch, runtimeReady };
	} catch (cause) {
		// 컨텍스트를 만들다 던지는 경로에도 같은 누수가 있다 — 만든 것만 되돌리고 원인은 그대로 올린다.
		// allSettled 인 이유는 정리 실패가 진짜 원인인 cause 를 덮지 않게 하려는 것.
		await Promise.allSettled([browser?.close(), app.close()]);
		throw cause;
	}
}

describe("vendored ELK layout loader", () => {
	let ctx: PageContext;
	let elk: RenderProbe;
	let dagre: RenderProbe;
	let beforePrepWarnings: string[];

	before(async () => {
		ctx = await openPageContext();
		// 대입 뒤에 단정 — 이 순서라야 실패가 after() 의 정리를 거쳐 붉게 끝난다(openPageContext 주석).
		assert.equal(
			ctx.runtimeReady,
			true,
			"page-level network prerequisite unmet — the mermaid CDN runtime did not load",
		);
		// 전제 먼저 — logLevel 이 3 을 넘으면 아래 경고 단언 전부가 공허해짐.
		await assertFallbackWarningVisible(ctx.page);

		// 대조군 — 준비를 기다리지 않고 그린다. 번들은 아직 도착 전이므로 등록도 전이고, mermaid 는
		// 폴백 경고를 낸다. 이 한 건이 있어야 아래 "경고 0건" 이 "await 덕분" 이라는 뜻이 된다.
		await getRenderProbe(ctx.page, "smoke-before-prep", getSmokeSource("elk"));
		beforePrepWarnings = [...ctx.watch.messages];
		ctx.watch.clear();

		// 렌더 경로가 하는 그대로 — 그리기 전에 준비를 기다린다.
		const prepReady = await ctx.page.evaluate(async () => {
			const w = window as never as { ensureElkLayout?: () => Promise<void> };
			if (typeof w.ensureElkLayout !== "function") return false;
			await w.ensureElkLayout();
			return true;
		});
		assert.equal(
			prepReady,
			true,
			"the shipped page assigned no window.ensureElkLayout — index.html must load mermaid-elk-loader.js",
		);

		elk = await getRenderProbe(ctx.page, "smoke-elk", getSmokeSource("elk"));
		dagre = await getRenderProbe(ctx.page, "smoke-dagre", getSmokeSource("dagre"));
	});

	after(async () => {
		await ctx?.browser?.close();
		await ctx?.app?.close();
	});

	test("AC-2 an elk directive renders with zero fallback warnings", () => {
		assert.deepStrictEqual(
			ctx.watch.messages,
			[],
			"mermaid logged a layout fallback — the ELK loaders were not registered",
		);
		assert.ok(Object.keys(elk.nodes).length === 3, `rendered nodes: ${Object.keys(elk.nodes).join(", ")}`);
	});

	// 위 단언의 대조군. 같은 페이지·같은 소스인데 준비를 기다렸는지만 다르다 — 그래서 이 둘이
	// 함께 통과할 때에만 "0건" 이 등록이 일어났다는 증거가 된다.
	test("AC-2 the same render without awaiting the prep does warn", () => {
		assert.ok(
			beforePrepWarnings.length > 0,
			"a render issued before window.ensureElkLayout() resolved produced no fallback warning — then the zero count above is not evidence that awaiting it registered anything",
		);
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
