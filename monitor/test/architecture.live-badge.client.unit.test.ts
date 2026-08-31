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
// 확장 영역 한 줄 — 실행 하나의 날짜와 그 실행이 낸 사유들.
interface DaemonRunRow {
  runDate: string;
  verdict: string;
  reasons: { message: string; count: number }[];
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
  // 접힌 상태의 유일한 표시 문자열 — 펼침 컨트롤의 이름이 여기서 나옴 (T11).
  title?: string;
  render: (states: unknown) => unknown;
}
// T11: 훅 구성 한 줄 — 이벤트 하나와 그 이벤트에 걸린 matcher 들.
interface HookChainRow {
  event: string;
  hookCount: number;
  groups: { matcher: string; hooks: { command: string; type: string | null; timeout: number | null }[] }[];
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
  // T11: 전역 블록 펼침 영역의 DOM id — 블록 컨트롤의 aria-controls 가 이 값을 가리킴.
  getGlobalBlockDetailId: (blockId: string) => string;
  // T11: hook-chain 응답을 이벤트 → matcher → 훅 줄로 접는 순수 fold.
  getHookChainRows: (state: FetchState | null | undefined) => HookChainRow[] | null;
  buildLiveDaemonsByNodeId: (
    daemons: DaemonLiveStatus[] | null | undefined,
  ) => Map<string, DaemonLiveStatus[]>;
  getLiveDaemonRows: (daemons: DaemonLiveStatus[] | null | undefined) => DaemonRow[];
  // T8: 확장 영역의 DOM id — 행 컨트롤의 aria-controls 가 이 값을 가리킴.
  getRowDetailId: (rowKey: string) => string;
  // T9c: 선택 데몬의 payload 응답을 날짜 + 사유 줄로 접는 순수 fold.
  getDaemonRunRows: (
    payloadState: FetchState | null | undefined,
    daemonName: string,
  ) => DaemonRunRow[] | null;
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
  assert.strictEqual(
    typeof h.getRowDetailId,
    "function",
    "getRowDetailId must be reachable (T8 aria-controls instrument)",
  );
  assert.strictEqual(
    typeof h.getDaemonRunRows,
    "function",
    "getDaemonRunRows must be reachable (T9c date+reason fold instrument)",
  );
  assert.strictEqual(
    typeof h.getGlobalBlockDetailId,
    "function",
    "getGlobalBlockDetailId must be reachable (T11 aria-controls instrument)",
  );
  assert.strictEqual(
    typeof h.getHookChainRows,
    "function",
    "getHookChainRows must be reachable (T11 hook-configuration fold instrument)",
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

// 화면은 이 표를 두 몫으로 갈라 요청함 — 드릴다운을 따라 다시 나가는 것은 페이로드 하나뿐이고,
// 나머지 넷은 머리글(스트립·KPI)이 서 있는 값이라 행을 펼칠 때 다시 나가면 안 됨.
// 그 가름이 성립하려면 데몬 이름을 싣는 URL 이 정확히 하나여야 함 — 그 전제를 여기서 못 박음.
test("T7 exactly one endpoint follows the daemon, which is what lets the other four stay put", () => {
  const urls = arch.getMapHealthEndpoints("wiki");
  // 파일 관례대로 이어붙여 비교함 — 화면 소스는 별도 realm 에서 평가되므로 그쪽 Array 는
  // 내용이 같아도 prototype 이 달라 deepEqual 이 붙지 않음.
  assert.strictEqual(
    urls.filter((u) => u.includes("wiki")).join("\n"),
    "/api/health/daemon-payload?daemon=wiki&limit=10",
    "a second daemon-bearing URL would silently rejoin the strip's responses to the drilldown",
  );
});

// 이름 안의 `&` 는 인코딩하지 않으면 질의를 한 칸 더 만듦 — 서버가 허용목록으로 거르지만
// 그건 서버의 방어이고, 이 자리는 URL 을 조립하는 쪽이 제 값을 감쌌는지를 잼.
// 조립된 원문 그대로 냄: `new URL` 은 파싱하면서 공백 같은 문자를 스스로 인코딩하므로,
// 파싱한 값만 보면 감싸지 않은 구현도 초록이 됨(감싸는 쪽과 구별되지 않음).
function getPayloadUrl(daemon: string): string {
  const raw = arch
    .getMapHealthEndpoints(daemon)
    .find((u) => u.startsWith("/api/health/daemon-payload"));
  assert.ok(raw, "the fetch table must carry a daemon-payload URL");
  return raw;
}

test("T7 a daemon name that would otherwise change the query is encoded into it", () => {
  const hostile = "auto&limit=1";
  const url = new URL(getPayloadUrl(hostile), "http://monitor.invalid");

  assert.strictEqual(
    url.searchParams.get("daemon"),
    hostile,
    "the daemon parameter must round-trip to the selected name, not to a truncated prefix",
  );
  assert.deepStrictEqual(
    [...url.searchParams.keys()].sort(),
    ["daemon", "limit"],
    "an unencoded name splits its own `&` into an extra parameter — the query must keep exactly two",
  );
  assert.strictEqual(
    url.searchParams.get("limit"),
    "10",
    "the row limit must survive a name carrying its own limit= text",
  );
});

test("T7 a daemon name carrying a space is encoded before the URL leaves the screen", () => {
  // 원문을 잼 — fetch 에 넘기는 문자열이 이것이고, 파싱을 거치면 두 구현이 같아 보임.
  const raw = getPayloadUrl("daily restart");
  assert.ok(
    !raw.includes(" "),
    `a raw space must never reach the request URL, but it read: ${raw}`,
  );
  assert.strictEqual(
    new URL(raw, "http://monitor.invalid").searchParams.get("daemon"),
    "daily restart",
    "encoding must be reversible — the server still receives the name that was selected",
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
});

// T7 이 세운 통과 규칙 — render 를 갖춘 항목만 컨테이너에 닿음. 명부의 내용은 T11·T12c 가
// 채우므로 여기서는 '무엇이 등록됐는가' 가 아니라 '반쯤 등록된 항목이 통과하지 못함' 을 잼.
// 원소가 아니라 길이/문자열로 잼 — 반환 배열은 vm 렐름 소속이라 구조 비교가 프로토타입에서 걸림.
test("T7 only blocks carrying a render function reach the container", () => {
  const blocks = arch.getGlobalDetailBlocks();
  assert.strictEqual(
    blocks.filter((b) => typeof b.render !== "function").length,
    0,
    "a half-registered block would open the container onto an empty box",
  );
  // 정렬해 비교함 — 명부의 차례는 화면에 그려지는 차례이고 그 순서는 merged-surface e2e 의
  // deepEqual 이 소유함. 여기서 순서를 한 번 더 못 박으면 명부를 재배열하는 변경이 두 곳에서
  // 붉어지면서 어느 쪽이 진짜 계약인지 흐려짐 — 이 자리는 '무엇이 등록됐는가'만 잼.
  // 블록을 더하는 작업은 제 id 를 아래 목록에 더함 (T11 → hook-chain · T12c → hook-failures).
  assert.strictEqual(
    blocks
      .map((b) => b.id)
      .sort()
      .join(","),
    "hook-chain,hook-failures",
    "the registry holds exactly the blocks registered so far — an appending task adds its id here",
  );
});

test("T7 the global block container renders a registered block", () => {
  const rendered = arch.GlobalDetailRegion({
    blocks: [{ id: "probe", title: "Probe", render: () => ({}) }],
  });
  assert.notStrictEqual(
    rendered,
    null,
    "a registered block must reach the tree — an always-null container would silently swallow T11/T12c",
  );
});

// --- T11: the hook chain block ---------------------------------------------

test("T11 the hook chain block is registered with a title and a renderer", () => {
  const block = arch.getGlobalDetailBlocks().find((b) => b.id === "hook-chain");
  assert.ok(block, "the hook chain block must be registered — the map consumed /api/health/hook-chain for nothing otherwise");
  assert.strictEqual(typeof block.render, "function");
  // 제목은 접힌 상태에서 유일하게 보이는 문자열 — 없으면 펼침 컨트롤에 이름이 안 남음.
  assert.ok(block.title && block.title.length > 0, "a collapsed block shows only its title");
});

test("T11 the block's expansion region id is stable, per-block, and a legal DOM id", () => {
  const id = arch.getGlobalBlockDetailId("hook-chain");
  assert.strictEqual(id, arch.getGlobalBlockDetailId("hook-chain"), "aria-controls and the region are wired by the same call");
  assert.notStrictEqual(id, arch.getGlobalBlockDetailId("hook-failures"), "two blocks must not share one region id");
  assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/, "the id must remain a legal getElementById target");
});

test("T11 the hook chain fold names every hook under the matcher it fires on", () => {
  const rows = arch.getHookChainRows({
    status: "ready",
    error: null,
    data: {
      events: [
        {
          event: "PreToolUse",
          groups: [
            { matcher: "Write|Edit", hooks: [{ command: "a.sh", type: "command", timeout: 5 }] },
            { matcher: "Bash", hooks: [{ command: "b.sh", type: "command", timeout: null }] },
          ],
        },
        { event: "SubagentStop", groups: [] },
      ],
    },
  });
  assert.ok(rows, "a ready response must fold into rows");
  assert.strictEqual(rows.length, 2, "one row per event, empty events included — a missing event is a fact");
  assert.strictEqual(rows[0].event, "PreToolUse");
  assert.strictEqual(rows[0].hookCount, 2, "the count must span every matcher of the event");
  assert.strictEqual(rows[0].groups.map((g) => g.matcher).join(","), "Write|Edit,Bash");
  assert.strictEqual(rows[1].hookCount, 0, "an event with no hooks reads zero, not absent");
});

test("T11 a response that has not arrived folds to null, never to an empty configuration", () => {
  assert.strictEqual(arch.getHookChainRows({ status: "loading", data: null, error: null }), null);
  assert.strictEqual(arch.getHookChainRows({ status: "error", data: null, error: "boom" }), null);
  assert.strictEqual(arch.getHookChainRows(null), null);
  // 응답은 왔고 이벤트가 0개인 경우는 [] — '못 읽음' 과 '설정이 비었음' 은 다른 문장임.
  assert.deepStrictEqual(
    [...(arch.getHookChainRows({ status: "ready", data: { events: [] }, error: null }) || [])],
    [],
  );
});

// --- T8: the expansion region's DOM id --------------------------------------

test("T8 the detail id is derived from the row key it is handed and stays a legal DOM id", () => {
  const id = arch.getRowDetailId("autoagent");
  assert.match(id, /autoagent$/, "the id must name the row it belongs to");
  assert.strictEqual(
    id,
    arch.getRowDetailId("autoagent"),
    "the id must be stable — aria-controls and the region are wired by the same call",
  );
  assert.notStrictEqual(
    id,
    arch.getRowDetailId("wiki"),
    "two rows must not share one region id",
  );
  // 행 키(데몬 이름 · 부품 id)는 하이픈을 포함함 — id 문법을 벗어나는 문자만 접히고 나머지는 남아야 함.
  assert.match(
    arch.getRowDetailId("daily-restart-autoagent"),
    /^[A-Za-z][A-Za-z0-9_-]*$/,
    "the id must remain a legal getElementById target for every roster name",
  );
});

// --- T9c: the date + reason fold -------------------------------------------

const RUN_FAIL_DATE = "2026-08-22";
const RUN_OK_DATE = "2026-08-19";
const RUN_QUOTA_MESSAGE = "haiku classify failed: quota exceeded";
const RUN_DOCTOR_MESSAGE = "doctor verdict: fail (rc=1)";

function getPayloadState(daemon: string): FetchState {
  return {
    status: "ready",
    data: {
      daemon,
      entries: [
        {
          run_date: RUN_FAIL_DATE,
          daemon_name: daemon,
          payload: {},
          payload_size_bytes: 512,
          summary: {
            verdict: "fail",
            error_signatures: [
              { message: RUN_QUOTA_MESSAGE, count: 4 },
              { message: RUN_DOCTOR_MESSAGE, count: 1 },
            ],
          },
        },
        {
          run_date: RUN_OK_DATE,
          daemon_name: daemon,
          payload: {},
          payload_size_bytes: 256,
          summary: { verdict: "ok", error_signatures: [] },
        },
      ],
    },
    error: null,
  };
}

test("T9c the fold carries each run's date and every signature behind it", () => {
  const rows = arch.getDaemonRunRows(getPayloadState("autoagent"), "autoagent");
  assert.ok(rows, "a ready response for the named daemon must fold into rows");
  assert.deepStrictEqual(
    rows.map((r) => r.runDate),
    [RUN_FAIL_DATE, RUN_OK_DATE],
    "run dates must come through in response order",
  );
  assert.deepStrictEqual(
    rows[0].reasons.map((r) => `${r.message}#${r.count}`),
    [`${RUN_QUOTA_MESSAGE}#4`, `${RUN_DOCTOR_MESSAGE}#1`],
    "both signatures must survive with their counts — a first-only fold hides the doctor verdict",
  );
  assert.strictEqual(rows[0].verdict, "fail");
  assert.deepStrictEqual(rows[1].reasons, [], "a clean run must fold to zero reasons, not to null");
});

// 드릴다운 재요청이 도는 동안의 반증 케이스 — 응답의 daemon 을 대조하지 않는 fold 는 여기서
// 다른 작업의 실패를 이 행 아래 그리게 되므로 붉어짐.
test("T9c a response that names a different daemon folds to null, not to that daemon's failures", () => {
  assert.strictEqual(
    arch.getDaemonRunRows(getPayloadState("autoagent"), "wiki"),
    null,
    "the fold must refuse a response belonging to another daemon",
  );
});

test("T9c a response still in flight folds to null and an empty roster folds to an empty list", () => {
  assert.strictEqual(
    arch.getDaemonRunRows({ status: "loading", data: null, error: null }, "autoagent"),
    null,
    "loading is not 'no runs' — the two must stay distinguishable in the region",
  );
  assert.strictEqual(
    arch.getDaemonRunRows({ status: "error", data: null, error: "boom" }, "autoagent"),
    null,
  );
  const empty = arch.getDaemonRunRows(
    { status: "ready", data: { daemon: "autoagent", entries: [] }, error: null },
    "autoagent",
  );
  assert.deepStrictEqual(empty, [], "a ready response with no entries must fold to an empty list");
});
