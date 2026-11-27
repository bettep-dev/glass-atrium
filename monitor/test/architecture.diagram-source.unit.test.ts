// The architecture screen hands /api/architecture/diagrams → mermaid_source to mermaid and mounts the SVG as raw markup
// (architecture.jsx → MermaidCanvas); that sink is safe only while every source it draws is the repository's own.
// Runner: npx tsx --test test/architecture.diagram-source.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import Fastify from "fastify";

import { CANONICAL_MAP, DIAGRAMS } from "../src/server/architecture/diagrams-source.js";
import { registerArchitectureRoutes } from "../src/server/routes/architecture.js";

const REPOSITORY_SOURCES = new Set<string>([CANONICAL_MAP.mermaid_drawn, ...DIAGRAMS.map((diagram) => diagram.mermaid_source)]);

test("every diagram source the route serves is one compiled into the repository, whatever the request carries", async () => {
  const app = Fastify({ logger: false });
  await registerArchitectureRoutes(app);
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/architecture/diagrams?source=%3Cform%3E&doc=1",
      headers: { "x-diagram-source": "flowchart LR\n  A[\"<form><button>Send</button></form>\"]" },
    });

    assert.equal(res.statusCode, 200);
    const served = (res.json() as { diagrams: Array<{ id: string; mermaid_source?: string }> }).diagrams;
    assert.ok(served.length > 0, "the route serves diagrams");
    for (const diagram of served) {
      assert.ok(diagram.mermaid_source !== undefined && REPOSITORY_SOURCES.has(diagram.mermaid_source), `${diagram.id}: a repository source`);
    }
  } finally {
    await app.close();
  }
});
