// Test-fixture delete behind a path guard: an empty, relative or root path is refused before any delete runs.

import { rmSync, type RmOptions } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Recursive forced delete of a test fixture directory; throws on an unguarded path instead of deleting.
 * @param remove - delete step, `rmSync` unless a test injects a recorder to observe the refusal without a real delete
 */
export function deleteDirectory(dir: string, remove: (dir: string, options: RmOptions) => void = rmSync): void {
  const guardedDir = getGuardedPathOrThrow(dir);
  remove(guardedDir, { recursive: true, force: true });
}

/**
 * Delete of a folder a test made with `mkdtemp(join(tmpdir(), prefix))`; throws unless the folder sits directly under the system temp directory and its name starts with `prefix`.
 * @param remove - delete step, `rmSync` unless a test injects a recorder to observe the refusal without a real delete
 */
export function deleteTempDirectory(dir: string, prefix: string, remove: (dir: string, options: RmOptions) => void = rmSync): void {
  const guardedDir = getGuardedPathOrThrow(dir);
  const resolved = path.resolve(guardedDir);
  const isOwnTempFolder = path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith(prefix);
  if (prefix === "" || !isOwnTempFolder) {
    throw new Error(`temp folder delete refused for path "${dir}": must be a "${prefix}" folder directly under ${tmpdir()}`);
  }
  remove(resolved, { recursive: true, force: true });
}

function getGuardedPathOrThrow(dir: string): string {
  const isRoot = path.resolve(dir) === path.parse(path.resolve(dir)).root;
  if (dir === "" || !path.isAbsolute(dir) || isRoot) {
    throw new Error(`fixture delete refused for path "${dir}": must be absolute and not the filesystem root`);
  }
  return dir;
}
