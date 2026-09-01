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
interface HealthCardDef {
  id: string;
  kind: string;
}
// T11: 훅 구성 한 줄 — 이벤트 하나와 그 이벤트에 걸린 matcher 들.
interface HookChainRow {
  event: string;
  hookCount: number;
  groups: { matcher: string; hooks: { command: string; type: string | null; timeout: number | null }[] }[];
}
// 표 행 확장의 본문 렌더러 — kind 별로 하나씩. hook 행은 구성과 실패 이력을 함께 냄 (AC-B2-5a).
interface RowDetailRenderers {
  hook: (row: unknown, states: MapHealthStates) => unknown;
}
interface HealthModelGlobal {
  HEALTH_CARD_DEFS: HealthCardDef[];
}

interface ArchHelpers {
  // 맵이 흡수한 health 엔드포인트 표(ADR-B1 R2) — health.jsx:42-47 의 5종.
  getMapHealthEndpoints: (payloadDaemon: string) => string[];
  // T11: hook-chain 응답을 이벤트 → matcher → 훅 줄로 접는 순수 fold.
  getHookChainRows: (state: FetchState | null | undefined) => HookChainRow[] | null;
  buildLiveDaemonsByNodeId: (
    daemons: DaemonLiveStatus[] | null | undefined,
  ) => Map<string, DaemonLiveStatus[]>;
  // 링 tone 표 — /live 의 데몬 판정과 health 카드 판정을 한 node id 표로 접는 순수 fold.
  buildRingToneByNodeId: (
    daemonsByNodeId: Map<string, DaemonLiveStatus[]>,
    partBindings: Record<string, string[]> | null | undefined,
    cardStates: unknown,
  ) => Map<string, string>;
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

// 샌드박스 전역 — React/window.UI 스텁만 둔 빈 문맥. 무엇을 실을지는 부르는 쪽이 정함:
// health-model.js 의 부재가 이 파일이 재는 사실 중 하나라 적재 순서를 고정하면 안 됨.
function createArchContext(): Record<string, unknown> {
  // React stub — every hook returns a benign default; the (uninvoked) component
  // bodies touch React, so the stubs never actually drive a render.
  const reactStub = new Proxy(
    {
      // 요소를 실제로 지음 — 렌더러가 낸 트리를 읽어야 '무엇이 그려졌는가' 를 잴 수 있음.
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
        type,
        props: { ...(props || {}), children },
        children,
      }),
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
    // 표시 문장은 이 테스트의 대상이 아님 — 값이 렌더러를 통과했는지만 보이면 됨.
    formatRelativeTime: (v: string) => `rel:${v}`,
    formatKstFull: (v: string) => `kst:${v}`,
    resolveBadge: (tone: string) => ({ label: tone }),
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
  return ctx;
}

// health-model.js 를 싣지 않은 문맥 — index.html:103 의 <script> 하나가 빠진 상태.
// 화면 스크립트는 이미 빌드된 같은 원문을 씀: 두 문맥의 유일한 차이가 그 부재여야 함.
function loadArchWithoutHealthModel(code: string): Record<string, unknown> {
  const ctx = createArchContext();
  vm.runInContext(code, ctx);
  assert.strictEqual(
    (ctx.window as { HealthModel?: unknown }).HealthModel,
    undefined,
    "fixture precondition: the health model must be absent from this context",
  );
  return ctx;
}

// Build once, evaluate in a sandbox — the real top-level helper declarations.
// 반환하는 code 가 AC-12 단언 대상(컴파일 산출물 원문) — 부재 단언은 sandbox 전역이 아니라
// 이 텍스트를 봄(제거된 축약기/목적 맵은 호출되지 않아도 선언만으로 되살아날 수 있음).
async function loadArch(): Promise<{
  helpers: ArchHelpers;
  code: string;
  rowDetails: RowDetailRenderers;
}> {
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

  const ctx = createArchContext();
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
    typeof h.buildRingToneByNodeId,
    "function",
    "buildRingToneByNodeId must be reachable (AC-T2 live-verdict instrument)",
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
    typeof h.getDaemonRunRows,
    "function",
    "getDaemonRunRows must be reachable (T9c date+reason fold instrument)",
  );
  assert.strictEqual(
    typeof h.getHookChainRows,
    "function",
    "getHookChainRows must be reachable (T11 hook-configuration fold instrument)",
  );

