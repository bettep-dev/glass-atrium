// Test-fixture delete guard: a recursive forced delete runs only on an absolute, non-root path.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { deleteDirectory } from "./lib/remove-dir.js";

describe("deleteDirectory", () => {
  const refusedRows = [
    { name: "empty path", dir: "" },
    { name: "relative path", dir: "queue-fixture" },
    { name: "filesystem root", dir: "/" },
    { name: "root spelled with a dot segment", dir: "/." },
    { name: "root spelled with a parent segment", dir: "/tmp/.." },
  ];
  for (const row of refusedRows) {
    test(`refuses ${row.name} before deleting anything`, () => {
      assert.throws(() => deleteDirectory(row.dir), /refused/);
    });
  }

  test("removes an absolute fixture tree with its contents", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "remove-dir-"));
    mkdirSync(path.join(fixture, "nested"));
    writeFileSync(path.join(fixture, "nested", "file.txt"), "fixture");
    deleteDirectory(fixture);
    assert.equal(existsSync(fixture), false);
  });
});
