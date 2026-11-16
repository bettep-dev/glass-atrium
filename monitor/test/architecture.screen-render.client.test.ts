// Element-tree behaviour tests for the System map screen, run on the shipped JSX through test/lib/render-screen.ts.
//
// Runner: npx tsx --test test/architecture.screen-render.client.test.ts

import test, { describe } from "node:test";
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

// one Part health list: flagged parts first, then every part not judged healthy; healthy parts fold under their count
describe("Part health is one list, healthy parts folded under a count", () => {
  const part = (id: string, tone: string | null, statusLabel: string) =>
    ({ id, name: `${id}-part`, kind: "unknown-kind", daemonName: null, tone, statusLabel, nodeIds: [], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null });
  const render = async (partRows: ReturnType<typeof part>[]) => {
    const mod = await loadArch();
    const props = { partRows, attentionEmpty: "No part needs attention", freshness: null, nodeIndex: new Map(), onSelectNode: () => {} };
    const tree = renderScreen(mod.React.createElement(mod.PartHealthBlockAR, props));
    const [fold] = findNodes(tree, (n) => n.type === "details");
    const rowIds = (root: unknown) => findNodes(root as ReturnType<typeof renderScreen>, (n) => n.type === "li").map((n) => String(n.props.id));
    const foldIds = fold ? rowIds(fold) : [];
    return { tree, fold, shownIds: rowIds(tree).filter((id) => !foldIds.includes(id)), foldIds };
  };
  const rows = [
    { name: "a mixed read", parts: [part("ok1", "ok", "Healthy"), part("info", "info", "Idle"), part("crit", "crit", "Overdue"), part("cold", null, "Not loaded"), part("ok2", "ok", "Healthy"), part("warn", "warn", "Late")], shown: ["crit", "warn", "cold", "info"], folded: ["ok1", "ok2"], isAllClear: false },
    { name: "a read with nothing flagged", parts: [part("ok1", "ok", "Healthy"), part("cold", null, "Not loaded")], shown: ["cold"], folded: ["ok1"], isAllClear: true },
    { name: "a read with no healthy part", parts: [part("crit", "crit", "Overdue"), part("cold", null, "Not loaded")], shown: ["crit", "cold"], folded: [], isAllClear: false },
  ];
  for (const row of rows)
    test(row.name, async () => {
      const r = await render(row.parts);
      assert.deepEqual(r.shownIds.map((id) => id.replace(/^arch-part-/, "")), row.shown, "shown parts, flagged worst first");
      assert.deepEqual(r.foldIds.map((id) => id.replace(/^arch-part-/, "")).sort(), row.folded.sort(), "healthy parts sit inside the fold");
      if (row.folded.length) assert.match(collectText(findNodes(r.fold, (n) => n.type === "summary")[0]).trim(), new RegExp(`^${row.folded.length} healthy$`), "the fold names its count");
      else assert.equal(r.fold, undefined, "no fold without a healthy part");
      assert.equal(findNodes(r.tree, (n) => n.type === "h3").length, 0, "no column title splits the list");
      assert.equal(collectText(r.tree).includes("No part needs attention"), row.isAllClear, "the all-clear line shows exactly when nothing is flagged");
    });
});

// the head Status is the page's in-page alarm → the shared head Status atom, the one Learning's head draws
test("the Part health head Status is the shared head Status atom in the worst part's tone", async () => {
  const mod = await loadArch();
  const flagged = { id: "crit", name: "crit-part", kind: "unknown-kind", daemonName: null, tone: "crit", statusLabel: "Overdue", nodeIds: [], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null };
  const props = { partRows: [flagged], attentionEmpty: "No part needs attention", freshness: null, nodeIndex: new Map(), onSelectNode: () => {} };
  const tree = renderScreen(mod.React.createElement(mod.PartHealthBlockAR, props));
  const statuses = findNodes(tree, (n) => n.props.atom === "HeadStatus");

  assert.equal(statuses.length, 1, "the head draws one shared Status");
  assert.equal(statuses[0].props.tone, "crit");
  assert.equal(findNodes(tree, (n) => n.props.atom === "Icon").length, 0, "no hand-drawn glyph beside it");
});

