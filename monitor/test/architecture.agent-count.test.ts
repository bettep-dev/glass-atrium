// Agent-count parity — the agent node of every architecture diagram states how many
// agents the install ships, as static Mermaid text. The repo's agent-registry.json is the
// roster the Dashboard and Agents screens count from, so the two must name one number.
// Runner: npx tsx --test test/architecture.agent-count.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CANONICAL_MAP, DIAGRAMS } from "../src/server/architecture/diagrams-source.js";

const REGISTRY_PATH = fileURLToPath(new URL("../../agent-registry.json", import.meta.url));
const AGENT_LABEL = /agent_layer\["(\d+) agents"\]/g;

function getRegistryAgentCount(): number {
  // `agents` is keyed by agent name, one entry per registered agent
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as { agents: Record<string, unknown> };
  return Object.keys(registry.agents).length;
}

function getStatedCounts(source: string): number[] {
  return [...source.matchAll(AGENT_LABEL)].map((m) => Number(m[1]));
}

test("every diagram's agent node states the registry's agent count", () => {
  const expected = getRegistryAgentCount();
  const surfaces = [
    ...DIAGRAMS.map((d) => ({ name: `${d.slug}.mermaid_source`, source: d.mermaid_source })),
    { name: `${CANONICAL_MAP.slug}.mermaid_drawn`, source: CANONICAL_MAP.mermaid_drawn },
  ];
  const stated = surfaces.flatMap((s) => getStatedCounts(s.source).map((n) => ({ name: s.name, n })));
  // a renamed label would match nothing and pass vacuously → the drawn map must carry one
  assert.ok(
    stated.some((s) => s.name.endsWith(".mermaid_drawn")),
    "the drawn map has no agent_layer[\"N agents\"] node",
  );
  for (const { name, n } of stated) {
    assert.strictEqual(n, expected, `${name} states ${n} agents; agent-registry.json lists ${expected}`);
  }
});
