// Owner queue API — the monitor's first encapsulated plugin (deliberately NOT fastify-plugin wrapped):
// its Host allowlist reaches only /api/queue/* routes, never a root route. No credential: a session route acts only on
// the session id it names; owner mutations (queue-owner.ts) additionally need the monitor page's own origin.

import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";

import { getMonitorPort } from "../monitor-port.js";
import { ackItem, claimPendingItems, withdrawItem } from "../queue/delivery.js";
import { getQueueCliPath } from "../queue/envelope.js";
import { createItem, getCount, getItemOrThrow } from "../queue/items.js";
import { deregisterSession, registerSession } from "../queue/registry.js";
import { buildHostAllowlistHook } from "../queue/request-gate.js";
import {
  ackBodySchema,
  deregisterBodySchema,
  pendingBodySchema,
  postItemBodySchema,
  registerBodySchema,
  sessionBodySchema,
} from "../queue/schemas.js";
import { ownerRoutesPlugin } from "./queue-owner.js";
import { type IdParams, handleItemRequest, handleParsed, handleQueueRequest } from "./queue-request.js";

/** Title 200 + body 20000 + options 20000 chars at up to 4 UTF-8 bytes each, plus JSON framing. */
const POST_ROUTE_OPTIONS = { bodyLimit: 192 * 1024 } as const;

export interface QueueRouteOptions {
  /** Port the Host allowlist and the page-origin leg pin (`127.0.0.1:<port>` · `localhost:<port>` · `[::1]:<port>`). */
  port: number;
  /** Home whose `.claude` / `.claude-<name>` directories are the only accepted config dirs. */
  homeDir: string;
  /** Installed queue CLI → the owner page's pull command names the real path on a non-default install. */
  cliPath: string;
}

/** Defaults resolved at registration time (never import time) → a GA_ROOT set after import still wins. */
export function resolveQueueRouteOptions(): QueueRouteOptions {
  const gaRoot = process.env.GA_ROOT || path.join(os.homedir(), ".glass-atrium");
  return {
    port: getMonitorPort(),
    homeDir: os.homedir(),
    cliPath: getQueueCliPath(gaRoot),
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
  registerItemRoutes(app);
  registerDeliveryRoutes(app);
  registerWithdrawRoute(app);
  await app.register(ownerRoutesPlugin, options);
}

function registerSessionRoutes(app: FastifyInstance, homeDir: string): void {
  app.post("/api/queue/sessions/register", POST_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/sessions/register",
      schema: registerBodySchema,
      input: request.body,
      work: (body) => registerSession(body, homeDir),
    }),
  );
  app.post("/api/queue/sessions/deregister", POST_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/sessions/deregister",
      schema: deregisterBodySchema,
      input: request.body,
      work: (body) => deregisterSession(body).then(() => ({ ok: true })),
    }),
  );
}

function registerItemRoutes(app: FastifyInstance): void {
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
      work: (id, query) => getItemOrThrow(id, query.sessionId),
    }),
  );
}

function registerDeliveryRoutes(app: FastifyInstance): void {
  app.post("/api/queue/pending", POST_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/pending",
      schema: pendingBodySchema,
      input: request.body,
      work: async (body) => ({ items: await claimPendingItems(body.sessionId, body.pid === undefined ? undefined : { pid: body.pid }) }),
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