  const rowDetails = vm.runInContext("HEALTH_ROW_DETAILS", ctx) as RowDetailRenderers;
  assert.strictEqual(
    typeof rowDetails.hook,
    "function",
    "HEALTH_ROW_DETAILS.hook must be reachable (AC-B2-5e hook row renderer instrument)",
  );

  const healthModel = (ctx.window as { HealthModel?: HealthModelGlobal }).HealthModel;
  assert.ok(
    healthModel && Array.isArray(healthModel.HEALTH_CARD_DEFS),
    "window.HealthModel must carry the card definitions the map's KPI denominator reads",
  );
  return { helpers: h, code, rowDetails };
}

const { helpers: arch, code: archCode, rowDetails } = await loadArch();

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

// --- AC-T2: 판정은 서버 필드에서만 옴 (화면 재계산 삭제) ---
//
// 계기가 바뀌었음(ADR-20): 라이브 상태 표가 걷히며 그 표의 행 빌더도 함께 죽었으므로,
// 같은 사실을 표가 아니라 링 tone 표에서 잼 — /live 의 데몬 판정을 읽는 화면 경로가 이제
// 그것임. 축소된 범위를 밝혀 둠: 표가 재던 사실 중 tone 만 여기 남고, 상태 문장(라벨)은
// 노드 상세 패널의 pill 이 JSX 안에서 직접 그리므로 이 파일에 잴 자리가 없음.

// 아직 도착하지 않은 health 카드 응답 넷 — 어느 카드도 ready 가 아니므로 부품 tone 이 하나도 서지
// 않음. 데몬 판정만 남은 표를 얻는 자리임(카드가 서면 rank-max 가 두 판정을 하나로 접어 버림).
const NO_CARD_STATES = {
  pgState: { status: "loading", data: null, error: null },
  daemonState: { status: "loading", data: null, error: null },
  hookState: { status: "loading", data: null, error: null },
  hookFailState: { status: "loading", data: null, error: null },
};

// 한 데몬을 제 node id 표로 접어 링 tone 하나를 냄.
function ringToneOf(daemon: DaemonLiveStatus): string | undefined {
  return arch
    .buildRingToneByNodeId(arch.buildLiveDaemonsByNodeId([daemon]), null, NO_CARD_STATES)
    .get("cron");
}

test("AC-T2 초과 판정은 서버 필드에서 tone 으로 그대로 나옴", () => {
  assert.strictEqual(ringToneOf(daemon("autoagent", "ok", { effective_status: "stale" })), "crit");
});

test("AC-T2 cadence 를 넘긴 staleness 가 있어도 화면은 판정을 올리지 않음", () => {
  // 삭제된 재계산이 되살아나면 tone 이 warn 으로 밀리고 이 단언이 붉어짐.
  assert.strictEqual(
    ringToneOf(
      daemon("autoagent", "ok", {
        expected_cadence_minutes: 1440,
        staleness_minutes: 2160,
      }),
    ),
    "ok",
  );
});

test("AC-T2 판정 필드가 없으면 상태를 지어내지 않고 미상으로 남김", () => {
  // `info` 는 링 등급표에 없는 tone 임 — 미수신은 링을 칠하지 않음이 정답임.
  assert.strictEqual(
    ringToneOf({ daemon_name: "autoagent", status: "ok", node_ids: ["cron"] }),
    undefined,
  );
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

// T7 의 KPI 세 절은 맵이 분모를 HEALTH_CARD_DEFS 에 위임하는지를 쟀음. 그 위임층(맵의
// KPI 대리 함수와 모델의 집계 fold)이 함께 접히면서 분모는 표의 행 수가 됐고, 그 사실은
// AC-B2-4b(merged-surface e2e)가 화면에서 직접 잼. 죽은 이름은 제거 원장이 따로 지킴.
// 픽스처도 그 셋만 쓰던 것이라 함께 걷음.

// --- T11: the hook chain fold and the row renderer that consumes it -------

// 함수 컴포넌트를 실제로 불러 그 결과까지 펼침 — 렌더러가 낸 글을 재려면 트리를 끝까지 풀어야 함.
function renderToText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderToText).join(" ");

  const el = node as { type?: unknown; props?: { children?: unknown }; children?: unknown };
  if (typeof el.type === "function")
    return renderToText((el.type as (props: unknown) => unknown)(el.props));

  return renderToText(el.children ?? null);
}

