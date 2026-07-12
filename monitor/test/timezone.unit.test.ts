// Unit tests for src/server/timezone.ts (config.toml [meta].timezone →
// ATRIUM_TIMEZONE resolution — T20 config externalization, T11 host-resolution).
// Runner: npx tsx --test test/timezone.unit.test.ts
// DB 불필요 — 순수 함수 + 모듈 상수 일관성 검증.
//
// resolveDayBucketTimezone 의 auto/host 분기는 INJECTED host-detection seam
// (HostTimezoneResolver 2번째 인자)으로만 검증한다 — 러너 ambient tz(launchd
// TZ=UTC shadow 하에서 'UTC')에 의존하면 flaky 하므로 절대 사용하지 않는다.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DAY_BUCKET_TIMEZONE,
  resolveDayBucketTimezone,
  type ConfigAlarmSink,
  type HostTimezoneResolver,
} from "../src/server/timezone.js";

// 결정론적 fake host resolver 들 (ambient tz 비의존).
const hostUndefined: HostTimezoneResolver = () => undefined;
const hostEmpty: HostTimezoneResolver = () => "";
const hostUtc: HostTimezoneResolver = () => "UTC";
const hostValid: HostTimezoneResolver = () => "Europe/Paris";
const hostInvalid: HostTimezoneResolver = () => "Not/A_Zone";

// ── auto 분기: 명시 'auto' → host 감지 ────────────────────────────────────

test("auto + host 감지 성공(유효 IANA) → 감지된 host tz 채택", () => {
  assert.strictEqual(resolveDayBucketTimezone("auto", hostValid), "Europe/Paris");
});

test("auto + host 미해결(undefined) → last-resort Asia/Seoul (throw 아님)", () => {
  assert.strictEqual(resolveDayBucketTimezone("auto", hostUndefined), "Asia/Seoul");
});

test("auto + host 빈 문자열 → last-resort Asia/Seoul", () => {
  assert.strictEqual(resolveDayBucketTimezone("auto", hostEmpty), "Asia/Seoul");
});

test("auto + host 무효 명칭 → last-resort Asia/Seoul (auto 경로는 boot 중단 안 함)", () => {
  assert.strictEqual(resolveDayBucketTimezone("auto", hostInvalid), "Asia/Seoul");
});

// ── empty/undefined 분기: auto 와 동일 취급 (구 'always Asia/Seoul' 가정 교체) ──

test("env undefined → auto 와 동일하게 host 감지 경로 (host 유효 시 host 채택)", () => {
  // 구 동작: undefined → 무조건 Asia/Seoul. 신 동작: host 감지(주입된 seam).
  assert.strictEqual(resolveDayBucketTimezone(undefined, hostValid), "Europe/Paris");
});

test("빈 문자열 → auto 와 동일하게 host 감지 경로, host 미해결 시 Asia/Seoul", () => {
  assert.strictEqual(resolveDayBucketTimezone("", hostUndefined), "Asia/Seoul");
});

// ── explicit 분기: non-'auto' 구체 IANA ──────────────────────────────────

test("explicit 유효 IANA 는 그대로 통과 (host 와 divergence 여부 무관, 값 자체는 honor)", () => {
  // host 'UTC' 주입 → divergence 경고 억제(코드상 host==='UTC' 면 warn skip).
  assert.strictEqual(resolveDayBucketTimezone("America/New_York", hostUtc), "America/New_York");
  assert.strictEqual(resolveDayBucketTimezone("Europe/Berlin", hostUtc), "Europe/Berlin");
  assert.strictEqual(resolveDayBucketTimezone("UTC", hostUtc), "UTC");
});

test("explicit 무효 명칭 → boot-시점 loud fail (throw, env-var 명 포함)", () => {
  assert.throws(
    () => resolveDayBucketTimezone("Not/A_Zone", hostUtc),
    /invalid ATRIUM_TIMEZONE 'Not\/A_Zone'/,
    "invalid IANA name throws with the env-var name in the message",
  );
});

