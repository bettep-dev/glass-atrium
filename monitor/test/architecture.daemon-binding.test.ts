// Unit tests for DAEMON_NODE_BINDINGS (F32) — every live-overlay daemon must
// resolve to >= 1 mermaid node id that actually exists in DIAGRAMS sources,
// so the FE live rings never bind to dead/renamed nodes.
// Runner: npx tsx --test test/architecture.daemon-binding.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  DAEMON_NODE_BINDINGS,
  DIAGRAMS,
} from "../src/server/architecture/diagrams-source.js";

// live-overlay.ts DAEMON_NAMES mirror — the overlay surface this binding serves.
const EXPECTED_DAEMONS = [
  "autoagent",
  "wiki",
  "daily-restart-autoagent",
  "daily-restart-wiki",
] as const;

// Node-definition matcher: id immediately followed by a shape opener
// ([, (, {, [/ …) at a token boundary — mermaid node declaration form.
function nodeIsDefined(nodeId: string): boolean {
  const pattern = new RegExp(`(^|[\\s;])${nodeId}[\\[\\({]`, "m");
  return DIAGRAMS.some((d) => pattern.test(d.mermaid_source));
}

test("every overlay daemon has >= 1 bound node id", () => {
  for (const daemon of EXPECTED_DAEMONS) {
    const nodeIds = DAEMON_NODE_BINDINGS[daemon];
    assert.ok(
      nodeIds !== undefined && nodeIds.length >= 1,
      `daemon '${daemon}' must bind to at least one node id`,
    );
  }
});

test("every bound node id exists as a node definition in some diagram source", () => {
  for (const [daemon, nodeIds] of Object.entries(DAEMON_NODE_BINDINGS)) {
    for (const nodeId of nodeIds) {
      assert.ok(
        nodeIsDefined(nodeId),
        `daemon '${daemon}' binds node id '${nodeId}' which is not defined in any mermaid source`,
      );
    }
  }
});

test("binding map keys are exactly the overlay daemon set (no orphan bindings)", () => {
  assert.deepStrictEqual(
    Object.keys(DAEMON_NODE_BINDINGS).sort(),
    [...EXPECTED_DAEMONS].sort(),
    "DAEMON_NODE_BINDINGS keys must mirror live-overlay DAEMON_NAMES",
  );
});
