// Render guard for RejectBucketSplitI in public/src/screens/improvement.jsx — the
// Rejected track's three-way split (quality / infra / lifecycle).
//
// improvement.reject-buckets.route.test.ts pins what the route COUNTS; nothing pinned
// what the screen SHOWS. The screen must display the server counts as-is: the
// provenance filter lives server-side, so a client-side recount or re-filter reads a
// different population and quietly disagrees with the API — which is exactly the
// failure this file exists to catch. A swapped label→count mapping fails here too.
//
// Sandbox harness (esbuild + node:vm over the real shipped improvement.jsx):
// client-sandbox.ts. The component is invoked with a recording React.createElement and
// the emitted element tree is walked for its rendered strings.
//
// Runner: npx tsx --test test/improvement.reject-buckets.client.unit.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPROVEMENT_SRC = resolve(__dirname, "../public/src/screens/improvement.jsx");

interface RecordedElement {
  type: unknown;
  props: Record<string, unknown>;
}

interface RejectBucketSummary {
  window_days: number;
  infra_count: number;
  quality_count: number;
  lifecycle_count: number;
  total: number;
}

type BoardColumns = Record<"safety" | "applied" | "rejected", Array<{ id: number }>>;

interface SplitSandbox {
  React: { createElement: unknown };
  window: { UI: { CardInfo: unknown } };
  RejectSparkI: (props: { trend: Array<{ reject: number }> }) => RecordedElement;
  RejectBucketSplitI: (props: {
    summary: RejectBucketSummary | null | undefined;
    trend?: Array<{ date: string; verified: number; reject: number }>;
  }) => RecordedElement | null;
  groupByColumnI: (proposals: Array<{ id: number; status: string }>) => BoardColumns;
  CompactProposalCardI: (props: {
    row: { id: number; status: string; rationale: string };
    onClick: () => void;
  }) => RecordedElement;
}

const LABELS = ["Quality", "Infra", "Lifecycle"];

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

// Depth-first collection of every rendered string, in emit order.
function collectStrings(node: unknown, out: string[]): string[] {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (!isElement(node)) return out;
  const children = node.props.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) collectStrings(child, out);
  return out;
}

// Each cell renders its label immediately followed by its count, so the string that
// follows a known label IS that bucket's rendered count.
function readCounts(node: unknown): Record<string, string> {
  const texts = collectStrings(node, []);
  const counts: Record<string, string> = {};
  texts.forEach((text, i) => {
    const next = texts[i + 1];
    if (LABELS.includes(text) && next !== undefined) counts[text] = next;
  });
  return counts;
}

const sandbox = await buildScreenSandbox<SplitSandbox>(IMPROVEMENT_SRC);
sandbox.React.createElement = (
  type: unknown,
  props: Record<string, unknown> | null,
  ...rest: unknown[]
) => ({
  type,
  props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
});

// A deliberately uneven mix — three distinct counts, so a swapped or recomputed
// mapping cannot pass by coincidence.
const MIXED: RejectBucketSummary = {
  window_days: 30,
  infra_count: 7,
  quality_count: 3,
  lifecycle_count: 2,
  total: 12,
};

test("each bucket renders the server count it was given", () => {
  const counts = readCounts(sandbox.RejectBucketSplitI({ summary: MIXED }));
  assert.equal(counts.Quality, "3", "quality is the only substantive reject bucket");
  assert.equal(counts.Infra, "7", "infra never reached a quality verdict");
  assert.equal(counts.Lifecycle, "2", "lifecycle rows were superseded, not judged");
});

// The discriminating case for a falsy guard: a measured zero is a real count, and
// dropping it hides that a bucket was empty rather than absent.
test("a measured zero bucket still renders as zero", () => {
  const counts = readCounts(
    sandbox.RejectBucketSplitI({
      summary: { window_days: 30, infra_count: 0, quality_count: 5, lifecycle_count: 0, total: 5 },
    }),
  );
  assert.equal(counts.Infra, "0");
  assert.equal(counts.Lifecycle, "0");
  assert.equal(counts.Quality, "5");
});

// Backward compatibility: an older payload carries no reject_bucket_summary. Rendering
// nothing is the contract — an empty split with dashes would be a fabricated artifact.
test("an absent summary renders nothing at all", () => {
  assert.equal(sandbox.RejectBucketSplitI({ summary: undefined }), null);
  assert.equal(sandbox.RejectBucketSplitI({ summary: null }), null);
});

type HeaderProps = {
  rowCount: number;
  summary: RejectBucketSummary | null;
  label: string;
  symbol: string;
};

const renderHeader = (props: Partial<HeaderProps>) =>
  (sandbox as unknown as { RejectedHeaderI: (props: HeaderProps) => unknown }).RejectedHeaderI({
    rowCount: 40,
    summary: null,
    label: "Rejected",
    symbol: "✕",
    ...props,
  });

// Visible strings only — the ⓘ drawer body (CardInfo children) is not on the page.
function collectVisibleStrings(node: unknown, out: string[]): string[] {
  if (isElement(node) && node.type === sandbox.window.UI.CardInfo) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (!isElement(node)) return out;
  const children = node.props.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) collectVisibleStrings(child, out);
  return out;
}

const summaryRows = [
  { name: "with a server window", summary: MIXED },
  { name: "without a server window", summary: null },
];

