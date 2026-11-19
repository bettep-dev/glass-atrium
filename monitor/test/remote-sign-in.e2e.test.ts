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

import { REGISTRATION_CODE } from "../src/server/remote/registration-code.js";

const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const REGISTER_PATH = "/api/remote/register";
const PAGE_PATH = "/sign-in.html";
const LEAD = {
  empty: "Enter the code from the Mac, name this device, then tap Register device.",
  filled: "Check the code, name this device, then tap Register device.",
};
// every symbol of the code's alphabet, cut into codes of the code's length → each one is a code the Mac can show
const ALPHABET_CODES = REGISTRATION_CODE.ALPHABET.match(new RegExp(`.{${REGISTRATION_CODE.LENGTH}}`, "g")) ?? [];
const VALID_CODE = ALPHABET_CODES[1] ?? "";
// [0-9A-Z] symbols the Mac never shows
const FOREIGN_SYMBOLS = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter((symbol) => !REGISTRATION_CODE.ALPHABET.includes(symbol));
// the signed pre-auth file list → the remote app serves each one as an exact route, no device needed; every other file needs a registered device
const SIGN_IN_FILES = ["/sign-in.html", "/sign-in.js", "/sign-in.css"];
const WAIT_TIMEOUT_MS = 15_000;

const REFUSALS = [
  { name: "a refused code shows the one opaque refusal and marks the code field", answer: { status: 400, error: "registration_refused" }, message: /Code not accepted — show a new code on the Mac and use it/, invalidField: "Code", isCodeCleared: true },
  { name: "a refused device name marks the name field", answer: { status: 400, error: "label_invalid" }, message: /^Device name not accepted — use letters, numbers, spaces, \. _ -$/, invalidField: "Device name" },
  { name: "the device limit says to remove a device on the Mac", answer: { status: 409, error: "device_limit_reached" }, message: /Device limit reached — remove a device on the Mac, then show a new code/, invalidField: null },
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

  test("an empty page says to enter the code and name the device, and warns before a connection that is not private, with no certificate steps", async () => {
    await withPage(async (page) => {
      await openSignIn(page);

      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");

      assert.ok(text.includes(LEAD.empty), text);
      assert.match(text, /One use · a new code on the Mac replaces it/);
      assert.equal(await page.getByRole("heading", { name: "Connection warning" }).count(), 1);
      assert.match(text, /If the browser warned this connection is not private, close this page\./);
      assert.doesNotMatch(text, /step \d/i, "the steps differ by device, so the page names no step number");
      assert.doesNotMatch(text, /Remote access|Connect a device|Registered devices/, "a page shown before sign-in names no Mac screen or feature");
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
  test("a submit before the script binds posts the entry, so the code never lands in an address", async () => {
    await withPage(async (page) => {
      await page.route("**/sign-in.js", (route) => route.abort());
      await openSignIn(page);

      const navigation = page.waitForRequest((request) => request.isNavigationRequest(), { timeout: WAIT_TIMEOUT_MS });
      await submit(page, { code: "ABCDEFGH", label: "Pixel 9" });
      const request = await navigation;

      assert.deepEqual({ method: request.method(), hasCode: request.url().includes("ABCDEFGH") }, { method: "POST", hasCode: false });
    });
  });

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
          assert.equal(await page.getByLabel("Code").inputValue(), "isCodeCleared" in row ? "" : "ABCDEFGH", `${row.name}: only a refused code empties its field`);
        });
      });
    }
  });
});

