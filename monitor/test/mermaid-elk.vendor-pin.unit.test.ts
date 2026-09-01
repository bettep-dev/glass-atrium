// P0-1 — vendored ELK bundle supply-chain pin, browserless.
// Runner: npx tsx --test test/mermaid-elk.vendor-pin.unit.test.ts
//
// Split out of mermaid-elk.loader.test.ts on the security verdict: every claim in
// that file sits under a before() that launches chromium and pulls mermaid from a
// CDN, so a leg without a browser or without outbound network never executes the
// pins at all — a swapped bundle would ship green. Nothing here opens a socket or a
// browser: fs + crypto plus a node:vm evaluation of one repo-owned script, so the
// pins run in every leg. Whether `layout: elk` actually reaches ELK stays in the
// browser suites, which are the only place it can be measured.
//
// Seven claims: the bundle on disk is the byte sequence its sidecar pins; index.html
// hands that bundle to the on-demand loader instead of fetching it eagerly itself;
// the loader names exactly the file the sidecar names and nothing else from that
// directory; the loader injects that file BEFORE it registers and does both once per
// page; a bundle already on the page registers without a fetch and one that fails to
// arrive resolves loudly rather than stranding its callers; every viewer render path
// awaits the loader before it renders; the sidecar's tarball hash is the hash npm
// itself resolved (package-lock.json is the second, independently-produced witness);
// and every package the bundle embeds carries a license notice, which the esbuild
// build stripped with --legal-comments=none.
//
// Why several of those replace one position check on index.html: the eager
// `<script src="assets/vendor/…">` is gone, so document order no longer decides
// anything. What that order stood for — a diagram never draws on a layout nobody
// registered — is now carried by the loader's own inject→register sequence and by the
// render paths that await it, so both are asserted by RUNNING the loader against a
// stub. That measures the sequence instead of inferring it from where two tags sit.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_ROOT = resolve(HERE, "..");
const PUBLIC_ROOT = resolve(MONITOR_ROOT, "public");
const VENDOR_ROOT = resolve(PUBLIC_ROOT, "assets", "vendor");
const PROVENANCE_PATH = resolve(VENDOR_ROOT, "mermaid-layout-elk.provenance.json");
const NOTICES_PATH = resolve(VENDOR_ROOT, "THIRD-PARTY-NOTICES.md");
const INDEX_PATH = resolve(PUBLIC_ROOT, "index.html");
const LOADER_PATH = resolve(PUBLIC_ROOT, "mermaid-elk-loader.js");
const LOCK_PATH = resolve(MONITOR_ROOT, "package-lock.json");

// 뷰어의 두 렌더 경로. 세 번째 소비자인 내보내기는 브라우저 밖 드라이버라 산출물로 재는 쪽이
// 정확하다 — test/html-export-elk-parity.test.ts 가 그 판정을 갖는다.
const VIEWER_RENDER_PATHS = [
	"public/src/screens/architecture.jsx",
	"public/src/screens/clauded-docs.jsx",
] as const;

interface EmbeddedPackage {
	package: string;
	version: string;
	license: string;
	note?: string;
}

interface VendorProvenance {
	package: string;
	version: string;
	registry: string;
	tarball_url: string;
	global_name: string;
	bundle_file: string;
	bundle_sha256: string;
	bundle_bytes: number;
	tarball_sha512: string;
	build_command: string;
	embedded: EmbeddedPackage[];
}

interface LockEntry {
	version?: string;
	resolved?: string;
	integrity?: string;
}

interface PackageLock {
	packages?: Record<string, LockEntry>;
}

async function getProvenance(): Promise<VendorProvenance> {
	return JSON.parse(await readFile(PROVENANCE_PATH, "utf8")) as VendorProvenance;
}

/** 사이드카가 이름을 적은 파일의, index.html 기준 상대 경로. 기대값을 테스트에 적어두면 그 사본이 드리프트한다. */
async function getVendorSrc(): Promise<string> {
	return `assets/vendor/${(await getProvenance()).bundle_file}`;
}

// ── 로더 실행 하네스 (browserless) ───────────────────────────────────────────
// 로더는 import/export 없는 고전 스크립트 IIFE 라 vm 컨텍스트에서 그대로 돈다. 문서 위치가
// 아니라 실제로 일어난 일의 순서를 재려는 것이므로, 스텁은 값이 아니라 사건을 기록한다.

