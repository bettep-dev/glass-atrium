// audit-log 미들웨어 통합 테스트 (monitor.audit_log re-wiring).
// 변이 라우트 → audit row · GET/미커버 라우트 → row 없음 · INSERT 실패 격리 · coverage-drift guard (A09 회귀 방지).

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RouteOptions,
} from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { ROUTE_RESOURCE, registerAuditLogHook } from "../src/server/middleware/audit-log.js";
import { registerClaudedDocsRoutes } from "../src/server/routes/clauded-docs.js";
import { registerImprovementRoutes } from "../src/server/routes/improvement.js";
import { registerModelConfigRoutes } from "../src/server/routes/model-config.js";

// Unique marker isolates this suite's rows in payload for scrub + assertion.
const SUITE_MARKER = `audit-test-${randomUUID()}`;
let app: FastifyInstance;

/**
 * Build an app with the audit hook + stub handlers mirroring the real covered route keys.
 * Stub handlers echo a controllable status so result_code mapping can be asserted.
 */
function buildAppWithCoveredRoutes(): FastifyInstance {
  const instance = Fastify({ logger: false });
  registerAuditLogHook(instance);

  // Mirror the real route keys so routeOptions.url matches the audited set.
  instance.delete("/api/clauded-docs/:id", async (_req, reply) => {
    reply.header("x-suite", SUITE_MARKER);
    return reply.code(200).send({ ok: true });
  });
  instance.put("/api/clauded-docs/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { status?: number } | undefined;
    return reply.code(body?.status ?? 200).send({ ok: true });
  });
  instance.post("/api/clauded-docs", async (_req, reply) => reply.code(201).send({ id: 1 }));
  instance.post("/api/improvement/:id/approve", async (_req, reply) =>
    reply.code(200).send({ ok: true }),
  );
  instance.get("/api/clauded-docs/:id", async (_req, reply) => reply.code(200).send({ ok: true }));
  // Uncovered mutating route — must NOT be audited.
  instance.post("/api/never-audited", async (_req, reply) => reply.code(200).send({ ok: true }));
  return instance;
}

/** Poll audit_log for a row matching the route + action_kind written in this test run. */
async function findAuditRow(
  actionKind: string,
  targetId: number | null,
): Promise<{ action_kind: string; result_code: string; actor: string; target_table: string; target_id: bigint | null } | null> {
  const prisma = getPrisma();
  // Fire-and-forget INSERT — allow the floating promise to settle.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const rows = await prisma.$queryRaw<
      { action_kind: string; result_code: string; actor: string; target_table: string; target_id: bigint | null }[]
    >`
      SELECT action_kind, result_code, actor, target_table, target_id
      FROM monitor.audit_log
      WHERE action_kind = ${actionKind}
        AND actor = 'monitor-web'
        AND (${targetId}::bigint IS NULL OR target_id = ${targetId}::bigint)
        AND event_ts >= NOW() - INTERVAL '2 minutes'
      ORDER BY event_ts DESC
      LIMIT 1
    `;
    if (rows.length > 0) {
      return rows[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** Count audit rows for an action_kind within the recent window (used for negative assertions). */
async function countAuditRows(actionKind: string): Promise<number> {
  const prisma = getPrisma();
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM monitor.audit_log
    WHERE action_kind = ${actionKind}
      AND event_ts >= NOW() - INTERVAL '2 minutes'
  `;
  return Number(rows[0].count);
}

before(async () => {
  app = buildAppWithCoveredRoutes();
  await app.ready();
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  // Scrub rows this suite wrote — all carry actor='monitor-web' + this run's specific target ids.
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM monitor.audit_log
      WHERE actor = 'monitor-web'
        AND target_table IN ('clauded-docs', 'clauded-docs-group', 'improvement')
        AND target_id IN (424242, 525252, 626262)
        AND event_ts >= NOW() - INTERVAL '10 minutes'
    `;
  } catch (error) {
    console.error("[audit-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
});

// Happy path — mutation produces an audit row with correct fields.
test("DELETE covered route → audit_log row: action_kind=clauded-docs.delete result_code=success", async () => {
  const res = await app.inject({ method: "DELETE", url: "/api/clauded-docs/424242" });
  assert.strictEqual(res.statusCode, 200);

  const row = await findAuditRow("clauded-docs.delete", 424242);
  assert.ok(row, "audit_log row written for DELETE");
  assert.strictEqual(row.action_kind, "clauded-docs.delete");
  assert.strictEqual(row.result_code, "success");
  assert.strictEqual(row.actor, "monitor-web");
  assert.strictEqual(row.target_table, "clauded-docs");
  assert.strictEqual(Number(row.target_id), 424242);
});

test("POST /approve covered route → action_kind=improvement.approve (literal verb wins over method)", async () => {
  const res = await app.inject({ method: "POST", url: "/api/improvement/525252/approve" });
  assert.strictEqual(res.statusCode, 200);

  const row = await findAuditRow("improvement.approve", 525252);
  assert.ok(row, "audit_log row written for /approve");
  assert.strictEqual(row.action_kind, "improvement.approve");
  assert.strictEqual(row.result_code, "success");
  assert.strictEqual(row.target_table, "improvement");
});

test("PUT covered route returning 400 → result_code=blocked", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/clauded-docs/626262",
    payload: { status: 400 },
  });
  assert.strictEqual(res.statusCode, 400);

  const row = await findAuditRow("clauded-docs.update", 626262);
  assert.ok(row, "audit_log row written for 400 PUT");
  assert.strictEqual(row.result_code, "blocked");
});

