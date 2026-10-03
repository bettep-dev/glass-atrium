// Copy-cap guard for the Learning screen's card headers in public/src/screens/improvement.jsx and
// improvement-instrumentation.jsx. The 48px header is one line: a title past 24 characters or a
// meta past 32 ellipsizes in a ~330px card until it loses its meaning, so qualifiers belong in
// the meta or the ⓘ drawer, never in the title.
//
// Runner: npx tsx --test test/improvement.header-copy.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPROVEMENT_SRC = resolve(__dirname, "../public/src/screens/improvement.jsx");
const INSTRUMENTATION_SRC = resolve(__dirname, "../public/src/screens/improvement-instrumentation.jsx");

const TITLE_CAP = 24;
const META_CAP = 32;

interface RecordedElement {
  type: unknown;
  props: Record<string, unknown>;
}

type Card = (props: Record<string, unknown>) => unknown;

interface ScreenSandbox {
  React: { createElement: unknown };
  window: { UI: Record<string, unknown>; ImprovementShared?: Record<string, unknown> };
  [card: string]: unknown;
}

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

function recordElements(sandbox: ScreenSandbox): void {
  sandbox.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
    type,
    props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
  });
}

// CardHead elements a card returns directly — the shared atom is recorded, never invoked.
function getHeads(sandbox: ScreenSandbox, node: unknown, out: RecordedElement[] = []): RecordedElement[] {
  if (Array.isArray(node)) {
    for (const child of node) getHeads(sandbox, child, out);
    return out;
  }
  if (!isElement(node)) return out;
  if (node.type === sandbox.window.UI.CardHead) out.push(node);
  else getHeads(sandbox, node.props.children, out);
  return out;
}

const page = await buildScreenSandbox<ScreenSandbox>(IMPROVEMENT_SRC);
recordElements(page);
const gauges = await buildScreenSandbox<ScreenSandbox>(INSTRUMENTATION_SRC);
recordElements(gauges);
gauges.window.ImprovementShared = page.window.ImprovementShared;

const FAILED = { status: "error", data: null, error: "HTTP 500" };
const LOADING = { status: "loading", data: null, error: null };
const READY = { status: "ready", data: {}, error: null };

function getLoopAggregate(days: string[]) {
  const deriveLoopAggregate = page.deriveLoopAggregateI as (data: unknown) => unknown;
  return deriveLoopAggregate({
    events: days.map((day) => ({ event_ts: `${day}T01:00:00Z`, eval_result: "verified" })),
  });
}

const loopAggregate = getLoopAggregate(["2026-09-24", "2026-09-25"]);
const emptyAggregate = getLoopAggregate([]);
// the loop-events fetch limit → the longest basis: a cut count over a two-month span
const cutLoopAggregate = getLoopAggregate(
  Array.from({ length: 200 }, (_, i) => `2026-${i < 100 ? "08" : "09"}-${String(1 + (i % 28)).padStart(2, "0")}`),
);

function ready(data: Record<string, unknown>) {
  return { status: "ready", data, error: null };
}

// Every state each card can head: failed, loading, empty and populated.
const titleRows: Array<{ name: string; sandbox: ScreenSandbox; card: string; props: Record<string, unknown> }> = [
  { name: "applied changes, failed", sandbox: page, card: "ChangeSummaryCardI", props: { state: FAILED } },
  { name: "applied changes, loading", sandbox: page, card: "ChangeSummaryCardI", props: { state: LOADING } },
  { name: "applied changes, no cycles", sandbox: page, card: "ChangeSummaryCardI", props: { state: READY, aggregate: emptyAggregate } },
  { name: "applied changes, populated", sandbox: page, card: "ChangeSummaryCardI", props: { state: READY, aggregate: loopAggregate } },
  { name: "trend, failed", sandbox: page, card: "TrendCardI", props: { state: FAILED } },
  { name: "trend, loading", sandbox: page, card: "TrendCardI", props: { state: LOADING } },
  { name: "trend, too few days", sandbox: page, card: "TrendCardI", props: { state: READY, aggregate: emptyAggregate } },
  { name: "trend, populated", sandbox: page, card: "TrendCardI", props: { state: READY, aggregate: loopAggregate } },
  { name: "learning memory, failed", sandbox: page, card: "BucketRowI", props: { state: FAILED } },
  { name: "learning memory, loading", sandbox: page, card: "BucketRowI", props: { state: LOADING } },
  { name: "learning memory, populated", sandbox: page, card: "BucketRowI", props: { state: READY, buckets: { ctm: 4, epm: 2 } } },
];

