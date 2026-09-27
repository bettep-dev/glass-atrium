// A System map node drawer links to the screen that owns that part, when one exists.
//
// Runner: npx tsx --test test/architecture.owning-screen.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH_SRC = resolve(__dirname, "../public/src/screens/architecture.jsx");
const APP_SRC = resolve(__dirname, "../public/src/app.jsx");

interface OwningScreen {
  id: string;
  label: string;
}

interface OwningSandbox {
  getOwningScreenAR: (nodeId: unknown) => OwningScreen | null;
}

const sandbox = await buildScreenSandbox<OwningSandbox>(ARCH_SRC);

// app.jsx NAV → id ↔ label, the routing table the hash link must land in.
const NAV_LABEL_BY_ID = new Map(
  [...readFileSync(APP_SRC, "utf8").matchAll(/\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
);

const OWNED: Array<[string, string]> = [
  ["agent_layer", "agents"],
  ["hook_pipeline", "outcomes"],
  ["autoagent_d", "improvement"],
  ["wiki_d", "wiki"],
  ["doc_export", "clauded-docs"],
];

test("each owned part links to a real screen under the label that screen carries in the sidebar", () => {
  assert.ok(NAV_LABEL_BY_ID.size > 0, "fixture precondition: app.jsx NAV must parse");

  for (const [nodeId, screenId] of OWNED) {
    const owner = sandbox.getOwningScreenAR(nodeId);
    assert.equal(owner?.id, screenId, nodeId);
    assert.equal(owner?.label, NAV_LABEL_BY_ID.get(screenId), nodeId);
  }
});

test("a scoped mermaid id resolves to the same owner as its bare id", () => {
  for (const [nodeId] of OWNED) {
    assert.deepEqual(
      { ...sandbox.getOwningScreenAR(`v2-overview.${nodeId}`) },
      { ...sandbox.getOwningScreenAR(nodeId) },
      nodeId,
    );
  }
});

test("a part no screen owns gets no link", () => {
  for (const nodeId of ["user", "main_session", "cron", "pg_db", "", undefined]) {
    assert.equal(sandbox.getOwningScreenAR(nodeId), null, String(nodeId));
  }
});
