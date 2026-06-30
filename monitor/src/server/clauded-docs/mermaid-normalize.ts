// Mermaid source normalizer — relocates accessibility directives that precede
// the diagram-type line so mermaid v11 detectType can recognize the diagram.
//
// Problem:
//   - mermaid v11 detectType requires the diagram-type keyword (flowchart,
//     sequenceDiagram, …) as the FIRST significant content line. It strips ONLY
//     a leading YAML frontmatter block, leading %%{init:…}%% directives, and %%
//     comments before scanning for the type. A stored block that places acc
//     directives (accTitle:/accDescr:) BEFORE the type line therefore fails with
//     "No diagram type detected" — breaking BOTH render surfaces (server export
//     loud-fail → HTTP 503, client viewer raw-<pre> fallback).
//
// Fix — pure source rewrite, no render-code change:
//   - Hold leading frontmatter, init-directives, and %% comments in place, find
//     the first recognized type line, and move any acc directives sitting above
//     it to immediately AFTER it. The accDescr braced-block form moves as one
//     unit. Idempotent + safe: an unrecognized source returns unchanged.
//
// SYNC: this file (src/server/clauded-docs/mermaid-normalize.ts) is the source
// of truth for normalizeMermaidSource. A logic-identical inline copy lives in
// public/src/screens/clauded-docs.jsx (the client viewer cannot import server
// .ts — esbuild IIFE transpile, no module bundling). Keep the two LOGIC-identical,
// NOT byte-identical: the client copy's private helpers carry a CD suffix
// (isMermaidTypeLineCD, etc.) to avoid namespace collision in the shared .jsx, so
// a literal byte-diff drift check is expected to differ. The keyword set, boundary
// class, and acc/frontmatter/init/CRLF reordering logic must stay identical.
//
// Browser-safe: pure string ops, zero Node APIs.

// Recognized mermaid v11 diagram-type keywords (broad set). A line is a "type
// line" when its trimmed content starts (case-insensitive) with one of these
// followed by end-of-token (whitespace, direction modifier, or end of line) —
// so "flowchart TD" matches but "flowchartish" does not.
const MERMAID_TYPE_KEYWORDS: readonly string[] = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram-v2",
  "classDiagram",
  "stateDiagram-v2",
  "stateDiagram",
  "erDiagram",
  "gantt",
  "pie",
  "journey",
  "gitGraph",
  "mindmap",
  "timeline",
  "quadrantChart",
  "requirementDiagram",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
  "block-beta",
  "packet-beta",
  "architecture-beta",
  "kanban",
  "xychart-beta",
  "sankey-beta",
  "zenuml",
];

// Multi-keyword forms (classDiagram-v2, stateDiagram-v2) precede their shorter
// prefix in the list so the longer keyword wins the startsWith race.
function isTypeLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  for (const kw of MERMAID_TYPE_KEYWORDS) {
    const kwLower = kw.toLowerCase();
    if (!lower.startsWith(kwLower)) continue;
    // Boundary check: the char after the keyword must be a separator, not an
    // identifier continuation (rejects "flowchartish").
    const after = trimmed.charAt(kw.length);
    if (after === "" || /[\s:;{(]/.test(after)) return true;
  }
  return false;
}

// An acc directive is `accTitle:` / `accDescr:` (single-line) or `accDescr {`
// (braced multi-line block, spanning until the matching `}`).
function isAccLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("accTitle:") ||
    trimmed.startsWith("accDescr:") ||
    trimmed.startsWith("accDescr {") ||
    trimmed.startsWith("accDescr{")
  );
}

function isInitOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("%%");
}

// Consume a leading YAML frontmatter block (`---` … `---`) anchored at position
// 0, returning the held lines and the index of the first line past it.
function holdFrontmatter(lines: string[]): { held: string[]; next: number } {
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { held: [], next: 0 };
  }
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      return { held: lines.slice(0, i + 1), next: i + 1 };
    }
  }
  // Unterminated frontmatter → not a valid block; hold nothing.
  return { held: [], next: 0 };
}

