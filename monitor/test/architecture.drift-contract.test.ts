// AC-10 parity: the `stale` / `diffs` shape returned by /api/architecture/live is an EXTERNAL consumption
// contract (verify-arch Stage-1 instrument + success oracle). This test reads BOTH artifacts — the route
// module and the skill — so a rename on either side reddens instead of silently breaking the skill.
// Runner: npx tsx --test test/architecture.drift-contract.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import test from "node:test";
import assert from "node:assert/strict";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const ROUTE_SRC = readFileSync(path.join(REPO_ROOT, "monitor/src/server/routes/architecture.ts"), "utf8");
const DRIFT_SRC = readFileSync(
  path.join(REPO_ROOT, "monitor/src/server/architecture/compute-arch-drift.ts"),
  "utf8",
);
// Loud on absence: a missing skill file is a broken contract, never a skip.
const SKILL_SRC = readFileSync(
  path.join(REPO_ROOT, "skills/glass-atrium-ops-verify-arch/SKILL.md"),
  "utf8",
);

// Keys the skill's Stage-1 consumption actually reads, taken from the skill text itself.
const SKILL_TOP_KEYS = ["stale", "diffs"];
const SKILL_DIFF_KEYS = ["key", "actual"];

test("AC-10 (i) both keys exist on the live response and come from the drift result", () => {
  assert.match(ROUTE_SRC, /stale: drift\.stale/);
  assert.match(ROUTE_SRC, /diffs: drift\.diffs/);
});

test("AC-10 (ii) stale is boolean and diffs is an array of ArchDiff", () => {
  assert.match(DRIFT_SRC, /stale: boolean;/);
  assert.match(DRIFT_SRC, /diffs: ArchDiff\[\];/);
});

test("AC-10 (iii) every key the skill reads exists on the diff element", () => {
  // Field presence counts only INSIDE the ArchDiff block — another top-level declaration must not stand in.
  const archDiffBody = DRIFT_SRC.match(/export interface ArchDiff \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.notEqual(archDiffBody, "", "ArchDiff interface block must be locatable");
  for (const key of SKILL_DIFF_KEYS) {
    assert.match(archDiffBody, new RegExp(`^\\s*${key}: `, "m"), `ArchDiff must declare '${key}'`);
  }
  for (const key of SKILL_TOP_KEYS) {
    assert.ok(SKILL_SRC.includes(`'${key}'`), `skill Stage-1 must still consume '${key}'`);
  }
  // COUNT spec drives the fix from (key, actual); losing that sentence unpins the contract.
  assert.match(SKILL_SRC, /ARCH_INVARIANTS\[<key>\] = <actual>/);
});

test("the new budget health surface is additive — it does not replace the live drift consumer", () => {
  assert.match(ROUTE_SRC, /app\.get\("\/api\/architecture\/live", handleLive\)/);
});
