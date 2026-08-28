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
  ELK_PREP_PATH,
  MERMAID_CONFIG_PATH,
  loadExportAsset,
} from "../src/server/clauded-docs/html-export.js";
import {
  MERMAID_CONFIG_SOURCE,
  evaluateMermaidConfig,
} from "./lib/mermaid-config-source.js";

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

const viewerScripts = getViewerScriptPaths();

test("P1-2 the export reads the config file index.html loads", () => {
  assert.ok(
    viewerScripts.includes(MERMAID_CONFIG_PATH),
    `index.html loads ${viewerScripts.join(", ")} — none of them is the export's ${MERMAID_CONFIG_PATH}`,
  );
});

test("P1-2 the export reads the ELK prep module index.html loads", () => {
  assert.ok(
    viewerScripts.includes(ELK_PREP_PATH),
    `index.html loads ${viewerScripts.join(", ")} — none of them is the export's ${ELK_PREP_PATH}`,
  );
});

// index.html no longer carries a tag for the vendored bundle itself: the prep module above
// fetches it on demand, from a path written inside that module. So the two surfaces agree on
// the ENGINE only if the path the viewer's module fetches is the file the export injects —
// a claim the script-tag list can no longer answer, and the one thing it used to answer here.
test("P1-2 the export injects the same vendored bundle the prep module fetches", () => {
  // Whole-line comments dropped first: the module's own header quotes the tag it replaced.
  const code = readFileSync(ELK_PREP_PATH, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
  const named = [...code.matchAll(/"(assets\/vendor\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(
    named.length,
    1,
    `the prep module names ${named.length} vendor paths (${named.join(", ")}) — exactly one carries the fetch`,
  );
  assert.equal(
    resolve(PUBLIC_ROOT, named[0]),
    ELK_LOADER_PATH,
    "the viewer fetches a different vendored bundle than the export injects — same config, two engines",
  );
});

test("P1-2 the export injects the config file itself, with nothing appended", async () => {
  assert.equal(
    await loadExportAsset(MERMAID_CONFIG_PATH, "mermaid config"),
    MERMAID_CONFIG_SOURCE,
    "the injected text differs from the file on disk — the export carries an override",
  );
});

test("P1-2 the config the export injects deep-equals the one the viewer initializes from", async () => {
  const referenced = viewerScripts.find((path) => path.endsWith("mermaid-config.js"));
  assert.ok(referenced, "index.html must load a mermaid-config.js");
  assert.deepStrictEqual(
    evaluateMermaidConfig(await loadExportAsset(MERMAID_CONFIG_PATH, "mermaid config")),
    evaluateMermaidConfig(readFileSync(referenced, "utf8")),
  );
});

test("P1-2 the injected config carries the two keys the export's own guards stand on", async () => {
  const config = evaluateMermaidConfig(await loadExportAsset(MERMAID_CONFIG_PATH, "mermaid config"));
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

// ── P1a mermaid build parity ─────────────────────────────────────────────────
// The config above is one file both surfaces read, but the ENGINE that reads it is not:
// the viewer pulls mermaid from a CDN tag while the export injects the installed
// dependency's own bundle. A floating tag (`mermaid@11`) makes the viewer's engine
// whatever the CDN published last, so the two surfaces lay the same source out
// differently for a reason no file states. The version is therefore asserted across all
// three declarations — the CDN tag, the lockfile's resolved version, and the package on
// disk the export actually injects — so drift in any of them goes red.

const LOCK_PATH = resolve(MONITOR_ROOT, "package-lock.json");

// Matches the version segment of a CDN package path (`…/npm/mermaid@11.15.0/dist/…`).
// Anchored on the slashes so a neighbouring `@mermaid-js/*` tag cannot answer for it.
const MERMAID_CDN_TAG = /\/mermaid@([^/]+)\//;

/** Remote (cross-origin) scripts index.html loads — the same-origin ones are asserted above. */
function getViewerRemoteScriptSrcs(): string[] {
  return parseHtml(readFileSync(INDEX_PATH, "utf8"))
    .querySelectorAll("script")
    .map((node) => node.getAttribute("src") ?? "")
    .filter((src) => src.startsWith("http"));
}

/**
 * The version of the mermaid package on disk. html-export.ts resolves the SAME
 * package.json and injects `dist/mermaid.min.js` from beside it, so this is the export's
 * runtime version, not a restatement of the manifest.
 */
function getInstalledMermaidVersion(): string {
  const pkgPath = fileURLToPath(import.meta.resolve("mermaid/package.json"));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  assert.ok(pkg.version, `no version field in the installed mermaid package at ${pkgPath}`);
  return pkg.version;
}

/** The lockfile's RESOLVED version — not the manifest range, which a range could satisfy loosely. */
function getLockedMermaidVersion(): string {
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as {
    packages?: Record<string, { version?: string } | undefined>;
  };
  const version = lock.packages?.["node_modules/mermaid"]?.version;
  assert.ok(version, "package-lock.json resolves no node_modules/mermaid entry");
  return version;
}

const remoteMermaidSrcs = getViewerRemoteScriptSrcs().filter((src) => MERMAID_CDN_TAG.test(src));

test("P1a index.html loads exactly one remote mermaid runtime", () => {
  assert.equal(
    remoteMermaidSrcs.length,
    1,
    `index.html loads ${remoteMermaidSrcs.length} remote mermaid runtimes (${remoteMermaidSrcs.join(", ")}) — ` +
      "with more than one, the version below is asserted against a tag that may not be the one that wins",
  );
});

test("P1a the viewer's mermaid tag names the exact version the export injects", () => {
  const tagged = MERMAID_CDN_TAG.exec(remoteMermaidSrcs[0] ?? "")?.[1];
  const installed = getInstalledMermaidVersion();
  assert.ok(tagged, `no mermaid@<version> segment in ${remoteMermaidSrcs[0] ?? "(no remote mermaid script)"}`);
  assert.equal(
    tagged,
    installed,
    `index.html loads mermaid@${tagged} while the export injects ${installed} from node_modules — ` +
      "a floating or stale tag hands the viewer's layout to whatever the CDN published last",
  );
});

test("P1a the installed mermaid driver is the version the lockfile resolves", () => {
  assert.equal(
    getInstalledMermaidVersion(),
    getLockedMermaidVersion(),
    "the mermaid package on disk is not the one package-lock.json resolves — the pin above " +
      "is asserted against a tree the next npm ci would not reproduce",
  );
});
