// Prisma 7 client singleton via @prisma/adapter-pg driver-adapter pattern.
// connectionString is a Unix-socket URL (host=/tmp), set in .env.
// Generated client lives at src/generated/prisma/.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

let prismaSingleton: PrismaClient | null = null;

// adapter-pg ^7.8.0 timestamptz 9h drift 차단 → pg Pool startup param 으로 모든 커넥션 UTC 강제
// (wire-protocol startup message → pool reuse 전체 일관). 대안 기각: pool.on('connect') SET TIME ZONE (node-postgres #3265 race) · $executeRaw SET TIME ZONE (재사용 커넥션 미적용)
const POOL_STARTUP_OPTIONS = "-c timezone=UTC";

// warm-pool config — idle drain 차단으로 cold-start 제거 (drain → 0 시 Prisma 7 per-query-shape JS compile ~0.2~0.42s 재지불)
// PrismaPg 1st-arg 은 pg.PoolConfig 로 그대로 new pg.Pool() 전달 → options(timezone=UTC) 와 동일 flat object 공존
const POOL_WARM_CONFIG = {
  // idleTimeoutMillis falsy(0) → idle-close setTimeout 미예약 → 무기한 유지 (양수값은 drain 만 지연, 결국 0 도달)
  idleTimeoutMillis: 0,
  // pg-pool 은 reactive only (close 방지)이고 proactive fill 안 함 → boot pre-warm 이 1개 생성 후 유지
  min: 1,
  // socket-level liveness — Unix socket 에선 무해, TCP 전환 대비 유지
  keepAlive: true,
} as const;

/** Returns the lazily-initialized Prisma client (one per process). */
export function getPrisma(): PrismaClient {
  if (prismaSingleton !== null) {
    return prismaSingleton;
  }
  const connectionString = process.env.DATABASE_URL;
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error(
      "DATABASE_URL is not set; expected Unix-socket URL (postgresql://user@localhost/db?host=/tmp).",
    );
  }
  // 단일 PoolConfig object → adapter-pg 가 그대로 new pg.Pool() 전달: options(UTC drift fix) + warm-pool 필드 공존
  const adapter = new PrismaPg({
    connectionString,
    options: POOL_STARTUP_OPTIONS,
    ...POOL_WARM_CONFIG,
  });
  prismaSingleton = new PrismaClient({ adapter });
  return prismaSingleton;
}

/**
 * Startup-time assertion — verifies the pg session is actually UTC.
 * Fatal if not UTC — blocks silent drift. main.ts calls it right after server.listen().
 */
export async function assertSessionTimezoneIsUtc(): Promise<void> {
  const prisma = getPrisma();
  const rows = await prisma.$queryRaw<Array<{ TimeZone: string }>>`SHOW timezone`;
  const actual = rows[0]?.TimeZone;
  if (actual !== "UTC") {
    throw new Error(
      `pg session_timezone verification failed: expected UTC, actual ${actual ?? "<null>"}. ` +
        `adapter-pg Pool startup options not applied — check db.ts POOL_STARTUP_OPTIONS.`,
    );
  }
}

/** Closes the singleton's pg pool. Idempotent. */
export async function disconnectPrisma(): Promise<void> {
  if (prismaSingleton === null) {
    return;
  }
  const client = prismaSingleton;
  prismaSingleton = null;
  await client.$disconnect();
}
