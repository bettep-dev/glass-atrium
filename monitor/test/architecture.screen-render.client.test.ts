// Element-tree behaviour tests for the System map screen, run on the shipped JSX through test/lib/render-screen.ts.
//
// Runner: npx tsx --test test/architecture.screen-render.client.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { collectText, createReactStub, findNodes, loadScreenModule, renderScreen } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH_SRC = resolve(__dirname, "../public/src/screens/architecture.jsx");
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const realUi = ((await loadScreenModule(UI_SRC)) as { UI: Record<string, unknown> }).UI;

type Component = (props: unknown) => unknown;

// window.UI stub — components resolve to transparent host elements; state helpers and constants stay real.
function uiStub(overrides: Record<string, unknown>): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name in overrides) return overrides[name];
        if (!/^[A-Z][a-z]/.test(name) && name in realUi) return realUi[name];
        return Object.defineProperty(
          (props: Record<string, unknown>) => ({ __element: true, type: "ui-atom", props: { ...props, atom: name } }),
          "name",
          { value: name },
        );
      },
      has: () => true,
    },
  );
}

type RegionState = Record<string, unknown>;

// the state a Retry on a cold failure produces — putRegionRequest keeps the error and flips status to 'loading'
function getColdRetryState(): RegionState {
  const initial = realUi.INITIAL_REGION_STATE as RegionState;
  const down = { ...initial, status: "error", data: null, error: "HTTP 503 Service Unavailable — down", busy: false };
  const putRegionRequest = realUi.putRegionRequest as (state: RegionState, key: string, request: object) => RegionState;
  return putRegionRequest(down, "retry", new AbortController());
}

test("the page alert shows its Retry in flight and hands focus to the verdict, which outlives recovery", async () => {
  const retrying = getColdRetryState();
  const mod = (await loadScreenModule(ARCH_SRC, {
    UI: uiStub({ INITIAL_REGION_STATE: retrying }),
    React: createReactStub(),
  })) as { React: { createElement: (t: unknown, p: unknown) => unknown }; ScreenArchitecture: Component };

  const tree = renderScreen(mod.React.createElement(mod.ScreenArchitecture, {}));
  const banners = findNodes(tree, (n) => n.props.atom === "PageErrorBanner");
  assert.equal(banners.length, 1, "every read failing on one cause lifts to one page alert");
  assert.equal(banners[0].props.isBusy, true, "a Retry in flight marks the alert busy");
  // host nodes only — a stubbed atom also appears as its component node
  const targets = findNodes(tree, (n) => /^[a-z]/.test(n.type) && n.props.id === banners[0].props.focusTargetId);
  assert.equal(targets.length, 1, `focus target ${String(banners[0].props.focusTargetId)} is one rendered element`);
  assert.notEqual(targets[0].props.atom, "PageErrorBanner", "focus lands outside the alert that unmounts on recovery");
});

test("a cold map Retry keeps the map's failure card in place, busy, with a focus target that outlives recovery", async () => {
  const mod = (await loadScreenModule(ARCH_SRC, {
    UI: uiStub({ INITIAL_REGION_STATE: getColdRetryState() }),
    React: createReactStub(),
  })) as { React: { createElement: (t: unknown, p: unknown) => unknown }; ScreenArchitecture: Component };

  const tree = renderScreen(mod.React.createElement(mod.ScreenArchitecture, {}));
  const cards = findNodes(tree, (n) => n.props.atom === "RegionFailure" && /\barch-col-card\b/.test(String(n.props.className)));
  assert.equal(cards.length, 1, "the map slot stays a failure card during its Retry instead of collapsing to a loader");
  assert.equal(cards[0].props.isBusy, true, "the card's Retry shows as in flight");
  const targetId = cards[0].props.focusTargetId;
  const targets = findNodes(tree, (n) => /^[a-z]/.test(n.type) && n.props.atom === undefined && n.props.id === targetId);
  assert.equal(targets.length, 1, `focus target ${String(targetId)} is one host element`);
  assert.equal(findNodes(targets[0], (n) => n === cards[0]).length, 1, "the target wraps the card, so it outlives the error-to-map swap");
});

