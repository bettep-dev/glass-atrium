// Unit tests for the governance membership surface — the named-absence list that
// replaced the filesystem-inventory totals. The point of the surface is that a
// vanished scope or rule file fails BY NAME, so that is what these assert.
// Runner: npx tsx --test test/architecture.governance-membership.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getMembershipAt } from "../src/server/architecture/governance-membership.js";

const REPO_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SILENT = { warn(): void {}, info(): void {} };

const MATRIX_BODY = [
  "| File | Loads when |",
  "| `scoped/scope-dev.md` | DEV |",
  "| `scoped/scope-qa.md` | QA |",
  "| `rules/glass-atrium/core-security.md` | ALL |",
  "Prose mentioning `agents/GLASS_ATRIUM_GLOBAL_RULES.md` too.",
].join("\n");

const DECLARED = [
  "scoped/scope-dev.md",
  "scoped/scope-qa.md",
  "rules/glass-atrium/core-security.md",
  "agents/GLASS_ATRIUM_GLOBAL_RULES.md",
];

// Sandboxed Atrium root — the live install is never touched by these tests.
async function seedRoot(present: readonly string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ga-membership-"));
  await mkdir(path.join(root, "rules", "glass-atrium"), { recursive: true });
  await writeFile(
    path.join(root, "rules", "glass-atrium", "core-compliance-matrix.md"),
    MATRIX_BODY,
  );
  for (const relative of present) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "seed");
  }
  return root;
}

test("every declared document present → no absence reported", async () => {
  const root = await seedRoot(DECLARED);
  try {
    const result = await getMembershipAt(root, SILENT);
    assert.deepEqual(result, { absent: [], sourceMissing: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("absent scope file is reported by name, not as a total", async () => {
  const root = await seedRoot(DECLARED.filter((p) => p !== "scoped/scope-qa.md"));
  try {
    const result = await getMembershipAt(root, SILENT);
    assert.deepEqual(result.absent, ["scoped/scope-qa.md"]);
    assert.equal(result.sourceMissing, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("absent rule file is reported by name", async () => {
  const root = await seedRoot(
    DECLARED.filter((p) => p !== "rules/glass-atrium/core-security.md"),
  );
  try {
    const result = await getMembershipAt(root, SILENT);
    assert.deepEqual(result.absent, ["rules/glass-atrium/core-security.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unreadable matrix surfaces as sourceMissing rather than a silent pass", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ga-membership-"));
  try {
    const result = await getMembershipAt(root, SILENT);
    assert.deepEqual(result, { absent: [], sourceMissing: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the real matrix still yields a non-empty declared set", async () => {
  // Derivation guard: a matrix whose path spellings drifted out of the extraction
  // pattern would report a vacuously empty absence list forever. Copied into a
  // sandbox root holding none of the documents — the live install is untouched.
  const root = await mkdtemp(path.join(tmpdir(), "ga-membership-real-"));
  try {
    const real = await readFile(
      path.join(REPO_ROOT, "rules", "glass-atrium", "core-compliance-matrix.md"),
      "utf8",
    );
    await mkdir(path.join(root, "rules", "glass-atrium"), { recursive: true });
    await writeFile(
      path.join(root, "rules", "glass-atrium", "core-compliance-matrix.md"),
      real,
    );
    const result = await getMembershipAt(root, SILENT);
    assert.equal(result.sourceMissing, false);
    assert.ok(result.absent.includes("scoped/scope-dev.md"));
    assert.ok(result.absent.includes("rules/glass-atrium/core-security.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
