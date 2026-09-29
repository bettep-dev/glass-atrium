// Unit tests for the shared formatRelativeTime in public/src/ui.jsx — the "as of" stamp on
// every screen. Regression pin: a timestamp at or just before now rounded to -0 and read "in 0s".
//
// Runner: npx tsx --test test/ui.relative-time.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildUiSandbox } from "./client-sandbox.js";

interface UiSurface {
  formatRelativeTime: (iso: string | null | undefined) => string;
}

const UI = await buildUiSandbox<UiSurface>();

function isoAt(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

test("a timestamp at now or up to 999 ms in the past never reads as future", () => {
  for (const offsetMs of [0, -1, -250, -499, -500, -999]) {
    const label = UI.formatRelativeTime(isoAt(offsetMs));
    assert.match(label, / ago$/, `offset ${offsetMs} ms → "${label}"`);
  }
});

test("a genuinely future timestamp still reads as future", () => {
  for (const offsetMs of [5_000, 120_000, 7_200_000]) {
    const label = UI.formatRelativeTime(isoAt(offsetMs));
    assert.match(label, /^in /, `offset ${offsetMs} ms → "${label}"`);
  }
});
