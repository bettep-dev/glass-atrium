// Produces a SINGLE self-contained .html (all styling + Mermaid diagrams render
// offline, zero network on open). INVARIANT: the serialized output carries live
// <svg> and MUST NEVER be re-run through sanitizeHtmlBody (FORBID_TAGS includes
// "svg" → re-sanitizing destroys the diagrams).

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import type { BrowserContext, Page } from "playwright";
import { parse as parseHtml } from "node-html-parser";

import { acquireBrowser, BrowserPoolError } from "./browser-pool.js";
import { normalizeMermaidSource } from "./mermaid-normalize.js";
import {
  findMdMermaidFences,
  MERMAID_NODE_SELECTOR,
  MERMAID_RENDERED_SVG_SELECTOR,
} from "./mermaid-selector.js";

// public/ under both layouts — tsc keeps src/server/clauded-docs/ at the same depth in dist/.
const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "public");

// The one mermaid runtime config; index.html loads this same file. Its text is injected
// verbatim and the page initializes from the global it assigns, so the export holds no
// second copy that could drift from the viewer's.
export const MERMAID_CONFIG_PATH = resolve(PUBLIC_ROOT, "mermaid-config.js");

// Vendored ELK loader (IIFE). The shared config asks for layout 'elk' and an unregistered
// layout draws on dagre with nothing but a console warning — see LAYOUT_FALLBACK_MARKERS.
export const ELK_LOADER_PATH = resolve(PUBLIC_ROOT, "assets", "vendor", "mermaid-layout-elk-0.2.3.min.js");

// The viewer's ELK prep function; index.html loads this same file. The viewer calls it to FETCH
// the vendored bundle on demand, and this page has already injected that bundle's text, so what
// the export takes from it is the registration step alone (it detects window.mermaidLayoutElk and
// skips the network). Injecting it here is what keeps one registration expression instead of two.
export const ELK_PREP_PATH = resolve(PUBLIC_ROOT, "mermaid-elk-loader.js");

// mermaid's own wording: `Layout algorithm <x> is not registered. Using <y> as fallback.`
const LAYOUT_FALLBACK_MARKERS: readonly string[] = ["Layout algorithm", "not registered"];

// Above warn, mermaid rebinds log.warn to a no-op → the fallback warning is never emitted
// and a zero-warning render would prove nothing.
const WARN_LOG_LEVEL = 3;

// The render context's declared screen basis — passed as BOTH viewport and screen so the
// two never disagree. mermaid 11's C4 renderer takes its row-wrap limit from
// `screen.availWidth` (c4Diagram-*.mjs: `widthLimit = screen.availWidth`), not from the
// container or the config, so leaving it undeclared hands the exported C4 row count to
// Playwright's default and the viewer harness's row count to whatever viewport it set —
// two paths laying the same diagram out differently for a reason neither states.
export const EXPORT_SCREEN = { width: 1280, height: 720 } as const;

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

/**
 * Thrown on HTML export failure. Route handler maps to a 503 envelope (reason
 * `html_export_<stage>: <msg>`). stage "mermaid" = a known-mermaid doc finished
 * with zero <svg> — NEVER ship raw <pre>. stage "tailwind" = a doc that loaded
 * the Tailwind Play CDN finished WITHOUT the runtime stylesheet — NEVER ship an
 * unstyled file. A diagram drawn by a layout the page never registered fails at the
 * "mermaid" stage too — the export never ships a silent fallback.
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
    .querySelectorAll(MERMAID_NODE_SELECTOR)
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

// Injected script text, read once per path at first export.
// Process-lifetime and never invalidated — the assumption is that the updater restarts the
// monitor when it applies, so an edited asset arrives with a fresh process rather than
// having to be noticed here.
const assetCache = new Map<string, string>();

/**
 * Reads a script the render page needs. An unreadable asset is a loud "mermaid" stage
 * failure: skipping the injection would export a diagram drawn by the wrong layout.
 */
export async function loadExportAsset(path: string, label: string): Promise<string> {
  const cached = assetCache.get(path);
  if (cached !== undefined) return cached;
  try {
    const text = await readFile(path, "utf8");
    assetCache.set(path, text);
    return text;
  } catch (error) {
    throw new HtmlExportError(`${label} unreadable at ${path}`, "mermaid", error);
  }
}