// From `start`, consume consecutive init-directive / %% comment lines (and the
// blank lines interleaved among them), returning them as held preamble.
function holdInitAndComments(
  lines: string[],
  start: number,
): { held: string[]; next: number } {
  const held: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isInitOrComment(line) || line.trim().length === 0) {
      held.push(line);
      i += 1;
      continue;
    }
    break;
  }
  // Trailing blank lines belong to the body, not the preamble — give them back.
  while (held.length > 0 && held[held.length - 1].trim().length === 0) {
    held.pop();
    i -= 1;
  }
  return { held, next: i };
}

// Collect an acc directive starting at `start`. A single-line directive spans
// one line; a braced `accDescr {` block spans until the line containing `}`.
function collectAccUnit(
  lines: string[],
  start: number,
): { unit: string[]; next: number } {
  const first = lines[start];
  const trimmed = first.trim();
  const isBraced =
    trimmed.startsWith("accDescr {") || trimmed.startsWith("accDescr{");
  if (!isBraced) {
    return { unit: [first], next: start + 1 };
  }
  const unit: string[] = [first];
  // A `}` on the opening line itself closes the block (single-line braced form).
  if (trimmed.includes("}")) {
    return { unit, next: start + 1 };
  }
  for (let i = start + 1; i < lines.length; i += 1) {
    unit.push(lines[i]);
    if (lines[i].includes("}")) {
      return { unit, next: i + 1 };
    }
  }
  // Unterminated brace → treat the rest as the unit (defensive; never strands).
  return { unit, next: lines.length };
}

/**
 * Normalize a mermaid source so the diagram-type keyword is the first
 * significant line detectType sees, moving any preceding acc directives to
 * immediately after the type line.
 *
 * Reconstructs as: [frontmatter] + [init-directives/comments] + [type line] +
 * [moved acc directives] + [remaining body]. Frontmatter, init directives, %%
 * comments, and anything already after the type line are left untouched.
 * Idempotent; returns the source unchanged when no recognized type keyword
 * exists (safety floor — never corrupts a non-standard source).
 */
export function normalizeMermaidSource(src: string): string {
  if (src.length === 0) return src;

  // Preserve the input's line-ending convention on reconstruction.
  const usesCrlf = src.includes("\r\n");
  const eol = usesCrlf ? "\r\n" : "\n";
  const lines = src.split(/\r\n|\n/);

  const frontmatter = holdFrontmatter(lines);
  const preamble = holdInitAndComments(lines, frontmatter.next);
  let cursor = preamble.next;

  // Walk from the preamble end, separating leading acc directives from the lines
  // up to the first type line. `leadingAcc` = directives to relocate after the
  // type line; `betweenLines` = blank lines interleaved with them (kept after
  // the moved acc directives, so reconstruction is lossless). Relocation fires
  // only when at least one acc directive precedes a recognized type line.
  const leadingAcc: string[] = [];
  const betweenLines: string[] = [];
  let typeLineIdx = -1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim().length === 0) {
      // Blank line before the type line — preserve it (only meaningful for the
      // lossless rebuild once acc directives have started).
      betweenLines.push(line);
      cursor += 1;
      continue;
    }
    if (isAccLine(line)) {
      const acc = collectAccUnit(lines, cursor);
      leadingAcc.push(...acc.unit);
      cursor = acc.next;
      continue;
    }
    if (isTypeLine(line)) {
      typeLineIdx = cursor;
      break;
    }
    // A non-acc, non-type significant line before any type line → relocation is
    // unsafe (type, if any, sits after arbitrary body). Leave the source as-is.
    break;
  }

  // No acc directives sat before a type line → nothing to relocate. Return the
  // source unchanged (covers already-valid, no-acc, and no-recognized-type).
  if (leadingAcc.length === 0 || typeLineIdx === -1) {
    return src;
  }

  const typeLine = lines[typeLineIdx];
  const remaining = lines.slice(typeLineIdx + 1);

  const rebuilt = [
    ...frontmatter.held,
    ...preamble.held,
    typeLine,
    ...leadingAcc,
    ...betweenLines,
    ...remaining,
  ];
  return rebuilt.join(eol);
}
