// Unit tests for the client-side cron-node live-badge fold in
// public/src/screens/architecture.jsx (F39): two daemons can bind ONE node id
// (cron: daily-restart-autoagent + daily-restart-wiki, per DAEMON_NODE_BINDINGS).
// buildLiveDaemonsByNodeId must keep a LIST per node id so no status is dropped,
// and worstDaemonTone must fold the bound daemons to their worst EFFECTIVE severity
// for the ring class. Pre-fix, the Map was `set(nid, d)` (last-writer-wins) — one
// daemon silently vanished and the drawer showed a single pill.
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
interface ArchHelpers {
  buildLiveDaemonsByNodeId: (
    daemons: DaemonLiveStatus[] | null | undefined,
  ) => Map<string, DaemonLiveStatus[]>;
  worstDaemonTone: (
    daemons: DaemonLiveStatus[] | null | undefined,
  ) => string | null;
  daemonEffectiveTone: (d: Partial<DaemonLiveStatus>) => string;
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
    typeof h.worstDaemonTone,
    "function",
    "worstDaemonTone must be reachable",
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

// --- worstDaemonTone: the ring shows the worst bound severity ---

test("ok + crit folds to crit (worst severity drives the ring)", () => {
  const daemons = [daemon("a", "ok"), daemon("b", "error")];
  assert.strictEqual(arch.worstDaemonTone(daemons), "crit");
  // order-independent
  assert.strictEqual(arch.worstDaemonTone([...daemons].reverse()), "crit");
});

test("ok + warn folds to warn", () => {
  assert.strictEqual(
    arch.worstDaemonTone([daemon("a", "ok"), daemon("b", "partial")]),
    "warn",
  );
});

test("fold uses EFFECTIVE tone — an ok-but-overdue daemon escalates the ring to warn", () => {
  // status 'ok' but staleness (120) > cadence (60) → daemonEffectiveTone → 'warn'.
  const overdue = daemon("b", "ok", {
    expected_cadence_minutes: 60,
    staleness_minutes: 120,
  });
  assert.strictEqual(arch.daemonEffectiveTone(overdue), "warn");
  assert.strictEqual(
    arch.worstDaemonTone([daemon("a", "ok"), overdue]),
    "warn",
  );
});

test("all-healthy fold stays ok", () => {
  assert.strictEqual(
    arch.worstDaemonTone([daemon("a", "ok"), daemon("b", "ok")]),
    "ok",
  );
});

test("quota_exceeded folds to warn ring (T3 re-tone)", () => {
  // quota_exceeded → warn → map ring tone (이전 neutral/no-ring 대체).
  assert.strictEqual(
    arch.worstDaemonTone([daemon("a", "quota_exceeded")]),
    "warn",
  );
});

test("info-only / empty bindings produce no ring (null)", () => {
  assert.strictEqual(arch.worstDaemonTone([daemon("a", "missing")]), null);
  assert.strictEqual(arch.worstDaemonTone([]), null);
  assert.strictEqual(arch.worstDaemonTone(undefined), null);
});
