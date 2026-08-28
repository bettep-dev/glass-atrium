// Unit tests for public/src/app.jsx nav-badge routing (T2 · T13a): the live signal and the
// KPI fail count both land on the ONE architecture (System map) nav slot — the map owns the
// health readings now, so the Health entry point is gone (T13a) and mergeHealthBadge's source
// tags keep the three contributors (kpi · drift · daemon) from clobbering each other on
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
//
// Top-level `const` (NAV · Screens) lands in the context's global LEXICAL scope, not on
// globalThis — a second runInContext in the same context resolves it, which is how the nav
// entry assertions read the shipped list rather than a copy of it.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_SRC = resolve(__dirname, "../public/src/app.jsx");

interface Badge {
  badge: string;
  badgeTone: string;
  source?: string;
}
interface NavEntry {
  id: string;
  label: string;
  icon: string;
}
interface Rollup {
  tone: string;
  dotClass: string;
  label: string;
}
interface AppHelpers {
  liveToBadge: (live: unknown) => {
    drift: Badge | null;
    daemonDown: Badge | null;
  };
  mergeHealthBadge: (
    prevHealth: { badges?: Badge[] } | null,
    source: string,
    badge: Badge | null,
  ) => { badges: Badge[] } | null;
  kpiToBadges: (kpi: unknown) => { architecture: Badge | null; cost: Badge | null };
  systemsRollup: (dynamicBadges: unknown) => Rollup;
  parseHashScreen: () => string;
}
interface AppSurface extends AppHelpers {
  nav: NavEntry[];
  screens: Record<string, unknown>;
  setHash: (hash: string) => void;
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
  return Object.assign(h as AppSurface, {
    nav: vm.runInContext("NAV", ctx) as NavEntry[],
    screens: vm.runInContext("Screens", ctx) as Record<string, unknown>,
    setHash: (hash: string) => {
      location.hash = hash;
    },
  });
}

const app = await loadApp();

// --- T13a · AC-T13(a): the Health entry point is gone, the map keeps its own ---

test("nav: no Health entry and no health screen mapping", () => {
  assert.ok(
    !app.nav.some((n) => n.id === "health"),
    "NAV must not offer a Health entry",
  );
  assert.ok(
    !app.nav.some((n) => n.label === "System health"),
    "no nav label may still advertise the removed screen",
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(app.screens, "health"),
    "the screen map must not route a health id",
  );
  // The map entry stays — it is where the migrated readings live.
  assert.ok(app.nav.some((n) => n.id === "architecture"));
  assert.ok(
    Object.prototype.hasOwnProperty.call(app.screens, "architecture"),
    "the map must still be routable",
  );
});

test("routing: '#health' gets no alias — the unknown-hash fallback takes it to dashboard", () => {
  app.setHash("#health");
  assert.strictEqual(app.parseHashScreen(), "dashboard");
  app.setHash("#architecture");
  assert.strictEqual(app.parseHashScreen(), "architecture");
  app.setHash("");
});

// --- liveToBadge: both signals aimed at the one map slot ---

// deepStrictEqual trips on cross-realm prototype mismatch for vm-realm objects — assert fields.
function assertBadge(b: Badge | null | undefined, badge: string, badgeTone: string): void {
  assert.ok(b, "badge must be present");
  assert.strictEqual(b.badge, badge);
  assert.strictEqual(b.badgeTone, badgeTone);
}

test("liveToBadge: stale → drift info badge; non-ok daemons → warn count", () => {
  const out = app.liveToBadge({
    stale: true,
    daemons: [
      { effective_status: "error" },
      { effective_status: "ok" },
      { effective_status: "stale" },
    ],
  });
  assertBadge(out.drift, "Update needed", "info");
  assertBadge(out.daemonDown, "2", "warn");
});

test("liveToBadge: no stale + all-ok daemons → both badges null", () => {
  const out = app.liveToBadge({ stale: false, daemons: [{ effective_status: "ok" }] });
  assert.strictEqual(out.drift, null);
  assert.strictEqual(out.daemonDown, null);
});

test("liveToBadge: stale drift stays an info badge, never a daemon count", () => {
  const out = app.liveToBadge({ stale: true, daemons: [{ effective_status: "ok" }] });
  assertBadge(out.drift, "Update needed", "info");
  assert.strictEqual(out.daemonDown, null);
});

