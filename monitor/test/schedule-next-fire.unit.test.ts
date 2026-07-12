// Unit tests for src/server/schedule-next-fire.ts (nextOccurrenceUtc — the shared
// DST-correct daemon next-fire computation consumed by dashboard.ts +
// health-detail.ts).
// Runner: npx tsx --test test/schedule-next-fire.unit.test.ts
// DB 불필요 — 순수 함수(Intl 2-pass offset-at-candidate) + 고정 now 주입으로 결정론적.
//
// 모든 golden ISO 값은 실제 구현으로 사전 검증됨(임의 손계산 금지). now 는 항상
// 명시 주입 → 러너 ambient tz / 시각 비의존(launchd TZ=UTC shadow 영향 없음).

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDaemonCronSchedule,
  nextOccurrenceUtc,
  type ConfigAlarmSink,
  type CronRule,
  type RawDaemonSchedule,
} from "../src/server/schedule-next-fire.js";

const daily = (hour: number, minute: number): CronRule => ({ type: "daily-at", hour, minute });
const weekly = (dayOfWeek: number, hour: number, minute: number): CronRule => ({
  type: "weekly-at",
  dayOfWeek,
  hour,
  minute,
});

// ── daily-at 기본 정합 (각 zone, DST 활성/비활성 양쪽) ──────────────────────

test("daily-at UTC: 미경과 후보 → 같은 날 wall time (offset 0)", () => {
  // 10:00 UTC, now 08:00Z 같은 날 → 당일 10:00Z.
  assert.strictEqual(
    nextOccurrenceUtc(daily(10, 0), "UTC", new Date("2025-06-15T08:00:00Z")),
    "2025-06-15T10:00:00.000Z",
  );
});

test("daily-at UTC: 경과 후보 → 익일로 wall-clock day 롤오버", () => {
  // 10:00 UTC, now 11:00Z(경과) → 익일 10:00Z.
  assert.strictEqual(
    nextOccurrenceUtc(daily(10, 0), "UTC", new Date("2025-06-15T11:00:00Z")),
    "2025-06-16T10:00:00.000Z",
  );
});

test("daily-at America/New_York: EST(겨울, UTC-5) offset 적용", () => {
  // 09:00 EST = 14:00Z. now 12:00Z(=07:00 EST 당일) → 미경과 → 14:00Z.
  assert.strictEqual(
    nextOccurrenceUtc(daily(9, 0), "America/New_York", new Date("2025-01-15T12:00:00Z")),
    "2025-01-15T14:00:00.000Z",
  );
});

test("daily-at America/New_York: EDT(여름, UTC-4) offset 적용 — EST 와 다름", () => {
  // 09:00 EDT = 13:00Z (EST 였다면 14:00Z). offset 이 instant 별로 재계산됨을 증명.
  assert.strictEqual(
    nextOccurrenceUtc(daily(9, 0), "America/New_York", new Date("2025-07-15T06:00:00Z")),
    "2025-07-15T13:00:00.000Z",
  );
});

test("daily-at Europe/Berlin: CET(겨울, UTC+1) offset 적용", () => {
  // 08:00 CET = 07:00Z. now 05:00Z(=06:00 CET) → 미경과 → 07:00Z.
  assert.strictEqual(
    nextOccurrenceUtc(daily(8, 0), "Europe/Berlin", new Date("2025-01-15T05:00:00Z")),
    "2025-01-15T07:00:00.000Z",
  );
});

test("daily-at Europe/Berlin: CEST(여름, UTC+2) offset 적용 — CET 와 다름", () => {
  // 08:00 CEST = 06:00Z (CET 였다면 07:00Z).
  assert.strictEqual(
    nextOccurrenceUtc(daily(8, 0), "Europe/Berlin", new Date("2025-07-15T04:00:00Z")),
    "2025-07-15T06:00:00.000Z",
  );
});

// ── across-DST-transition-DAY 롤오버 (고정 ms add 가 틀림을 잠금) ──────────

