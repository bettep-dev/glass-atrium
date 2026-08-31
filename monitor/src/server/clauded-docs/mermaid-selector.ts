// Diagram-node render contract — the ONE selector that decides what counts as a
// mermaid block, and the companion selector that decides when one has finished
// rendering.
//
// Why a module for two strings: the pair is a CONTRACT between four readers that
// have to agree or the system fails silently, not loudly —
//   · the viewer's post-render effect (public/src/screens/clauded-docs.jsx)
//   · the export driver + its zero-svg guard (html-export.ts)
//   · the stored-body validator (html-validator.ts)
//   · the export's source extractor (html-export.ts, reads the raw string)
// A writer that emits a container shape one reader recognises and another does
// not produces a document that validates, exports, and then shows a code block —
// which is exactly the defect this module was extracted for. Divergence here is
// undetectable at every layer that does not compare the two literals.
//
// CLIENT COPY: the viewer is a browser module (esbuild IIFE transpile, no module
// bundling — see the SYNC note above normalizeMermaidSource in clauded-docs.jsx)
// and CANNOT import this file. It carries one named constant instead, pinned to
// this literal by clauded-docs.md-mermaid.test.ts — the drift guard that makes
// the copy safe. Same constraint, same remedy as mermaid-normalize.ts.

/** Every node the render contract treats as a diagram block. */
export const MERMAID_NODE_SELECTOR = "pre.mermaid, .mermaid";

/** A diagram block that has finished rendering — its `<svg>` child is present. */
export const MERMAID_RENDERED_SVG_SELECTOR = "pre.mermaid svg, .mermaid svg";

// ---------------------------------------------------------------------------
// Markdown source half of the same contract.
//
// The two constants above answer "what counts as a diagram block" once a
// document is HTML. This half answers it one layer earlier, for a markdown
// SOURCE body, and it lives here for the same reason: the viewer and the export
// have to agree or a document renders on one surface and not the other, with
// nothing red anywhere.
//
// WHY A RE-IMPLEMENTATION AND NOT THE VIEWER'S PARSER: the viewer delegates the
// question to marked@13.0.0, loaded from a CDN by public/index.html. The server
// cannot ask that parser — `marked` is not a monitor dependency; the only copy
// on disk is a TRANSITIVE dependency of mermaid (mermaid -> marked ^16.3.0),
// and importing an undeclared transitive package into shipped server code is a
// provenance defect that breaks the day mermaid retunes its range. So the
// grammar below is a deliberate second implementation, and the divergence it
// creates is made VISIBLE rather than assumed away: clauded-docs.md-mermaid.test.ts
// runs this function and marked over one table of bodies and fails on any
// disagreement outside the documented gaps.
//
// WHAT IT IMPLEMENTS (CommonMark 0.31 fenced code blocks, the subset markdown
// writers actually reach for):
//   · backtick AND tilde fences, 3 or more, closing fence at least as long
//   · scanning is SEQUENTIAL, so a fence opened in any language swallows every
//     line until its own closer — an inner ```mermaid inside an outer `````
//     fence is literal text, exactly as marked reads it. This is the rule that
//     keeps a document ABOUT mermaid from being mistaken for one.
//   · the opening fence indents at most 3 spaces past its container, so a
//     4-space-indented block is code, not a fence
//   · one level of list-item context, so a fence indented under `- ` or `1. `
//     still counts
//   · blockquote (`> `) prefixes, stripped from the captured source
//   · info strings: the language is the first word, so ```mermaid title="x"
//     counts and ```mermaidjs does not; backticks are illegal in a backtick
//     fence's info string
//   · a fence left unclosed at end of body, which CommonMark closes there
//   · CRLF bodies, and the case-SENSITIVE spelling (see MD_MERMAID_INFO_WORD)
//
// WHAT IT DOES NOT IMPLEMENT — every one of these is a FALSE NEGATIVE, which
// ships the fence as literal text (what the export always did) rather than
// feeding non-diagram text to the renderer:
//   · nesting deeper than one list level, and list items whose content indent
//     exceeds the marker width
//   · backslash/entity escapes inside the info string
//   · tabs are counted as 4 columns rather than expanded to the next tab stop
//   · setext/ATX interactions and any inline construct
// ---------------------------------------------------------------------------

/**
 * The info-string word that makes a fenced block a diagram.
 *
 * Case-SENSITIVE on purpose: marked copies the info string verbatim into
 * `language-<info>`, and the viewer's container replacement matches
 * `language-mermaid` exactly — so ```MERMAID stays a code block in the viewer,
 * and the export has to leave it one too.
 */
