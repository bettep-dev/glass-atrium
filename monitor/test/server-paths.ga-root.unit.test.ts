// Unit tests for the GA data-separation root on the server's external-surface path
// resolvers (daemon-apply.sh + the clauded-docs body root), plus a source scan that keeps
// a fresh `~/.claude` path build from re-entering monitor/src/server through a new route.
// Pure string builds + file reads — no DB, no server boot.
//
// Runner: npx tsx --test test/server-paths.ga-root.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveApplyScript } from "../src/server/routes/improvement.js";
import { getHtmlBodyRoot, resetDocsRootCache } from "../src/server/clauded-docs/storage.js";

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server");
const LEGACY_ROOT = ".claude";

// The only reads that legitimately stay on ~/.claude: settings.json is the file the Claude
// Code CLI itself owns, and compute-arch-drift additionally keeps the dropped hook-farm dir
// as a documented fail-open fallback (absent → 0 count). Values = matching source lines.
const LEGACY_ALLOWLIST: ReadonlyMap<string, number> = new Map([
  [path.join("routes", "health-detail.ts"), 1],
  [path.join("architecture", "compute-arch-drift.ts"), 2],
]);

// undefined restores the "unset" state so a saved-absent seam is cleared, not blanked to "".
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function findTsFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

// Comment-only lines are skipped — prose naming ~/.claude describes the CLI's own root rather
// than building a path, so scanning it would pin wording instead of behavior.
function countLegacyLines(source: string): number {
  let count = 0;
  for (const line of source.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    if (line.includes(LEGACY_ROOT)) {
      count += 1;
    }
  }
  return count;
}

test("daemon-apply.sh defaults under ~/.glass-atrium, off the legacy ~/.claude", () => {
  const saved = process.env.AUTOAGENT_APPLY_SCRIPT;
  try {
    delete process.env.AUTOAGENT_APPLY_SCRIPT;

    assert.strictEqual(
      resolveApplyScript(),
      path.join(homedir(), ".glass-atrium", "autoagent", "daemon-apply.sh"),
    );
    assert.ok(
      !resolveApplyScript().includes(`${path.sep}${LEGACY_ROOT}${path.sep}`),
      "apply-script default off ~/.claude",
    );
  } finally {
    restoreEnv("AUTOAGENT_APPLY_SCRIPT", saved);
  }
});

test("AUTOAGENT_APPLY_SCRIPT still wins over the default", () => {
  const saved = process.env.AUTOAGENT_APPLY_SCRIPT;
  try {
    process.env.AUTOAGENT_APPLY_SCRIPT = "/tmp/explicit-daemon-apply.sh";
    assert.strictEqual(resolveApplyScript(), "/tmp/explicit-daemon-apply.sh");
  } finally {
    restoreEnv("AUTOAGENT_APPLY_SCRIPT", saved);
  }
});

test("clauded-docs body root defaults under ~/.glass-atrium/monitor/data/documents", () => {
  const saved = process.env.CLAUDED_DOCS_HTML_ROOT;
  try {
    delete process.env.CLAUDED_DOCS_HTML_ROOT;
    resetDocsRootCache();

    assert.strictEqual(
      getHtmlBodyRoot(),
      path.resolve(path.join(homedir(), ".glass-atrium", "monitor", "data", "documents")),
    );
  } finally {
    restoreEnv("CLAUDED_DOCS_HTML_ROOT", saved);
    resetDocsRootCache();
  }
});

test("CLAUDED_DOCS_HTML_ROOT still wins over the default", () => {
  const saved = process.env.CLAUDED_DOCS_HTML_ROOT;
  try {
    process.env.CLAUDED_DOCS_HTML_ROOT = "/tmp/explicit-docs-root";
    resetDocsRootCache();

    assert.strictEqual(getHtmlBodyRoot(), "/tmp/explicit-docs-root");
  } finally {
    restoreEnv("CLAUDED_DOCS_HTML_ROOT", saved);
    resetDocsRootCache();
  }
});

test("no ~/.claude path build in monitor/src/server outside the CLI-coupled allowlist", async () => {
  const files = await findTsFiles(SERVER_DIR);
  assert.ok(files.length > 0, "server sources scanned");

  const hits = new Map<string, number>();
  for (const file of files) {
    const count = countLegacyLines(await readFile(file, "utf8"));
    if (count > 0) {
      hits.set(path.relative(SERVER_DIR, file), count);
    }
  }

  for (const [relative, count] of hits) {
    const allowed = LEGACY_ALLOWLIST.get(relative);
    assert.ok(
      allowed !== undefined,
      `${relative} builds a ~/.claude path — GA-owned state belongs under ~/.glass-atrium`,
    );
    assert.strictEqual(count, allowed, `${relative} ~/.claude line count`);
  }

  for (const relative of LEGACY_ALLOWLIST.keys()) {
    assert.ok(hits.has(relative), `${relative} allowlist entry is stale — drop it`);
  }
});
