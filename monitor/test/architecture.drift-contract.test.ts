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

// Each row names the artifact it reads so a failure identifies the broken side without a per-row test().
const CONTRACT_ROWS: ReadonlyArray<{ artifact: string; src: string; pattern: RegExp }> = [
  { artifact: "routes/architecture.ts", src: ROUTE_SRC, pattern: /stale: drift\.stale/ },
  { artifact: "routes/architecture.ts", src: ROUTE_SRC, pattern: /diffs: drift\.diffs/ },
  // The budget health surface is additive: the live drift consumer must still be mounted.
  { artifact: "routes/architecture.ts", src: ROUTE_SRC, pattern: /app\.get\("\/api\/architecture\/live", handleLive\)/ },
  { artifact: "compute-arch-drift.ts", src: DRIFT_SRC, pattern: /stale: boolean;/ },
  { artifact: "compute-arch-drift.ts", src: DRIFT_SRC, pattern: /diffs: ArchDiff\[\];/ },
  // COUNT spec drives the fix from (key, actual); losing that sentence unpins the contract.
  { artifact: "verify-arch SKILL.md", src: SKILL_SRC, pattern: /ARCH_INVARIANTS\[<key>\] = <actual>/ },
];

test("AC-10 the live drift consumption contract holds across route, ArchDiff and the verify-arch skill", () => {
  // Row identity is the (artifact, pattern) pair — three rows share an artifact name, so a name set cannot see a swap.
  assert.deepEqual(
    CONTRACT_ROWS.map(({ artifact, pattern }) => `${artifact} :: ${pattern.source}`),
    [
      "routes/architecture.ts :: stale: drift\\.stale",
      "routes/architecture.ts :: diffs: drift\\.diffs",
      'routes/architecture.ts :: app\\.get\\("\\/api\\/architecture\\/live", handleLive\\)',
      "compute-arch-drift.ts :: stale: boolean;",
      "compute-arch-drift.ts :: diffs: ArchDiff\\[\\];",
      "verify-arch SKILL.md :: ARCH_INVARIANTS\\[<key>\\] = <actual>",
    ],
    "contract row membership changed — a dropped or swapped row silently unpins the live drift contract",
  );
  // Anti-vacuity: an empty source would satisfy every loop below.
  for (const src of [ROUTE_SRC, DRIFT_SRC, SKILL_SRC]) {
    assert.ok(src.length > 0, "contract artifact source must be readable and non-empty");
  }

  for (const { artifact, src, pattern } of CONTRACT_ROWS) {
    assert.match(src, pattern, `${artifact} must still carry ${pattern}`);
  }

  // Field presence counts only INSIDE the ArchDiff block — another top-level declaration must not stand in.
  const archDiffBody = DRIFT_SRC.match(/export interface ArchDiff \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.notEqual(archDiffBody, "", "ArchDiff interface block must be locatable");
  assert.deepEqual(SKILL_DIFF_KEYS, ["key", "actual"], "ArchDiff key set changed");
  assert.deepEqual(SKILL_TOP_KEYS, ["stale", "diffs"], "skill Stage-1 top-level key set changed");
  for (const key of SKILL_DIFF_KEYS) {
    assert.match(archDiffBody, new RegExp(`^\\s*${key}: `, "m"), `ArchDiff must declare '${key}'`);
  }
  for (const key of SKILL_TOP_KEYS) {
    assert.ok(SKILL_SRC.includes(`'${key}'`), `skill Stage-1 must still consume '${key}'`);
  }
});