/** 로더가 만드는 <script> 가 건드리는 만큼만 — src / async / addEventListener. */
interface StubScript {
	src: string;
	async: boolean;
	listeners: Map<string, () => void>;
	addEventListener(type: string, handler: () => void): void;
}

/** 한 번의 실행에서 관측한 것 — 사건의 순서, 등록에 실린 값, 실제로 요청한 경로. */
interface LoaderRun {
	events: string[];
	registered: unknown[];
	vendorSrcs: string[];
	ensure(): Promise<void>;
}

// 벤더 IIFE 가 남기는 전역을 대신하는 표식. 등록 인자가 이 객체와 같은지로 "도착한 번들을
// 등록했는가" 와 "빈 목록으로 등록해 조용히 dagre 로 눕는가" 가 갈린다.
const ELK_LOADERS = [{ name: "elk-loader-stub" }];

async function runLoader(
	options: { alreadyArrived?: boolean; loadFails?: boolean } = {},
): Promise<LoaderRun> {
	const events: string[] = [];
	const registered: unknown[] = [];
	const vendorSrcs: string[] = [];

	const windowStub: Record<string, unknown> = {
		mermaid: {
			registerLayoutLoaders(loaders: unknown): void {
				events.push("register");
				registered.push(loaders);
			},
		},
	};
	if (options.alreadyArrived === true) windowStub.mermaidLayoutElk = { default: ELK_LOADERS };

	const documentStub = {
		createElement(tag: string): StubScript {
			events.push(`create:${tag}`);
			const listeners = new Map<string, () => void>();
			return {
				src: "",
				async: true,
				listeners,
				addEventListener(type: string, handler: () => void): void {
					listeners.set(type, handler);
				},
			};
		},
		head: {
			appendChild(el: StubScript): void {
				vendorSrcs.push(el.src);
				events.push(`inject:${el.src}`);
				// 브라우저가 하는 순서 그대로 — 받아온 번들이 전역을 남긴 다음에 load 가 뜬다.
				queueMicrotask(() => {
					if (options.loadFails === true) {
						events.push("error");
						el.listeners.get("error")?.();
						return;
					}
					windowStub.mermaidLayoutElk = { default: ELK_LOADERS };
					events.push("load");
					el.listeners.get("load")?.();
				});
			},
		},
	};

	// SECURITY: node:vm 샌드박스에서 저장소 소유 정적 자산 하나만 평가한다 — 외부 입력을 실행하지
	// 않으며 모양은 test/client-sandbox.ts 와 같다. new Function 을 쓰지 않는 이유는
	// test/lib/mermaid-config-source.ts 의 단일-사이트 지시 — 그 shape 를 두 곳에 두지 않는다.
	const ctx: Record<string, unknown> = {
		window: windowStub,
		document: documentStub,
		console: {
			warn(): void {
				events.push("warn");
			},
		},
	};
	ctx.globalThis = ctx;
	vm.createContext(ctx);
	vm.runInContext(await readFile(LOADER_PATH, "utf8"), ctx);

	const ensure = windowStub.ensureElkLayout;
	assert.equal(
		typeof ensure,
		"function",
		"public/mermaid-elk-loader.js must assign window.ensureElkLayout — the render paths call nothing else",
	);
	return { events, registered, vendorSrcs, ensure: ensure as () => Promise<void> };
}

