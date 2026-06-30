// DOMPurify-based HTML body sanitizer — the sole enforcement point for stored
// doc bodies; its output is the SoT. Output is deterministic (SHA256 → row
// content_hash). GET returns the stored copy as-is (no re-sanitize) so the
// response never mismatches the stored hash.

import DOMPurify, { type Config } from "isomorphic-dompurify";

// CDN allowlist — allowed origins for <script src="…"> in the body. Origins
// (scheme+host+port), not prefixes: a prefix startsWith match treats
// "https://cdn.tailwindcss.com.evil.com/x.js" as allowed (suffix-host bypass).
// Any path on a listed origin passes; any other host is rejected.
const CDN_SCRIPT_ORIGIN_ALLOWLIST: ReadonlySet<string> = new Set(
  [
    "https://cdn.jsdelivr.net/",
    "https://cdn.tailwindcss.com/",
    "https://fonts.googleapis.com/",
    "https://fonts.gstatic.com/",
    "https://ajax.googleapis.com/",
  ].map((entry) => new URL(entry).origin),
);

// Tags to remove. iframe is listed explicitly (DOMPurify passes it by default).
// details/summary are NOT removed (sandbox-safe disclosure UI) — their handlers
// stay neutralized by the on* block + uponSanitizeElement hook.
const FORBID_TAGS_LIST: readonly string[] = [
  "iframe",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "video",
  "audio",
  "canvas",
  "svg",
  "picture",
  "source",
  "template",
];

// Explicit `on*` handler block — DOMPurify removes them by default; layered defense.
const FORBID_ATTR_LIST: readonly string[] = [
  "onerror",
  "onclick",
  "onload",
  "onmouseover",
  "onfocus",
  "onmouseout",
  "onkeydown",
  "onkeyup",
  "onkeypress",
  "onblur",
  "onchange",
  "onsubmit",
  "onreset",
  "ondblclick",
  "ondrag",
  "ondrop",
  "onscroll",
  "onwheel",
  "onanimationstart",
  "onanimationend",
  "ontransitionend",
];

// Extra allowed attributes — presentation attributes the viewer needs + lang.
// Layered on top of DOMPurify's default allowlist (not an overwrite).
const ADD_ATTR_LIST: readonly string[] = [
  "style",
  "class",
  "id",
  "lang",
  "title",
  "data-*", // ADD_ATTR pattern — DOMPurify supports prefix matching
];

// Origin-compares whether a CDN script src is in the allowlist. Parses the src
// to its origin so only the exact host (any path/version) passes — an unparseable
// src or a non-allowlisted host (incl. suffix-host bypass like *.evil.com) is rejected.
function isAllowedCdnScript(src: string): boolean {
  let origin: string;
  try {
    origin = new URL(src).origin;
  } catch {
    return false;
  }
  return CDN_SCRIPT_ORIGIN_ALLOWLIST.has(origin);
}

// `uponSanitizeElement` hook — registered once at module import. Idempotency guard
// via a registration flag (no duplicate hook even if tests require the module repeatedly).
let hooksRegistered = false;

function registerHooksOnce(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;

  // script tags — pass only when src is CDN-allowlisted; inline / non-allowlist are
  // deleted. Works alongside DOMPurify's ADD_TAGS:['script'].
  DOMPurify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName !== "script") return;

    // node narrows to HTMLScriptElement for script tags; getAttribute via type guard.
    const src = getAttribute(node, "src");
    if (src === null || src.length === 0) {
      data.allowedTags["script"] = false; // inline script — remove
      return;
    }
    if (!isAllowedCdnScript(src)) {
      data.allowedTags["script"] = false;
      return;
    }
    data.allowedTags["script"] = true;
  });
}

// Safe node-level getAttribute access. jsdom Element instances always have a
// getAttribute method, guarded by a typeof check.
function getAttribute(node: unknown, attr: string): string | null {
  if (typeof node !== "object" || node === null) return null;
  const candidate = node as { getAttribute?: (name: string) => string | null };
  if (typeof candidate.getAttribute !== "function") return null;
  return candidate.getAttribute(attr);
}

// Default sanitize config — `sanitizeHtmlBody` reuses the same object every call.
const SANITIZE_CONFIG: Config = {
  WHOLE_DOCUMENT: true,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  KEEP_CONTENT: false,
  ADD_TAGS: ["script"],
  ADD_ATTR: [...ADD_ATTR_LIST],
  FORBID_TAGS: [...FORBID_TAGS_LIST],
  FORBID_ATTR: [...FORBID_ATTR_LIST],
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
};

/**
 * Sanitizes an input HTML string via DOMPurify.
 *
 * - identical input → identical output (deterministic) — usable as content_hash input.
 * - empty string input → empty string output (no throw).
 * - DOMPurify internal exceptions propagate — the route layer handles them as 500.
 *
 * @param rawHtml - raw HTML body sent by the user/agent via POST/PUT
 * @returns the sanitized HTML string
 */
export function sanitizeHtmlBody(rawHtml: string): string {
  registerHooksOnce();

  if (rawHtml.length === 0) return "";

  const result = DOMPurify.sanitize(rawHtml, SANITIZE_CONFIG);
  // A string return is type-guaranteed under RETURN_DOM=false / RETURN_DOM_FRAGMENT=false,
  // but a runtime guard narrows isomorphic-dompurify's union type (`string | …`).
  if (typeof result !== "string") {
    throw new TypeError("DOMPurify.sanitize did not return a string under string-mode config");
  }
  return result;
}
