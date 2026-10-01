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
  title?: string;
}
interface Rollup {
  tone: string;
  dotClass: string;
  label: string;
  glyph?: string | null;
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
  agentsToNavBadges: (agentsState: unknown) => { agents?: Badge | null };
  systemsRollup: (harness: HarnessFold | null, pageState?: ShellPageState | null) => Rollup;
  getHarness: (stores: Record<string, unknown>) => HarnessFold & { unreadSources: string[]; error: string | null };
  parseHashScreen: () => string;
  toStoreState: (settled: PromiseSettledResult<unknown>, prev?: unknown) => { status: string; data: unknown };
  readHarnessSources: (read: (url: string) => Promise<unknown>) => Promise<Record<string, PromiseSettledResult<unknown>>>;
}
interface ShellPageState {
  state: string;
  at: string | null;
}
interface StampInput {
  at?: string;
  loading?: boolean;
  failed?: boolean;
  regions?: { busy: boolean; error: string | null }[];
  now: number;
}
interface UiSurface {
  getShellPageState: (input: StampInput) => ShellPageState;
  formatKstTime: (at: string) => string;
}
interface AppSurface extends AppHelpers {
  setHash: (hash: string) => void;
  foldHarness: (states: unknown) => HarnessFold;
  ui: UiSurface;
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
  const { HealthModel: healthModel, UI: ui } = ctx.window as {
    HealthModel: { foldHarness: AppSurface["foldHarness"] };
    UI: UiSurface;
  };
  return Object.assign(h as AppSurface, {
    setHash: (hash: string) => {
      location.hash = hash;
    },
    foldHarness: healthModel.foldHarness,
    ui,
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

// The lane headline counts fold.downNames — every down part, not only daemons — so the numeral must too.
test("the nav down numeral equals the lane's down-part count for every mix of down parts", () => {
  const rows = [
    { name: "nothing down", over: {} },
    { name: "one daemon down", over: { liveState: ready(daemonPayload(1)) } },
    { name: "every daemon down", over: { liveState: ready(daemonPayload(4)) } },
    {
      name: "two daemons plus the hook chain",
      over: { liveState: ready(daemonPayload(2)), hookFailState: ready({ count_24h: 1, unretried_count_24h: 1 }) },
    },
    { name: "postgres down, daemons fine", over: { healthState: ready({ status: "ok", db: "closed", browser: "ok" }) } },
  ];
  for (const row of rows) {
    const fold = app.foldHarness(allHealthy(row.over));
    const badges = app.harnessToNavBadges(fold).architecture?.badges || [];
    const downBadge = badges.find((b) => b.source === "down");
    assert.equal(downBadge === undefined ? 0 : Number(downBadge.badge), fold.downNames.length, row.name);
  }
});

test("the nav down badge's tooltip names every down part it counts", () => {
  const fold = app.foldHarness(
    allHealthy({ liveState: ready(daemonPayload(2)), hookFailState: ready({ count_24h: 1, unretried_count_24h: 1 }) }),
  );
  const downBadge = (app.harnessToNavBadges(fold).architecture?.badges || []).find((b) => b.source === "down");
  assert.ok(downBadge?.title, "the badge explains what it counts");
  assert.match(downBadge.title, /3 harness parts down/);
  for (const name of fold.downNames) assert.ok(downBadge.title.includes(name), `${name} is named`);
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

test("a failed poll keeps the held reading; only a store that never answered becomes an error", () => {
  const held = { status: "ready", data: daemonPayload(1) };
  const rejected: PromiseSettledResult<unknown> = { status: "rejected", reason: new Error("HTTP 503") };
  const rows = [
    { name: "held reading survives the failure, marked failed", prev: held, expected: { ...held, error: "HTTP 503" } },
    { name: "no prior reading → error", prev: { status: "loading", data: null }, expected: { status: "error", data: null, error: "HTTP 503" } },
    { name: "a prior error stays an error", prev: { status: "error", data: null }, expected: { status: "error", data: null, error: "HTTP 503" } },
  ];
  for (const row of rows) {
    // spread → the vm realm's object prototype drops out of the strict comparison
    assert.deepEqual({ ...app.toStoreState(rejected, row.prev) }, row.expected, row.name);
  }
  assert.deepEqual(
    { ...app.toStoreState({ status: "fulfilled", value: { ok: 1 } }, held) },
    { status: "ready", data: { ok: 1 }, error: null },
    "a fresh answer replaces the held one and clears the failure",
  );
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

// The footer tone follows the worst alarm: a down part is crit on the lane, so the footer is crit too.
test("systemsRollup: a down part is crit with the ✕ glyph and the lane's down count", () => {
  for (const down of [1, 3]) {
    const fold = app.foldHarness(allHealthy({ liveState: ready(daemonPayload(down)), kpiState: ready({ last_1h_fail_count: 4 }) }));
    const r = app.systemsRollup(fold);
    assert.strictEqual(r.tone, "crit", `${down} down outranks the fail count`);
    assert.strictEqual(r.dotClass, "bg-crit");
    assert.strictEqual(r.glyph, "✕");
    assert.strictEqual(r.label, `${fold.downNames.length} ${down === 1 ? "PART" : "PARTS"} DOWN`);
  }
});

test("systemsRollup: failures with no down part stay warn, without the crit glyph", () => {
  const r = app.systemsRollup(app.foldHarness(allHealthy({ kpiState: ready({ last_1h_fail_count: 4 }) })));
  assert.strictEqual(r.tone, "warn");
  assert.strictEqual(r.dotClass, "bg-warn");
  assert.strictEqual(r.label, "ISSUES DETECTED");
  assert.ok(!r.glyph);
});

// An unread source is unknown, never healthy: the footer must not keep "ALL SYSTEMS" over a lost store.
test("a failed harness read turns the footer to STATUS UNKNOWN, fresh or held", () => {
  assert.strictEqual(app.systemsRollup(app.getHarness(allHealthy())).label, "ALL SYSTEMS");

  const rows = [
    { name: "cold failure", liveState: { status: "error", data: null, error: "HTTP 500" } },
    { name: "held reading whose repoll failed", liveState: { status: "ready", data: daemonPayload(0), error: "HTTP 500" } },
  ];
  for (const row of rows) {
    const harness = app.getHarness(allHealthy({ liveState: row.liveState }));
    assert.deepEqual([...harness.unreadSources], ["daemon status"], row.name);
    assert.strictEqual(harness.error, "HTTP 500", row.name);
    assert.strictEqual(app.systemsRollup(harness).label, "STATUS UNKNOWN", row.name);
  }

  const known = app.getHarness(allHealthy({ liveState: ready(daemonPayload(1)), hookState: { status: "error", data: null, error: "x" } }));
  assert.strictEqual(app.systemsRollup(known).label, "1 PART DOWN", "a known fault still outranks an unread source");
});

// The harness tile's Retry and the page Refresh run this one read → a source it skipped would stay unread after the Retry.
test("the harness re-read covers every source the harness can report unread, the failure count included", async () => {
  const requested: string[] = [];
  const settled = await app.readHarnessSources(async (url) => {
    requested.push(url);
    throw new Error("HTTP 500");
  });
  const stores = Object.fromEntries(Object.entries(settled).map(([key, result]) => [key, app.toStoreState(result)]));
  const unread = app.getHarness(stores).unreadSources;

  assert.strictEqual(requested.length, Object.keys(settled).length, "one request per source");
  assert.strictEqual(new Set(unread).size, requested.length, "each re-read source maps to its own unread label");
  assert.ok(unread.includes("the failure count"), "a failed failure-count read is re-read by the same Retry");
  assert.ok(requested.includes("/api/dashboard/kpi"));
});

test("harnessToNavBadges: the two contributors share the slot and cannot clobber each other", () => {
  const fold = app.foldHarness(
    allHealthy({ liveState: ready(daemonPayload(2)), kpiState: ready({ last_1h_fail_count: 4 }) }),
  );
  const badges = app.harnessToNavBadges(fold).architecture?.badges || [];
  const bySource = new Map(badges.map((b) => [b.source, b.badge]));
  assert.strictEqual(bySource.get("kpi"), "4");
  assert.strictEqual(bySource.get("down"), "2");
  const toneBySource = new Map(badges.map((b) => [b.source, b.badgeTone]));
  assert.strictEqual(toneBySource.get("down"), "crit", "a down part reads crit, as its Dashboard alarm does");
  assert.strictEqual(toneBySource.get("kpi"), "warn");
  assert.match(badges.find((b) => b.source === "kpi")?.title || "", /4 failed tasks in the last hour/);
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

// --- The Agents nav numeral: agents unsafe to route, read from the circuit-breaker summary ---

function breakerAlarm(agent: string, suspended: boolean): Record<string, unknown> {
  return { agent, suspended, consecutive_fails: suspended ? 3 : 2, suspended_at: suspended ? "2026-10-01T09:00:00Z" : null };
}
function breakerSummary(alarms: Record<string, unknown>[]): unknown {
  const suspended = alarms.filter((a) => a.suspended).length;
  return {
    data: [],
    meta: {
      circuit_breaker: {
        source: "loaded",
        registry_agents: 23,
        suspended_count: suspended,
        streak_count: alarms.length - suspended,
        alarms,
      },
    },
  };
}

test("the Agents nav numeral equals the unsafe-to-route count, crit once any agent is suspended", async (t) => {
  const rows = [
    { name: "one streak", alarms: [breakerAlarm("glass-atrium-dev-react", false)], tone: "warn" },
    { name: "two streaks", alarms: [breakerAlarm("glass-atrium-dev-react", false), breakerAlarm("glass-atrium-dev-node", false)], tone: "warn" },
    { name: "one suspended", alarms: [breakerAlarm("glass-atrium-qa-debugger", true)], tone: "crit" },
    {
      name: "suspended plus a streak",
      alarms: [breakerAlarm("glass-atrium-qa-debugger", true), breakerAlarm("glass-atrium-dev-node", false)],
      tone: "crit",
    },
  ];
  for (const row of rows) {
    await t.test(row.name, () => {
      const slot = app.agentsToNavBadges(ready(breakerSummary(row.alarms))).agents;
      assert.strictEqual(slot?.badge, String(row.alarms.length));
      assert.strictEqual(slot?.badgeTone, row.tone);
      for (const alarm of row.alarms) assert.ok(slot?.title?.includes(String(alarm.agent)), `${alarm.agent} is named`);
    });
  }
});

test("the Agents nav numeral renders nothing at zero, while unread, or when the breaker is unavailable", async (t) => {
  const unavailable = { meta: { circuit_breaker: { source: "unavailable", registry_agents: 23, suspended_count: 0, streak_count: 0, alarms: [] } } };
  const rows = [
    { name: "loaded with no alarm", state: ready(breakerSummary([])) },
    { name: "never answered", state: { status: "loading", data: null } },
    { name: "first read failed", state: { status: "error", data: null, error: "HTTP 500" } },
    { name: "breaker unavailable", state: ready(unavailable) },
    { name: "summary without a breaker", state: ready({ data: [], meta: {} }) },
  ];
  for (const row of rows) {
    await t.test(row.name, () => {
      assert.strictEqual(app.agentsToNavBadges(row.state).agents?.badge, undefined);
    });
  }
});

interface SidebarSurface {
  Sidebar: (props: Record<string, unknown>) => unknown;
  React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown };
}
const collectText = (node: unknown): string[] => {
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (node === null || typeof node !== "object" || !("children" in node)) return [];
  return collectText((node as { children: unknown[] }).children);
};
interface RenderedNode {
  type: unknown;
  props: Record<string, unknown> | null;
  children: unknown[];
}
const isRenderedNode = (node: unknown): node is RenderedNode =>
  node !== null && typeof node === "object" && "children" in node && "props" in node;
const findNodes = (node: unknown, match: (n: RenderedNode) => boolean): RenderedNode[] => {
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, match));
  if (!isRenderedNode(node)) return [];
  return [...(match(node) ? [node] : []), ...findNodes(node.children, match)];
};
// Sidebar's element tree, with agentsState reaching it beside the harness exactly as App passes them
const renderSidebar = (harness: unknown, agentsState: unknown): unknown => {
  const surface = app as unknown as SidebarSurface;
  const stubCreate = surface.React.createElement;
  surface.React.createElement = (type, props, ...children) => ({ type, props, children });
  try {
    return surface.Sidebar({ active: "dashboard", onNav: () => {}, harness, agentsState, pageState: null });
  } finally {
    surface.React.createElement = stubCreate;
  }
};
const renderSidebarText = (harness: unknown, agentsState: unknown): string[] =>
  collectText(renderSidebar(harness, agentsState));

test("a failed agent-store read leaves the footer and the System map numeral unchanged", () => {
  const harness = app.getHarness(allHealthy({ liveState: ready(daemonPayload(1)), kpiState: ready({ last_1h_fail_count: 2 }) }));
  const unread = renderSidebarText(harness, { status: "loading", data: null });
  const failed = renderSidebarText(harness, { status: "error", data: null, error: "HTTP 503" });
  const systemMapNumeral = app.harnessToNavBadges(harness).architecture?.badges[0]?.badge;
  assert.ok(systemMapNumeral && unread.includes(systemMapNumeral), "the render reaches the System map numeral");
  assert.ok(unread.includes(app.systemsRollup(harness).label), "the render reaches the footer");
  assert.deepStrictEqual(failed, unread);
});

// The numeral alone says how many; the rendered tooltip is where the operator reads which agents.
test("the rendered Agents nav badge's tooltip names every agent it counts", () => {
  const alarms = [breakerAlarm("glass-atrium-qa-debugger", true), breakerAlarm("glass-atrium-dev-node", false)];
  const tree = renderSidebar(app.getHarness(allHealthy()), ready(breakerSummary(alarms)));
  const [agentsItem] = findNodes(tree, (n) => n.props?.key === "agents");
  const [agentsBadge] = findNodes(agentsItem, (n) => String(n.props?.className ?? "").includes("nav-badge"));
  const title = String(agentsBadge?.props?.title ?? "");

  assert.ok(agentsBadge, "the Agents item renders its badge");
  for (const alarm of alarms) assert.ok(title.includes(String(alarm.agent)), `${alarm.agent} is named in the rendered tooltip`);
});

// A daemon row may still carry the retired `stale` flag; the verdict is effective_status alone.
test("a legacy stale flag on a healthy daemon row adds no System map badge", () => {
  const legacy = {
    daemons: daemonPayload(0).daemons.map((row) => ({ ...row, stale: true })),
  };
  const fold = app.foldHarness(allHealthy({ liveState: ready(legacy), kpiState: ready({ last_1h_fail_count: 0 }) }));
  assert.strictEqual(app.harnessToNavBadges(fold).architecture, null);
});

// The sidebar never reads greener than the page in view: the header stamp's read state takes only the ALL SYSTEMS slot.
test("the sidebar slot follows the page's read state, below every harness word", async (t) => {
  const at = "2026-09-30T05:05:00Z";
  const now = Date.parse("2026-09-30T05:06:00Z");
  const healthy = app.getHarness(allHealthy());
  const faulted = app.getHarness(allHealthy({ liveState: ready(daemonPayload(1)) }));
  const unread = app.getHarness(allHealthy({ liveState: { status: "error", data: null, error: "HTTP 500" } }));
  const lastKnown = `LAST KNOWN ${app.ui.formatKstTime(at)}`;
  const rows = [
    { name: "one page source failed, harness healthy → Last known at the page's read time", harness: healthy, stamp: { at, now, regions: [{ busy: false, error: null }, { busy: false, error: "HTTP 500" }] }, label: lastKnown, tone: "neutral" },
    { name: "the page's refresh failed over held data → Last known", harness: healthy, stamp: { at, now, failed: true }, label: lastKnown, tone: "neutral" },
    { name: "a failed first page read → Not read", harness: healthy, stamp: { now, failed: true }, label: "NOT READ", tone: "neutral" },
    { name: "a harness fault outranks a page Last known", harness: faulted, stamp: { at, now, failed: true }, label: "1 PART DOWN", tone: "crit" },
    { name: "an unread harness source outranks a page Last known", harness: unread, stamp: { at, now, failed: true }, label: "STATUS UNKNOWN", tone: "neutral" },
    { name: "a first page read in flight still reads Checking", harness: healthy, stamp: { now, loading: true }, label: "CHECKING…", tone: "neutral" },
    { name: "a refresh over a fresh read keeps All systems", harness: healthy, stamp: { at, now, loading: true }, label: "ALL SYSTEMS", tone: "ok" },
    { name: "a fresh page read keeps All systems", harness: healthy, stamp: { at, now }, label: "ALL SYSTEMS", tone: "ok" },
  ];
  for (const row of rows) {
    await t.test(row.name, () => {
      const rollup = app.systemsRollup(row.harness, app.ui.getShellPageState(row.stamp));

      assert.strictEqual(rollup.label, row.label);
      assert.strictEqual(rollup.tone, row.tone);
    });
  }
});
