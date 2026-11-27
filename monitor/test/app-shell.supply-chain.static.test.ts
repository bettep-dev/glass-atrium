// App-shell supply chain — every script the shell runs is pinned by bytes, and the CSP allows exactly that set.
// Runner: npx tsx --test test/app-shell.supply-chain.static.test.ts
//
// Browserless and offline: markup + sidecar + bytes on disk. Whether the pinned bytes still load,
// and whether every screen runs under the policy, is app-shell.csp.e2e.test.ts.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseHtml, type HTMLElement } from "node-html-parser";

const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const VENDOR_ROOT = resolve(PUBLIC_ROOT, "assets", "vendor");
const PATH = {
  INDEX: resolve(PUBLIC_ROOT, "index.html"),
  TAILWIND_PROVENANCE: resolve(VENDOR_ROOT, "tailwindcss-play-cdn.provenance.json"),
  QR_PROVENANCE: resolve(VENDOR_ROOT, "qrcode-generator.provenance.json"),
  LOCKFILE: resolve(PUBLIC_ROOT, "..", "package-lock.json"),
  QR_INSTALLED: resolve(PUBLIC_ROOT, "..", "node_modules", "qrcode-generator", "dist", "qrcode.js"),
  FONT_CAPTURES: resolve(PUBLIC_ROOT, "..", "test", "fixtures", "font-stylesheets"),
};

interface FontStylesheetCapture {
  name: string;
  href: string;
  file: string;
}

// one recorded read of each external font stylesheet the shell links; Google Fonts answers per user agent → recorded as desktop Chrome (woff2)
const FONT_STYLESHEET_CAPTURES: FontStylesheetCapture[] = [
  { name: "Pretendard", href: "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css", file: "pretendard.min.css" },
  { name: "JetBrains Mono", href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap", file: "jetbrains-mono.css" },
];

// below this the "every external script" loop could pass on a page that lost its CDN tags
const EXTERNAL_SCRIPT_FLOOR = 10;

interface TailwindProvenance {
  version: string;
  source_url: string;
  bundle_file: string;
  bundle_sha256: string;
  bundle_bytes: number;
  license: string;
}

const html = readFileSync(PATH.INDEX, "utf8");
const root = parseHtml(html);
const scripts = root.querySelectorAll("script");
const externalScripts = scripts.filter((node) => /^https?:/.test(node.getAttribute("src") ?? ""));
const inlineScripts = scripts.filter((node) => !node.hasAttribute("src"));

function getCspMeta(): HTMLElement {
  const metas = root.querySelectorAll("meta").filter((node) => node.getAttribute("http-equiv")?.toLowerCase() === "content-security-policy");
  assert.equal(metas.length, 1, `index.html carries ${metas.length} CSP meta tags — expected exactly one`);
  return metas[0];
}

/** directive name → source tokens, from the meta's content attribute */
function getDirectives(): Map<string, string[]> {
  const content = getCspMeta().getAttribute("content") ?? "";
  const entries = content
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .filter((tokens) => tokens[0] !== "")
    .map(([name, ...sources]): [string, string[]] => [name.toLowerCase(), sources]);
  return new Map(entries);
}

function getStylesheetHrefs(): string[] {
  return root.querySelectorAll('link[rel="stylesheet"]').map((node) => node.getAttribute("href") ?? "");
}

/** Each @font-face url() of a captured stylesheet, resolved against the URL the shell links it from. */
function getFaceUrls(capture: FontStylesheetCapture): URL[] {
  const css = readFileSync(resolve(PATH.FONT_CAPTURES, capture.file), "utf8");
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  return blocks.flatMap((block) => [...block.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)].map((match) => new URL(match[2], capture.href)));
}

