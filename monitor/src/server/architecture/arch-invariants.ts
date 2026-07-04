// 설계도가 주장하는 정량 불변식의 SoT — computeArchDrift() 가 라이브 파일시스템 카운트와 비교.
// HOOK-COUNT 단위: settings.json event 당 평탄화된 Atrium-owned hook-command 수 (matcher-entry 수 아님 — 1 entry 에 복수 command 가 묶이는 케이스 반영).

export interface HookEventCounts {
	PreToolUse: number;
	PostToolUse: number;
	SessionStart: number;
	SubagentStart: number;
	Stop: number;
	SubagentStop: number;
	PreCompact: number;
}

// 라이브 비교 타깃 — 각 필드 = 카운트 대상 파일시스템 글롭.
export interface ArchInvariants {
	// `~/.glass-atrium/agents/*.md` − GLASS_ATRIUM_GLOBAL_RULES.md.
	agents: number;
	// `~/Library/LaunchAgents/com.glass-atrium.*.plist`.
	launchd: number;
	// `~/.glass-atrium/rules/*.md` (GLASS_ATRIUM_GLOBAL_RULES.md 동거 포함 — 현 SoT 결정).
	rules: number;
	// `~/.glass-atrium/scoped/*.md` 전체 (scope-*.md + shared-*.md).
	scoped: number;
	// `~/.glass-atrium/scoped/scope-*.md`.
	scopedScope: number;
	// `~/.glass-atrium/scoped/shared-*.md`.
	scopedShared: number;
	// `~/.glass-atrium/skills/*/` 디렉터리 (플러그인 스킬 네임스페이스 제외).
	skills: number;
	// `~/.glass-atrium/hooks/*.{sh,py}` maxdepth 1 고유 basename (lib/test/__pycache__ 제외).
	uniqueHookBasename: number;
	hooks: HookEventCounts;
}

// SYNCED 시작용 라이브 실측 시드값 — drift 발견 시(computeArchDrift 배지 신호) 갱신.
export const ARCH_INVARIANTS: ArchInvariants = {
	agents: 23,
	launchd: 8,
	rules: 10,
	scoped: 16,
	scopedScope: 9,
	scopedShared: 7,
	skills: 15,
	uniqueHookBasename: 47,
	hooks: {
		PreToolUse: 20,
		PostToolUse: 7,
		SessionStart: 4,
		SubagentStart: 3,
		Stop: 3,
		SubagentStop: 4,
		PreCompact: 1,
	},
};