// the fold's summary already says healthy — a folded row adds a status word only when its verdict says more than that
describe("a folded Part health row shows its status only when it says more than the fold's count", () => {
  const now = Date.now();
  const readAt = new Date(now - 5 * 60_000).toISOString();
  const part = (id: string, tone: string, statusLabel: string) =>
    ({ id, name: `${id}-part`, kind: "unknown-kind", daemonName: null, tone, statusLabel, nodeIds: [], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null });
  const statusTexts = (root: unknown) =>
    findNodes(root as ReturnType<typeof renderScreen>, (n) => n.type === "span" && /\barch-part-status\b/.test(String(n.props.className))).map((n) => collectText(n).trim());
  const rows = [
    { name: "a fresh read drops the Healthy the fold's count already says", freshness: { at: readAt, regions: [], now }, folded: [] },
    { name: "a held read keeps Last known on every folded row", freshness: { at: readAt, failed: true, regions: [], now }, folded: ["Last known", "Last known"] },
  ];
  for (const row of rows)
    test(row.name, async () => {
      const mod = await loadArch();
      const partRows = [part("ok1", "ok", "Healthy"), part("crit", "crit", "Overdue"), part("ok2", "ok", "Healthy")];
      const props = { partRows, attentionEmpty: "No part needs attention", freshness: row.freshness, nodeIndex: new Map(), onSelectNode: () => {} };
      const tree = renderScreen(mod.React.createElement(mod.PartHealthBlockAR, props));
      const [fold] = findNodes(tree, (n) => n.type === "details");

      assert.deepEqual(statusTexts(fold), row.folded, "a folded row's status atom");
      assert.equal(statusTexts(tree).length - statusTexts(fold).length, 1, "the listed flagged row keeps its status");
    });
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

// drawer sections read as titles, not as mono captions; the drawer's prose is sans and no mark keys a colour nothing explains
test("the node drawer titles its sections at the title step in sans and writes its prose without a colour key", async () => {
  const mod = await loadArch();
  const nodeId = "canonical.hook_pipeline";
  const props = {
    info: { id: nodeId, label: "Hook pipeline", path: "hooks/", description: "Hooks" },
    flows: [{ id: "f1", from: "canonical.agent_layer", to: nodeId, edge_type: "data" }],
    nodeIndex: new Map([["canonical.agent_layer", { label: "Agents" }]]),
    liveDaemonsByNodeId: new Map(),
    healthPartRows: [{ id: "hooks", name: "Hook failures", kind: "unknown-kind", daemonName: null, tone: "ok", statusLabel: "Healthy", nodeIds: ["hook_pipeline", "agent_layer"] }],
    zoneIdByMemberId: new Map(),
  };

  const tree = renderScreen(mod.React.createElement(mod.NodeDetailBody, props));
  const css = findNodes(renderScreen(mod.React.createElement(mod.ScreenArchitecture, {})), (n) => n.type === "style").map(collectText).join(" ");
  const headings = findNodes(tree, (n) => n.type === "h3");
  const [alsoLights] = findNodes(tree, (n) => n.type === "div" && collectText(n).startsWith("Also lights"));
  const [flowList] = findNodes(tree, (n) => n.type === "ul" && collectText(n).includes("Agents"));
  const [heading] = getRuleBodies(css, "arch-drawer-heading");

  assert.equal(headings.length, 3, "Health, Connections and Records each have a section heading");
  for (const h of headings)
    assert.deepEqual(String(h.props.className).split(/\s+/).filter((c) => /^(font-mono|uppercase|tracking-\w+|fs-meta|text-faint)$/.test(c)), [], `${collectText(h)} drops the caption look`);
  assert.equal(getRuleFontPx(css, "arch-drawer-heading"), 16, "a drawer section title sits at the title step");
  assert.match(heading ?? "", /font-weight:\s*600/, "a drawer section title is semibold");
  assert.doesNotMatch(String(alsoLights?.props.className), /\bfont-mono\b/, "the Also lights line is prose");
  assert.deepEqual(findNodes(flowList, (n) => Object.hasOwn(Object(n.props.style), "color")).map(collectText), [], "no connection carries a colour dot");
});

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
    { name: "drawer section", upper: "arch-drawer-heading", lower: "arch-drawer-subheading" },
  ];
  for (const ladder of ladders)
    assert.ok(getRuleFontPx(css, ladder.upper) >= getRuleFontPx(css, ladder.lower), `${ladder.name}: the lower heading outsizes the one above it`);
});

