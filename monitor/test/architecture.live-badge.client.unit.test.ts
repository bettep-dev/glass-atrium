// Unit tests for the client-side cron-node live-badge fold in
// public/src/screens/architecture.jsx (F39): two daemons can bind ONE node id
// (cron: daily-restart-autoagent + daily-restart-wiki, per DAEMON_NODE_BINDINGS).
// buildLiveDaemonsByNodeId must keep a LIST per node id so no status is dropped.
// Pre-fix, the Map was `set(nid, d)` (last-writer-wins) — one daemon silently
// vanished and the drawer showed a single pill.
//
// Runner: npx tsx --test test/architecture.live-badge.client.unit.test.ts
//
// architecture.jsx is a browser global module (top-level `const { useState } = React`,
// JSX, `window.ScreenArchitecture =` export) with NO import/export — so esbuild emits
// it as a plain script whose top-level `function` declarations land on the vm context
// global. The test evaluates the ACTUAL shipped source in a node:vm sandbox with
// minimal React/window.UI stubs, then exercises the real helpers — not a drift-prone
// copy. No DB / no network is touched (the tested helpers are pure).

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH_SRC = resolve(__dirname, "../public/src/screens/architecture.jsx");
// KPI 분모의 SoT — index.html:106 이 architecture.js(:116) 보다 먼저 싣는 순수 모델.
// 샌드박스에도 같은 순서로 실어 맵이 실제로 읽는 window.HealthModel 을 진짜 모듈로 둠.
const HEALTH_MODEL_SRC = resolve(__dirname, "../public/src/data/health-model.js");

interface DaemonLiveStatus {
  daemon_name: string;
  status: string;
  // 서버가 임계를 적용해 낸 판정 — /api/architecture/live 와 /api/health/daemons 가 같은 이름으로 냄.
  effective_status?: string;
  node_ids: string[];
  last_run_at?: string | null;
  // 화면이 읽지 않는 원자료. 두 값이 있어도 tone 이 움직이지 않는다는 것이 아래 단언 대상임.
  expected_cadence_minutes?: number;
  staleness_minutes?: number;
}
interface DaemonRow {
  name: string;
  tone: string;
  statusLabel: string;
  nodeIds: string[];
  lastRunAt: string | null;
}
// 맵이 흡수한 health 응답 5종의 상태 묶음 — health.jsx 의 fetch 상태와 같은 모양.
interface FetchState {
  status: string;
  data: unknown;
  error: string | null;
}
interface MapHealthStates {
  daemonState: FetchState;
  pgState: FetchState;
  hookState: FetchState;
  hookFailState: FetchState;
}
interface OverviewKpis {
  okCount: number | string;
  degradedCount: number | string;
  infoCount: number | string;
  staleCount: number | string;
  totalCount: number | string;
}
interface HealthCardDef {
  id: string;
  kind: string;
}
interface GlobalDetailBlock {
  id: string;
  render: (states: unknown) => unknown;
}
interface HealthModelGlobal {
  HEALTH_CARD_DEFS: HealthCardDef[];
  computeOverviewKpis: (states: MapHealthStates) => OverviewKpis;
}

interface ArchHelpers {
  // 맵이 흡수한 health 엔드포인트 표(ADR-B1 R2) — health.jsx:42-47 의 5종.
  getMapHealthEndpoints: (payloadDaemon: string) => string[];
  // KPI 집계 위임 — 맵은 카드 목록을 다시 적지 않고 window.HealthModel 에 넘김.
  getMapHealthKpis: (states: MapHealthStates) => OverviewKpis | null;
  // 전역 확장 블록 컨테이너 — 등록된 블록이 없으면 렌더 트리에 아무것도 남기지 않음.
  GlobalDetailRegion: (props: { blocks?: GlobalDetailBlock[] }) => unknown;
  getGlobalDetailBlocks: () => GlobalDetailBlock[];
  buildLiveDaemonsByNodeId: (
    daemons: DaemonLiveStatus[] | null | undefined,
  ) => Map<string, DaemonLiveStatus[]>;
  getLiveDaemonRows: (daemons: DaemonLiveStatus[] | null | undefined) => DaemonRow[];
  getLegibleFitScaleAR: (
    paneW: number,
    paneH: number,
    graphW: number,
    graphH: number,
  ) => number;
}