test("daily-at NY: 롤오버가 spring-forward 경계를 가로지르면 23h 간격(wall-clock day 증가, 고정 86_400_000ms add 아님)", () => {
  // now = 2025-03-08 12:30 EST(=17:30Z), 정오 후보(17:00Z) 경과 → 익일(03-09)로 롤.
  // 03-09 는 spring-forward 일: 정오 NY = EDT = 16:00Z.
  // 고정 +24h 였다면 17:00Z(=13:00 EDT, 오답)이 됐을 것 → 실제 간격은 23h.
  const prevFire = new Date("2025-03-08T17:00:00Z").getTime(); // 03-08 정오 EST
  const next = nextOccurrenceUtc(
    daily(12, 0),
    "America/New_York",
    new Date("2025-03-08T17:30:00Z"),
  );
  assert.strictEqual(next, "2025-03-09T16:00:00.000Z");
  // 명시적 간격 검증: 고정 ms add(24h) 회귀를 잡는 핵심 oracle.
  assert.strictEqual(new Date(next).getTime() - prevFire, 23 * 3_600_000);
  assert.notStrictEqual(next, "2025-03-09T17:00:00.000Z"); // 고정 +24h 오답
});

// ── 결정론적 spring-forward GAP oracle (존재하지 않는 wall time → shifted instant) ──
// 핵심: round-trip 이 아니라 yield 된 instant 자체를 pin. 02:30 은 실제 daemon
// 스케줄에는 없는 합성 입력(실 스케줄 04:30/05:30 은 gap-safe)이지만, 2-pass 가
// nonexistent wall time 을 결정론적 instant 로 접는다는 사실을 고정한다.

test("spring-forward GAP NY: 02:30(비존재) → 결정론적 06:30Z (= 01:30 EST, 뒤로 접힘)", () => {
  // 2025-03-09 02:00 EST → 03:00 EDT 점프로 02:30 부재. yield 인스턴트 06:30Z
  // 의 wall-clock 은 01:30 EST. round-trip 아닌 yield 된 instant 를 직접 단언.
  assert.strictEqual(
    nextOccurrenceUtc(daily(2, 30), "America/New_York", new Date("2025-03-09T05:00:00Z")),
    "2025-03-09T06:30:00.000Z",
  );
});

test("spring-forward GAP Berlin: 02:30(비존재) → 결정론적 01:30Z (= 03:30 CEST, 앞으로 접힘)", () => {
  // 2025-03-30 02:00 CET → 03:00 CEST 점프로 02:30 부재. yield 인스턴트 01:30Z
  // 의 wall-clock 은 03:30 CEST. NY 와 접히는 방향이 반대임에 주의(둘 다 결정론적).
  assert.strictEqual(
    nextOccurrenceUtc(daily(2, 30), "Europe/Berlin", new Date("2025-03-30T00:00:00Z")),
    "2025-03-30T01:30:00.000Z",
  );
});

// ── weekly-at DST: 목표 weekday 의 offset(now 가 아닌)으로 계산 ──────────────

test("weekly-at NY: 목표 일요일이 spring-forward 일이면 그 날의 EDT offset 적용", () => {
  // rule = 매주 일(0) 12:00. now = 2025-03-05(수, EST). 다음 일요일 03-09 는
  // spring-forward 일 → 정오 EDT = 16:00Z (직전 일요일 03-02 였다면 EST 17:00Z).
  assert.strictEqual(
    nextOccurrenceUtc(weekly(0, 12, 0), "America/New_York", new Date("2025-03-05T12:00:00Z")),
    "2025-03-09T16:00:00.000Z",
  );
});

test("weekly-at: 같은 weekday 이고 후보 wall time 미경과면 당일 발화", () => {
  // now = 2025-03-09(일) 05:00Z(=00:00 EST 당일). rule 일(0) 12:00 → 당일 16:00Z.
  assert.strictEqual(
    nextOccurrenceUtc(weekly(0, 12, 0), "America/New_York", new Date("2025-03-09T05:00:00Z")),
    "2025-03-09T16:00:00.000Z",
  );
});

// ── Seoul backward-compat GOLDEN-PIN (legacy 고정 9h 거동과 byte-identical) ──
// Asia/Seoul = UTC+9, DST 없음. 과거 하드코딩 KST(고정 +9h) 거동과 완전히 동일한
// instant 를 산출해야 함 → 이 두 핀이 회귀 시 즉시 깨진다.