// ── production boot guard: NODE_ENV=production + ATRIUM_TIMEZONE 부재 ────────
// launchd 가 TZ=UTC 를 shadow 하므로 DEV-ONLY Intl 감지는 'UTC' 를 반환(실 host 아님).
// prod 에서 부재 → render-monitor-env.sh 미실행 misconfiguration → silent degrade 금지:
// prominent/surfaced alarm 발화 + last-resort 고정(shadow 'UTC' 미신뢰). dev 는 불변.

// 주입 alarm sink — 발화 메시지를 in-process 로 포착(기본 logger.error 미사용, 결정론적).
function captureAlarm(): { sink: ConfigAlarmSink; calls: string[] } {
  const calls: string[] = [];
  return { sink: (message) => calls.push(message), calls };
}

// 호출 여부를 세는 host resolver — prod 가드는 Intl fallback 을 아예 실행하지 않아야 한다.
function countingResolver(value: string | undefined): { resolver: HostTimezoneResolver; count: () => number } {
  let n = 0;
  return {
    resolver: () => {
      n += 1;
      return value;
    },
    count: () => n,
  };
}

test("prod + ATRIUM_TIMEZONE 부재(undefined) → alarm 발화 + last-resort 고정, Intl fallback 미실행", () => {
  const alarm = captureAlarm();
  const host = countingResolver("UTC"); // shadow 값을 반환하지만 prod 에선 신뢰 안 함
  const resolved = resolveDayBucketTimezone(undefined, host.resolver, "production", alarm.sink);
  assert.strictEqual(resolved, "Asia/Seoul", "prod 부재 → shadow 'UTC' 아닌 last-resort Asia/Seoul");
  assert.strictEqual(alarm.calls.length, 1, "prod 부재는 silent 아니라 prominent alarm 1회");
  assert.match(alarm.calls[0] ?? "", /NODE_ENV=production/, "alarm 메시지에 prod 컨텍스트 포함");
  assert.match(alarm.calls[0] ?? "", /render-monitor-env\.sh/, "alarm 메시지에 remediation 포함");
  assert.strictEqual(host.count(), 0, "prod 가드는 DEV-ONLY Intl fallback 을 아예 호출하지 않음");
});

test("prod + 'auto' 명시(부재와 동치) → 동일하게 alarm + last-resort 고정", () => {
  const alarm = captureAlarm();
  const resolved = resolveDayBucketTimezone("auto", hostUtc, "production", alarm.sink);
  assert.strictEqual(resolved, "Asia/Seoul");
  assert.strictEqual(alarm.calls.length, 1);
});

test("dev(NODE_ENV=development) + 부재 → Intl fallback 그대로 실행(불변), alarm 미발화", () => {
  const alarm = captureAlarm();
  const resolved = resolveDayBucketTimezone(undefined, hostValid, "development", alarm.sink);
  assert.strictEqual(resolved, "Europe/Paris", "dev 는 host 감지 fallback 을 그대로 채택");
  assert.strictEqual(alarm.calls.length, 0, "dev 경로는 prod alarm 을 발화하지 않음");
});

test("prod + explicit 유효 IANA 존재 → 가드 미발동(명시값 honor, alarm 미발화)", () => {
  const alarm = captureAlarm();
  const resolved = resolveDayBucketTimezone("America/New_York", hostUtc, "production", alarm.sink);
  assert.strictEqual(resolved, "America/New_York", "명시값이 있으면 prod 가드는 개입하지 않음");
  assert.strictEqual(alarm.calls.length, 0);
});

// ── 모듈 상수 일관성 ──────────────────────────────────────────────────────

test("DAY_BUCKET_TIMEZONE: 현재 프로세스 env 와 일관 (모듈 상수 = resolve 결과)", () => {
  assert.strictEqual(
    DAY_BUCKET_TIMEZONE,
    resolveDayBucketTimezone(process.env.ATRIUM_TIMEZONE),
  );
});
