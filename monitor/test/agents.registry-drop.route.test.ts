// agent-registry 기본 경로 해석 회귀 테스트 — ~/.claude 드롭 이후 불변식.
// 핵심 invariant — AGENT_REGISTRY_PATH 미설정 시 registry JSON 과 agents/ .md 디렉터리
// 모두 ~/.glass-atrium 아래에서 해석 · 레거시 ~/.claude 는 어떤 경로로도 참조 금지.
// 헤르메틱 장치: POSIX os.homedir() 는 $HOME env 를 우선하므로 HOME 을 tmpdir 로
// 재지정해 실제 홈 디렉터리를 건드리지 않고 기본 경로 분기를 실행한다.

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadAgentRegistry,
  loadCanonicalAgentKeys,
  resetAgentRegistryCache,
} from "../src/server/agents/registry.js";

let tmpHome: string;
let savedHome: string | undefined;
let savedRegistryPath: string | undefined;

// 정본 fixture — ~/.glass-atrium 아래 (기본 경로가 반드시 도달해야 하는 위치).
const FIXTURE_ATRIUM_REGISTRY = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    "glass-atrium-dev-node": {
      domains: ["nodejs", "esm"],
      phase: "implementation",
      dual_phase: true,
    },
    "glass-atrium-qa-code-reviewer": {
      domains: ["review"],
      phase: "review",
      dual_phase: false,
    },
  },
};

// 미끼 fixture — 레거시 ~/.claude 아래. 어떤 agent 명도 정본과 겹치지 않게 하여
// 이 이름이 로드 결과에 나타나면 곧 레거시 경로 참조(회귀)로 판정 가능.
const FIXTURE_LEGACY_DECOY_REGISTRY = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    "legacy-decoy-agent": {
      domains: ["decoy"],
      phase: "implementation",
      dual_phase: false,
    },
  },
};

// H6 dedupe 충돌 fixture — prefixed 키와 그 bare alias("dev-node")가 registry 에
// 동시 존재 + alias 파생이 없어야 하는 비접두 user-origin 키("custom-helper").
// Set dedupe 없이 flatMap 만 하면 "dev-node" 가 2회(bare 키 passthrough +
// prefixed 키 alias 파생) 나오므로, 이 fixture 가 dedupe 삭제 회귀를 실제로 잡는다.
const FIXTURE_DUAL_MATCH_COLLISION_REGISTRY = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    "glass-atrium-dev-node": {
      domains: ["nodejs"],
      phase: "implementation",
      dual_phase: false,
    },
    "dev-node": {
      domains: ["legacy"],
      phase: "implementation",
      dual_phase: false,
    },
    "custom-helper": {
      domains: ["user"],
      phase: "implementation",
      dual_phase: false,
      origin: "user",
    },
  },
};

const ATRIUM_DEV_NODE_MD = `---
description: Node.js ESM CLI and MCP server implementation specialist. Use when building Node tooling.
---

# glass-atrium-dev-node
`;

// 미끼 .md — 정본과 다른 description 으로, 값이 이쪽이면 agents-dir 가 레거시로 샜다는 뜻.
const LEGACY_DEV_NODE_MD = `---
description: LEGACY DECOY description that must never surface.
---

# glass-atrium-dev-node (legacy decoy)
`;

async function writeAtriumFixtures(home: string): Promise<void> {
  const atriumRoot = join(home, ".glass-atrium");
  await mkdir(join(atriumRoot, "agents"), { recursive: true });
  await writeFile(
    join(atriumRoot, "agent-registry.json"),
    JSON.stringify(FIXTURE_ATRIUM_REGISTRY),
    "utf8",
  );
  await writeFile(
    join(atriumRoot, "agents", "glass-atrium-dev-node.md"),
    ATRIUM_DEV_NODE_MD,
    "utf8",
  );
}

async function writeDualMatchCollisionFixtures(home: string): Promise<void> {
  const atriumRoot = join(home, ".glass-atrium");
  // agents/ .md 없이 registry JSON 만 배치 — description enrich 는 결측 허용
  // (Promise.allSettled → null)이라 키 계산 검증에는 불필요.
  await mkdir(atriumRoot, { recursive: true });
  await writeFile(
    join(atriumRoot, "agent-registry.json"),
    JSON.stringify(FIXTURE_DUAL_MATCH_COLLISION_REGISTRY),
    "utf8",
  );
}

async function writeLegacyDecoyFixtures(home: string): Promise<void> {
  const legacyRoot = join(home, ".claude");
  await mkdir(join(legacyRoot, "agents"), { recursive: true });
  await writeFile(
    join(legacyRoot, "agent-registry.json"),
    JSON.stringify(FIXTURE_LEGACY_DECOY_REGISTRY),
    "utf8",
  );
  await writeFile(
    join(legacyRoot, "agents", "glass-atrium-dev-node.md"),
    LEGACY_DEV_NODE_MD,
    "utf8",
  );
}

