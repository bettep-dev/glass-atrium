// E2E chromium — every screen of the shipped shell renders under its own CSP, with every pinned script loaded.
// Payloads: test/fixtures/dashboard-payloads.json + app-shell-data-payloads.json (Cost, Documents), `{ rows: [] }` for every other /api read.
// Screens: read from the rendered primary nav, so a screen added to the nav is covered without editing this file.
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
import type { Browser, BrowserContext, Page, Request } from "playwright";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const PAYLOADS: Record<string, unknown> = {
  ...readPayloads("dashboard-payloads.json"),
  ...readPayloads("app-shell-data-payloads.json"),
};

const NAV_ITEM = 'nav[aria-label="Primary"] button';

// one global per pinned script — an integrity mismatch or a CSP block leaves its global undefined
const SCRIPT_GLOBALS = [
  "tailwind", "mermaid", "svgPanZoom", "React", "ReactDOM", "PropTypes",
  "Recharts", "hljs", "marked", "DOMPurify", "lucide", "MERMAID_CONFIG", "ensureElkLayout",
];

// Chromium's console text for a CSP block and for an SRI digest mismatch
const BLOCKED_CONSOLE = /Content Security Policy|integrity/i;

// ceiling only — a page that never settles fails here instead of passing on a fixed sleep
const SETTLE_TIMEOUT_MS = 30_000;

// document format → the node its body path leaves once marked / hljs / DOMPurify + mermaid have run
const RENDERED_BODY: Record<string, string> = {
  md: ".doc-body-isolation table",
  json: '.doc-body-isolation code[data-format="json"].hljs',
  html: ".doc-body-isolation pre.mermaid svg",
};

interface DocGroups {
  groups: { representative_title: string; representative_format: string }[];
}

interface NavScreen {
  id: string;
  label: string;
}

interface Shell {
  page: Page;
  errors: string[];
  pending: Set<Request>;
}

let app: FastifyInstance;
let serverUrl: string;
let browser: Browser;
let context: BrowserContext;

function readPayloads(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(HERE, "fixtures", file), "utf8"));
}

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

/** Opens a fresh page on `hash`, recording console CSP/SRI errors, uncaught page errors and requests in flight. */
async function openShell(hash: string): Promise<Shell> {
  const page = await context.newPage();
  const shell: Shell = { page, errors: [], pending: new Set() };
  page.on("console", (message) => {
    if (message.type() === "error" && BLOCKED_CONSOLE.test(message.text())) shell.errors.push(message.text());
  });
  page.on("pageerror", (error) => shell.errors.push(error.message));
  page.on("request", (request) => shell.pending.add(request));
  page.on("requestfinished", (request) => shell.pending.delete(request));
  page.on("requestfailed", (request) => shell.pending.delete(request));
  await page.goto(`${serverUrl}/#${hash}`, { waitUntil: "load" });
  return shell;
}

/**
 * Resolves once no request is in flight and #main-content holds no busy region, on two checks two frames apart.
 * Two frames → React commits the last response and runs its effects, so a fetch or lazy script an effect starts is seen.
 */
async function waitForSettled({ page, pending }: Shell): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let wasQuiet = false;
  for (;;) {
    const isBusy = await page.evaluate(() => new Promise<boolean>((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => done(document.querySelector('#main-content [aria-busy="true"]') !== null)));
    }));
    const isQuiet = pending.size === 0 && !isBusy;
    if (isQuiet && wasQuiet) return;
    wasQuiet = isQuiet;
    assert.ok(Date.now() < deadline, `page never settled — ${pending.size} requests in flight, busy region ${isBusy}`);
  }
}

async function assertNothingBlocked({ page, errors }: Shell): Promise<void> {
  const violations = await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
  assert.deepEqual({ violations, errors }, { violations: [], errors: [] });
}

/** The primary nav as rendered — each item clicked once and read back as its route id and screen label. */
async function getNavScreens(): Promise<NavScreen[]> {
  const { page } = await openShell("dashboard");
  await page.waitForSelector(NAV_ITEM, { timeout: 30_000 });
  const screens: NavScreen[] = [];
  for (const item of await page.locator(NAV_ITEM).all()) {
    await item.click();
    screens.push({
      id: await page.evaluate(() => window.location.hash.replace(/^#/, "").split("?")[0]),
      label: (await item.getAttribute("title")) ?? "",
    });
  }
  await page.close();
  return screens;
}

describe("the shell loads every pinned script under its CSP", () => {
  test("each pinned script defines its global and nothing is blocked", async () => {
    const shell = await openShell("dashboard");
    const missing = await shell.page.evaluate(
      (names) => names.filter((name) => (window as unknown as Record<string, unknown>)[name] === undefined),
      SCRIPT_GLOBALS,
    );
    assert.deepEqual(missing, []);
    await assertNothingBlocked(shell);
    await shell.page.close();
  });

  test("a diagram renders through mermaid and the lazily injected ELK bundle", async () => {
    const shell = await openShell("dashboard");
    const svg = await shell.page.evaluate(async () => {
      const w = window as unknown as {
        ensureElkLayout(): Promise<void>;
        mermaid: { render(id: string, source: string): Promise<{ svg: string }> };
      };
      await w.ensureElkLayout();
      return (await w.mermaid.render("csp-probe", "flowchart TD\n  Shell --> Policy\n  Policy --> Screen")).svg;
    });
    assert.match(svg, /^<svg[\s\S]*Policy[\s\S]*<\/svg>$/);
    await assertNothingBlocked(shell);
    await shell.page.close();
  });
});

describe("every screen renders under the CSP", () => {
  test("each primary nav item routes to a screen of its own", async (t) => {
    const screens = await getNavScreens();
    // repeated ids → the clicks never routed, and the loop below would open one screen many times
    assert.ok(screens.length > 1, `the rendered nav holds ${screens.length} items`);
    assert.equal(new Set(screens.map((screen) => screen.id)).size, screens.length, JSON.stringify(screens));

    for (const screen of screens) {
      await t.test(`${screen.label} mounts with no CSP violation, SRI failure or page error`, async () => {
        const shell = await openShell(screen.id);
        await shell.page.waitForSelector(`[data-screen-label="${screen.label}"] #main-content > :not(.placeholder)`, { timeout: 30_000 });
        await waitForSettled(shell);
        const painted = await shell.page.$eval("#main-content", (main) => (main.textContent ?? "").trim().length);
        assert.ok(painted > 0, `${screen.label} painted no text`);
        await assertNothingBlocked(shell);
        await shell.page.close();
      });
    }
  });
});

describe("populated payloads run their render paths under the CSP", () => {
  test("Cost draws its charts from populated payloads", async () => {
    const shell = await openShell("cost");
    await shell.page.waitForSelector("#main-content .recharts-surface path", { timeout: 30_000 });
    await waitForSettled(shell);
    await assertNothingBlocked(shell);
    await shell.page.close();
  });

  for (const group of (PAYLOADS["/api/clauded-docs/groups"] as DocGroups).groups) {
    const format = group.representative_format;
    test(`a ${format} document body renders in the viewer`, async () => {
      assert.ok(RENDERED_BODY[format], `no rendered-body selector for format ${format}`);
      const shell = await openShell("clauded-docs");
      await shell.page.click(`tr.doc-row[aria-label="${group.representative_title}"]`, { timeout: 30_000 });
      await shell.page.waitForSelector(RENDERED_BODY[format], { timeout: 30_000 });
      await waitForSettled(shell);
      await assertNothingBlocked(shell);
      await shell.page.close();
    });
  }
});
