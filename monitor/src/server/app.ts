// App assembly — the production Fastify wiring (guards → static → routes → audit hook → browser shutdown), importable
// with no side effect: no listen, no timer, no process.exit, no DB connection (Prisma stays lazy). main.ts owns those.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

import { logger } from "./logger.js";
import { type RegisterRoutesOptions, registerRoutes } from "./routes/index.js";
import { registerBrowserShutdownHook } from "./clauded-docs/browser-pool.js";
import { registerAuditLogHook } from "./middleware/audit-log.js";
import { registerRequestGuards } from "./request-guards.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "..", "public");

export type AppOptions = RegisterRoutesOptions;

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: false });

  // Before every route → the queue plugin copies the parsers the guards leave (text/plain removed) at its load
  registerRequestGuards(app);

  await app.register(fastifyStatic, {
    root: PUBLIC_ROOT,
    prefix: "/",
    index: ["index.html"],
  });

  await registerRoutes(app, options);

  // audit-trail hook — mutating write 를 monitor.audit_log 에 fire-and-forget 기록(mutation 미차단)
  registerAuditLogHook(app);

  // onClose 에서 chromium 종료 → SIGTERM 시 zombie chromium 미잔류
  registerBrowserShutdownHook(app);

  return app;
}
