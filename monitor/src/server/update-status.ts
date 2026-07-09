// Update-availability resolver — tells the dashboard whether a newer Atrium RELEASE exists, comparing the
// local installed version (version.ts → manifest.json `version`) against the LATEST GitHub Release's
// manifest.json `version`, fetched over HTTPS.
//
// Safety contract — every branch degrades, NEVER throws on the dashboard path:
//   - source-dev tree (symlinked maintainer checkout) → "source-dev", check SUPPRESSED (badge never fires on
//     the dev machine). Grounded marker: the release bundle is `tar … -T <manifest.files>` and manifest.files
//     comes from `git ls-files`, which NEVER includes `.git/` — so a relocated install has no `.git`, the maintainer tree does → `.git` presence == source-dev.
//   - release repo unconfigured → "unknown"; network / parse failure → "unknown", logged warn-once.
//   - read from a TAGGED RELEASE asset over HTTPS, NEVER raw `main` (gate G5); the remote check is TTL-CACHED.
//
// Transport mirrors publish-release.sh: release tag `v<manifest.version>` carrying a `manifest.json` asset;
// repo slug resolves ATRIUM_RELEASE_REPO env → config.toml [release].repo.

import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getAtriumVersion, UNKNOWN_VERSION, type VersionLogger } from "./version.js";
import type { UpdateStatusResponse, UpdateStatusVerdict } from "./types/dashboard.js";

const GH_USER_AGENT = "glass-atrium-monitor";
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min — passive badge, no need to be fresh-to-the-second.
const DEFAULT_TIMEOUT_MS = 5000;

// Cached verdict + warn-once flag (mirrors version.ts) — a missing/unreachable
// release must not flood stderr nor re-hit GitHub on every dashboard load.
let cache: { body: UpdateStatusResponse; expiresAt: number } | null = null;
let warnedOnce = false;

export interface GetUpdateStatusOptions {
  logger?: VersionLogger;
  // Test seams — production omits all of these and uses the real implementations.
  localVersion?: () => Promise<string>;
  isSourceDev?: () => Promise<boolean>;
  releaseSlug?: () => Promise<string | null>;
  fetchLatest?: (slug: string) => Promise<string | null>;
  now?: () => Date;
  ttlMs?: number;
  bypassCache?: boolean;
}

/**
 * Resolves the dashboard update-availability verdict (cached for `ttlMs`).
 *
 * NEVER throws — every failure path degrades to a typed "unknown"/"source-dev"
 * body so the dashboard route stays a non-throwing read.
 */
export async function getUpdateStatus(
  options: GetUpdateStatusOptions = {},
): Promise<UpdateStatusResponse> {
  const nowFn = options.now ?? (() => new Date());
  const ttl = options.ttlMs ?? resolveTtlMs();
  const now = nowFn();

  if (!options.bypassCache && cache !== null && now.getTime() < cache.expiresAt) {
    return cache.body;
  }

  const body = await computeUpdateStatus(options, now);

  if (!options.bypassCache) {
    cache = { body, expiresAt: now.getTime() + ttl };
  }
  return body;
}

