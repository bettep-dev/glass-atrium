// task_type 9종 canonical allowlist 단일 SoT (rules/core-outcome-record.md 미러) — agents.ts/outcomes.ts/improvement.ts 공유.
// route 별 사본은 enum drift 원인; 비코드 4종(review/diagnosis/doc/cleanup) 누락 시 각 route 의 방어적 allowlist guard 가 해당 행을 조용히 누락시킨다.

export const TASK_TYPES = [
  "bug-fix",
  "feature",
  "refactor",
  "research",
  "plan",
  "review",
  "diagnosis",
  "doc",
  "cleanup",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];
