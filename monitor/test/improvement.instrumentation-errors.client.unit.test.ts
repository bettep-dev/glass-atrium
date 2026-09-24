// Render guard for the instrumentation view's failure surface in
// public/src/screens/improvement-instrumentation.jsx. A failed payload must stay
// visible as exactly one retryable error banner at the group that owns it; a card
// that returns null on error makes the failure vanish from the whole screen.
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

interface RecordedElement {
  type: unknown;
  props: Record<string, unknown>;
}

interface ViewSandbox {
  React: { createElement: unknown };
  window: { ImprovementShared?: Record<string, unknown> };
  ImprovementInstrumentationViewI: (props: Record<string, unknown>) => RecordedElement;
}

const PAYLOADS = ["statsState", "listState", "correctionState", "corpusAuditState"] as const;

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

const sandbox = await buildScreenSandbox<ViewSandbox>(INSTRUMENTATION_SRC);
const BannerMarker = () => null;
sandbox.window.ImprovementShared = { ErrorBannerI: BannerMarker };
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
      banners.map((b) => b.props.detail).sort(),
      failed.map((name) => `${name} HTTP 500`).sort(),
    );
    for (const banner of banners) assert.equal(banner.props.onRetry, onRetry);
  });
}
