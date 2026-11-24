// Render guard for the instrumentation view's failure surface in
// public/src/screens/improvement-instrumentation.jsx. A failed payload must stay
// visible as exactly one error banner at the group that owns it, naming its own source; a card
// that returns null on error makes the failure vanish from the whole screen. The banner itself
// is the shared plain-sentence atom, and a page-level outage banner takes over the Retry.
//
// Runner: npx tsx --test test/improvement.instrumentation-errors.client.unit.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTRUMENTATION_SRC = resolve(
  __dirname,
  "../public/src/screens/improvement-instrumentation.jsx",
);
const IMPROVEMENT_SRC = resolve(__dirname, "../public/src/screens/improvement.jsx");

interface RecordedElement {
  type: unknown;
  props: Record<string, unknown>;
}

interface ViewSandbox {
  React: { createElement: unknown };
  window: { UI: Record<string, unknown>; ImprovementShared?: Record<string, unknown> };
  ImprovementInstrumentationViewI: (props: Record<string, unknown>) => RecordedElement;
  [card: string]: unknown;
}

const PAYLOADS = ["statsState", "listState", "correctionState", "corpusAuditState"] as const;

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

const sandbox = await buildScreenSandbox<ViewSandbox>(INSTRUMENTATION_SRC);
const BannerMarker = () => null;
sandbox.window.UI.RegionFailure = BannerMarker;
sandbox.window.ImprovementShared = {};
sandbox.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
  type,
  props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
});

// Expands view-local components so banners nested in cards are reachable.
function collectBanners(node: unknown, out: RecordedElement[]): RecordedElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectBanners(child, out);
    return out;
  }
  if (!isElement(node)) return out;
  if (node.type === BannerMarker) {
    out.push(node);
    return out;
  }
  if (typeof node.type === "function") {
    return collectBanners((node.type as (p: unknown) => unknown)(node.props), out);
  }
  return collectBanners(node.props.children, out);
}

// Every subset of failed payloads, the untouched ones still loading.
const subsets = Array.from({ length: 1 << PAYLOADS.length }, (_, mask) =>
  PAYLOADS.filter((_, i) => mask & (1 << i)),
);

for (const failed of subsets) {
  test(`one retryable banner per failed payload: [${failed.join(", ") || "none"}]`, () => {
    const onRetry = () => {};
    const props: Record<string, unknown> = { onRetry };
    for (const name of PAYLOADS) {
      props[name] = failed.includes(name)
        ? { status: "error", data: null, error: `${name} HTTP 500` }
        : { status: "loading", data: null, error: null };
    }

    const banners = collectBanners(sandbox.ImprovementInstrumentationViewI(props), []);

    assert.equal(banners.length, failed.length);
    assert.deepEqual(
      banners.map((b) => b.props.error).sort(),
      failed.map((name) => `${name} HTTP 500`).sort(),
    );
    assert.equal(new Set(banners.map((b) => b.props.source)).size, failed.length);
    for (const banner of banners) assert.equal(banner.props.onRetry, onRetry);
  });
}

test("a page-level outage hands every failed card the shared failure, so the banner alone owns Retry", () => {
  const failures = {
    banner: { sources: ["flagged results"], error: "HTTP 503 Service Unavailable" },
    speakers: new Map(),
  };
  const props: Record<string, unknown> = { onRetry: undefined, failures };
  for (const name of PAYLOADS) props[name] = { status: "error", data: null, error: "HTTP 503 Service Unavailable" };

  const banners = collectBanners(sandbox.ImprovementInstrumentationViewI(props), []);

  assert.equal(banners.length, PAYLOADS.length);
  for (const banner of banners) {
    assert.equal(banner.props.failures, failures);
    assert.equal(banner.props.onRetry, undefined);
  }
});

// slot id → the title of the first card inside it; a shared Card is read, never expanded
function getSlotTitles(node: unknown, slot: string | null = null, out = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(node)) {
    for (const child of node) getSlotTitles(child, slot, out);
    return out;
  }
  if (!isElement(node)) return out;
  if (node.type === sandbox.window.UI.Card) {
    if (slot && !out.has(slot)) out.set(slot, node.props.title);
    return out;
  }
  if (typeof node.type === "function") return getSlotTitles((node.type as (p: unknown) => unknown)(node.props), slot, out);
  return getSlotTitles(node.props.children, typeof node.props.id === "string" ? node.props.id : slot, out);
}

