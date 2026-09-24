// Shared heading + landmark pins (plan 39859 S1): page h1 = nav label, card titles = h2, named shell regions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../public/src");
const APP_SRC = readFileSync(resolve(SRC, "app.jsx"), "utf8");

type Component = (props: Record<string, unknown>) => unknown;

function getNavEntries(): Array<{ id: string; label: string }> {
  return [...APP_SRC.matchAll(/\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)].map((m) => ({ id: m[1], label: m[2] }));
}

test("every screen's page h1 is its nav label", () => {
  const entries = getNavEntries();
  assert.ok(entries.length >= 9, `NAV parse found ${entries.length} entries`);
  for (const { id, label } of entries) {
    const path = resolve(SRC, "screens", `${id}.jsx`);
    assert.ok(existsSync(path), `screen file for nav id ${id}`);
    const title = readFileSync(path, "utf8").match(/<PageHeader\b[^>]*?\btitle="([^"]+)"/)?.[1];
    assert.equal(title, label, `${id}.jsx PageHeader title matches the nav label`);
  }
});

test("a card heading is a section h2, below the page h1 in the outline", async () => {
  const ui = await loadScreenModule(resolve(SRC, "ui.jsx"));
  const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };
  const card = renderScreen(React.createElement(ui.CardHead as Component, { title: "Spend by model", sub: "last 7 days" }));
  const h2 = findNodes(card, (n) => n.type === "h2");
  assert.equal(h2.length, 1);
  assert.equal(collectText(h2[0]), "Spend by model");
  assert.equal(findNodes(card, (n) => n.type === "h1").length, 0);
});

test("the shell's sidebar and primary navigation are named landmarks", () => {
  assert.match(APP_SRC, /<aside\b[^>]*\baria-label="[^"]+"/, "aside carries an accessible name");
  assert.match(APP_SRC, /<nav\b[^>]*\baria-label="[^"]+"/, "nav carries an accessible name");
  assert.match(APP_SRC, /<main\b/, "a single main landmark holds the screen");
});

test("type scale keeps h1 > section h2 > column header, with the KPI value largest", () => {
  const css = readFileSync(resolve(__dirname, "../public/styles/base.css"), "utf8");
  const ui = readFileSync(resolve(SRC, "ui.jsx"), "utf8");
  const px = (re: RegExp, text: string): number => Number(text.match(re)?.[1]);
  const h1 = px(/--fs-display:\s*(\d+)px/, ui);
  const h2 = px(/\.card-title\s*\{[^}]*?font-size:\s*var\(--fs-title,\s*(\d+)px\)/, css);
  const th = px(/\.tbl th\s*\{[^}]*?font-size:\s*(\d+)px/, css);
  const kpi = px(/\.kpi-value\s*\{[^}]*?font-size:\s*(\d+)px/, css);
  assert.ok(kpi > h1 && h1 > h2 && h2 > th, `kpi ${kpi} > h1 ${h1} > h2 ${h2} > th ${th}`);
});
