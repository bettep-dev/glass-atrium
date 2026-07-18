// agent-registry 캐시 무효화 회귀 (DF-12) — DELETE 커밋이 registry 파일을 out-of-process
// 로 재작성해도 싱글턴 캐시가 갱신되지 않아 삭제된 agent 가 계속 노출되던 결함.
// 두 갱신 경로를 고정: (1) 명시적 invalidateAgentRegistryCache 즉시 축출,
// (2) mtime revalidation — 파일 mtime 변화만으로 자동 재로드. DB 무의존(fs fixture).
// Runner: npx tsx --test test/agents.registry-cache.unit.test.ts

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  invalidateAgentRegistryCache,
  loadAgentRegistry,
  resetAgentRegistryCache,
} from "../src/server/agents/registry.js";

let tmpRoot: string;
let registryPath: string;
let savedRegistryPath: string | undefined;

function registryWith(...names: string[]): string {
  const agents: Record<string, unknown> = {};
  for (const name of names) {
    agents[name] = { domains: ["test"], phase: "implementation", dual_phase: false };
  }
  return JSON.stringify({ $schema: "agent-registry", version: "1.1", agents });
}

before(() => {
  savedRegistryPath = process.env.AGENT_REGISTRY_PATH;
});

after(async () => {
  if (savedRegistryPath === undefined) {
    delete process.env.AGENT_REGISTRY_PATH;
  } else {
    process.env.AGENT_REGISTRY_PATH = savedRegistryPath;
  }
  resetAgentRegistryCache();
  if (tmpRoot !== undefined) {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  if (tmpRoot !== undefined) {
    await rm(tmpRoot, { recursive: true, force: true });
  }
  tmpRoot = await mkdtemp(join(tmpdir(), "registry-cache-test-"));
  registryPath = join(tmpRoot, "agent-registry.json");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();
});

test("명시적 무효화: invalidate 후 다음 로드가 삭제 agent 를 제외", async () => {
  await writeFile(registryPath, registryWith("agent-a", "agent-b"), "utf8");
  const first = await loadAgentRegistry();
  assert.ok(first.has("agent-a"));

  // out-of-process DELETE 모사 — agent-a 제거로 파일 재작성.
  await writeFile(registryPath, registryWith("agent-b"), "utf8");
  invalidateAgentRegistryCache();

  const second = await loadAgentRegistry();
  assert.strictEqual(second.has("agent-a"), false, "삭제 agent 는 재조회에서 제외");
  assert.ok(second.has("agent-b"));
});

test("mtime revalidation: 명시적 무효화 없이 mtime 변화만으로 자동 재로드", async () => {
  await writeFile(registryPath, registryWith("agent-a"), "utf8");
  const first = await loadAgentRegistry();
  assert.ok(first.has("agent-a"));

  // 재작성 후 mtime 을 명확히 미래로 밀어 stat 비교가 결정적으로 불일치하게 만든다
  // (동일 ms 재작성 회피 — 이 경로는 명시적 invalidate 없이 검증).
  await writeFile(registryPath, registryWith("agent-c"), "utf8");
  const future = new Date(Date.now() + 5000);
  await utimes(registryPath, future, future);

  const second = await loadAgentRegistry();
  assert.strictEqual(second.has("agent-a"), false, "mtime 변화 → 재로드");
  assert.ok(second.has("agent-c"));
});

test("mtime 불변: 재작성 없으면 캐시 인스턴스 재사용", async () => {
  await writeFile(registryPath, registryWith("agent-a"), "utf8");
  const first = await loadAgentRegistry();
  const second = await loadAgentRegistry();
  assert.strictEqual(first, second, "동일 파일 → 동일 Map 인스턴스(재파싱 회피)");
});
