// Unit tests for public/src/app.jsx nav-badge routing (T2 · T13a): the sidebar footer, the
// architecture (System map) nav numeral and the Dashboard lane all read ONE harness fold, so
// no two of those surfaces can disagree about a harness fact — including on the path where a
// store fails to answer, which is where a per-surface cache used to keep a stale ALL SYSTEMS.
// The map owns the health readings now, so the Health entry point is gone (T13a).
//
// Runner: npx tsx --test test/app.nav-badge.client.unit.test.ts
//
// app.jsx is a browser global module (top-level `const { useState } = React`, JSX, no
// import/export) — esbuild emits a plain script whose top-level fn decls land on the vm
// context global. The test evaluates the ACTUAL shipped source in a node:vm sandbox with
// minimal React/window/fetch stubs (the trailing bootstrap fetch is left pending so the
// synchronous eval completes and never mounts). No DB / no network is touched.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";
import { readFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_SRC = resolve(__dirname, "../public/src/app.jsx");
// The REAL health model and the REAL ui.jsx are evaluated into the same context: the fold
// derives every part verdict from the map's own tone table (window.UI.daemonStatusTone), so a
// stub here would assert an echo of itself instead of the shipped classification.
const HEALTH_MODEL_SRC = resolve(__dirname, "../public/src/data/health-model.js");
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

interface Badge {
  badge: string;
  badgeTone: string;
  source?: string;
}
interface Rollup {
  tone: string;
  dotClass: string;
  label: string;
}
interface HarnessFold {
  status: string;
  partsOk: number;
  partsChecked: number;
  partsTotal: number;
  downNames: string[];
  uncheckedNames: string[];
  daemonsDown: number | null;
  failCount1h: number | null;
  version: string | null;
}
interface AppHelpers {
  harnessToNavBadges: (harness: HarnessFold | null) => { architecture?: { badges: Badge[] } | null };
  systemsRollup: (harness: HarnessFold | null) => Rollup;
  parseHashScreen: () => string;
}
interface AppSurface extends AppHelpers {
  setHash: (hash: string) => void;
  foldHarness: (states: unknown) => HarnessFold;
}

async function transform(srcPath: string): Promise<string> {
  const built = await esbuild.build({
    entryPoints: [srcPath],
    bundle: false,
    write: false,
    loader: { ".jsx": "jsx" },
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    target: "es2022",
    format: "esm",
  });
  return built.outputFiles[0].text;
}

async function loadApp(): Promise<AppSurface> {
  const code = await transform(APP_SRC);
  // ui.jsx is wrapped in an IIFE — it exports only window.UI, and its top-level consts must
  // stay out of the shared vm global (client-sandbox.ts uses the same shape).
  const uiCode = `(function(){\n${await transform(UI_SRC)}\n})();`;

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
  const location = { hash: "" };
  const ctx: Record<string, unknown> = {
    window: { location, useTweaks: () => [{}, () => {}] },
    React: reactStub,
    ReactDOM: { createRoot: () => ({ render: () => {} }) },
    document: { getElementById: () => ({}), documentElement: { style: {} } },
    // Bootstrap fetch at module tail — leave pending so sync eval finishes, no mount.
    fetch: () => new Promise(() => {}),
    Intl,
    console,
    setInterval: () => 0,
    clearInterval: () => {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Script order mirrors index.html: ui.js → health-model.js → app.js.
  vm.runInContext(uiCode, ctx);
  vm.runInContext(await readFile(HEALTH_MODEL_SRC, "utf8"), ctx);
  vm.runInContext(code, ctx);

  const h = ctx as unknown as AppHelpers;
  assert.strictEqual(
    typeof h.harnessToNavBadges,
    "function",
    "harnessToNavBadges must be reachable",
  );
  assert.strictEqual(
    typeof h.systemsRollup,
    "function",
    "systemsRollup must be reachable",
  );
  const healthModel = (
    ctx.window as {
      HealthModel: { foldHarness: AppSurface["foldHarness"] };
    }
  ).HealthModel;
  return Object.assign(h as AppSurface, {
    setHash: (hash: string) => {
      location.hash = hash;
    },
    foldHarness: healthModel.foldHarness,
  });
}

const app = await loadApp();

function ready(data: unknown): unknown {
  return { status: "ready", data };
}
function daemonPayload(down: number): { daemons: { daemon_name: string; effective_status: string }[] } {
  const names = ["autoagent", "wiki", "daily-restart-autoagent", "daily-restart-wiki"];
  return {
    daemons: names.map((daemon_name, i) => ({
      daemon_name,
      effective_status: i < down ? "error" : "ok",
    })),
  };
}
// Every shell-polled store answering healthy — the 7-part denominator the tile reads.
function allHealthy(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    liveState: ready(daemonPayload(0)),
    healthState: ready({ status: "ok", db: "open", browser: "ok", version: "1.0.0" }),
    hookState: ready({ events: [{ event: "PreToolUse", groups: [] }] }),
    hookFailState: ready({ count_24h: 0, unretried_count_24h: 0 }),
    ...over,
  };
}

// --- T13a · AC-T13(a): the Health entry point is gone; '#architecture' still resolves ---

test("routing: '#health' gets no alias — the unknown-hash fallback takes it to dashboard", () => {
  app.setHash("#health");
  assert.strictEqual(app.parseHashScreen(), "dashboard");
  app.setHash("#architecture");
  assert.strictEqual(app.parseHashScreen(), "architecture");
  app.setHash("");
});

// --- The fold: the ONE reading the nav numeral, the footer and the Dashboard lane share ---
// The relationship asserted is agreement across an input class, not one hand-picked payload.

test("fold daemonsDown equals the nav slot's daemon badge for every down count", () => {
  for (const down of [0, 1, 2, 3, 4]) {
    const fold = app.foldHarness(allHealthy({ liveState: ready(daemonPayload(down)) }));
    const badges = app.harnessToNavBadges(fold).architecture?.badges || [];
    const daemonBadge = badges.find((b) => b.source === "daemon");
    assert.equal(fold.daemonsDown, down, `fold must count ${down} down`);
    assert.equal(
      daemonBadge === undefined ? 0 : Number(daemonBadge.badge),
      fold.daemonsDown,
      "nav numeral and fold must report the same count",
    );
  }
});

test("an unpolled harness store leaves its parts unchecked rather than counted healthy", () => {
  const fold = app.foldHarness({});
  assert.equal(fold.status, "loading", "nothing answered yet = loading, never a healthy zero");
  assert.equal(fold.partsChecked, 0);
  assert.equal(fold.partsOk, 0);
  assert.equal(fold.uncheckedNames.length, fold.partsTotal);
  assert.equal(fold.daemonsDown, null, "an unpolled count is null, not 0");
  assert.equal(fold.failCount1h, null);
});

// First-poll wait and a lost harness are different facts — the tile skeleton and the footer's
// CHECKING… belong to the wait, 'unavailable' only once every part has answered without a reading.
test("a fold with nothing checked is loading while any part store is pending, unavailable once none is", () => {
  const rejected = { status: "error", data: null };
  const allRejected = { healthState: rejected, liveState: rejected, hookState: rejected, hookFailState: rejected };
  assert.equal(app.foldHarness(allRejected).status, "unavailable");
  for (const pending of ["healthState", "liveState", "hookState", "hookFailState"]) {
    const fold = app.foldHarness({ ...allRejected, [pending]: { status: "loading", data: null } });
    assert.equal(fold.status, "loading", `${pending} still pending`);
    assert.equal(fold.partsChecked, 0);
  }
  const partial = app.foldHarness(allHealthy({ hookState: { status: "loading", data: null } }));
  assert.equal(partial.status, "ready", "one answered part is a reading, whatever is still pending");
});

test("partsOk counts only observed-healthy parts and never exceeds partsChecked", () => {
  for (const down of [0, 2, 4]) {
    const fold = app.foldHarness(allHealthy({ liveState: ready(daemonPayload(down)) }));
    assert.equal(fold.partsChecked, 7, "4 daemons + pg + browser + hook chain are all shell-polled");
    assert.equal(fold.partsOk, 7 - down);
    assert.ok(fold.partsOk <= fold.partsChecked);
    assert.equal(fold.downNames.length, down);
    assert.equal(fold.version, "1.0.0");
    assert.equal(fold.uncheckedNames.length, 0, "every part in the set answered");
  }
});

// The lane exists for act-now facts, and a hook failure is one of them (plan §2 P1).
test("an unretried hook failure puts the hook chain in the lane's down set", () => {
  const fold = app.foldHarness(
    allHealthy({ hookFailState: ready({ count_24h: 3, unretried_count_24h: 2 }) }),
  );
  assert.deepEqual([...fold.downNames], ["Hook Chain"]);
  assert.equal(fold.partsOk, 6);
  assert.equal(fold.partsChecked, 7);
});

test("a hook store that has not answered leaves the part unchecked, not down", () => {
  const fold = app.foldHarness(allHealthy({ hookState: { status: "loading", data: null } }));
  assert.deepEqual([...fold.downNames], [], "silence is not a fault");
  assert.deepEqual([...fold.uncheckedNames], ["Hook Chain"]);
  assert.equal(fold.partsChecked, 6, "the denominator is what answered");
});

// The map is the owner of the part set — a part it reads as 'no data' must not read as down here.
test("a part the System map calls 'no data' is unchecked in the fold, never down", () => {
  const noRows = app.foldHarness(allHealthy({ liveState: ready({ daemons: [] }) }));
  assert.deepEqual([...noRows.downNames], [], "an absent daemon row is unknown, not down");
  assert.equal(noRows.uncheckedNames.length, 4);

  const unprobed = app.foldHarness(
    allHealthy({ healthState: ready({ status: "ok", db: "open", browser: "unprobed" }) }),
  );
  assert.deepEqual([...unprobed.uncheckedNames], ["Chromium Export"]);
  assert.deepEqual([...unprobed.downNames], []);
});

test("a rejected harness store is unavailable, not a zero reading", () => {
  const fold = app.foldHarness({
    liveState: { status: "error", data: null },
    healthState: ready({ status: "ok", db: "open", browser: "ok" }),
  });
  assert.equal(fold.daemonsDown, null, "a failed poll reports unknown, never 0 down");
  assert.equal(fold.partsChecked, 2, "only the parts that answered are in the denominator");
  assert.equal(fold.version, null);
});

// --- AC-T13(c): the footer and the nav numeral are consumers of that same fold ---

test("systemsRollup: an unavailable fold → CHECKING…, never a remembered verdict", () => {
  for (const fold of [null, app.foldHarness({})]) {
    const r = app.systemsRollup(fold);
    assert.strictEqual(r.tone, "neutral");
    assert.strictEqual(r.dotClass, "bg-faint");
    assert.strictEqual(r.label, "CHECKING…");
  }
});

test("systemsRollup: every part healthy and no failures → ALL SYSTEMS", () => {
  const r = app.systemsRollup(app.foldHarness(allHealthy({ kpiState: ready({ last_1h_fail_count: 0 }) })));
  assert.strictEqual(r.tone, "ok");
  assert.strictEqual(r.dotClass, "bg-ok");
  assert.strictEqual(r.label, "ALL SYSTEMS");
});

test("systemsRollup: a down part or a fail count → ISSUES DETECTED", () => {
  const down = app.systemsRollup(app.foldHarness(allHealthy({ liveState: ready(daemonPayload(1)) })));
  assert.strictEqual(down.label, "ISSUES DETECTED");
  assert.strictEqual(down.dotClass, "bg-warn");

  const fails = app.systemsRollup(
    app.foldHarness(allHealthy({ kpiState: ready({ last_1h_fail_count: 4 }) })),
  );
  assert.strictEqual(fails.label, "ISSUES DETECTED");
});

// The path a per-surface badge cache used to get wrong: the lane drops the daemon row while
// the footer keeps the verdict it was holding. One fold makes that disagreement unreachable.
test("a failed live poll moves the footer and the lane together, not apart", () => {
  const healthy = app.foldHarness(allHealthy());
  assert.strictEqual(app.systemsRollup(healthy).label, "ALL SYSTEMS");

  const lost = app.foldHarness(allHealthy({ liveState: { status: "error", data: null } }));
  assert.strictEqual(lost.daemonsDown, null, "the lane reads the daemons as unknown");
  assert.strictEqual(
    app.systemsRollup(lost).label,
    "ALL SYSTEMS",
    "the footer reports on what the same fold still observed — never on a dropped store",
  );
  assert.equal(lost.uncheckedNames.length, 4, "and the unknown parts are named as unknown");
});

test("harnessToNavBadges: the two contributors share the slot and cannot clobber each other", () => {
  const fold = app.foldHarness(
    allHealthy({ liveState: ready(daemonPayload(2)), kpiState: ready({ last_1h_fail_count: 4 }) }),
  );
  const badges = app.harnessToNavBadges(fold).architecture?.badges || [];
  const bySource = new Map(badges.map((b) => [b.source, b.badge]));
  assert.strictEqual(bySource.get("kpi"), "4");
  assert.strictEqual(bySource.get("daemon"), "2");
  assert.ok(badges.every((b) => b.badgeTone === "warn"));
});

test("harnessToNavBadges: polled-and-clean emits the key with a null badge; unpolled emits no key", () => {
  const clean = app.harnessToNavBadges(app.foldHarness(allHealthy({ kpiState: ready({ last_1h_fail_count: 0 }) })));
  assert.ok("architecture" in clean, "the key-present contract blocks the static fallback badge");
  assert.strictEqual(clean.architecture, null);

  assert.ok(
    !("architecture" in app.harnessToNavBadges(app.foldHarness({}))),
    "an unobserved fold claims nothing about the slot",
  );
});
