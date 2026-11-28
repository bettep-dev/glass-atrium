// A screen that throws while rendering takes down only the screen area of public/src/app.jsx: the navigation stays,
// the area says so in fixed words, and nothing of the error reaches the page. Real React + react-dom on a jsdom
// document, so the catch is React's own, not a stub's.
//
// Runner: npx tsx --test test/app.screen-boundary.client.test.ts

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import React from "react";
import { loadScreenModule } from "./lib/render-screen.js";

// jsdom ships no types → the one constructor used here, typed by hand
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as { JSDOM: new (html: string) => { window: Window & typeof globalThis } };

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_SRC = resolve(__dirname, "../public/src/app.jsx");
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
// what a failing screen's error could carry: a path, a token-shaped value — none of it may be drawn
const ERROR_TEXT = "Cannot read properties of undefined (reading 'rows') at /Users/owner/.glass-atrium/data token=abc123";

// react-dom reads the global window (event priority) → the jsdom window stands in for this file's run
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
const host = globalThis as Record<string, unknown>;
host.window = dom.window;
host.document = dom.window.document;
host.IS_REACT_ACT_ENVIRONMENT = true;
const ReactDOM = require("react-dom/client") as unknown;
after(() => {
  delete host.window;
  delete host.document;
  delete host.IS_REACT_ACT_ENVIRONMENT;
});

async function mountShell(screens: Record<string, () => unknown>) {
  const document = dom.window.document;
  document.body.innerHTML = '<div id="root"></div>';
  const listeners: Record<string, () => void> = {};
  const location = { hash: "#dashboard", reload: test.mock.fn() };
  const ui = (await loadScreenModule(UI_SRC, { React, document, setInterval: () => 0, clearInterval: () => undefined })).UI as Record<string, unknown>;
  await React.act(async () => {
    await loadScreenModule(APP_SRC, {
      React,
      ReactDOM,
      document,
      fetch: () => new Promise(() => undefined),
      setInterval: () => 0,
      clearInterval: () => undefined,
      location,
      history: { replaceState: () => undefined },
      addEventListener: (type: string, listener: () => void) => {
        listeners[type] = listener;
      },
      removeEventListener: () => undefined,
      useTweaks: () => [{ density: "comfortable", accent: "#3b82f6" }, () => undefined],
      HealthModel: { foldHarness: () => ({ status: "loading" }) },
      UI: ui,
      ...screens,
    });
  });
  const navigateByHash = async (hash: string) => {
    location.hash = hash;
    await React.act(async () => listeners.hashchange());
  };
  const getMain = () => document.getElementById("main-content");
  return { document, location, navigateByHash, getMain };
}

const throwingScreen = () => {
  throw new Error(ERROR_TEXT);
};
const costScreen = () => React.createElement("h1", null, "Cost & usage");

describe("a screen that throws while rendering", () => {
  test("leaves the navigation and shows the fixed words in the screen area, never the error", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const { document, getMain } = await mountShell({ ScreenDashboard: throwingScreen, ScreenCost: costScreen });

    const navLabels = Array.from(document.querySelectorAll('nav[aria-label="Primary"] button'), (button) => button.getAttribute("title"));
    const main = getMain();
    assert.ok(navLabels.includes("Dashboard") && navLabels.includes("Cost & usage"), `the nav stays: ${navLabels.join(", ")}`);
    assert.match(main?.textContent ?? "", /This screen could not be shown\./);
    assert.deepEqual(Array.from(main?.querySelectorAll("button") ?? [], (button) => button.textContent), ["Reload"]);
    assert.equal(document.body.textContent?.includes("reading 'rows'"), false, "no part of the error text is drawn");
  });

  test("the next route renders its own screen again", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const { navigateByHash, getMain } = await mountShell({ ScreenDashboard: throwingScreen, ScreenCost: costScreen });

    await navigateByHash("#cost");

    assert.equal(getMain()?.querySelector("h1")?.textContent, "Cost & usage");
    assert.doesNotMatch(getMain()?.textContent ?? "", /could not be shown/);
  });

  test("Reload reloads the page", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const { location, getMain } = await mountShell({ ScreenDashboard: throwingScreen });
    const reload = getMain()?.querySelector("button");

    await React.act(async () => reload?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));

    assert.equal(location.reload.mock.callCount(), 1);
  });
});
