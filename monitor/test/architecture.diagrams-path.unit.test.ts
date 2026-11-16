// GET /api/architecture/diagrams leaves the Mac on the remote listener → its response names no absolute local path.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/architecture.diagrams-path.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";

import { registerArchitectureRoutes } from "../src/server/routes/architecture.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the diagrams response carries a repo-relative doc_path and no absolute local path", async () => {
  const app = Fastify({ logger: false });
  await registerArchitectureRoutes(app);
  try {
    const response = await app.inject({ method: "GET", url: "/api/architecture/diagrams" });
    assert.equal(response.statusCode, 200, response.body);
    const docPath = (JSON.parse(response.body) as { doc_path: string }).doc_path;
    assert.equal(docPath, "monitor/src/server/architecture/diagrams-source.ts");
    await access(path.join(REPO_ROOT, docPath));
    assert.ok(!response.body.includes(homedir()), "the home directory appears in the response");
    assert.ok(!response.body.includes(REPO_ROOT), "the checkout path appears in the response");
  } finally {
    await app.close();
  }
});
