// Remote device fetch: on the remote page every same-origin mutation carries the device's CSRF value in one shared place,
// read once from the session route; the Mac's loopback page keeps the browser's own fetch.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadScreenModule } from "./lib/render-screen.js";

const UI_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../public/src/ui.jsx");
const REMOTE_ORIGIN = "https://studio-mac.local:16146";
const SESSION_URL = "/api/remote/session";
const CSRF_VALUE = "c2Vzc2lvbi1kZXJpdmVkLWNzcmYtdmFsdWU";

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}

interface FakeWindow {
  location: { protocol: string; origin: string };
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

const ui = await loadScreenModule(UI_SRC, { Headers, URL, Request, Response });
const installRemoteFetch = ui.installRemoteFetch as (win: FakeWindow) => void;

/** Browser stand-in: records every request the page sends; the session route answers with `sessionStatus`. */
function createRemoteWindow(sessionStatuses: number[] = [200]): { win: FakeWindow; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const statuses = [...sessionStatuses];
  const win: FakeWindow = {
    location: { protocol: "https:", origin: REMOTE_ORIGIN },
    fetch: async (input, init = {}) => {
      sent.push({ url: String(input), method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers) });
      if (String(input) !== SESSION_URL) return new Response("{}", { status: 200 });
      const status = statuses.shift() ?? 200;
      const body = status === 200 ? { csrf: CSRF_VALUE, device: { id: "3", label: "Pixel 8" } } : { error: "not_registered" };
      return new Response(JSON.stringify(body), { status });
    },
  };
  return { win, sent };
}

describe("remote page fetch adds the device CSRF value to same-origin mutations only", () => {
  const rows = [
    { name: "a same-origin POST carries it", url: "/api/queue/items/7/answer", method: "POST", expected: CSRF_VALUE },
    { name: "a same-origin PATCH carries it", url: "/api/clauded-docs/12", method: "PATCH", expected: CSRF_VALUE },
    { name: "a same-origin DELETE carries it", url: "/api/agents/x", method: "DELETE", expected: CSRF_VALUE },
    { name: "a same-origin PUT written in lower case carries it", url: "/api/model-config", method: "put", expected: CSRF_VALUE },
    { name: "an absolute same-origin URL carries it", url: `${REMOTE_ORIGIN}/api/dashboard/update`, method: "POST", expected: CSRF_VALUE },
    { name: "a same-origin GET carries none", url: "/api/health", method: "GET", expected: null },
    { name: "a cross-origin POST carries none", url: "https://cdn.jsdelivr.net/npm/x", method: "POST", expected: null },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const { win, sent } = createRemoteWindow();
      installRemoteFetch(win);

      await win.fetch(row.url, { method: row.method, headers: { "Content-Type": "application/json" } });

      const request = sent.find((entry) => entry.url === row.url);
      assert.ok(request, `${row.name}: request not sent`);
      assert.equal(request.headers.get("x-csrf-token"), row.expected, row.name);
      assert.equal(request.headers.get("content-type"), "application/json", `${row.name}: caller header kept`);
    });
  }
});

test("the session route is read once for every mutation the page sends", async () => {
  const { win, sent } = createRemoteWindow();
  installRemoteFetch(win);

  await Promise.all([win.fetch("/api/a", { method: "POST" }), win.fetch("/api/b", { method: "DELETE" }), win.fetch("/api/c", { method: "PATCH" })]);

  assert.equal(sent.filter((entry) => entry.url === SESSION_URL).length, 1);
});

test("a failed session read sends no mutation and is read again by the next one", async () => {
  const { win, sent } = createRemoteWindow([500, 200]);
  installRemoteFetch(win);

  await assert.rejects(win.fetch("/api/a", { method: "POST" }));
  await win.fetch("/api/b", { method: "POST" });

  assert.deepEqual(
    sent.map((entry) => `${entry.method} ${entry.url} ${entry.headers.get("x-csrf-token") ?? "-"}`),
    [`GET ${SESSION_URL} -`, `GET ${SESSION_URL} -`, `POST /api/b ${CSRF_VALUE}`],
  );
});

test("the Mac's loopback page keeps the browser's own fetch", () => {
  const { win } = createRemoteWindow();
  win.location = { protocol: "http:", origin: "http://127.0.0.1:16145" };
  const browserFetch = win.fetch;

  installRemoteFetch(win);

  assert.equal(win.fetch, browserFetch);
});
