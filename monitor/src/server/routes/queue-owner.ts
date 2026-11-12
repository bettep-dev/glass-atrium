// Owner routes of the queue (/api/queue/owner/*): no sign-in; every state change must come from the monitor's own page.
// A child of the queue plugin → the Host allowlist runs before the page-origin hook, which a DNS-rebound page would pass.

import type { FastifyInstance, FastifyRequest } from "fastify";

import { QueueRequestError } from "../queue/errors.js";
import { putAnswer, putLater, putReply, putResend, putSeen } from "../queue/owner-items.js";
import { getOwnerItemOrThrow, getOwnerItems, getRecentResumes } from "../queue/owner-views.js";
import { buildPageOriginHook, getPageOrigins } from "../queue/request-gate.js";
import { answerBodySchema, emptyBodySchema, ownerListQuerySchema, recentResumesQuerySchema, replyBodySchema } from "../queue/schemas.js";
import { type PageOriginSignal, getPageOriginSignal } from "../request-guards.js";
import type { QueueRouteOptions } from "./queue.js";
import { type IdParams, handleItemRequest, handleParsed } from "./queue-request.js";

/** Answer or reply text 20000 chars at up to 4 UTF-8 bytes each, plus JSON framing. */
const OWNER_ROUTE_OPTIONS = { bodyLimit: 96 * 1024 } as const;

type ItemTransition = (id: number) => Promise<void>;

export async function ownerRoutesPlugin(app: FastifyInstance, options: QueueRouteOptions): Promise<void> {
  const pageOrigins = getPageOrigins(options.port);
  app.addHook("onRequest", buildPageOriginHook(pageOrigins));
  registerReadRoutes(app, options.cliPath);
  registerRecentResumesRoute(app);
  registerAnswerRoutes(app, pageOrigins);
  registerTransitionRoute(app, "later", putLater);
  registerTransitionRoute(app, "seen", putSeen);
  registerTransitionRoute(app, "resend", putResend);
}

function registerReadRoutes(app: FastifyInstance, cliPath: string): void {
  app.get("/api/queue/owner/items", async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/owner/items",
      schema: ownerListQuerySchema,
      input: request.query,
      work: async (query) => ({ ...(await getOwnerItems(query)), cliPath }),
    }),
  );
  app.get<{ Params: IdParams }>("/api/queue/owner/items/:id", async (request, reply) =>
    handleItemRequest(request, reply, {
      route: "/api/queue/owner/items/:id",
      schema: emptyBodySchema,
      input: request.query,
      work: (id) => getOwnerItemOrThrow(id),
    }),
  );
}

// page-level record: reads Delivery rows, not the owner list → a resume of a delivered item stays listed
function registerRecentResumesRoute(app: FastifyInstance): void {
  app.get("/api/queue/owner/resumes", async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/owner/resumes",
      schema: recentResumesQuerySchema,
      input: request.query,
      work: (query) => getRecentResumes(query),
    }),
  );
}

function registerAnswerRoutes(app: FastifyInstance, pageOrigins: ReadonlySet<string>): void {
  app.post<{ Params: IdParams }>("/api/queue/owner/items/:id/answer", OWNER_ROUTE_OPTIONS, async (request, reply) =>
    handleItemRequest(request, reply, {
      route: "/api/queue/owner/items/:id/answer",
      schema: answerBodySchema,
      input: request.body,
      work: (id, body) => putAnswer(id, body, getPageOriginSignalOrThrow(request, pageOrigins)).then(() => ({ ok: true })),
    }),
  );
  app.post<{ Params: IdParams }>("/api/queue/owner/items/:id/reply", OWNER_ROUTE_OPTIONS, async (request, reply) =>
    handleItemRequest(request, reply, {
      route: "/api/queue/owner/items/:id/reply",
      schema: replyBodySchema,
      input: request.body,
      work: (id, body) => putReply(id, body, getPageOriginSignalOrThrow(request, pageOrigins)).then(() => ({ ok: true })),
    }),
  );
}

function registerTransitionRoute(app: FastifyInstance, action: "later" | "seen" | "resend", transition: ItemTransition): void {
  const route = `/api/queue/owner/items/:id/${action}`;
  app.post<{ Params: IdParams }>(route, OWNER_ROUTE_OPTIONS, async (request, reply) =>
    handleItemRequest(request, reply, {
      route,
      schema: emptyBodySchema,
      input: request.body,
      work: (id) => transition(id).then(() => ({ ok: true })),
    }),
  );
}

// The page-origin hook already refused a request with no signal → null here is a wiring fault, still refused, never stamped
function getPageOriginSignalOrThrow(request: FastifyRequest, pageOrigins: ReadonlySet<string>): PageOriginSignal {
  const signal = getPageOriginSignal(request.headers, pageOrigins);
  if (signal === null) throw new QueueRequestError(403, "not_page_origin", "the request is not from the monitor page");
  return signal;
}