// 렌더된 트리의 모든 요소 부분트리 글 — 함수 컴포넌트는 불러서 그 결과까지 폄.
// 포함 여부만 보는 단언은 matcher 를 한 목록에, 명령을 다른 목록에 평평히 늘어놓은 렌더러도
// 통과함(둘 다 어딘가에는 있음). '어느 자리 안에서' 를 재려면 자리마다의 글이 필요함.
function collectSubtreeTexts(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectSubtreeTexts(child, out);
    return out;
  }

  const el = node as { type?: unknown; props?: { children?: unknown }; children?: unknown };
  if (typeof el.type === "function")
    return collectSubtreeTexts((el.type as (props: unknown) => unknown)(el.props), out);

  out.push(renderToText(el));
  return collectSubtreeTexts(el.children ?? null, out);
}

// 렌더러에 먹일 훅 구성 — matcher 둘 · 훅 둘. 폴드 케이스와 같은 모양을 쓰되 값은 따로 둠:
// 한 픽스처를 둘이 나눠 쓰면 어느 쪽이 그 값을 통과시킨 것인지 메시지에서 갈리지 않음.
const HOOK_RENDER_EVENTS = [
  {
    event: "PreToolUse",
    groups: [
      { matcher: "Write|Edit", hooks: [{ command: "render-a.sh", type: "command", timeout: 5 }] },
      { matcher: "Bash", hooks: [{ command: "render-b.sh", type: "command", timeout: null }] },
    ],
  },
];

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

  // AC-B2-5e — 같은 사실을 렌더러가 이사한 자리에서 다시 잼. 접기 명부를 거치지 않고 hook 행의
  // 본문 렌더러를 직접 부름: 폴드가 옳아도 렌더러가 matcher 를 안 부르면 화면에는 관계가 없음.
  const rendered = rowDetails.hook(null, {
    hookState: { status: "ready", error: null, data: { events: HOOK_RENDER_EVENTS, source_path: "/fixture/settings.json" } },
    hookFailState: { status: "ready", error: null, data: { days: 30, failures: [], last_failure_ts: null } },
  } as unknown as MapHealthStates);
  const text = renderToText(rendered);
  for (const group of HOOK_RENDER_EVENTS[0].groups) {
    assert.ok(text.includes(group.matcher), `the row renderer must name the ${group.matcher} matcher, but it read: ${text}`);
    for (const hook of group.hooks) {
      assert.ok(
        text.includes(hook.command),
        `the row renderer must name ${hook.command}, but it read: ${text}`,
      );
    }
  }

  // 여기까지는 '둘 다 어딘가에 있음' 뿐임 — 이 테스트의 이름이 부르는 사실은 관계임.
  // 그래서 자리로 잼: 제 matcher 와 제 훅을 함께 담고 남의 matcher·훅은 담지 않는 부분트리가
  // 하나는 있어야 함. matcher 를 한 목록에, 명령을 다른 목록에 늘어놓은 렌더러에서는 둘을
  // 함께 담는 자리가 트리 전체뿐이고 그 자리는 남의 것도 담으므로 여기서 붉어짐.
  const subtrees = collectSubtreeTexts(rendered);
  for (const group of HOOK_RENDER_EVENTS[0].groups) {
    const own = [group.matcher, ...group.hooks.map((h) => h.command)];
    const foreign = HOOK_RENDER_EVENTS[0].groups
      .filter((other) => other.matcher !== group.matcher)
      .flatMap((other) => [other.matcher, ...other.hooks.map((h) => h.command)]);

    assert.ok(
      subtrees.some(
        (subtree) => own.every((s) => subtree.includes(s)) && foreign.every((s) => !subtree.includes(s)),
      ),
      `no place in the tree holds ${group.matcher} together with its own hooks and nothing of the other matcher — the renderer lists them flat, so the fold's grouping does not survive to the screen. It read: ${text}`,
    );
  }
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