test("the part-health column never says 'No other parts' above a non-empty Not loaded list", async () => {
  const mod = (await loadScreenModule(ARCH_SRC, { UI: uiStub({}), React: createReactStub() })) as {
    React: { createElement: (t: unknown, p: unknown) => unknown };
    PartHealthBlockAR: Component;
  };
  const coldRow = { id: "hooks", name: "Hook failures", kind: "unknown-kind", daemonName: null, tone: null, statusLabel: "Not loaded", nodeIds: [] };
  const props = { partRows: [coldRow], attentionEmpty: "Nothing needs attention", freshness: null, nodeIndex: new Map(), onSelectNode: () => {} };

  const tree = renderScreen(mod.React.createElement(mod.PartHealthBlockAR, props));
  const text = JSON.stringify(findNodes(tree, (n) => n.type === "p" || n.type === "h3").map((n) => n.children ?? ""));
  assert.match(text, /Not loaded/, "precondition: the cold part is listed as not loaded");
  assert.doesNotMatch(text, /No other parts/);
});

test("a cold map read the page alert speaks for keeps a quiet placeholder in the map's own space", async () => {
  const initial = realUi.INITIAL_REGION_STATE as Record<string, unknown>;
  const down = { ...initial, status: "error", data: null, error: "HTTP 503 Service Unavailable — down", busy: false };
  const mod = (await loadScreenModule(ARCH_SRC, {
    UI: uiStub({ INITIAL_REGION_STATE: down }),
    React: createReactStub(),
  })) as { React: { createElement: (t: unknown, p: unknown) => unknown }; ScreenArchitecture: Component };

  const tree = renderScreen(mod.React.createElement(mod.ScreenArchitecture, {}));
  const [banner] = findNodes(tree, (n) => n.props.atom === "PageErrorBanner");
  const placeholders = findNodes(tree, (n) => n.props.atom === "RegionFailure" && /\barch-col-card\b/.test(String(n.props.className)));
  assert.ok(banner, "precondition: the shared outage lifts to the page alert");
  assert.equal(placeholders.length, 1, "the map region renders one map-sized failure placeholder");
  const shared = placeholders[0].props.shared as { sources: string[] };
  assert.ok(shared.sources.includes(String(placeholders[0].props.source)), "the placeholder is told the alert already names its source");
});

test("the node drawer names each of its sections with a heading element", async () => {
  const mod = (await loadScreenModule(ARCH_SRC, { UI: uiStub({}), React: createReactStub() })) as {
    React: { createElement: (t: unknown, p: unknown) => unknown };
    NodeDetailBody: Component;
  };
  const nodeId = "canonical.hook_pipeline";
  const props = {
    info: { id: nodeId, label: "Hook pipeline", path: "hooks/", description: "Hooks" },
    flows: [{ id: "f1", from: "canonical.agent_layer", to: nodeId }],
    nodeIndex: new Map([["canonical.agent_layer", { label: "Agents" }]]),
    liveDaemonsByNodeId: new Map(),
    healthPartRows: [{ id: "hooks", name: "Hook failures", kind: "unknown-kind", daemonName: null, tone: "ok", statusLabel: "Healthy", nodeIds: ["hook_pipeline"] }],
    zoneIdByMemberId: new Map(),
  };

  const tree = renderScreen(mod.React.createElement(mod.NodeDetailBody, props));
  const headingText = (n: { children?: unknown }): string => JSON.stringify(n.children ?? "");
  const headings = findNodes(tree, (n) => /^h[2-6]$/.test(n.type)).map(headingText).join(" ");
  for (const section of ["Health", "Connections", "Records"])
    assert.match(headings, new RegExp(section), `the ${section} section has no heading element`);
});

