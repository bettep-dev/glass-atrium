// E2E chromium captures of the Queue page (screens/queue.jsx): each named state and close-up the owner compares to the mockup.
//
// Runner: npx tsx --test test/queue.render-captures.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network (React and the fonts).
// Captures: QUEUE_SHOTS_DIR (absolute) names a folder that keeps them; unset → a fresh mktemp folder, removed when its test ends.
// Harness: test/lib/queue-render-harness.ts; a queue read with no fixture route answers 404 and is recorded.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { captureCloseUp, captureQueueStates, CLOSE_UP_STATES, closeHarness, getPngSize, getShotName, getShotsDir, getStateViewports, type Harness, openHarness, QUEUE_STATES, VIEWPORTS } from "./lib/queue-render-harness.js";

describe("queue page named-state captures for the mockup", () => {
  let harness: Harness;

  before(async () => {
    harness = await openHarness();
  });

  after(() => closeHarness(harness));

  test("each named state is captured at every size §18.4 marks for it as a viewport-sized PNG named for the mockup", async (t) => {
    const dir = await getShotsDir(t);
    t.diagnostic(`captures: ${dir}`);

    const failures = await captureQueueStates(harness, dir);

    assert.deepEqual(failures, []);
    for (const state of QUEUE_STATES) {
      for (const viewport of getStateViewports(state)) {
        const name = getShotName(viewport, state);
        assert.deepEqual(await getPngSize(join(dir, name)), { width: viewport.width, height: viewport.height }, name);
      }
    }
  });

  test("each close-up is captured at device scale 2: its PNG is twice its element's box", async (t) => {
    const dir = await getShotsDir(t);
    t.diagnostic(`close-ups: ${dir}`);
    const shots = [];
    for (const state of CLOSE_UP_STATES) {
      const box = await captureCloseUp(harness, dir, state);
      const name = getShotName(VIEWPORTS[0], state);
      shots.push({ name, png: await getPngSize(join(dir, name)), twice: { width: box.width * 2, height: box.height * 2 } });
    }

    assert.deepEqual(shots.map((shot) => ({ name: shot.name, png: shot.png })), shots.map((shot) => ({ name: shot.name, png: shot.twice })));
  });
});
