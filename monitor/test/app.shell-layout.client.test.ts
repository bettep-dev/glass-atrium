// Shell layout and focus behaviour of public/src/app.jsx: no fixed width floor, a skip link
// ahead of the sidebar, and focus moved to the new page heading on a route change only.
// Exercises the shipped JSX through test/lib/render-screen.ts with a slot-keeping hook stub,
// so state and effects persist across renders the way React keeps them.
//
// Runner: npx tsx --test test/app.shell-layout.client.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  collectText,
  createReactStub,
  findNodes,
  loadScreenModule,
  renderScreen,
  type RenderedNode,
} from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_SRC = resolve(__dirname, "../public/src/app.jsx");
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

interface FakeElement {
  tag: string;
  attrs: Record<string, string>;
  heading: FakeElement | null;
  hasAttribute: (name: string) => boolean;
  setAttribute: (name: string, value: string) => void;
  focus: () => void;
  querySelector: (selector: string) => FakeElement | null;
}

type Effect = () => unknown;
type Deps = unknown[] | undefined;

// Hook slots keyed by call order, reset per render — mirrors React's persistence contract.
function createStatefulReact() {
  const base = createReactStub();
  const slots: unknown[] = [];
  let cursor = 0;
  let pending: Effect[] = [];
  const claim = (init: () => unknown): number => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = init();
    return index;
  };

  // createReactStub is typed as a loose record; its createElement is the variadic factory
  const createElement = base.createElement as (type: unknown, props: unknown, ...children: unknown[]) => unknown;
  const react = {
    ...base,
    createElement,
    useState: (initial: unknown) => {
      const index = claim(() => (typeof initial === "function" ? (initial as () => unknown)() : initial));
      const setter = (next: unknown) => {
        slots[index] = typeof next === "function" ? (next as (p: unknown) => unknown)(slots[index]) : next;
      };
      return [slots[index], setter];
    },
    useRef: (initial: unknown) => slots[claim(() => ({ current: initial }))],
    // memoized by deps like React → a stable callback keeps its effect from re-running every render
    useCallback: (fn: unknown, deps: Deps) => {
      const index = claim(() => ({ fn, deps }));
      const memo = slots[index] as { fn: unknown; deps: Deps };
      const changed = !deps || !memo.deps || deps.some((dep, i) => dep !== memo.deps?.[i]);
      if (changed) slots[index] = { fn, deps };
      return (slots[index] as { fn: unknown }).fn;
    },
    useEffect: (effect: Effect, deps: Deps) => {
      const index = claim(() => undefined);
      const prev = slots[index] as Deps;
      const changed = !deps || !prev || deps.some((dep, i) => dep !== prev[i]);
      if (!changed) return;
      slots[index] = deps;
      pending.push(effect);
    },
  };
  const flushEffects = () => {
    const run = pending;
    pending = [];
    for (const effect of run) effect();
  };
  const resetCursor = () => {
    cursor = 0;
  };
  return { react, flushEffects, resetCursor };
}

function fakeElement(tag: string, heading: FakeElement | null, focusLog: FakeElement[]): FakeElement {
  const element: FakeElement = {
    tag,
    attrs: {},
    heading,
    hasAttribute: (name) => name in element.attrs,
    setAttribute: (name, value) => {
      element.attrs[name] = value;
    },
    focus: () => {
      focusLog.push(element);
    },
    querySelector: (selector) => (selector === "h1" ? element.heading : null),
  };
  return element;
}

type StatefulReact = ReturnType<typeof createStatefulReact>["react"];
type ScreenFactory = (react: StatefulReact, ui: Record<string, unknown>) => Record<string, unknown>;

// Harness fold stand-in: loading until every store answered, then ready with no fault.
const readyOnceAnswered = (stores: Record<string, { status: string }>) =>
  Object.values(stores).some((store) => store.status === "loading")
    ? { status: "loading" }
    : { status: "ready", downNames: [], failCount1h: 0 };

