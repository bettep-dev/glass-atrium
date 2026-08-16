// The parked-loop banner is the only operator-facing instruction about the repeat-apply
// cap, so what it claims has to be true of the mechanism.
//
// Its superseded text told an operator to re-arm a parked pattern by setting the
// core.learning_log status back to 'identified'. That was measured to be inert and lossy:
// drop_apply_capped_patterns recomputes the cap every cycle from the agent's applied
// proposals in core.autoagent_proposals and reads nothing off the learning_log row, so a
// reset row re-parks on the next run and its original park timestamp and reason are
// overwritten. Following the advice destroyed provenance and re-armed nothing.
//
// Each assertion below pins one claim of the corrected text and goes red against the
// superseded one. The rejected alternative — a banner that presents the parked state as
// intended behaviour with nothing to do — is guarded explicitly, because it would read as
// correct while removing the pressure that gets the cap fixed.
//
// No DB dependency — the constant is asserted directly.
// Runner: npx tsx --test test/improvement.rearm-hint.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { APPLY_CAP_REARM_HINT } from "../src/server/routes/improvement.js";

test("the banner names the status reset it is warning about", () => {
  assert.match(
    APPLY_CAP_REARM_HINT,
    /status back to 'identified'/,
    "an operator reaching for the reset must find it addressed by name",
  );
});

test("the banner denies that resetting status re-arms the cap", () => {
  assert.match(
    APPLY_CAP_REARM_HINT,
    /does NOT re-arm/,
    "the reset is inert; the text must say so rather than recommend it",
  );
});

test("the banner no longer carries the superseded imperative", () => {
  assert.doesNotMatch(
    APPLY_CAP_REARM_HINT,
    /re-arm a parked pattern\b/i,
    "the old text opened its remedy this way — the destructive advice must be gone",
  );
});

test("the banner names the evidence the cap is actually recomputed from", () => {
  assert.match(
    APPLY_CAP_REARM_HINT,
    /core\.autoagent_proposals/,
    "naming the real source is what makes the denial checkable rather than asserted",
  );
});

test("the banner states the reset's destructive cost", () => {
  assert.match(APPLY_CAP_REARM_HINT, /park timestamp/, "the lost provenance is named");
  assert.match(
    APPLY_CAP_REARM_HINT,
    /overwritten/,
    "a reset costs the original park timestamp and reason — silence here reads as harmless",
  );
});

test("the banner keeps the parked row an open item", () => {
  assert.match(
    APPLY_CAP_REARM_HINT,
    /open design decision/,
    "the cap defect stays open; the banner must not close it",
  );
  assert.doesNotMatch(
    APPLY_CAP_REARM_HINT,
    /nothing to do/i,
    "presenting the parked state as intended behaviour is the rejected non-remedy",
  );
});
