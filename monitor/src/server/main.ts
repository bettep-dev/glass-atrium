// Fastify server entry — single-origin localhost; bind 127.0.0.1 ONLY (never 0.0.0.0 / ::).
// Static public/ at /, API at /api/*; graceful shutdown SIGINT/SIGTERM -> app.close() + prisma.$disconnect().

import "dotenv/config";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

import { logger } from "./logger.js";
import { assertSessionTimezoneIsUtc, disconnectPrisma, getPrisma } from "./db.js";
import { registerRoutes } from "./routes/index.js";
import { probeBrowserLaunch, registerBrowserShutdownHook } from "./clauded-docs/browser-pool.js";
import { registerAuditLogHook } from "./middleware/audit-log.js";
import { auditHtmlRootAtBoot } from "./maintenance/html-root-audit.js";

// Port SoT = config.toml [ports].monitor → 배포 시 ATRIUM_MONITOR_PORT 렌더(render-monitor-env.sh); 미설정 → 16145 default, PORT = generic fallback
const HOST = process.env.ATRIUM_MONITOR_HOST ?? "127.0.0.1";
const PORT = Number(process.env.ATRIUM_MONITOR_PORT ?? process.env.PORT ?? 16145);
// Reject a non-bindable port loudly — never silently bind a wrong port.
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  logger.error(
    { port: process.env.ATRIUM_MONITOR_PORT ?? process.env.PORT, resolved: PORT },
    "invalid ATRIUM_MONITOR_PORT/PORT — must be an integer 1-65535",
  );
  process.exit(1);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "..", "public");

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: false });

  await app.register(fastifyStatic, {
    root: PUBLIC_ROOT,
    prefix: "/",
    index: ["index.html"],
  });

  await registerRoutes(app);

  // audit-trail hook — mutating write 를 monitor.audit_log 에 fire-and-forget 기록(mutation 미차단)
  registerAuditLogHook(app);

  // onClose 에서 chromium 종료 → SIGTERM 시 zombie chromium 미잔류
  registerBrowserShutdownHook(app);

  return app;
}

function attachShutdown(app: FastifyInstance): void {
  let shuttingDown = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, "received shutdown signal");
    void shutdown(app, signal);
  };
  process.once("SIGINT", handle);
  process.once("SIGTERM", handle);
}

async function shutdown(app: FastifyInstance, signal: NodeJS.Signals): Promise<void> {
  try {
    await app.close();
    await disconnectPrisma();
    app.log.info({ signal }, "graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error, signal }, "graceful shutdown failed");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const app = await buildApp();
  attachShutdown(app);
  // Top-level handlers — log + exit so launchd respawns cleanly.
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "unhandledRejection");
    process.exit(1);
  });
  process.on("uncaughtException", (error) => {
    app.log.error({ err: error }, "uncaughtException");
    process.exit(1);
  });

  // pg session timezone UTC 검증을 app.listen 이전 실행 = DB gate: DB unavailable 이면 :16145 bind 전 fatal exit(1) → launchd respawn.
  // db.ts connectionTimeoutMillis:5000 이 pre-listen connect 를 5s bound → bootstrap early-liveness probe 통과; UTC 아니어도 fatal exit → drift 무음 지속 차단.
  try {
    await assertSessionTimezoneIsUtc();
    app.log.info("pg session timezone verification passed (UTC)");
  } catch (error) {
    app.log.error({ err: error }, "pg session timezone verification failed — fatal");
    process.exit(1);
  }

  // boot-stage pool pre-warm — cold-start latency 제거 (app.listen 이전, DB gate 직후).
  // db.ts idleTimeoutMillis:0 + min:1 은 reactive only → 여기서 첫 커넥션 생성; Prisma 7 per-query-shape JS compile 을 미리 지불해 실제 첫 요청은 무비용.
  await prewarmPool(app);

  // DB gate + pre-warm 통과 후에만 포트 bind — DB unavailable 은 여기 도달 전 exit
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`listening on http://${HOST}:${PORT}`);

  // boot-stage chromium launch probe — playwright 업그레이드 후 브라우저 바이너리 드리프트를 부팅 시점에 loud 표면화 (/api/health browser 필드 + health 카드).
  await probeStartupBrowser(app);

  // boot-stage html_path ↔ document-root 정합 감사 — root 이동 후 잔존 행을 기동 시점에 loud 표면화 (비치명)
  await auditHtmlRootAtBoot(app);
}

/**
 * Boot-time chromium launch probe. Launch failure (e.g. browser binary missing
 * after a playwright upgrade) is loud-failed via error log + /api/health
 * `browser:"failed"` — non-fatal so the monitor's non-export surfaces stay up.
 */
async function probeStartupBrowser(app: FastifyInstance): Promise<void> {
  const health = await probeBrowserLaunch();
  if (health.status === "ok") {
    app.log.info("chromium launch probe passed");
    return;
  }
  app.log.error(
    { reason: health.reason },
    "chromium launch probe FAILED — html export is broken; run `npx playwright install chromium` then restart the monitor",
  );
}

/**
 * Boot-time pool pre-warm — creates 1 connection + runs hot-route query shapes once in advance
 * so the first user request does not pay cold-connect + per-query-shape JS compile.
 * Not fatal on failure — handled best-effort since the health route lazily retries.
 */
async function prewarmPool(app: FastifyInstance): Promise<void> {
  try {
    // 1) 커넥션 생성 + SELECT 1 shape compile (min:1 floor 가 유지할 첫 커넥션 확보)
    await getPrisma().$queryRaw`SELECT 1`;
    // 2) hot-route self-call — app.inject = 외부 TCP/port 노출 없이 in-process handler 실행 · Promise.allSettled = 한 route 실패가 다른 warmup 미차단
    await Promise.allSettled([
      app.inject({ method: "GET", url: "/api/improvement" }),
      app.inject({ method: "GET", url: "/api/clauded-docs" }),
    ]);
    app.log.info("pool pre-warm complete");
  } catch (error) {
    // log+continue: pre-warm 은 성능 최적화일 뿐 정합성 요건 아님 → 실패해도 boot 진행
    app.log.warn({ err: error }, "pool pre-warm failed — cold-start optimization not applied (normal operation preserved)");
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "server bootstrap failed");
  process.exit(1);
});