// Negative scope — reads + uncovered routes produce no audit row.
test("GET on a covered route → NO audit row (mutation-only)", async () => {
  const before = await countAuditRows("clauded-docs.update");
  const res = await app.inject({ method: "GET", url: "/api/clauded-docs/999111" });
  assert.strictEqual(res.statusCode, 200);
  // GET has no method verb in the audited verb set and is filtered out before insert.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const after = await countAuditRows("clauded-docs.update");
  assert.strictEqual(after, before, "GET must not write an audit row");
});

test("uncovered mutating route → NO audit row", async () => {
  const before = await countAuditRows("never-audited.create");
  const res = await app.inject({ method: "POST", url: "/api/never-audited" });
  assert.strictEqual(res.statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const after = await countAuditRows("never-audited.create");
  assert.strictEqual(after, before, "uncovered route must not write an audit row");
  assert.strictEqual(after, 0, "uncovered action_kind never appears");
});

// Failure isolation — an audit INSERT that throws must NOT fail the handler.
test("audit INSERT failure does NOT propagate to the handler (response still succeeds)", async () => {
  // Force a REAL insert failure by monkeypatching the shared prisma singleton's $executeRaw
  // to throw, then assert: (1) the covered-route response still completes with the handler's
  // own status, and (2) the audit failure was swallowed + logged (never rethrown into the path).
  const prisma = getPrisma();
  const originalExecuteRaw = prisma.$executeRaw.bind(prisma);

  const failApp = Fastify({ logger: false });
  let swallowedWarnSeen = false;
  failApp.log.warn = ((_obj: unknown, msg?: unknown): void => {
    const text = typeof msg === "string" ? msg : "";
    if (text.includes("audit-log middleware")) {
      swallowedWarnSeen = true;
    }
  }) as unknown as typeof failApp.log.warn;

  registerAuditLogHook(failApp);
  failApp.delete("/api/clauded-docs/:id", async (_req, reply) => reply.code(204).send());
  await failApp.ready();

  // Poison the insert path — every $executeRaw now throws, simulating a DB-write failure.
  (prisma as { $executeRaw: unknown }).$executeRaw = (() => {
    return Promise.reject(new Error("forced audit insert failure"));
  }) as unknown as typeof prisma.$executeRaw;

  try {
    const res = await failApp.inject({ method: "DELETE", url: "/api/clauded-docs/000888" });
    // The handler's own 204 is returned untouched — the failing fire-and-forget audit write
    // never alters, delays, or fails the mutation response.
    assert.strictEqual(res.statusCode, 204, "handler response unaffected by audit insert failure");
    // Let the floating (rejected) audit promise settle so the swallow path runs.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(swallowedWarnSeen, "audit insert failure was swallowed + logged, not rethrown");
  } finally {
    // Restore the real $executeRaw before any cleanup query runs.
    (prisma as { $executeRaw: unknown }).$executeRaw = originalExecuteRaw;
    try {
      await failApp.close();
    } catch {
      // best-effort
    }
  }
});

// Coverage-drift guard — ROUTE_RESOURCE 가 등록된 모든 변이 라우트의 superset 유지.
// A09 orphan-class 회귀 방지 — map 등록을 빠뜨린 새 변이 라우트는 silently un-audited 가 됨.

// Mutating routes that are deliberately NOT audited. Each entry MUST carry a reason so the
// exclusion is intentional and visible — these are read/export operations using POST for a
// request body, not state mutations of the resource being audited.
//   '/api/clauded-docs/html-export'        — multi-doc HTML export (read/serialize, no DB mutation).
//   '/api/clauded-docs/search'             — POST-bodied search query (read-only; registered as GET
//                                            today, listed defensively in case it ever moves to POST).
const NON_AUDITED_MUTATIONS: ReadonlySet<string> = new Set([
  "/api/clauded-docs/html-export",
  "/api/clauded-docs/search",
]);

const MUTATING_METHOD_SET: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Build a throwaway app, register the real mutation-bearing routers, and collect every
 * registered route via the onRoute hook (Fastify route introspection) — never re-hardcode
 * the route list. Returns the set of mutating-route keys (method-agnostic union of url patterns).
 */
async function collectRegisteredMutatingRoutes(): Promise<Set<string>> {
  const introspectApp = Fastify({ logger: false });
  const mutatingRoutes = new Set<string>();
  introspectApp.addHook("onRoute", (route: RouteOptions): void => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const isMutating = methods.some((m) => MUTATING_METHOD_SET.has(String(m).toUpperCase()));
    if (isMutating) {
      mutatingRoutes.add(route.url);
    }
  });
  try {
    await registerClaudedDocsRoutes(introspectApp);
    await registerImprovementRoutes(introspectApp);
    await registerModelConfigRoutes(introspectApp);
    await introspectApp.ready();
  } finally {
    try {
      await introspectApp.close();
    } catch {
      // best-effort
    }
  }
  return mutatingRoutes;
}

