// Owner routes of the queue (/api/queue/owner/*): passphrase login, then everything behind the owner-session cookie.
// A child of the queue plugin → it inherits the Host allowlist, never the queue-key hook; @fastify/cookie is
// registered here, so cookie parsing reaches no session route and no root route.

import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";

import { LoginLimiter } from "../queue/login-limiter.js";
import { putAnswer, putLater, putReply, putResend, putSeen } from "../queue/owner-items.js";
import { OWNER_COOKIE, OwnerSessionStore } from "../queue/owner-session.js";
import { getOwnerItemOrThrow, getOwnerItems } from "../queue/owner-views.js";
import { type PassphraseCheck, type PassphraseVerifier, createPassphraseVerifier } from "../queue/passphrase.js";
import { answerBodySchema, emptyBodySchema, loginBodySchema, ownerListQuerySchema, replyBodySchema } from "../queue/schemas.js";
import type { QueueRouteOptions } from "./queue.js";
import { type IdParams, handleItemRequest, handleParsed } from "./queue-request.js";

/** Answer or reply text 20000 chars at up to 4 UTF-8 bytes each, plus JSON framing. */
const OWNER_ROUTE_OPTIONS = { bodyLimit: 96 * 1024 } as const;

const COOKIE_OPTIONS = {
  path: OWNER_COOKIE.PATH,
  httpOnly: true,
  sameSite: "strict",
  maxAge: OWNER_COOKIE.MAX_AGE_SECONDS,
  // plain-http loopback has no network leg for Secure to protect, and a browser may drop a Secure cookie over http
  secure: false,
} as const;

/** Per-app owner auth state: lives in memory, so a monitor restart logs the owner out. */
interface OwnerAuth {
  verifier: PassphraseVerifier;
  sessions: OwnerSessionStore;
  limiter: LoginLimiter;
}

type ItemTransition = (id: number) => Promise<void>;

export async function ownerRoutesPlugin(app: FastifyInstance, options: QueueRouteOptions): Promise<void> {
  await app.register(fastifyCookie);
  const auth: OwnerAuth = {
    verifier: createPassphraseVerifier(options.secretsDir),
    sessions: new OwnerSessionStore(),
    limiter: new LoginLimiter(),
  };
  app.post("/api/queue/owner/login", OWNER_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/owner/login",
      schema: loginBodySchema,
      input: request.body,
      work: (body) => logIn(auth, body.passphrase, reply),
    }),
  );
  await app.register(ownerSessionRoutesPlugin, auth);
}

async function ownerSessionRoutesPlugin(app: FastifyInstance, auth: OwnerAuth): Promise<void> {
  app.addHook("onRequest", buildOwnerSessionHook(auth));
  app.post("/api/queue/owner/logout", OWNER_ROUTE_OPTIONS, async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/owner/logout",
      schema: emptyBodySchema,
      input: request.body,
      work: async () => logOut(auth, request, reply),
    }),
  );
  registerReadRoutes(app);
  registerAnswerRoutes(app);
  registerTransitionRoute(app, "later", putLater);
  registerTransitionRoute(app, "seen", putSeen);
  registerTransitionRoute(app, "resend", putResend);
}

function registerReadRoutes(app: FastifyInstance): void {
  app.get("/api/queue/owner/items", async (request, reply) =>
    handleParsed(request, reply, {
      route: "/api/queue/owner/items",
      schema: ownerListQuerySchema,
      input: request.query,
      work: (query) => getOwnerItems(query),
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

function registerAnswerRoutes(app: FastifyInstance): void {
  app.post<{ Params: IdParams }>("/api/queue/owner/items/:id/answer", OWNER_ROUTE_OPTIONS, async (request, reply) =>
    handleItemRequest(request, reply, {
      route: "/api/queue/owner/items/:id/answer",
      schema: answerBodySchema,
      input: request.body,
      work: (id, body) => putAnswer(id, body).then(() => ({ ok: true })),
    }),
  );
  app.post<{ Params: IdParams }>("/api/queue/owner/items/:id/reply", OWNER_ROUTE_OPTIONS, async (request, reply) =>
    handleItemRequest(request, reply, {
      route: "/api/queue/owner/items/:id/reply",
      schema: replyBodySchema,
      input: request.body,
      work: (id, body) => putReply(id, body).then(() => ({ ok: true })),
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

// No live cookie → 401, or 503 while the passphrase is not provisioned so the page can show the setup command
function buildOwnerSessionHook(auth: OwnerAuth): onRequestAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const id = request.cookies[OWNER_COOKIE.NAME];
    if (id !== undefined && auth.sessions.renew(id)) {
      reply.setCookie(OWNER_COOKIE.NAME, id, COOKIE_OPTIONS);
      return;
    }
    try {
      if (!(await auth.verifier.isProvisioned())) return reply.code(503).send({ error: "not_provisioned" });
    } catch (error) {
      request.log.error({ err: error }, "owner passphrase read failed");
      return reply.code(500).send({ error: "queue_environment_failure" });
    }
    return reply.code(401).send({ error: "unauthorized" });
  };
}

async function logIn(auth: OwnerAuth, passphrase: string, reply: FastifyReply): Promise<object> {
  const waitMs = auth.limiter.getWaitMs();
  if (waitMs > 0) {
    const retryAfterSeconds = Math.ceil(waitMs / 1000);
    reply.header("retry-after", String(retryAfterSeconds)).code(429);
    return { error: "login_throttled", retryAfterSeconds };
  }
  auth.limiter.setPending();
  // pending cleared in the same synchronous step as the verdict → no concurrent attempt slips between them
  let check: PassphraseCheck;
  try {
    check = await auth.verifier.verify(passphrase);
  } catch (error) {
    auth.limiter.deletePending();
    throw error;
  }
  if (check === "not_provisioned") {
    auth.limiter.deletePending();
    return reply.code(503).send({ error: "not_provisioned" });
  }
  auth.limiter.setResult(check === "match");
  if (check === "mismatch") return reply.code(401).send({ error: "wrong_passphrase" });
  reply.setCookie(OWNER_COOKIE.NAME, auth.sessions.create(), COOKIE_OPTIONS);
  return { ok: true };
}

function logOut(auth: OwnerAuth, request: FastifyRequest, reply: FastifyReply): object {
  const id = request.cookies[OWNER_COOKIE.NAME];
  if (id !== undefined) auth.sessions.delete(id);
  reply.clearCookie(OWNER_COOKIE.NAME, { path: OWNER_COOKIE.PATH });
  return { ok: true };
}
