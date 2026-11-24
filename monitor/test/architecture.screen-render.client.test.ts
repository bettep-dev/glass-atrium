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

// a row's status as drawn: the plain word's span, or the stubbed status atom's host — never the component node wrapping it
function isStatusHost(node: { type: string }): boolean {
  return node.type === "span" || node.type === "ui-atom";
}

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

test("a cold map Retry keeps the map's failure card in place with a focus target that outlives recovery", async () => {
  const mod = (await loadScreenModule(ARCH_SRC, {
    UI: uiStub({ INITIAL_REGION_STATE: getColdRetryState() }),
    React: createReactStub(),
  })) as { React: { createElement: (t: unknown, p: unknown) => unknown }; ScreenArchitecture: Component };

  const tree = renderScreen(mod.React.createElement(mod.ScreenArchitecture, {}));
  const cards = findNodes(tree, (n) => n.props.atom === "RegionFailure" && /\barch-col-card\b/.test(String(n.props.className)));
  assert.equal(cards.length, 1, "the map slot stays a failure card during its Retry instead of collapsing to a loader");
  const targetId = cards[0].props.focusTargetId;
  const targets = findNodes(tree, (n) => /^[a-z]/.test(n.type) && n.props.atom === undefined && n.props.id === targetId);
  assert.equal(targets.length, 1, `focus target ${String(targetId)} is one host element`);
  assert.equal(findNodes(targets[0], (n) => n === cards[0]).length, 1, "the target wraps the card, so it outlives the error-to-map swap");
});

// one System parts list: flagged parts first, then every part not judged healthy; healthy parts fold under their count
describe("System parts is one list, healthy parts folded under a count", () => {
  const part = (id: string, tone: string | null, statusLabel: string) =>
    ({ id, name: `${id}-part`, kind: "unknown-kind", daemonName: null, tone, statusLabel, nodeIds: [], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null });
  const render = async (partRows: ReturnType<typeof part>[]) => {
    const mod = await loadArch();
    const props = { partRows, attentionEmpty: "No system part needs attention", freshness: null, nodeIndex: new Map(), onSelectNode: () => {} };
    const tree = renderScreen(mod.React.createElement(mod.PartHealthBlockAR, props));
    const [fold] = findNodes(tree, (n) => n.type === "details");
    const rowIds = (root: unknown) => findNodes(root as ReturnType<typeof renderScreen>, (n) => n.type === "li").map((n) => String(n.props.id));
    const foldIds = fold ? rowIds(fold) : [];
    return { tree, fold, shownIds: rowIds(tree).filter((id) => !foldIds.includes(id)), foldIds };
  };
  const rows = [
    { name: "a mixed read", parts: [part("ok1", "ok", "Healthy"), part("info", "info", "Idle"), part("crit", "crit", "Overdue"), part("cold", null, "Not loaded"), part("ok2", "ok", "Healthy"), part("warn", "warn", "Late")], shown: ["crit", "warn", "cold", "info"], folded: ["ok1", "ok2"], foldText: "2 system parts healthy", isAllClear: false },
    { name: "a read with nothing flagged", parts: [part("ok1", "ok", "Healthy"), part("cold", null, "Not loaded")], shown: ["cold"], folded: ["ok1"], foldText: "1 system part healthy", isAllClear: true },
    { name: "a read with no healthy part", parts: [part("crit", "crit", "Overdue"), part("cold", null, "Not loaded")], shown: ["crit", "cold"], folded: [], foldText: null, isAllClear: false },
  ];
  for (const row of rows)
    test(row.name, async () => {
      const r = await render(row.parts);
      assert.deepEqual(r.shownIds.map((id) => id.replace(/^arch-part-/, "")), row.shown, "shown parts, flagged worst first");
      assert.deepEqual(r.foldIds.map((id) => id.replace(/^arch-part-/, "")).sort(), row.folded.sort(), "healthy parts sit inside the fold");
      if (row.folded.length) assert.equal(collectText(findNodes(r.fold, (n) => n.type === "summary")[0]).trim(), row.foldText, "the fold names its count with the shared noun");
      else assert.equal(r.fold, undefined, "no fold without a healthy part");
      assert.equal(findNodes(r.tree, (n) => n.type === "h3").length, 0, "no column title splits the list");
      assert.equal(collectText(r.tree).includes("No system part needs attention"), row.isAllClear, "the all-clear line shows exactly when nothing is flagged");
    });
});