// window.UI.daemonStatusTone/Label mirror (ui.jsx DAEMON_STATUS_TONE, A2 SoT).
const DAEMON_STATUS_TONE: Record<string, { tone: string; label: string }> = {
  ok: { tone: "ok", label: "Healthy" },
  partial: { tone: "warn", label: "Warning" },
  error: { tone: "crit", label: "Down" },
  missing: { tone: "info", label: "No data" },
  stale: { tone: "crit", label: "Overdue" },
  quota_exceeded: { tone: "warn", label: "Usage limit" },
};

// Build once, evaluate in a sandbox — the real top-level helper declarations.
// 반환하는 code 가 AC-12 단언 대상(컴파일 산출물 원문) — 부재 단언은 sandbox 전역이 아니라
// 이 텍스트를 봄(제거된 축약기/목적 맵은 호출되지 않아도 선언만으로 되살아날 수 있음).
async function loadArch(): Promise<{ helpers: ArchHelpers; code: string; healthModel: HealthModelGlobal }> {
  const built = await esbuild.build({
    entryPoints: [ARCH_SRC],
    bundle: false,
    write: false,
    loader: { ".jsx": "jsx" },
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    target: "es2022",
    // No import/export → top-level fn decls become vm-context-global properties.
    format: "esm",
  });
  const code = built.outputFiles[0].text;

  // React stub — every hook returns a benign default; the (uninvoked) component
  // bodies touch React, so the stubs never actually drive a render.
  const reactStub = new Proxy(
    {
      createElement: () => ({}),
      Fragment: "frag",
      useState: () => [undefined, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useMemo: (fn: () => unknown) => fn(),
      useCallback: (fn: unknown) => fn,
    },
    { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => ({})) },
  );
  const uiStub = {
    daemonStatusTone: (s: string) =>
      (DAEMON_STATUS_TONE[s] || { tone: "info" }).tone,
    daemonStatusLabel: (s: string) =>
      (DAEMON_STATUS_TONE[s] || { label: s || "—" }).label,
  };
  const ctx: Record<string, unknown> = {
    window: { UI: uiStub },
    React: reactStub,
    document: { documentElement: {} },
    Intl,
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // index.html 의 적재 순서를 그대로 재현 — 모델 먼저, 화면 나중.
  // 사본이 아니라 출하되는 원본을 실어야 정의 목록이 진짜 참조로 공유됨.
  vm.runInContext(readFileSync(HEALTH_MODEL_SRC, "utf8"), ctx);
  vm.runInContext(code, ctx);

  const h = ctx as unknown as ArchHelpers;
  assert.strictEqual(
    typeof h.buildLiveDaemonsByNodeId,
    "function",
    "buildLiveDaemonsByNodeId must be reachable",
  );
  assert.strictEqual(
    typeof h.getLiveDaemonRows,
    "function",
    "getLiveDaemonRows must be reachable (AC-15(a) instrument)",
  );
  assert.strictEqual(
    typeof h.getLegibleFitScaleAR,
    "function",
    "getLegibleFitScaleAR must be reachable (AC-13 instrument)",
  );
  assert.strictEqual(
    typeof h.getMapHealthEndpoints,
    "function",
    "getMapHealthEndpoints must be reachable (T7 fetch-table instrument)",
  );
  assert.strictEqual(
    typeof h.getMapHealthKpis,
    "function",
    "getMapHealthKpis must be reachable (T7 KPI instrument)",
  );
  assert.strictEqual(
    typeof h.GlobalDetailRegion,
    "function",
    "GlobalDetailRegion must be reachable (T7 global-block container)",
  );

  const healthModel = (ctx.window as { HealthModel?: HealthModelGlobal }).HealthModel;
  assert.ok(
    healthModel && Array.isArray(healthModel.HEALTH_CARD_DEFS),
    "window.HealthModel must carry the card definitions the map's KPI denominator reads",
  );
  return { helpers: h, code, healthModel };
}

const { helpers: arch, code: archCode, healthModel } = await loadArch();

// 기본값은 서버가 임계 미만에서 내는 모양 — 판정이 마지막 상태와 같음.
// 초과 구간은 `effective_status` 를 명시해 덮어씀.
const daemon = (
  name: string,
  status: string,
  extra: Partial<DaemonLiveStatus> = {},
): DaemonLiveStatus => ({
  daemon_name: name,
  status,
  effective_status: status,
  node_ids: ["cron"],
  last_run_at: null,
  ...extra,
});

// --- buildLiveDaemonsByNodeId: the F39 collision fix (both daemons kept) ---

test("two daemons on one node id are BOTH kept as a list (no last-writer-wins drop)", () => {
  const map = arch.buildLiveDaemonsByNodeId([
    daemon("daily-restart-autoagent", "ok"),
    daemon("daily-restart-wiki", "error"),
  ]);
  const bound = map.get("cron");
  assert.ok(bound, "node 'cron' must have a bound list");
  assert.strictEqual(bound.length, 2, "both daemons must survive the collision");
  // The drawer maps 1:1 over this list → 2 entries == 2 pills rendered.
  // join to a primitive string: the list is a vm-realm array, so a structural
  // deepStrictEqual would trip on the cross-realm Array.prototype mismatch.
  assert.strictEqual(
    bound.map((d) => d.daemon_name).sort().join(","),
    "daily-restart-autoagent,daily-restart-wiki",
  );
});

test("collision keeps both regardless of input order (order-independent)", () => {
  const map = arch.buildLiveDaemonsByNodeId([
    daemon("daily-restart-wiki", "error"),
    daemon("daily-restart-autoagent", "ok"),
  ]);
  assert.strictEqual(map.get("cron")?.length, 2);
});

test("one daemon bound to many node ids appears under each id as a length-1 list", () => {
  const map = arch.buildLiveDaemonsByNodeId([
    daemon("autoagent", "ok", { node_ids: ["autoagent_d", "autoagent_ka"] }),
  ]);
  assert.strictEqual(map.get("autoagent_d")?.length, 1);
  assert.strictEqual(map.get("autoagent_ka")?.length, 1);
  assert.strictEqual(map.get("autoagent_d")?.[0].daemon_name, "autoagent");
});

test("empty / null daemon input yields an empty map (no throw)", () => {
  assert.strictEqual(arch.buildLiveDaemonsByNodeId([]).size, 0);
  assert.strictEqual(arch.buildLiveDaemonsByNodeId(null).size, 0);
  assert.strictEqual(arch.buildLiveDaemonsByNodeId(undefined).size, 0);
});

// --- AC-15(a): 표 행 수 == 소스 상태 행 수 (표 행 빌더 직접 호출) ---

test("AC-15(a) 표 행 수는 daemons 배열 원소 수와 1:1", () => {
  const daemons = [
    daemon("autoagent", "ok", { node_ids: ["autoagent_d"] }),
    daemon("daily-restart-wiki", "error"),
    daemon("wiki-compile", "missing", { node_ids: [], last_run_at: null }),
  ];
  const rows = arch.getLiveDaemonRows(daemons);
  assert.strictEqual(rows.length, daemons.length);
  assert.strictEqual(
    rows.map((r) => r.name).join(","),
    "autoagent,daily-restart-wiki,wiki-compile",
  );
  // 필드 누락 행도 삭제되지 않고 대체값으로 남음.
  assert.strictEqual(arch.getLiveDaemonRows([{} as DaemonLiveStatus]).length, 1);
});

test("AC-15(a) 빈/누락 입력은 빈 행 목록 (throw 없음)", () => {
  assert.strictEqual(arch.getLiveDaemonRows([]).length, 0);
  assert.strictEqual(arch.getLiveDaemonRows(null).length, 0);
  assert.strictEqual(arch.getLiveDaemonRows(undefined).length, 0);
});

// --- AC-T2: 판정은 서버 필드에서만 옴 (화면 재계산 삭제) ---

test("AC-T2 초과 판정은 서버 필드에서 tone·라벨로 그대로 나옴", () => {
  const [row] = arch.getLiveDaemonRows([
    daemon("autoagent", "ok", { effective_status: "stale" }),
  ]);
  assert.strictEqual(row.tone, "crit");
  assert.strictEqual(row.statusLabel, "Overdue");
});

test("AC-T2 cadence 를 넘긴 staleness 가 있어도 화면은 판정을 올리지 않음", () => {
  // 삭제된 재계산이 되살아나면 tone 이 warn 으로 밀리고 이 단언이 붉어짐.
  const [row] = arch.getLiveDaemonRows([
    daemon("autoagent", "ok", {
      expected_cadence_minutes: 1440,
      staleness_minutes: 2160,
    }),
  ]);
  assert.strictEqual(row.tone, "ok");
  assert.strictEqual(row.statusLabel, "Healthy");
});

test("AC-T2 판정 필드가 없으면 상태를 지어내지 않고 미상으로 남김", () => {
  const [row] = arch.getLiveDaemonRows([
    { daemon_name: "autoagent", status: "ok", node_ids: [] },
  ]);
  assert.strictEqual(row.tone, "info");
  assert.strictEqual(row.statusLabel, "—");
});

// --- AC-13: 순수 스케일 산식 — 하향 클램프가 되살아나면 붉어짐 ---

// 화면 상수와 짝. 리터럴 표류를 막기 위해 컴파일 산출물의 선언과 대조함.
const LEGIBLE_FIT_FLOOR = 0.6;

// 픽스처 격자 — 폭-fit 이 하한보다 작은 조합을 반드시 포함해야 함(AC-13 도메인 조건).
// 아래 `contains a width-fit below the floor` 단언이 그 조건 자체를 기계로 잠금.
const FIT_GRID: Array<[number, number, number, number]> = [
  [400, 400, 4000, 200], // 폭-fit 0.1 — 하한 미만, 하향 클램프의 유일한 무는 지점
  [400, 400, 800, 800], // fit 0.5 — 하한 미만
  [1200, 800, 1500, 1000], // fit 0.8 — 하한 초과, 클램프 없음
  [400, 400, 400, 400], // fit 1
  [800, 800, 200, 200], // fit 4 — 상한 1 로 잘림
];

test("AC-13 하한 상수가 화면 선언과 일치", () => {
  assert.match(archCode, /LEGIBLE_FIT_FLOOR\s*=\s*0\.6\b/);
});

test("AC-13 픽스처 격자는 폭-fit 이 하한 미만인 조합을 포함함", () => {
  const raw = FIT_GRID.map(([pw, ph, gw, gh]) => Math.min(pw / gw, ph / gh));
  assert.ok(
    raw.some((f) => f < LEGIBLE_FIT_FLOOR),
    "격자에서 하한 미만 조합을 빼면 AC-13 단언이 영구히 푸름",
  );
});

test("AC-13 어떤 입력에도 하한 미만을 반환하지 않고 1 을 넘지 않음", () => {
  for (const [pw, ph, gw, gh] of FIT_GRID) {
    const s = arch.getLegibleFitScaleAR(pw, ph, gw, gh);
    assert.ok(s >= LEGIBLE_FIT_FLOOR, `${pw}x${ph}/${gw}x${gh} -> ${s} < floor`);
    assert.ok(s <= 1, `${pw}x${ph}/${gw}x${gh} -> ${s} > 1`);
  }
  // 하한 미만 조합은 정확히 하한으로 올라옴(하향 클램프 복원 시 0.1 이 반환되어 실패).
  assert.strictEqual(arch.getLegibleFitScaleAR(400, 400, 4000, 200), LEGIBLE_FIT_FLOOR);
  // fit 이 하한을 넘으면 그대로 통과(상수로 뭉개지 않음).
  assert.strictEqual(arch.getLegibleFitScaleAR(1200, 800, 1500, 1000), 0.8);
});

test("AC-13 비정상 치수는 하한으로 떨어짐 (0/음수/NaN)", () => {
  assert.strictEqual(arch.getLegibleFitScaleAR(0, 400, 400, 400), LEGIBLE_FIT_FLOOR);
  assert.strictEqual(arch.getLegibleFitScaleAR(400, 400, 0, 400), LEGIBLE_FIT_FLOOR);
  assert.strictEqual(arch.getLegibleFitScaleAR(NaN, 400, 400, 400), LEGIBLE_FIT_FLOOR);
});

// --- AC-12: 설명 축약 경로와 하드코드 목적 맵이 둘 다 부재 ---

test("AC-12(a) 설명 축약 경로가 컴파일 산출물에 없음", () => {
  assert.doesNotMatch(archCode, /\btruncateText\b/);
  assert.doesNotMatch(archCode, /\bdiagramPurposeAR\b/);
});

test("AC-12(b) 하드코드 목적 문자열 맵이 컴파일 산출물에 없음", () => {
  assert.doesNotMatch(archCode, /\bTAB_PURPOSE\b/);
});

// --- T7: the map absorbs the five health responses -------------------------

// health.jsx:42-47 이 들고 있던 fetch 표. 맵이 흡수한 뒤에도 같은 5종이어야 함
// (ADR-B1 R2 — 서버 무변경, 요청을 옮기기만 함).
const EXPECTED_HEALTH_ENDPOINTS = [
  "/api/health/daemons",
  "/api/health/hook-chain",
  "/api/health",
  "/api/health/daemon-payload?daemon=autoagent&limit=10",
  "/api/health/hook-failures?days=30&limit=50",
];

test("T7 the map's health fetch table names the same five endpoints health.jsx read", () => {
  assert.strictEqual(
    arch.getMapHealthEndpoints("autoagent").join("\n"),
    EXPECTED_HEALTH_ENDPOINTS.join("\n"),
  );
});

test("T7 the payload endpoint carries the selected daemon, not a frozen literal", () => {
  const urls = arch.getMapHealthEndpoints("wiki");
  assert.ok(
    urls.some((u) => u.includes("daemon=wiki")),
    "daemon-payload must follow the selected daemon (T9c drills down through it)",
  );
});

// 카드 7종이 모두 ready 로 떨어지는 상태 묶음 — 분모가 정의 목록 길이와 같아지는 조건.
// daemonState 가 ready 면 daemon 카드는 명부에 없어도 info tone 으로 ready 임.
function getAllReadyHealthStates(): MapHealthStates {
  return {
    daemonState: { status: "ready", data: { daemons: [] }, error: null },
    pgState: {
      status: "ready",
      data: { status: "ok", db: "open", browser: "ok" },
      error: null,
    },
    hookState: { status: "ready", data: { events: [{ hook: "x" }] }, error: null },
    hookFailState: {
      status: "ready",
      data: { count_24h: 0, unretried_count_24h: 0 },
      error: null,
    },
  };
}

test("T7 the KPI denominator equals the health card definition count, not a map-local literal", () => {
  const kpis = arch.getMapHealthKpis(getAllReadyHealthStates());
  assert.ok(kpis, "KPI fold must resolve while window.HealthModel is loaded");
  assert.strictEqual(kpis.totalCount, healthModel.HEALTH_CARD_DEFS.length);
  // 분모 = ok + degraded + info (F02 불변식의 화면 몫).
  assert.strictEqual(
    Number(kpis.okCount) + Number(kpis.degradedCount) + Number(kpis.infoCount),
    kpis.totalCount,
  );
});

// RED 확보 기구 — `HEALTH_CARD_DEFS` 는 동결되지 않은 채 참조로 내보내지므로 픽스처가
// 변형했다 복원할 수 있음. 맵이 목록 길이를 자기 파일에 다시 적었다면 이 단언이 붉어짐.
// T14 가 쓸 기구를 여기서 먼저 세움 (§6 T14 행의 '의도적 파괴' 경로와 같은 기구).
test("T7 shrinking the shared definition list shrinks the map's KPI denominator", () => {
  const defs = healthModel.HEALTH_CARD_DEFS;
  const full = defs.length;
  const removed = defs.splice(1, 3);
  try {
    assert.strictEqual(removed.length, 3, "fixture precondition: three defs removed");
    const kpis = arch.getMapHealthKpis(getAllReadyHealthStates());
    assert.ok(kpis);
    assert.strictEqual(
      kpis.totalCount,
      full - 3,
      "denominator must follow HEALTH_CARD_DEFS — a map-local count would stay at the old total",
    );
    assert.strictEqual(kpis.totalCount, defs.length);
  } finally {
    // 복원 — 뒤 테스트가 온전한 목록을 보게 함. splice 반환분을 원래 자리에 되꽂음.
    defs.splice(1, 0, ...removed);
    assert.strictEqual(defs.length, full, "definition list must be restored");
  }
});

test("T7 an empty definition list yields an empty denominator, never a stale total", () => {
  const defs = healthModel.HEALTH_CARD_DEFS;
  const backup = defs.slice();
  defs.splice(0, defs.length);
  try {
    const kpis = arch.getMapHealthKpis(getAllReadyHealthStates());
    assert.ok(kpis);
    assert.strictEqual(kpis.totalCount, 0);
    assert.strictEqual(kpis.okCount, 0);
  } finally {
    defs.splice(0, 0, ...backup);
    assert.strictEqual(defs.length, backup.length, "definition list must be restored");
  }
});

// --- T7: the global expansion container ------------------------------------

test("T7 the global block container renders nothing while no block is registered", () => {
  assert.strictEqual(
    arch.GlobalDetailRegion({ blocks: [] }),
    null,
    "an empty registry must leave no container in the tree (no empty box under the map)",
  );
  // 원소가 아니라 길이/문자열로 잼 — 반환 배열은 vm 렐름 소속이라 구조 비교가 프로토타입에서 걸림.
  assert.strictEqual(
    arch.getGlobalDetailBlocks().map((b) => b.id).join(","),
    "",
    "T7 registers no block itself — T11 and T12c fill it",
  );
});

test("T7 the global block container renders a registered block", () => {
  const rendered = arch.GlobalDetailRegion({
    blocks: [{ id: "probe", render: () => ({}) }],
  });
  assert.notStrictEqual(
    rendered,
    null,
    "a registered block must reach the tree — an always-null container would silently swallow T11/T12c",
  );
});