async function mountShell({ fetch = () => new Promise(() => undefined), createRoot = () => ({ render: () => undefined }), screens, foldHarness }: {
  fetch?: (url: string) => Promise<unknown>;
  createRoot?: () => { render: (node: unknown) => void };
  screens?: ScreenFactory;
  foldHarness?: (stores: Record<string, { status: string; error?: string | null }>) => unknown;
} = {}) {
  const { react, flushEffects, resetCursor } = createStatefulReact();
  let displayTimezone = "Asia/Seoul";
  const focusLog: FakeElement[] = [];
  const heading = fakeElement("h1", null, focusLog);
  const main = fakeElement("main", heading, focusLog);
  const listeners: Record<string, () => void> = {};
  const location = { hash: "#dashboard" };
  const screen = (label: string) => () => react.createElement("h1", null, label);
  // the shipped ui.jsx atoms, sharing the shell's hook slots; the stubs below override the few the shell test pins
  const ui = (await loadScreenModule(UI_SRC, { React: react, setInterval: () => 0, clearInterval: () => undefined })).UI as Record<string, unknown>;

  const mod = await loadScreenModule(APP_SRC, {
    React: react,
    ReactDOM: { createRoot },
    fetch,
    setInterval: () => 0,
    clearInterval: () => undefined,
    location,
    history: { replaceState: () => undefined },
    addEventListener: (type: string, listener: () => void) => {
      listeners[type] = listener;
    },
    removeEventListener: () => undefined,
    document: {
      getElementById: (id: string) => (id === "main-content" ? main : null),
      documentElement: { setAttribute: () => undefined, style: { setProperty: () => undefined } },
    },
    useTweaks: () => [{ theme: "dark", density: "comfortable", accent: "#3b82f6" }, () => undefined],
    HealthModel: { foldHarness: foldHarness ?? (screens ? readyOnceAnswered : () => ({ status: "loading" })) },
    UI: {
      ...ui,
      Icon: () => null,
      setDisplayTimezone: (tz: string) => { if (tz) displayTimezone = tz; },
      getDisplayTimezone: () => displayTimezone,
    },
    ScreenDashboard: function ScreenDashboard() { return react.createElement("time", null, displayTimezone); },
    ScreenCost: screen("Cost & usage"),
    ...screens?.(react, ui),
  });

  const render = (): RenderedNode => {
    resetCursor();
    const tree = renderScreen(react.createElement(mod.App as () => unknown, {})) as RenderedNode;
    flushEffects();
    return tree;
  };
  const navigateByHash = (hash: string) => {
    location.hash = hash;
    listeners.hashchange();
  };
  return { render, navigateByHash, focusLog, heading, main };
}

function mainRegion(tree: RenderedNode): RenderedNode {
  const [main] = findNodes(tree, (n) => n.type === "main");
  assert.ok(main, "the shell renders a main landmark");
  return main;
}

