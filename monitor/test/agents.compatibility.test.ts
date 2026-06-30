// agent-registry compatibility 필드 단위 테스트.
// 핵심 invariant — compatibility 미선언 시 null (throw 금지) · registry v1.0 → v1.1 backwards-compat.

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadAgentRegistry,
  resetAgentRegistryCache,
  type AgentRegistryEntry,
} from "../src/server/agents/registry.js";

let tmpRoot: string;
let registryPath: string;

// 3 agent · 일부만 compatibility 선언 (react-dev 미선언 = backwards-compat 검증 대상).
const FIXTURE_PARTIAL_COMPATIBILITY = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    "nodejs-dev": {
      domains: ["nodejs", "esm"],
      phase: "implementation",
      dual_phase: true,
      compatibility: "monitor running at 127.0.0.1:7842",
    },
    reporter: {
      domains: ["report", "html-emit"],
      phase: "report",
      dual_phase: false,
      compatibility: "monitor api /clauded-docs available",
    },
    "react-dev": {
      // compatibility 의도적 누락 — backwards-compat 검증용.
      domains: ["react"],
      phase: "implementation",
      dual_phase: true,
    },
  },
};

// 모든 agent compatibility 미선언 — registry v1.0 시뮬레이션.
const FIXTURE_LEGACY_V1 = {
  $schema: "agent-registry",
  version: "1.0",
  agents: {
    "nodejs-dev": {
      domains: ["nodejs"],
      phase: "implementation",
      dual_phase: true,
    },
    reporter: {
      domains: ["report"],
      phase: "report",
      dual_phase: false,
    },
  },
};

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "agent-registry-test-"));
  registryPath = join(tmpRoot, "agent-registry.json");
});

after(async () => {
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // 각 테스트 hermetic — 캐시 reset + env 재주입.
  resetAgentRegistryCache();
  process.env.AGENT_REGISTRY_PATH = registryPath;
});

test("loadAgentRegistry: 정상 JSON → entries 로 파싱", async () => {
  await writeFile(registryPath, JSON.stringify(FIXTURE_PARTIAL_COMPATIBILITY), "utf8");
  const entries = await loadAgentRegistry();
  // 3 agent 모두 반환.
  assert.strictEqual(entries.size, 3);
  assert.ok(entries.has("nodejs-dev"));
  assert.ok(entries.has("reporter"));
  assert.ok(entries.has("react-dev"));
});

test("loadAgentRegistry: compatibility 선언 agent → 값 그대로", async () => {
  await writeFile(registryPath, JSON.stringify(FIXTURE_PARTIAL_COMPATIBILITY), "utf8");
  const entries = await loadAgentRegistry();
  const nodejsDev = entries.get("nodejs-dev");
  assert.ok(nodejsDev !== undefined);
  assert.strictEqual(nodejsDev.compatibility, "monitor running at 127.0.0.1:7842");
});

test("loadAgentRegistry: compatibility 미선언 agent → null (backwards-compat invariant)", async () => {
  await writeFile(registryPath, JSON.stringify(FIXTURE_PARTIAL_COMPATIBILITY), "utf8");
  const entries = await loadAgentRegistry();
  const reactDev = entries.get("react-dev");
  assert.ok(reactDev !== undefined);
  // 핵심 invariant — 누락 = null (throw 아님).
  assert.strictEqual(reactDev.compatibility, null);
});

test("loadAgentRegistry: legacy v1.0 registry (모든 agent compatibility 미선언) → 모두 null", async () => {
  await writeFile(registryPath, JSON.stringify(FIXTURE_LEGACY_V1), "utf8");
  const entries = await loadAgentRegistry();
  // 전체 agent 가 null compatibility — registry version bump 전 호환.
  for (const [name, entry] of entries) {
    assert.strictEqual(
      entry.compatibility,
      null,
      `legacy v1.0 ${name}.compatibility expected null`,
    );
  }
});

test("loadAgentRegistry: 캐시 동작 — 두 번째 호출은 fs read 우회", async () => {
  await writeFile(registryPath, JSON.stringify(FIXTURE_PARTIAL_COMPATIBILITY), "utf8");
  const first = await loadAgentRegistry();
  // fixture 파일 삭제 후에도 두 번째 호출은 캐시에서 성공.
  await rm(registryPath, { force: true });
  const second = await loadAgentRegistry();
  assert.strictEqual(first, second, "동일한 Map 인스턴스 반환 (캐시 hit)");
});

test("loadAgentRegistry: ENOENT (파일 없음) → 빈 Map fallback (서버 기동 차단 금지)", async () => {
  // 일부러 존재하지 않는 경로 주입.
  process.env.AGENT_REGISTRY_PATH = join(tmpRoot, "does-not-exist.json");
  resetAgentRegistryCache();
  const entries = await loadAgentRegistry();
  // 빈 Map — monitor 서버는 registry 없이도 부팅 가능해야 함 (degrade gracefully).
  assert.strictEqual(entries.size, 0);
});

test("loadAgentRegistry: 잘못된 JSON → 빈 Map fallback (서버 기동 차단 금지)", async () => {
  await writeFile(registryPath, "{ this is not valid json", "utf8");
  const entries = await loadAgentRegistry();
  // 손상된 registry 가 서버 전체를 다운시키면 안 됨 — 빈 Map 으로 fallback.
  assert.strictEqual(entries.size, 0);
});

test("AgentRegistryEntry.compatibility: 타입은 string | null 만 허용", async () => {
  // 비-string·비-null 값 (number 42) → null 로 강제 변환 (방어적 정규화).
  const malformed = {
    $schema: "agent-registry",
    version: "1.1",
    agents: {
      "bad-agent": {
        domains: ["x"],
        phase: "implementation",
        dual_phase: true,
        compatibility: 42, // 의도적 잘못된 타입.
      },
    },
  };
  await writeFile(registryPath, JSON.stringify(malformed), "utf8");
  const entries = await loadAgentRegistry();
  const bad = entries.get("bad-agent");
  assert.ok(bad !== undefined);
  // 방어적 normalize — number 등 비-string 은 null 로 (런타임 가드).
  assert.strictEqual(bad.compatibility, null);
});

test("AgentRegistryEntry: 빈 string compatibility → null 로 normalize", async () => {
  // 빈 문자열은 의미 없음 — null 동치 취급.
  const fixture = {
    $schema: "agent-registry",
    version: "1.1",
    agents: {
      "empty-agent": {
        domains: ["x"],
        phase: "implementation",
        dual_phase: true,
        compatibility: "",
      },
    },
  };
  await writeFile(registryPath, JSON.stringify(fixture), "utf8");
  const entries = await loadAgentRegistry();
  const e = entries.get("empty-agent");
  assert.ok(e !== undefined);
  assert.strictEqual(e.compatibility, null);
});

test("AgentRegistryEntry 타입: domains · phase · compatibility 필드 노출", async () => {
  // 타입은 컴파일러 차원의 검증이지만, 런타임에서 필수 필드 존재만 확인.
  await writeFile(registryPath, JSON.stringify(FIXTURE_PARTIAL_COMPATIBILITY), "utf8");
  const entries = await loadAgentRegistry();
  const nodejsDev: AgentRegistryEntry | undefined = entries.get("nodejs-dev");
  assert.ok(nodejsDev !== undefined);
  assert.ok(Array.isArray(nodejsDev.domains));
  assert.strictEqual(typeof nodejsDev.phase, "string");
  // compatibility 는 string | null — 타입 선언 자체가 TS 컴파일러로 검증됨.
  assert.ok(nodejsDev.compatibility === null || typeof nodejsDev.compatibility === "string");
});
