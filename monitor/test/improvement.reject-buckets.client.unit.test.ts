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

import test from "node:test";
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

interface SplitSandbox {
  React: { createElement: unknown };
  RejectBucketSplitI: (props: {
    summary: RejectBucketSummary | null | undefined;
  }) => RecordedElement | null;
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
