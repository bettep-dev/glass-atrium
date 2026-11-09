// Fixture Claude Code install: <root>/bin/claude → symlink to the npm layout's bin/claude.exe, with the package.json
// two levels above it. The binary is an executable script that touches a marker → a run of it is observable.

import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface BundleFixture {
  /** The launcher path the guard is given (a symlink, as on the real install). */
  claudePath: string;
  binaryPath: string;
  packageJsonPath: string;
  /** Exists only once something executed the fixture binary. */
  runMarkerPath: string;
}

export function createBundleFixture(root: string, version: string): BundleFixture {
  const packageDir = path.join(root, "lib", "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  mkdirSync(path.join(root, "bin"), { recursive: true });
  const fixture: BundleFixture = {
    claudePath: path.join(root, "bin", "claude"),
    binaryPath: path.join(packageDir, "bin", "claude.exe"),
    packageJsonPath: path.join(packageDir, "package.json"),
    runMarkerPath: path.join(root, "ran"),
  };
  writePackageVersion(fixture, version);
  writeBundle(fixture, []);
  symlinkSync(fixture.binaryPath, fixture.claudePath);
  return fixture;
}

export function writePackageVersion(fixture: BundleFixture, version: string): void {
  writeFileSync(fixture.packageJsonPath, JSON.stringify({ name: "@anthropic-ai/claude-code", version }));
}

/** Rewrites the binary: a marker-touching script whose body holds `parts` between filler lines. */
export function writeBundle(fixture: BundleFixture, parts: string[]): void {
  const body = parts.map((part) => `// filler ${"x".repeat(40)}\n${part}\n`).join("");
  writeFileSync(fixture.binaryPath, `#!/bin/sh\ntouch "${fixture.runMarkerPath}"\nexit 0\n${body}`);
  chmodSync(fixture.binaryPath, 0o755);
}

export function hasRun(fixture: BundleFixture): boolean {
  return existsSync(fixture.runMarkerPath);
}