// CSP source path match: a path ending in "/" admits every path under it, any other path only itself
function isFontSourceMatch(source: string, face: URL): boolean {
  if (!/^https:\/\//.test(source)) return false;
  const allowed = new URL(source);
  if (allowed.origin !== face.origin) return false;
  return allowed.pathname.endsWith("/") ? face.pathname.startsWith(allowed.pathname) : face.pathname === allowed.pathname;
}

function getInlineHashSource(node: HTMLElement): string {
  return `'sha256-${createHash("sha256").update(node.rawText, "utf8").digest("base64")}'`;
}

describe("every external script is pinned by integrity", () => {
  test("the shell still loads its CDN scripts", () => {
    assert.ok(externalScripts.length >= EXTERNAL_SCRIPT_FLOOR, `only ${externalScripts.length} external scripts found`);
  });

  for (const node of externalScripts) {
    const src = node.getAttribute("src");
    test(`${src} carries a sha384 integrity and anonymous crossorigin`, () => {
      assert.match(node.getAttribute("integrity") ?? "", /^sha384-[A-Za-z0-9+/]{64}$/);
      assert.equal(node.getAttribute("crossorigin"), "anonymous");
    });
  }
});

describe("the shell CSP allows exactly the scripts the shell runs", () => {
  test("the policy precedes every script — a meta CSP governs only what follows it", () => {
    getCspMeta();
    assert.ok(html.indexOf('http-equiv="Content-Security-Policy"') < html.indexOf("<script"), "CSP meta sits after a <script>");
  });

  test("script-src is self, each external src by full URL, and each inline script by its current hash", () => {
    const expected = ["'self'", ...externalScripts.map((node) => node.getAttribute("src")), ...inlineScripts.map(getInlineHashSource)];
    assert.ok(inlineScripts.length > 0, "no inline script found — the hash arm would be vacuous");
    assert.deepEqual([...(getDirectives().get("script-src") ?? [])].sort(), [...expected].sort());
  });

  test("plugins are off and <base> cannot re-root the self-relative scripts", () => {
    const directives = getDirectives();
    assert.deepEqual(directives.get("object-src"), ["'none'"]);
    assert.deepEqual(directives.get("base-uri"), ["'self'"]);
  });

  test("an injected script cannot send queue text to another origin by fetch or form post", () => {
    const directives = getDirectives();
    assert.deepEqual(directives.get("connect-src"), ["'self'"]);
    assert.deepEqual(directives.get("form-action"), ["'self'"]);
  });
});

describe("the shell CSP refuses every fetch kind it does not name", () => {
  test("default-src is 'none' — a fetch kind with no directive of its own loads nothing", () => {
    assert.deepEqual(getDirectives().get("default-src"), ["'none'"]);
  });

  // the Tailwind runtime, mermaid's SVG and document bodies write <style> elements at run time → no hash can name them
  // a source names origin + path only → the Google Fonts query (it holds ";") stays out of the policy
  test("style-src is self, each external stylesheet by origin and path, and inline for the style elements written at run time", () => {
    const external = getStylesheetHrefs().filter((href) => /^https?:/.test(href)).map((href) => {
      const url = new URL(href);
      return `${url.origin}${url.pathname}`;
    });
    assert.ok(external.length > 0, "no external stylesheet found — the URL arm would be vacuous");
    const expected = ["'self'", "'unsafe-inline'", ...external];
    assert.deepEqual([...(getDirectives().get("style-src") ?? [])].sort(), [...expected].sort());
  });

  test("images come only from this origin and from the data: and blob: URLs the page builds itself", () => {
    assert.deepEqual([...(getDirectives().get("img-src") ?? [])].sort(), ["'self'", "blob:", "data:"]);
  });

  for (const capture of FONT_STYLESHEET_CAPTURES) {
    test(`every face the linked ${capture.name} stylesheet names loads under font-src`, () => {
      assert.ok(getStylesheetHrefs().includes(capture.href), `index.html no longer links ${capture.href} — re-record its capture`);
      const faces = getFaceUrls(capture);
      assert.ok(faces.length > 0, `the ${capture.name} capture names no @font-face url — the check would be vacuous`);
      const sources = getDirectives().get("font-src") ?? [];
      assert.deepEqual(faces.filter((face) => !sources.some((source) => isFontSourceMatch(source, face))).map(String), []);
    });
  }

  test("font-src names no source the captured font stylesheets load nothing from", () => {
    const faces = FONT_STYLESHEET_CAPTURES.flatMap(getFaceUrls);
    const sources = getDirectives().get("font-src") ?? [];
    assert.deepEqual(sources.filter((source) => !faces.some((face) => isFontSourceMatch(source, face))), []);
  });
});

describe("the Tailwind runtime is the vendored file its sidecar pins", () => {
  const provenance = JSON.parse(readFileSync(PATH.TAILWIND_PROVENANCE, "utf8")) as TailwindProvenance;

  test("the bytes on disk are the bytes the sidecar pins", () => {
    const bytes = readFileSync(resolve(VENDOR_ROOT, provenance.bundle_file));
    assert.equal(bytes.length, provenance.bundle_bytes, "byte count vs sidecar");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.bundle_sha256, "sha256 vs sidecar");
  });

  test("the shell loads that file and no Tailwind runtime from the network", () => {
    const srcs = scripts.map((node) => node.getAttribute("src") ?? "");
    assert.ok(srcs.includes(`assets/vendor/${provenance.bundle_file}`), `index.html does not load assets/vendor/${provenance.bundle_file}`);
    assert.deepEqual(srcs.filter((src) => src.includes("tailwindcss.com")), []);
  });

  test("the sidecar's file name, source URL and notice agree on one version", () => {
    assert.ok(provenance.bundle_file.includes(provenance.version), "bundle_file names another version");
    assert.ok(provenance.source_url.endsWith(`/${provenance.version}`), "source_url names another version");
    const notice = readFileSync(resolve(VENDOR_ROOT, "THIRD-PARTY-NOTICES.md"), "utf8")
      .split("\n")
      .find((line) => line.includes("`tailwindcss`") && line.includes("|"));
    assert.ok(notice?.includes(provenance.version) && notice.includes(provenance.license), "THIRD-PARTY-NOTICES.md has no matching tailwindcss row");
  });
});