// T8 의 DOM-id 절은 그 id 와 함께 사라졌음 — 패널에는 접을 것이 없어 aria-controls 로 영역을
// 가리킬 일이 없고, 상세는 제 부품 항목 '안에' 서므로 자리로 이미 결정됨. 그 포함 관계는
// merged-surface e2e 의 AC-T8 상세 절이 잼(영역이 제 부품 안에 있고 제 데몬을 이름으로 실음).

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

// --- AC-B2-6a: '못 읽음' 을 부르는 표면은 부품 명부 가드 아래 있으면 안 됨 -----------
// 부품 명부는 window.HealthModel 에서 옴 — index.html:103 이 architecture.js 와 따로 싣는
// <script> 라 그 태그 하나만 빠져도 부품 목록이 통째로 빔. 경보가 그 가드 아래 있으면
// 다섯 저장소가 전부 안 읽히는 화면이 '아무 일 없음' 과 같은 그림이 됨.
//
// 표가 사라지며 경보는 화면(ScreenArchitecture)으로 올라갔으므로 컴포넌트를 불러 그릴 자리가
// 없어졌음 — 대신 그 경보를 세우는 두 순수 함수를 같은 문맥에서 직접 잼: 명부가 없을 때
// 부품 목록은 비지만 저장소 사유는 여전히 이름을 부름. 그려진 경보의 자리(패널이 아니라
// 페이지)는 merged-surface e2e 의 AC-B2-6b 가 잼.

// 화면이 흡수한 health 응답 5종 — PG 만 끊고 나머지는 답하게 둠.
// 넷을 함께 끊으면 경보가 떴다는 사실만 보이고 '누가 끊겼는지' 를 못 가림.
function healthStoreStates(overrides: Record<string, unknown> = {}) {
  return {
    daemonState: { status: "ready", data: { daemons: [] }, error: null },
    pgState: { status: "error", data: null, error: "ECONNREFUSED" },
    hookState: { status: "ready", data: { events: [] }, error: null },
    hookFailState: {
      status: "ready",
      data: { count_24h: 0, unretried_count_24h: 0 },
      error: null,
    },
    payloadState: { status: "ready", data: null, error: null },
    ...overrides,
  };
}

function callInCtx<T>(ctx: Record<string, unknown>, name: string, ...args: unknown[]): T {
  const fn = vm.runInContext(name, ctx) as (...a: unknown[]) => T;
  return fn(...args);
}

test("AC-B2-6a a store that failed is still named when the health model never loaded", () => {
  const ctx = loadArchWithoutHealthModel(archCode);
  const states = healthStoreStates();

  // 명부가 없으므로 부품 목록은 비어야 함 — 이 절이 없으면 아래 사유 목록이 '명부가 살아 있어서'
  // 나온 것인지 갈리지 않음.
  // vm 문맥이 낸 배열은 프로토타입이 이 realm 의 것이 아님 — 파일의 다른 절들과 같이 펴서 비교함
  // (펴지 않으면 값이 맞아도 deepStrictEqual 이 프로토타입에서 갈라짐).
  assert.deepStrictEqual(
    [...callInCtx<unknown[]>(ctx, "getHealthPartRows", states, undefined)],
    [],
    "without the model no part can stand — the store reasons are then the only thing that can speak",
  );

  const reasons = callInCtx<string[]>(ctx, "getHealthStoreErrorsAR", states);
  assert.strictEqual(
    reasons.length,
    1,
    `exactly the cut store must be named — read: ${JSON.stringify(reasons)}`,
  );
  assert.ok(
    reasons[0].includes("PostgreSQL"),
    `the reason must still name the store that failed — read: "${reasons[0]}"`,
  );
});

test("AC-B2-6a no model and no failure names nothing — the alert is not a permanent fixture", () => {
  const ctx = loadArchWithoutHealthModel(archCode);
  const quiet = callInCtx<string[]>(
    ctx,
    "getHealthStoreErrorsAR",
    healthStoreStates({ pgState: { status: "ready", data: { status: "ok" }, error: null } }),
  );

  assert.deepStrictEqual(
    [...quiet],
    [],
    "every store answered, so a reason here would call five live stores dead",
  );
});
