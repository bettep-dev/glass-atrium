// P1-1 — the shared mermaid runtime config (public/mermaid-config.js), read as the
// one source both viewer surfaces initialize from.
// Runner: npx tsx --test test/mermaid-config.tokens.test.ts
//
// Four claims, none of which the others cover: the colour values are derived from
// the shipped tokens.css dark block rather than hand-copied, the two keys the ELK
// proof and the fallback-warning watch stand on carry the values those harnesses
// assume, the per-type width contract covers every adopted diagram type, and
// index.html reads the file instead of carrying a second copy of it.
//
// Browserless: the config is a classic script assigning one global, so a bare
// `window` stub evaluates it — no chromium, no network, runs on every leg.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { evaluateMermaidConfig } from "./lib/mermaid-config-source.js";
import { compositeOver, relativeLuminance, type Rgba } from "./lib/wcag-contrast.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_ROOT = resolve(HERE, "..");
const INDEX_PATH = resolve(MONITOR_ROOT, "public/index.html");
const TOKENS_PATH = resolve(MONITOR_ROOT, "public/styles/tokens.css");
const DECLARATION_PATH = resolve(MONITOR_ROOT, "src/server/clauded-docs/diagram-types.json");

// mermaid 의 폴백 경고는 logLevel 4 이상에서 log.warn 이 no-op 이라 아예 나오지 않음.
const WARN_LOG_LEVEL = 3;

// §6 muted/soft — ink 를 캔버스 위에 이 불투명도로 합성한 값.
const MUTED_INK_ALPHA = 0.4;

// 채택 타입 선언(diagram-types.json) → 설정 키. mermaid 는 타입별로 useMaxWidth 를 따로 읽음.
const TYPE_CONFIG_KEY = new Map<string, string>([
	["flowchart", "flowchart"],
	["sequenceDiagram", "sequence"],
	["stateDiagram-v2", "state"],
	["erDiagram", "er"],
	["classDiagram", "class"],
	["gitGraph", "gitGraph"],
	["C4", "c4"],
]);

// tokens.css 다크 토큰에서 그대로 오는 themeVariables.
const TOKEN_ANCHORED = new Map<string, string>([
	["background", "--surface"],
	["edgeLabelBackground", "--surface"],
	["clusterBkg", "--sunken"],
	["nodeTextColor", "--ink"],
]);

// 토큰 파생이 아닌 값 — mermaid 11 의 다크 가독성 팔레트(타입별 텍스트 기본값이
// "calculated"/"black" 으로 남아 #0c0a09 위에서 안 보이는 것을 막는 고정값).
// 목록 밖의 새 hex 는 파생 근거가 없다는 뜻이므로 붉어진다.
const PALETTE_FIXED = new Set([
	"#e5e7eb",
	"#f1f5f9",
	"#1e3a8a",
	"#1e293b",
	"#334155",
	"#475569",
	"#94a3b8",
	"#fde68a",
	"#0a0a0a",
]);

/** tokens.css 의 [data-theme="dark"] 블록 — :root 라이트 트리플릿과 같은 이름이라 블록을 먼저 가른다. */
function getDarkBlock(): string {
	const css = readFileSync(TOKENS_PATH, "utf8");
	const sel = css.indexOf('[data-theme="dark"]');
	assert.notEqual(sel, -1, 'tokens.css must contain a [data-theme="dark"] block');
	const open = css.indexOf("{", sel);
	const close = css.indexOf("}", open);
	assert.ok(open !== -1 && close !== -1, "dark-theme block must be brace-delimited");
	return css.slice(open + 1, close);
}

function getToken(block: string, name: string): Rgba {
	const m = block.match(new RegExp(`${name}\\s*:\\s*(\\d{1,3})\\s+(\\d{1,3})\\s+(\\d{1,3})`));
	assert.ok(m, `dark block must define ${name} as a space-separated RGB triplet`);
	return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: 1 };
}

