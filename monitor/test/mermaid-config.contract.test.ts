// P1-1 — the shared mermaid runtime config (public/mermaid-config.js), read as the
// one source both viewer surfaces initialize from.
// Runner: npx tsx --test test/mermaid-config.contract.test.ts
//
// Three claims, none of which the others cover: the two keys the ELK proof and the
// fallback-warning watch stand on carry the values those harnesses assume, authored
// diagram text is rendered at a security level that strips script, and the per-type
// width contract covers every adopted diagram type.
//
// Browserless: the config is a classic script assigning one global, so a bare
// `window` stub evaluates it — no chromium, no network, runs on every leg.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { evaluateMermaidConfig } from "./lib/mermaid-config-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_ROOT = resolve(HERE, "..");
const DECLARATION_PATH = resolve(MONITOR_ROOT, "src/server/clauded-docs/diagram-types.json");

// mermaid 의 폴백 경고는 logLevel 4 이상에서 log.warn 이 no-op 이라 아예 나오지 않음.
const WARN_LOG_LEVEL = 3;

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

const config = evaluateMermaidConfig();

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
