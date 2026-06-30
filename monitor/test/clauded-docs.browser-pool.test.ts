// 공유 chromium browser pool 회귀 테스트 — PDF + HTML export 가 단일 chromium 공유, reset 시 relaunch.
// real chromium (Playwright, 경계라 모킹 없음) → `npx playwright install chromium` 선행 필요.

import test, { after } from "node:test";
import assert from "node:assert/strict";

import {
  acquireBrowser,
  getBrowserLaunchHealth,
  probeBrowserLaunch,
  resetBrowserForTests,
} from "../src/server/clauded-docs/browser-pool.js";

after(async () => {
  await resetBrowserForTests();
});

test("acquireBrowser: returns a connected browser", async () => {
  const browser = await acquireBrowser();
  assert.ok(browser.isConnected(), "acquired browser is connected");
});

test("acquireBrowser: reuses the same instance across calls (single shared chromium)", async () => {
  const first = await acquireBrowser();
  const second = await acquireBrowser();
  assert.strictEqual(first, second, "second acquire returns the SAME browser instance");
});

test("acquireBrowser: concurrent first-callers share a single launch", async () => {
  await resetBrowserForTests();
  // Fire both before either resolves — the in-flight guard must hand both the
  // same instance rather than racing two chromium spawns.
  const [a, b] = await Promise.all([acquireBrowser(), acquireBrowser()]);
  assert.strictEqual(a, b, "concurrent acquires share one launch");
});

test("resetBrowserForTests: forces a relaunch (new instance after reset)", async () => {
  const before = await acquireBrowser();
  await resetBrowserForTests();
  const afterReset = await acquireBrowser();
  assert.notStrictEqual(
    before,
    afterReset,
    "reset clears the cache so the next acquire relaunches a fresh browser",
  );
  // The stale handle is closed; the fresh one is connected.
  assert.ok(afterReset.isConnected(), "relaunched browser is connected");
});

test("disconnected browser → next acquire relaunches instead of returning a dead handle", async () => {
  const browser = await acquireBrowser();
  // Simulate a crash/manual close — the pool's disconnected handler clears the
  // cache; the next acquire MUST hand back a fresh connected instance.
  await browser.close();
  const relaunched = await acquireBrowser();
  assert.notStrictEqual(browser, relaunched, "dead handle is not returned");
  assert.ok(relaunched.isConnected(), "relaunched after disconnect is connected");
});

test("probeBrowserLaunch: unprobed → 성공 probe 가 launchHealth 를 ok + checked_at 로 갱신", async () => {
  await resetBrowserForTests();
  assert.strictEqual(getBrowserLaunchHealth().status, "unprobed", "reset 직후는 unprobed");
  const health = await probeBrowserLaunch();
  assert.strictEqual(health.status, "ok", `probe 성공이어야 함: ${JSON.stringify(health)}`);
  assert.ok(
    typeof health.checked_at === "string" && health.checked_at.length > 0,
    "checked_at ISO timestamp 기록",
  );
  assert.strictEqual(getBrowserLaunchHealth().status, "ok", "모듈 health 상태에도 반영");
});

test("probeBrowserLaunch: 연결된 공유 인스턴스가 있으면 재사용 — probe 가 공유 browser 를 닫지 않음", async () => {
  await resetBrowserForTests();
  const shared = await acquireBrowser();
  const health = await probeBrowserLaunch();
  assert.strictEqual(health.status, "ok");
  assert.ok(shared.isConnected(), "probe 후에도 공유 인스턴스 연결 유지");
});

test("acquireBrowser: 실제 launch 도 launchHealth 를 ok 로 갱신 (boot probe 이후 상태 추적)", async () => {
  await resetBrowserForTests();
  assert.strictEqual(getBrowserLaunchHealth().status, "unprobed");
  await acquireBrowser();
  assert.strictEqual(getBrowserLaunchHealth().status, "ok");
});