describe("the QR encoder is the unmodified package file its sidecar pins", () => {
  const provenance = JSON.parse(readFileSync(PATH.QR_PROVENANCE, "utf8")) as TailwindProvenance & { tarball_integrity: string };
  const bytes = readFileSync(resolve(VENDOR_ROOT, provenance.bundle_file));

  test("the bytes on disk are the bytes the sidecar pins", () => {
    assert.equal(bytes.length, provenance.bundle_bytes, "byte count vs sidecar");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.bundle_sha256, "sha256 vs sidecar");
  });

  test("the copy is the file npm installed from the tarball the lockfile resolved", () => {
    const lock = JSON.parse(readFileSync(PATH.LOCKFILE, "utf8")) as { packages: Record<string, { version: string; integrity: string }> };
    const entry = lock.packages["node_modules/qrcode-generator"];
    assert.equal(entry?.version, provenance.version, "lockfile version vs sidecar");
    assert.equal(entry?.integrity, provenance.tarball_integrity, "lockfile integrity vs sidecar");
    assert.ok(bytes.equals(readFileSync(PATH.QR_INSTALLED)), "vendored copy differs from node_modules/qrcode-generator/dist/qrcode.js");
  });

  test("the shell loads that file before the screens, from its own origin", () => {
    const srcs = scripts.map((node) => node.getAttribute("src") ?? "");
    const at = srcs.indexOf(`assets/vendor/${provenance.bundle_file}`);
    assert.ok(at !== -1, `index.html does not load assets/vendor/${provenance.bundle_file}`);
    assert.ok(at < srcs.indexOf("dist/screens/remote-access.js"), "the encoder loads after the screen that draws with it");
  });

  test("the notice names the same version and license", () => {
    const notice = readFileSync(resolve(VENDOR_ROOT, "THIRD-PARTY-NOTICES.md"), "utf8")
      .split("\n")
      .find((line) => line.includes("`qrcode-generator`") && line.includes("|"));
    assert.ok(notice?.includes(provenance.version) && notice.includes(provenance.license), "THIRD-PARTY-NOTICES.md has no matching qrcode-generator row");
  });
});
