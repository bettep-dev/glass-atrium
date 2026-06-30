// Tests for the dashboard update-availability resolver (plan E2 / T06).
// Covers: semver compare edge cases (v-prefix, multi-digit, pre-release,
// malformed), the verdict orchestration (behind/current/unknown/source-dev), the
// unconfigured-repo + network-failure degrades, the source-dev suppression, the
// real HTTPS fetch path (globalThis.fetch MOCKED — no real network), TTL caching,
// and the /api/dashboard/update-status route integration.
// Runner: npx tsx --test test/dashboard.update-status.unit.test.ts

import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import {
  compareSemver,
  getUpdateStatus,
  resetUpdateStatusCache,
} from "../src/server/update-status.js";
import { registerDashboardRoutes } from "../src/server/routes/dashboard.js";
import { resetAtriumVersionCache } from "../src/server/version.js";

// ----- env snapshot/restore so cases never leak into one another -------------

const ENV_KEYS = [
  "ATRIUM_ROOT",
  "ATRIUM_RELEASE_REPO",
  "ATRIUM_CONFIG_TOML",
  "ATRIUM_MANIFEST_PATH",
  "ATRIUM_UPDATE_CHECK_TTL_MS",
  "ATRIUM_UPDATE_CHECK_TIMEOUT_MS",
] as const;

const envSnapshot = new Map<string, string | undefined>();
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    envSnapshot.set(key, process.env[key]);
    delete process.env[key];
  }
  resetUpdateStatusCache();
  resetAtriumVersionCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prior = envSnapshot.get(key);
    if (prior === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prior;
    }
  }
  globalThis.fetch = ORIGINAL_FETCH;
  resetUpdateStatusCache();
  resetAtriumVersionCache();
});

// ----- fake fetch helpers ----------------------------------------------------

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}

function fakeResponse(init: FakeResponseInit): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => init.json,
    text: async () => init.text ?? JSON.stringify(init.json ?? {}),
  } as unknown as Response;
}

// Routes a fetch by URL substring: api.github.com → the release JSON, anything
// else (the asset download URL) → the manifest.json body.
function installFetchRouter(
  releaseInit: FakeResponseInit,
  assetInit: FakeResponseInit | null,
): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("api.github.com")) {
      return fakeResponse(releaseInit);
    }
    if (assetInit !== null) {
      return fakeResponse(assetInit);
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  return { calls };
}

// ====== compareSemver ========================================================

test("compareSemver: equal versions → 0", () => {
  assert.strictEqual(compareSemver("1.2.3", "1.2.3"), 0);
});

test("compareSemver: behind → -1, ahead → 1", () => {
  assert.strictEqual(compareSemver("1.0.0", "2.0.0"), -1);
  assert.strictEqual(compareSemver("2.0.0", "1.0.0"), 1);
});

test("compareSemver: v-prefix is tolerated on either side (v1.2.3 == 1.2.3)", () => {
  assert.strictEqual(compareSemver("v1.2.3", "1.2.3"), 0);
  assert.strictEqual(compareSemver("1.2.3", "v1.2.4"), -1);
  assert.strictEqual(compareSemver("V2.0.0", "v2.0.0"), 0);
});

test("compareSemver: multi-digit components compare numerically, not lexically", () => {
  // Lexical compare would wrongly rank "1.9.0" above "1.10.0".
  assert.strictEqual(compareSemver("1.9.0", "1.10.0"), -1);
  assert.strictEqual(compareSemver("1.0.20", "1.0.3"), 1);
  assert.strictEqual(compareSemver("10.0.0", "9.99.99"), 1);
});

test("compareSemver: pre-release ranks below its release (SemVer §11)", () => {
  assert.strictEqual(compareSemver("1.0.0-alpha", "1.0.0"), -1);
  assert.strictEqual(compareSemver("1.0.0", "1.0.0-rc.1"), 1);
});

test("compareSemver: pre-release identifier precedence", () => {
  assert.strictEqual(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"), -1); // fewer fields < more
  assert.strictEqual(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.2"), -1); // numeric compare
  assert.strictEqual(compareSemver("1.0.0-alpha.1", "1.0.0-beta"), -1); // numeric < alphanumeric
  assert.strictEqual(compareSemver("1.0.0-beta.2", "1.0.0-beta.11"), -1); // numeric, not lexical
});

test("compareSemver: build metadata is ignored for precedence", () => {
  assert.strictEqual(compareSemver("1.2.3+build.99", "1.2.3"), 0);
});

test("compareSemver: malformed input → null", () => {
  assert.strictEqual(compareSemver("1.2", "1.2.3"), null);
  assert.strictEqual(compareSemver("not-a-version", "1.0.0"), null);
  assert.strictEqual(compareSemver("1.2.3", ""), null);
  assert.strictEqual(compareSemver("1.x.0", "1.2.0"), null);
  assert.strictEqual(compareSemver("1.2.3.4", "1.2.3"), null);
});

// ====== getUpdateStatus — verdict orchestration (seam-driven) ================

const NO_SOURCE_DEV = async (): Promise<boolean> => false;
const SLUG = async (): Promise<string | null> => "owner/atrium";

test("getUpdateStatus: local behind release → update-available", async () => {
  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "1.0.0",
    releaseSlug: SLUG,
    fetchLatest: async () => "1.1.0",
  });
  assert.strictEqual(body.status, "update-available");
  assert.strictEqual(body.local_version, "1.0.0");
  assert.strictEqual(body.latest_version, "1.1.0");
  assert.strictEqual(body.reason, null);
  assert.ok(!Number.isNaN(Date.parse(body.checked_at)), "checked_at is an ISO instant");
});

