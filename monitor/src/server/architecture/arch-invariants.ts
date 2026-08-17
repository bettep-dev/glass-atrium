// 설계도가 주장하는 정량 불변식의 SoT — computeArchDrift() 가 라이브 settings.json 과 비교.
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

// 라이브 비교 타깃 — 남는 것은 설계도 ↔ 바인딩 배열 불일치를 잡는 이벤트별 훅 카운트 뿐이다.
// 파일시스템 인벤토리 총계는 거버넌스 멤버십(이름 지정 부재 목록)이 대신한다.
export interface ArchInvariants {
	hooks: HookEventCounts;
}

// SYNCED 시작용 라이브 실측 시드값 — drift 발견 시(computeArchDrift 배지 신호) 갱신.
export const ARCH_INVARIANTS: ArchInvariants = {
	hooks: {
		// dedupe 후 정본 목표치 = EXPECTED_HOOK_BINDINGS(lib/ga-env.sh) 의 PreToolUse leaf 수 (test/hook-bindings-complete.bats 가 동치를 강제).
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
