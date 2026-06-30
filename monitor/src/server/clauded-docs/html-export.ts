// Produces a SINGLE self-contained .html (all styling + Mermaid diagrams render
// offline, zero network on open). INVARIANT: the serialized output carries live
// <svg> and MUST NEVER be re-run through sanitizeHtmlBody (FORBID_TAGS includes
// "svg" → re-sanitizing destroys the diagrams).

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

import type { BrowserContext, Page } from "playwright";
import { parse as parseHtml } from "node-html-parser";

import { acquireBrowser, BrowserPoolError } from "./browser-pool.js";
import { normalizeMermaidSource } from "./mermaid-normalize.js";

// Pinned mermaid version for the injected export driver → matches package.json + live viewer (index.html:54).
const MERMAID_VERSION = "11";

// Page navigation timeout (ms) — networkidle covers Tailwind Play CDN fetch+exec, cold-cache tolerant.
const PAGE_NAVIGATION_TIMEOUT_MS = 10_000;

// Mermaid render ceiling (ms) — polls DOM for <svg>; a hung driver surfaces as typed error, not silent timeout.
const MERMAID_RENDER_TIMEOUT_MS = 15_000;

// Tailwind Play CDN stylesheet-injection ceiling (ms) — polls for window.tailwind
// + an applied utility; a blocked CDN surfaces as a typed "tailwind" error, not a
// silently unstyled file. Separate from the navigation timeout (predicate wait).
const TAILWIND_INJECT_TIMEOUT_MS = 10_000;

// Tailwind Play CDN host — the strip/guard target. A stored body referencing this
// host expects the runtime to inject its generated utility <style> on setContent.
const TAILWIND_CDN_HOST = "cdn.tailwindcss.com";

// Offline-portability marker comments inserted during the strip pass.
const OFFLINE_FONTS_COMMENT =
  " fonts: web fonts stripped for offline portability; system/local font-family fallback applied ";
const MERMAID_VERSION_COMMENT = ` mermaid driver: pinned mermaid@${MERMAID_VERSION} (locally bundled, no network) `;

/**
 * Thrown on HTML export failure. Route handler maps to a 503 envelope (reason
 * `html_export_<stage>: <msg>`). stage "mermaid" = a known-mermaid doc finished
 * with zero <svg> — NEVER ship raw <pre>. stage "tailwind" = a doc that loaded
 * the Tailwind Play CDN finished WITHOUT the runtime stylesheet — NEVER ship an
 * unstyled file.
 */
export class HtmlExportError extends Error {
  readonly stage: "launch" | "render" | "mermaid" | "tailwind" | "serialize";
  constructor(
    message: string,
    stage: "launch" | "render" | "mermaid" | "tailwind" | "serialize",
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "HtmlExportError";
    this.stage = stage;
  }
}

/**
 * Extracts HTML-entity-decoded mermaid sources from the raw stored body, in DOM
 * order (index → source mapping consumed by driveMermaidRender).
 *
 * Extracts from the RAW STRING, not live DOM: OWN-BUNDLE docs ship a jsdelivr
 * mermaid bundle (sanitize.ts allowlists it) whose startOnLoad=true auto-renders
 * <pre class="mermaid"> to <svg> before our driver runs → live textContent then
 * yields SVG label text, not diagram source ("No diagram type detected").
 * node-html-parser's .text decodes entities (&gt;&gt; → >>) and preserves
 * pre/code whitespace (blockTextElements).
 */
function extractMermaidSources(storedBody: string): string[] {
  const root = parseHtml(storedBody, {
    comment: false,
    blockTextElements: { pre: true, code: true, script: true, style: true },
  });
  // .text on a <pre> with blockTextElements:true → decoded, whitespace-preserved.
  return root
    .querySelectorAll("pre.mermaid, .mermaid")
    .map((node) => node.text);
}