before(() => {
  savedHome = process.env.HOME;
  savedRegistryPath = process.env.AGENT_REGISTRY_PATH;
});

after(async () => {
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
  if (savedRegistryPath === undefined) {
    delete process.env.AGENT_REGISTRY_PATH;
  } else {
    process.env.AGENT_REGISTRY_PATH = savedRegistryPath;
  }
  resetAgentRegistryCache();
  if (tmpHome !== undefined) {
    await rm(tmpHome, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  // 각 테스트 hermetic — 새 HOME + 캐시 reset + override env 제거(기본 분기 강제).
  if (tmpHome !== undefined) {
    await rm(tmpHome, { recursive: true, force: true });
  }
  tmpHome = await mkdtemp(join(tmpdir(), "registry-drop-test-"));
  process.env.HOME = tmpHome;
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
});

test("기본 경로: AGENT_REGISTRY_PATH 미설정 → ~/.glass-atrium/agent-registry.json 해석", async () => {
  await writeAtriumFixtures(tmpHome);
  const entries = await loadAgentRegistry();
  assert.strictEqual(entries.size, 2);
  assert.ok(entries.has("glass-atrium-dev-node"));
  assert.ok(entries.has("glass-atrium-qa-code-reviewer"));
});

test("레거시 드롭: ~/.claude 레지스트리만 존재 → 빈 Map (레거시 경로 불참조)", async () => {
  // ~/.glass-atrium 은 비워두고 미끼만 배치 — fallback 이 있었다면 미끼가 로드된다.
  await writeLegacyDecoyFixtures(tmpHome);
  const entries = await loadAgentRegistry();
  assert.strictEqual(entries.size, 0);
});

test("레거시 드롭: 양쪽 공존 시 ~/.glass-atrium 만 로드, 미끼 agent 부재", async () => {
  await writeAtriumFixtures(tmpHome);
  await writeLegacyDecoyFixtures(tmpHome);
  const entries = await loadAgentRegistry();
  assert.strictEqual(entries.size, 2);
  assert.strictEqual(entries.has("legacy-decoy-agent"), false);
});

test("agents-dir 기본 경로: description 은 ~/.glass-atrium/agents/<name>.md 에서 enrich", async () => {
  await writeAtriumFixtures(tmpHome);
  // 미끼 .md 동시 배치 — 값이 미끼 쪽이면 agents-dir 해석이 레거시로 새는 회귀.
  await writeLegacyDecoyFixtures(tmpHome);
  const entries = await loadAgentRegistry();
  const devNode = entries.get("glass-atrium-dev-node");
  assert.ok(devNode !== undefined);
  // toRoleLine 첫 문장 절삭 규칙 반영.
  assert.strictEqual(
    devNode.description,
    "Node.js ESM CLI and MCP server implementation specialist.",
  );
});

test("기본 경로 ENOENT: ~/.glass-atrium 부재 → 빈 Map fallback (기동 차단 금지)", async () => {
  const entries = await loadAgentRegistry();
  assert.strictEqual(entries.size, 0);
});

test("loadCanonicalAgentKeys: 기본 경로 registry 의 키 배열 반환 (membership 게이트 SoT)", async () => {
  await writeAtriumFixtures(tmpHome);
  const keys = await loadCanonicalAgentKeys();
  // H6 전환창 dual-match 반영 — prefixed 정본 키 + bare legacy alias 동시 반환.
  assert.deepStrictEqual(
    [...keys].sort(),
    [
      "dev-node",
      "glass-atrium-dev-node",
      "glass-atrium-qa-code-reviewer",
      "qa-code-reviewer",
    ],
  );
});

// H6 rename-전환창 dual-match 회귀 테스트 — pre-rename DB 행은 bare agent 명
// (dev-node 등)을 갖고, prefixed-only IN-list 는 그 히스토리 전체를 숨긴다
// (배포 회귀: /api/outcomes/search total 0). 거울 구현:
// monitor/src/server/routes/improvement.ts DEV_AGENT_PREFIX dual-match —
// 전환창 종료 시 registry.ts 쪽과 함께 제거.
test("H6 전환 dual-match: bare alias 충돌 시 정확히 1회 + 비접두 키 passthrough", async () => {
  await writeDualMatchCollisionFixtures(tmpHome);
  const keys = await loadCanonicalAgentKeys();
  // 정확-배열 단언이 세 분기를 모두 고정한다:
  // 1. prefixed 키 + de-prefixed alias 동시 반환 (dual-match 본체)
  // 2. registry 의 bare "dev-node" 와 alias 파생 "dev-node" 가 1회로 dedupe —
  //    registry.ts 의 Set dedupe 를 지우면 "dev-node" 가 2회가 되어 실패한다
  // 3. 비접두 user-origin 키는 alias 파생 없이 그대로 통과 (passthrough 분기)
  assert.deepStrictEqual(
    [...keys].sort(),
    ["custom-helper", "dev-node", "glass-atrium-dev-node"],
  );
});