function toHex(c: Rgba): string {
	return `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(value: string): Rgba {
	const m = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
	assert.ok(m, `themeVariables value "${value}" is not a 6-digit hex`);
	return { r: Number.parseInt(m[1], 16), g: Number.parseInt(m[2], 16), b: Number.parseInt(m[3], 16), a: 1 };
}

const config = evaluateMermaidConfig();
const dark = getDarkBlock();
const theme = config.themeVariables;

test("P1-1 the token-anchored themeVariables are the shipped tokens.css dark values", () => {
	for (const [key, token] of TOKEN_ANCHORED) {
		assert.equal(
			theme[key],
			toHex(getToken(dark, token)),
			`themeVariables.${key} must be ${token} from the tokens.css dark block`,
		);
	}
});

test("P1-1 the edge tone is ink composited onto the canvas, not an eyeballed grey", () => {
	const muted = compositeOver({ ...getToken(dark, "--ink"), a: MUTED_INK_ALPHA }, getToken(dark, "--surface"));
	assert.equal(theme.lineColor, toHex(muted), "themeVariables.lineColor must be --ink at 40% over --surface");
});

test("P1-1 canvas, zone and box tones stay a warm ladder above the canvas", () => {
	// 단차의 하한은 architecture.merged-surface.e2e 의 대비 판정이 소유함 — 여기서는 순서와 온기만 잰다.
	const ladder = ["background", "clusterBkg", "mainBkg"].map((k) => ({ k, c: parseHex(String(theme[k])) }));
	for (let i = 1; i < ladder.length; i += 1) {
		assert.ok(
			relativeLuminance(ladder[i].c) > relativeLuminance(ladder[i - 1].c),
			`themeVariables.${ladder[i].k} must sit above ${ladder[i - 1].k} — the three tones collapse otherwise`,
		);
	}
	for (const [border, fill] of [
		["clusterBorder", "clusterBkg"],
		["nodeBorder", "mainBkg"],
	]) {
		assert.ok(
			relativeLuminance(parseHex(String(theme[border]))) > relativeLuminance(parseHex(String(theme[fill]))),
			`themeVariables.${border} must sit above its own fill ${fill}`,
		);
	}
	// 같은 온기(r>g>b) — 한 톤만 중성으로 빠지면 사다리가 색상에서 어긋난다.
	for (const key of ["background", "clusterBkg", "clusterBorder", "mainBkg", "nodeBorder"]) {
		const c = parseHex(String(theme[key]));
		assert.ok(c.r > c.g && c.g > c.b, `themeVariables.${key} lost the warm cast of the token palette`);
	}
});

test("P1-1 every themeVariables colour is token-derived or a declared palette constant", () => {
	const tokenHexes = new Set(
		["--surface", "--sunken", "--line", "--ink", "--accent", "--warn", "--crit"].map((t) =>
			toHex(getToken(dark, t)),
		),
	);
	const derived = new Set([
		toHex(compositeOver({ ...getToken(dark, "--ink"), a: MUTED_INK_ALPHA }, getToken(dark, "--surface"))),
		String(theme.mainBkg),
		String(theme.nodeBorder),
		String(theme.clusterBorder),
	]);
	const unexplained = Object.entries(theme)
		.filter(([, v]) => typeof v === "string" && (v as string).startsWith("#"))
		.map(([k, v]) => [k, (v as string).toLowerCase()] as const)
		.filter(([, v]) => !tokenHexes.has(v) && !derived.has(v) && !PALETTE_FIXED.has(v));
	assert.deepStrictEqual(
		unexplained.map(([k, v]) => `${k}=${v}`),
		[],
		"a themeVariables colour is neither a tokens.css dark value, a declared derivation, nor a listed palette constant",
	);
});

test("P1-1 no themeVariables value uses paren colour notation", () => {
	// `fill: rgb(` 한 건이면 그 안의 공백을 content-budget 계수기가 오프너로 오검출함(§6).
	const paren = Object.entries(theme).filter(([, v]) => typeof v === "string" && (v as string).includes("("));
	assert.deepStrictEqual(paren.map(([k]) => k), [], "themeVariables must be hex-only");
});

test("P1-1 the config carries the ELK default and the log level the warning watch needs", () => {
	assert.equal(config.layout, "elk", "the shared config is what promotes ELK to every diagram (ADR-5)");
	assert.equal(config.logLevel, WARN_LOG_LEVEL, "logLevel above warn makes every 'zero fallback warnings' claim vacuous");
	assert.equal(config.theme, "dark");
	assert.equal(config.startOnLoad, false, "both surfaces render explicitly");
});

test("P1-1 authored diagram text is rendered at a level that strips script", () => {
	// 다이어그램 소스는 LLM 이 POST API 로 올린 문서 본문에서 온다. <pre class="mermaid"> 안의
	// 텍스트는 sanitize.ts 를 지나지 않고 렌더러에 닿는다 — 내보내기가 저장 본문에서 직접 긁어
	// 엔티티만 되돌리기 때문(html-export.ts extractMermaidSources). 즉 이 값이 그 통로의 유일한 방벽이다.
	// 'loose' 만이 mermaid 의 script 제거 pre-pass 를 통째로 건너뛰고 click 콜백을 켠다(mermaid 11
	// sanitizeMore / setClickFun). 'antiscript' 는 DOMPurify 를 태우면서 htmlLabels 는 남기므로
	// 라벨의 <br/> 는 그대로 산다 — securityLevel 과 무관한 getEffectiveHtmlLabels 가 정한다.
	assert.notEqual(
		config.securityLevel,
		"loose",
		"'loose' hands LLM-authored diagram text to the renderer with mermaid's script-stripping pre-pass skipped",
	);
	assert.equal(
		config.securityLevel,
		"antiscript",
		"antiscript is the level that strips script and disables click callbacks while keeping HTML labels",
	);
});

test("P1-1 all seven elk tuning keys are pinned, and curve is left to the renderer", () => {
	assert.deepStrictEqual(
		Object.keys(config.elk).sort(),
		[
			"considerModelOrder",
			"cycleBreakingStrategy",
			"forceNodeModelOrder",
			"keepEntryNodeOnTop",
			"mergeEdges",
			"nodePlacementAlignment",
			"nodePlacementStrategy",
		],
		"the config is the only surface that can carry the three initialize-only elk keys",
	);
	const flowchart = config.flowchart as Record<string, unknown>;
	assert.equal(
		Object.hasOwn(flowchart, "curve"),
		false,
		"flowchart.curve is inert under ELK and would only mislead a dagre opt-out reader (ADR-3)",
	);
	assert.equal(flowchart.htmlLabels, true);
});

test("P1-1 every adopted diagram type carries the useMaxWidth:false width contract", () => {
	const declaration = JSON.parse(readFileSync(DECLARATION_PATH, "utf8")) as { adopted: { type: string }[] };
	const missing = declaration.adopted
		.map((entry) => entry.type)
		.map((type) => {
			const key = TYPE_CONFIG_KEY.get(type);
			assert.ok(key, `adopted type ${type} has no config key in this test's map`);
			return [type, config[key] as Record<string, unknown> | undefined] as const;
		})
		.filter(([, block]) => block?.useMaxWidth !== false);
	assert.deepStrictEqual(
		missing.map(([type]) => type),
		[],
		"useMaxWidth true makes mermaid stamp an inline max-width that beats the container rule",
	);
});