/**
 * Strips integrity + crossorigin from the Tailwind Play CDN <script> in the raw
 * stored body, returning the re-serialized string for setContent.
 *
 * A setContent document has an opaque origin ("null"); crossorigin="anonymous"
 * forces a CORS-mode subresource fetch the Play CDN rejects (no
 * Access-Control-Allow-Origin) → chromium blocks the script → window.tailwind
 * stays undefined → ZERO utility CSS. Removing both attributes downgrades it to a
 * no-CORS classic script that executes and injects its stylesheet. Narrowly
 * scoped to the tailwind CDN <script> (minimal blast radius); leaves the output's
 * zero-network-on-OPEN invariant intact (stripCdnScriptsAndFonts later removes the
 * executed script and keeps the baked <style>).
 */
function stripTailwindCorsAttributes(storedBody: string): string {
  if (!storedBody.includes(TAILWIND_CDN_HOST)) return storedBody;

  const root = parseHtml(storedBody, {
    comment: true,
    blockTextElements: { script: true, style: true, pre: true, code: true },
  });

  let stripped = false;
  for (const script of root.querySelectorAll("script")) {
    const src = script.getAttribute("src") ?? "";
    if (src.includes(TAILWIND_CDN_HOST)) {
      script.removeAttribute("integrity");
      script.removeAttribute("crossorigin");
      stripped = true;
    }
  }
  if (!stripped) return storedBody;

  // Same defensive DOCTYPE prepend as stripCdnScriptsAndFonts — toString() may
  // drop the DOCTYPE; guard double-prepend for a future preserving version.
  const serialized = root.toString();
  if (/^<!doctype\s/i.test(serialized)) {
    return serialized;
  }
  return `<!DOCTYPE html>\n${serialized}`;
}

// UMD bundle text, read once at first export. Resolved via import.meta.resolve so
// the path is identical under tsx (src/) and node (dist/) — no build-asset copy.
let mermaidBundleCache: string | null = null;

async function loadMermaidBundle(): Promise<string> {
  if (mermaidBundleCache !== null) return mermaidBundleCache;
  const pkgPath = fileURLToPath(import.meta.resolve("mermaid/package.json"));
  const bundlePath = resolve(dirname(pkgPath), "dist", "mermaid.min.js");
  mermaidBundleCache = await readFile(bundlePath, "utf8");
  return mermaidBundleCache;
}

// Verbatim copy of the live viewer's dark themeVariables (public/index.html) —
// the palette is load-bearing for dark-on-dark legibility; DO NOT re-derive.
// securityLevel:'loose' matches the viewer (stored body is already DOMPurify-sanitized).
const MERMAID_INIT_CONFIG = {
  startOnLoad: false,
  theme: "dark",
  themeVariables: {
    darkMode: true,
    background: "#0a0a0a",
    primaryColor: "#1e3a8a",
    primaryTextColor: "#e5e7eb",
    lineColor: "#94a3b8",
    fontSize: "14px",
    fontFamily: "Pretendard, system-ui, -apple-system, sans-serif",

    textColor: "#e5e7eb",
    nodeTextColor: "#e5e7eb",
    labelTextColor: "#e5e7eb",
    titleColor: "#f1f5f9",
    noteTextColor: "#0a0a0a",
    noteBkgColor: "#fde68a",

    mainBkg: "#1e293b",
    secondaryColor: "#334155",
    tertiaryColor: "#475569",
    secondaryTextColor: "#e5e7eb",
    tertiaryTextColor: "#e5e7eb",

    pieTitleTextColor: "#f1f5f9",
    pieSectionTextColor: "#e5e7eb",
    pieLegendTextColor: "#e5e7eb",
    pieStrokeColor: "#0a0a0a",
    pieOuterStrokeColor: "#94a3b8",

    actorTextColor: "#e5e7eb",
    taskTextColor: "#e5e7eb",
    labelBoxBkgColor: "#1e293b",
    fillType0: "#e5e7eb", fillType1: "#e5e7eb", fillType2: "#e5e7eb", fillType3: "#e5e7eb",
    fillType4: "#e5e7eb", fillType5: "#e5e7eb", fillType6: "#e5e7eb", fillType7: "#e5e7eb",

    labelColor: "#e5e7eb",
    stateLabelColor: "#e5e7eb",
    compositeTitleBackground: "#1e293b",

    cScaleLabel0: "#e5e7eb", cScaleLabel1: "#e5e7eb", cScaleLabel2: "#e5e7eb",
    cScaleLabel3: "#e5e7eb", cScaleLabel4: "#e5e7eb", cScaleLabel5: "#e5e7eb",
    cScaleLabel6: "#e5e7eb", cScaleLabel7: "#e5e7eb", cScaleLabel8: "#e5e7eb",
    cScaleLabel9: "#e5e7eb", cScaleLabel10: "#e5e7eb", cScaleLabel11: "#e5e7eb",
  },
  flowchart: {
    htmlLabels: true,
    curve: "basis",
    padding: 12,
    nodeSpacing: 50,
    rankSpacing: 60,
    useMaxWidth: true,
  },
  securityLevel: "loose",
} as const;

