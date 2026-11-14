// App assembly — the production Fastify wiring (guards → static → routes → audit hook → browser shutdown), importable
// with no side effect: no listen, no timer, no process.exit, no DB connection (Prisma stays lazy). main.ts owns those.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

import { logger } from "./logger.js";
import { registerRoutes } from "./routes/index.js";
import { registerBrowserShutdownHook } from "./clauded-docs/browser-pool.js";
import { registerAuditLogHook } from "./middleware/audit-log.js";
import { registerRequestGuards } from "./request-guards.js";
import { getMonitorPort } from "./monitor-port.js";
import { type ListenerContext, buildHostAllowlistHook, setListenerContext } from "./queue/request-gate.js";
import { type RemoteGateDeps, registerRemoteGate } from "./remote/gate.js";
import { type RemoteTls, getRemoteServerOptions, setRemoteSocketLimits } from "./remote/listener.js";
import type { QueueRouteOptions } from "./routes/queue.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "..", "public");

// a meta CSP cannot carry frame-ancestors → a framed Queue page would send same-origin owner actions a neighbour page could click into
const STATIC_FRAME_HEADERS = { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" } as const;

export async function buildApp(port: number = getMonitorPort()): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: false });

  // a tunnel, proxy or rebound page reaching 127.0.0.1 carries its own Host → refused before any route, login-free API included
  app.addHook("onRequest", buildHostAllowlistHook(port));

  // Before every route → the queue plugin copies the parsers the guards leave (text/plain removed) at its load
  registerRequestGuards(app);

  await registerSurface(app);

  // audit-trail hook — mutating write 를 monitor.audit_log 에 fire-and-forget 기록(mutation 미차단)
  registerAuditLogHook(app);

  // onClose 에서 chromium 종료 → SIGTERM 시 zombie chromium 미잔류
  registerBrowserShutdownHook(app);

  return app;
}

const HOT_ROUTES = ["/api/improvement", "/api/clauded-docs"] as const;

/**
 * Boot pre-warm self-calls (in-process, no socket) → pays each hot route's first query-shape compile before a real request.
 * @returns the URLs that did not answer 2xx → main.ts logs them; an empty list means every route warmed
 */
export async function warmHotRoutes(app: FastifyInstance, port: number): Promise<string[]> {
  const host = `127.0.0.1:${port}`;
  const responses = await Promise.allSettled(HOT_ROUTES.map((url) => app.inject({ method: "GET", url, headers: { host } })));
  return HOT_ROUTES.filter((_url, index) => {
    const response = responses[index];
    return response?.status !== "fulfilled" || response.value.statusCode < 200 || response.value.statusCode >= 300;
  });
}

// every remote mutation but the image upload, whose route keeps its own limit
const REMOTE_BODY_LIMIT_BYTES = 96 * 1024;

export interface RemoteAppOptions {
  readonly tls: RemoteTls;
  readonly listener: ListenerContext;
  readonly gate: RemoteGateDeps;
  readonly queue?: QueueRouteOptions;
}

/**
 * The remote listener's app: the same surface behind the remote gate, which replaces the loopback request guards
 * (they admit `none`, absent headers and loopback origins only).
 * Owns no shared resource → no browser shutdown hook, no queue scheduler; closing it leaves the loopback app untouched.
 */
export async function buildRemoteApp(options: RemoteAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger, bodyLimit: REMOTE_BODY_LIMIT_BYTES, ...getRemoteServerOptions(options.tls) });
  setRemoteSocketLimits(app);
  setListenerContext(app, options.listener);
  await registerRemoteGate(app, options.gate);
  // same parser set as loopback → a cross-origin text/plain simple request gets 415
  app.removeContentTypeParser("text/plain");
  await registerSurface(app, options.queue);
  return app;
}

/** The page and API surface (static shell + every route) → the remote route classes are checked against this set. */
export async function registerSurface(app: FastifyInstance, queue?: QueueRouteOptions): Promise<void> {
  await app.register(fastifyStatic, {
    root: PUBLIC_ROOT,
    prefix: "/",
    index: ["index.html"],
    setHeaders: (reply) => {
      reply.headers(STATIC_FRAME_HEADERS);
    },
  });
  await registerRoutes(app, queue);
}