// Resolved via import.meta.resolve so the path is identical under tsx (src/) and node
// (dist/) — no build-asset copy.
async function loadMermaidBundle(): Promise<string> {
  const pkgPath = fileURLToPath(import.meta.resolve("mermaid/package.json"));
  return loadExportAsset(resolve(dirname(pkgPath), "dist", "mermaid.min.js"), "mermaid driver bundle");
}

// The injected driver's version, read from the package the driver comes OUT of: loadMermaidBundle
// reads dist/mermaid.min.js from beside this very package.json, so a hand-written value could only
// ever drift from the bundle it names.
//
// Read at the first export, never at module load. This module sits on the server's boot path
// (routes/clauded-docs.ts → registerRoutes → main.ts), so a filesystem read at module scope turns a
// missing mermaid package into a boot failure that launchd repays with a restart loop — the opposite
// of main.ts's non-fatal-prerequisite design, where an unmet export prerequisite leaves the rest of
// the service up and fails the first export loudly. Memoized for the same reason and with the same
// lifetime as assetCache: an edited asset arrives with a fresh process.
//
// Sync read, deliberately: stripCdnScriptsAndFonts is a pure string transform and every caller holds
// it to that, so threading a promise through it to spare one 2 KB read — on a path already blocked on
// a chromium render — would buy nothing.
let mermaidVersion: string | null = null;

function getMermaidVersion(): string {
  if (mermaidVersion !== null) return mermaidVersion;
  try {
    const pkgPath = fileURLToPath(import.meta.resolve("mermaid/package.json"));
    const { version } = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (version === undefined) throw new Error(`no version field in the mermaid package at ${pkgPath}`);
    mermaidVersion = version;
    return version;
  } catch (error) {
    throw new HtmlExportError(
      "mermaid driver version unreadable — the installed mermaid package resolved to nothing readable",
      "mermaid",
      error,
    );
  }
}

/** The offline marker naming the driver that was actually injected — see getMermaidVersion. */
function getMermaidVersionComment(): string {
  return ` mermaid driver: pinned mermaid@${getMermaidVersion()} (locally bundled, no network) `;
}

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
 * returns raw <pre>). The md leg is the one exception and degrades instead —
 * see the fallback there. INVARIANT: the return is never re-sanitized (carries
 * live <svg> that sanitize.ts would strip).
 *
 * @param storedBody - the already-sanitized stored doc body
 * @param format - the doc's stored format (derived from its file extension)
 */
export async function renderSelfContainedHtml(
  storedBody: string,
  format: ExportFormatToken,
): Promise<string> {
  if (format !== "html") {
    const shell = wrapPlainInHtmlShell(storedBody, format);
    // A markdown body carrying diagram fences goes through the SAME browser driver
    // the html format uses — the shell alone has no renderer, so its fences would
    // ship as text (the defect this branch closes). Routing on the fence count and
    // not on the format keeps every fence-free plain export on the cheap path: no
    // chromium, no browser pool, byte-identical output.
    if (format === "md" && countMdMermaidFences(storedBody) > 0) {
      try {
        return await renderHtmlThroughBrowser(shell);
      } catch (error) {
        // An md body ALWAYS had a 200 before this path existed, so a renderer that
        // cannot draw its fences must return the document, not a 503 — a source
        // this grammar reads as a diagram and mermaid does not is a disagreement
        // between two parsers, and the reader loses a document over it either way.
        // The shell it falls back to is the same one every md export shipped
        // before, plus a marker naming what failed so the degradation is visible
        // in the artifact rather than silent.
        return degradeMdToPlainShell(shell, error);
      }
    }
    return shell;
  }
  return renderHtmlThroughBrowser(storedBody);
}

/**
 * Render-time egress predicate for the export browser context (SSRF / LLM01
 * trust boundary). The stored body is attacker-influenceable, so during export
 * the context MUST fetch+execute NOTHING but the Tailwind Play CDN — its JIT
 * runtime is the one resource genuinely required at render (see
 * waitForTailwindStylesheet). Mermaid is injected locally (addScriptTag, no
 * network) and webfonts are stripped from the output, so aborting every other
 * host — across ALL request types (script/style/font/xhr) — is regression-free
 * while eliminating server-side execution + network egress of any embedded
 * attacker script. Fails CLOSED: an unparseable request URL is aborted.
 */