// one card, one name: a failed payload's card keeps the title its loading and data forms show
// the suggestion list is left out → its one banner stands in for a group of four cards, so it names the group
describe("a failed payload's card keeps its card's own title", () => {
  for (const failed of ["statsState", "corpusAuditState", "correctionState"] as const) {
    test(failed, () => {
      const loading: Record<string, unknown> = { onRetry: () => {} };
      for (const name of PAYLOADS) loading[name] = { status: "loading", data: null, error: null };
      const withError = { ...loading, [failed]: { status: "error", data: null, error: "HTTP 500" } };

      const before = getSlotTitles(sandbox.ImprovementInstrumentationViewI(loading));
      const after = getSlotTitles(sandbox.ImprovementInstrumentationViewI(withError));

      assert.deepEqual([...after], [...before]);
    });
  }
});

interface PageSandbox {
  React: { createElement: unknown };
  window: { UI: { RegionFailure: unknown } };
  ErrorBannerI: (props: Record<string, unknown>) => RecordedElement;
  getPageFailuresI: (
    regions: Array<{ source: string; state: { error: string | null } }>,
    view: string,
  ) => { banner: { sources: string[]; error: string } | null };
}

const page = await buildScreenSandbox<PageSandbox>(IMPROVEMENT_SRC);
page.React.createElement = sandbox.React.createElement;

test("a failed region renders the shared unavailable card with its own source, never the raw answer as copy", () => {
  const onRetry = () => {};
  const failures = { banner: { sources: ["suggestions"], error: "HTTP 503" }, speakers: new Map() };
  const banner = page.ErrorBannerI({ source: "loop stats", error: "HTTP 500 Internal Server Error — {}", onRetry, failures });

  assert.equal(banner.type, page.window.UI.RegionFailure);
  assert.deepEqual(
    { source: banner.props.source, error: banner.props.error, onRetry: banner.props.onRetry, failures: banner.props.failures },
    { source: "loop stats", error: "HTTP 500 Internal Server Error — {}", onRetry, failures },
  );
});

test("the page outage names exactly the regions that failed with one shared cause", () => {
  const ok = { error: null };
  const down = { error: "HTTP 503 Service Unavailable" };
  const rows = [
    { name: "one failed region stays on its own card", regions: [["suggestion list", down], ["loop stats", ok]], sources: null },
    { name: "two regions sharing a cause become one outage", regions: [["suggestion list", down], ["loop stats", down], ["pattern ledger", ok]], sources: ["suggestion list", "loop stats"] },
  ] as const;

  for (const row of rows) {
    const failure = page.getPageFailuresI(row.regions.map(([source, state]) => ({ source, state })), "instrumentation").banner;
    assert.deepEqual(failure ? [...failure.sources] : null, row.sources ? [...row.sources] : null, row.name);
  }
});

// A held-back card must say so in words: a silent skeleton reads as an empty card to a screen reader.
test("while every payload loads, each card announces itself through the status-role placeholder", () => {
  const LoadingMarker = () => null;
  const shared = sandbox.window.UI.LoadingPlaceholder;
  sandbox.window.UI.LoadingPlaceholder = LoadingMarker;
  const props: Record<string, unknown> = { onRetry: () => {} };
  for (const name of PAYLOADS) props[name] = { status: "loading", data: null, error: null };

  const cards: RecordedElement[][] = [];
  const walk = (node: unknown, card: RecordedElement[] | null): void => {
    if (Array.isArray(node)) return node.forEach((child) => walk(child, card));
    if (!isElement(node)) return;
    if (node.type === LoadingMarker) return void card?.push(node);
    if (typeof node.type === "function") return walk((node.type as (p: unknown) => unknown)(node.props), card);
    const isCard = String(node.props.className ?? "").split(" ").includes("card");
    const scope = isCard ? [] : card;
    if (isCard && scope) cards.push(scope);
    walk(node.props.children, scope);
  };
  try {
    walk(sandbox.ImprovementInstrumentationViewI(props), null);
  } finally {
    sandbox.window.UI.LoadingPlaceholder = shared;
  }

  assert.ok(cards.length > 0, "the loading view must still lay out its cards");
  for (const placeholders of cards) {
    assert.equal(placeholders.length, 1, "each loading card carries exactly one announced placeholder");
    assert.match(String(placeholders[0]?.props.label ?? ""), /\w/, "the placeholder names what is loading");
  }
});