describe("vendored ELK bundle pin (no browser, no network)", () => {
	test("AC-1 the bundle on disk is the byte sequence its sidecar pins", async () => {
		const provenance = await getProvenance();
		const bundle = await readFile(resolve(VENDOR_ROOT, provenance.bundle_file));
		assert.equal(
			createHash("sha256").update(bundle).digest("hex"),
			provenance.bundle_sha256,
			`${provenance.bundle_file} content does not match the sha256 its sidecar pins`,
		);
		assert.equal(bundle.byteLength, provenance.bundle_bytes, "bundle byte length vs sidecar");
	});

	test("AC-1 index.html hands the vendored bundle to the on-demand loader", async () => {
		const html = await readFile(INDEX_PATH, "utf8");

		// index.html 이 벤더 파일을 직접 받던 자리 — 다이어그램 하나 없는 라우트에서도 5 MB 를
		// 동기로 받아 첫 페인트를 늦추던 태그다. "정확히 하나" 보다 좁은 "하나도 없어야 한다" 로
		// 바뀌었고, 사이드카가 모르는 둘째 벤더 스크립트도 같은 단언 하나에 함께 걸린다.
		const vendorSrcs = [...html.matchAll(/src="(assets\/vendor\/[^"]+)"/g)].map((m) => m[1]);
		assert.deepStrictEqual(
			vendorSrcs,
			[],
			"index.html loads a vendor script eagerly again — the on-demand loader owns that fetch now",
		);

		// 버전이 아니라 모양으로 찾는다 — 리터럴로 두면 CDN 태그 고정이 이 파일까지 함께 고쳐야 하는 일이 된다.
		const mermaidAt = html.search(/mermaid@[\d.]+\/dist\/mermaid\.min\.js/);
		const loaderAt = html.indexOf('src="mermaid-elk-loader.js"');
		assert.ok(mermaidAt >= 0, "index.html must load the mermaid UMD script");
		assert.ok(loaderAt >= 0, "index.html must load public/mermaid-elk-loader.js");
		// 등록은 mermaid 전역 위에서만 성립한다(ADR-1). 등록 시점이 렌더 직전으로 늦춰졌어도 그
		// 전제는 그대로여서, UMD 태그가 로더보다 뒤로 가면 준비 함수는 조용히 아무것도 등록하지 않는다.
		assert.ok(mermaidAt < loaderAt, "the ELK loader must be loaded after the mermaid UMD script");
	});

	test("AC-1 the loader names exactly the vendored file the sidecar names", async () => {
		const vendorSrc = await getVendorSrc();
		const source = await readFile(LOADER_PATH, "utf8");

		// 모듈 안의 벤더 경로 문자열. 여기와 사이드카가 갈라지면 뷰어는 404 를 먹고 dagre 로 눕는다.
		// 통째 주석 줄은 걷어내고 본다 — 머리말이 대체한 태그를 산문으로 인용하고 있어서,
		// 인용까지 세면 "코드가 이 디렉터리에서 무엇을 가리키는가" 가 아니라 문장을 재게 된다.
		const code = source.replace(/^[ \t]*\/\/.*$/gm, "");
		assert.deepStrictEqual(
			[...code.matchAll(/"(assets\/vendor\/[^"]+)"/g)].map((m) => m[1]),
			[vendorSrc],
			"the loader must name the sidecar-named vendor bundle and nothing else from that directory",
		);

		// 문자열이 있다는 것과 그것을 요청한다는 것은 다른 주장 — 실행해서 요청 경로로 확인한다.
		const run = await runLoader();
		await run.ensure();
		assert.deepStrictEqual(
			run.vendorSrcs,
			[vendorSrc],
			"the loader requested a path other than the one the sidecar names",
		);
	});

	test("AC-1 the loader injects the bundle before it registers, once per page", async () => {
		const vendorSrc = await getVendorSrc();
		const run = await runLoader();

		await run.ensure();
		assert.deepStrictEqual(
			run.events,
			["create:script", `inject:${vendorSrc}`, "load", "register"],
			"the loader must fetch the bundle and only then register — registering first hands layout:'elk' to dagre",
		);
		assert.deepStrictEqual(
			run.registered,
			[ELK_LOADERS],
			"registration did not receive the arrived bundle's loaders — an empty list registers nothing and falls back silently",
		);

		// 같은 페이지의 둘째·셋째 다이어그램은 기억된 약속을 그대로 받아야 한다 —
		// 기억이 깨지면 5 MB 를 다이어그램마다 다시 받고 등록도 다시 돈다.
		await run.ensure();
		await run.ensure();
		assert.deepStrictEqual(
			run.events,
			["create:script", `inject:${vendorSrc}`, "load", "register"],
			"a repeat call re-ran the loader — the vendored bundle is fetched again per diagram",
		);
	});

	test("AC-1 a bundle already on the page registers without a fetch", async () => {
		const run = await runLoader({ alreadyArrived: true });
		await run.ensure();
		assert.deepStrictEqual(
			run.events,
			["register"],
			"the loader fetched a bundle that was already present — this is the branch the HTML export takes, where the text is injected, not fetched",
		);
		assert.deepStrictEqual(run.registered, [ELK_LOADERS], "the already-present bundle was not the one registered");
	});

	test("AC-1 a bundle that fails to arrive resolves loudly instead of stranding its callers", async () => {
		const vendorSrc = await getVendorSrc();
		const run = await runLoader({ loadFails: true });
		await run.ensure();
		assert.deepStrictEqual(
			run.events,
			["create:script", `inject:${vendorSrc}`, "error", "warn", "register"],
			"a failed vendor load must warn and resolve — rejecting strands every render path that awaits it, and silence hides the fallback",
		);
		const loaders = run.registered[0];
		assert.ok(
			Array.isArray(loaders) && loaders.length === 0,
			`registration received ${JSON.stringify(loaders)} after a failed load — the empty-list posture is what keeps the diagram drawing on dagre`,
		);
	});

	test("AC-1 every viewer render path awaits the loader before it renders", async () => {
		for (const relative of VIEWER_RENDER_PATHS) {
			const source = await readFile(resolve(MONITOR_ROOT, relative), "utf8");

			// 렌더 호출은 경로당 하나. 둘째가 생기면 그 자리는 아래 사슬 밖일 수 있으므로 조용히
			// 통과시키지 않고 여기서 붉어져 다시 읽히게 한다.
			assert.equal(
				[...source.matchAll(/window\.mermaid\.render\(/g)].length,
				1,
				`${relative} has more than one mermaid.render call site — re-check that each of them awaits window.ensureElkLayout`,
			);
			assert.match(
				source,
				/const elkReady = window\.ensureElkLayout \? window\.ensureElkLayout\(\) : Promise\.resolve\(\);/,
				`${relative} does not consult window.ensureElkLayout — layout:'elk' would draw on dagre`,
			);
			assert.match(
				source,
				/elkReady[\s\S]{0,80}?\.then\(\s*\(\)\s*=>[\s\S]{0,80}?window\.mermaid\.render\(/,
				`${relative} calls mermaid.render outside the elkReady chain — the render can start before ELK is registered`,
			);
		}
	});

	test("AC-1 the sidecar's tarball hash is the one npm resolved", async () => {
		const provenance = await getProvenance();
		const lock = JSON.parse(await readFile(LOCK_PATH, "utf8")) as PackageLock;
		const key = `node_modules/${provenance.package}`;
		const entry = lock.packages?.[key];
		assert.ok(entry, `package-lock.json carries no ${key} entry to cross-check the sidecar against`);

		assert.equal(entry.version, provenance.version, "sidecar version vs package-lock version");
		assert.equal(
			entry.integrity,
			provenance.tarball_sha512,
			"sidecar tarball_sha512 disagrees with the integrity npm recorded — the vendored bundle was built from a tarball the lock does not describe",
		);
		// 출처 URL 은 origin 으로 비교 — 문자열 prefix 비교는 registry.npmjs.org.evil.com 류를 통과시킨다.
		assert.ok(entry.resolved, "package-lock entry carries no resolved URL");
		assert.equal(
			new URL(entry.resolved).origin,
			new URL(provenance.registry).origin,
			"sidecar registry origin vs the origin npm resolved the tarball from",
		);
		assert.equal(provenance.tarball_url, entry.resolved, "sidecar tarball_url vs package-lock resolved URL");
	});

	test("AC-1 every package the bundle embeds carries a license notice", async () => {
		const provenance = await getProvenance();
		const notices = await readFile(NOTICES_PATH, "utf8");
		const lines = notices.split("\n");

		// 빈 목록이면 아래 루프가 공허하게 통과함 — 사이드카가 embedded 를 잃는 쪽도 실패여야 한다.
		assert.ok(
			provenance.embedded.length >= 3,
			`sidecar lists ${provenance.embedded.length} embedded packages — too few to be the bundle's real dependency set`,
		);
		// 빌드가 법적 주석을 벗겨낸다는 사실 자체가 이 파일의 존재 이유 — 빌드 커맨드가 바뀌면 재확인 대상.
		assert.ok(
			provenance.build_command.includes("--legal-comments=none"),
			"build no longer strips legal comments — re-check whether this notices file is still the only carrier",
		);

		for (const dep of provenance.embedded) {
			const row = lines.find((line) => line.includes(`\`${dep.package}\``) && line.includes("|"));
			assert.ok(row, `THIRD-PARTY-NOTICES.md lists no entry for embedded package ${dep.package}`);
			assert.ok(row.includes(dep.version), `${dep.package} notice does not name version ${dep.version}`);
			assert.ok(row.includes(dep.license), `${dep.package} notice does not carry its ${dep.license} license identifier`);
			assert.match(row, /https:\/\/\S+/, `${dep.package} notice carries no upstream repository URL`);
		}
	});
});
