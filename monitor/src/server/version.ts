// Unified Atrium system version resolver — the SINGLE source of truth is
// `~/.glass-atrium/manifest.json` `version` (set to 1.0.0 by T01). The monitor
// reports this ONE system version; the former standalone 0.4.0 (health APP_VERSION
// + package.json) is removed/reconciled (plan D1 / T03).
//
// Path-resolution + graceful-degrade conventions mirror agents/registry.ts:
// env override → `~/.glass-atrium/manifest.json`, and a missing/unreadable/invalid
// manifest degrades to "unknown" (a liveness probe must NEVER crash). Resolved once
// and cached — a version change requires a monitor restart to surface, and caching
// avoids re-reading a ~32KB JSON on every /api/health probe.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const UNKNOWN_VERSION = "unknown";

export interface VersionLogger {
  warn(obj: object, msg?: string): void;
}

interface ManifestShape {
  version?: unknown;
}

let cachedVersion: string | null = null;
// warn once — a missing/corrupt manifest must not flood stderr on every probe.
let warnedOnce = false;

// env override → defaults to `~/.glass-atrium/manifest.json` (the live install
// root, matching compute-arch-drift.ts ATRIUM_ROOT). ATRIUM_MANIFEST_PATH lets
// tests point at a fixture without touching the real install.
function resolveManifestPath(): string {
  const override = process.env.ATRIUM_MANIFEST_PATH;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homedir(), ".glass-atrium", "manifest.json");
}

/**
 * Resolves the unified Atrium system version (cached after first read).
 *
 * Returns the manifest `version` string, or UNKNOWN_VERSION on any failure
 * (missing file / unreadable / invalid JSON / absent or non-string `version`).
 */
export async function getAtriumVersion(logger?: VersionLogger): Promise<string> {
  if (cachedVersion !== null) {
    return cachedVersion;
  }
  cachedVersion = await readAtriumVersion(logger);
  return cachedVersion;
}

async function readAtriumVersion(logger?: VersionLogger): Promise<string> {
  const path = resolveManifestPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    warnOnce(logger, { err: error, path }, "manifest read failed → version unknown");
    return UNKNOWN_VERSION;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnOnce(logger, { err: error, path }, "manifest JSON parse failed → version unknown");
    return UNKNOWN_VERSION;
  }
  const version = (parsed as ManifestShape | null)?.version;
  if (typeof version === "string" && version.length > 0) {
    return version;
  }
  warnOnce(logger, { path }, 'manifest has no usable "version" field → version unknown');
  return UNKNOWN_VERSION;
}

function warnOnce(logger: VersionLogger | undefined, obj: object, msg: string): void {
  if (warnedOnce) {
    return;
  }
  warnedOnce = true;
  logger?.warn(obj, msg);
}

/** Test hook — resets the cached version + warn flag. Do not call from production code. */
export function resetAtriumVersionCache(): void {
  cachedVersion = null;
  warnedOnce = false;
}
