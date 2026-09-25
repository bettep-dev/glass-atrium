// The System map node drawer names zones by the canonical source's full wording, not the drawn one-word titles.
//
// Runner: npx tsx --test test/architecture.node-drawer-labels.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSingleDiagram } from "../src/server/architecture/parser.js";
import { CANONICAL_MAP, DIAGRAMS } from "../src/server/architecture/diagrams-source.js";
import type { SystemDiagram } from "../src/server/types/architecture.js";
import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH_SRC = resolve(__dirname, "../public/src/screens/architecture.jsx");

interface NodeInfo {
  label: string;
  layer_label: string;
}

interface DrawerLabelSandbox {
  getNodeIndexAR: (diagram: SystemDiagram | null) => Map<string, NodeInfo>;
}

const sandbox = await buildScreenSandbox<DrawerLabelSandbox>(ARCH_SRC);

const logger = { warn: () => {}, info: () => {} };
const slug = CANONICAL_MAP.slug;
const drawn = buildSingleDiagram(slug, "System map", "", CANONICAL_MAP.mermaid_drawn, logger);
const sourceTitleByZone = new Map(
  [...(DIAGRAMS.find((diagram) => diagram.slug === slug)?.mermaid_source ?? "").matchAll(/subgraph\s+(\w+)\["([^"]*)"\]/g)].map(
    ([, zoneId, title]) => [zoneId, title],
  ),
);

test("every drawn zone's nodes carry the source's full zone title as the drawer subtitle", () => {
  assert.ok(drawn, "fixture precondition: the drawn map must parse");
  assert.ok(sourceTitleByZone.size > 0, "fixture precondition: the source map must declare zone titles");

  const index = sandbox.getNodeIndexAR(drawn);
  const zoneLayers = drawn.layers.filter((layer) => sourceTitleByZone.has(layer.id.slice(slug.length + 1)));
  assert.equal(zoneLayers.length, sourceTitleByZone.size, "each source zone is drawn as a layer");

  for (const layer of zoneLayers) {
    const fullTitle = sourceTitleByZone.get(layer.id.slice(slug.length + 1));
    for (const node of layer.nodes ?? []) {
      assert.equal(index.get(node.id)?.layer_label, fullTitle, node.id);
    }
  }
});

test("a flow endpoint that is a whole zone is named by the source's full zone title", () => {
  assert.ok(drawn, "fixture precondition: the drawn map must parse");

  const index = sandbox.getNodeIndexAR(drawn);
  const zoneEndpointIds = new Set(
    drawn.flows.flatMap((flow) => [flow.from, flow.to]).filter((id) => sourceTitleByZone.has(id.slice(slug.length + 1))),
  );
  assert.ok(zoneEndpointIds.size > 0, "fixture precondition: some flow must end on a whole zone");

  for (const nodeId of zoneEndpointIds) {
    assert.equal(index.get(nodeId)?.label, sourceTitleByZone.get(nodeId.slice(slug.length + 1)), nodeId);
  }
});

test("a node that is not a zone keeps its own drawn label", () => {
  assert.ok(drawn, "fixture precondition: the drawn map must parse");

  const index = sandbox.getNodeIndexAR(drawn);
  const zoneIds = new Set(sourceTitleByZone.keys());
  const memberNodes = drawn.layers.flatMap((layer) => layer.nodes ?? []).filter((node) => !zoneIds.has(node.id.slice(slug.length + 1)));
  assert.ok(memberNodes.length > 0, "fixture precondition: the map must draw member nodes");

  for (const node of memberNodes) {
    assert.equal(index.get(node.id)?.label, node.label, node.id);
  }
});

test("no diagram yields an empty index", () => {
  assert.equal(sandbox.getNodeIndexAR(null).size, 0);
});
