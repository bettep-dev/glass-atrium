// Owner queue API — the monitor's first encapsulated plugin (deliberately NOT fastify-plugin wrapped):
// its Host allowlist and queue-key hooks reach only /api/queue/* routes, never a root route.

import os from "node:os";
import path from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

import { respondDbFailure } from "../db-failure.js";
import { QueueRequestError } from "../queue/errors.js";
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
const QUEUE_BODY_LIMIT_BYTES = 192 * 1024;
const DEFAULT_MONITOR_PORT = 16145;

export interface QueueRouteOptions {
  /** Directory holding the 0600 `queue-key` file; read lazily, never at registration. */
  secretsDir: string;
  /** Port the Host allowlist pins (`127.0.0.1:<port>` · `localhost:<port>` · `[::1]:<port>`). */
  port: number;
  /** Home whose `.claude` / `.claude-<name>` directories are the only accepted config dirs. */
  homeDir: string;
}

type IdParams = { id: string };

/** Defaults resolved at registration time (never import time) so a caller-supplied secrets dir always wins. */
export function resolveQueueRouteOptions(secretsDir?: string): QueueRouteOptions {
  const gaRoot = process.env.GA_ROOT || path.join(os.homedir(), ".glass-atrium");
  return {
    secretsDir: secretsDir ?? path.join(gaRoot, "secrets"),
    // same resolution as main.ts PORT, which validates it before listen
    port: Number(process.env.ATRIUM_MONITOR_PORT ?? process.env.PORT ?? DEFAULT_MONITOR_PORT),
    homeDir: os.homedir(),
  };
}

export async function registerQueueRoutes(app: FastifyInstance, options: QueueRouteOptions): Promise<void> {
  await app.register(queuePlugin, options);
}

async function queuePlugin(app: FastifyInstance, options: QueueRouteOptions): Promise<void> {
  app.addHook("onRequest", buildHostAllowlistHook(options.port));
  app.get("/api/queue/count", async (request, reply) =>
    handleQueueRequest(request, reply, "/api/queue/count", () => getCount()),
  );
  await app.register(sessionRoutesPlugin, options);
}

async function sessionRoutesPlugin(app: FastifyInstance, options: QueueRouteOptions): Promise<void> {
  app.addHook("onRequest", buildQueueKeyHook(options.secretsDir));
  const post = { bodyLimit: QUEUE_BODY_LIMIT_BYTES };
  app.post("/api/queue/sessions/register", post, async (request, reply) =>
    handleParsedBody(request, reply, "/api/queue/sessions/register", registerBodySchema, (body) => registerSession(body, options.homeDir)),
  );
  app.post("/api/queue/sessions/deregister", post, async (request, reply) =>
    handleParsedBody(request, reply, "/api/queue/sessions/deregister", deregisterBodySchema, async (body) => {
      await deregisterSession(body);
      return { ok: true };
    }),
  );
  app.post("/api/queue/items", post, async (request, reply) =>
    handleParsedBody(request, reply, "/api/queue/items", postItemBodySchema, async (body) => {
      reply.code(201);
      return createItem(body);
    }),
  );
  registerItemRoutes(app, post);
}

function registerItemRoutes(app: FastifyInstance, post: { bodyLimit: number }): void {
  app.get<{ Params: IdParams }>("/api/queue/items/:id", async (request, reply) =>
    handleItemRequest(request, reply, "/api/queue/items/:id", request.query, sessionBodySchema, (id, query) => getItem(id, query.sessionId)),
  );
  app.post("/api/queue/pending", post, async (request, reply) =>
    handleParsedBody(request, reply, "/api/queue/pending", sessionBodySchema, async (body) => ({
      items: await claimPendingItems(body.sessionId),
    })),
  );
  app.post<{ Params: IdParams }>("/api/queue/items/:id/ack", post, async (request, reply) =>
    handleItemRequest(request, reply, "/api/queue/items/:id/ack", request.body, ackBodySchema, async (id, body) => ({
      result: await ackItem(id, body.sessionId, body.msgId),
    })),
  );
  app.post<{ Params: IdParams }>("/api/queue/items/:id/withdraw", post, async (request, reply) =>
    handleItemRequest(request, reply, "/api/queue/items/:id/withdraw", request.body, sessionBodySchema, async (id, body) => {
      await withdrawItem(id, body.sessionId);
      return { ok: true };
    }),
  );
}

async function handleItemRequest<S extends z.ZodType, R>(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
  route: string,
  input: unknown,
  schema: S,
  work: (id: number, parsed: z.infer<S>) => Promise<R>,
): Promise<R | object> {
  const id = parseIdParam(request.params.id);
  if (id === null) return reply.code(400).send({ error: "invalid_id" });
  return handleParsed(request, reply, route, input, schema, (parsed) => work(id, parsed));
}

function handleParsedBody<S extends z.ZodType, R>(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  schema: S,
  work: (parsed: z.infer<S>) => Promise<R>,
): Promise<R | object> {
  return handleParsed(request, reply, route, request.body, schema, work);
}

// Issue paths + messages only → a rejected value is never echoed back
async function handleParsed<S extends z.ZodType, R>(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  input: unknown,
  schema: S,
  work: (parsed: z.infer<S>) => Promise<R>,
): Promise<R | object> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    return reply.code(400).send({ error: "invalid_input", issues });
  }
  return handleQueueRequest(request, reply, route, () => work(parsed.data));
}

async function handleQueueRequest<R>(request: FastifyRequest, reply: FastifyReply, route: string, work: () => Promise<R>): Promise<R | object> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof QueueRequestError) {
      reply.code(error.statusCode);
      return { error: error.code, reason: error.message };
    }
    return respondDbFailure(request, reply, route, error, "queue request failed");
  }
}
