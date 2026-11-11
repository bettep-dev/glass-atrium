// Test-fixture delete behind a path guard: an empty, relative or root path is refused before any delete runs.

import { rmSync, type RmOptions } from "node:fs";
import path from "node:path";

/**
 * Recursive forced delete of a test fixture directory; throws on an unguarded path instead of deleting.
 * @param remove - delete step, `rmSync` unless a test injects a recorder to observe the refusal without a real delete
 */
export function deleteDirectory(dir: string, remove: (dir: string, options: RmOptions) => void = rmSync): void {
  const guardedDir = getGuardedPathOrThrow(dir);
  remove(guardedDir, { recursive: true, force: true });
}

function getGuardedPathOrThrow(dir: string): string {
  const isRoot = path.resolve(dir) === path.parse(path.resolve(dir)).root;
  if (dir === "" || !path.isAbsolute(dir) || isRoot) {
    throw new Error(`fixture delete refused for path "${dir}": must be absolute and not the filesystem root`);
  }
  return dir;
}