// Paired gauges share one split row so both read in one eye span; two short gauges stack in one column to fill a tall partner's height.
test("the measurement gauges pair side by side, the two short gauges stacked beside Suggestion confidence", () => {
  const props: Record<string, unknown> = { onRetry: () => {} };
  for (const name of PAYLOADS) props[name] = { status: "loading", data: null, error: null };
  const pairs: unknown[][] = [];
  const layouts: unknown[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isElement(node)) return;
    if (node.type === sandbox.window.UI.SplitRow) {
      layouts.push(node.props.layout);
      // a column is a slot wrapper (the recovery focus target) around its one card, a SplitColumn stack, or a bare card
      const columns = ([] as unknown[]).concat(node.props.children).filter(isElement);
      pairs.push(
        columns.map((column) => {
          const isWrapper = column.type === "div" || column.type === sandbox.window.UI.SplitColumn;
          const cards = isWrapper ? ([] as unknown[]).concat(column.props.children) : [column];
          return cards.filter(isElement).map((card) => card.type);
        }),
      );
      return;
    }
    walk(node.props.children);
  };

  walk(sandbox.ImprovementInstrumentationViewI(props));

  assert.deepEqual(pairs, [
    [[sandbox.CorpusGrowthCardI], [sandbox.CorrectionSignalsCardI]],
    [[sandbox.ProseOnlyAddCardI, sandbox.TierBreakdownCardI], [sandbox.ConfidenceDistCardI]],
  ]);
  assert.deepEqual(layouts, ["equal", "equal"], "peer gauges stretch to one height, so their bottoms meet");
});

// a row stretches only while every card in it holds data → an empty card keeps its own height, its partner too
describe("a gauge row holding an empty card sizes each column to its content", () => {
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const FILLED: Record<string, unknown> = {
    onRetry: () => {},
    statsState: ready({ review_flag_last_7d: 3 }),
    corpusAuditState: ready({ total_audits: 1, audits: [{ cycle_date: "2026-11-20", word_count: 41250 }] }),
    correctionState: ready({ total_signals: 12 }),
    listState: ready({}),
    proseOnlyAdd: { window_days: 30, agents: [{ agent: "glass-atrium-dev-db", count: 2 }], total: 2 },
    tierBreakdown: { window_days: 30, code_based_pass_30d: 12406, code_based_fail_30d: 538, pre_3tier_baseline_count: 0 },
    confidenceDist: { buckets: [{ promotion_tier: "candidate", proposal_count: 12, confidence_observed_avg: 0.75 }], overall_confidence_observed_avg: 0.75 },
  };
  const rows = [
    { name: "every card holds data", change: {}, layouts: ["equal", "equal"] },
    { name: "no corpus reading", change: { corpusAuditState: ready({ total_audits: 0, audits: [] }) }, layouts: ["content", "equal"] },
    { name: "no correction signal", change: { correctionState: ready({ total_signals: 0 }) }, layouts: ["content", "equal"] },
    { name: "no add-only patch", change: { proseOnlyAdd: { window_days: 30, agents: [], total: 0 } }, layouts: ["equal", "content"] },
    {
      name: "no checked task",
      change: { tierBreakdown: { window_days: 30, code_based_pass_30d: 0, code_based_fail_30d: 0, pre_3tier_baseline_count: 0 } },
      layouts: ["equal", "content"],
    },
    { name: "no suggestion", change: { confidenceDist: { buckets: [], overall_confidence_observed_avg: null } }, layouts: ["equal", "content"] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const layouts: unknown[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!isElement(node)) return;
        if (node.type === sandbox.window.UI.SplitRow) layouts.push(node.props.layout);
        walk(node.props.children);
      };

      walk(sandbox.ImprovementInstrumentationViewI({ ...FILLED, ...row.change }));

      assert.deepEqual(layouts, row.layouts);
    });
  }
});
