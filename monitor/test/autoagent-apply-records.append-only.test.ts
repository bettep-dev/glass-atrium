// core.autoagent_apply_records guards, run by execution against the migrated test database.
// CI builds that database with `prisma migrate deploy` over the whole chain → a squash that loses the raw-SQL trigger or CHECKs turns this red.
// Every case runs in one transaction that never commits: the table rejects the DELETE a cleanup would need.

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import "dotenv/config";

import { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";

/** Thrown last inside a case's transaction → the transaction rolls back and nothing persists. */
class Rollback extends Error {}

const APPEND_ONLY_REJECTION = /autoagent_apply_records is append-only/;

const LANDED_DIFF = [
  "--- a/agents/glass-atrium-dev-db.md",
  "+++ b/agents/glass-atrium-dev-db.md",
  "@@ -41,3 +41,4 @@",
  " ## Work Rules",
  " - Large data → batch + progress tracking",
  "+- Key lists come from the code SoT, never hand-copied",
  " - Comments: every migration comments its intent",
  "",
].join("\n");

after(async () => {
  await disconnectPrisma();
});

function getSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function buildRecord(): Prisma.AutoagentApplyRecordCreateInput {
  return {
    proposalId: 179n,
    cycleDate: new Date("2026-10-02T00:00:00.000Z"),
    patternLabel: "verification key lists hand-copied instead of re-derived",
    targetFile: "agents/glass-atrium-dev-db.md",
    targetAgent: "glass-atrium-dev-db",
    appliedAt: new Date("2026-10-02T09:14:07.000Z"),
    strategy: "recount",
    beforeSha256: getSha256("agent body before the apply"),
    afterSha256: getSha256("agent body after the apply"),
    landedDiff: LANDED_DIFF,
    modelId: "claude-haiku-4-5",
  };
}

function runRolledBack(work: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<void> {
  return getPrisma().$transaction(async (tx) => {
    await work(tx);
    throw new Rollback();
  });
}

describe("append-only trigger", () => {
  test("accepts an INSERT and stores the record as given", async () => {
    const record = buildRecord();

    await assert.rejects(
      runRolledBack(async (tx) => {
        const stored = await tx.autoagentApplyRecord.create({ data: record, omit: { id: true } });
        assert.deepEqual(stored, record);
      }),
      Rollback,
    );
  });

  const mutations: readonly {
    name: string;
    mutate: (tx: Prisma.TransactionClient, id: bigint) => Promise<unknown>;
  }[] = [
    {
      name: "rejects an UPDATE of a recorded apply",
      mutate: (tx, id) => tx.autoagentApplyRecord.update({ where: { id }, data: { landedDiff: "+rewritten" } }),
    },
    {
      name: "rejects a DELETE of a recorded apply",
      mutate: (tx, id) => tx.autoagentApplyRecord.delete({ where: { id } }),
    },
    {
      name: "rejects a TRUNCATE of the record table",
      mutate: (tx) => tx.$executeRaw`TRUNCATE "core"."autoagent_apply_records"`,
    },
  ];

  for (const row of mutations) {
    test(row.name, async () => {
      // Reaching Rollback means the mutation went through → the regex mismatch fails the case.
      await assert.rejects(
        runRolledBack(async (tx) => {
          const { id } = await tx.autoagentApplyRecord.create({ data: buildRecord(), select: { id: true } });
          await row.mutate(tx, id);
        }),
        APPEND_ONLY_REJECTION,
      );
    });
  }
});

describe("fail-loud hash and diff columns", () => {
  const uncomputedFields: readonly {
    name: string;
    override: Partial<Prisma.AutoagentApplyRecordCreateInput>;
    constraint: RegExp;
  }[] = [
    {
      name: "rejects an empty before-hash, the hash helper's failure value",
      override: { beforeSha256: "" },
      constraint: /autoagent_apply_records_before_sha256_check/,
    },
    {
      name: "rejects an empty after-hash",
      override: { afterSha256: "" },
      constraint: /autoagent_apply_records_after_sha256_check/,
    },
    {
      name: "rejects an after-hash that is not a whole 64-hex digest",
      override: { afterSha256: getSha256("agent body after the apply").slice(0, 63) },
      constraint: /autoagent_apply_records_after_sha256_check/,
    },
    {
      name: "rejects an empty landed diff",
      override: { landedDiff: "" },
      constraint: /autoagent_apply_records_landed_diff_check/,
    },
  ];

  for (const row of uncomputedFields) {
    test(row.name, async () => {
      await assert.rejects(
        runRolledBack((tx) => tx.autoagentApplyRecord.create({ data: { ...buildRecord(), ...row.override } })),
        row.constraint,
      );
    });
  }
});