async function computeUpdateStatus(
  options: GetUpdateStatusOptions,
  now: Date,
): Promise<UpdateStatusResponse> {
  const logger = options.logger;
  let localVersion = UNKNOWN_VERSION;
  try {
    localVersion = await (options.localVersion ?? (() => getAtriumVersion(logger)))();

    // Source-dev (maintainer) tree → suppress the check entirely (badge inert).
    const sourceDev = await (options.isSourceDev ?? defaultIsSourceDev)();
    if (sourceDev) {
      return build(
        "source-dev",
        localVersion,
        null,
        "source-dev tree (symlinked maintainer install) — update check suppressed",
        now,
      );
    }

    if (localVersion === UNKNOWN_VERSION) {
      return build("unknown", localVersion, null, "local version unknown", now);
    }

    const slug = await (options.releaseSlug ?? defaultReleaseSlug)();
    if (slug === null) {
      return build("unknown", localVersion, null, "release repo not configured", now);
    }

    const fetchLatest =
      options.fetchLatest ??
      ((s: string) => fetchLatestReleaseVersion(s, resolveTimeoutMs(), logger));
    const latestVersion = await fetchLatest(slug);
    if (latestVersion === null) {
      return build("unknown", localVersion, null, "latest release unreachable", now);
    }

    // v-prefix tolerant compare (e.g. tag `v1.2.3` vs manifest `1.2.3`).
    const cmp = compareSemver(localVersion, latestVersion);
    if (cmp === null) {
      return build(
        "unknown",
        localVersion,
        latestVersion,
        "version compare failed (malformed semver)",
        now,
      );
    }
    // local behind → update available; equal or ahead → current.
    if (cmp < 0) {
      return build("update-available", localVersion, latestVersion, null, now);
    }
    return build("current", localVersion, latestVersion, null, now);
  } catch (error) {
    warnOnce(logger, { err: error }, "update-status check failed → unknown");
    return build("unknown", localVersion, null, "update check error", now);
  }
}

function build(
  status: UpdateStatusVerdict,
  localVersion: string,
  latestVersion: string | null,
  reason: string | null,
  now: Date,
): UpdateStatusResponse {
  return {
    status,
    local_version: localVersion,
    latest_version: latestVersion,
    reason,
    checked_at: now.toISOString(),
  };
}

// source-dev detection

// ATRIUM_ROOT env override (test hook) → ~/.glass-atrium default install root (matches compute-arch-drift.ts ATRIUM_ROOT).
function resolveAtriumRoot(): string {
  const override = process.env.ATRIUM_ROOT;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homedir(), ".glass-atrium");
}

async function defaultIsSourceDev(): Promise<boolean> {
  try {
    // `.git` (dir or file) at the Atrium root == maintainer source tree; a relocated consumer install (extracted bundle) has none.
    await access(join(resolveAtriumRoot(), ".git"));
    return true;
  } catch {
    return false;
  }
}

// release repo slug

// ATRIUM_RELEASE_REPO env → config.toml [release].repo → null (mirrors publish-release.sh repo_slug; null == unconfigured).
async function defaultReleaseSlug(): Promise<string | null> {
  const fromEnv = process.env.ATRIUM_RELEASE_REPO;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return readReleaseRepoFromConfig(resolveConfigTomlPath());
}

// ATRIUM_CONFIG_TOML env (test/sandbox override) → <root>/config.toml (mirrors atrium-config.sh atrium_config_file()).
function resolveConfigTomlPath(): string {
  const override = process.env.ATRIUM_CONFIG_TOML;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(resolveAtriumRoot(), "config.toml");
}