export const MD_MERMAID_INFO_WORD = "mermaid";

/** One recognized mermaid fence: its span in the body, and its diagram source. */
export interface MdMermaidFence {
  /** Offset of the opening fence line's first character. */
  start: number;
  /** Offset one past the closing fence line's last character (its newline excluded). */
  end: number;
  /** Diagram source — blockquote prefixes and the opening fence's indent removed. */
  source: string;
}

/** A list marker, whose width is how far its item's content is indented. */
const LIST_MARKER = /^([-*+]|\d{1,9}[.)])(\s+|$)/;

/** An opening fence: 3+ backticks or tildes, then the info string. */
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;

/** Leading whitespace, counted in columns (a tab is 4 — see the DOES NOT IMPLEMENT note). */
function indentColumns(line: string): { columns: number; offset: number } {
  let columns = 0;
  let offset = 0;
  while (offset < line.length) {
    const ch = line[offset];
    if (ch === " ") columns += 1;
    else if (ch === "\t") columns += 4;
    else break;
    offset += 1;
  }
  return { columns, offset };
}

/** Strips `> ` blockquote markers, returning how many were removed. */
function stripQuotePrefix(line: string): { depth: number; rest: string } {
  let depth = 0;
  let rest = line;
  for (;;) {
    const match = /^ {0,3}>[ \t]?/.exec(rest);
    if (match === null) return { depth, rest };
    depth += 1;
    rest = rest.slice(match[0].length);
  }
}

/**
 * Every mermaid fence a markdown body carries, in source order — the ONE answer
 * the export routes on and splices with, so the count and the containers can
 * never disagree.
 *
 * Returns [] for a body with no fence, which is what keeps a plain md export
 * byte-identical to what it has always produced.
 */
export function findMdMermaidFences(body: string): MdMermaidFence[] {
  const found: MdMermaidFence[] = [];
  const lines = body.split("\n");

  let open: {
    char: string;
    length: number;
    indent: number;
    indentOffset: number;
    quoteDepth: number;
    isMermaid: boolean;
    start: number;
    source: string[];
  } | null = null;
  let listIndent = 0;
  let cursor = 0;

  for (const rawLine of lines) {
    const lineStart = cursor;
    cursor += rawLine.length + 1;
    // A CRLF body keeps its \r on every line after the split — drop it so a
    // closing fence is not "``` \r" and a captured source carries no stray \r.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const { depth: quoteDepth, rest } = stripQuotePrefix(line);
    const { columns: indent, offset } = indentColumns(rest);
    const content = rest.slice(offset);

    if (open !== null) {
      // Leaving the blockquote ends the containing block, and with it the fence.
      if (quoteDepth !== open.quoteDepth) {
        if (open.isMermaid) {
          found.push({ start: open.start, end: lineStart - 1, source: open.source.join("\n") });
        }
        open = null;
      } else {
        const closer = new RegExp(`^\\${open.char}{${open.length},}[ \\t]*$`);
        if (indent <= open.indent + 3 && closer.test(content)) {
          if (open.isMermaid) {
            found.push({
              start: open.start,
              end: lineStart + rawLine.length,
              source: open.source.join("\n"),
            });
          }
          open = null;
          continue;
        }
        // Content keeps its own indentation past the opening fence's.
        open.source.push(rest.slice(Math.min(offset, open.indentOffset)));
        continue;
      }
    }

    if (content.length === 0) continue;

    const opener = FENCE_OPEN.exec(content);
    if (opener !== null && indent <= listIndent + 3) {
      const marker = opener[1];
      const info = opener[2];
      // CommonMark: a backtick fence's info string may not contain a backtick.
      if (!(marker.startsWith("`") && info.includes("`"))) {
        const language = info.trim().split(/\s+/)[0] ?? "";
        open = {
          char: marker[0],
          length: marker.length,
          indent,
          indentOffset: offset,
          quoteDepth,
          isMermaid: language === MD_MERMAID_INFO_WORD,
          start: lineStart,
          source: [],
        };
        continue;
      }
    }

    const listMarker = LIST_MARKER.exec(content);
    if (listMarker !== null) listIndent = indent + listMarker[0].length;
    else if (indent === 0) listIndent = 0;
  }

  // CommonMark closes a fence left open at end of body.
  if (open !== null && open.isMermaid) {
    found.push({ start: open.start, end: body.length, source: open.source.join("\n") });
  }

  return found;
}
