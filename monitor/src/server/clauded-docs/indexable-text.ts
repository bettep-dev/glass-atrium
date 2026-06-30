// HTML → plaintext extractor for the monitor.documents.indexable_text column.
//
// Purpose & determinism contract:
//   - tsvector input wants visual whitespace + decoded entities + script/style
//     stripped, but does NOT want markdown structure (headings as #, lists as -).
//     Output is plaintext — no markdown / no structural sigils.
//   - Postgres' GENERATED tsvector column derives from `indexable_text`, so the
//     extracted text MUST be deterministic for a given HTML input — caching at
//     the FS or downstream layer relies on that determinism.
//
// Boundaries: pure function. No FS, no DB, no logger. Composable from the route
// layer's transactional flow.

import { parse, type HTMLElement, type Node } from "node-html-parser";

// Tags whose content MUST be excluded from indexable_text:
//   - script / style: code, not document content
//   - noscript: fallback content already shadowed by document body
//   - iframe / embed / object: external content out of our trust boundary
const NON_TEXT_TAGS: ReadonlySet<string> = new Set<string>([
  "script",
  "style",
  "noscript",
  "iframe",
  "embed",
  "object",
  "template",
]);

// Block-level tags trigger a newline boundary in the output. node-html-parser
// returns text nodes verbatim; without these breaks the extracted text would
// run paragraphs together (hurting tsvector tokenization quality).
const BLOCK_TAGS: ReadonlySet<string> = new Set<string>([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "dd",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "td",
  "th",
  "ul",
  "video",
]);

/**
 * Extracts a normalized plaintext representation of `html` suitable for
 * Postgres tsvector indexing.
 *
 * - Decodes HTML entities (via node-html-parser's parser; library uses `he`).
 * - Strips script / style / iframe content entirely.
 * - Block-level tags introduce a single space boundary so adjacent words from
 *   different paragraphs do not concatenate.
 * - Collapses all whitespace runs to single spaces; trims edges.
 *
 * Throws when the input is not a string (defensive — TS type system enforces
 * this at the boundary, but the route layer hands user-supplied content).
 */
export function extractIndexableText(html: string): string {
  if (typeof html !== "string") {
    throw new TypeError("extractIndexableText expects a string");
  }
  if (html.length === 0) {
    return "";
  }
  // node-html-parser is forgiving — handles fragments and full documents the
  // same way. `lowerCaseTagName: true` normalizes tag comparison upstream.
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false, // discard <!-- ... --> nodes; they are not document content.
    voidTag: { closingSlash: true },
    blockTextElements: {
      script: false,
      noscript: false,
      style: false,
      pre: true, // preserve pre-formatted text content
    },
  });

  const buffer: string[] = [];
  // Root is a synthetic container with empty rawTagName — its `text` accessor
  // would return the concatenated descendant text (collapsing whitespace), so
  // we MUST recurse into childNodes directly. Calling collectText(root) would
  // hit the text-node fallback branch and lose paragraph boundaries.
  for (const child of root.childNodes) {
    collectText(child, buffer);
  }
  // Collapse any whitespace run to single space, then trim edges. Multiple
  // newlines from BLOCK_TAGS are also folded — tsvector cares about word
  // boundaries, not paragraph structure.
  return buffer.join("").replace(/\s+/g, " ").trim();
}

function collectText(node: Node, out: string[]): void {
  // Text node — node-html-parser exposes nodeType=3 for text nodes; the
  // generic Node base class lacks a discriminator field, so the safest path is
  // to detect HTMLElement via its rawTagName property and treat the rest as text.
  if (isHtmlElement(node)) {
    const tagName = node.rawTagName.toLowerCase();
    if (NON_TEXT_TAGS.has(tagName)) {
      // Skip the entire subtree.
      return;
    }
    const isBlock = BLOCK_TAGS.has(tagName);
    if (isBlock) {
      out.push(" ");
    }
    for (const child of node.childNodes) {
      collectText(child, out);
    }
    if (isBlock) {
      out.push(" ");
    }
    return;
  }
  // Text node fallback — `text` accessor returns the entity-decoded content.
  const text = node.text;
  if (typeof text === "string" && text.length > 0) {
    out.push(text);
  }
}

function isHtmlElement(node: Node): node is HTMLElement {
  // node-html-parser does not export a typeguard; check for the rawTagName
  // string accessor that only HTMLElement provides at runtime.
  return (
    typeof (node as { rawTagName?: unknown }).rawTagName === "string" &&
    (node as { rawTagName: string }).rawTagName.length > 0
  );
}