/** Non-html stored body formats the shell-wrap path handles. */
export type PlainFormatToken = "md" | "yaml" | "json" | "txt";

/** All formats renderSelfContainedHtml accepts. */
export type ExportFormatToken = "html" | PlainFormatToken;

/**
 * Produces a self-contained offline HTML string from a stored doc body — "html"
 * renders through chromium (inline <svg>), other formats wrap in a dark shell.
 *
 * Throws HtmlExportError on launch/render/mermaid/serialize failure; a
 * known-mermaid doc finishing with zero <svg> throws stage "mermaid" (NEVER
 * returns raw <pre>). INVARIANT: the return is never re-sanitized (carries live
 * <svg> that sanitize.ts would strip).
 *
 * @param storedBody - the already-sanitized stored doc body
 * @param format - the doc's stored format (derived from its file extension)
 */
export async function renderSelfContainedHtml(
  storedBody: string,
  format: ExportFormatToken,
): Promise<string> {
  if (format !== "html") {
    return wrapPlainInHtmlShell(storedBody, format);
  }
  return renderHtmlThroughBrowser(storedBody);
}

async function renderHtmlThroughBrowser(storedBody: string): Promise<string> {
  let browser;
  try {
    browser = await acquireBrowser();
  } catch (error) {
    throw new HtmlExportError(
      error instanceof Error ? error.message : "chromium launch failed",
      "launch",
      error,
    );
  }

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    context = await browser.newContext();
    page = await context.newPage();
    page.setDefaultNavigationTimeout(PAGE_NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(PAGE_NAVIGATION_TIMEOUT_MS);

    // setContent input ONLY — the integrity/crossorigin strip unblocks the
    // Tailwind Play CDN under the opaque setContent origin. Mermaid extraction
    // below still reads the ORIGINAL storedBody (pristine source — see
    // extractMermaidSources / OWN-BUNDLE rationale).
    const setContentBody = stripTailwindCorsAttributes(storedBody);
    const usesTailwindCdn = storedBody.includes(TAILWIND_CDN_HOST);

    let serialized: string;
    try {
      // networkidle lets the Tailwind Play CDN inject its runtime <style> node.
      await page.setContent(setContentBody, { waitUntil: "networkidle" });
      await page.emulateMedia({ media: "screen" });
    } catch (error) {
      throw new HtmlExportError(
        error instanceof Error ? error.message : "page setContent failed",
        "render",
        error,
      );
    }

    // Loud-fail if the Play CDN never injected its stylesheet — gated on the body
    // actually referencing the CDN so non-Tailwind docs (and the plain-shell path)
    // never trip a false-positive timeout.
    if (usesTailwindCdn) {
      await waitForTailwindStylesheet(page);
    }

    // Extract from the RAW body BEFORE setContent — see extractMermaidSources.
    // Normalize each source so detectType sees the diagram-type line first (acc
    // directives placed above it would otherwise fail "No diagram type detected"
    // → loud-fail 503). Fixes the SOURCE upstream; the zero-svg guard below is
    // left untouched. See mermaid-normalize.ts.
    const mermaidSources =
      extractMermaidSources(storedBody).map(normalizeMermaidSource);

    if (mermaidSources.length > 0) {
      await driveMermaidRender(page, mermaidSources);
    }

    try {
      serialized = await page.content();
    } catch (error) {
      throw new HtmlExportError(
        error instanceof Error ? error.message : "page.content serialize failed",
        "serialize",
        error,
      );
    }

    return stripCdnScriptsAndFonts(serialized);
  } catch (error) {
    if (error instanceof HtmlExportError) throw error;
    // Defensive — any unwrapped failure becomes a render-stage typed error.
    throw new HtmlExportError(
      error instanceof Error ? error.message : "html export render failed",
      "render",
      error,
    );
  } finally {
    if (page !== null) {
      await page.close().catch(() => undefined);
    }
    if (context !== null) {
      await context.close().catch(() => undefined);
    }
  }
}

