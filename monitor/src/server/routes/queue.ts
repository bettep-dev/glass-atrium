// Owner queue API — the monitor's first encapsulated plugin (deliberately NOT fastify-plugin wrapped):
// its Host allowlist reaches only /api/queue/* routes, never a root route. No credential: a session route acts only on
// the session id it names; owner mutations (queue-owner.ts) additionally need the monitor page's own origin.

import os from "node:os";
import path from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { insertAudit, setAuditRecorded, setAuditTarget } from "../middleware/audit-log.js";
import { getMonitorPort } from "../monitor-port.js";
import { ackItem, claimPendingItems, getPendingCount, withdrawItem } from "../queue/delivery.js";
import { getQueueCliPath } from "../queue/envelope.js";
import { getQueueImageDir } from "../queue/images.js";
import { createItem, getClaimViews, getCount, getItemOrThrow } from "../queue/items.js";
import { getPeerSessions } from "../queue/owner-sessions.js";
import { type RelayRefusal, createRelay, getRefusalResponse } from "../queue/relay.js";
import { getSecretScannerPath } from "../queue/relay-scan.js";
import { deregisterSession, putSessionName, registerSession } from "../queue/registry.js";
import { secretRequests } from "../queue/scan-approvals.js";
import { buildHostAllowlistHook } from "../queue/request-gate.js";
import { hasBrowserSignal } from "../request-guards.js";
import {
  ackBodySchema,
  deregisterBodySchema,
  pendingBodySchema,
  pendingCountBodySchema,
  postItemBodySchema,
  registerRouteBodySchema,
  relayBodySchema,
  scanApprovalConsumeBodySchema,
  scanApprovalRegisterBodySchema,
  sessionBodySchema,
} from "../queue/schemas.js";
import { ownerRoutesPlugin } from "./queue-owner.js";
import { type IdParams, handleItemRequest, handleParsed, handleQueueRequest } from "./queue-request.js";

/** Title 200 + body 20000 + options 20000 chars at up to 4 UTF-8 bytes each, plus JSON framing. */
const POST_ROUTE_OPTIONS = { bodyLimit: 192 * 1024 } as const;
const SESSION_ONLY_ROUTE_OPTIONS = { ...POST_ROUTE_OPTIONS, onRequest: refuseBrowserRequest } as const;

export interface QueueRouteOptions {
  /** Port the Host allowlist and the page-origin leg pin (`127.0.0.1:<port>` · `localhost:<port>` · `[::1]:<port>`). */
  port: number;
  /** Home whose `.claude` / `.claude-<name>` directories are the only accepted config dirs. */
  homeDir: string;
  /** Installed queue CLI → the owner page's pull command names the real path on a non-default install. */
  cliPath: string;
  /** Owner image folder: uploads land here, the serve route and the session-side read name files in it. */
  imageDir: string;
  /** The install's secret scanner the relay route runs, fixed here so no request can name another. */
  scannerPath: string;
}

/** Defaults resolved at registration time (never import time) → a GA_ROOT set after import still wins. */
export function resolveQueueRouteOptions(): QueueRouteOptions {
  const gaRoot = process.env.GA_ROOT || path.join(os.homedir(), ".glass-atrium");
  return {
    port: getMonitorPort(),
    homeDir: os.homedir(),
    cliPath: getQueueCliPath(gaRoot),
    imageDir: getQueueImageDir(gaRoot),
    scannerPath: getSecretScannerPath(gaRoot),
  };
}

export async function registerQueueRoutes(app: FastifyInstance, options: QueueRouteOptions): Promise<void> {
  await app.register(queuePlugin, options);
}

async function queuePlugin(app: FastifyInstance, options: QueueRouteOptions): Promise<void> {
  app.addHook("onRequest", buildHostAllowlistHook(options.port));
  app.get("/api/queue/count", async (request, reply) =>
    handleQueueRequest(request, reply, { route: "/api/queue/count", work: () => getCount() }),
  );
  registerSessionRoutes(app, options.homeDir);
  registerItemRoutes(app, options.imageDir);
  registerDeliveryRoutes(app);
  registerPendingCountRoute(app);
  registerWithdrawRoute(app);
  registerPeerRoute(app);
  registerRelayRoute(app, options.scannerPath);
  registerScanApprovalRoutes(app);
  await app.register(ownerRoutesPlugin, options);
}

function registerSessionRoutes(app: FastifyInstance, homeDir: string): void {
  app.post("/api/queue/sessions/register", POST_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/sessions/register",
      schema: registerRouteBodySchema,
      input: request.body,
      work: (body): Promise<object> => ("cwd" in body ? registerSession(body, homeDir) : putSessionName(body).then(() => ({ ok: true }))),
    }),
  );
  app.post("/api/queue/sessions/deregister", POST_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/sessions/deregister",
      schema: deregisterBodySchema,
      input: request.body,
      work: (body) => deregisterSession(body).then((result) => ({ ok: true, ...result })),
    }),
  );
}