test("P1-1 index.html reads the shared config instead of carrying a second copy", () => {
	const html = readFileSync(INDEX_PATH, "utf8");

	// 벤더 번들은 더 이상 여기서 태그로 받지 않는다 — 첫 다이어그램 직전에 로더가 받아온다.
	// 그래서 위치 기준점은 그 로더 스크립트이고, 벤더 파일의 신원 자체는 사이드카와 대조하는
	// test/mermaid-elk.vendor-pin.unit.test.ts 가 갖는다(이 파일의 주장은 설정 사본 하나뿐).
	const elkLoaderAt = html.indexOf('src="mermaid-elk-loader.js"');
	const configAt = html.indexOf('src="mermaid-config.js"');
	const initializeAt = html.indexOf("window.mermaid?.initialize(");
	assert.ok(elkLoaderAt >= 0, "index.html must load the on-demand ELK loader");
	assert.ok(configAt >= 0, "index.html must load public/mermaid-config.js");
	assert.ok(initializeAt >= 0, "index.html must call window.mermaid?.initialize(");
	assert.ok(elkLoaderAt < configAt, "the config script must follow the ELK loader");
	assert.ok(configAt < initializeAt, "the config script must precede initialize");

	assert.match(
		html.slice(initializeAt),
		/^window\.mermaid\?\.initialize\(\s*window\.MERMAID_CONFIG\s*\)/,
		"initialize must be handed the shared global, not an inline object",
	);
	for (const literal of ["themeVariables", "logLevel", "useMaxWidth", "startOnLoad"]) {
		assert.equal(
			html.includes(literal),
			false,
			`index.html still carries the inline '${literal}' key — that is the copy this file replaces`,
		);
	}
});
