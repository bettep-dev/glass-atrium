// E2E chromium — every screen of the shipped shell renders under its own CSP, with every pinned script loaded.
// Payloads: test/fixtures/dashboard-payloads.json for the Dashboard, `{ rows: [] }` for every other /api read.
//
// Runner: npx tsx --test test/app-shell.csp.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:client`, installed chromium, CDN network.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const PAYLOADS: Record<string, unknown> = JSON.parse(
  readFileSync(resolve(HERE, "fixtures", "dashboard-payloads.json"), "utf8"),
);

// the nav of public/src/app.jsx — id → the label the shell stamps on data-screen-label
const SCREENS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "cost", label: "Cost & usage" },
  { id: "model-config", label: "Models & budgets" },
  { id: "agents", label: "Agents" },
  { id: "outcomes", label: "Task results" },
  { id: "improvement", label: "Learning" },
  { id: "wiki", label: "Wiki" },
  { id: "architecture", label: "System map" },
  { id: "clauded-docs", label: "Documents" },
];

// one global per pinned script — an integrity mismatch or a CSP block leaves its global undefined
const SCRIPT_GLOBALS = [
  "tailwind", "mermaid", "svgPanZoom", "React", "ReactDOM", "PropTypes",
  "Recharts", "hljs", "marked", "DOMPurify", "lucide", "MERMAID_CONFIG", "ensureElkLayout",
];

// Chromium's console text for a CSP block and for an SRI digest mismatch
const BLOCKED_CONSOLE = /Content Security Policy|integrity/i;

// effects settle → fetches, charts and icon passes have run once
const SETTLE_MS = 1_500;

interface BlockedLog {
  violations: string[];
  errors: string[];
}

let app: FastifyInstance;
let serverUrl: string;
let browser: Browser;
let context: BrowserContext;

before(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  for (const [path, payload] of Object.entries(PAYLOADS)) app.get(path, async () => payload);
  app.get("/api/*", async () => ({ rows: [] }));
  serverUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // init scripts run outside the page's CSP → the listener is in place before the first script tag
  await context.addInitScript(() => {
    const sink: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = sink;
    document.addEventListener("securitypolicyviolation", (event) => {
      sink.push(`${event.effectiveDirective} blocked ${event.blockedURI || "inline"}`);
    });
  });
});

after(async () => {
  await browser?.close();
  await app?.close();
});

/** Opens a fresh page on `hash`, recording console CSP/SRI errors and uncaught page errors. */
async function openShell(hash: string): Promise<{ page: Page; log: BlockedLog }> {
  const page = await context.newPage();
  const log: BlockedLog = { violations: [], errors: [] };
  page.on("console", (message) => {
    if (message.type() === "error" && BLOCKED_CONSOLE.test(message.text())) log.errors.push(message.text());
  });
  page.on("pageerror", (error) => log.errors.push(error.message));
  await page.goto(`${serverUrl}/#${hash}`, { waitUntil: "load" });
  return { page, log };
}

async function getViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
}

describe("the shell loads every pinned script under its CSP", () => {
  test("each pinned script defines its global and nothing is blocked", async () => {
    const { page, log } = await openShell("dashboard");
    const missing = await page.evaluate(
      (names) => names.filter((name) => (window as unknown as Record<string, unknown>)[name] === undefined),
      SCRIPT_GLOBALS,
    );
    assert.deepEqual({ missing, violations: await getViolations(page), errors: log.errors }, { missing: [], violations: [], errors: [] });
    await page.close();
  });

  test("a diagram renders through mermaid and the lazily injected ELK bundle", async () => {
    const { page, log } = await openShell("dashboard");
    const svg = await page.evaluate(async () => {
      const w = window as unknown as {
        ensureElkLayout(): Promise<void>;
        mermaid: { render(id: string, source: string): Promise<{ svg: string }> };
      };
      await w.ensureElkLayout();
      return (await w.mermaid.render("csp-probe", "flowchart TD\n  Shell --> Policy\n  Policy --> Screen")).svg;
    });
    assert.match(svg, /^<svg[\s\S]*Policy[\s\S]*<\/svg>$/);
    assert.deepEqual({ violations: await getViolations(page), errors: log.errors }, { violations: [], errors: [] });
    await page.close();
  });
});

describe("every screen renders under the CSP", () => {
  for (const screen of SCREENS) {
    test(`${screen.label} mounts with no CSP violation, SRI failure or page error`, async () => {
      const { page, log } = await openShell(screen.id);
      await page.waitForSelector(`[data-screen-label="${screen.label}"] #main-content > :not(.placeholder)`, { timeout: 30_000 });
      await page.waitForTimeout(SETTLE_MS);
      const painted = await page.$eval("#main-content", (main) => (main.textContent ?? "").trim().length);
      assert.ok(painted > 0, `${screen.label} painted no text`);
      assert.deepEqual({ violations: await getViolations(page), errors: log.errors }, { violations: [], errors: [] });
      await page.close();
    });
  }
});