test("Seoul GOLDEN-PIN daily-at 04:30 == 전일 19:30:00Z (legacy KST 등가)", () => {
  // now = 2025-05-31 18:00Z (=06-01 03:00 KST). 04:30 KST 후보 = 05-31 19:30Z, 미경과.
  assert.strictEqual(
    nextOccurrenceUtc(daily(4, 30), "Asia/Seoul", new Date("2025-05-31T18:00:00Z")),
    "2025-05-31T19:30:00.000Z",
  );
});

test("Seoul GOLDEN-PIN daily-at 05:30 == 전일 20:30:00Z (legacy KST 등가)", () => {
  // 05:30 KST = 전일 20:30Z (= 05:30 − 9h).
  assert.strictEqual(
    nextOccurrenceUtc(daily(5, 30), "Asia/Seoul", new Date("2025-05-31T18:00:00Z")),
    "2025-05-31T20:30:00.000Z",
  );
});

test("Seoul GOLDEN-PIN daily-at 04:50 (wiki 정정값) == 전일 19:50:00Z", () => {
  // wiki 가 04:30→04:50 으로 정정된 값(이 fix 의 핵심). 04:50 KST = 전일 19:50Z
  // (= 04:50 − 9h). 같은 now(2025-05-31 18:00Z = 06-01 03:00 KST) 에서 미경과 →
  // 05-31 19:50Z. autoagent(19:30Z)/daily-restart(20:30Z) 핀과 같은 now 공유.
  assert.strictEqual(
    nextOccurrenceUtc(daily(4, 50), "Asia/Seoul", new Date("2025-05-31T18:00:00Z")),
    "2025-05-31T19:50:00.000Z",
  );
});

// ── buildDaemonCronSchedule: env → 4-row CronRule 맵 (injectable seam) ────────
// config.toml → ATRIUM_SCHEDULE_* (.env) → buildDaemonCronSchedule. INJECTED raw
// source 로만 검증 (ambient .env 비의존 — 모듈-로드 DAEMON_CRON_SCHEDULE 과 무관).
// timezone.ts 의 loud-fail/last-resort 패턴 미러: present-but-malformed → throw
// (env-var 명 포함), partial → throw, 전부 부재 → dev fallback + 단일 stderr 경고.

const FULL_SOURCE: RawDaemonSchedule = {
  autoagent: "04:30",
  wiki: "04:50",
  "daily-restart": "05:30",
};

// 정정된 wiki 04:50 + autoagent/daily-restart 불변. daily-restart 가 두 role-qualified
// row(autoagent/wiki)로 fan-out 됨에 유의 — 한 launchd job → 두 monitor row. dev
// fallback({04:30,04:50,05:30}) 도 같은 결과를 산출하므로 두 경로가 이 맵을 공유한다.
const EXPECTED_SCHEDULE: Record<string, CronRule> = {
  autoagent: { type: "daily-at", hour: 4, minute: 30 },
  wiki: { type: "daily-at", hour: 4, minute: 50 },
  "daily-restart-autoagent": { type: "daily-at", hour: 5, minute: 30 },
  "daily-restart-wiki": { type: "daily-at", hour: 5, minute: 30 },
};