type ArchModule = { React: { createElement: (t: unknown, p: unknown) => unknown } } & Record<string, Component>;

async function loadArch(overrides: Record<string, unknown> = {}): Promise<ArchModule> {
  return (await loadScreenModule(ARCH_SRC, { UI: uiStub(overrides), React: createReactStub() })) as ArchModule;
}

function getMapSlot(tree: ReturnType<typeof renderScreen>): { region: { props: Record<string, unknown> }; placeholder: { props: Record<string, unknown> } } {
  const [region] = findNodes(tree, (n) => /^[a-z]/.test(n.type) && n.props.atom === undefined && n.props.id === "arch-map-region");
  const [placeholder] = findNodes(region, (n) => n.props.atom === "LoadingPlaceholder" || n.props.atom === "RegionFailure");
  return { region, placeholder };
}

test("a map not drawn yet holds one map-sized slot, the same while loading and after a cold failure", async () => {
  const initial = realUi.INITIAL_REGION_STATE as Record<string, unknown>;
  const down = { ...initial, status: "error", data: null, error: "HTTP 503 Service Unavailable — down", busy: false };
  const loading = getMapSlot(renderScreen((await loadArch()).React.createElement((await loadArch()).ScreenArchitecture, {})));
  const coldMod = await loadArch({ INITIAL_REGION_STATE: down });
  const cold = getMapSlot(renderScreen(coldMod.React.createElement(coldMod.ScreenArchitecture, {})));

  assert.equal(loading.placeholder.props.atom, "LoadingPlaceholder", "precondition: the first read shows the loader");
  assert.equal(cold.placeholder.props.atom, "RegionFailure", "precondition: a cold failure shows its card");
  assert.ok(Number(loading.placeholder.props.minHeight) > 0, "the loader reserves a height of its own");
  assert.equal(cold.placeholder.props.minHeight, loading.placeholder.props.minHeight, "loader and failure card hold the same slot, so neither swap jumps");
  for (const slot of [loading, cold])
    assert.match(String(slot.region.props.className), /\barch-main-pending\b/, "an undrawn map region is marked so the page-tall floor lets go of it");
});