test("no shell node carries a fixed minimum width, so the layout fits a 1024px viewport", async () => {
  const { render } = await mountShell();
  const tree = render();

  const floored = findNodes(tree, (n) => {
    const style = n.props.style as Record<string, unknown> | undefined;
    return style?.minWidth !== undefined || /\bmin-w-\[/.test(String(n.props.className ?? ""));
  });
  assert.deepEqual(floored.map((n) => n.type), []);
  assert.match(String(mainRegion(tree).props.className), /\bmin-w-0\b/, "main may shrink below its content");
});

// index.html carries the stored-document language → the English chrome declares its own
test("the shell root declares English, so the skip link, sidebar and main region are announced as English", async () => {
  const { render } = await mountShell();
  const [root] = render().children as RenderedNode[]; // the harness wraps App in a component node

  assert.equal(root.props.lang, "en");
  assert.equal(findNodes(root, (n) => n.type === "main").length, 1, "the main region renders under the shell root");
});

test("the skip link is the first focusable stop and targets the main region", async () => {
  const { render } = await mountShell();
  const tree = render();

  const [first] = findNodes(tree, (n) => n.type === "a" || n.type === "button");
  const main = mainRegion(tree);
  assert.equal(first.type, "a", "a link precedes every sidebar button");
  assert.equal(first.props.href, `#${main.props.id}`);
  assert.equal(main.props.tabIndex, -1, "main is a programmatic focus target");
});

test("activating the skip link keeps the hash route and focuses the page heading", async () => {
  const { render, focusLog, heading } = await mountShell();
  const [skip] = findNodes(render(), (n) => n.type === "a");
  let prevented = false;

  (skip.props.onClick as (e: unknown) => void)({ preventDefault: () => (prevented = true) });

  assert.equal(prevented, true, "the #main-content href must not replace the screen hash");
  assert.deepEqual(focusLog, [heading]);
  assert.equal(heading.attrs.tabindex, "-1");
});

test("focus moves to the heading only when the route changes", async () => {
  const { render, navigateByHash, focusLog, heading } = await mountShell();

  render();
  assert.deepEqual(focusLog, [], "first mount leaves focus where the browser put it");

  navigateByHash("#cost");
  render();
  assert.deepEqual(focusLog, [heading], "a route change focuses the new page heading");

  render();
  assert.equal(focusLog.length, 1, "a re-render on the same route does not steal focus");
});

test("route focus falls back to the main region and keeps an authored tabindex", async (t) => {
  const rows = [
    { name: "no heading → the main region takes focus", hasHeading: false, authored: undefined, expectTag: "main", expectTabindex: "-1" },
    { name: "heading without tabindex → it becomes programmatically focusable", hasHeading: true, authored: undefined, expectTag: "h1", expectTabindex: "-1" },
    { name: "heading with an authored tabindex → the value is kept", hasHeading: true, authored: "0", expectTag: "h1", expectTabindex: "0" },
  ];
  for (const row of rows) {
    await t.test(row.name, async () => {
      const { render, focusLog, heading, main } = await mountShell();
      if (!row.hasHeading) main.heading = null;
      if (row.authored !== undefined) heading.attrs.tabindex = row.authored;
      const [skip] = findNodes(render(), (n) => n.type === "a");

      (skip.props.onClick as (e: unknown) => void)({ preventDefault: () => undefined });

      assert.equal(focusLog[0]?.tag, row.expectTag);
      assert.equal(focusLog[0]?.attrs.tabindex, row.expectTabindex);
    });
  }
});

test("the shell mounts at once, without waiting for the health read", async () => {
  const mounted: unknown[] = [];

  await mountShell({ createRoot: () => ({ render: (node) => mounted.push(node) }) });

  assert.equal(mounted.length, 1, "one root render while /api/health is still pending");
});

// the queue has no sign-in → the shell reads only the count route, never an owner route
test("the shell reads no owner queue route on mount", async () => {
  const urls: string[] = [];
  const { render } = await mountShell({
    fetch: (url) => {
      urls.push(url);
      return new Promise(() => undefined);
    },
  });
  render();

  assert.ok(urls.includes("/api/queue/count"), urls.join(", "));
  assert.deepEqual(urls.filter((url) => url.startsWith("/api/queue/owner")), []);
});

test("a timezone arriving on the health read re-keys the page, so every time string re-renders in it", async () => {
  const health = { ok: true, json: async () => ({ timezone: "America/New_York" }) };
  const { render } = await mountShell({
    fetch: (url) => (url === "/api/health" ? Promise.resolve(health) : Promise.reject(new Error("HTTP 503"))),
  });
  const getPage = (tree: RenderedNode) => findNodes(tree, (n) => n.type === "ScreenDashboard")[0];

  assert.equal(getPage(render()).props.key, "Asia/Seoul", "the default zone renders before the read settles");
  await new Promise((settle) => setImmediate(settle));
  render();
  const page = getPage(render());

  assert.equal(page.props.key, "America/New_York");
  assert.deepEqual(findNodes(page, (n) => n.type === "time").map((n) => n.children[0]), ["America/New_York"]);
});

// Harness endpoints answer on demand; one /api/dashboard/kpi request marks one harness read.
function createHarnessFetch({ isHealthy }: { isHealthy: boolean }) {
  const state = { isHealthy, kpiReads: 0 };
  let pending: (() => void)[] = [];
  const fetch = (url: string) =>
    new Promise((resolve, reject) => {
      if (url === "/api/dashboard/kpi") state.kpiReads += 1;
      pending.push(() => (state.isHealthy ? resolve({ ok: true, json: async () => ({}) }) : reject(new Error("HTTP 503"))));
    });
  const settle = async () => {
    const run = pending;
    pending = [];
    for (const answer of run) answer();
    for (let tick = 0; tick < 5; tick += 1) await new Promise((done) => setImmediate(done));
  };
  return { fetch, settle, state };
}

const clickNode = (node: RenderedNode) => (node.props.onClick as (e: unknown) => void)({});

test("a Refresh off the Dashboard starts one harness read, and concurrent requests join it", async () => {
  const harnessFetch = createHarnessFetch({ isHealthy: true });
  const captured: { onRetryHarness?: () => Promise<unknown> } = {};
  const { render, navigateByHash } = await mountShell({
    fetch: harnessFetch.fetch,
    screens: (react, ui) => ({
      ScreenCost: function ScreenCost(props: { onRetryHarness: () => Promise<unknown> }) {
        captured.onRetryHarness = props.onRetryHarness;
        return react.createElement(ui.RefreshButton, { label: "Refresh cost data", onRefresh: () => undefined });
      },
    }),
  });
  render();
  await harnessFetch.settle();
  navigateByHash("#cost");
  const [refresh] = findNodes(mainRegion(render()), (n) => n.type === "button");
  const readsBefore = harnessFetch.state.kpiReads;

  clickNode(refresh);
  clickNode(refresh);
  assert.equal(harnessFetch.state.kpiReads - readsBefore, 1, "two Refreshes start one harness read");
  const dashboardRead = captured.onRetryHarness?.();

  assert.equal(harnessFetch.state.kpiReads - readsBefore, 1, "the Dashboard re-read joins the read in flight");
  await harnessFetch.settle();
  await dashboardRead;
});

// Harness fold stand-in: a part down while any store's latest read failed, no fault once every store answered.
const downWhileUnread = (stores: Record<string, { status: string; error?: string | null }>) => ({
  status: "ready",
  downNames: Object.values(stores).some((store) => store.error != null) ? ["PostgreSQL"] : [],
  failCount1h: 0,
});

// the rendered count shells, not the Badge elements that produce them
const findNavBadges = (tree: RenderedNode) => findNodes(tree, (n) => ["pill", "nav-count"].every((name) => String(n.props.className ?? "").split(" ").includes(name)));

test("a page Retry also re-reads the harness, so a recovered harness reaches the nav on that action", async () => {
  const harnessFetch = createHarnessFetch({ isHealthy: false });
  const { render, navigateByHash } = await mountShell({
    fetch: harnessFetch.fetch,
    foldHarness: downWhileUnread,
    screens: (react, ui) => ({
      ScreenCost: function ScreenCost() {
        return react.createElement(ui.RetryButton, { onRetry: () => undefined });
      },
    }),
  });
  render();
  await harnessFetch.settle();
  navigateByHash("#cost");
  const faulted = render();
  const [retry] = findNodes(mainRegion(faulted), (n) => n.type === "button");
  assert.equal(findNavBadges(faulted).length, 1, "precondition: the faulted harness shows on the nav");
  const readsBefore = harnessFetch.state.kpiReads;
  harnessFetch.state.isHealthy = true;

  clickNode(retry);
  await harnessFetch.settle();

  assert.equal(harnessFetch.state.kpiReads - readsBefore, 1, "the Retry starts one harness read");
  assert.deepEqual(findNavBadges(render()), [], "the recovered harness clears the nav badge");
});

describe("the Queue nav item", () => {
  const QUEUE_SLOT = { badge: "128", badgeTone: "warn", glyph: "⚠", source: "queue", title: "128 awaiting you, 1 deviation", description: "128 awaiting you, 1 deviation" };
  // the queue slot from its own read, beside a toned Agents numeral on the same merged nav map
  async function renderNav(): Promise<RenderedNode> {
    const getQueueNavBadge = () => ({ queue: { badges: [QUEUE_SLOT] }, agents: { badge: "3", badgeTone: "crit" } });
    const { render } = await mountShell({ screens: () => ({ QueueNav: { getQueueNavBadge } }) });
    return render();
  }
  const classOf = (n: RenderedNode) => String(n.props.className ?? "");
  function getNavBadge(tree: RenderedNode, label: string): RenderedNode {
    const [item] = findNodes(tree, (n) => n.type === "button" && n.props.title === label);
    assert.ok(item, `the nav renders ${label}`);
    const [badge] = findNodes(item, (n) => classOf(n).split(" ").includes("pill"));
    assert.ok(badge, `${label} carries a badge`);
    return badge;
  }

  test("carries its warn count as the solid round count badge, capped at 99+", async () => {
    const queue = getNavBadge(await renderNav(), "Queue");
    assert.deepEqual(["pill--solid", "pill--num", "nav-count"].map((name) => classOf(queue).split(" ").includes(name)), [true, true, true]);
    assert.match(collectText(queue), /99\+/);
  });

  test("the deviation glyph leads the count inside the badge in the badge's own colour, and assistive tech hears the full description", async () => {
    const queue = getNavBadge(await renderNav(), "Queue");
    const [glyph] = findNodes(queue, (n) => n.type === "span" && collectText(n) === "⚠ ");
    const [description] = findNodes(queue, (n) => classOf(n) === "sr-only");
    assert.ok(glyph, "the glyph renders inside the badge");
    assert.deepEqual([glyph.props["aria-hidden"], classOf(glyph)], ["true", ""]);
    assert.equal(collectText(description), `, ${QUEUE_SLOT.description}`);
  });
});

describe("the nav counts", () => {
  const SLOT = {
    warn: { badge: "4", badgeTone: "warn", glyph: "⚠", title: "4 failed", description: "4 failed" },
    crit: { badge: "2", badgeTone: "crit", glyph: "✕", title: "2 down", description: "2 down" },
    many: { badge: "140", badgeTone: "warn", glyph: "⚠", title: "140 failed", description: "140 failed" },
  };
  const getClasses = (n: RenderedNode) => String(n.props.className ?? "").split(" ");
  async function renderAgentCounts(badges: unknown[]): Promise<RenderedNode[]> {
    const getQueueNavBadge = () => ({ agents: { badges } });
    const { render } = await mountShell({ screens: () => ({ QueueNav: { getQueueNavBadge } }) });
    const [item] = findNodes(render(), (n) => n.type === "button" && n.props.title === "Agents");
    return findNodes(item, (n) => getClasses(n).includes("pill"));
  }

  // spec 44084 §12.2b: crit → solid, warn → quiet, one solid disc per item
  const rows = [
    { name: "a lone warn count stays quiet", badges: [SLOT.warn], solid: [false] },
    { name: "a lone crit count is solid", badges: [SLOT.crit], solid: [true] },
    { name: "a crit count raised after a warn count is drawn first, and solid", badges: [SLOT.warn, SLOT.crit], solid: [true, false] },
    { name: "of two crit counts only the first is solid", badges: [SLOT.crit, SLOT.crit], solid: [true, false] },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const counts = await renderAgentCounts(row.badges);
      assert.deepEqual(counts.map((n) => getClasses(n).includes("pill--solid")), row.solid);
      for (const count of counts) assert.deepEqual(["nav-count", "pill--num"].map((name) => getClasses(count).includes(name)), [true, true], "every nav numeral takes the round count shape");
    });
  }

  test("a quiet count above 99 reads 99+, and its title and assistive-tech description stay whole", async () => {
    const [count] = await renderAgentCounts([SLOT.many]);
    const [description] = findNodes(count, (n) => getClasses(n).includes("sr-only"));
    assert.deepEqual([getClasses(count).includes("pill--solid"), count.props.title], [false, SLOT.many.title]);
    assert.match(collectText(count), /^⚠\s+99\+/);
    assert.equal(collectText(description), `, ${SLOT.many.description}`);
  });
});

