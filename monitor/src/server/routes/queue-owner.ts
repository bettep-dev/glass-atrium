// Owner routes of the queue (/api/queue/owner/*): no sign-in; every state change (message send included) must come from the monitor's own page.
// A child of the queue plugin → the Host allowlist runs before the page-origin hook, which a DNS-rebound page would pass.

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuditChangeCarrier } from "../middleware/audit-log.js";
import { QueueRequestError } from "../queue/errors.js";
import { IMAGE_BYTES_MAX, UPLOAD_CONTENT_TYPES, createImage, getImageFileOrThrow } from "../queue/images.js";
import { putAnswer, putLater, putReply, putResend, putSeen } from "../queue/owner-items.js";
import { getOwnerItemOrThrow, getOwnerItems, getOwnerOrders, getRecentResumes } from "../queue/owner-views.js";
import { createMessages, getOwnerSessions } from "../queue/owner-sessions.js";
import { type PageOriginCarrier, buildPageOriginHook, getPageOrigins } from "../queue/request-gate.js";
import {
  answerBodySchema,
  emptyBodySchema,
  imageParamsSchema,
  imageUploadQuerySchema,
  messageBodySchema,
  ownerListQuerySchema,
  ownerOrdersQuerySchema,
  ownerSessionsQuerySchema,
  recentResumesQuerySchema,
  replyBodySchema,
} from "../queue/schemas.js";
import type { PageOriginSignal } from "../request-guards.js";
import type { QueueRouteOptions } from "./queue.js";
import { type IdParams, handleItemRequest, handleParsed } from "./queue-request.js";

/** Answer, reply or message text 20000 chars at up to 4 UTF-8 bytes each, plus 20 session ids and JSON framing. */
const OWNER_ROUTE_OPTIONS = { bodyLimit: 96 * 1024 } as const;
const UPLOAD_ROUTE_OPTIONS = { bodyLimit: IMAGE_BYTES_MAX } as const;
// An image is shown by the page's <img> only: never sniffed into a document, never run, never embedded by another site
const IMAGE_SERVE_HEADERS = {
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; sandbox",
  "cache-control": "private, max-age=31536000, immutable",
} as const;

type ItemTransition = (id: number) => Promise<void>;

export async function ownerRoutesPlugin(app: FastifyInstance, options: QueueRouteOptions): Promise<void> {
  app.addHook("onRequest", buildPageOriginHook(getPageOrigins(options.port)));
  registerReadRoutes(app, options.cliPath);
  registerRecentResumesRoute(app);
  registerOrderHistoryRoute(app);
  registerAnswerRoutes(app);
  registerSessionRoutes(app);
  await app.register(imageUploadPlugin, options);
  registerImageServeRoute(app, options.imageDir);
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

// every status, unlike the owner list → an order stays readable after its session receives it
function registerOrderHistoryRoute(app: FastifyInstance): void {
  app.get("/api/queue/owner/orders", async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/owner/orders",
      schema: ownerOrdersQuerySchema,
      input: request.query,
      work: (query) => getOwnerOrders(query),
    }),
  );
}

function registerAnswerRoutes(app: FastifyInstance): void {
  app.post<{ Params: IdParams }>("/api/queue/owner/items/:id/answer", OWNER_ROUTE_OPTIONS, async (request, reply) =>
    handleItemRequest(request, reply, {
      route: "/api/queue/owner/items/:id/answer",
      schema: answerBodySchema,
      input: request.body,
      work: (id, body) => putAnswer(id, body, getPageOriginSignalOrThrow(request)).then(() => ({ ok: true })),
    }),
  );
  app.post<{ Params: IdParams }>("/api/queue/owner/items/:id/reply", OWNER_ROUTE_OPTIONS, async (request, reply) =>
    handleItemRequest(request, reply, {
      route: "/api/queue/owner/items/:id/reply",
      schema: replyBodySchema,
      input: request.body,
      work: (id, body) => putReply(id, body, getPageOriginSignalOrThrow(request)).then(() => ({ ok: true })),
    }),
  );
}

function registerSessionRoutes(app: FastifyInstance): void {
  app.get("/api/queue/owner/sessions", async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/owner/sessions",
      schema: ownerSessionsQuerySchema,
      input: request.query,
      work: (query) => getOwnerSessions(query),
    }),
  );
  app.post("/api/queue/owner/messages/send", OWNER_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/owner/messages/send",
      schema: messageBodySchema,
      input: request.body,
      work: async (body) => {
        const created = await createMessages(body, getPageOriginSignalOrThrow(request));
        (request as FastifyRequest & AuditChangeCarrier).auditChange = { itemIds: created.items.map((item) => item.id) };
        reply.code(201);
        return created;
      },
    }),
  );
}

/**
 * Upload: one image as the raw body. Its own encapsulated plugin → the image parsers reach this route alone, and no
 * CORS-simple type (text/plain, form, multipart) is ever parsed; the parent's page-origin hook still runs first.
 */
async function imageUploadPlugin(app: FastifyInstance, options: QueueRouteOptions): Promise<void> {
  app.addContentTypeParser(UPLOAD_CONTENT_TYPES, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.post("/api/queue/owner/images", UPLOAD_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/owner/images",
      schema: imageUploadQuerySchema,
      input: request.query,
      work: async (query) => {
        const created = await createImage(options.imageDir, Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0), query.name);
        reply.code(201);
        return created;
      },
    }),
  );
}

function registerImageServeRoute(app: FastifyInstance, imageDir: string): void {
  app.get("/api/queue/owner/images/:id", async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/owner/images/:id",
      schema: imageParamsSchema,
      input: request.params,
      work: async (params) => {
        const file = await getImageFileOrThrow(imageDir, params.id);
        reply.headers({ ...IMAGE_SERVE_HEADERS, "content-type": file.mime, "content-disposition": `inline; filename="${file.fileName}"` });
        return file.bytes;
      },
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

// The page-origin hook stamps every mutation it admits → no stamp is a wiring fault, still refused, never recorded
function getPageOriginSignalOrThrow(request: FastifyRequest): PageOriginSignal {
  const signal = (request as FastifyRequest & PageOriginCarrier).pageOriginSignal;
  if (signal === undefined) throw new QueueRequestError(403, "not_page_origin", "the request is not from the monitor page");
  return signal;
}
