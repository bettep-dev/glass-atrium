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
	// `~/.glass-atrium/rules/glass-atrium/*.md` (GLASS_ATRIUM_GLOBAL_RULES.md 동거 포함 — 현 SoT 결정).
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
	scoped: 17,
	scopedScope: 9,
	scopedShared: 8,
	skills: 15,
	// KNOWN RESIDUE (2026-08-16), 의도적 미수정: repo 는 이미 56 (PR #158 이
	// advisory-worktree-writer-lock.sh 를 추가), 라이브는 아직 55. 이 필드는 hooks.PreToolUse 와 달리
	// repo 결합이 아니라 LIVE 결합이며 관례가 "라이브 카운트에 맞춰 sync" 이므로, 릴리스 전에 올리면
	// 없던 drift 를 만든다. 릴리스로 새 훅이 라이브에 안착한 뒤 56 으로 sync 할 것.
	uniqueHookBasename: 55,
	hooks: {
		// dedupe 후 정본 목표치 = EXPECTED_HOOK_BINDINGS(lib/ga-env.sh) 의 PreToolUse leaf 수 (test/hook-bindings-complete.bats 가 동치를 강제).
		// 26 → 27 은 advisory-worktree-writer-lock.sh(Write|Edit) 바인딩 신설분 — SoT 배열이 늘어난 정당한 증가다.
		// 배지 diff 를 따라 올리지 말 것: 라이브가 이 값을 넘으면 그건 settings.json 중복 매처 바인딩 신호이지 새 바인딩이 아니다.
		PreToolUse: 27,
		PostToolUse: 8,
		SessionStart: 4,
		SubagentStart: 3,
		Stop: 3,
		SubagentStop: 3,
		PreCompact: 1,
	},
};