// the head Status is the page's in-page alarm → the shared head Status atom, the one Learning's head draws
test("the System parts head Status is the shared head Status atom in the worst part's tone", async () => {
  const mod = await loadArch();
  const flagged = { id: "crit", name: "crit-part", kind: "unknown-kind", daemonName: null, tone: "crit", statusLabel: "Overdue", nodeIds: [], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null };
  const props = { partRows: [flagged], attentionEmpty: "No system part needs attention", freshness: null, nodeIndex: new Map(), onSelectNode: () => {} };
  const tree = renderScreen(mod.React.createElement(mod.PartHealthBlockAR, props));
  const statuses = findNodes(tree, (n) => n.props.atom === "HeadStatus");

  assert.equal(statuses.length, 1, "the head draws one shared Status");
  assert.equal(statuses[0].props.tone, "crit");
  assert.equal(findNodes(tree, (n) => n.props.atom === "Icon").length, 0, "no hand-drawn glyph beside it");
});

// the card takes the noun the Dashboard stat uses for the same watched parts (spec 44084 §9.4)
test("the card is titled System parts, the Dashboard's noun for the watched parts", async () => {
  const mod = await loadArch();
  const flagged = { id: "crit", name: "crit-part", kind: "unknown-kind", daemonName: null, tone: "crit", statusLabel: "Overdue", nodeIds: [], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null };
  const props = { partRows: [flagged], attentionEmpty: "No system part needs attention", freshness: null, nodeIndex: new Map(), onSelectNode: () => {} };
  const tree = renderScreen(mod.React.createElement(mod.PartHealthBlockAR, props));

  assert.deepEqual(findNodes(tree, (n) => n.type === "h2").map((n) => collectText(n).trim()), ["System parts"]);
});

