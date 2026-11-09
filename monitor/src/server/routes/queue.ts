// Owner queue API — the monitor's first encapsulated plugin (deliberately NOT fastify-plugin wrapped):
// its Host allowlist and queue-key hooks reach only /api/queue/* routes, never a root route.

import os from "node:os";
import path from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

import { respondDbFailure } from "../db-failure.js";
import { getMonitorPort } from "../monitor-port.js";
import { QueueEnvironmentError, QueueRequestError } from "../queue/errors.js";
import { ackItem, claimPendingItems, withdrawItem } from "../queue/delivery.js";
import { createItem, getCount, getItem } from "../queue/items.js";
import { deregisterSession, registerSession } from "../queue/registry.js";
import { buildHostAllowlistHook, buildQueueKeyHook } from "../queue/request-gate.js";
import {
  ackBodySchema,
  deregisterBodySchema,
  postItemBodySchema,
  registerBodySchema,
  sessionBodySchema,
} from "../queue/schemas.js";
import { parseIdParam } from "../route-params.js";

/** Title 200 + body 20000 + options 20000 chars at up to 4 UTF-8 bytes each, plus JSON framing. */
const POST_ROUTE_OPTIONS = { bodyLimit: 192 * 1024 } as const;

export interface QueueRouteOptions {
  /** Directory holding the 0600 `queue-key` file; read lazily, never at registration. */
  secretsDir: string;
  /** Port the Host allowlist pins (`127.0.0.1:<port>` · `localhost:<port>` · `[::1]:<port>`). */
  port: number;
  /** Home whose `.claude` / `.claude-<name>` directories are the only accepted config dirs. */
  homeDir: string;
}

type IdParams = { id: string };

/** One queue route call: route label (logs), the schema its raw input must pass, and the work it then runs. */
interface RequestSpec<S extends z.ZodType, W> {
  route: string;
  schema: S;
  input: unknown;
  work: W;
}

type RouteWork<R> = Pick<RequestSpec<z.ZodType, () => Promise<R>>, "route" | "work">;

/** Defaults resolved at registration time (never import time) so a caller-supplied secrets dir always wins. */
export function resolveQueueRouteOptions(secretsDir?: string): QueueRouteOptions {
  const gaRoot = process.env.GA_ROOT || path.join(os.homedir(), ".glass-atrium");
  return {
    secretsDir: secretsDir ?? path.join(gaRoot, "secrets"),
    port: getMonitorPort(),
    homeDir: os.homedir(),
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
  await app.register(sessionRoutesPlugin, options);
}

async function sessionRoutesPlugin(app: FastifyInstance, options: QueueRouteOptions): Promise<void> {
  app.addHook("onRequest", buildQueueKeyHook(options.secretsDir));
  registerSessionRoutes(app, options.homeDir);
  registerItemRoutes(app);
  registerDeliveryRoutes(app);
  registerWithdrawRoute(app);
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
      work: (id, query) => getItem(id, query.sessionId),
    }),
  );
}

function registerDeliveryRoutes(app: FastifyInstance): void {
  app.post("/api/queue/pending", POST_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/pending",
      schema: sessionBodySchema,
      input: request.body,
      work: async (body) => ({ items: await claimPendingItems(body.sessionId) }),
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

async function handleItemRequest<S extends z.ZodType, R>(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
  spec: RequestSpec<S, (id: number, parsed: z.infer<S>) => Promise<R>>,
): Promise<R | object> {
  const id = parseIdParam(request.params.id);
  if (id === null) return reply.code(400).send({ error: "invalid_id" });
  return handleParsed(request, reply, { ...spec, work: (parsed) => spec.work(id, parsed) });
}

// Issue paths + messages only → a rejected value is never echoed back
async function handleParsed<S extends z.ZodType, R>(
  request: FastifyRequest,
  reply: FastifyReply,
  spec: RequestSpec<S, (parsed: z.infer<S>) => Promise<R>>,
): Promise<R | object> {
  const parsed = spec.schema.safeParse(spec.input ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    return reply.code(400).send({ error: "invalid_input", issues });
  }
  return handleQueueRequest(request, reply, { route: spec.route, work: () => spec.work(parsed.data) });
}

async function handleQueueRequest<R>(request: FastifyRequest, reply: FastifyReply, spec: RouteWork<R>): Promise<R | object> {
  try {
    return await spec.work();
  } catch (error) {
    if (error instanceof QueueRequestError) {
      reply.code(error.statusCode);
      return { error: error.code, reason: error.message };
    }
    if (error instanceof QueueEnvironmentError) {
      request.log.error({ err: error, route: spec.route }, "queue environment read failed");
      reply.code(500);
      return { error: "queue_environment_failure" };
    }
    return respondDbFailure(request, reply, spec.route, error, "queue request failed");
  }
}
