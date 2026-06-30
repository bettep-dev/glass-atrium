// Tests for the unified Atrium system version (T03) — the monitor reports ONE
// version sourced from ~/.glass-atrium/manifest.json `version`; the former
// standalone 0.4.0 is gone. Covers the version resolver (graceful degrade to
// "unknown") AND the AC: /api/health `version` equals the manifest version.
// Runner: npx tsx --test test/health-version.unit.test.ts

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import {
  getAtriumVersion,
  resetAtriumVersionCache,
  UNKNOWN_VERSION,
} from "../src/server/version.js";
import { registerHealthRoute } from "../src/server/routes/health.js";
import { disconnectPrisma } from "../src/server/db.js";

let tmp: string;
const ORIGINAL_MANIFEST_PATH = process.env.ATRIUM_MANIFEST_PATH;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "atrium-version-"));
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (ORIGINAL_MANIFEST_PATH === undefined) {
    delete process.env.ATRIUM_MANIFEST_PATH;
  } else {
    process.env.ATRIUM_MANIFEST_PATH = ORIGINAL_MANIFEST_PATH;
  }
  resetAtriumVersionCache();
  await disconnectPrisma();
});

// Each case re-reads from scratch — the resolver caches after first read.
beforeEach(() => {
  resetAtriumVersionCache();
});

async function writeManifest(name: string, content: string): Promise<string> {
  const path = join(tmp, name);
  await writeFile(path, content, "utf8");
  return path;
}

test("resolver reads the `version` field from a valid manifest", async () => {
  process.env.ATRIUM_MANIFEST_PATH = await writeManifest(
    "valid.json",
    JSON.stringify({ version: "1.0.0", files: ["a", "b"] }),
  );
  assert.strictEqual(await getAtriumVersion(), "1.0.0");
});

test("resolver degrades to 'unknown' when the manifest is missing", async () => {
  process.env.ATRIUM_MANIFEST_PATH = join(tmp, "does-not-exist.json");
  assert.strictEqual(await getAtriumVersion(), UNKNOWN_VERSION);
});

test("resolver degrades to 'unknown' on invalid JSON", async () => {
  process.env.ATRIUM_MANIFEST_PATH = await writeManifest("broken.json", "{ not valid json");
  assert.strictEqual(await getAtriumVersion(), UNKNOWN_VERSION);
});

test("resolver degrades to 'unknown' when `version` is absent", async () => {
  process.env.ATRIUM_MANIFEST_PATH = await writeManifest(
    "no-version.json",
    JSON.stringify({ files: ["a"] }),
  );
  assert.strictEqual(await getAtriumVersion(), UNKNOWN_VERSION);
});

test("resolver caches the first read (re-reads only after reset)", async () => {
  process.env.ATRIUM_MANIFEST_PATH = await writeManifest("first.json", JSON.stringify({ version: "1.0.0" }));
  assert.strictEqual(await getAtriumVersion(), "1.0.0");
  // Point at a different version — cached value persists until reset.
  process.env.ATRIUM_MANIFEST_PATH = await writeManifest("second.json", JSON.stringify({ version: "2.0.0" }));
  assert.strictEqual(await getAtriumVersion(), "1.0.0");
  resetAtriumVersionCache();
  assert.strictEqual(await getAtriumVersion(), "2.0.0");
});

// AC: /api/health reports the manifest version (proves health DERIVES from the
// manifest, not a hardcoded literal). Distinctive value cannot match any constant.
// getPrisma() needs DATABASE_URL (read outside the route try/catch) → skip without it.
test(
  "GET /api/health reports the manifest `version`",
  { skip: process.env.DATABASE_URL ? false : "DATABASE_URL not set (route needs Prisma)" },
  async () => {
    const manifestVersion = "9.9.9-test";
    process.env.ATRIUM_MANIFEST_PATH = await writeManifest(
      "health.json",
      JSON.stringify({ version: manifestVersion }),
    );
    resetAtriumVersionCache();

    const app: FastifyInstance = Fastify({ logger: false });
    try {
      await registerHealthRoute(app);
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/api/health" });
      assert.strictEqual(res.statusCode, 200);
      const body = res.json() as { version: string };
      assert.strictEqual(body.version, manifestVersion, "/api/health version must equal the manifest version");
    } finally {
      await app.close();
    }
  },
);
