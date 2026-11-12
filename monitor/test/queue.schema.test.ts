// Owner queue tables (monitor.queue_*) guards, run by execution against the migrated test database.
// CI builds that database with `prisma migrate deploy` over the whole chain → a squash that loses the raw-SQL CHECKs
// or the resume partial unique index turns this red.
// Every case runs in transactions that never commit → the test database keeps no queue rows.

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";

/** Thrown last inside a case's transaction → the transaction rolls back and nothing persists. */
class Rollback extends Error {}

const SENT_AT = new Date("2026-11-09T08:10:00.000Z");
const ACK_DEADLINE_AT = new Date("2026-11-09T08:12:00.000Z");

after(async () => {
  await disconnectPrisma();
});

function runRolledBack(work: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<void> {
  return getPrisma().$transaction(async (tx) => {
    await work(tx);
    throw new Rollback();
  });
}

function buildSession(pid: number): Prisma.QueueSessionCreateInput {
  return {
    sessionId: randomUUID(),
    isConfigDirSet: true,
    configDir: "/Users/owner/.claude-work",
    profileLabel: ".claude-work",
    cwd: "/Users/owner/Desktop/git/glass-atrium",
    worktreeRoot: "/Users/owner/Desktop/git/glass-atrium",
    pid,
    processStartTime: "Mon Nov  9 08:01:12 2026",
    socketPath: `/private/tmp/cc-socks/${pid}.sock`,
    permissionHint: "default",
    state: "live",
    lastSeenAt: SENT_AT,
  };
}

function buildDecision(sessionId: string): Prisma.QueueItemUncheckedCreateInput {
  return {
    kind: "decision",
    sessionId,
    title: "Pick the sweep interval",
    body: "The sweep re-probes stale rows; a shorter interval spends more probes.",
    options: [
      { code: "R1", label: "30 seconds", pros: "fast recovery", cons: "more probes" },
      { code: "R2", label: "2 minutes", pros: "fewer probes", cons: "slower recovery" },
    ],
    recommendedCode: "R1",
    isFreeTextAllowed: true,
  };
}

function buildDelivery(
  itemId: bigint,
  route: Prisma.QueueDeliveryUncheckedCreateInput["route"],
  attempt: number,
): Prisma.QueueDeliveryUncheckedCreateInput {
  return { msgId: randomUUID(), itemId, route, attempt, result: "sent", sentAt: SENT_AT, ackDeadlineAt: ACK_DEADLINE_AT };
}

/** Option entries R1..R<count> in the route's entry shape. */
function buildOptions(count: number): Prisma.InputJsonArray {
  return Array.from({ length: count }, (_, i) => ({ code: `R${i + 1}`, label: `Interval ${i + 1}`, pros: "fast", cons: "costly" }));
}

function buildDriftCheck(): Prisma.QueueDriftCheckCreateInput {
  return {
    binaryRealpath: "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    binarySize: 319598464n,
    binaryModifiedAt: new Date("2026-11-01T02:00:00.000Z"),
    version: "2.1.318",
    bundleResult: "pass",
    checkedAt: SENT_AT,
  };
}

/**
 * Rejection oracle for one unique key: Prisma P2002 whose Postgres 23505 names `index`.
 * P2002's own message lists the key's fields only → the name comes from the driver-adapter cause.
 */
function expectUniqueViolation(index: string): (error: unknown) => true {
  return (error) => {
    assert.ok(error instanceof Prisma.PrismaClientKnownRequestError, `expected a Prisma request error, got ${String(error)}`);
    assert.equal(error.code, "P2002");
    const postgres = getPostgresCause(error);
    assert.equal(postgres.code, "23505");
    assert.ok(typeof postgres.message === "string", "driver-adapter cause carries no Postgres message");
    assert.ok(postgres.message.includes(`"${index}"`), `unique violation names another key: ${postgres.message}`);
    return true;
  };
}

/** meta.driverAdapterError.cause → the Postgres SQLSTATE and message behind a Prisma error code. */
function getPostgresCause(error: Prisma.PrismaClientKnownRequestError): { code: unknown; message: unknown } {
  const adapterError = error.meta?.driverAdapterError;
  const cause = typeof adapterError === "object" && adapterError !== null && "cause" in adapterError ? adapterError.cause : null;
  if (typeof cause !== "object" || cause === null) return { code: undefined, message: undefined };
  return {
    code: "originalCode" in cause ? cause.originalCode : undefined,
    message: "originalMessage" in cause ? cause.originalMessage : undefined,
  };
}

/** Session + one decision item → the item id the delivery cases hang rows on. */
async function createItem(tx: Prisma.TransactionClient, pid: number): Promise<bigint> {
  const { sessionId } = await tx.queueSession.create({ data: buildSession(pid), select: { sessionId: true } });
  const { id } = await tx.queueItem.create({ data: buildDecision(sessionId), select: { id: true } });
  return id;
}

describe("monitor.queue_deliveries resume bound", () => {
  test("a second resume row for the same item and attempt is rejected", async () => {
    await assert.rejects(
      runRolledBack(async (tx) => {
        const itemId = await createItem(tx, 41001);
        await tx.queueDelivery.create({ data: buildDelivery(itemId, "resume", 1) });
        await tx.queueDelivery.create({ data: buildDelivery(itemId, "resume", 1) });
      }),
      expectUniqueViolation("queue_deliveries_resume_item_attempt_key"),
    );
  });

  const acceptedSeconds: readonly {
    name: string;
    first: Prisma.QueueDeliveryUncheckedCreateInput["route"];
    second: Prisma.QueueDeliveryUncheckedCreateInput["route"];
    secondAttempt: number;
  }[] = [
    { name: "a second socket row for the same attempt is accepted", first: "socket", second: "socket", secondAttempt: 1 },
    { name: "a second pull row for the same attempt is accepted", first: "pull", second: "pull", secondAttempt: 1 },
    { name: "a resume row beside a socket row of the same attempt is accepted", first: "socket", second: "resume", secondAttempt: 1 },
    { name: "a resume row for the next attempt is accepted", first: "resume", second: "resume", secondAttempt: 2 },
  ];

  for (const row of acceptedSeconds) {
    test(row.name, async () => {
      await assert.rejects(
        runRolledBack(async (tx) => {
          const itemId = await createItem(tx, 41002);
          await tx.queueDelivery.create({ data: buildDelivery(itemId, row.first, 1) });
          await tx.queueDelivery.create({ data: buildDelivery(itemId, row.second, row.secondAttempt) });
          assert.equal(await tx.queueDelivery.count({ where: { itemId } }), 2);
        }),
        Rollback,
      );
    });
  }
});

describe("monitor.queue_deliveries msg id", () => {
  test("a msg id already taken by another delivery is rejected", async () => {
    await assert.rejects(
      runRolledBack(async (tx) => {
        const itemId = await createItem(tx, 41003);
        const first = buildDelivery(itemId, "socket", 1);
        await tx.queueDelivery.create({ data: first });
        await tx.queueDelivery.create({ data: { ...buildDelivery(itemId, "pull", 1), msgId: first.msgId } });
      }),
      expectUniqueViolation("queue_deliveries_msg_id_key"),
    );
  });
});

describe("monitor.queue_items queue position", () => {
  test("two writers whose transactions overlap draw distinct positions", async () => {
    // Each writer holds its transaction open until both have inserted → a max()+1 default would hand both one value.
    let releaseWriters!: () => void;
    const bothInserted = new Promise<void>((resolve) => {
      releaseWriters = resolve;
    });
    let insertedCount = 0;
    const positions: bigint[] = [];

    const writeItem = (pid: number): Promise<void> =>
      runRolledBack(async (tx) => {
        const { sessionId } = await tx.queueSession.create({ data: buildSession(pid), select: { sessionId: true } });
        const { queuePosition } = await tx.queueItem.create({
          data: buildDecision(sessionId),
          select: { queuePosition: true },
        });
        positions.push(queuePosition);
        insertedCount += 1;
        if (insertedCount === 2) releaseWriters();
        await bothInserted;
      });

    await Promise.all([assert.rejects(writeItem(41004), Rollback), assert.rejects(writeItem(41005), Rollback)]);
    assert.equal(new Set(positions).size, 2);
  });

  test("Later draws a position behind every item already queued", async () => {
    await assert.rejects(
      runRolledBack(async (tx) => {
        const { sessionId } = await tx.queueSession.create({ data: buildSession(41006), select: { sessionId: true } });
        const deferred = await tx.queueItem.create({ data: buildDecision(sessionId), select: { id: true } });
        await tx.queueItem.create({ data: buildDecision(sessionId) });
        await tx.$executeRaw`
          UPDATE "monitor"."queue_items"
          SET "queue_position" = nextval('"monitor"."queue_items_queue_position_seq"'), "defer_count" = "defer_count" + 1
          WHERE "id" = ${deferred.id}`;
        const last = await tx.queueItem.findFirstOrThrow({
          where: { sessionId },
          orderBy: { queuePosition: "desc" },
          select: { id: true, deferCount: true },
        });
        assert.deepEqual(last, { id: deferred.id, deferCount: 1 });
      }),
      Rollback,
    );
  });
});

describe("monitor.queue_* enum limits", () => {
  // Raw SQL → a value outside the enum reaches Postgres instead of stopping at the typed client.
  const outsideValues: readonly { name: string; insert: (tx: Prisma.TransactionClient, itemId: bigint) => Promise<unknown> }[] = [
    {
      name: "rejects an item status outside the item states",
      insert: (tx, itemId) =>
        tx.$executeRaw`UPDATE "monitor"."queue_items" SET "status" = ${"answering"}::"monitor"."QueueItemStatus" WHERE "id" = ${itemId}`,
    },
    {
      name: "rejects a delivery route outside socket, resume and pull",
      insert: (tx, itemId) =>
        tx.$executeRaw`
          INSERT INTO "monitor"."queue_deliveries" ("msg_id", "item_id", "route", "attempt", "result", "sent_at", "ack_deadline_at")
          VALUES (${randomUUID()}::uuid, ${itemId}, ${"email"}::"monitor"."QueueDeliveryRoute", 1, 'sent', ${SENT_AT}, ${ACK_DEADLINE_AT})`,
    },
    {
      name: "rejects a session state outside live, stale and exited",
      insert: (tx) =>
        tx.$executeRaw`UPDATE "monitor"."queue_sessions" SET "state" = ${"sleeping"}::"monitor"."QueueSessionState" WHERE "pid" = 41007`,
    },
  ];

  for (const row of outsideValues) {
    test(row.name, async () => {
      await assert.rejects(
        runRolledBack(async (tx) => row.insert(tx, await createItem(tx, 41007))),
        /invalid input value for enum/,
      );
    });
  }
});

describe("monitor.queue_items answer record", () => {
  // Raw SQL → the enum types and the pairing CHECK reach Postgres, not the typed client's own checks.
  const rows: readonly { name: string; route: string | null; signal: string | null; isAccepted: boolean; error?: RegExp }[] = [
    { name: "accepts the answer route with fetch metadata", route: "answer", signal: "fetch_metadata", isAccepted: true },
    { name: "accepts the reply route with an Origin-only signal", route: "reply", signal: "origin", isAccepted: true },
    { name: "accepts the message route with fetch metadata", route: "message", signal: "fetch_metadata", isAccepted: true },
    { name: "accepts a backfilled row from before the record", route: "answer", signal: "before_record", isAccepted: true },
    { name: "accepts an unstamped answer, which the page lists as outside", route: null, signal: null, isAccepted: true },
    { name: "rejects a route with no signal", route: "answer", signal: null, isAccepted: false, error: /queue_items_answer_record_check/ },
    { name: "rejects a signal with no route", route: null, signal: "origin", isAccepted: false, error: /queue_items_answer_record_check/ },
    { name: "rejects a route outside answer, reply and message", route: "cli", signal: "origin", isAccepted: false, error: /invalid input value for enum/ },
    { name: "rejects a signal outside the recorded signals", route: "answer", signal: "cookie", isAccepted: false, error: /invalid input value for enum/ },
  ];

  for (const row of rows) {
    test(row.name, async () => {
      const work = runRolledBack(async (tx) => {
        const itemId = await createItem(tx, 41011);
        await tx.$executeRaw`
          UPDATE "monitor"."queue_items"
          SET "status" = 'answered', "answer_code" = 'R1', "answered_at" = ${SENT_AT},
              "answer_route" = ${row.route}::"monitor"."QueueAnswerRoute", "answer_signal" = ${row.signal}::"monitor"."QueueAnswerSignal"
          WHERE "id" = ${itemId}`;
      });
      if (row.isAccepted) await assert.rejects(work, Rollback);
      else await assert.rejects(work, row.error ?? /./);
    });
  }
});

describe("monitor.queue_* length and shape limits", () => {
  const rejectedRows: readonly {
    name: string;
    write: (tx: Prisma.TransactionClient, itemId: bigint) => Promise<unknown>;
    constraint: RegExp;
  }[] = [
    {
      name: "rejects an item title past 200 characters",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { title: "t".repeat(201) } }),
      constraint: /value too long|too long for the column/,
    },
    {
      name: "rejects an item body past 20000 characters",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { body: "b".repeat(20001) } }),
      constraint: /queue_items_body_check/,
    },
    {
      name: "rejects a blank item body",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { body: "   " } }),
      constraint: /queue_items_body_check/,
    },
    {
      name: "rejects an answer text past 20000 characters",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { answerText: "a".repeat(20001) } }),
      constraint: /queue_items_answer_text_check/,
    },
    {
      name: "rejects more than 20 linked doc ids",
      write: (tx, itemId) =>
        tx.queueItem.update({
          where: { id: itemId },
          data: { linkedDocIds: Array.from({ length: 21 }, (_, i) => BigInt(43900 + i)) },
        }),
      constraint: /queue_items_linked_doc_ids_check/,
    },
    {
      // Raw SQL → the typed client cannot write a NULL array or a NULL entry
      name: "rejects a NULL linked doc ids array",
      write: (tx, itemId) => tx.$executeRaw`UPDATE "monitor"."queue_items" SET "linked_doc_ids" = NULL WHERE "id" = ${itemId}`,
      constraint: /queue_items_linked_doc_ids_check/,
    },
    {
      name: "rejects a linked doc id entry that is NULL",
      write: (tx, itemId) =>
        tx.$executeRaw`UPDATE "monitor"."queue_items" SET "linked_doc_ids" = ARRAY[43944, NULL]::bigint[] WHERE "id" = ${itemId}`,
      constraint: /queue_items_linked_doc_ids_check/,
    },
    {
      name: "rejects a blank item title",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { title: "   " } }),
      constraint: /queue_items_title_check/,
    },
    {
      name: "rejects a recommended code that names no option",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { recommendedCode: "R3" } }),
      constraint: /queue_items_decision_options_check/,
    },
    {
      name: "rejects a report that carries options",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { kind: "report" } }),
      constraint: /queue_items_decision_options_check/,
    },
    {
      name: "rejects a decision with fewer than 2 options",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { options: buildOptions(1) } }),
      constraint: /queue_items_decision_options_check/,
    },
    {
      name: "rejects a decision with more than 9 options",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { options: buildOptions(10) } }),
      constraint: /queue_items_decision_options_check/,
    },
    {
      name: "rejects a decision without an options array",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { options: Prisma.DbNull } }),
      constraint: /queue_items_decision_options_check/,
    },
    {
      // the code names an entry → only the R1..R9 form is under test
      name: "rejects a recommended code outside R1 to R9",
      write: (tx, itemId) =>
        tx.queueItem.update({
          where: { id: itemId },
          data: {
            options: [
              { code: "X1", label: "30 seconds", pros: "fast recovery", cons: "more probes" },
              { code: "R2", label: "2 minutes", pros: "fewer probes", cons: "slower recovery" },
            ],
            recommendedCode: "X1",
          },
        }),
      constraint: /queue_items_decision_options_check/,
    },
    {
      name: "rejects options whose serialized text passes 20000 characters",
      write: (tx, itemId) =>
        tx.queueItem.update({
          where: { id: itemId },
          data: {
            options: [
              { code: "R1", label: "30 seconds", pros: "p".repeat(20000), cons: "more probes" },
              { code: "R2", label: "2 minutes", pros: "fewer probes", cons: "slower recovery" },
            ],
          },
        }),
      constraint: /queue_items_options_check/,
    },
    {
      name: "rejects an answer code that names no option",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { answerCode: "R9" } }),
      constraint: /queue_items_answer_code_check/,
    },
    {
      name: "rejects a next attempt below 1",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { nextAttempt: 0 } }),
      constraint: /queue_items_next_attempt_check/,
    },
    {
      name: "rejects a negative defer count",
      write: (tx, itemId) => tx.queueItem.update({ where: { id: itemId }, data: { deferCount: -1 } }),
      constraint: /queue_items_defer_count_check/,
    },
    {
      name: "rejects a bg id that starts with a hyphen",
      write: (tx, itemId) => tx.queueDelivery.create({ data: { ...buildDelivery(itemId, "resume", 1), bgId: "-h" } }),
      constraint: /queue_deliveries_bg_id_check/,
    },
    {
      name: "rejects a bg id carrying a character other than letters, digits and hyphens",
      write: (tx, itemId) => tx.queueDelivery.create({ data: { ...buildDelivery(itemId, "resume", 1), bgId: "a.b" } }),
      constraint: /queue_deliveries_bg_id_check/,
    },
    {
      name: "rejects a bg id on a socket row",
      write: (tx, itemId) => tx.queueDelivery.create({ data: { ...buildDelivery(itemId, "socket", 1), bgId: "abc123" } }),
      constraint: /queue_deliveries_bg_id_check/,
    },
    {
      name: "rejects an aborted row with no abort reason",
      write: (tx, itemId) => tx.queueDelivery.create({ data: { ...buildDelivery(itemId, "resume", 1), result: "aborted" } }),
      constraint: /queue_deliveries_abort_reason_check/,
    },
    {
      name: "rejects an abort reason on a row that did not abort",
      write: (tx, itemId) =>
        tx.queueDelivery.create({ data: { ...buildDelivery(itemId, "resume", 1), abortReason: "shared_worktree" } }),
      constraint: /queue_deliveries_abort_reason_check/,
    },
    {
      name: "rejects an aborted row on a route other than resume",
      write: (tx, itemId) =>
        tx.queueDelivery.create({
          data: { ...buildDelivery(itemId, "socket", 1), result: "aborted", abortReason: "session_returned" },
        }),
      constraint: /queue_deliveries_abort_reason_check/,
    },
    {
      name: "rejects an attempt below 1",
      write: (tx, itemId) => tx.queueDelivery.create({ data: buildDelivery(itemId, "pull", 0) }),
      constraint: /queue_deliveries_attempt_check/,
    },
    {
      name: "rejects an ack deadline that is not after the send time",
      write: (tx, itemId) => tx.queueDelivery.create({ data: { ...buildDelivery(itemId, "socket", 1), ackDeadlineAt: SENT_AT } }),
      constraint: /queue_deliveries_ack_deadline_check/,
    },
  ];

  for (const row of rejectedRows) {
    test(row.name, async () => {
      await assert.rejects(
        runRolledBack(async (tx) => row.write(tx, await createItem(tx, 41008))),
        row.constraint,
      );
    });
  }

  const rejectedSessions: readonly {
    name: string;
    override: Partial<Prisma.QueueSessionCreateInput>;
    constraint: RegExp;
  }[] = [
    {
      name: "rejects a socket path outside cc-socks for the registered pid",
      override: { socketPath: "/private/tmp/cc-socks/41010.sock" },
      constraint: /queue_sessions_socket_path_check/,
    },
    {
      name: "rejects an exited row with no exit reason",
      override: { state: "exited" },
      constraint: /queue_sessions_exit_reason_check/,
    },
    {
      name: "rejects a live row that carries an exit reason",
      override: { exitReason: "dead" },
      constraint: /queue_sessions_exit_reason_check/,
    },
    {
      name: "rejects a config dir present while the flag says unset",
      override: { isConfigDirSet: false },
      constraint: /queue_sessions_config_dir_check/,
    },
    {
      name: "rejects a relative config dir",
      override: { configDir: ".claude-work" },
      constraint: /queue_sessions_config_dir_check/,
    },
    {
      name: "rejects a relative cwd",
      override: { cwd: "Desktop/git/glass-atrium" },
      constraint: /queue_sessions_cwd_check/,
    },
    {
      name: "rejects a relative worktree root",
      override: { worktreeRoot: "Desktop/git/glass-atrium" },
      constraint: /queue_sessions_worktree_root_check/,
    },
    {
      // no socket path → the pid-keyed socket path CHECK stays out of the way
      name: "rejects a pid of 0",
      override: { pid: 0, socketPath: null },
      constraint: /queue_sessions_pid_check/,
    },
    {
      name: "rejects an empty profile label",
      override: { profileLabel: "" },
      constraint: /queue_sessions_profile_label_check/,
    },
    {
      name: "rejects an empty process start time",
      override: { processStartTime: "" },
      constraint: /queue_sessions_process_start_time_check/,
    },
  ];

  for (const row of rejectedSessions) {
    test(row.name, async () => {
      await assert.rejects(
        runRolledBack((tx) => tx.queueSession.create({ data: { ...buildSession(41009), ...row.override } })),
        row.constraint,
      );
    });
  }

  const rejectedDriftChecks: readonly {
    name: string;
    override: Partial<Prisma.QueueDriftCheckCreateInput>;
    constraint: RegExp;
  }[] = [
    {
      name: "rejects a relative binary realpath",
      override: { binaryRealpath: "bin/claude.exe" },
      constraint: /queue_drift_checks_binary_realpath_check/,
    },
    {
      name: "rejects a negative binary size",
      override: { binarySize: -1n },
      constraint: /queue_drift_checks_binary_size_check/,
    },
    {
      name: "rejects an empty version",
      override: { version: "" },
      constraint: /queue_drift_checks_version_check/,
    },
  ];

  for (const row of rejectedDriftChecks) {
    test(row.name, async () => {
      await assert.rejects(
        runRolledBack((tx) => tx.queueDriftCheck.create({ data: { ...buildDriftCheck(), ...row.override } })),
        row.constraint,
      );
    });
  }

  test("accepts an item at every length and count cap", async () => {
    await assert.rejects(
      runRolledBack(async (tx) => {
        const itemId = await createItem(tx, 41012);
        const item = await tx.queueItem.update({
          where: { id: itemId },
          data: {
            title: "t".repeat(200),
            body: "b".repeat(20000),
            answerText: "a".repeat(20000),
            linkedDocIds: Array.from({ length: 20 }, (_, i) => BigInt(43900 + i)),
            options: buildOptions(9),
          },
          select: { title: true, body: true, answerText: true, linkedDocIds: true, options: true },
        });
        assert.deepEqual(
          {
            title: item.title.length,
            body: item.body.length,
            answerText: item.answerText?.length,
            linkedDocIds: item.linkedDocIds.length,
            options: Array.isArray(item.options) ? item.options.length : null,
          },
          { title: 200, body: 20000, answerText: 20000, linkedDocIds: 20, options: 9 },
        );
      }),
      Rollback,
    );
  });

  test("accepts a resume row carrying a bg id of letters, digits and a hyphen", async () => {
    await assert.rejects(
      runRolledBack(async (tx) => {
        const itemId = await createItem(tx, 41011);
        const { bgId } = await tx.queueDelivery.create({
          data: { ...buildDelivery(itemId, "resume", 1), bgId: "a1b2-c3d4" },
          select: { bgId: true },
        });
        assert.equal(bgId, "a1b2-c3d4");
      }),
      Rollback,
    );
  });
});

describe("monitor.queue_drift_checks one row per Claude Code version", () => {
  test("a second row for a recorded version is rejected", async () => {
    const row = buildDriftCheck();
    await assert.rejects(
      runRolledBack(async (tx) => {
        await tx.queueDriftCheck.create({ data: row });
        await tx.queueDriftCheck.create({ data: { ...row, binarySize: 319598465n } });
      }),
      expectUniqueViolation("queue_drift_checks_version_key"),
    );
  });
});
