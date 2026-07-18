// Unit tests for public/src/app.jsx nav-badge routing (T2): liveToBadge splits the
// live signal into two independent slots (architecture "Update needed" · health daemon
// count), and mergeHealthBadge co-locates the KPI-fail badge and the daemon-down badge
// on the health slot without either source clobbering the other on re-poll.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_SRC = resolve(__dirname, "../public/src/app.jsx");

interface Badge {
  badge: string;
  badgeTone: string;
  source?: string;
}
interface AppHelpers {
  liveToBadge: (live: unknown) => {
    architecture: Badge | null;
    daemonHealth: Badge | null;
  };
  mergeHealthBadge: (
    prevHealth: { badges?: Badge[] } | null,
    source: string,
    badge: Badge | null,
  ) => { badges: Badge[] } | null;
  kpiToBadges: (kpi: unknown) => { health: Badge | null; cost: Badge | null };
}

async function loadApp(): Promise<AppHelpers> {
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
  const ctx: Record<string, unknown> = {
    window: { location: { hash: "" }, UI: {}, useTweaks: () => [{}, () => {}] },
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
  return h;
}

const app = await loadApp();

// --- liveToBadge: two independent slots ---

// deepStrictEqual trips on cross-realm prototype mismatch for vm-realm objects — assert fields.
function assertBadge(b: Badge | null | undefined, badge: string, badgeTone: string): void {
  assert.ok(b, "badge must be present");
  assert.strictEqual(b.badge, badge);
  assert.strictEqual(b.badgeTone, badgeTone);
}

test("liveToBadge: stale → architecture info badge; non-ok daemons → health warn count", () => {
  const out = app.liveToBadge({
    stale: true,
    daemons: [{ status: "error" }, { status: "ok" }, { status: "partial" }],
  });
  assertBadge(out.architecture, "Update needed", "info");
  assertBadge(out.daemonHealth, "2", "warn");
});

test("liveToBadge: no stale + all-ok daemons → both slots null", () => {
  const out = app.liveToBadge({ stale: false, daemons: [{ status: "ok" }] });
  assert.strictEqual(out.architecture, null);
  assert.strictEqual(out.daemonHealth, null);
});

test("liveToBadge: stale drift never leaks into the health slot", () => {
  const out = app.liveToBadge({ stale: true, daemons: [{ status: "ok" }] });
  assertBadge(out.architecture, "Update needed", "info");
  assert.strictEqual(out.daemonHealth, null);
});

// --- mergeHealthBadge: KPI + daemon coexistence on one slot ---

test("mergeHealthBadge: KPI and daemon badges coexist (no clobber)", () => {
  let health = app.mergeHealthBadge(null, "kpi", { badge: "3", badgeTone: "warn" });
  health = app.mergeHealthBadge(health, "daemon", { badge: "1", badgeTone: "warn" });
  assert.strictEqual(health?.badges.length, 2);
  const bySource = new Map(health.badges.map((b) => [b.source, b.badge]));
  assert.strictEqual(bySource.get("kpi"), "3");
  assert.strictEqual(bySource.get("daemon"), "1");
});

test("mergeHealthBadge: re-poll of one source replaces only its own contribution", () => {
  let health = app.mergeHealthBadge(null, "kpi", { badge: "3", badgeTone: "warn" });
  health = app.mergeHealthBadge(health, "daemon", { badge: "1", badgeTone: "warn" });
  health = app.mergeHealthBadge(health, "kpi", { badge: "5", badgeTone: "warn" });
  assert.strictEqual(health?.badges.length, 2);
  const bySource = new Map(health.badges.map((b) => [b.source, b.badge]));
  assert.strictEqual(bySource.get("kpi"), "5");
  assert.strictEqual(bySource.get("daemon"), "1");
});

test("mergeHealthBadge: clearing one source keeps the other; clearing both → null", () => {
  let health = app.mergeHealthBadge(null, "kpi", { badge: "3", badgeTone: "warn" });
  health = app.mergeHealthBadge(health, "daemon", { badge: "1", badgeTone: "warn" });
  health = app.mergeHealthBadge(health, "kpi", null);
  assert.strictEqual(health?.badges.length, 1);
  assert.strictEqual(health.badges[0].source, "daemon");
  health = app.mergeHealthBadge(health, "daemon", null);
  assert.strictEqual(health, null);
});

// --- end-to-end: the two effects feeding one navBadges.health slot ---

test("effect composition: kpiToBadges + liveToBadge merge onto health; architecture stays stale-only", () => {
  const kpi = app.kpiToBadges({ last_1h_fail_count: 4 });
  const { architecture, daemonHealth } = app.liveToBadge({
    stale: true,
    daemons: [{ status: "error" }],
  });
  let health = app.mergeHealthBadge(null, "kpi", kpi.health);
  health = app.mergeHealthBadge(health, "daemon", daemonHealth);
  assert.strictEqual(health?.badges.length, 2);
  // System map slot carries only the info drift badge — no warn count.
  assertBadge(architecture, "Update needed", "info");
  assert.ok(!health.badges.some((b) => b.badge === "Update needed"));
});
