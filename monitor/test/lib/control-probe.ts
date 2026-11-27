// Box, style and forced-pseudo-state probes shared by the chromium control-tier suites (DESIGN.md §7.15 · §7.16).
// Page and CDP session are read through getters at call time → a suite binds the probe at module level and opens both in before().
import assert from "node:assert/strict";

import type { CDPSession, Page } from "playwright";

export interface Box { left: number; right: number; top: number; bottom: number; width: number; height: number }

export const PSEUDO_STATES = [["hover"], ["focus-visible"], ["active"]] as const;
// rotate(90deg) as chromium serializes it — cos 90° as float residue or as an exact 0
export const QUARTER_TURN = /^matrix\(6\.1\d*e-17, 1, -1, 6\.1\d*e-17, 0, 0\)$|^matrix\(0, 1, -1, 0, 0, 0\)$/;

export const isSameBox = (a: Box, b: Box) => Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01;

interface Probe {
  readBox: (selector: string) => Promise<Box>;
  readStyle: (selector: string, prop: string) => Promise<string>;
  setOpen: (details: string, isOpen: boolean) => Promise<void>;
  forcePseudo: (selector: string, classes: readonly string[]) => Promise<void>;
}

export function createControlProbe(getPage: () => Page, getCdp: () => CDPSession) {
  const readBox = (selector: string) => getBox(getPage(), selector);
  const readStyle = (selector: string, prop: string) => getStyle(getPage(), selector, prop);
  const setOpen = (details: string, isOpen: boolean) => setDetailsOpen(getPage(), details, isOpen);
  const forcePseudo = (selector: string, classes: readonly string[]) => setPseudoState(getCdp(), selector, classes);
  const probe: Probe = { readBox, readStyle, setOpen, forcePseudo };
  return {
    ...probe,
    assertBoxHeldAcrossStates: (selector: string, follower?: string) => assertBoxHeldAcrossStates(probe, selector, follower),
    assertFoldOnOneBox: (details: string, summary: string) => assertFoldOnOneBox(probe, details, summary),
  };
}

const getBox = (page: Page, selector: string): Promise<Box> =>
  page.$eval(selector, (el) => {
    const { left, right, top, bottom, width, height } = el.getBoundingClientRect();
    return { left, right, top, bottom, width, height };
  });

const getStyle = (page: Page, selector: string, prop: string): Promise<string> =>
  page.$eval(selector, (el, name) => getComputedStyle(el).getPropertyValue(name), prop);

const setDetailsOpen = (page: Page, details: string, isOpen: boolean) =>
  page.$eval(details, (el, open) => { (el as HTMLDetailsElement).open = open; }, isOpen);

async function setPseudoState(cdp: CDPSession, selector: string, classes: readonly string[]): Promise<void> {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [...classes] });
}

// a control's border-box at rest, then under each forced pseudo state — and an optional follower's top, so a grown control cannot push what comes after it
async function assertBoxHeldAcrossStates(probe: Probe, selector: string, follower?: string): Promise<void> {
  const rest = await probe.readBox(selector);
  const restFollower = follower ? await probe.readBox(follower) : null;
  for (const state of PSEUDO_STATES) {
    await probe.forcePseudo(selector, state);
    try {
      const changed = await probe.readBox(selector);
      assert.ok(isSameBox(changed, rest), `${selector} ${state[0]} ${changed.width}x${changed.height} vs resting ${rest.width}x${rest.height}`);
      if (follower && restFollower) {
        const moved = await probe.readBox(follower);
        assert.ok(Math.abs(moved.top - restFollower.top) < 0.01, `${follower} top ${moved.top} under ${state[0]} vs ${restFollower.top}`);
      }
    } finally {
      await probe.forcePseudo(selector, []);
    }
  }
}

// a closed fold's summary: 32 tall, no UA marker, the chevron the one open-state cue — turned a quarter only once open, in one box
async function assertFoldOnOneBox(probe: Probe, details: string, summary: string): Promise<void> {
  const closed = await probe.readBox(summary);
  assert.equal(closed.height, 32);
  assert.notEqual(await probe.readStyle(summary, "display"), "list-item", "no UA marker");
  const chevron = `${summary} .disclosure-chevron`;
  assert.equal(await probe.readStyle(chevron, "transform"), "none");
  await probe.setOpen(details, true);
  try {
    const open = await probe.readBox(summary);
    assert.ok(isSameBox(open, closed), `open ${open.width}x${open.height} vs closed ${closed.width}x${closed.height}`);
    const turn = await probe.readStyle(chevron, "transform");
    assert.match(turn, QUARTER_TURN, `open chevron ${turn}`);
  } finally {
    await probe.setOpen(details, false);
  }
}
