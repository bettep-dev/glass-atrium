// browser_reason 경로 노출 회귀 — red-team #21 형제 사이트. chromium launch 실패
// 메시지에 박힌 브라우저 바이너리 절대경로가 미인증 GET /api/health 응답으로 새는지
// 방지한다. buildLaunchFailReason 이 launchHealth.reason(→ browser_reason) 을 만드는
// 순수 함수 → 실제 chromium/DB 없이 검증(모킹 불필요).

import test from "node:test";
import assert from "node:assert/strict";

import { buildLaunchFailReason } from "../src/server/clauded-docs/browser-pool.js";

// 절대경로 흔적 — 어떤 launch 실패 입력에도 결과에 남아선 안 됨.
const PATH_MARKERS = ["/Users/", "/home/"];

function assertPathFreeNonEmpty(reason: string): void {
  assert.ok(reason.length > 0, "진단용 reason 은 비어있지 않아야 함");
  for (const marker of PATH_MARKERS) {
    assert.ok(
      !reason.includes(marker),
      `browser_reason 에 절대경로(${marker}) 노출 금지: ${JSON.stringify(reason)}`,
    );
  }
}

test("buildLaunchFailReason: Playwright 절대경로 메시지(코드 없음) → 경로 없는 일반 사유", () => {
  // Playwright 의 전형적 실패 — errno code 없이 message 에 바이너리 절대경로를 담음.
  const err = new Error(
    "browserType.launch: Executable doesn't exist at " +
      "/Users/testuser/Library/Caches/ms-playwright/chromium-1179/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  );
  const reason = buildLaunchFailReason(err);
  assertPathFreeNonEmpty(reason);
  assert.strictEqual(reason, "chromium launch failed");
});

test("buildLaunchFailReason: spawn errno(ENOENT) → 경로 없는 errno 코드만", () => {
  const err = Object.assign(
    new Error("spawn /Users/testuser/.cache/ms-playwright/chromium/chrome ENOENT"),
    { code: "ENOENT" },
  );
  const reason = buildLaunchFailReason(err);
  assertPathFreeNonEmpty(reason);
  assert.strictEqual(reason, "launch error (ENOENT)");
});

test("buildLaunchFailReason: Linux /home 절대경로 메시지 → 경로 없는 일반 사유", () => {
  const err = new Error(
    "Executable doesn't exist at /home/ci/.cache/ms-playwright/chromium-1179/chrome-linux/chrome",
  );
  const reason = buildLaunchFailReason(err);
  assertPathFreeNonEmpty(reason);
});

test("buildLaunchFailReason: EACCES errno → 경로 없는 errno 코드만", () => {
  const err = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
  const reason = buildLaunchFailReason(err);
  assertPathFreeNonEmpty(reason);
  assert.strictEqual(reason, "launch error (EACCES)");
});

test("buildLaunchFailReason: 비-Error 값 → 경로 없는 일반 사유(비어있지 않음)", () => {
  for (const value of ["/Users/testuser/leak", undefined, null, 42]) {
    const reason = buildLaunchFailReason(value);
    assertPathFreeNonEmpty(reason);
    assert.strictEqual(reason, "chromium launch failed");
  }
});
