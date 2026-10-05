// core.autoagent_trial_ledger + core.autoagent_cycle_verdicts guards, run by execution against the migrated test database.
// CI builds that database with `prisma migrate deploy` over the whole chain → a squash that loses the raw-SQL triggers or CHECKs turns this red.
// Every case runs in one transaction that never commits: both tables reject the DELETE a cleanup would need.

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import "dotenv/config";

import { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";

/** Thrown last inside a case's transaction → the transaction rolls back and nothing persists. */
class Rollback extends Error {}

const TRIAL_KEY = createHash("sha256")
  .update("glass-atrium-dev-node|4127|budget_overage|2026-09-24")
  .digest("hex");
const LOOK_KEY = `${TRIAL_KEY}:look:1`;
const CYCLE_DATE = new Date("2026-10-08T00:00:00.000Z");

after(async () => {
  await disconnectPrisma();
});

function buildLedgerRow(): Prisma.AutoagentTrialLedgerCreateInput {
  return {
    recordedAt: new Date("2026-10-08T04:12:31.000Z"),
    trialKey: TRIAL_KEY,
    agent: "glass-atrium-dev-node",
    learningPatternId: 4127n,
    event: "look",
    actor: "daemon-cycle-shadow",
    payload: { look: 1, tasks: { treatment: 41, control: 39 } },
    dedupeKey: LOOK_KEY,
  };
}

function buildVerdictRow(): Prisma.AutoagentCycleVerdictCreateInput {
  return { cycleDate: CYCLE_DATE, verdict: "extends", recordedAt: new Date("2026-10-08T04:20:02.000Z") };
}

function runRolledBack(work: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<void> {
  return getPrisma().$transaction(async (tx) => {
    await work(tx);
    throw new Rollback();
  });
}

/** Ledger insert in the writer's form → the affected-row count (0 = the dedupe key was taken). */
function insertLedgerRow(tx: Prisma.TransactionClient, dedupeKey: string | null): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO "core"."autoagent_trial_ledger"
      ("trial_key", "agent", "learning_pattern_id", "event", "actor", "payload", "dedupe_key")
    VALUES (${TRIAL_KEY}, 'glass-atrium-dev-node', 4127, 'look', 'daemon-cycle-shadow', '{"look": 1}'::jsonb, ${dedupeKey})
    ON CONFLICT ("dedupe_key") DO NOTHING`;
}

const appendOnlyTables: readonly {
  name: string;
  rejection: RegExp;
  create: (tx: Prisma.TransactionClient) => Promise<{ id: bigint }>;
  update: (tx: Prisma.TransactionClient, id: bigint) => Promise<unknown>;
  delete: (tx: Prisma.TransactionClient, id: bigint) => Promise<unknown>;
  truncate: (tx: Prisma.TransactionClient) => Promise<unknown>;
}[] = [
  {
    name: "core.autoagent_trial_ledger",
    rejection: /autoagent_trial_ledger is append-only/,
    create: (tx) => tx.autoagentTrialLedger.create({ data: buildLedgerRow(), select: { id: true } }),
    update: (tx, id) => tx.autoagentTrialLedger.update({ where: { id }, data: { event: "decision" } }),
    delete: (tx, id) => tx.autoagentTrialLedger.delete({ where: { id } }),
    truncate: (tx) => tx.$executeRaw`TRUNCATE "core"."autoagent_trial_ledger"`,
  },
  {
    name: "core.autoagent_cycle_verdicts",
    rejection: /autoagent_cycle_verdicts is append-only/,
    create: (tx) => tx.autoagentCycleVerdict.create({ data: buildVerdictRow(), select: { id: true } }),
    update: (tx, id) => tx.autoagentCycleVerdict.update({ where: { id }, data: { verdict: "breaks" } }),
    delete: (tx, id) => tx.autoagentCycleVerdict.delete({ where: { id } }),
    truncate: (tx) => tx.$executeRaw`TRUNCATE "core"."autoagent_cycle_verdicts"`,
  },
];

for (const table of appendOnlyTables) {
  describe(`${table.name} append-only trigger`, () => {
    const mutations: readonly {
      name: string;
      mutate: (tx: Prisma.TransactionClient, id: bigint) => Promise<unknown>;
    }[] = [
      { name: "rejects an UPDATE of a recorded row", mutate: table.update },
      { name: "rejects a DELETE of a recorded row", mutate: table.delete },
      { name: "rejects a TRUNCATE of the table", mutate: (tx) => table.truncate(tx) },
    ];

    for (const row of mutations) {
      test(row.name, async () => {
        // Reaching Rollback means the mutation went through → the regex mismatch fails the case.
        await assert.rejects(
          runRolledBack(async (tx) => {
            const { id } = await table.create(tx);
            await row.mutate(tx, id);
          }),
          table.rejection,
        );
      });
    }
  });
}

describe("core.autoagent_trial_ledger rows as written", () => {
  test("accepts an INSERT and stores the row as given", async () => {
    const row = buildLedgerRow();

    await assert.rejects(
      runRolledBack(async (tx) => {
        const stored = await tx.autoagentTrialLedger.create({ data: row, omit: { id: true } });
        assert.deepEqual(stored, row);
      }),
      Rollback,
    );
  });

  test("a second insert with a taken dedupe key under ON CONFLICT DO NOTHING inserts nothing and raises nothing", async () => {
    await assert.rejects(
      runRolledBack(async (tx) => {
        const inserted = [await insertLedgerRow(tx, LOOK_KEY), await insertLedgerRow(tx, LOOK_KEY)];
        const stored = await tx.autoagentTrialLedger.count({ where: { dedupeKey: LOOK_KEY } });
        assert.deepEqual({ inserted, stored }, { inserted: [1, 0], stored: 1 });
      }),
      Rollback,
    );
  });

  test("rows without a dedupe key never conflict with each other", async () => {
    await assert.rejects(
      runRolledBack(async (tx) => {
        const inserted = [await insertLedgerRow(tx, null), await insertLedgerRow(tx, null)];
        const stored = await tx.autoagentTrialLedger.count({ where: { trialKey: TRIAL_KEY, dedupeKey: null } });
        assert.deepEqual({ inserted, stored }, { inserted: [1, 1], stored: 2 });
      }),
      Rollback,
    );
  });

  const uncorrectableFields: readonly {
    name: string;
    override: Partial<Prisma.AutoagentTrialLedgerCreateInput>;
    constraint: RegExp;
  }[] = [
    {
      name: "rejects a trial key that is not a whole 64-hex digest",
      override: { trialKey: TRIAL_KEY.slice(0, 63) },
      constraint: /autoagent_trial_ledger_trial_key_check/,
    },
    {
      name: "rejects an empty dedupe key, which would dedupe unrelated events",
      override: { dedupeKey: "" },
      constraint: /autoagent_trial_ledger_dedupe_key_check/,
    },
    {
      name: "rejects an empty event",
      override: { event: "" },
      constraint: /autoagent_trial_ledger_event_check/,
    },
    {
      name: "rejects an empty actor",
      override: { actor: "" },
      constraint: /autoagent_trial_ledger_actor_check/,
    },
  ];

  for (const row of uncorrectableFields) {
    test(row.name, async () => {
      await assert.rejects(
        runRolledBack((tx) => tx.autoagentTrialLedger.create({ data: { ...buildLedgerRow(), ...row.override } })),
        row.constraint,
      );
    });
  }
});

describe("core.autoagent_cycle_verdicts one verdict per cycle date", () => {
  test("a second verdict for a recorded cycle date under ON CONFLICT DO NOTHING inserts nothing and keeps the first", async () => {
    await assert.rejects(
      runRolledBack(async (tx) => {
        const inserted = [];
        for (const verdict of ["extends", "breaks"]) {
          inserted.push(
            await tx.$executeRaw`
              INSERT INTO "core"."autoagent_cycle_verdicts" ("cycle_date", "verdict")
              VALUES (${CYCLE_DATE}::date, ${verdict}::"core"."CycleVerdict")
              ON CONFLICT ("cycle_date") DO NOTHING`,
          );
        }
        const stored = await tx.autoagentCycleVerdict.findMany({
          where: { cycleDate: CYCLE_DATE },
          select: { verdict: true },
        });
        assert.deepEqual({ inserted, stored }, { inserted: [1, 0], stored: [{ verdict: "extends" }] });
      }),
      Rollback,
    );
  });
});