// a rule body for one class in the screen's style block — every match, so a class defined twice shows up as two
function getRuleBodies(css: string, className: string): string[] {
  return [...css.matchAll(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
}

test("the Part health title is no smaller than the row text under it", async () => {
  const mod = await loadArch();
  const tree = renderScreen(mod.React.createElement(mod.ScreenArchitecture, {}));
  const css = findNodes(tree, (n) => n.type === "style").map(collectText).join(" ");
  assert.ok(getRuleFontPx(css, "arch-part-health-title") >= getRuleFontPx(css, "arch-part-row"), "the Part health rows outsize the card title");
});

test("the Part health list and the drawer's part list each own one rule, so their gaps never cross-apply", async () => {
  const mod = await loadArch();
  const tree = renderScreen(mod.React.createElement(mod.ScreenArchitecture, {}));
  const css = findNodes(tree, (n) => n.type === "style").map(collectText).join(" ");
  assert.equal(getRuleBodies(css, "arch-part-list").length, 1, "the Part health list is defined once");
  assert.equal(getRuleBodies(css, "arch-drawer-part-list").length, 1, "the drawer's part list is defined once");
});

test("a Part health row keeps the name and the status on one line each", async () => {
  const mod = await loadArch();
  const tree = renderScreen(mod.React.createElement(mod.ScreenArchitecture, {}));
  const css = findNodes(tree, (n) => n.type === "style").map(collectText).join(" ");
  const [name] = getRuleBodies(css, "arch-part-name");
  const [status] = getRuleBodies(css, "arch-part-status");
  assert.match(name ?? "", /white-space:\s*nowrap/, "the part name stays on one line");
  assert.match(name ?? "", /text-overflow:\s*ellipsis/, "a long part name ends in an ellipsis");
  assert.match(status ?? "", /display:\s*inline-flex/, "the glyph and the verdict word are one inline atom");
  assert.match(status ?? "", /white-space:\s*nowrap/, "the verdict word never wraps under its glyph");

  const nodeIndex = new Map([["canonical.cron", { id: "canonical.cron", label: "Scheduled background jobs" }]]);
  const row = { id: "cron", name: "cron-scheduler", tone: "ok", statusLabel: "Healthy", nodeIds: ["cron"], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null };
  const freshness = { at: new Date().toISOString(), regions: [], now: Date.now() };
  const rowTree = renderScreen(mod.React.createElement(mod.PartHealthRowAR, { row, freshness, nodeIndex, onSelectNode: () => {} }));
  const [nameEl] = findNodes(rowTree, (n) => /\barch-part-name\b/.test(String(n.props.className)));
  assert.equal(nameEl?.props.title, "cron-scheduler", "a truncated name keeps its full text in title");
});

test("a flagged Part health row reads its status right after the name and its cause on the same line, never in the meta line", async () => {
  const mod = await loadArch();
  const nodeIndex = new Map([["canonical.cron", { id: "canonical.cron", label: "Scheduled background jobs" }]]);
  const row = { id: "cron", name: "cron-scheduler", tone: "crit", statusLabel: "Overdue", nodeIds: ["cron"], lastRunAt: null, nextRunAt: null, cadenceMinutes: 60, cause: "exit 1 at the last run" };
  const tree = renderScreen(mod.React.createElement(mod.PartHealthRowAR, { row, freshness: { at: null, regions: [], now: Date.now() }, nodeIndex, onSelectNode: () => {} }));
  const [line] = findNodes(tree, (n) => /\barch-part-line\b/.test(String(n.props.className)));
  const [meta] = findNodes(tree, (n) => /\barch-part-meta\b/.test(String(n.props.className)));
  const parts = ((line?.children ?? []) as { props?: { className?: unknown } }[]).filter((c) => c && typeof c === "object").map((c) => String(c.props?.className).split(/\s+/)[0]);

  assert.deepEqual(parts, ["arch-part-name", "arch-part-status", "arch-part-cause"], "one line: name, then its status, then its cause");
  assert.ok(meta, "precondition: the row keeps a meta line");
  assert.doesNotMatch(collectText(meta), /exit 1/, "the cause is not repeated in the meta line");
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

test("a part's Open box action is the quiet ghost button, so a list of parts carries no column of bordered buttons", async () => {
  const mod = await loadArch();
  const nodeIndex = new Map([["canonical.cron", { id: "canonical.cron", label: "Scheduled background jobs" }]]);
  const row = { id: "cron", name: "cron", tone: "crit", statusLabel: "Overdue", nodeIds: ["cron"], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null };
  const freshness = { at: null, regions: [], now: Date.now() };

  const tree = renderScreen(mod.React.createElement(mod.PartHealthRowAR, { row, freshness, nodeIndex, onSelectNode: () => {} }));
  const [action] = findNodes(tree, (n) => n.type === "button");
  assert.match(String(action.props.className), /\bbtn\b/);
  assert.match(String(action.props.className), /\bghost\b/, "the row action takes the quiet tier");
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
      const [status] = findNodes(tree, (n) => n.type === "span" && /\barch-part-status\b/.test(String(n.props.className)) && collectText(n).includes(row.statusLabel));
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

// The row keeps its alert role and its data hooks; the shared AlertCard owns the look, tone riding its bare glyph only.
test("an alarm row is a bare alert wrapper around one page-level AlertCard that leaves the announcing to it", async () => {
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
    { tone: card.tone, hasLiveHost: card.hasLiveHost, title: card.title, body: card.body, details: card.details, subjects: card.subjects },
    { tone: "crit", hasLiveHost: true, title: row.title, body: row.note, details: row.detail, subjects: row.badges },
  );
  assert.notEqual(card.surface, "inset", "the lane sits on the page, not inside a card");
  assert.equal(findNodes(renderScreen(card.actions), (n) => n.type === "button" && n.props.onClick === onRetry).length, 1, "the row's Retry rides the card's actions");
});