// process.stderr.write 를 일시 가로채 dev-fallback 경고를 in-process 로 단언한다
// (러너 ambient .env 비의존, 결정론적). finally 에서 항상 원복.
function captureStderr(fn: () => void): string {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test("buildDaemonCronSchedule: 완전 주입 → 4-row 맵(wiki 04:50, autoagent 04:30, daily-restart 두 row 05:30)", () => {
  assert.deepStrictEqual(buildDaemonCronSchedule(FULL_SOURCE), EXPECTED_SCHEDULE);
});

test("buildDaemonCronSchedule: daily-restart 단일 값이 두 row 로 fan-out (동일 05:30)", () => {
  const schedule = buildDaemonCronSchedule(FULL_SOURCE);
  assert.strictEqual(Object.keys(schedule).length, 4);
  assert.deepStrictEqual(schedule["daily-restart-autoagent"], {
    type: "daily-at",
    hour: 5,
    minute: 30,
  });
  assert.deepStrictEqual(schedule["daily-restart-wiki"], {
    type: "daily-at",
    hour: 5,
    minute: 30,
  });
});

test("buildDaemonCronSchedule: present-but-malformed 값 → throw (env-var 명 포함)", () => {
  assert.throws(
    () => buildDaemonCronSchedule({ autoagent: "0430", wiki: "04:50", "daily-restart": "05:30" }),
    /ATRIUM_SCHEDULE_AUTOAGENT/,
    "colon 없는 autoagent 값은 해당 env-var 명을 담아 throw",
  );
  assert.throws(
    () => buildDaemonCronSchedule({ autoagent: "04:30", wiki: "25:00", "daily-restart": "05:30" }),
    /ATRIUM_SCHEDULE_WIKI/,
    "out-of-range wiki 값도 env-var 명을 담아 throw (never mix a rendered value with a fallback)",
  );
});

test("buildDaemonCronSchedule: partial 주입(일부만 존재) → throw (부재 env-var 명 포함)", () => {
  assert.throws(
    () => buildDaemonCronSchedule({ autoagent: "04:30" }),
    /ATRIUM_SCHEDULE_WIKI/,
    "wiki/daily-restart 부재 시 partial loud-fail (부재 키 명 포함)",
  );
  assert.throws(
    () => buildDaemonCronSchedule({ autoagent: "04:30", wiki: "04:50" }),
    /partial daemon schedule env/,
    "daily-restart 단일 부재도 partial loud-fail (silent fallback 금지)",
  );
});

test("buildDaemonCronSchedule: 전부 부재({}) → dev fallback {04:30,04:50,05:30} + 단일 stderr 경고", () => {
  let schedule: Record<string, CronRule> | undefined;
  const stderr = captureStderr(() => {
    schedule = buildDaemonCronSchedule({});
  });
  assert.deepStrictEqual(schedule, EXPECTED_SCHEDULE);
  assert.match(stderr, /WARNING/, "totally-absent 경로는 silent 가 아니라 loud warning");
  assert.match(stderr, /dev-fallback/, "경고에 dev-fallback 식별자 포함");
});

// ── production boot guard: NODE_ENV=production + ATRIUM_SCHEDULE_* 전부 부재 ──
// prod 에서 전부 부재 → render-monitor-env.sh 미실행 misconfiguration → lost stderr line 대신
// prominent/surfaced alarm 로 escalate(config-truth fallback 은 그대로 렌더돼 대시보드 유지). dev 불변.

// 주입 alarm sink — 발화 메시지를 in-process 로 포착(기본 logger.error 미사용, 결정론적).
function captureAlarm(): { sink: ConfigAlarmSink; calls: string[] } {
  const calls: string[] = [];
  return { sink: (message) => calls.push(message), calls };
}

test("buildDaemonCronSchedule: prod + 전부 부재 → prominent alarm(stderr 아님) + config-truth fallback", () => {
  const alarm = captureAlarm();
  let schedule: Record<string, CronRule> | undefined;
  const stderr = captureStderr(() => {
    schedule = buildDaemonCronSchedule({}, "production", alarm.sink);
  });
  assert.deepStrictEqual(schedule, EXPECTED_SCHEDULE, "prod 에서도 config-truth fallback 을 렌더해 대시보드 유지");
  assert.strictEqual(stderr, "", "prod 경로는 lost stderr line 을 쓰지 않음");
  assert.strictEqual(alarm.calls.length, 1, "prod 부재는 silent 아니라 prominent alarm 1회");
  assert.match(alarm.calls[0] ?? "", /NODE_ENV=production/, "alarm 메시지에 prod 컨텍스트 포함");
  assert.match(alarm.calls[0] ?? "", /render-monitor-env\.sh/, "alarm 메시지에 remediation 포함");
});

test("buildDaemonCronSchedule: dev(NODE_ENV=development) + 전부 부재 → stderr 경고 그대로, alarm 미발화", () => {
  const alarm = captureAlarm();
  let schedule: Record<string, CronRule> | undefined;
  const stderr = captureStderr(() => {
    schedule = buildDaemonCronSchedule({}, "development", alarm.sink);
  });
  assert.deepStrictEqual(schedule, EXPECTED_SCHEDULE);
  assert.match(stderr, /WARNING/, "dev 경로는 기존 loud stderr 경고 유지(불변)");
  assert.strictEqual(alarm.calls.length, 0, "dev 경로는 prod alarm 을 발화하지 않음");
});
