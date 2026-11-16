// Test-fixture delete guard: a recursive forced delete runs only on an absolute, non-root path,
// and a temp-folder delete only on a folder directly under the system temp directory carrying the test's prefix.
// Refused rows pass a recording remover → a regressed guard records a call instead of deleting a real path.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, type RmOptions } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { deleteDirectory, deleteTempDirectory } from "./lib/remove-dir.js";

interface RemoveCall {
  dir: string;
  options: RmOptions;
}

function createRecordingRemover(): { calls: RemoveCall[]; remove: (dir: string, options: RmOptions) => void } {
  const calls: RemoveCall[] = [];
  return { calls, remove: (dir, options) => void calls.push({ dir, options }) };
}

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
      const remover = createRecordingRemover();
      assert.throws(() => deleteDirectory(row.dir, remover.remove), /refused/);
      assert.deepEqual(remover.calls, [], "a refused path never reaches the remover");
    });
  }

  test("hands an absolute path to the remover as one recursive forced delete", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "remove-dir-"));
    const remover = createRecordingRemover();
    deleteDirectory(fixture, remover.remove);
    assert.deepEqual(remover.calls, [{ dir: fixture, options: { recursive: true, force: true } }]);
    deleteDirectory(fixture);
  });

  test("removes an absolute fixture tree with its contents", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "remove-dir-"));
    mkdirSync(path.join(fixture, "nested"));
    writeFileSync(path.join(fixture, "nested", "file.txt"), "fixture");
    deleteDirectory(fixture);
    assert.equal(existsSync(fixture), false);
  });
});

describe("deleteTempDirectory", () => {
  const prefix = "remove-dir-temp-";
  const refusedRows = [
    { name: "empty path", dir: "" },
    { name: "relative path carrying the prefix", dir: `${prefix}abc` },
    { name: "absolute path outside the temp directory", dir: path.join(path.parse(tmpdir()).root, "Users", `${prefix}abc`) },
    { name: "temp-directory folder without the prefix", dir: path.join(tmpdir(), "queue-fixture-abc") },
    { name: "prefixed folder nested below another temp folder", dir: path.join(tmpdir(), "other", `${prefix}abc`) },
    { name: "path climbing out of a prefixed folder", dir: path.join(tmpdir(), `${prefix}abc`, "..", "..") },
    { name: "the temp directory itself", dir: tmpdir() },
  ];
  for (const row of refusedRows) {
    test(`refuses ${row.name} before deleting anything`, () => {
      const remover = createRecordingRemover();
      assert.throws(() => deleteTempDirectory(row.dir, prefix, remover.remove), /refused/);
      assert.deepEqual(remover.calls, [], "a refused path never reaches the remover");
    });
  }

  test("removes a prefixed folder made directly under the temp directory, with its contents", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), prefix));
    writeFileSync(path.join(fixture, "shot.png"), "fixture");
    deleteTempDirectory(fixture, prefix);
    assert.equal(existsSync(fixture), false);
  });
});