// the fold's summary already says healthy — a folded row adds a status word only when its verdict says more than that
describe("a folded System parts row shows its status only when it says more than the fold's count", () => {
  const now = Date.now();
  const readAt = new Date(now - 5 * 60_000).toISOString();
  const part = (id: string, tone: string, statusLabel: string) =>
    ({ id, name: `${id}-part`, kind: "unknown-kind", daemonName: null, tone, statusLabel, nodeIds: [], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null });
  const statusTexts = (root: unknown) =>
    findNodes(root as ReturnType<typeof renderScreen>, (n) => isStatusHost(n) && /\barch-part-status\b/.test(String(n.props.className))).map((n) => collectText(n).trim());
  const rows = [
    { name: "a fresh read drops the Healthy the fold's count already says", freshness: { at: readAt, regions: [], now }, folded: [] },
    { name: "a held read keeps Last known on every folded row", freshness: { at: readAt, failed: true, regions: [], now }, folded: ["Last known", "Last known"] },
  ];
  for (const row of rows)
    test(row.name, async () => {
      const mod = await loadArch();
      const partRows = [part("ok1", "ok", "Healthy"), part("crit", "crit", "Overdue"), part("ok2", "ok", "Healthy")];
      const props = { partRows, attentionEmpty: "No system part needs attention", freshness: row.freshness, nodeIndex: new Map(), onSelectNode: () => {} };
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

test("the node drawer stacks the prose Description above its label's edge and keeps the file path on one row", async () => {
  const mod = (await loadScreenModule(ARCH_SRC, { UI: uiStub({}), React: createReactStub() })) as {
    React: { createElement: (t: unknown, p: unknown) => unknown };
    NodeDetailBody: Component;
  };
  const props = {
    info: { id: "canonical.wiki_d", label: "Wiki daemon", path: "wiki/", description: "Compiles fetched sources into notes." },
    flows: [], nodeIndex: new Map(), liveDaemonsByNodeId: new Map(), healthPartRows: [], zoneIdByMemberId: new Map(),
  };

  const tree = renderScreen(mod.React.createElement(mod.NodeDetailBody, props));
  const fields = findNodes(tree, (n) => n.props.atom === "DetailField");
  const isStackedByLabel = Object.fromEntries(fields.map((n) => [n.props.label, Boolean(n.props.isStacked)]));
  assert.deepEqual(isStackedByLabel, { "File path": false, Description: true });
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
  const headings = findNodes(tree, (n) => n.type === "h3");
  const [alsoLights] = findNodes(tree, (n) => n.type === "div" && collectText(n).startsWith("Also lights"));
  const [flowList] = findNodes(tree, (n) => n.type === "ul" && collectText(n).includes("Agents"));

  assert.equal(headings.length, 3, "Health, Connections and Records each have a section heading");
  for (const h of headings)
    assert.deepEqual(String(h.props.className).split(/\s+/).filter((c) => /^(font-mono|uppercase|tracking-\w+|fs-meta|text-faint)$/.test(c)), [], `${collectText(h)} drops the caption look`);
  for (const h of headings) {
    assert.equal(getClassFontPx(h), 16, `${collectText(h)} sits at the title step`);
    assert.match(String(h.props.className), /\bfont-semibold\b/, `${collectText(h)} is semibold`);
  }
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
    assert.match(String(slot.region.props.className), /\barch-main-undrawn\b/, "an undrawn map region is marked so the page-tall floor lets go of it");
});

// one failure shape on the page: the alarm card with Retry at its row end, as a held map's failure and parts-failed draw it
test("a map failure no other surface speaks for draws the alarm card in the map slot, sized to the card", async () => {
  const mod = await loadArch();
  const down = { status: "error", data: null, error: "HTTP 503 Service Unavailable — down", busy: false };
  const onRetry = () => {};
  const tree = renderScreen(mod.React.createElement(mod.MapRegionAR, { diagState: down, pageFailure: null, isBusy: false, onRetry, isEmpty: false }));
  const [region] = findNodes(tree, (n) => n.props.id === "arch-map-region");
  const cards = findNodes(region, (n) => n.props.atom === "PageErrorBanner");

  assert.equal(cards.length, 1, "one alarm card in the map slot");
  assert.equal(cards[0].props.onRetry, onRetry, "the card carries the map's Retry");
  assert.equal(cards[0].props.focusTargetId, "arch-map-region", "recovery focus lands on the region that outlives the card");
  assert.equal(findNodes(region, (n) => n.props.atom === "RegionFailure").length, 0, "no bare failure block on the page ground");
  assert.match(String(region.props.className), /\barch-main-undrawn\b/, "the slot lets go of the page-tall floor and ends at the card");
});

describe("the map card ends at its content when there is nothing to draw", () => {
  const ready = { status: "ready", data: { diagrams: [] }, error: null, busy: false };
  const rows = [
    { name: "a map with nothing to draw", isEmpty: true, isUndrawn: true },
    { name: "a drawn map", isEmpty: false, isUndrawn: false },
  ];
  for (const row of rows)
    test(row.name, async () => {
      const mod = await loadArch();
      const tree = renderScreen(mod.React.createElement(mod.MapRegionAR, { diagState: ready, pageFailure: null, isBusy: false, onRetry: () => {}, isEmpty: row.isEmpty }));
      const [region] = findNodes(tree, (n) => n.props.id === "arch-map-region");

      assert.equal(/\barch-main-undrawn\b/.test(String(region.props.className)), row.isUndrawn);
    });
});

test("a diagram with no source says so without naming the field", async () => {
  const mod = await loadArch();
  const diagState = { status: "ready", data: { diagrams: [] }, error: null, busy: false };
  const tree = renderScreen(mod.React.createElement(mod.DiagramBody, { diagState, activeDiagram: { id: "canonical", mermaid_source: "  " } }));

  assert.deepEqual(findNodes(tree, (n) => n.props.atom === "EmptyState").map((n) => n.props.message), ["This diagram has no source."]);
});

// §12.5: the six-key legend keeps its place under the h1 whatever the map read did
describe("the legend stays under the heading before the map is drawn", () => {
  const down = { status: "error", data: null, error: "HTTP 503 Service Unavailable — down", busy: false };
  const rows = [
    { name: "while the first read is in flight", overrides: {} },
    { name: "after the map read failed", overrides: { INITIAL_REGION_STATE: down } },
  ];
  for (const row of rows)
    test(row.name, async () => {
      const mod = await loadArch(row.overrides);
      const tree = renderScreen(mod.React.createElement(mod.ScreenArchitecture, {}));

      assert.equal(findNodes(tree, (n) => n.type === "ul" && /\barch-legend\b/.test(String(n.props.className))).length, 1);
    });
});

// the caption's last line is one slot: the health load note while pending, the open-a-box hint once settled — the map below never moves
describe("the caption's last line carries the health load note in the hint's place", () => {
  const rows = [
    { name: "while health is pending", healthPending: true, status: "Loading health…", hint: [] },
    { name: "once health has settled", healthPending: false, status: "", hint: ["Click a box for details"] },
  ];
  for (const row of rows)
    test(row.name, async () => {
      const mod = await loadArch();
      const tree = renderScreen(mod.React.createElement(mod.MapCaptionAR, { healthPending: row.healthPending }));
      const lines = findNodes(tree, (n) => n.type === "p");
      const [status] = findNodes(tree, (n) => n.props.role === "status");
      const hint = findNodes(lines[0], (n) => n.type === "span" && n.props["aria-hidden"] === "true").map((n) => collectText(n));

      assert.equal(lines.length, 1, "one caption line in either state, so the caption keeps its height");
      assert.equal(findNodes(lines[0], (n) => n.props.role === "status").length, 1, "the live region sits in that line");
      assert.equal(collectText(status), row.status);
      assert.deepEqual(hint, row.hint);
    });
});

// a daemon row reads one way wherever it comes from: its id through MachineString, a bare glyph and word, no chip
test("the node drawer draws every daemon row's status as a bare glyph and word", async () => {
  const mod = await loadArch();
  const partRows = [{ id: "daemon-cycle", name: "autoagent", kind: "daemon", daemonName: "autoagent", nodeIds: ["hook_pipeline"], tone: "ok", statusLabel: "Healthy", lastRunAt: null }];
  const daemons = [{ daemon_name: "learning-aggregator", effective_status: "ok", last_run_at: null }];
  const tree = renderScreen(mod.React.createElement(mod.NodePartHealth, {
    nodeId: "canonical.hook_pipeline", partRows, daemons, payloadDaemon: null, onSelectDaemon: () => {},
    payloadState: null, hookState: null, hookFailState: null, unpricedModelState: null,
  }));

  assert.equal(findNodes(tree, (n) => n.props.atom === "Badge").length, 0, "no filled chip");
  assert.deepEqual(findNodes(tree, (n) => n.props.atom === "StatusDot").map((n) => n.props.status), ["ok", "ok"], "one bare glyph per daemon row");
  assert.deepEqual(findNodes(tree, (n) => n.props.atom === "MachineString").map((n) => collectText(n).trim()), ["autoagent", "learning-aggregator"]);
});

// font-size a page rule sets for one class, in px — tokens resolved from the shipped tokens.css
// an element's size through its type-scale class: fs-<step> → the --fs-<step> token's px
function getClassFontPx(node: { props: { className?: unknown } } | undefined): number {
  const tokens = readFileSync(resolve(__dirname, "../public/styles/tokens.css"), "utf8");
  const step = /(?:^|\s)fs-([a-z]+)(?=\s|$)/.exec(String(node?.props.className))?.[1];
  const px = step ? new RegExp(`--fs-${step}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(tokens)?.[1] : undefined;
  assert.ok(px, `'${String(node?.props.className)}' sets its size through a type-scale class`);
  return Number(px);
}

test("every heading on the page and in the drawer is no larger than the heading it sits under", async () => {
  const mod = await loadArch();
  const flows = [{ id: "f1", from: "canonical.agent_layer", to: "canonical.hook_pipeline", edge_type: "data" }];
  const tree = renderScreen(mod.React.createElement(mod.FlowSummary, { inbound: flows, outbound: [], nodeIndex: new Map() }));
  const [upper] = findNodes(tree, (n) => n.type === "h3");
  const [lower] = findNodes(tree, (n) => n.type === "h4");
  assert.ok(getClassFontPx(upper) >= getClassFontPx(lower), "drawer section: the lower heading outsizes the one above it");
});

// a rule body for one class in the screen's style block — every match, so a class defined twice shows up as two
function getRuleBodies(css: string, className: string): string[] {
  return [...css.matchAll(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
}

test("the System parts title is no smaller than the row text under it", async () => {
  const mod = await loadArch();
  const partRows = [{ id: "cron", name: "cron-scheduler", kind: "unknown-kind", daemonName: null, tone: "crit", statusLabel: "Overdue", nodeIds: [], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null }];
  const props = { partRows, attentionEmpty: "", freshness: { at: null, regions: [], now: Date.now() }, nodeIndex: new Map(), onSelectNode: () => {} };
  const tree = renderScreen(mod.React.createElement(mod.PartHealthBlockAR, props));
  const [title] = findNodes(tree, (n) => n.type === "h2");
  const [row] = findNodes(tree, (n) => /\barch-part-row\b/.test(String(n.props.className)));
  assert.ok(getClassFontPx(title) >= getClassFontPx(row), "the System parts rows outsize the card title");
});

test("the System parts list is defined once, so its gap never cross-applies to the drawer's part list", async () => {
  const mod = await loadArch();
  const tree = renderScreen(mod.React.createElement(mod.ScreenArchitecture, {}));
  const css = findNodes(tree, (n) => n.type === "style").map(collectText).join(" ");
  assert.equal(getRuleBodies(css, "arch-part-list").length, 1, "the System parts list is defined once");
  assert.equal(getRuleBodies(css, "arch-drawer-part-list").length, 0, "the drawer's part list takes its spacing from its Stack alone");
});

test("a System parts row keeps the name and the status on one line each", async () => {
  const mod = await loadArch();
  const tree = renderScreen(mod.React.createElement(mod.ScreenArchitecture, {}));
  const css = findNodes(tree, (n) => n.type === "style").map(collectText).join(" ");
  const [name] = getRuleBodies(css, "arch-part-name");
  assert.match(name ?? "", /white-space:\s*nowrap/, "the part name stays on one line");
  assert.match(name ?? "", /text-overflow:\s*ellipsis/, "a long part name ends in an ellipsis");

  const nodeIndex = new Map([["canonical.cron", { id: "canonical.cron", label: "Scheduled background jobs" }]]);
  const row = { id: "cron", name: "cron-scheduler", tone: "ok", statusLabel: "Healthy", nodeIds: ["cron"], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null };
  const freshness = { at: new Date().toISOString(), regions: [], now: Date.now() };
  const rowTree = renderScreen(mod.React.createElement(mod.PartHealthRowAR, { row, freshness, nodeIndex, onSelectNode: () => {} }));
  const [nameEl] = findNodes(rowTree, (n) => /\barch-part-name\b/.test(String(n.props.className)));
  const [status] = findNodes(rowTree, (n) => isStatusHost(n) && /\barch-part-status\b/.test(String(n.props.className)));
  assert.equal(nameEl?.props.title, "cron-scheduler", "a truncated name keeps its full text in title");
  assert.equal(status?.props.atom, "HeadStatus", "the glyph and the verdict word are one status atom");
  assert.match(String(status?.props.className), /\bwhitespace-nowrap\b/, "the verdict word never wraps under its glyph");
});

test("a flagged System parts row reads its status right after the name and its cause on the same line, never in the meta line", async () => {
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

test("a System parts row names its map box only when the box label differs from the part name", async () => {
  const mod = await loadArch();
  const nodeIndex = new Map([
    ["canonical.pg_db", { id: "canonical.pg_db", label: "PostgreSQL" }],
    ["canonical.cron", { id: "canonical.cron", label: "Scheduled background jobs" }],
  ]);
  const getMeta = (name: string, nodeId: string) => {
    const row = { id: name, name, tone: "crit", statusLabel: "Down", nodeIds: [nodeId], lastRunAt: new Date().toISOString(), nextRunAt: null, cadenceMinutes: null, cause: null };
    const tree = renderScreen(mod.React.createElement(mod.PartHealthRowAR, { row, freshness: { at: null, regions: [], now: Date.now() }, nodeIndex, onSelectNode: () => {} }));
    const [meta] = findNodes(tree, (n) => /\barch-part-meta\b/.test(String(n.props.className)));
    return collectText(meta);
  };

  assert.doesNotMatch(getMeta("PostgreSQL", "pg_db"), /\bin PostgreSQL\b/, "a box named like its part is not repeated");
  assert.match(getMeta("cron-scheduler", "cron"), /\bin Scheduled background jobs\b/, "a box with its own name is still named");
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

// mono marks text a program wrote that a person copies or matches — times, dates, part names and reason lines stay sans
test("the node drawer draws exactly its machine strings through MachineString", async () => {
  const mod = await loadArch();
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const hookState = {
    status: "ready",
    data: {
      source_path: "/Users/op/.claude/settings.json", source_mtime: ago(48),
      events: [{ event: "PreToolUse", groups: [{ matcher: "Bash|Edit", hooks: [{ command: "hooks/enforce-commit-guard.sh --strict", type: "command", timeout: 10 }] }] }, { event: "SessionStart", groups: [] }],
    },
  };
  const hookFailState = {
    status: "ready",
    data: {
      days: 30, last_failure_ts: ago(3), error_kind_breakdown: [{ error_kind: "db_unavailable", count: 1 }],
      failures: [{ id: 7, failure_ts: ago(3), hook_name: "track-outcome", target_table: "core.outcomes", error_kind: "db_unavailable", payload_ref: "payload spooled to /tmp/ga-spool/outcome-7.json", retry_attempted: true }],
    },
  };
  const unpricedModelState = { status: "ready", data: { models: [{ model: "claude-opus-5-5-20261101", event_count: 3, last_seen_at: ago(5) }] } };
  const payloadState = { status: "ready", data: { daemon: "autoagent", entries: [{ run_date: "2026-11-23", summary: { verdict: "failed", error_signatures: [{ message: "timeout waiting for the grader", count: 2 }] } }] } };
  const partRows = [
    { id: "hook-chain", name: "Hook Chain", kind: "hook", daemonName: null, nodeIds: ["hook_pipeline"], tone: "warn", statusLabel: "Warning", lastRunAt: null },
    { id: "daemon-cycle", name: "autoagent", kind: "daemon", daemonName: "autoagent", nodeIds: ["hook_pipeline"], tone: "ok", statusLabel: "Healthy", lastRunAt: ago(2) },
  ];
  const daemons = [{ daemon_name: "learning-aggregator", effective_status: "ok", last_run_at: ago(3) }];

  const tree = renderScreen(mod.React.createElement(mod.NodePartHealth, {
    nodeId: "canonical.hook_pipeline", partRows, daemons, payloadDaemon: "autoagent", onSelectDaemon: () => {},
    payloadState, hookState, hookFailState, unpricedModelState,
  }));
  const machineStrings = findNodes(tree, (n) => n.props.atom === "MachineString").map((n) => collectText(n).trim());

  assert.deepEqual(machineStrings.sort(), [
    "/Users/op/.claude/settings.json", "Bash|Edit", "PreToolUse", "SessionStart", "claude-opus-5-5-20261101",
    "autoagent", "core.outcomes", "hooks/enforce-commit-guard.sh --strict", "learning-aggregator", "track-outcome",
  ].sort());
});

// §2.2: a value the payload leaves out is a known absence → the word None, never a dash
test("the node drawer reads None for every value its payloads leave out and dates each run in the Day form", async () => {
  const mod = await loadArch();
  const hookState = { status: "ready", data: { events: [{ event: "SessionStart", groups: [] }] } };
  const hookFailState = {
    status: "ready",
    data: { last_failure_ts: null, error_kind_breakdown: [{ error_kind: "db_unavailable", count: 1 }], failures: [{ id: 7, failure_ts: null, error_kind: "db_unavailable" }] },
  };
  const unpricedModelState = { status: "ready", data: { model_count: 0 } };
  const payloadState = {
    status: "ready",
    data: { daemon: "autoagent", entries: [{ run_date: "2026-11-23", summary: { verdict: "failed", error_signatures: [{ count: 2 }] } }, { summary: { verdict: "failed" } }] },
  };
  const partRows = [
    { id: "hook-chain", name: "Hook Chain", kind: "hook", daemonName: null, nodeIds: ["hook_pipeline"], tone: "warn", statusLabel: "Warning", lastRunAt: null },
    { id: "daemon-cycle", name: "autoagent", kind: "daemon", daemonName: "autoagent", nodeIds: ["hook_pipeline"], tone: "ok", statusLabel: "Healthy", lastRunAt: null },
  ];
  const daemons = [{ daemon_name: "learning-aggregator", effective_status: "ok", last_run_at: null }];

  const tree = renderScreen(mod.React.createElement(mod.NodePartHealth, {
    nodeId: "canonical.hook_pipeline", partRows, daemons, payloadDaemon: "autoagent", onSelectDaemon: () => {},
    payloadState, hookState, hookFailState, unpricedModelState,
  }));
  const text = collectText(tree);
  const absent = findNodes(tree, (n) => n.props.atom === "AbsentValue").map((n) => n.props.kind);

  assert.doesNotMatch(text, /—/, `a dash stands for a missing value — read: ${text}`);
  // settings path · failure time · hook name · target table · window days ×2 · reason line · run date · last run ×2
  assert.deepEqual(absent, Array(10).fill("none"), `read: ${text}`);
  assert.match(text, /\b11-23\b/);
  assert.doesNotMatch(text, /2026-11-23/, "a run list inside one window takes the Day form, not the full date");
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

// A part's verdict word sits at the meta step, where warn/ok/info text falls below 4.5:1 — the tone rides the status atom's glyph.
test("a part's health verdict carries its tone on the status atom's glyph, an unjudged word staying faint and glyphless", async (t) => {
  const mod = await loadArch();
  const now = Date.now();
  const freshness = { at: new Date(now).toISOString(), regions: [], now };
  const rows = [
    { name: "crit", tone: "crit", statusLabel: "Overdue" },
    { name: "warn", tone: "warn", statusLabel: "Late" },
    { name: "info", tone: "info", statusLabel: "Idle" },
    { name: "ok", tone: "ok", statusLabel: "Healthy" },
    { name: "no verdict yet", tone: null, statusLabel: "Not loaded" },
  ];
  for (const row of rows) {
    await t.test(row.name, () => {
      const part = { id: "cron", name: "cron", tone: row.tone, statusLabel: row.statusLabel, nodeIds: [], lastRunAt: null, nextRunAt: null, cadenceMinutes: null, cause: null };
      const tree = renderScreen(mod.React.createElement(mod.PartHealthRowAR, { row: part, freshness, nodeIndex: new Map(), onSelectNode: () => {} }));
      const [status] = findNodes(tree, (n) => isStatusHost(n) && /\barch-part-status\b/.test(String(n.props.className)) && collectText(n).includes(row.statusLabel));
      const classes = String(status.props.className).split(/\s+/);

      assert.deepEqual(classes.filter((c) => /^text-(ok|warn|crit|info)$/.test(c)), [], `the ${row.name} verdict word carries no tone`);
      if (!row.tone) {
        assert.equal(status.props.atom, undefined, "a part with no verdict shows the word alone, no status atom");
        return assert.ok(classes.includes("text-faint"), "a part with no verdict reads faint");
      }
      assert.equal(status.props.atom, "HeadStatus", `the ${row.name} verdict draws through the status atom`);
      assert.equal(status.props.tone, row.tone, `the ${row.name} glyph takes its tone`);
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
