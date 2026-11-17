// Remote sign-in page — what an unregistered device sees: one code entry, one message per server answer, and only its own files.
// Runner: npx tsx --test test/remote-sign-in.e2e.test.ts
//
// The register route is answered by Playwright, so no server code is under test here; every off-origin request is aborted.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { chromium } from "playwright";

const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const REGISTER_PATH = "/api/remote/register";
// the signed pre-auth file list → the remote app serves each one as an exact route, no device needed; every other file needs a registered device
const SIGN_IN_FILES = ["/sign-in.html", "/sign-in.js", "/sign-in.css"];
const WAIT_TIMEOUT_MS = 15_000;

const REFUSALS = [
  { name: "a refused code shows the one opaque refusal and marks the code field", answer: { status: 400, error: "registration_refused" }, message: /Code not accepted — open a new code on the Mac \(step 5\) and enter it/, invalidField: "Code" },
  { name: "a refused device name marks the name field and keeps the code valid", answer: { status: 400, error: "label_invalid" }, message: /Device name not accepted.*code is still valid/, invalidField: "Device name" },
  { name: "the device limit says to remove a device on the Mac", answer: { status: 409, error: "device_limit_reached" }, message: /Device limit reached — remove a device on the Mac, then open a new code/, invalidField: null },
  { name: "too many tries says to wait before the next one", answer: { status: 429, error: "too_many_requests" }, message: /Too many tries — wait a minute/, invalidField: null },
  { name: "any other refusal names its HTTP status", answer: { status: 503, error: "audit_unavailable" }, message: /Not registered \(HTTP 503\)/, invalidField: null },
  { name: "a request that never reaches the Mac says to check the network", answer: null, message: /Not sent — check this device is on the Mac's network, then try again/, invalidField: null },
];

const EMPTY_ENTRIES = [
  { name: "a code of only spaces and dashes asks for the code", entry: { code: " - ", label: "Pixel 9" }, message: /Enter the code shown on the Mac/, invalidField: "Code" },
  { name: "a blank device name asks for a name", entry: { code: "ABCDEFGH", label: "   " }, message: /Enter a device name/, invalidField: "Device name" },
];

let app: FastifyInstance;
let serverUrl: string;
let browser: Browser;

before(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/" });
  serverUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await app?.close();
});

describe("sign-in page load", () => {
  test("requests exactly its three pre-auth files and nothing else, each once, with no CSP block", async () => {
    await withPage(async (page) => {
      const requested: string[] = [];
      const loaded = new Map<string, number>();
      const blocked: string[] = [];
      // every request the page makes, any origin → an off-origin or extra same-origin fetch shows up here even though withPage aborts it
      page.on("request", (request) => requested.push(request.url()));
      page.on("response", (response) => loaded.set(response.url(), response.status()));
      page.on("console", (message) => /Content Security Policy/i.test(message.text()) && blocked.push(message.text()));

      await page.goto(`${serverUrl}/sign-in.html`, { waitUntil: "networkidle" });

      const expected = SIGN_IN_FILES.map((path) => `${serverUrl}${path}`).sort();
      assert.deepEqual([...requested].sort(), expected, "every request on load = the signed file list, nothing more");
      assert.deepEqual([...loaded.keys()].sort(), expected, "every signed file answered");
      assert.ok([...loaded.values()].every((status) => status === 200), `every file served: ${JSON.stringify([...loaded])}`);
      assert.deepEqual(blocked, []);
    });
  });

  test("the page says where the code is shown and warns before a connection that is not private, with no certificate steps", async () => {
    await withPage(async (page) => {
      await openSignIn(page);

      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");

      assert.match(text, /Enter the code shown on the Mac: Remote access → Connect a device → step 5\./);
      assert.match(text, /One use · a new code on the Mac replaces it/);
      assert.equal(await page.getByRole("heading", { name: "Connection warning" }).count(), 1);
      assert.match(text, /said the connection is not private, stop and do not enter the code\. On the Mac, open Remote access → Connect a device, finish steps 1 to 3/);
      assert.equal(await page.getByRole("heading", { name: "Certificate" }).count(), 0, "the certificate steps live on the Mac screen only");
      assert.doesNotMatch(text, /fingerprint|SHA-256|AirDrop|~\/|\.pem|revoke|Open registration|Android/i);
      assert.equal(await page.locator("ol").count(), 0, "no step list on the device");
    });
  });

  test("every listed pre-auth file exists in public/", () => {
    const missing = SIGN_IN_FILES.filter((path) => !existsSync(resolve(PUBLIC_ROOT, `.${path}`)));

    assert.deepEqual(missing, []);
  });

  test("a phone lays the form out at its own width with no sideways scroll", async () => {
    await withPage(
      async (page) => {
        await page.goto(`${serverUrl}/sign-in.html`, { waitUntil: "load" });

        const width = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));

        assert.deepEqual(width, { client: 390, scroll: 390 });
      },
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    );
  });
});

