// Unit tests for public/src/app.jsx nav-badge routing (T2 · T13a): the live signal and the
// KPI fail count both land on the ONE architecture (System map) nav slot — the map owns the
// health readings now, so the Health entry point is gone (T13a) and mergeHealthBadge's source
// tags keep the two contributors (kpi · daemon) from clobbering each other on
// re-poll. The ALL SYSTEMS footer derives its three states from that same slot, and
// liveToBadge counts daemons down by `effective_status` (the verdict of record) rather than
// the transitional `status` duplicate.
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
// The REAL health model is evaluated into the same context: the shell derives the nav
// numeral and the harness fold from it, so a stub here would assert an echo of itself.
const HEALTH_MODEL_SRC = resolve(__dirname, "../public/src/data/health-model.js");

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
interface AppHelpers {
  liveToBadge: (live: unknown) => { daemonDown: Badge | null };
  mergeHealthBadge: (
    prevHealth: { badges?: Badge[] } | null,
    source: string,
    badge: Badge | null,
  ) => { badges: Badge[] } | null;
  kpiToBadges: (kpi: unknown) => { architecture: Badge | null; cost: Badge | null };
  systemsRollup: (dynamicBadges: unknown) => Rollup;
  parseHashScreen: () => string;
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
interface AppSurface extends AppHelpers {
  setHash: (hash: string) => void;
  foldHarness: (states: unknown) => HarnessFold;
}

async function loadApp(): Promise<AppSurface> {
  const built = await esbuild.build({
    entryPoints: [APP_SRC],
    bundle: false,
    write: false,
    loader: { ".jsx": "jsx" },
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    target: "es2022",
    format: "esm",
  });
  const code = built.outputFiles[0].text;

  const reactStub = new Proxy(
    {
      createElement: () => ({}),
      Fragment: "frag",
      useState: () => [undefined, () => {}],
      useEffect: () => {},
    },
    { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => ({})) },
  );
  const location = { hash: "" };
  const ctx: Record<string, unknown> = {
    window: { location, UI: {}, useTweaks: () => [{}, () => {}] },
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
  // health-model.js is plain JS and self-registers on window — load it first, as the browser does.
  vm.runInContext(await readFile(HEALTH_MODEL_SRC, "utf8"), ctx);
  vm.runInContext(code, ctx);

  const h = ctx as unknown as AppHelpers;
  assert.strictEqual(typeof h.liveToBadge, "function", "liveToBadge must be reachable");
  assert.strictEqual(
    typeof h.mergeHealthBadge,
    "function",
    "mergeHealthBadge must be reachable",
  );
  assert.strictEqual(
    typeof h.systemsRollup,
    "function",
    "systemsRollup must be reachable",
  );
  const healthModel = (ctx.window as { HealthModel: { foldHarness: AppSurface["foldHarness"] } })
    .HealthModel;
  return Object.assign(h as AppSurface, {
    setHash: (hash: string) => {
      location.hash = hash;
    },
    foldHarness: healthModel.foldHarness,
  });
}

const app = await loadApp();

// --- T13a · AC-T13(a): the Health entry point is gone; '#architecture' still resolves ---

test("routing: '#health' gets no alias — the unknown-hash fallback takes it to dashboard", () => {
  app.setHash("#health");
  assert.strictEqual(app.parseHashScreen(), "dashboard");
  app.setHash("#architecture");
  assert.strictEqual(app.parseHashScreen(), "architecture");
  app.setHash("");
});

// --- liveToBadge: the daemon signal aimed at the map slot ---

// deepStrictEqual trips on cross-realm prototype mismatch for vm-realm objects — assert fields.
function assertBadge(b: Badge | null | undefined, badge: string, badgeTone: string): void {
  assert.ok(b, "badge must be present");
  assert.strictEqual(b.badge, badge);
  assert.strictEqual(b.badgeTone, badgeTone);
}

test("liveToBadge: non-ok daemons → warn count", () => {
  const out = app.liveToBadge({
    daemons: [
      { effective_status: "error" },
      { effective_status: "ok" },
      { effective_status: "stale" },
    ],
  });
  assertBadge(out.daemonDown, "2", "warn");
});

test("liveToBadge: all-ok daemons → daemonDown null", () => {
  const out = app.liveToBadge({ daemons: [{ effective_status: "ok" }] });
  assert.strictEqual(out.daemonDown, null);
});

// A legacy `stale` field on the payload must not resurrect the retired drift slot.
test("liveToBadge: the drift slot is gone — daemonDown is the only key", () => {
  const out = app.liveToBadge({ stale: true, daemons: [] });
  assert.deepStrictEqual([...Object.keys(out)], ["daemonDown"]);
});

test("liveToBadge: effective_status wins over a disagreeing transitional status", () => {
  const out = app.liveToBadge({
    daemons: [
      { status: "ok", effective_status: "stale" },
      { status: "error", effective_status: "ok" },
    ],
  });
  assertBadge(out.daemonDown, "1", "warn");
});

// --- mergeHealthBadge: KPI + daemon coexistence on one slot ---

test("mergeHealthBadge: KPI and daemon badges coexist (no clobber)", () => {
  let slot = app.mergeHealthBadge(null, "kpi", { badge: "3", badgeTone: "warn" });
  slot = app.mergeHealthBadge(slot, "daemon", { badge: "1", badgeTone: "warn" });
  assert.strictEqual(slot?.badges.length, 2);
  const bySource = new Map(slot.badges.map((b) => [b.source, b.badge]));
  assert.strictEqual(bySource.get("kpi"), "3");
  assert.strictEqual(bySource.get("daemon"), "1");
});

test("mergeHealthBadge: re-poll of one source replaces only its own contribution", () => {
  let slot = app.mergeHealthBadge(null, "kpi", { badge: "3", badgeTone: "warn" });
  slot = app.mergeHealthBadge(slot, "daemon", { badge: "1", badgeTone: "warn" });
  slot = app.mergeHealthBadge(slot, "kpi", { badge: "5", badgeTone: "warn" });
  assert.strictEqual(slot?.badges.length, 2);
  const bySource = new Map(slot.badges.map((b) => [b.source, b.badge]));
  assert.strictEqual(bySource.get("kpi"), "5");
  assert.strictEqual(bySource.get("daemon"), "1");
});

test("mergeHealthBadge: clearing one source keeps the other; clearing both → null", () => {
  let slot = app.mergeHealthBadge(null, "kpi", { badge: "3", badgeTone: "warn" });
  slot = app.mergeHealthBadge(slot, "daemon", { badge: "1", badgeTone: "warn" });
  slot = app.mergeHealthBadge(slot, "kpi", null);
  assert.strictEqual(slot?.badges.length, 1);
  assert.strictEqual(slot.badges[0].source, "daemon");
  slot = app.mergeHealthBadge(slot, "daemon", null);
  assert.strictEqual(slot, null);
});

// --- AC-T13(c): the ALL SYSTEMS footer keeps its three states off the map slot ---

test("systemsRollup: map slot never polled → CHECKING…", () => {
  const r = app.systemsRollup({});
  assert.strictEqual(r.tone, "neutral");
  assert.strictEqual(r.dotClass, "bg-faint");
  assert.strictEqual(r.label, "CHECKING…");
});

test("systemsRollup: polled with no warn badge → ALL SYSTEMS", () => {
  const r = app.systemsRollup({ architecture: null });
  assert.strictEqual(r.tone, "ok");
  assert.strictEqual(r.dotClass, "bg-ok");
  assert.strictEqual(r.label, "ALL SYSTEMS");
});

test("systemsRollup: polled with a warn badge → ISSUES DETECTED", () => {
  const r = app.systemsRollup({
    architecture: { badges: [{ badge: "2", badgeTone: "warn", source: "daemon" }] },
  });
  assert.strictEqual(r.tone, "warn");
  assert.strictEqual(r.dotClass, "bg-warn");
  assert.strictEqual(r.label, "ISSUES DETECTED");
});

test("systemsRollup: the retired health slot no longer feeds the footer", () => {
  const r = app.systemsRollup({
    health: { badges: [{ badge: "3", badgeTone: "warn", source: "kpi" }] },
  });
  assert.strictEqual(r.label, "CHECKING…");
});

// --- end-to-end: the two effects feeding one navBadges.architecture slot ---

test("effect composition: KPI and daemon badges share the map slot", () => {
  const kpi = app.kpiToBadges({ last_1h_fail_count: 4 });
  assertBadge(kpi.architecture, "4", "warn");
  assert.ok(!("health" in kpi), "kpiToBadges must not emit a health slot key");
  assert.strictEqual(kpi.cost, null);

  const { daemonDown } = app.liveToBadge({
    daemons: [{ effective_status: "error" }],
  });
  let slot = app.mergeHealthBadge(null, "kpi", kpi.architecture);
  slot = app.mergeHealthBadge(slot, "daemon", daemonDown);
  assert.strictEqual(slot?.badges.length, 2);
  const bySource = new Map(slot.badges.map((b) => [b.source, b.badge]));
  assert.strictEqual(bySource.get("kpi"), "4");
  assert.strictEqual(bySource.get("daemon"), "1");

  // Both warns — the footer reads the slot the map now owns.
  assert.strictEqual(app.systemsRollup({ architecture: slot }).label, "ISSUES DETECTED");
});

// --- Harness fold: the ONE reading the nav numeral, the footer and the Dashboard lane share ---
// The point of the fold is that three surfaces cannot disagree about a harness fact, so the
// relationship asserted is agreement across an input class, not one hand-picked payload.

function daemonPayload(down: number): { daemons: { daemon_name: string; effective_status: string }[] } {
  const names = ["autoagent", "wiki", "daily-restart-autoagent", "daily-restart-wiki"];
  return {
    daemons: names.map((daemon_name, i) => ({
      daemon_name,
      effective_status: i < down ? "error" : "ok",
    })),
  };
}

test("fold daemonsDown equals the nav slot's daemon badge for every down count", async () => {
  const app = await loadApp();
  for (const down of [0, 1, 2, 3, 4]) {
    const live = daemonPayload(down);
    const fold = app.foldHarness({ liveState: { status: "ready", data: live } });
    const badge = app.liveToBadge(live).daemonDown;
    assert.equal(fold.daemonsDown, down, `fold must count ${down} down`);
    assert.equal(
      badge === null ? 0 : Number(badge.badge),
      fold.daemonsDown,
      "nav numeral and fold must report the same count",
    );
  }
});

test("an unpolled harness store leaves its parts unchecked rather than counted healthy", async () => {
  const app = await loadApp();
  const fold = app.foldHarness({});
  assert.equal(fold.status, "unavailable", "nothing polled = unavailable, never a healthy zero");
  assert.equal(fold.partsChecked, 0);
  assert.equal(fold.partsOk, 0);
  assert.equal(fold.uncheckedNames.length, fold.partsTotal);
  assert.equal(fold.daemonsDown, null, "an unpolled count is null, not 0");
  assert.equal(fold.failCount1h, null);
});

test("partsOk counts only observed-healthy parts and never exceeds partsChecked", async () => {
  const app = await loadApp();
  for (const down of [0, 2, 4]) {
    const fold = app.foldHarness({
      liveState: { status: "ready", data: daemonPayload(down) },
      healthState: { status: "ready", data: { status: "ok", db: "open", browser: "ok", version: "1.0.0" } },
    });
    assert.equal(fold.partsChecked, 6, "4 daemons + pg + browser are the shell-polled parts");
    assert.equal(fold.partsOk, 6 - down);
    assert.ok(fold.partsOk <= fold.partsChecked);
    assert.equal(fold.downNames.length, down);
    assert.equal(fold.version, "1.0.0");
    assert.equal(
      fold.uncheckedNames.join(","),
      "Hook Chain",
      "the hook chain is the System map's store",
    );
  }
});

test("a rejected harness store is unavailable, not a zero reading", async () => {
  const app = await loadApp();
  const fold = app.foldHarness({
    liveState: { status: "error", data: null },
    healthState: { status: "ready", data: { status: "ok", db: "open", browser: "ok" } },
  });
  assert.equal(fold.daemonsDown, null, "a failed poll reports unknown, never 0 down");
  assert.equal(fold.partsChecked, 2, "only the parts that answered are in the denominator");
  assert.equal(fold.version, null);
});
