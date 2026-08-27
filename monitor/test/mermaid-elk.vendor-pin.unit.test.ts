// P0-1 — vendored ELK bundle supply-chain pin, browserless.
// Runner: npx tsx --test test/mermaid-elk.vendor-pin.unit.test.ts
//
// Split out of mermaid-elk.loader.test.ts on the security verdict: every claim in
// that file sits under a before() that launches chromium and pulls mermaid from a
// CDN, so a leg without a browser or without outbound network never executes the
// pins at all — a swapped bundle would ship green. Nothing here opens a socket or a
// browser: fs + crypto only, so the pins run in every leg. Registration behaviour
// (does `layout: elk` actually reach ELK) stays in the e2e, which is the only place
// it can be measured.
//
// Four claims: the bundle on disk is the byte sequence its sidecar pins; index.html
// loads exactly that file, in the one document order that makes synchronous
// registration work; the sidecar's tarball hash is the hash npm itself resolved
// (package-lock.json is the second, independently-produced witness); and every
// package the bundle embeds carries a license notice, which the esbuild build
// stripped with --legal-comments=none.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_ROOT = resolve(HERE, "..");
const PUBLIC_ROOT = resolve(MONITOR_ROOT, "public");
const VENDOR_ROOT = resolve(PUBLIC_ROOT, "assets", "vendor");
const PROVENANCE_PATH = resolve(VENDOR_ROOT, "mermaid-layout-elk.provenance.json");
const NOTICES_PATH = resolve(VENDOR_ROOT, "THIRD-PARTY-NOTICES.md");
const INDEX_PATH = resolve(PUBLIC_ROOT, "index.html");
const LOCK_PATH = resolve(MONITOR_ROOT, "package-lock.json");

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

	test("AC-1 index.html loads exactly the vendored file the sidecar names", async () => {
		const provenance = await getProvenance();
		const html = await readFile(INDEX_PATH, "utf8");

		// "정확히 그 파일" — 포함 검사로는 사이드카가 모르는 두 번째 벤더 스크립트를 못 잡는다.
		const vendorSrcs = [...html.matchAll(/src="(assets\/vendor\/[^"]+)"/g)].map((m) => m[1]);
		assert.deepStrictEqual(
			vendorSrcs,
			[`assets/vendor/${provenance.bundle_file}`],
			"index.html must load the sidecar-named vendor bundle and nothing else from that directory",
		);

		// 문서 순서 — mermaid 전역이 먼저 있어야 동기 등록이 성립하고(ADR-1),
		// 등록은 initialize 보다 앞서야 한다. 순서가 무너지면 layout:'elk' 가 조용히 dagre 로 떨어짐.
		const mermaidAt = html.indexOf("mermaid@11/dist/mermaid.min.js");
		const vendorAt = html.indexOf(vendorSrcs[0]);
		const registerAt = html.indexOf("registerLayoutLoaders");
		const initializeAt = html.indexOf("window.mermaid?.initialize(");
		assert.ok(mermaidAt >= 0, "index.html must load the mermaid UMD script");
		assert.ok(registerAt >= 0, "index.html must call registerLayoutLoaders");
		assert.ok(initializeAt >= 0, "index.html must call window.mermaid?.initialize(");
		assert.ok(mermaidAt < vendorAt, "the vendored loader must be loaded after the mermaid UMD script");
		assert.ok(vendorAt < registerAt, "registration must follow the vendored loader in document order");
		assert.ok(registerAt < initializeAt, "layout loaders must be registered before mermaid.initialize");
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