describe("registering the device", () => {
  test("sends the code as the Mac shows it and the trimmed name, then opens the monitor", async () => {
    await withPage(async (page) => {
      const sent: { body: unknown; contentType: string | undefined }[] = [];
      await page.route(`**${REGISTER_PATH}`, (route) => {
        sent.push({ body: route.request().postDataJSON(), contentType: route.request().headers()["content-type"] });
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ device: { id: "7", label: "Pixel 9" } }) });
      });
      await openSignIn(page);

      await submit(page, { code: " abcd-efgh ", label: "  Pixel 9 " });
      await page.waitForURL(`${serverUrl}/`, { waitUntil: "commit", timeout: WAIT_TIMEOUT_MS });

      assert.deepEqual(sent, [{ body: { code: "ABCDEFGH", label: "Pixel 9" }, contentType: "application/json" }]);
    });
  });

  test("the button is disabled and busy while the request is in flight", async () => {
    await withPage(async (page) => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolveHeld) => {
        release = resolveHeld;
      });
      await page.route(`**${REGISTER_PATH}`, async (route) => {
        await held;
        await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "too_many_requests" }) });
      });
      await openSignIn(page);

      await submit(page, { code: "ABCDEFGH", label: "Pixel 9" });
      const button = page.getByRole("button", { name: "Registering…" });
      await button.waitFor({ timeout: WAIT_TIMEOUT_MS });
      const inFlight = { disabled: await button.isDisabled(), busy: await button.getAttribute("aria-busy") };
      release();

      assert.deepEqual(inFlight, { disabled: true, busy: "true" });
    });
  });

  describe("an empty entry is caught on the device, so it never spends one of the code's tries", () => {
    for (const row of EMPTY_ENTRIES) {
      test(row.name, async () => {
        await withPage(async (page) => {
          let sentCount = 0;
          await page.route(`**${REGISTER_PATH}`, (route) => {
            sentCount += 1;
            return route.abort();
          });
          await openSignIn(page);

          await submit(page, row.entry);

          assert.match((await page.getByRole("status").textContent()) ?? "", row.message, row.name);
          assert.deepEqual(await getInvalidFields(page), [row.invalidField], row.name);
          assert.equal(sentCount, 0, row.name);
        });
      });
    }
  });

  describe("each refusal shows its own message and stays on the page", () => {
    for (const row of REFUSALS) {
      test(row.name, async () => {
        await withPage(async (page) => {
          await page.route(`**${REGISTER_PATH}`, (route) => answerRegister(route, row.answer));
          await openSignIn(page);

          await submit(page, { code: "ABCDEFGH", label: "Pixel 9" });
          const status = page.getByRole("status");
          await page.waitForFunction(() => (document.querySelector('[role="status"]')?.textContent ?? "").trim() !== "", null, { timeout: WAIT_TIMEOUT_MS });

          assert.match((await status.textContent()) ?? "", row.message, row.name);
          assert.equal(new URL(page.url()).pathname, "/sign-in.html", row.name);
          assert.deepEqual(await getInvalidFields(page), row.invalidField === null ? [] : [row.invalidField], row.name);
          assert.equal(await page.getByRole("button", { name: "Register device" }).isEnabled(), true, row.name);
        });
      });
    }
  });
});

async function withPage(body: (page: Page) => Promise<void>, options: Parameters<Browser["newContext"]>[0] = {}): Promise<void> {
  const context: BrowserContext = await browser.newContext(options);
  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => (route.request().url().startsWith(serverUrl) ? route.fallback() : route.abort()));
    await body(page);
  } finally {
    await context.close();
  }
}

async function openSignIn(page: Page): Promise<void> {
  await page.goto(`${serverUrl}/sign-in.html`, { waitUntil: "load" });
}

async function submit(page: Page, entry: { code: string; label: string }): Promise<void> {
  await page.getByLabel("Code").fill(entry.code);
  await page.getByLabel("Device name").fill(entry.label);
  await page.getByRole("button", { name: "Register device" }).click();
}

function answerRegister(route: Route, answer: { status: number; error: string } | null): Promise<void> {
  if (answer === null) return route.abort("internetdisconnected");
  return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify({ error: answer.error }) });
}

async function getInvalidFields(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('input[aria-invalid="true"]')].map((input) => (input as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? ""),
  );
}