function registerItemRoutes(app: FastifyInstance, imageDir: string): void {
  app.post("/api/queue/items", POST_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/items",
      schema: postItemBodySchema,
      input: request.body,
      // 201 only once the row exists → a failed post keeps its own error status
      work: (body) => createItem(body).then((created) => { reply.code(201); return created; }),
    }),
  );
  app.get<{ Params: IdParams }>("/api/queue/items/:id", async (request, reply) =>
    handleItemRequest(request, reply, {
      route: "/api/queue/items/:id",
      schema: sessionBodySchema,
      input: request.query,
      work: (id, query) => getItemOrThrow(id, query.sessionId, imageDir),
    }),
  );
}

function registerDeliveryRoutes(app: FastifyInstance): void {
  app.post("/api/queue/pending", POST_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/pending",
      schema: pendingBodySchema,
      input: request.body,
      work: async (body) => ({ items: await getClaimViews(await claimPendingItems(body.sessionId, body.pid === undefined ? undefined : { pid: body.pid })) }),
    }),
  );
  app.post<{ Params: IdParams }>("/api/queue/items/:id/ack", POST_ROUTE_OPTIONS, async (request, reply) =>
    handleItemRequest(request, reply, {
      route: "/api/queue/items/:id/ack",
      schema: ackBodySchema,
      input: request.body,
      work: async (id, body) => ({ result: await ackItem(id, body.sessionId, body.msgId) }),
    }),
  );
}

function registerPendingCountRoute(app: FastifyInstance): void {
  app.post("/api/queue/pending/count", POST_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/pending/count",
      schema: pendingCountBodySchema,
      input: request.body,
      work: (body) => getPendingCount(body.sessionId, { pid: body.pid }),
    }),
  );
}

function registerWithdrawRoute(app: FastifyInstance): void {
  app.post<{ Params: IdParams }>("/api/queue/items/:id/withdraw", POST_ROUTE_OPTIONS, async (request, reply) =>
    handleItemRequest(request, reply, {
      route: "/api/queue/items/:id/withdraw",
      schema: sessionBodySchema,
      input: request.body,
      work: (id, body) => withdrawItem(id, body.sessionId).then(() => ({ ok: true })),
    }),
  );
}

function registerPeerRoute(app: FastifyInstance): void {
  app.post("/api/queue/peers", SESSION_ONLY_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/peers",
      schema: sessionBodySchema,
      input: request.body,
      work: (body) => getPeerSessions(body.sessionId),
    }),
  );
}

function registerRelayRoute(app: FastifyInstance, scannerPath: string): void {
  app.post("/api/queue/relay", SESSION_ONLY_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/relay",
      schema: relayBodySchema,
      input: request.body,
      work: async (body) => {
        const outcome = await createRelay(body, scannerPath);
        if ("relay" in outcome) {
          reply.code(201);
          return outcome.relay;
        }
        const refusal = getRefusalResponse(body.sessionId, outcome.refusal);
        await recordRelayRefusal(request, outcome.refusal, refusal);
        reply.code(refusal.statusCode);
        return refusal.body;
      },
    }),
  );
}

// The secret-scan hook's two calls; every reply carries ids only, never a line or a hash
function registerScanApprovalRoutes(app: FastifyInstance): void {
  app.post("/api/queue/scan-approvals", SESSION_ONLY_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/scan-approvals",
      schema: scanApprovalRegisterBodySchema,
      input: request.body,
      work: async (body) => {
        const requestId = secretRequests.create(body);
        request.log.info({ requestId }, "scan approval request registered");
        return { requestId };
      },
    }),
  );
  app.post("/api/queue/scan-approvals/consume", SESSION_ONLY_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/scan-approvals/consume",
      schema: scanApprovalConsumeBodySchema,
      input: request.body,
      work: async (body) => {
        const requestId = secretRequests.consume(body);
        if (requestId === null) {
          reply.code(409);
          return { error: "scan_approval_refused", decision: "refuse" };
        }
        request.log.info({ requestId }, "scan approval consumed — the write it covers passes once");
        return { decision: "pass", requestId };
      },
    }),
  );
}

async function recordRelayRefusal(request: FastifyRequest, outcome: RelayRefusal, refusal: ReturnType<typeof getRefusalResponse>): Promise<void> {
  if (outcome.isRecorded === false) {
    setAuditRecorded(request);
    return;
  }
  setAuditTarget(request, refusal.record);
  await insertAudit(request, { statusCode: refusal.statusCode, resultCode: "blocked" }).catch((error: unknown) => {
    request.log.error({ err: error, route: "/api/queue/relay", reason: outcome.reason }, "relay refusal audit row not written — the refusal is still returned");
  });
}

async function refuseBrowserRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!hasBrowserSignal(request.headers)) return;
  request.log.warn({ route: request.routeOptions.url, method: request.method }, "browser request refused on a session-only queue route");
  await reply.code(403).send({ error: "browser_request_refused" });
}
