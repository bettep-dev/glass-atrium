// E2E chromium check of the Queue page's own copy (screens/queue.jsx): every sentence in each named state the mockup captures.
//
// Runner: npx tsx --test test/queue.render-sentences.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network (React and the fonts).
// Harness: test/lib/queue-render-harness.ts; a queue read with no fixture route answers 404 and is recorded.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";

import { CLOSE_UP_STATES, closeHarness, getLongSentences, getStateViewports, type Harness, openHarness, QUEUE_STATES, readQueueState, type Viewport } from "./lib/queue-render-harness.js";

describe("queue page copy in each named state", () => {
  let harness: Harness;

  before(async () => {
    harness = await openHarness();
  });

  after(() => closeHarness(harness));

  test("every sentence the page shows in each named state is twelve words or fewer", async () => {
    const long: string[] = [];
    for (const state of [...QUEUE_STATES, ...CLOSE_UP_STATES]) {
      const viewport = getStateViewports(state)[0] as Viewport;
      const found = await readQueueState(harness, viewport, state, (page) => getLongSentences(page, harness.fixture));
      long.push(...found.map((sentence) => `${state.nn}-${state.name}: ${sentence}`));
    }

    assert.deepEqual(long, []);
  });
});