test("getUpdateStatus: local equal to release → current", async () => {
  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "1.2.3",
    releaseSlug: SLUG,
    fetchLatest: async () => "v1.2.3",
  });
  assert.strictEqual(body.status, "current");
});

test("getUpdateStatus: local ahead of release → current (no downgrade signal)", async () => {
  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "2.0.0",
    releaseSlug: SLUG,
    fetchLatest: async () => "1.9.9",
  });
  assert.strictEqual(body.status, "current");
});

test("getUpdateStatus: HTTPS fetch failure → unknown (never throws)", async () => {
  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "1.0.0",
    releaseSlug: SLUG,
    fetchLatest: async () => null,
  });
  assert.strictEqual(body.status, "unknown");
  assert.strictEqual(body.latest_version, null);
  assert.match(body.reason ?? "", /unreachable/);
});

test("getUpdateStatus: release repo unconfigured → unknown", async () => {
  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "1.0.0",
    releaseSlug: async () => null,
  });
  assert.strictEqual(body.status, "unknown");
  assert.match(body.reason ?? "", /not configured/);
});

test("getUpdateStatus: source-dev tree → suppressed (check never runs)", async () => {
  let fetched = false;
  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: async () => true,
    localVersion: async () => "1.0.0",
    releaseSlug: SLUG,
    fetchLatest: async () => {
      fetched = true;
      return "9.9.9";
    },
  });
  assert.strictEqual(body.status, "source-dev");
  assert.strictEqual(body.latest_version, null);
  assert.strictEqual(fetched, false, "no remote check on the source-dev tree");
});

test("getUpdateStatus: local version unknown → unknown verdict", async () => {
  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "unknown",
    releaseSlug: SLUG,
    fetchLatest: async () => "1.0.0",
  });
  assert.strictEqual(body.status, "unknown");
  assert.match(body.reason ?? "", /local version unknown/);
});

test("getUpdateStatus: malformed remote version → unknown", async () => {
  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "1.0.0",
    releaseSlug: SLUG,
    fetchLatest: async () => "garbage",
  });
  assert.strictEqual(body.status, "unknown");
  assert.match(body.reason ?? "", /compare failed/);
});

test("getUpdateStatus: a throwing seam degrades to unknown, never propagates", async () => {
  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "1.0.0",
    releaseSlug: SLUG,
    fetchLatest: async () => {
      throw new Error("boom");
    },
  });
  assert.strictEqual(body.status, "unknown");
  assert.match(body.reason ?? "", /update check error/);
});

// ====== caching ==============================================================

test("getUpdateStatus: caches within TTL, refetches after expiry", async () => {
  let calls = 0;
  let fakeNow = new Date("2026-06-30T00:00:00.000Z");
  const opts = {
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "1.0.0",
    releaseSlug: SLUG,
    fetchLatest: async () => {
      calls += 1;
      return "1.1.0";
    },
    ttlMs: 60_000,
    now: () => fakeNow,
  };

  await getUpdateStatus(opts);
  await getUpdateStatus(opts); // within TTL → served from cache
  assert.strictEqual(calls, 1, "second call within TTL is cached");

  fakeNow = new Date(fakeNow.getTime() + 61_000); // past TTL
  await getUpdateStatus(opts);
  assert.strictEqual(calls, 2, "call after TTL expiry refetches");
});

// ====== real HTTPS fetch path (globalThis.fetch MOCKED — no real network) ====

test("real fetch path: manifest.json asset version drives the verdict", async () => {
  process.env.ATRIUM_UPDATE_CHECK_TIMEOUT_MS = "200";
  const { calls } = installFetchRouter(
    {
      json: {
        tag_name: "v1.5.0",
        assets: [
          { name: "glass-atrium-bundle-1.5.0.tar.gz", browser_download_url: "https://x/bundle" },
          { name: "manifest.json", browser_download_url: "https://x/manifest.json" },
        ],
      },
    },
    { json: { version: "1.5.0" } },
  );

  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "1.0.0",
    releaseSlug: SLUG,
  });
  assert.strictEqual(body.status, "update-available");
  assert.strictEqual(body.latest_version, "1.5.0");
  assert.strictEqual(calls.length, 2, "one API call + one asset download");
  assert.match(calls[0] ?? "", /api\.github\.com\/repos\/owner\/atrium\/releases\/latest/);
});