export function shouldAllowRenderRequest(requestUrl: string): boolean {
  let host: string;
  try {
    host = new URL(requestUrl).hostname;
  } catch {
    return false;
  }
  return host === TAILWIND_CDN_HOST;
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
    context = await browser.newContext({
      viewport: { ...EXPORT_SCREEN },
      screen: { ...EXPORT_SCREEN },
    });

    // SSRF / egress guard — abort every render-time request except the Tailwind
    // Play CDN. Installed BEFORE newPage so it covers the very first subresource.
    // See shouldAllowRenderRequest (covers script/style/font/xhr via **/* glob).
    await context.route("**/*", (route) =>
      shouldAllowRenderRequest(route.request().url())
        ? route.continue()
        : route.abort(),
    );

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
 * Watches the render console for mermaid's layout-fallback warning and reports it after the
 * fact. The two halves have to sit apart in time — the warning is emitted mid-render, so the
 * listener attaches before the driver runs, while the verdict can only be read once the
 * render is finished — and keeping them in one named pair is what stops the attach from
 * drifting away from the check it exists for.
 */
function watchLayoutFallback(page: Page): { assertNoFallback: () => void } {
  const fallbackWarnings: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (LAYOUT_FALLBACK_MARKERS.every((marker) => text.includes(marker))) {
      fallbackWarnings.push(text);
    }
  });

  return {
    // A fallback still produces an <svg>, so the zero-svg guard cannot see it.
    assertNoFallback() {
      if (fallbackWarnings.length > 0) {
        throw new HtmlExportError(
          `mermaid drew a diagram with a layout the page never registered: ${fallbackWarnings[0]}`,
          "mermaid",
        );
      }
    },
  };
}

/** Classic script, no `type` — a module tag resolves before it runs, so its global would not be there yet. */
async function injectScript(page: Page, content: string, label: string): Promise<void> {
  try {
    await page.addScriptTag({ content });
  } catch (error) {
    throw new HtmlExportError(`${label} injection failed`, "mermaid", error);
  }
}

/**
 * Injects the pinned mermaid driver, the vendored ELK loader and the shared config, then
 * runs the per-node render loop keyed on PRE-EXTRACTED sources (rationale:
 * extractMermaidSources). sources[i] ↔ the i-th MERMAID_NODE_SELECTOR node (the
 * same constant both sides read). Waits until every node holds an <svg>; zero <svg> for a doc that
 * HAD mermaid nodes → HtmlExportError stage "mermaid".
 */
