// Render guard for the instrumentation view's failure surface in
// public/src/screens/improvement-instrumentation.jsx. A failed payload must stay
// visible as exactly one error banner at the group that owns it, naming its own source; a card
// that returns null on error makes the failure vanish from the whole screen. The banner itself
// is the shared plain-sentence atom, and a page-level outage banner takes over the Retry.
//
// Runner: npx tsx --test test/improvement.instrumentation-errors.client.unit.test.ts

import test from "node:test";
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
}

const PAYLOADS = ["statsState", "listState", "correctionState", "corpusAuditState"] as const;

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

const sandbox = await buildScreenSandbox<ViewSandbox>(INSTRUMENTATION_SRC);
const BannerMarker = () => null;
sandbox.window.UI.RegionUnavailable = BannerMarker;
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

test("a page-level outage banner leaves no per-card Retry", () => {
  const props: Record<string, unknown> = { onRetry: undefined };
  for (const name of PAYLOADS) props[name] = { status: "error", data: null, error: "HTTP 503 Service Unavailable" };

  const banners = collectBanners(sandbox.ImprovementInstrumentationViewI(props), []);

  assert.equal(banners.length, PAYLOADS.length);
  for (const banner of banners) assert.equal(banner.props.onRetry, undefined);
});

interface PageSandbox {
  React: { createElement: unknown };
  window: { UI: { RegionUnavailable: unknown } };
  ErrorBannerI: (props: Record<string, unknown>) => RecordedElement;
  getPageFailureI: (
    regions: Array<{ source: string; state: { error: string | null } }>,
  ) => { sources: string[]; error: string } | null;
}

const page = await buildScreenSandbox<PageSandbox>(IMPROVEMENT_SRC);
page.React.createElement = sandbox.React.createElement;

test("a failed region renders the shared unavailable card with its own source, never the raw answer as copy", () => {
  const onRetry = () => {};
  const banner = page.ErrorBannerI({ source: "loop stats", error: "HTTP 500 Internal Server Error — {}", onRetry });

  assert.equal(banner.type, page.window.UI.RegionUnavailable);
  assert.deepEqual(
    { source: banner.props.source, error: banner.props.error, onRetry: banner.props.onRetry },
    { source: "loop stats", error: "HTTP 500 Internal Server Error — {}", onRetry },
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
    const failure = page.getPageFailureI(row.regions.map(([source, state]) => ({ source, state })));
    assert.deepEqual(failure ? [...failure.sources] : null, row.sources ? [...row.sources] : null, row.name);
  }
});