// AC-후속-2(screen): the transitional `status` duplicate is not the reader's input.
test("liveToBadge: a fixture carrying only effective_status counts the same daemons down", () => {
  const daemons = [
    { effective_status: "error" },
    { effective_status: "ok" },
    { effective_status: "stale" },
  ];
  assert.ok(
    daemons.every((d) => !Object.prototype.hasOwnProperty.call(d, "status")),
    "the fixture must carry no transitional status key at all",
  );
  assertBadge(app.liveToBadge({ daemons }).daemonDown, "2", "warn");
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

// --- mergeHealthBadge: KPI + drift + daemon coexistence on one slot ---

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

// The drift badge shares the slot but reports staleness of the drawing, not a system issue.
test("systemsRollup: a lone drift info badge does not raise ISSUES", () => {
  const r = app.systemsRollup({
    architecture: {
      badges: [{ badge: "Update needed", badgeTone: "info", source: "drift" }],
    },
  });
  assert.strictEqual(r.tone, "ok");
  assert.strictEqual(r.label, "ALL SYSTEMS");
});

test("systemsRollup: the retired health slot no longer feeds the footer", () => {
  const r = app.systemsRollup({
    health: { badges: [{ badge: "3", badgeTone: "warn", source: "kpi" }] },
  });
  assert.strictEqual(r.label, "CHECKING…");
});

// --- end-to-end: the two effects feeding one navBadges.architecture slot ---

test("effect composition: KPI, drift and daemon badges share the map slot", () => {
  const kpi = app.kpiToBadges({ last_1h_fail_count: 4 });
  assertBadge(kpi.architecture, "4", "warn");
  assert.ok(!("health" in kpi), "kpiToBadges must not emit a health slot key");
  assert.strictEqual(kpi.cost, null);

  const { drift, daemonDown } = app.liveToBadge({
    stale: true,
    daemons: [{ effective_status: "error" }],
  });
  let slot = app.mergeHealthBadge(null, "kpi", kpi.architecture);
  slot = app.mergeHealthBadge(slot, "drift", drift);
  slot = app.mergeHealthBadge(slot, "daemon", daemonDown);
  assert.strictEqual(slot?.badges.length, 3);
  const bySource = new Map(slot.badges.map((b) => [b.source, b.badge]));
  assert.strictEqual(bySource.get("kpi"), "4");
  assert.strictEqual(bySource.get("drift"), "Update needed");
  assert.strictEqual(bySource.get("daemon"), "1");

  // Two warns out of the three badges — the footer reads the slot the map now owns.
  assert.strictEqual(app.systemsRollup({ architecture: slot }).label, "ISSUES DETECTED");
});

// --- AC-T13(b): the deleted health screen leaves zero references in the shipped surfaces ---
//
// Read the files that actually ship, never a copy: a fixture restating the entry list would
// stay green after the real package.json drifted. The screen source itself, the build entry,
// the index include and the README screen table are the four surfaces T13b clears.
//
// The counter-direction assertion at the end is the guard against over-deleting: the KPI model
// `src/data/health-model.js` is loaded INDEPENDENTLY of the screen (index.html:106) and the map
// still consumes it (ADR-B1 R2), so removing that line must turn this file red.

const MONITOR_ROOT = resolve(__dirname, "..");
const HEALTH_SCREEN = resolve(MONITOR_ROOT, "public/src/screens/health.jsx");
const PKG_JSON = resolve(MONITOR_ROOT, "package.json");
const INDEX_HTML = resolve(MONITOR_ROOT, "public/index.html");
const MONITOR_README = resolve(MONITOR_ROOT, "README.md");

test("AC-T13(b): the health screen source is gone", () => {
  assert.ok(
    !existsSync(HEALTH_SCREEN),
    "public/src/screens/health.jsx must be deleted — the map absorbed it",
  );
});

test("AC-T13(b): the build:jsx entry list no longer names the health screen", () => {
  const pkg = readFileSync(PKG_JSON, "utf8");
  assert.ok(
    !pkg.includes("screens/health"),
    "monitor/package.json build:jsx must not list public/src/screens/health.jsx — " +
      "a stale entry makes esbuild fail to resolve and takes the whole suite down",
  );
});

test("AC-T13(b): index.html no longer includes the health screen bundle", () => {
  const html = readFileSync(INDEX_HTML, "utf8");
  assert.ok(
    !html.includes("screens/health"),
    "monitor/public/index.html must not <script src> dist/screens/health.js — " +
      "the bundle is no longer built, so the include would 404",
  );
});

test("AC-T13(b): the README screen table has no health row", () => {
  const readme = readFileSync(MONITOR_README, "utf8");
  assert.ok(
    !/^\|[^|\n]*\|\s*`health`\s*\|/m.test(readme),
    "monitor/README.md screen table must not carry a `health` row",
  );
  const screensDirLine = readme
    .split("\n")
    .find((line) => line.includes("└── screens/"));
  assert.ok(screensDirLine, "README source-tree listing must still describe screens/");
  assert.ok(
    !/\bhealth\b/.test(screensDirLine),
    `README source-tree screens/ listing must not name health — found: ${screensDirLine}`,
  );
});

// Counter-direction — deleting too much must go red here.
test("AC-T13(b) counter: index.html still loads the KPI model the map depends on", () => {
  const html = readFileSync(INDEX_HTML, "utf8");
  assert.ok(
    html.includes("src/data/health-model.js"),
    "monitor/public/index.html must keep loading src/data/health-model.js — " +
      "window.HealthModel is loaded independently of the screen and the map still reads it",
  );
});