/**
 * Injects the pinned mermaid driver, runs the viewer's dark initialize, then the
 * per-node render loop keyed on PRE-EXTRACTED sources (rationale:
 * extractMermaidSources). sources[i] ↔ the i-th `pre.mermaid, .mermaid` node
 * (same selector both sides). Waits until every node holds an <svg>; zero <svg>
 * for a doc that HAD mermaid nodes → HtmlExportError stage "mermaid".
 */
async function driveMermaidRender(page: Page, sources: string[]): Promise<void> {
  const bundle = await loadMermaidBundle();
  try {
    await page.addScriptTag({ content: bundle });
  } catch (error) {
    throw new HtmlExportError(
      error instanceof Error ? error.message : "mermaid driver injection failed",
      "mermaid",
      error,
    );
  }

  let renderError: string | null;
  try {
    // Callback runs in chromium (DOM context); tsconfig lib is ES2022 (no DOM),
    // so browser globals go through a locally-typed globalThis cast.
    renderError = await page.evaluate(async (args) => {
      type MermaidGlobal = {
        mermaid?: {
          initialize: (c: unknown) => void;
          render: (id: string, src: string) => Promise<{ svg: string }>;
        };
        document: {
          querySelectorAll: (sel: string) => ArrayLike<{ innerHTML: string }>;
        };
      };
      const g = globalThis as unknown as MermaidGlobal;
      const mermaid = g.mermaid;
      if (mermaid === undefined) return "window.mermaid undefined after driver injection";
      try {
        mermaid.initialize(args.config);
        const nodes = Array.from(g.document.querySelectorAll("pre.mermaid, .mermaid"));
        // node/source count divergence (rare parser difference) → render by index, no abort.
        for (let i = 0; i < nodes.length; i += 1) {
          const node = nodes[i];
          const src = args.sources[i] ?? "";
          const { svg } = await mermaid.render(`mmd-export-${i}`, src);
          // SECURITY: svg is mermaid's OWN output under securityLevel:'loose' (same
          // trust boundary as the live viewer), not external input → not an XSS sink.
          node.innerHTML = svg;
        }
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "mermaid render threw";
      }
    }, { config: MERMAID_INIT_CONFIG, sources });
  } catch (error) {
    throw new HtmlExportError(
      error instanceof Error ? error.message : "mermaid render evaluate failed",
      "mermaid",
      error,
    );
  }

  if (renderError !== null) {
    throw new HtmlExportError(`mermaid render error: ${renderError}`, "mermaid");
  }

  // Explicit predicate wait — every mermaid node must hold an <svg> child.
  // Not a blind timer: a hung/failed driver surfaces as a "mermaid" stage error.
  try {
    await page.waitForFunction(
      (count) => {
        const g = globalThis as unknown as {
          document: { querySelectorAll: (sel: string) => ArrayLike<unknown> };
        };
        return g.document.querySelectorAll("pre.mermaid svg, .mermaid svg").length >= count;
      },
      sources.length,
      { timeout: MERMAID_RENDER_TIMEOUT_MS },
    );
  } catch (error) {
    throw new HtmlExportError(
      "mermaid render finished with fewer <svg> than mermaid nodes (zero-svg guard)",
      "mermaid",
      error,
    );
  }
}