test("real fetch path: falls back to the release tag when no manifest asset", async () => {
  process.env.ATRIUM_UPDATE_CHECK_TIMEOUT_MS = "200";
  installFetchRouter(
    { json: { tag_name: "v2.0.0", assets: [] } },
    null, // no asset fetch expected
  );

  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "1.0.0",
    releaseSlug: SLUG,
  });
  assert.strictEqual(body.status, "update-available");
  assert.strictEqual(body.latest_version, "v2.0.0", "tag used verbatim as the fallback source");
});

test("real fetch path: asset download failure falls back to the tag", async () => {
  process.env.ATRIUM_UPDATE_CHECK_TIMEOUT_MS = "200";
  installFetchRouter(
    {
      json: {
        tag_name: "v3.1.0",
        assets: [{ name: "manifest.json", browser_download_url: "https://x/manifest.json" }],
      },
    },
    { ok: false, status: 404 },
  );

  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "1.0.0",
    releaseSlug: SLUG,
  });
  assert.strictEqual(body.status, "update-available");
  assert.strictEqual(body.latest_version, "v3.1.0");
});

test("real fetch path: GitHub API non-OK → unknown", async () => {
  process.env.ATRIUM_UPDATE_CHECK_TIMEOUT_MS = "200";
  installFetchRouter({ ok: false, status: 404 }, null);

  const body = await getUpdateStatus({
    bypassCache: true,
    isSourceDev: NO_SOURCE_DEV,
    localVersion: async () => "1.0.0",
    releaseSlug: SLUG,
  });
  assert.strictEqual(body.status, "unknown");
  assert.strictEqual(body.latest_version, null);
});

test("real fetch path: slug resolved from config.toml [release].repo", async () => {
  process.env.ATRIUM_UPDATE_CHECK_TIMEOUT_MS = "200";
  const dir = await mkdtemp(join(tmpdir(), "atrium-cfg-"));
  const cfg = join(dir, "config.toml");
  await writeFile(
    cfg,
    ['[meta]', 'project = "glass-atrium"', "", "[release]", 'repo = "acme/atrium"  # the release repo', ""].join("\n"),
    "utf8",
  );
  process.env.ATRIUM_CONFIG_TOML = cfg;
  // ATRIUM_ROOT points at the same dir (no .git → not source-dev).
  process.env.ATRIUM_ROOT = dir;

  const { calls } = installFetchRouter({ json: { tag_name: "v1.0.0", assets: [] } }, null);

  try {
    const body = await getUpdateStatus({
      bypassCache: true,
      localVersion: async () => "1.0.0",
    });
    assert.strictEqual(body.status, "current");
    assert.match(calls[0] ?? "", /repos\/acme\/atrium\/releases\/latest/, "config slug used");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ====== route integration (/api/dashboard/update-status) =====================

async function withDashboardApp(fn: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = Fastify({ logger: false });
  try {
    await registerDashboardRoutes(app);
    await app.ready();
    await fn(app);
  } finally {
    await app.close();
  }
}

test("route: source-dev tree → 200 + status source-dev (no network)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atrium-srcdev-"));
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ version: "1.0.0" }), "utf8");
  process.env.ATRIUM_ROOT = dir;
  process.env.ATRIUM_MANIFEST_PATH = join(dir, "manifest.json");
  resetUpdateStatusCache();
  resetAtriumVersionCache();

  try {
    await withDashboardApp(async (app) => {
      const res = await app.inject({ method: "GET", url: "/api/dashboard/update-status" });
      assert.strictEqual(res.statusCode, 200);
      const body = res.json() as { status: string; local_version: string; latest_version: null };
      assert.strictEqual(body.status, "source-dev");
      assert.strictEqual(body.local_version, "1.0.0");
      assert.strictEqual(body.latest_version, null);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("route: relocated install, repo unconfigured → 200 + status unknown (no network)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atrium-reloc-")); // no .git → relocated install
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ version: "1.0.0" }), "utf8");
  process.env.ATRIUM_ROOT = dir; // config.toml absent here → slug null
  process.env.ATRIUM_MANIFEST_PATH = join(dir, "manifest.json");
  resetUpdateStatusCache();
  resetAtriumVersionCache();

  try {
    await withDashboardApp(async (app) => {
      const res = await app.inject({ method: "GET", url: "/api/dashboard/update-status" });
      assert.strictEqual(res.statusCode, 200);
      const body = res.json() as { status: string; local_version: string; reason: string };
      assert.strictEqual(body.status, "unknown");
      assert.strictEqual(body.local_version, "1.0.0");
      assert.match(body.reason, /not configured/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
