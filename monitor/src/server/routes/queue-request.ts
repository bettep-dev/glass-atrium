// Shared request pipeline of the queue route files: id param → Zod parse → work → error mapping.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

import { respondDbFailure } from "../db-failure.js";
import { QueueEnvironmentError, QueueRequestError } from "../queue/errors.js";
import { parseIdParam } from "../route-params.js";

export type IdParams = { id: string };

/** One queue route call: route label (logs), the schema its raw input must pass, and the work it then runs. */
export interface RequestSpec<S extends z.ZodType, W> {
  route: string;
  schema: S;
  input: unknown;
  work: W;
}

export type RouteWork<R> = Pick<RequestSpec<z.ZodType, () => Promise<R>>, "route" | "work">;

export async function handleItemRequest<S extends z.ZodType, R>(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
  spec: RequestSpec<S, (id: number, parsed: z.infer<S>) => Promise<R>>,
): Promise<R | object> {
  const id = parseIdParam(request.params.id);
  if (id === null) return reply.code(400).send({ error: "invalid_id" });
  return handleParsed(request, reply, { ...spec, work: (parsed) => spec.work(id, parsed) });
}

// Issue paths + messages only → a rejected value is never echoed back
export async function handleParsed<S extends z.ZodType, R>(
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

export async function handleQueueRequest<R>(request: FastifyRequest, reply: FastifyReply, spec: RouteWork<R>): Promise<R | object> {
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