// The head heads the lane's rows → its count is their count, whatever the server window holds.
describe("the rejected header counts the rows it heads and names their basis", () => {
  for (const row of summaryRows) {
    test(row.name, () => {
      const visible = collectVisibleStrings(renderHeader({ summary: row.summary }), []);

      assert.ok(visible.includes("40"), visible.join(" | "));
      assert.match(visible.join(" "), /latest 50/i);
      assert.doesNotMatch(visible.join(" "), /last \d+ days/i, "the window basis stays behind ⓘ");
    });
  }
});

test("the rejected header keeps the day window's total behind its ⓘ", () => {
  const all = collectStrings(renderHeader({ summary: MIXED }), []).join(" ");
  const visible = collectVisibleStrings(renderHeader({ summary: MIXED }), []);

  assert.ok(!visible.includes(String(MIXED.total)), visible.join(" | "));
  assert.match(all, new RegExp(`${MIXED.total} rejected in the last ${MIXED.window_days} days`));
});

test("the cause split names the day window it counts", () => {
  const texts = collectStrings(sandbox.RejectBucketSplitI({ summary: MIXED }), []).join(" ");

  assert.match(texts, new RegExp(`last ${MIXED.window_days} days`));
});

test("the cause split captions its sparkline with a unit", () => {
  const texts = collectStrings(
    sandbox.RejectBucketSplitI({
      summary: MIXED,
      trend: [
        { date: "2026-09-24", verified: 1, reject: 2 },
        { date: "2026-09-25", verified: 2, reject: 1 },
      ],
    }),
    [],
  ).join(" ");

  assert.match(texts, /per day/i);
});

const sparkRows = [
  { name: "a series that peaks mid-window", rejects: [2, 5, 1] },
  { name: "a series with no rejection", rejects: [0, 0] },
];

for (const row of sparkRows) {
  test(`the rejection sparkline is a named image summarising its series: ${row.name}`, () => {
    const spark = sandbox.RejectSparkI({ trend: row.rejects.map((reject) => ({ reject })) });
    const name = String(spark.props["aria-label"]);
    const total = row.rejects.reduce((sum, count) => sum + count, 0);

    assert.equal(spark.props.role, "img");
    assert.match(name, new RegExp(`${row.rejects.length} days`));
    assert.match(name, new RegExp(`latest ${row.rejects[row.rejects.length - 1]}\\b`));
    assert.match(name, new RegExp(`peak ${Math.max(...row.rejects)}\\b`));
    assert.match(name, new RegExp(`${total} in total`));
  });
}

// design.md §4.3: rejections per day are a quantity series, and a severity colour is never a series colour
test("the rejection sparkline draws its series in the data colour", () => {
  const spark = sandbox.RejectSparkI({ trend: [2, 5, 1].map((reject) => ({ reject })) });
  const line = spark.props.children as RecordedElement;

  assert.equal(line.props.stroke, "rgb(var(--data))");
});

// The board renders safety from the actionable feed and only applied / rejected from the
// terminal feed, so a terminal row grouped anywhere else leaves the board.
const terminalRows = [
  { name: "an applied row", status: "applied", column: "applied" },
  { name: "a rejected row", status: "rejected", column: "rejected" },
  { name: "a row closed without a verdict", status: "unadjudicated", column: "rejected" },
] as const;

for (const row of terminalRows) {
  test(`a terminal-feed row stays on the board in exactly one column: ${row.name}`, () => {
    const columns = sandbox.groupByColumnI([{ id: 1, status: row.status }]);
    const holding = Object.entries(columns)
      .filter(([, rows]) => rows.some((p) => p.id === 1))
      .map(([key]) => key);

    assert.deepEqual(holding, [row.column]);
  });
}

// A Rejected-column row renders through the page-local BoardRowI atom.
function renderRejectedRow(status: string): RecordedElement {
  const card = sandbox.CompactProposalCardI({
    row: { id: 9, status, rationale: "Model call hit the quota limit" },
    onClick: () => {},
  });
  return (card.type as (props: Record<string, unknown>) => RecordedElement)(card.props);
}

const rejectedColumnRows = [
  { name: "a row closed without a verdict", status: "unadjudicated", isVerdict: false },
  { name: "a rejected row", status: "rejected", isVerdict: true },
];

for (const row of rejectedColumnRows) {
  test(`a Rejected-column row is marked non-verdict only when it reached no verdict: ${row.name}`, () => {
    const button = renderRejectedRow(row.status);
    const texts = collectStrings(button, []).join(" ");
    const name = String(button.props["aria-label"]);

    assert.equal(/not judged/i.test(texts), !row.isVerdict, texts);
    assert.equal(/without a verdict/i.test(name), !row.isVerdict, name);
    assert.equal(/declined/i.test(name), row.isVerdict, name);
  });
}

// A lane with no rejection in its window has nothing to break down or plot: a split of
// zeros and a flat line spend the head's width on a fact the count already states.
describe("a rejected lane with nothing in its window draws no cause split and no sparkline", () => {
  const EMPTY_WINDOW: RejectBucketSummary = {
    window_days: 30,
    infra_count: 0,
    quality_count: 0,
    lifecycle_count: 0,
    total: 0,
  };
  const FLAT_TREND = [
    { date: "2026-11-14", verified: 0, reject: 0 },
    { date: "2026-11-15", verified: 1, reject: 0 },
  ];
  test("the cause split and its sparkline render nothing", () => {
    assert.equal(sandbox.RejectBucketSplitI({ summary: EMPTY_WINDOW, trend: FLAT_TREND }), null);
  });
});