// font-size a page rule sets for one class, in px — tokens resolved from the shipped tokens.css
function getRuleFontPx(css: string, className: string): number {
  const tokens = readFileSync(resolve(__dirname, "../public/styles/tokens.css"), "utf8");
  const rule = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const value = /font-size:\s*([^;]+);/.exec(rule)?.[1]?.trim() ?? "";
  const token = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  const px = token ? new RegExp(`${token}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(tokens)?.[1] : /^(\d+(?:\.\d+)?)px$/.exec(value)?.[1];
  assert.ok(px, `.${className} sets its own font-size in px or a size token, not '${value || "nothing"}'`);
  return Number(px);
}

test("every heading on the page and in the drawer is no larger than the heading it sits under", async () => {
  const mod = await loadArch();
  const tree = renderScreen(mod.React.createElement(mod.ScreenArchitecture, {}));
  const css = findNodes(tree, (n) => n.type === "style").map(collectText).join(" ");
  const ladders = [
    { name: "Part health", upper: "arch-part-health-title", lower: "arch-part-col-title" },
    { name: "drawer section", upper: "arch-drawer-heading", lower: "arch-drawer-subheading" },
  ];
  for (const ladder of ladders)
    assert.ok(getRuleFontPx(css, ladder.upper) >= getRuleFontPx(css, ladder.lower), `${ladder.name}: the lower heading outsizes the one above it`);
});

test("the node drawer's title is a heading that ranks above its section headings", async () => {
  const mod = await loadArch();
  const nodeId = "canonical.hook_pipeline";
  const props = {
    detail: { payload: { id: nodeId } },
    nodeIndex: new Map([[nodeId, { id: nodeId, label: "Hook pipeline" }]]),
    activeDiagram: null,
    liveDaemonsByNodeId: new Map(),
    healthPartRows: [],
    zoneIdByMemberId: new Map(),
    onClose: () => {},
  };

  const tree = renderScreen(mod.React.createElement(mod.DetailModal, props));
  const [surface] = findNodes(tree, (n) => n.props.atom === "DetailSurface");
  const title = surface.props.title as { type?: unknown; props?: { children?: unknown } };
  assert.equal(title.type, "h2", "the drawer title is an h2 — its sections are h3");
  assert.match(JSON.stringify(title.props?.children), /Hook pipeline/);
});

test("the hook chain lists each event collapsed, its hook paths behind a summary naming the count", async () => {
  const mod = await loadArch();
  const hooks = [{ command: "/h/a.sh", type: "command", timeout: 5 }, { command: "/h/b.sh", type: "command", timeout: null }];
  const state = {
    status: "ready",
    data: { source_path: "/s/settings.json", source_mtime: null, events: [{ event: "PreToolUse", groups: [{ matcher: "Bash", hooks }] }, { event: "Stop", groups: [] }] },
  };

  const tree = renderScreen(mod.React.createElement(mod.HookChainDetail, { state }));
  const [details] = findNodes(tree, (n) => n.type === "details");
  assert.ok(details, "an event with hooks folds into a details element");
  assert.notEqual(details.props.open, true, "the event starts collapsed");
  const [summary] = findNodes(details, (n) => n.type === "summary");
  assert.match(collectText(summary), /PreToolUse[\s\S]*2\s+hooks/, "the summary names the event and its hook count");
  assert.equal(findNodes(summary, (n) => collectText(n).includes("/h/a.sh")).length, 0, "the hook paths sit behind the summary, not in it");
});

test("the hook chain gives every matcher group of one event its own key, even when settings repeat a matcher", async () => {
  const mod = await loadArch();
  // settings.json may list one matcher twice under an event, and a matcher-less group reads as ''
  const groups = [
    { matcher: "Bash", hooks: [{ command: "/h/guard.sh", type: "command", timeout: 5 }] },
    { matcher: "Bash", hooks: [{ command: "/h/audit.sh", type: "command", timeout: null }] },
    { matcher: "", hooks: [{ command: "/h/any-a.sh", type: "command", timeout: null }] },
    { matcher: "", hooks: [{ command: "/h/any-b.sh", type: "command", timeout: null }] },
  ];
  const state = { status: "ready", data: { source_path: "/s/settings.json", source_mtime: null, events: [{ event: "PreToolUse", groups }] } };

  const tree = renderScreen(mod.React.createElement(mod.HookChainDetail, { state }));
  const keys = findNodes(tree, (n) => n.type === "li" && /\barch-hook-group\b/.test(String(n.props.className))).map((n) => n.props.key);
  assert.equal(keys.length, groups.length, "precondition: each matcher group renders one list item");
  assert.equal(new Set(keys).size, keys.length, `sibling group keys collide, so React drops or merges rows: ${JSON.stringify(keys)}`);
});

test("a part's Open box action carries the bordered button style, not the borderless ghost", async () => {
  const mod = await loadArch();
  const nodeIndex = new Map([["canonical.cron", { id: "canonical.cron", label: "Scheduled background jobs" }]]);
  const row = { id: "cron", name: "cron", tone: "crit", statusLabel: "Overdue", nodeIds: ["cron"], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null };
  const freshness = { at: null, regions: [], now: Date.now() };

  const tree = renderScreen(mod.React.createElement(mod.PartHealthRowAR, { row, freshness, nodeIndex, onSelectNode: () => {} }));
  const [action] = findNodes(tree, (n) => n.type === "button");
  assert.match(String(action.props.className), /\bbtn\b/);
  assert.doesNotMatch(String(action.props.className), /\bghost\b/, "a ghost button draws no border");
});

// A part's verdict word sits at the meta step, where warn/ok/info text falls below 4.5:1 — the tone rides a glyph beside it.
test("a part's health verdict carries its tone on a tone-shaped glyph, its word staying neutral", async (t) => {
  const mod = await loadArch();
  const now = Date.now();
  const freshness = { at: new Date(now).toISOString(), regions: [], now };
  const toneIcon = realUi.TONE_ICON as Record<string, string>;
  const rows = [
    { name: "crit", tone: "crit", statusLabel: "Overdue", textClass: "text-dim" },
    { name: "warn", tone: "warn", statusLabel: "Late", textClass: "text-dim" },
    { name: "info", tone: "info", statusLabel: "Idle", textClass: "text-dim" },
    { name: "ok", tone: "ok", statusLabel: "Healthy", textClass: "text-dim" },
    { name: "no verdict yet", tone: null, statusLabel: "Not loaded", textClass: "text-faint" },
  ];
  for (const row of rows) {
    await t.test(row.name, () => {
      const part = { id: "cron", name: "cron", tone: row.tone, statusLabel: row.statusLabel, nodeIds: [], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null };
      const tree = renderScreen(mod.React.createElement(mod.PartHealthRowAR, { row: part, freshness, nodeIndex: new Map(), onSelectNode: () => {} }));
      const [status] = findNodes(tree, (n) => n.type === "span" && collectText(n).includes(row.statusLabel));
      const glyphs = findNodes(status, (n) => n.props.atom === "Icon");
      const classes = String(status.props.className).split(/\s+/);

      assert.ok(classes.includes(row.textClass), `the ${row.name} verdict word reads ${row.textClass}`);
      assert.deepEqual(classes.filter((c) => /^text-(ok|warn|crit|info)$/.test(c)), [], `the ${row.name} verdict word carries no tone`);
      if (!row.tone) return assert.equal(glyphs.length, 0, "a part with no verdict shows no tone glyph");
      assert.equal(glyphs.length, 1, `the ${row.name} verdict leads with one glyph`);
      assert.equal(glyphs[0].props.name, toneIcon[row.tone], `the ${row.name} glyph takes its tone's shape`);
      assert.match(String(glyphs[0].props.className), new RegExp(`\\btext-${row.tone}\\b`), `the ${row.name} glyph carries the tone`);
    });
  }
});

