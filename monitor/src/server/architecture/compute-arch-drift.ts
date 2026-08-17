// 설계도 드리프트 계산 단일 SoT — 라이브 settings.json 의 아트리움 소유 훅 커맨드를 이벤트별로 세어 ARCH_INVARIANTS 와 비교 → { stale, diffs }. L1(배지/배너) · L2(스킬) 양쪽 소비자가 호출.
//
// 카운트 스코프 경계 = 아트리움 시스템만 — 아트리움 훅 디렉터리 소유권 필터 선적용 · MCP 는 스코프 밖(미카운트).
// 라이브 카운트 실패는 0 으로 떨어져 drift 로 surface — silent absorb 금지(false MATCH 보다 명시적 mismatch 가 안전).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";

import {
	ARCH_INVARIANTS,
	type ArchInvariants,
	type HookEventCounts,
} from "./arch-invariants.js";
import { createTtlCache } from "./ttl-cache.js";

export interface DriftLogger {
	warn(obj: object, msg?: string): void;
	info(obj: object, msg?: string): void;
}

// 단일 카운트 항목의 주장(claimed) vs 실측(actual) 불일치.
export interface ArchDiff {
	// ARCH_INVARIANTS 의 점 표기 키 (예: "hooks.PreToolUse").
	key: string;
	claimed: number;
	actual: number;
}

export interface ArchDriftResult {
	stale: boolean;
	diffs: ArchDiff[];
}

const HOME = homedir();
const ATRIUM_ROOT = join(HOME, ".glass-atrium");

// 아트리움 훅 디렉터리 — 훅은 `~/.glass-atrium/hooks/` 에서 in-place 소비 (primary).
// `~/.claude/hooks/` 는 farm 에서 드롭됨 → fail-open fallback (부재 시 0 카운트).
// settings.json 명령 경로가 둘 중 하나 하위면 아트리움 소유로 카운트.
const ATRIUM_HOOK_DIRS: readonly string[] = [
	join(ATRIUM_ROOT, "hooks"),
	join(HOME, ".claude", "hooks"),
];

const SETTINGS_PATH = join(HOME, ".claude", "settings.json");

const HOOK_EVENTS: readonly (keyof HookEventCounts)[] = [
	"PreToolUse",
	"PostToolUse",
	"SessionStart",
	"SubagentStart",
	"Stop",
	"SubagentStop",
	"PreCompact",
];

interface SettingsHookCommand {
	type?: string;
	command?: string;
}

interface SettingsHookEntry {
	matcher?: string;
	hooks?: SettingsHookCommand[];
}

// settings.json command 경로 정규화 — 첫 토큰 추출 + ~/$HOME 확장.
function resolveCommandPath(command: string): string {
	const firstField = command.trim().split(/\s+/)[0] ?? "";
	const expanded = firstField
		.replace(/^~(?=\/|$)/, HOME)
		.replace(/\$HOME/g, HOME)
		.replace(/\$\{HOME\}/g, HOME);
	return normalize(expanded);
}

function isAtriumOwnedCommand(command: string): boolean {
	const resolved = resolveCommandPath(command);
	return ATRIUM_HOOK_DIRS.some((dir) => resolved.startsWith(dir + sep));
}

async function countHookCommands(log: DriftLogger): Promise<HookEventCounts> {
	const empty: HookEventCounts = {
		PreToolUse: 0,
		PostToolUse: 0,
		SessionStart: 0,
		SubagentStart: 0,
		Stop: 0,
		SubagentStop: 0,
		PreCompact: 0,
	};
	let parsed: { hooks?: Record<string, SettingsHookEntry[]> };
	try {
		parsed = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as typeof parsed;
	} catch (error) {
		log.warn(
			{ err: error, path: SETTINGS_PATH },
			"arch drift: settings.json read failed",
		);
		return empty;
	}
	const events = parsed.hooks ?? {};
	const result: HookEventCounts = { ...empty };
	for (const event of HOOK_EVENTS) {
		const entries = events[event] ?? [];
		let count = 0;
		for (const entry of entries) {
			for (const hook of entry.hooks ?? []) {
				if (
					hook.type === "command" &&
					hook.command &&
					isAtriumOwnedCommand(hook.command)
				) {
					count += 1;
				}
			}
		}
		result[event] = count;
	}
	return result;
}

function diffCount(
	key: string,
	claimed: number,
	actual: number,
	out: ArchDiff[],
): void {
	if (claimed !== actual) out.push({ key, claimed, actual });
}

// 드리프트는 바인딩 변경(희소)에만 변하지만 /api/architecture/live 호출(고빈도)마다
// settings.json 을 재파싱한다 → 짧은 TTL 동안 결과 캐시.
// 30s TTL 은 "미감사 카운트 경고" 의미를 보존(바인딩 변경은 다음 TTL 윈도 내 반영).
const DRIFT_CACHE_TTL_MS = 30_000;

const driftCache = createTtlCache(DRIFT_CACHE_TTL_MS, computeArchDriftUncached);

// 공유 코어 — 라이브 카운트 ↔ ARCH_INVARIANTS 비교 → { stale, diffs }.
// L1(배지/배너)·L2(스킬) 두 소비자가 모두 이 함수를 호출 (드리프트 로직 단일 SoT).
export function computeArchDrift(log: DriftLogger): Promise<ArchDriftResult> {
	return driftCache.get(log);
}

/** Test seam — clears the drift cache so the next call re-scans the filesystem. */
export function resetArchDriftCache(): void {
	driftCache.reset();
}

async function computeArchDriftUncached(
	log: DriftLogger,
): Promise<ArchDriftResult> {
	const live: ArchInvariants = { hooks: await countHookCommands(log) };
	const diffs: ArchDiff[] = [];

	for (const event of HOOK_EVENTS) {
		diffCount(
			`hooks.${event}`,
			ARCH_INVARIANTS.hooks[event],
			live.hooks[event],
			diffs,
		);
	}

	const result: ArchDriftResult = { stale: diffs.length > 0, diffs };
	log.info(
		{ stale: result.stale, diffCount: diffs.length },
		"arch drift computed",
	);
	return result;
}
