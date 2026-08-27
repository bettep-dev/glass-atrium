// The shared mermaid runtime config (public/mermaid-config.js) as the test suites see it:
// one read of the file, one evaluation of it. Five suites had each grown their own copy of
// the same three lines — a stub, a `new Function`, a truthiness assert — so a change to how
// the config is loaded had five sites to find, and a dynamic-evaluation review had five
// shapes to read instead of one.
//
// The file is a classic script assigning a single global, so evaluating it needs no browser:
// a bare `window` stub is the whole environment it asks for.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_ROOT = resolve(HERE, "..", "..");

/** 뷰어와 내보내기가 함께 읽는 파일. html-export.ts 의 MERMAID_CONFIG_PATH 와 같은 파일을 가리킨다. */
const MERMAID_CONFIG_SOURCE_PATH = resolve(MONITOR_ROOT, "public/mermaid-config.js");

/** 그 파일의 원문 — 한 번만 읽는다. 사본을 두 곳에서 읽으면 그 둘이 어긋날 자리가 생긴다. */
export const MERMAID_CONFIG_SOURCE = readFileSync(MERMAID_CONFIG_SOURCE_PATH, "utf8");

/** 설정 파일이 할당하는 전역의 모양. 채택 타입별 블록은 인덱스 시그니처로 받는다. */
export interface MermaidConfig {
	startOnLoad: boolean;
	logLevel: number;
	theme: string;
	securityLevel: string;
	layout: string;
	elk: Record<string, unknown>;
	themeVariables: Record<string, unknown>;
	[key: string]: unknown;
}

/**
 * 설정 스크립트를 페이지가 하듯 그대로 평가해 전역을 걷어옴 — 값을 테스트에 적어두면 그 사본이 드리프트한다.
 * 인자를 주면 그 원문을(내보내기가 주입하는 텍스트 등), 주지 않으면 디스크의 파일을 평가한다.
 */
export function evaluateMermaidConfig(source: string = MERMAID_CONFIG_SOURCE): MermaidConfig {
	// SECURITY: the single dynamic-evaluation site under monitor/test. core-security bans
	// dynamic execution of EXTERNAL input; this input is a repo-owned static asset — either
	// public/mermaid-config.js itself or the text the export injects from that same file —
	// never user-supplied and never fetched. Keep it to this one site: a second copy is a
	// second shape a reviewer has to read.
	//
	// node:vm would sandbox this further, but not for free: each context is its own realm, so
	// two configs evaluated that way carry two different Object.prototypes and the parity
	// suite's deepStrictEqual on them fails on prototype identity alone. Same-realm evaluation
	// is what that comparison is written against.
	const windowStub: Record<string, unknown> = {};
	new Function("window", source)(windowStub);

	const config = windowStub.MERMAID_CONFIG;
	assert.ok(
		config !== null && typeof config === "object",
		"public/mermaid-config.js must assign window.MERMAID_CONFIG",
	);
	return config as MermaidConfig;
}

/**
 * themeVariables 의 문자열 값 하나. 색을 테스트에 적어두면 그 사본이 드리프트하므로 SoT 에서 직접 읽는다.
 */
export function getMermaidThemeValue(key: string): string {
	const value = evaluateMermaidConfig().themeVariables[key];
	assert.ok(
		typeof value === "string" && value !== "",
		`the shared config must define themeVariables.${key}`,
	);
	return value;
}