/**
 * Loud-fail guard: waits until the Tailwind Play CDN runtime has both loaded AND
 * injected its generated stylesheet, else throws HtmlExportError stage "tailwind".
 *
 * Sound, non-gameable predicate (NOT a raw <style> length compare): requires BOTH
 * window.tailwind !== undefined AND a <style> carrying the runtime's `--tw-`
 * custom-property signature (the preflight sheet the Play CDN ALWAYS injects on
 * its initial DOM scan — present even when the author used zero utility classes).
 * The author's own small inline <style> cannot contain `--tw-` vars, so the
 * signature uniquely proves the runtime actually generated and injected CSS —
 * exactly the step the CORS block (the bug) prevented. A pre-existing classed
 * element's computed utility value (p-2 → 8px · max-w-5xl → 1024px · bg-zinc-950
 * → rgb(9,9,11)) is the stronger confirmation when present, but the `--tw-`
 * signature is the universal floor that also covers utility-class-free docs.
 * Mirrors driveMermaidRender's explicit waitForFunction predicate-wait pattern.
 */
async function waitForTailwindStylesheet(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        // Callback runs in chromium (DOM context); tsconfig lib is ES2022 (no
        // DOM), so browser globals go through a locally-typed globalThis cast.
        const g = globalThis as unknown as {
          tailwind?: unknown;
          document: {
            querySelectorAll: (sel: string) => ArrayLike<{ textContent: string | null }>;
          };
        };
        if (g.tailwind === undefined) return false;
        const styles = g.document.querySelectorAll("style");
        for (let i = 0; i < styles.length; i += 1) {
          // `--tw-` custom props appear ONLY in the runtime's generated sheet,
          // never in an author's hand-written inline <style>.
          if ((styles[i].textContent ?? "").includes("--tw-")) return true;
        }
        return false;
      },
      undefined,
      { timeout: TAILWIND_INJECT_TIMEOUT_MS },
    );
  } catch (error) {
    throw new HtmlExportError(
      "Tailwind CDN referenced but its runtime stylesheet never applied (CORS-blocked or load failure)",
      "tailwind",
      error,
    );
  }
}

// CDN host substrings whose <link href> + <style>@import refs are stripped for
// zero network on open. Font-family fallback stack stays intact (only the remote
// @import is removed → system/local Pretendard resolves on the user's machine).
const WEBFONT_HOST_HINTS: readonly string[] = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
  "cdn.tailwindcss.com",
];

/**
 * Removes CDN <script src> / runtime inline scripts + webfont <link>/@import
 * refs from the serialized HTML, leaving the Tailwind-injected <style> and the
 * inline Mermaid <svg> intact. Uses node-html-parser (NOT regex). Inserts the
 * offline-fonts + pinned-mermaid-version marker comments.
 *
 * NEVER calls sanitizeHtmlBody — that would strip the <svg> (svg-strip invariant).
 */
