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
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH_SRC = resolve(__dirname, "../public/src/screens/architecture.jsx");

interface DaemonLiveStatus {
  daemon_name: string;
  status: string;
  node_ids: string[];
  last_run_at?: string | null;
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
interface ArchHelpers {
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

// AC-12 단언 대상 — 컴파일 산출물 원문. 부재 단언은 sandbox 전역이 아니라 이 텍스트를 봄
// (제거된 축약기/목적 맵은 호출되지 않아도 선언만으로 되살아날 수 있음).
let ARCH_CODE = "";

// Build once, evaluate in a sandbox — the real top-level helper declarations.
async function loadArch(): Promise<ArchHelpers> {
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
  ARCH_CODE = code;

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
  return h;
}

const arch = await loadArch();

const daemon = (
  name: string,
  status: string,
  extra: Partial<DaemonLiveStatus> = {},
): DaemonLiveStatus => ({
  daemon_name: name,
  status,
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
  assert.match(ARCH_CODE, /LEGIBLE_FIT_FLOOR\s*=\s*0\.6\b/);
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
  assert.doesNotMatch(ARCH_CODE, /\btruncateText\b/);
  assert.doesNotMatch(ARCH_CODE, /\bdiagramPurposeAR\b/);
});

test("AC-12(b) 하드코드 목적 문자열 맵이 컴파일 산출물에 없음", () => {
  assert.doesNotMatch(ARCH_CODE, /\bTAB_PURPOSE\b/);
});