describe("a code in the address fragment, from the Mac's QR code", () => {
  // what one load left behind: the address, the fields, the lead, every store a value could stay in, and the register requests
  async function loadFragment(page: Page, suffix: string) {
    const sent: unknown[] = [];
    await page.route(`**${REGISTER_PATH}`, (route) => {
      sent.push(route.request().postDataJSON());
      return route.abort();
    });
    await page.goto(`${serverUrl}${PAGE_PATH}${suffix}`, { waitUntil: "networkidle" });
    const state = await page.evaluate(() => ({
      href: window.location.href,
      historyState: window.history.state as unknown,
      historyLength: window.history.length,
      code: (document.getElementById("sign-in-code") as HTMLInputElement).value,
      label: (document.getElementById("sign-in-label") as HTMLInputElement).value,
      focused: document.activeElement?.id ?? null,
      lead: document.querySelector(".sign-in-lead")?.textContent ?? "",
      title: document.title,
      status: document.getElementById("sign-in-status")?.textContent ?? "",
      stored: window.localStorage.length + window.sessionStorage.length,
      cookie: document.cookie,
    }));
    return { ...state, sent };
  }

  const rows = [
    ...ALPHABET_CODES.map((code) => ({ name: `a code of the alphabet's symbols ${code} fills the field`, suffix: `#code=${code}`, code })),
    { name: "a query before a valid code is dropped with the fragment, never read", suffix: `?code=X#code=${VALID_CODE}`, code: VALID_CODE },
    { name: "a code one symbol too long is ignored", suffix: `#code=${VALID_CODE}2`, code: "" },
    { name: "a code one symbol too short is ignored", suffix: `#code=${VALID_CODE.slice(1)}`, code: "" },
    { name: "a lower-case code is ignored", suffix: `#code=${VALID_CODE.toLowerCase()}`, code: "" },
    ...FOREIGN_SYMBOLS.map((symbol) => ({ name: `a code holding ${symbol}, which the Mac never shows, is ignored`, suffix: `#code=${symbol}${VALID_CODE.slice(1)}`, code: "" })),
    { name: "another key is ignored", suffix: `#label=${VALID_CODE}`, code: "" },
    { name: "anything after the code is ignored", suffix: `#code=${VALID_CODE}&label=Pixel`, code: "" },
    { name: "anything before the key is ignored", suffix: `#x&code=${VALID_CODE}`, code: "" },
    { name: "a percent-encoded code is not decoded", suffix: `#code=${VALID_CODE.slice(1)}%32`, code: "" },
    { name: "markup is ignored", suffix: "#code=<b>ABCD</b>", code: "" },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      await withPage(async (page) => {
        const loaded = await loadFragment(page, row.suffix);

        assert.equal(loaded.href, `${serverUrl}${PAGE_PATH}`, `${row.name}: the address holds no fragment and no query`);
        assert.equal(loaded.code, row.code, row.name);
        assert.deepEqual(
          { label: loaded.label, title: loaded.title, status: loaded.status, stored: loaded.stored, cookie: loaded.cookie, historyState: loaded.historyState, sent: loaded.sent },
          { label: "", title: "Register this device · Atrium Monitor", status: "", stored: 0, cookie: "", historyState: null, sent: [] },
          `${row.name}: the value went nowhere but the code field, and nothing was sent`,
        );
        assert.deepEqual({ lead: loaded.lead, focused: loaded.focused }, row.code === "" ? { lead: LEAD.empty, focused: "sign-in-code" } : { lead: LEAD.filled, focused: "sign-in-label" }, row.name);
      });
    });
  }

  test("the fragment's entry is replaced, never added", async () => {
    await withPage(async (page) => {
      const plain = await loadFragment(page, "");
      const page2 = await page.context().newPage();
      const withCode = await loadFragment(page2, `#code=${VALID_CODE}`);

      assert.equal(withCode.historyLength, plain.historyLength);
    });
  });

  test("a second scan into the open page fills the field and cleans the address again", async () => {
    await withPage(async (page) => {
      await loadFragment(page, "");

      await page.evaluate((code) => {
        window.location.hash = `code=${code}`;
      }, VALID_CODE);
      await page.waitForFunction(() => window.location.hash === "" && (document.getElementById("sign-in-code") as HTMLInputElement).value !== "", null, { timeout: WAIT_TIMEOUT_MS });

      assert.deepEqual(await page.evaluate(() => ({ href: window.location.href, code: (document.getElementById("sign-in-code") as HTMLInputElement).value })), { href: `${serverUrl}${PAGE_PATH}`, code: VALID_CODE });
    });
  });

  test("a filled code leaves only with the person's press, in the register body", async () => {
    await withPage(async (page) => {
      const loaded = await loadFragment(page, `#code=${VALID_CODE}`);
      const sentAtLoad = [...loaded.sent];
      const posted = page.waitForRequest((request) => request.url().endsWith(REGISTER_PATH), { timeout: WAIT_TIMEOUT_MS });

      await page.getByLabel("Device name").fill("Pixel 9");
      await page.getByRole("button", { name: "Register device" }).click();

      assert.deepEqual(sentAtLoad, [], "nothing sent before the press");
      assert.deepEqual((await posted).postDataJSON(), { code: VALID_CODE, label: "Pixel 9" });
    });
  });

  test("a refused filled code empties the field, and the lead asks for a code again", async () => {
    await withPage(async (page) => {
      await page.route(`**${REGISTER_PATH}`, (route) => answerRegister(route, { status: 400, error: "registration_refused" }));
      await page.goto(`${serverUrl}${PAGE_PATH}#code=${VALID_CODE}`, { waitUntil: "load" });

      await page.getByLabel("Device name").fill("Pixel 9");
      await page.getByRole("button", { name: "Register device" }).click();
      await page.waitForFunction(() => (document.querySelector('[role="status"]')?.textContent ?? "").trim() !== "", null, { timeout: WAIT_TIMEOUT_MS });

      assert.deepEqual(
        { code: await page.getByLabel("Code").inputValue(), lead: await page.locator(".sign-in-lead").textContent() },
        { code: "", lead: LEAD.empty },
      );
    });
  });

  test("the lead follows a code typed by hand and then erased", async () => {
    await withPage(async (page) => {
      await openSignIn(page);
      const lead = page.locator(".sign-in-lead");

      await page.getByLabel("Code").fill("ABCD");
      const typed = await lead.textContent();
      await page.getByLabel("Code").fill("");

      assert.deepEqual({ typed, erased: await lead.textContent() }, { typed: LEAD.filled, erased: LEAD.empty });
    });
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