async function driveMermaidRender(page: Page, sources: string[]): Promise<void> {
  // Attached before the driver runs: the fallback warning is emitted mid-render and is the
  // only signal that a diagram was drawn by a layout nobody asked for.
  const layoutFallback = watchLayoutFallback(page);

  await injectScript(page, await loadMermaidBundle(), "mermaid driver bundle");
  await injectScript(page, await loadExportAsset(ELK_LOADER_PATH, "elk layout loader"), "elk layout loader");
  await injectScript(page, await loadExportAsset(ELK_PREP_PATH, "elk layout prep"), "elk layout prep");
  await injectScript(page, await loadExportAsset(MERMAID_CONFIG_PATH, "mermaid config"), "mermaid config");

  let renderError: string | null;
  try {
    // Callback runs in chromium (DOM context); tsconfig lib is ES2022 (no DOM),
    // so browser globals go through a locally-typed globalThis cast.
    renderError = await page.evaluate(async (args) => {
      type MermaidGlobal = {
        mermaid?: {
          initialize: (c: unknown) => void;
          registerLayoutLoaders: (loaders: unknown) => void;
          mermaidAPI?: { getConfig: () => { logLevel?: unknown } };
          render: (id: string, src: string) => Promise<{ svg: string }>;
        };
        MERMAID_CONFIG?: unknown;
        mermaidLayoutElk?: { default?: unknown };
        ensureElkLayout?: () => Promise<void>;
        document: {
          querySelectorAll: (sel: string) => ArrayLike<{ innerHTML: string }>;
        };
      };
      const g = globalThis as unknown as MermaidGlobal;
      const mermaid = g.mermaid;
      if (mermaid === undefined) return "window.mermaid undefined after driver injection";
      if (g.MERMAID_CONFIG === undefined) return "window.MERMAID_CONFIG undefined after config injection";
      if (g.ensureElkLayout === undefined) return "window.ensureElkLayout undefined after prep injection";
      try {
        // The viewer's prep function, on its already-arrived branch: the loader is a classic script
        // that has already executed, so this registers from window.mermaidLayoutElk and never fetches.
        await g.ensureElkLayout();
        mermaid.initialize(g.MERMAID_CONFIG);
        const level = Number(mermaid.mermaidAPI?.getConfig().logLevel ?? Number.NaN);
        if (!(level <= args.warnLogLevel)) {
          return `page logLevel ${String(level)} is above ${args.warnLogLevel}, where a layout fallback is never logged`;
        }
        const nodes = Array.from(g.document.querySelectorAll(args.nodeSelector));
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
    }, { sources, warnLogLevel: WARN_LOG_LEVEL, nodeSelector: MERMAID_NODE_SELECTOR });
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
      (args) => {
        const g = globalThis as unknown as {
          document: { querySelectorAll: (sel: string) => ArrayLike<unknown> };
        };
        return g.document.querySelectorAll(args.svgSelector).length >= args.count;
      },
      { count: sources.length, svgSelector: MERMAID_RENDERED_SVG_SELECTOR },
      { timeout: MERMAID_RENDER_TIMEOUT_MS },
    );
  } catch (error) {
    throw new HtmlExportError(
      "mermaid render finished with fewer <svg> than mermaid nodes (zero-svg guard)",
      "mermaid",
      error,
    );
  }

  // Checked after the render completes — see watchLayoutFallback.
  layoutFallback.assertNoFallback();
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

// mermaid runs with useMaxWidth off → the <svg> keeps its intrinsic width and this container absorbs it.
// Breakout presets size against the nearest query container, never the viewport.
// A viewport basis escapes past the scroll origin on any off-centre column, and negative offsets do not exist.
// `body` is that container here — the column the viewer's scroll wrap plays (clauded-docs.jsx).
// The negative margin-inline pulls the node out of the column while keeping it centred on it.
const DIAGRAM_CONTAINER_STYLE =
  "body{container-type:inline-size}" +
  "pre.mermaid,.mermaid{overflow-x:auto}" +
  "pre.mermaid>svg,.mermaid>svg{max-width:none}" +
  ".mermaid.doc-diagram-body{width:100%}" +
  ".mermaid.doc-diagram-wide{width:min(100cqi - 4rem,1600px);" +
  "margin-inline:calc(50% - min(50cqi - 2rem,800px))}" +
  ".mermaid.doc-diagram-full{width:100cqi;margin-inline:calc(50% - 50cqi)}" +
  // Node corners — the same r=8 the map's canvas gives its diagram nodes, and the viewer's
  // own rule beside the width block above. A CSS geometry property, so it also wins over the
  // presentation attribute the types that DO emit one write.
  "pre.mermaid svg :is(.node,.cluster) rect," +
  ".mermaid svg :is(.node,.cluster) rect{rx:8px;ry:8px}";

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
  // SECURITY: both args are module-level constants with ZERO document/body interpolation
  // — the mermaid note carries the installed package's own version, never stored content —
  // so this is not an injection sink. insertAdjacentHTML keeps them as real
  // DOM comments (insertAdjacentText would HTML-escape the markers).
  const head = root.querySelector("head") ?? root;
  head.insertAdjacentHTML(
    "afterbegin",
    `<!--${OFFLINE_FONTS_COMMENT}--><!--${getMermaidVersionComment()}-->`,
  );

  // Export pages get neither the viewer's .doc-body-isolation block nor SHELL_STYLE → the width rule ships here.
  // beforeend, not afterbegin — a later sheet wins specificity ties with the stored body's own styles.
  head.insertAdjacentHTML("beforeend", `<style>${DIAGRAM_CONTAINER_STYLE}</style>`);

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
  "main,pre:not(.mermaid){padding:1.5rem;max-width:980px;margin:0 auto}" +
  // .mermaid is a diagram container, not a code block — the dark box, the wrap
  // and the column cap all belong to the text formats. The yaml/json/txt <pre>
  // carries no class, so :not(.mermaid) selects exactly what the bare selector did
  // and their rendering is unchanged. Their stylesheet TEXT does differ by these two
  // selectors, so an existing plain export is equivalent, not byte-identical.
  "pre:not(.mermaid){white-space:pre-wrap;word-break:break-word;" +
  "background:#111827;border:1px solid #1f2937;border-radius:8px;" +
  "font-family:ui-monospace,SFMono-Regular,Menlo,monospace}" +
  "main{white-space:pre-wrap;word-break:break-word}";

/**
 * Splices a markdown body's ```mermaid fences into diagram containers, escaping
 * everything else exactly as the plain shell always has.
 *
 * WHICH fences those are is not decided here — findMdMermaidFences owns that
 * question for both the count and the splice, so the export can never route a
 * body to the renderer and then produce no container for it.
 *
 * The whole-body escape this replaces is why an md document exported its diagram
 * as literal fence text: the shell has no renderer, so a fence had no path to an
 * <svg>. Emitting the container the driver already reads (MERMAID_NODE_SELECTOR)
 * puts md on the same path the html format uses.
 *
 * A body with no fence returns escapeHtml(body) — byte-identical to before, which
 * is what keeps every existing plain export unchanged.
 *
 * The source is escaped, never pre-decoded: it has to survive as the container's
 * TEXT, and a decoded `--&gt;` would re-parse as markup.
 */
function renderMdInner(body: string): { inner: string; diagramCount: number } {
  let inner = "";
  let cursor = 0;
  let diagramCount = 0;

  for (const fence of findMdMermaidFences(body)) {
    inner += escapeHtml(body.slice(cursor, fence.start));
    // doc-diagram-body = the body-width preset, first of the three declared in
    // DIAGRAM_CONTAINER_STYLE. A fence carries no width declaration, so it gets the default.
    inner += `<pre class="mermaid doc-diagram-body">${escapeHtml(fence.source)}</pre>`;
    cursor = fence.end;
    diagramCount += 1;
  }
  inner += escapeHtml(body.slice(cursor));

  return { inner, diagramCount };
}

/** How many diagram fences a markdown body carries — the export's routing test. */
export function countMdMermaidFences(body: string): number {
  return renderMdInner(body).diagramCount;
}

/**
 * Marks an md export whose diagrams could not be drawn and shipped as text.
 *
 * The degradation itself is the point: an md body has always exported 200, and a
 * renderer that chokes on something this grammar read as a diagram must not cost
 * the reader the whole document. But it is never SILENT — this comment rides in
 * the artifact, so a degraded export is distinguishable from one that never had
 * a diagram, both by a reader opening the file and by the suite.
 */
export const MD_DIAGRAM_DEGRADED_COMMENT = "diagram render unavailable; body shipped as text";

/** Detail cap — a mermaid parse error quotes the source it choked on back at you. */
const DEGRADED_DETAIL_MAX = 200;

/** The plain shell every md export shipped before, plus the marker naming what failed. */
function degradeMdToPlainShell(shell: string, error: unknown): string {
  const stage = error instanceof HtmlExportError ? error.stage : "render";
  const detail = error instanceof Error ? error.message : String(error);
  // The message can quote the stored body, which is attacker-influenceable: a
  // `-->` inside it would close this comment and land markup in the shell.
  const safeDetail = detail
    .replace(/[<>]/g, " ")
    .replace(/-{2,}/g, "-")
    .slice(0, DEGRADED_DETAIL_MAX);
  // Function form, not a replacement string — safeDetail is untrusted and `$&`
  // in a replacement string is a substitution pattern.
  return shell.replace(
    "</head>",
    () => `<!-- ${MD_DIAGRAM_DEGRADED_COMMENT} (${stage}): ${safeDetail} --></head>`,
  );
}

/**
 * Wraps a raw non-HTML stored body in a minimal self-contained dark HTML shell.
 * Code formats (yaml/json/txt) go inside a <pre>; md goes inside a
 * newline-preserving <main>. No CDN, no script — offline by construction.
 */
export function wrapPlainInHtmlShell(body: string, format: PlainFormatToken): string {
  const inner =
    format === "md"
      ? `<main>${renderMdInner(body).inner}</main>`
      : `<pre>${escapeHtml(body)}</pre>`;
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
