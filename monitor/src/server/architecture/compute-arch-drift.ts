// 설계도 드리프트 계산 단일 SoT — 라이브 파일시스템 + settings.json 을 읽어 아트리움 자산을 카운트하고 ARCH_INVARIANTS 와 비교 → { stale, diffs }. L1(배지/배너) · L2(스킬) 양쪽 소비자가 호출.
//
// 카운트 스코프 경계 = 아트리움 시스템만 — hooks 는 settings.json 을 읽되 아트리움 훅 디렉터리 소유권 필터 선적용 · MCP 는 스코프 밖(미카운트) · skills 는 `~/.glass-atrium/skills/*/` 만(플러그인 네임스페이스 제외).
// 라이브 카운트 실패는 0 으로 떨어져 drift 로 surface — silent absorb 금지(false MATCH 보다 명시적 mismatch 가 안전).

import { readFile, readdir, stat } from "node:fs/promises";
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
	// ARCH_INVARIANTS 의 점 표기 키 (예: "agents", "hooks.PreToolUse").
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

// 아트리움 훅 디렉터리 — `~/.claude/hooks/` 는 glass-atrium 으로의 per-file 심볼릭 미러.
// settings.json 명령 경로가 둘 중 하나 하위면 아트리움 소유로 카운트.
const ATRIUM_HOOK_DIRS: readonly string[] = [
	join(ATRIUM_ROOT, "hooks"),
	join(HOME, ".claude", "hooks"),
];

const SETTINGS_PATH = join(HOME, ".claude", "settings.json");
const LAUNCH_AGENTS_DIR = join(HOME, "Library", "LaunchAgents");

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

// 디렉터리에서 매처(predicate)를 통과하는 항목 수 — ENOENT 등은 0 으로 격리.
async function countDirEntries(
	dir: string,
	predicate: (name: string, fullPath: string) => Promise<boolean> | boolean,
	log: DriftLogger,
): Promise<number> {
	let count = 0;
	try {
		const names = await readdir(dir);
		for (const name of names) {
			if (await predicate(name, join(dir, name))) count += 1;
		}
	} catch (error) {
		log.warn(
			{ err: error, dir },
			"arch drift: dir count failed (treated as 0)",
		);
		return 0;
	}
	return count;
}

async function isDirectory(fullPath: string): Promise<boolean> {
	try {
		return (await stat(fullPath)).isDirectory();
	} catch {
		return false;
	}
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

// maxdepth 1 의 *.sh/*.py 고유 basename 수 (서브디렉터리 lib/test/__pycache__ 미진입).
async function countUniqueHookBasenames(
	dir: string,
	log: DriftLogger,
): Promise<number> {
	try {
		const names = await readdir(dir);
		const unique = new Set<string>();
		for (const name of names) {
			if (name.endsWith(".sh") || name.endsWith(".py")) {
				// maxdepth 1 보장 — 서브디렉터리는 basename 매칭에서 제외.
				if (!(await isDirectory(join(dir, name)))) unique.add(name);
			}
		}
		return unique.size;
	} catch (error) {
		log.warn(
			{ err: error, dir },
			"arch drift: hook basename count failed (treated as 0)",
		);
		return 0;
	}
}

// 라이브 파일시스템에서 아트리움 자산을 카운트 (각 신호 격리).
async function countLiveInvariants(log: DriftLogger): Promise<ArchInvariants> {
	const agentsDir = join(ATRIUM_ROOT, "agents");
	const rulesDir = join(ATRIUM_ROOT, "rules");
	const scopedDir = join(ATRIUM_ROOT, "scoped");
	const skillsDir = join(ATRIUM_ROOT, "skills");
	const hooksDir = join(ATRIUM_ROOT, "hooks");

	const isMd = (name: string): boolean => name.endsWith(".md");

	const [
		agents,
		launchd,
		rules,
		scoped,
		scopedScope,
		scopedShared,
		skills,
		uniqueHookBasename,
		hooks,
	] = await Promise.all([
		countDirEntries(
			agentsDir,
			(name) => isMd(name) && name !== "GLOBAL_RULES.md",
			log,
		),
		countDirEntries(
			LAUNCH_AGENTS_DIR,
			(name) => name.startsWith("com.glass-atrium.") && name.endsWith(".plist"),
			log,
		),
		// rules — GLOBAL_RULES.md 동거 포함 (현 SoT 결정 · agents 와 달리 미제외).
		countDirEntries(rulesDir, (name) => isMd(name), log),
		countDirEntries(scopedDir, (name) => isMd(name), log),
		countDirEntries(
			scopedDir,
			(name) => name.startsWith("scope-") && isMd(name),
			log,
		),
		countDirEntries(
			scopedDir,
			(name) => name.startsWith("shared-") && isMd(name),
			log,
		),
		countDirEntries(skillsDir, (_name, full) => isDirectory(full), log),
		countUniqueHookBasenames(hooksDir, log),
		countHookCommands(log),
	]);

	return {
		agents,
		launchd,
		rules,
		scoped,
		scopedScope,
		scopedShared,
		skills,
		uniqueHookBasename,
		hooks,
	};
}

function diffCount(
	key: string,
	claimed: number,
	actual: number,
	out: ArchDiff[],
): void {
	if (claimed !== actual) out.push({ key, claimed, actual });
}

// 드리프트는 파일 추가/삭제(희소)에만 변하지만 /api/architecture/live 호출(고빈도)마다
// 풀 FS 스캔을 돌려 단일 이벤트루프/libuv 풀을 굶긴다 → 짧은 TTL 동안 결과 캐시.
// 30s TTL 은 "미감사 카운트 경고" 의미를 보존(파일 추가/삭제는 다음 TTL 윈도 내 반영).
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
	const live = await countLiveInvariants(log);
	const diffs: ArchDiff[] = [];

	diffCount("agents", ARCH_INVARIANTS.agents, live.agents, diffs);
	diffCount("launchd", ARCH_INVARIANTS.launchd, live.launchd, diffs);
	diffCount("rules", ARCH_INVARIANTS.rules, live.rules, diffs);
	diffCount("scoped", ARCH_INVARIANTS.scoped, live.scoped, diffs);
	diffCount(
		"scopedScope",
		ARCH_INVARIANTS.scopedScope,
		live.scopedScope,
		diffs,
	);
	diffCount(
		"scopedShared",
		ARCH_INVARIANTS.scopedShared,
		live.scopedShared,
		diffs,
	);
	diffCount("skills", ARCH_INVARIANTS.skills, live.skills, diffs);
	diffCount(
		"uniqueHookBasename",
		ARCH_INVARIANTS.uniqueHookBasename,
		live.uniqueHookBasename,
		diffs,
	);
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