// Minimal table-scoped read of [release].repo (no TOML-parser dependency — mirrors atrium-config.sh's awk approach).
// A repo slug never contains '#', so splitting an inline comment on '#' is safe for this key.
async function readReleaseRepoFromConfig(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let inRelease = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inRelease = trimmed.replace(/\s+/g, "") === "[release]";
      continue;
    }
    if (!inRelease) {
      continue;
    }
    const noComment = trimmed.split("#")[0]?.trim() ?? "";
    const match = noComment.match(/^repo\s*=\s*(.*)$/);
    if (match) {
      const value = (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

// remote release fetch (HTTPS, tagged release asset, never raw main)

interface GithubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}
interface GithubRelease {
  tag_name?: unknown;
  assets?: unknown;
}

// Reads the latest GitHub Release's version: prefer the manifest.json asset's `.version`, else the release tag (v<version> per publish-release.sh).
// Returns null (NOT throw) on any HTTP / network / parse failure.
async function fetchLatestReleaseVersion(
  slug: string,
  timeoutMs: number,
  logger: VersionLogger | undefined,
): Promise<string | null> {
  const apiUrl = `https://api.github.com/repos/${slug}/releases/latest`;
  let release: GithubRelease;
  try {
    const res = await fetch(apiUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": GH_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      warnOnce(logger, { slug, statusCode: res.status }, "GitHub releases/latest non-OK → unknown");
      return null;
    }
    release = (await res.json()) as GithubRelease;
  } catch (error) {
    warnOnce(logger, { err: error, slug }, "GitHub releases/latest fetch failed → unknown");
    return null;
  }

  const assetUrl = findManifestAssetUrl(release.assets);
  if (assetUrl !== null) {
    const fromAsset = await fetchManifestVersion(assetUrl, timeoutMs);
    if (fromAsset !== null) {
      return fromAsset;
    }
  }
  // Fallback: the release tag encodes the version (v<manifest.version>).
  return typeof release.tag_name === "string" && release.tag_name.length > 0
    ? release.tag_name
    : null;
}

function findManifestAssetUrl(assets: unknown): string | null {
  if (!Array.isArray(assets)) {
    return null;
  }
  for (const asset of assets as GithubReleaseAsset[]) {
    if (asset !== null && typeof asset === "object" && asset.name === "manifest.json") {
      const url = asset.browser_download_url;
      if (typeof url === "string" && url.length > 0) {
        return url;
      }
    }
  }
  return null;
}

// Downloads + parses the release manifest.json asset, returning its `.version`.
async function fetchManifestVersion(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/octet-stream", "User-Agent": GH_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return null;
    }
    const parsed = JSON.parse(await res.text()) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

// semver compare (v-prefix tolerant, SemVer 2.0.0 precedence)

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  // Empty == a release (no pre-release); a pre-release has LOWER precedence.
  prerelease: string[];
}

function parseSemver(input: string): ParsedSemver | null {
  if (typeof input !== "string") {
    return null;
  }
  let rest = input.trim();
  if (rest.length === 0) {
    return null;
  }
  if (rest[0] === "v" || rest[0] === "V") {
    rest = rest.slice(1);
  }
  // Build metadata (`+…`) is ignored for precedence.
  const plus = rest.indexOf("+");
  if (plus !== -1) {
    rest = rest.slice(0, plus);
  }

  let prerelease: string[] = [];
  const dash = rest.indexOf("-");
  let core = rest;
  if (dash !== -1) {
    core = rest.slice(0, dash);
    const pr = rest.slice(dash + 1);
    if (pr.length === 0) {
      return null;
    }
    prerelease = pr.split(".");
    if (prerelease.some((id) => id.length === 0 || !/^[0-9A-Za-z-]+$/.test(id))) {
      return null;
    }
  }

  const parts = core.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    nums.push(Number(part));
  }
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, prerelease };
}

/**
 * Compares two version strings (v-prefix tolerant) per SemVer 2.0.0 precedence.
 * Returns -1 (a < b), 0 (equal), 1 (a > b), or null when either is malformed.
 */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) {
    return null;
  }
  if (pa.major !== pb.major) {
    return pa.major < pb.major ? -1 : 1;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor < pb.minor ? -1 : 1;
  }
  if (pa.patch !== pb.patch) {
    return pa.patch < pb.patch ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  // A release (no pre-release) outranks a pre-release at the same core version.
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) {
        return diff < 0 ? -1 : 1;
      }
    } else if (aNum !== bNum) {
      // Numeric identifiers have lower precedence than alphanumeric.
      return aNum ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  if (a.length === b.length) {
    return 0;
  }
  // All preceding identifiers equal → the larger set has higher precedence.
  return a.length < b.length ? -1 : 1;
}

// env + warn helpers

function resolveTtlMs(): number {
  return readPositiveIntEnv("ATRIUM_UPDATE_CHECK_TTL_MS", DEFAULT_TTL_MS);
}

function resolveTimeoutMs(): number {
  return readPositiveIntEnv("ATRIUM_UPDATE_CHECK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function warnOnce(logger: VersionLogger | undefined, obj: object, msg: string): void {
  if (warnedOnce) {
    return;
  }
  warnedOnce = true;
  logger?.warn(obj, msg);
}

/** Test hook — clears the cached verdict + warn-once flag. Not for production. */
export function resetUpdateStatusCache(): void {
  cache = null;
  warnedOnce = false;
}
