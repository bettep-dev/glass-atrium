// P1-2 — the HTML export initializes from the SAME mermaid config file the viewer loads.
// Runner: npx tsx --test test/mermaid-config.parity.test.ts
//
// Equal values today say nothing about the next edit, so parity is asserted on the PATH
// each surface reads and on the TEXT the export injects — not on a value comparison that
// two hand-maintained copies could also satisfy for a while.
//
// Browserless: index.html is parsed as markup and the config is a classic script assigning
// one global, so a bare `window` stub evaluates it — no chromium, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parse as parseHtml } from "node-html-parser";

import {
  ELK_LOADER_PATH,
  MERMAID_CONFIG_PATH,
  loadExportAsset,
} from "../src/server/clauded-docs/html-export.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_ROOT = resolve(HERE, "..");
const PUBLIC_ROOT = resolve(MONITOR_ROOT, "public");
const INDEX_PATH = resolve(PUBLIC_ROOT, "index.html");
const EXPORT_MODULE_PATH = resolve(MONITOR_ROOT, "src/server/clauded-docs/html-export.ts");

// Above warn, mermaid rebinds log.warn to a no-op — the export's fallback watch would be blind.
const WARN_LOG_LEVEL = 3;

/** Absolute paths of the same-origin classic scripts index.html loads. */
function getViewerScriptPaths(): string[] {
  return parseHtml(readFileSync(INDEX_PATH, "utf8"))
    .querySelectorAll("script")
    .map((node) => node.getAttribute("src") ?? "")
    .filter((src) => src !== "" && !src.startsWith("http"))
    .map((src) => resolve(PUBLIC_ROOT, src));
}

/** Evaluates a config script the way a page would — reading a copy of it would defeat the point. */
function getConfig(source: string): Record<string, unknown> {
  const windowStub: Record<string, unknown> = {};
  new Function("window", source)(windowStub);
  const config = windowStub.MERMAID_CONFIG;
  assert.ok(config, "the config script must assign window.MERMAID_CONFIG");
  return config as Record<string, unknown>;
}

const viewerScripts = getViewerScriptPaths();

test("P1-2 the export reads the config file index.html loads", () => {
  assert.ok(
    viewerScripts.includes(MERMAID_CONFIG_PATH),
    `index.html loads ${viewerScripts.join(", ")} — none of them is the export's ${MERMAID_CONFIG_PATH}`,
  );
});

test("P1-2 the export reads the ELK loader index.html registers", () => {
  assert.ok(
    viewerScripts.includes(ELK_LOADER_PATH),
    `index.html loads ${viewerScripts.join(", ")} — none of them is the export's ${ELK_LOADER_PATH}`,
  );
});

test("P1-2 the export injects the config file itself, with nothing appended", async () => {
  assert.equal(
    await loadExportAsset(MERMAID_CONFIG_PATH, "mermaid config"),
    readFileSync(MERMAID_CONFIG_PATH, "utf8"),
    "the injected text differs from the file on disk — the export carries an override",
  );
});

test("P1-2 the config the export injects deep-equals the one the viewer initializes from", async () => {
  const referenced = viewerScripts.find((path) => path.endsWith("mermaid-config.js"));
  assert.ok(referenced, "index.html must load a mermaid-config.js");
  assert.deepStrictEqual(
    getConfig(await loadExportAsset(MERMAID_CONFIG_PATH, "mermaid config")),
    getConfig(readFileSync(referenced, "utf8")),
  );
});

test("P1-2 the injected config carries the two keys the export's own guards stand on", async () => {
  const config = getConfig(await loadExportAsset(MERMAID_CONFIG_PATH, "mermaid config"));
  assert.equal(config.layout, "elk", "the export's fallback watch guards a layout the config never requests");
  assert.ok(
    Number(config.logLevel) <= WARN_LOG_LEVEL,
    `logLevel is ${String(config.logLevel)} — above ${WARN_LOG_LEVEL} the fallback warning is never logged at all`,
  );
});

test("P1-2 html-export.ts declares no config object of its own", () => {
  const source = readFileSync(EXPORT_MODULE_PATH, "utf8");
  assert.equal(
    /themeVariables\s*:/.test(source),
    false,
    "html-export.ts declares its own theme palette — a second copy of one contract, and only one copy ever gets edited",
  );
});
