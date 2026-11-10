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
};

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
