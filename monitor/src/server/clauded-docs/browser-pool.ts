// Single source of truth for the ONE shared chromium instance (HTML export).
// Sharing avoids doubling the ~100MB resident cost + racing shutdown hooks
// (zombie risk). No `--no-sandbox` — chromium's default sandbox is the primary
// defense layer for any JS the rendered HTML runs.

import type { Browser } from "playwright";
import { chromium } from "playwright";
import type { FastifyInstance } from "fastify";
import { logger } from "../logger.js";

// Browser launch timeout (ms) — Playwright's documented default, explicit for review.
export const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;

/**
 * Thrown when Playwright cannot launch chromium. Callers map to a 503 envelope
 * so the daemon stays alive. Stage is always "launch" — render-stage failures
 * stay in the caller's own typed error (HtmlExportError).
 */
export class BrowserPoolError extends Error {
  readonly stage: "launch";
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "BrowserPoolError";
    this.stage = "launch";
  }
}

/**
 * Last chromium launch outcome — "unprobed" until the first launch attempt.
 * Surfaced via GET /api/health so browser-binary drift (playwright-core upgraded
 * without `npx playwright install`) is loud instead of a silent per-export skip.
 */
export interface BrowserLaunchHealth {
  status: "ok" | "failed" | "unprobed";
  reason?: string;
  checked_at?: string;
}

let launchHealth: BrowserLaunchHealth = { status: "unprobed" };

export function getBrowserLaunchHealth(): BrowserLaunchHealth {
  return launchHealth;
}

/**
 * Launch-path verification probe (boot-time caller in main.ts). Reuses the
 * connected shared instance when present; otherwise launches and closes a
 * throwaway browser so an unused monitor keeps zero chromium residency.
 * Every real launch also refreshes the health record (see launchBrowser).
 */
export async function probeBrowserLaunch(): Promise<BrowserLaunchHealth> {
  if (browserInstance !== null && browserInstance.isConnected()) {
    launchHealth = { status: "ok", checked_at: new Date().toISOString() };
    return launchHealth;
  }
  try {
    const browser = await launchBrowser();
    await browser.close().catch(() => undefined);
  } catch {
    // launchBrowser already logged the full error + recorded launchHealth.
  }
  return launchHealth;
}

// Reused chromium instance — null when not yet launched OR when a prior instance
// disconnected and was cleared (next acquireBrowser() relaunches).
let browserInstance: Browser | null = null;

// Concurrency guard — in-flight first-callers share one launch attempt.
let launchInFlight: Promise<Browser> | null = null;

/**
 * Returns the shared connected browser, launching lazily on first call.
 * Concurrent first-callers share a single in-flight launch promise.
 *
 * Throws BrowserPoolError on launch failure (caller maps to 503). The instance
 * stays alive across render failures so subsequent requests can succeed.
 */
export async function acquireBrowser(): Promise<Browser> {
  if (browserInstance !== null && browserInstance.isConnected()) {
    return browserInstance;
  }
  // Connection lost on a previous instance — clear before relaunch.
  if (browserInstance !== null) {
    browserInstance = null;
  }
  if (launchInFlight !== null) {
    return launchInFlight;
  }
  launchInFlight = launchBrowser();
  try {
    const launched = await launchInFlight;
    browserInstance = launched;
    return launched;
  } finally {
    launchInFlight = null;
  }
}

/**
 * Registers the onClose hook that shuts down the shared chromium browser on
 * Fastify teardown. MUST be wired BEFORE app.listen() per Fastify's addHook
 * contract. Register exactly once per app instance — a second registration
 * double-fires onClose (zombie close attempt).
 */
export function registerBrowserShutdownHook(app: FastifyInstance): void {
  app.addHook("onClose", async () => {
    await closeBrowserIfOpen(app);
  });
}

/**
 * Test/debug helper — forcibly closes the cached browser instance so the next
 * acquireBrowser() relaunches. NOT used in production; the onClose hook owns
 * shutdown there.
 */
export async function resetBrowserForTests(): Promise<void> {
  if (browserInstance !== null) {
    const b = browserInstance;
    browserInstance = null;
    await b.close().catch(() => undefined);
  }
  launchInFlight = null;
  launchHealth = { status: "unprobed" };
}

// internals

/**
 * Path-free reason for the public browser_reason field (red-team #21 sibling
 * site). A chromium launch failure — Playwright's "Executable doesn't exist at
 * <path>" message or a spawn errno — embeds the browser binary's absolute path
 * (server home-dir leak via the unauthenticated GET /api/health). The errno
 * code (ENOENT / EACCES / …) carries no path; the generic fallback covers
 * Playwright's own path-bearing message. Full error is logged server-side in
 * launchBrowser's catch, never returned. Mirrors routes/clauded-docs buildFsFailReason.
 */
export function buildLaunchFailReason(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? `launch error (${code})` : "chromium launch failed";
}

async function launchBrowser(): Promise<Browser> {
  try {
    // No --no-sandbox flag — keep chromium's default security boundary.
    const browser = await chromium.launch({
      timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      headless: true,
    });
    // Browser disconnect (crash, OOM kill) → clear the cache so the next
    // acquireBrowser() relaunches instead of returning a dead handle.
    browser.on("disconnected", () => {
      if (browserInstance === browser) {
        browserInstance = null;
      }
    });
    launchHealth = { status: "ok", checked_at: new Date().toISOString() };
    return browser;
  } catch (error) {
    // Full diagnostic (incl. the chromium binary absolute path) stays server-side
    // ONLY — probeBrowserLaunch swallows the throw, so this is the sole launch log.
    logger.error({ err: error }, "chromium launch failed");
    const reason = buildLaunchFailReason(error);
    launchHealth = { status: "failed", reason, checked_at: new Date().toISOString() };
    throw new BrowserPoolError(reason, error);
  }
}

async function closeBrowserIfOpen(app: FastifyInstance): Promise<void> {
  const b = browserInstance;
  if (b === null) return;
  browserInstance = null;
  try {
    await b.close();
    app.log.info({ module: "browser-pool" }, "chromium browser closed on shutdown");
  } catch (error) {
    app.log.warn(
      { module: "browser-pool", err: error },
      "chromium browser close failed during shutdown",
    );
  }
}
