// Integration tests for GET /api/clauded-docs/groups stage semantics: a group's stage is its
// least-advanced member over the WHOLE group, and the doc_status chip filter selects groups by
// that same stage — so the listed groups and the chip counts agree.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerClaudedDocsRoutes } from "../src/server/routes/clauded-docs.js";
import { resetDocsRootCache } from "../src/server/clauded-docs/storage.js";

const SUITE_MARKER = `groups-stage-test-${randomUUID()}`;
// Unique author = the listing scope, so rows from other suites never enter the counts.
const AUTHOR = `author-${randomUUID()}`;

let htmlSuiteRoot: string;
let app: FastifyInstance;

interface GroupRow {
  folder_id: number | null;
  representative_id: number;
  group_doc_status: string;
  group_stage_uniform: boolean;
}

interface GroupsBody {
  total: number;
  groups: GroupRow[];
  group_counts: { total: number; open: number; done: number };
}

async function postDoc(label: string, docStatus: string, folderId?: number): Promise<number> {
  const title = `${SUITE_MARKER}-${label}`;
  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs",
    payload: {
      title,
      prefix: "계획",
      doc_status: docStatus,
      author: AUTHOR,
      html_body:
        '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>x</title></head>' +
        `<body><main><h1>${title}</h1><p>${label}</p></main></body></html>`,
      ...(folderId === undefined ? {} : { folder_id: folderId }),
    },
  });
  assert.strictEqual(res.statusCode, 201, `seed ${label} POST 201`);
  return (res.json() as { id: number }).id;
}

async function getGroups(docStatus: string): Promise<GroupsBody> {
  const res = await app.inject({
    method: "GET",
    url: `/api/clauded-docs/groups?author=${AUTHOR}&doc_status=${docStatus}`,
  });
  assert.strictEqual(res.statusCode, 200, `groups ?doc_status=${docStatus} 200`);
  return res.json() as GroupsBody;
}

let mixedFolderId: number;

before(async () => {
  htmlSuiteRoot = mkdtempSync(join(tmpdir(), "clauded-docs-groups-stage-html-"));
  process.env.CLAUDED_DOCS_HTML_ROOT = htmlSuiteRoot;
  resetDocsRootCache();

  app = Fastify({ logger: false });
  await registerClaudedDocsRoutes(app);
  await app.ready();

  // Corpus: open single · mixed group {doc_review, done} · done single · all-done group.
  mixedFolderId = await postDoc("open-single", "doc_review");
  await postDoc("mixed-open", "doc_review", mixedFolderId);
  await postDoc("mixed-done", "done", mixedFolderId);
  const doneAnchor = await postDoc("done-single", "done");
  await postDoc("all-done-1", "done", doneAnchor);
  await postDoc("all-done-2", "done", doneAnchor);
});

after(async () => {
  await app.close();
  try {
    await getPrisma().$executeRaw`
      DELETE FROM monitor.documents WHERE title LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    console.error("[groups-stage-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
  rmSync(htmlSuiteRoot, { recursive: true, force: true });
  delete process.env.CLAUDED_DOCS_HTML_ROOT;
  resetDocsRootCache();
});

test("chip filter lists exactly the groups its chip counts, each at the filtered group stage", async () => {
  for (const filter of ["open", "done"] as const) {
    const body = await getGroups(filter);
    assert.strictEqual(body.groups.length, body.group_counts[filter], `${filter}: listed = chip count`);
    assert.strictEqual(body.total, body.group_counts[filter], `${filter}: total = chip count`);
    for (const row of body.groups) {
      assert.strictEqual(row.group_doc_status === "done", filter === "done", `${filter}: row stage`);
    }
  }
});

test("a group with an open member is open under every filter and states that its members differ", async () => {
  const done = await getGroups("done");
  assert.ok(!done.groups.some((row) => row.folder_id === mixedFolderId), "mixed group absent under done");

  const open = await getGroups("open");
  const mixed = open.groups.find((row) => row.folder_id === mixedFolderId);
  assert.ok(mixed !== undefined, "mixed group listed under open");
  assert.strictEqual(mixed.group_doc_status, "doc_review", "least-advanced member stage");
  assert.strictEqual(mixed.group_stage_uniform, false, "a done member makes the group non-uniform");
});
