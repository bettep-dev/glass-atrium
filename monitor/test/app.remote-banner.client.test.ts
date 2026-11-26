// Remote banner acts: a registered device signs itself out (back to the sign-in page) or turns remote access off for every device
// (the listener closes, so the page stays and says so); a refused act never leaves the page.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { collectText, createReactStub, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SRC = resolve(HERE, "../public/src/app.jsx");
const UI_SRC = resolve(HERE, "../public/src/ui.jsx");

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

type RemoteAct = "logout" | "off";

const react = createReactStub();
const SESSION_URL = "/api/remote/session";
const uiGlobals = { React: react, setInterval: () => 0, clearInterval: () => undefined, Headers, URL, Request };
const ui = (await loadScreenModule(UI_SRC, uiGlobals)).UI as Record<string, unknown>;

async function loadApp(status: number) {
  const sent: SentRequest[] = [];
  const replaced: string[] = [];
  const mod = await loadScreenModule(APP_SRC, {
    React: react,
    ReactDOM: { createRoot: () => ({ render: () => undefined }) },
    UI: ui,
    location: { protocol: "https:", origin: "https://studio-mac.local:16146", hash: "", replace: (url: string) => replaced.push(url) },
    document: { getElementById: () => null, querySelector: () => null, documentElement: { setAttribute: () => undefined, style: { setProperty: () => undefined } } },
    fetch: async (url: string, init: RequestInit = {}) => {
      // the page's shared CSRF read → answered, kept out of the acts under test
      if (url === SESSION_URL) return new Response(JSON.stringify({ csrf: "c3Jm", device: { id: "3", label: "Pixel 8" } }), { status: 200 });
      sent.push({ url, method: init.method ?? "GET", body: init.body });
      return new Response(JSON.stringify(status < 300 ? {} : { error: "not_page_origin" }), { status });
    },
  });
  return { deleteRemoteAccess: mod.deleteRemoteAccess as (act: RemoteAct) => Promise<string>, RemoteBanner: mod.RemoteBanner, sent, replaced };
}

describe("a remote device reduces access from its own banner", () => {
  test("signing out posts an empty logout and opens the sign-in page", async () => {
    const app = await loadApp(200);

    await app.deleteRemoteAccess("logout");

    assert.deepEqual(app.sent, [{ url: "/api/remote/logout", method: "POST", body: undefined }]);
    assert.deepEqual(app.replaced, ["/sign-in.html"]);
  });

  test("turning remote access off posts an empty off and stays on the page, now closed", async () => {
    const app = await loadApp(200);

    const state = await app.deleteRemoteAccess("off");

    assert.deepEqual(app.sent, [{ url: "/api/remote/off", method: "POST", body: undefined }]);
    assert.equal(state, "closed");
    assert.deepEqual(app.replaced, []);
  });

  for (const act of ["logout", "off"] as const) {
    test(`a refused ${act} rejects and never leaves the page`, async () => {
      const app = await loadApp(403);

      await assert.rejects(app.deleteRemoteAccess(act));

      assert.deepEqual(app.replaced, [], act);
    });
  }
});

test("the banner names the device and offers sign out and turn off as buttons", async () => {
  const app = await loadApp(200);

  const tree = renderScreen((react.createElement as (t: unknown, p: unknown) => unknown)(app.RemoteBanner, {})) as RenderedNode;

  const buttons = findNodes(tree, (node) => node.type === "button").map((node) => collectText(node).trim());
  assert.deepEqual(buttons, ["Sign out", "Turn off remote access"]);
  assert.match(collectText(tree), /Remote device/);
});