test("coverage-drift guard: ROUTE_RESOURCE is a superset of all registered mutating routes", async () => {
  const registered = await collectRegisteredMutatingRoutes();
  assert.ok(registered.size > 0, "router introspection found at least one mutating route");

  // Every registered mutating route must be either audited (in ROUTE_RESOURCE) or explicitly
  // allowlisted as non-audited. Any route in neither set is a coverage gap → fail loudly.
  const uncovered: string[] = [];
  for (const routeKey of registered) {
    if (ROUTE_RESOURCE.has(routeKey)) {
      continue;
    }
    if (NON_AUDITED_MUTATIONS.has(routeKey)) {
      continue;
    }
    uncovered.push(routeKey);
  }
  assert.deepStrictEqual(
    uncovered,
    [],
    `mutating route(s) registered but neither audited nor allowlisted — add to ROUTE_RESOURCE ` +
      `in audit-log.ts or to NON_AUDITED_MUTATIONS with a reason: ${uncovered.join(", ")}`,
  );

  // Reverse hygiene — every audited key must still correspond to a real registered route, and
  // the allowlist must not reference a phantom route (stale-entry rot).
  for (const auditedKey of ROUTE_RESOURCE.keys()) {
    assert.ok(
      registered.has(auditedKey),
      `ROUTE_RESOURCE key '${auditedKey}' no longer matches any registered mutating route (stale)`,
    );
  }
});