export function stripCdnScriptsAndFonts(html: string): string {
  const root = parseHtml(html, {
    comment: true,
    // Keep <style>/<script> bodies intact so we decide per-node what to drop.
    blockTextElements: { script: true, style: true, pre: true, code: true },
  });

  // Drop ALL <script> — none are load-bearing post-capture (CDN scripts already
  // ran; inline runtime scripts would re-fetch/mutate on open). An offline file
  // needs zero scripts.
  for (const script of root.querySelectorAll("script")) {
    script.remove();
  }

  // Drop webfont <link rel=stylesheet> + preconnect refs to font CDNs.
  for (const link of root.querySelectorAll("link")) {
    const href = link.getAttribute("href") ?? "";
    if (WEBFONT_HOST_HINTS.some((h) => href.includes(h))) {
      link.remove();
    }
  }

  // Strip @import <cdn-host> lines inside <style> blocks. Scoped regex on the
  // isolated style.innerHTML (not the full document) — target is a line-level
  // @import, not nested HTML. Host set built from WEBFONT_HOST_HINTS (single SoT).
  const hostPattern = WEBFONT_HOST_HINTS.map((h) =>
    h.replace(/\./g, "\\."),
  ).join("|");
  // Covers all quote styles + optional url() wrapper + optional trailing semicolon.
  const cdnImportRe = new RegExp(
    `@import\\s+(?:url\\()?[\\s\\S]*?(?:${hostPattern})[^;]*;?`,
    "gi",
  );
  for (const style of root.querySelectorAll("style")) {
    const css = style.innerHTML;
    if (WEBFONT_HOST_HINTS.some((h) => css.includes(h))) {
      style.set_content(css.replace(cdnImportRe, ""));
    }
  }

  // Insert marker comments at the top of <head> (or root if no head).
  // SECURITY: both args are module-level static literals with ZERO document/body
  // interpolation — not an injection sink. insertAdjacentHTML keeps them as real
  // DOM comments (insertAdjacentText would HTML-escape the markers).
  const head = root.querySelector("head") ?? root;
  head.insertAdjacentHTML(
    "afterbegin",
    `<!--${OFFLINE_FONTS_COMMENT}--><!--${MERMAID_VERSION_COMMENT}-->`,
  );

  // node-html-parser toString() drops the DOCTYPE → prepend unconditionally,
  // guarding double-prepend in case a future version preserves it.
  const serialized = root.toString();
  if (/^<!doctype\s/i.test(serialized)) {
    return serialized;
  }
  return `<!DOCTYPE html>\n${serialized}`;
}

const HTML_ESCAPE_MAP: ReadonlyMap<string, string> = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
]);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP.get(ch) ?? ch);
}

// Minimal dark inline stylesheet — no CDN, no script. Offline by construction.
const SHELL_STYLE =
  "html{color-scheme:dark}" +
  "body{margin:0;background:#0a0a0a;color:#e5e7eb;" +
  "font-family:Pretendard,system-ui,-apple-system,sans-serif;" +
  "font-size:14px;line-height:1.6}" +
  "main,pre{padding:1.5rem;max-width:980px;margin:0 auto}" +
  "pre{white-space:pre-wrap;word-break:break-word;" +
  "background:#111827;border:1px solid #1f2937;border-radius:8px;" +
  "font-family:ui-monospace,SFMono-Regular,Menlo,monospace}" +
  "main{white-space:pre-wrap;word-break:break-word}";

/**
 * Wraps a raw non-HTML stored body in a minimal self-contained dark HTML shell.
 * Code formats (yaml/json/txt) go inside a <pre>; md goes inside a
 * newline-preserving <main>. No CDN, no script — offline by construction.
 */
export function wrapPlainInHtmlShell(body: string, format: PlainFormatToken): string {
  const escaped = escapeHtml(body);
  const inner =
    format === "md"
      ? `<main>${escaped}</main>`
      : `<pre>${escaped}</pre>`;
  return (
    "<!doctype html>" +
    '<html lang="ko">' +
    "<head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style>${SHELL_STYLE}</style>` +
    `<!--${OFFLINE_FONTS_COMMENT}-->` +
    "</head>" +
    `<body>${inner}</body>` +
    "</html>"
  );
}

export { BrowserPoolError };
export { MERMAID_VERSION };
