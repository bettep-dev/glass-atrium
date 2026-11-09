// Test-fixture delete behind a path guard: an empty, relative or root path is refused before any delete runs.

import { rmSync } from "node:fs";
import path from "node:path";

/** Recursive forced delete of a test fixture directory; throws on an unguarded path instead of deleting. */
export function deleteDirectory(dir: string): void {
  const guardedDir = getGuardedPath(dir);
  rmSync(guardedDir, { recursive: true, force: true });
}

function getGuardedPath(dir: string): string {
  const isRoot = path.resolve(dir) === path.parse(path.resolve(dir)).root;
  if (dir === "" || !path.isAbsolute(dir) || isRoot) {
    throw new Error(`fixture delete refused for path "${dir}": must be absolute and not the filesystem root`);
  }
  return dir;
}