// Cards whose header meta is authored copy, or a count with its dates.
const metaRows: typeof titleRows = [
  { name: "applied changes, cut at the fetch limit", sandbox: page, card: "ChangeSummaryCardI", props: { state: READY, aggregate: cutLoopAggregate } },
  { name: "trend, cut at the fetch limit", sandbox: page, card: "TrendCardI", props: { state: READY, aggregate: cutLoopAggregate } },
  { name: "learning memory, loading", sandbox: page, card: "BucketRowI", props: { state: LOADING } },
  { name: "learning memory, populated", sandbox: page, card: "BucketRowI", props: { state: READY, buckets: { ctm: 4, epm: 2 } } },
  { name: "flagged results, loading", sandbox: gauges, card: "FlaggedResultsCardI", props: { state: LOADING } },
  { name: "flagged results, populated", sandbox: gauges, card: "FlaggedResultsCardI", props: { state: ready({ review_flag_last_7d: 3 }), reviewReasons: null } },
  { name: "check status, loading", sandbox: gauges, card: "TierBreakdownCardI", props: { state: LOADING } },
  { name: "check status, empty", sandbox: gauges, card: "TierBreakdownCardI", props: { state: READY, tierBreakdown: { window_days: 30 } } },
  { name: "check status, populated", sandbox: gauges, card: "TierBreakdownCardI", props: { state: READY, tierBreakdown: { code_based_pass_30d: 8, code_based_fail_30d: 2, window_days: 30 } } },
  { name: "suggestion confidence, loading", sandbox: gauges, card: "ConfidenceDistCardI", props: { state: LOADING } },
  { name: "suggestion confidence, empty", sandbox: gauges, card: "ConfidenceDistCardI", props: { state: READY, confidenceDist: { buckets: [] } } },
  { name: "add-only patches, none", sandbox: gauges, card: "ProseOnlyAddCardI", props: { state: READY, summary: { window_days: 30, agents: [], total: 0 } } },
  { name: "style-check rate, loading", sandbox: gauges, card: "StyleRefCardI", props: { state: LOADING } },
  { name: "style-check rate, populated", sandbox: gauges, card: "StyleRefCardI", props: { state: READY, styleRef: { overall_emission_rate: 0.6, overall_uncorroborated_rate: 0.05, agents: [] } } },
  { name: "detection agreement, loading", sandbox: gauges, card: "CorrectionSignalsCardI", props: { state: LOADING } },
  { name: "detection agreement, none yet", sandbox: gauges, card: "CorrectionSignalsCardI", props: { state: ready({ total_signals: 0 }) } },
  { name: "detection agreement, populated", sandbox: gauges, card: "CorrectionSignalsCardI", props: { state: ready({ total_signals: 128, latest_event_ts: "2026-09-23T05:00:00Z", agreement: { total: 128, agreement_count: 120 }, revision_delta_sum: 4, revision_delta_max: 2 }) } },
  { name: "corpus growth, loading", sandbox: gauges, card: "CorpusGrowthCardI", props: { state: LOADING } },
  { name: "corpus growth, none yet", sandbox: gauges, card: "CorpusGrowthCardI", props: { state: ready({ audits: [], total_audits: 0 }) } },
  { name: "corpus growth, populated", sandbox: gauges, card: "CorpusGrowthCardI", props: { state: ready({ audits: [{ cycle_date: "2026-09-23", word_count: 41000, trend_delta: 120 }], total_audits: 12 }) } },
];

function getRowHeads(row: (typeof titleRows)[number]): RecordedElement[] {
  const heads = getHeads(row.sandbox, (row.sandbox[row.card] as Card)(row.props));
  assert.ok(heads.length > 0, `${row.name}: the card renders a header`);
  return heads;
}

test(`every card title on the Learning screen fits the ${TITLE_CAP}-character header`, () => {
  for (const row of [...titleRows, ...metaRows]) {
    for (const head of getRowHeads(row)) {
      const title = String(head.props.title ?? "");
      assert.ok(title.length <= TITLE_CAP, `${row.name}: "${title}" is ${title.length} characters`);
    }
  }
});

test(`every authored header meta on the Learning screen fits ${META_CAP} characters`, () => {
  for (const row of metaRows) {
    for (const head of getRowHeads(row)) {
      const meta = String(head.props.sub ?? "");
      assert.ok(meta.length <= META_CAP, `${row.name}: "${meta}" is ${meta.length} characters`);
    }
  }
});
