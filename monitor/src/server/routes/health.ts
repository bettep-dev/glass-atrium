// GET /api/health — liveness + DB probe + chromium launch-path health.
// Always 200 (launchd/curl smoke checks pass) → `db` field is the actionable signal · PG 실패 시 status='degraded' + db='closed'.
// `browser` = last chromium launch outcome (boot probe + real launches) — binary
// drift after a playwright upgrade surfaces here instead of a silent export skip.
// `status` stays DB-driven on purpose: health-screen PG card keys on it.

import type { FastifyInstance } from "fastify";
import { getPrisma } from "../db.js";
import { DAY_BUCKET_TIMEZONE } from "../timezone.js";
import { getBrowserLaunchHealth } from "../clauded-docs/browser-pool.js";
import { getAtriumVersion } from "../version.js";

interface HealthResponse {
  status: "ok" | "degraded";
  db: "open" | "closed";
  browser: "ok" | "failed" | "unprobed";
  browser_reason?: string;
  browser_checked_at?: string;
  version: string;
  // Resolved display/day-bucket timezone — echoes DAY_BUCKET_TIMEZONE verbatim,
  // i.e. the RESOLVED host tz when [meta].timezone='auto' (non-Seoul reflected
  // as-is), or the explicit IANA override. No schema change. The client boot fetch
  // (app.jsx) seeds its display timezone from this field.
  timezone: string;
}

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async (): Promise<HealthResponse> => {
    const browser = getBrowserLaunchHealth();
    const browserFields = {
      browser: browser.status,
      ...(browser.reason !== undefined ? { browser_reason: browser.reason } : {}),
      ...(browser.checked_at !== undefined
        ? { browser_checked_at: browser.checked_at }
        : {}),
    };
    // Unified system version from ~/.glass-atrium/manifest.json (single SoT);
    // degrades to "unknown" if the manifest is unreadable — never throws.
    const version = await getAtriumVersion(app.log);
    const prisma = getPrisma();
    try {
      await prisma.$queryRaw`SELECT 1`;
      return {
        status: "ok",
        db: "open",
        ...browserFields,
        version,
        timezone: DAY_BUCKET_TIMEZONE,
      };
    } catch (error) {
      // log+continue (not rethrow) — degraded health is the intended response shape · rethrow → 500 + double-log.
      app.log.warn({ err: error }, "health probe: PG SELECT 1 failed");
      return {
        status: "degraded",
        db: "closed",
        ...browserFields,
        version,
        timezone: DAY_BUCKET_TIMEZONE,
      };
    }
  });
}