describe("the nav current item", () => {
  test("only the current route's item is aria-current page, and it follows navigation", async () => {
    const { render, navigateByHash } = await mountShell();
    const getCurrent = () => findNodes(render(), (n) => n.type === "button" && n.props["aria-current"] !== undefined).map((n) => [n.props.title, n.props["aria-current"]]);
    const onDashboard = getCurrent();
    navigateByHash("#cost");

    assert.deepEqual([onDashboard, getCurrent()], [[["Dashboard", "page"]], [["Cost & usage", "page"]]]);
  });
});

describe("the nav icons", () => {
  // owner decision, spec 44084 §12.2a; Task results keeps target
  test("each destination draws the owner-approved icon", async () => {
    const drawn: Record<string, string> = {};
    const { render } = await mountShell({
      screens: (react, ui) => ({
        UI: { ...ui, Icon: ({ name }: { name: string }) => react.createElement("svg", { "data-icon": name }) },
      }),
    });
    for (const item of findNodes(render(), (n) => n.type === "button" && /\bnav-item\b/.test(String(n.props.className ?? "")))) {
      const [icon] = findNodes(item, (n) => n.type === "svg");
      drawn[String(item.props.title)] = String(icon?.props["data-icon"]);
    }
    assert.deepEqual(
      { learning: drawn.Learning, wiki: drawn.Wiki, map: drawn["System map"], results: drawn["Task results"] },
      { learning: "repeat", wiki: "book-open", map: "network", results: "target" },
    );
  });
});
