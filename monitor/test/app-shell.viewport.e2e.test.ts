// App-shell viewport — index.html's own declaration, before any script runs: a phone lays the page out at the desktop width; a desktop browser keeps its window width.
// The Queue route's device-width layout on a phone → test/queue.phone.e2e.test.ts
// Runner: npx tsx --test test/app-shell.viewport.e2e.test.ts
//
// Layout width only → every off-origin request is aborted, so no CDN script is fetched.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser } from "playwright";
import { chromium } from "playwright";

const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
// the Queue desk needs 1012 → the page's own declared layout width
const DESKTOP_LAYOUT_WIDTH = 1280;

const DEVICES = [
  { name: "a phone lays the page out at the declared desktop width", options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, expected: DESKTOP_LAYOUT_WIDTH },
  { name: "a tablet lays the page out at the declared desktop width", options: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true }, expected: DESKTOP_LAYOUT_WIDTH },
  { name: "a desktop browser keeps its own window width", options: { viewport: { width: 1440, height: 900 } }, expected: 1440 },
];

let app: FastifyInstance;
let serverUrl: string;
let browser: Browser;

before(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/*", async () => ({ rows: [] }));
  serverUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await app?.close();
});

describe("app-shell layout width per device", () => {
  for (const device of DEVICES) {
    test(device.name, async () => {
      const context = await browser.newContext(device.options);
      try {
        const page = await context.newPage();
        await page.route("**/*", (route) => (route.request().url().startsWith(serverUrl) ? route.continue() : route.abort()));
        await page.goto(`${serverUrl}/`, { waitUntil: "domcontentloaded" });

        const layoutWidth = await page.evaluate(() => document.documentElement.clientWidth);

        assert.equal(layoutWidth, device.expected, `${device.name}: layout width ${layoutWidth}`);
      } finally {
        await context.close();
      }
    });
  }
});