// The row keeps its alert role and its data hooks; the shared AlertCard owns the look, tone riding its glyph well only.
test("an alarm row is a bare alert wrapper around one inset AlertCard that leaves the announcing to it", async () => {
  const mod = await loadArch();
  const row = { key: "live-overlay", tone: "crit", title: "Couldn't load the live overlay", note: "The live endpoint did not answer.", detail: "ECONNREFUSED", badges: ["daemon"], retry: true };
  const onRetry = () => {};

  const tree = renderScreen(mod.React.createElement(mod.AlarmRowAR, { row, onRetry }));
  const [wrapper] = findNodes(tree, (n) => n.props.role === "alert");
  const cards = findNodes(tree, (n) => n.props.atom === "AlertCard");

  assert.ok(wrapper, "the row declares the alert role");
  assert.equal(wrapper.props["data-alarm"], "live-overlay");
  assert.equal(wrapper.props["data-alarm-tone"], "crit");
  assert.equal(String(wrapper.props.className), "arch-alarm-row", "the wrapper draws no tint, border or padding of its own");
  assert.equal(wrapper.props.style, undefined, "the wrapper paints no tone fill");
  assert.equal(cards.length, 1, "one shared alert card renders the row");
  const card = cards[0].props;
  assert.deepEqual(
    { tone: card.tone, surface: card.surface, hasLiveHost: card.hasLiveHost, title: card.title, body: card.body, details: card.details, subjects: card.subjects },
    { tone: "crit", surface: "inset", hasLiveHost: true, title: row.title, body: row.note, details: row.detail, subjects: row.badges },
  );
  assert.equal(findNodes(renderScreen(card.actions), (n) => n.type === "button" && n.props.onClick === onRetry).length, 1, "the row's Retry rides the card's actions");
});
