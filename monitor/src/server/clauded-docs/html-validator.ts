// Pure structural validator for clauded-docs HTML bodies — catches half-formed
// agent output at the boundary (routes/clauded-docs.ts handleCreate/handleUpdate,
// after DOMPurify, before MD conversion + storage) rather than storing broken docs.
//
// Design note (load-bearing): DOMPurify strips `<!doctype>` and `<meta charset>`,
// so the validator inspects BOTH raw (doctype + charset) and sanitized (every
// element check) input. Element parsing is node-html-parser AST only — the
// doctype/charset scans are bounded preamble checks, not element traversal.
// Per-stage contract + the 7 required elements live in the `validateHtmlStructure`
// and `HtmlStructureCheck` doc blocks (SoT — not restated here).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parse } from "node-html-parser";

// 5 MB ceiling for the validator's input. Above this, return a synthetic
// "all missing" result so the caller returns 400 without invoking the parser.
const MAX_INPUT_BYTES = 5 * 1024 * 1024;

// First-N-chars window for the doctype scan. 100 chars covers `<!doctype html>`
// with generous leading whitespace / BOM allowance.
const DOCTYPE_SCAN_WINDOW = 100;

// D8 threshold JSON SoT — numeric D8 policy (comparison-column cap, WCAG
// contrast ratios, typography level cap) lives in a single co-located
// `d8-thresholds.json`, read + parsed at module init via a build-stable
// `import.meta.url` path (same pattern as main.ts's PUBLIC_ROOT).
// Build note: tsc does NOT copy .json, so `npm run build` (build:assets) copies
// d8-thresholds.json into dist/server/clauded-docs/ beside the compiled
// html-validator.js; the runtime reads it relative to import.meta.url.

/** Machine-consumed D8 numeric policy — the JSON SoT shape. */
export interface D8Thresholds {
  comparisonTable: {
    /** ≤N columns on comparison tables. */
    maxColumns: number;
  };
  contrast: {
    /** WCAG AA text-contrast floor (4.5:1). Forward use site. */
    textMinRatio: number;
    /** WCAG AA UI-contrast floor (3:1). Forward use site. */
    uiMinRatio: number;
  };
  typography: {
    /** Max heading levels (H1/H2/Body = 3). Forward use site. */
    maxLevels: number;
  };
}

// Build-stable path to the JSON SoT — resolved relative to THIS module's
// location so it works identically under tsx (src/) and node (dist/).
const HERE = dirname(fileURLToPath(import.meta.url));
const D8_THRESHOLDS_PATH = resolve(HERE, "d8-thresholds.json");

/**
 * Read + parse + shape-validate a D8 threshold JSON SoT, returning a deeply
 * frozen `D8Thresholds`. Pure relative to the file at `jsonPath` (no global
 * state) — module init calls it with the co-located default path; tests call
 * it with a temp-fixture path to prove the cap flows from data.
 *
 * Throws on malformed JSON or a missing required numeric field — a corrupt
 * policy SoT MUST loud-fail at startup, never silently fall back to a literal.
 *
 * @param jsonPath - absolute path to the threshold JSON file.
 * @returns frozen threshold object.
 */
export function loadD8Thresholds(jsonPath: string): D8Thresholds {
  const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as unknown;
  const t = parsed as Partial<D8Thresholds>;
  const maxColumns = t.comparisonTable?.maxColumns;
  const textMinRatio = t.contrast?.textMinRatio;
  const uiMinRatio = t.contrast?.uiMinRatio;
  const maxLevels = t.typography?.maxLevels;
  // Shape guard — every numeric policy field is required; absence = corrupt SoT.
  if (typeof maxColumns !== "number") {
    throw new Error(`D8 threshold SoT invalid: comparisonTable.maxColumns missing/non-number (${jsonPath})`);
  }
  if (typeof textMinRatio !== "number" || typeof uiMinRatio !== "number") {
    throw new Error(`D8 threshold SoT invalid: contrast ratios missing/non-number (${jsonPath})`);
  }
  if (typeof maxLevels !== "number") {
    throw new Error(`D8 threshold SoT invalid: typography.maxLevels missing/non-number (${jsonPath})`);
  }
  return Object.freeze({
    comparisonTable: Object.freeze({ maxColumns }),
    contrast: Object.freeze({ textMinRatio, uiMinRatio }),
    typography: Object.freeze({ maxLevels }),
  });
}

/**
 * Module-init D8 policy — loaded once from the co-located JSON SoT. All gate
 * sites read numeric D8 values from here, never from a code literal.
 */
export const D8_THRESHOLDS: D8Thresholds = loadD8Thresholds(D8_THRESHOLDS_PATH);

/** Placeholder-token scan pattern — residual `{{…}}` template tokens. */
const PLACEHOLDER_PATTERN = /\{\{[^}]*\}\}/;

/** AST subtrees whose text content is verbatim by design — placeholder-exempt. */
const PLACEHOLDER_EXEMPT_TAGS: ReadonlySet<string> = new Set(["code", "pre"]);

// node-html-parser NodeType discriminators (avoids importing the enum).
const TEXT_NODE_TYPE = 3;
const ELEMENT_NODE_TYPE = 1;

/**
 * Discriminated identifier of each structural requirement. Stable wire format
 * — the route layer surfaces these literals in the `details.missing` array.
 */
export type HtmlStructureMissingField =
  | "doctype"
  | "html_root"
  | "head_title"
  | "body"
  | "semantic_landmark"
  | "heading"
  | "charset";

/**
 * Input to `validateHtmlStructure`. `raw` is the original POST/PUT body BEFORE
 * sanitize — used for doctype + charset (DOMPurify strips both). `sanitized`
 * is the post-DOMPurify output — used for every element-level check.
 *
 * For callers that have only one form (e.g., tests of a fully-formed page),
 * passing the same string for both fields is a valid degenerate case.
 */
export interface HtmlStructureInput {
  raw: string;
  sanitized: string;
}

/**
 * A single D8 style-lint finding. Two kinds:
 *
 * - `line-anchored` — a violation localizable to one source line (e.g. an
 *   inline color literal). Carries the 1-based `line` (derived from the AST
 *   node's byte-offset range) and the deterministic `rule` id.
 * - `document-level` — a whole-document property violation (e.g. an explicit
 *   light-default body scheme). A scheme/presence property has no meaningful
 *   single line, so this kind carries NO `line` field — only the `rule` id.
 *
 * Every `rule` value MUST be a member of `STYLE_RULE_ALLOWLIST` (frozen set).
 */
export type StyleFinding =
  | { kind: "line-anchored"; line: number; rule: StyleRule }
  | { kind: "document-level"; rule: StyleRule };

/**
 * Result of `validateHtmlStructure`. Success carries no payload; failure
 * carries one of four discriminated variants (a single response = at most one
 * code; the pipeline short-circuits on the first failing stage):
 *
 * - `code: 'html_structure_invalid'` — 7-field structure check failed; the
 *   `missing` array enumerates absent elements in canonical declaration order.
 * - `code: 'placeholder_residue'` — structure passed but residual `{{…}}`
 *   template tokens remain (outside `<code>`/`<pre>`); `lines` carries the
 *   1-based offending line numbers, ascending.
 * - `code: 'd8_p2_violation'` — comparison table (`<th>`-bearing) exceeds the
 *   column cap; `details` locates the first violating table.
 * - `code: 'd8_style_violation'` — D8 visual style rules violated; `findings`
 *   reports ALL violations (not first-only) as a 2-kind discriminated array.
 *
 * Pipeline order: structure → placeholder → D8 columns → D8 style.
 */
export type HtmlStructureCheck =
  | { ok: true }
  | {
      ok: false;
      code: "html_structure_invalid";
      missing: HtmlStructureMissingField[];
    }
  | {
      ok: false;
      code: "placeholder_residue";
      lines: number[];
    }
  | {
      ok: false;
      code: "d8_p2_violation";
      details: D8P2ViolationDetails;
    }
  | {
      ok: false;
      code: "d8_style_violation";
      findings: StyleFinding[];
    };

/**
 * D8 column-cap violation payload — surfaced to FE via the 400 response so the
 * author can locate the offending table without re-scanning the document.
 */
export interface D8P2ViolationDetails {
  /** 1-based nth-of-type index of the violating `<table>` for DOM location. */
  tableIndex: number;
  /** Column count of the violating table (always > MAX_COMPARISON_COLUMNS). */
  columnCount: number;
  /** Cap applied at evaluation time — surfaces for caller error message. */
  maxAllowed: number;
}

/**
 * D8 comparison-table column cap — comparison tables MUST have ≤N columns (N
 * from the JSON SoT, not a code literal). Back-compat alias for the long-standing
 * export name; the value is sourced from `D8_THRESHOLDS`.
 *
 * Rationale: comparison tables are a decision-acceleration tool — exceeding the cap breaks the
 * cognitive load (mental model) of row=criterion / column=alternative. Enforced by a
 * mechanism gate, not prompt cascade self-discipline. The number is loaded
 * from the single SoT d8-thresholds.json — no code change needed on update.
 */
export const MAX_COMPARISON_COLUMNS = D8_THRESHOLDS.comparisonTable.maxColumns;

/** Deterministic D8 style-lint rule ids. Frozen — see STYLE_RULE_ALLOWLIST. */
export type StyleRule = "inline-color-literal" | "light-default-body";

/**
 * Frozen allowlist of every style-lint rule id the server gate may emit
 * Semantic D8 axes (color-blind intent, measured contrast ratio,
 * typography hierarchy) are excluded by construction — they never receive a
 * deterministic rule id, so they cannot enter the server gate. A guard test
 * asserts no emitted `rule` falls outside this set.
 *
 * `comparison-col-cap` is intentionally NOT here — the column-cap violation is
 * surfaced via its own `d8_p2_violation` variant (with structured `details`),
 * not as a `d8_style_violation` finding.
 */
export const STYLE_RULE_ALLOWLIST = Object.freeze([
  "inline-color-literal",
  "light-default-body",
] as const);

// Explicit light-default anti-pattern detection on <html>/<body> (dark-base
// contract). Only an EXPLICIT light background/scheme is a
// deterministic violation — the MERE ABSENCE of a dark token is a SEMANTIC
// authoring recommendation (LLM-judge scope per the scope-qa mechanical/
// semantic split), NOT a hard POST gate. Firing on absence would reject every
// minimal/unstyled doc; firing on an explicit light token catches the real
// anti-pattern. Tailwind light backgrounds = bg-white + bg-{slate,zinc,neutral,
// gray}-(50|100|200).
const LIGHT_BG_CLASS_PATTERN = /^bg-(?:white|(?:slate|zinc|neutral|gray)-(?:50|100|200))$/;

// Inline light background/scheme literals (CSS value side) — white / #fff /
// #ffffff backgrounds, or an explicit `color-scheme: light`.
const LIGHT_INLINE_PATTERN =
  /background(?:-color)?\s*:\s*(?:white|#fff(?:fff)?\b)|color-scheme\s*:\s*light/i;

// Color-literal pattern inside a CSS value — hex (#abc / #aabbcc), rgb(), rgba(),
// and the two named print-branch literals (white / black). Used for both inline
// `style=` attributes and `<style>`-block declarations.
const COLOR_LITERAL_PATTERN =
  /#[0-9a-f]{3,8}\b|\brgba?\s*\(|\b(?:white|black)\b/i;

/**
 * D8 column-cap violation thrown by `assertComparisonTableColumns`. Carries the same
 * payload as the `HtmlStructureCheck` discriminator variant so callers that
 * catch the throw can forward it to the wire response unchanged.
 */
export class D8P2ViolationError extends Error {
  readonly code = "d8_p2_violation" as const;
  readonly tableIndex: number;
  readonly columnCount: number;
  readonly maxAllowed: number;

  constructor(details: D8P2ViolationDetails) {
    super(
      `D8 P2 violation: comparison table (nth-of-type=${details.tableIndex}) ` +
        `has ${details.columnCount} columns, exceeds cap ${details.maxAllowed}`,
    );
    this.name = "D8P2ViolationError";
    this.tableIndex = details.tableIndex;
    this.columnCount = details.columnCount;
    this.maxAllowed = details.maxAllowed;
  }
}

// Canonical order of fields in the `missing` array — matches the type-level
// declaration order. Used to keep output stable across repeated invocations
// on the same input.
const FIELD_ORDER: readonly HtmlStructureMissingField[] = [
  "doctype",
  "html_root",
  "head_title",
  "body",
  "semantic_landmark",
  "heading",
  "charset",
];

/**
 * Validate the structural shape of a (raw + sanitized) HTML body.
 *
 * Pipeline order (single response, at most one error code — first failing
 * stage short-circuits):
 *   1. 7-field structure check (`html_structure_invalid`).
 *   2. Placeholder-residue check (`placeholder_residue`). Residual
 *      `{{…}}` outside `<code>`/`<pre>` → 1-based offending line numbers.
 *   3. D8 comparison-table column-cap check (`d8_p2_violation`).
 *   4. D8 style-lint check (`d8_style_violation`). Reports ALL findings.
 *
 * Each later stage runs only when every earlier stage passes — guarantees the
 * structure prerequisite is met before semantic / style enforcement.
 *
 * - Pure: no I/O, no side effects, deterministic. (The threshold JSON is read
 *   once at module init, not per call.)
 * - Single parse of `sanitized` + single parse of `raw` (charset + placeholder).
 * - DoS-safe: inputs > 5 MB (either side) short-circuit before parsing.
 *
 * @param input - `{ raw, sanitized }` pair. Doctype + charset + placeholder are
 *                checked on `raw` (DOMPurify strips doctype/charset; placeholder
 *                line numbers must map to the author's source); every other
 *                field is checked on `sanitized`.
 * @param thresholds - D8 numeric policy. Defaults to the module-init JSON SoT
 *                     (`D8_THRESHOLDS`); tests inject a fixture-loaded value to
 *                     prove the cap flows from data. Production
 *                     callers omit this argument.
 * @returns `{ ok: true }` when every requirement passes; otherwise a
 *          discriminated failure variant — see `HtmlStructureCheck`.
 */
export function validateHtmlStructure(
  input: HtmlStructureInput,
  thresholds: D8Thresholds = D8_THRESHOLDS,
): HtmlStructureCheck {
  const { raw, sanitized } = input;

  // DoS guard — oversized inputs are reported as fully invalid without
  // engaging the parser. The 5 MB ceiling exists so a runaway client cannot
  // pin the event loop on parser work.
  if (raw.length === 0 || raw.length > MAX_INPUT_BYTES) {
    return structureInvalid([...FIELD_ORDER]);
  }
  if (sanitized.length === 0 || sanitized.length > MAX_INPUT_BYTES) {
    return structureInvalid([...FIELD_ORDER]);
  }

  // Doctype is a preamble declaration (not an element node), so the AST never
  // surfaces it — string prefix scan is the only viable mechanism. Bounded to
  // the first 100 chars so this stays O(1) regardless of input size.
  const hasDoctype = raw.slice(0, DOCTYPE_SCAN_WINDOW).toLowerCase().includes("<!doctype");

  // Parse both raw and sanitized through node-html-parser. Two parses are
  // necessary because DOMPurify drops `<meta charset>` — the charset check
  // therefore inspects the agent's source AST, not the post-sanitize AST.
  // All other element checks read from the sanitized AST (post-security).
  const parseOpts = {
    lowerCaseTagName: true,
    comment: false,
    voidTag: { closingSlash: true },
  };
  const rawRoot = parse(raw, parseOpts);
  const root = parse(sanitized, parseOpts);

  const hasCharset = hasCharsetMeta(rawRoot);

  const hasHtmlRoot = root.querySelector("html") !== null;
  const hasBody = root.querySelector("body") !== null;
  const hasHeadTitle = hasNonEmptyTitle(root);
  const hasSemanticLandmark =
    root.querySelector("main") !== null ||
    root.querySelector("article") !== null ||
    root.querySelector("section") !== null;
  const hasHeading =
    root.querySelector("h1") !== null ||
    root.querySelector("h2") !== null ||
    root.querySelector("h3") !== null;

  const presence: Record<HtmlStructureMissingField, boolean> = {
    doctype: hasDoctype,
    html_root: hasHtmlRoot,
    head_title: hasHeadTitle,
    body: hasBody,
    semantic_landmark: hasSemanticLandmark,
    heading: hasHeading,
    charset: hasCharset,
  };

  const missing = FIELD_ORDER.filter((field) => !presence[field]);
  if (missing.length > 0) return structureInvalid(missing);

  // Step 2 — placeholder residue. Walk the RAW AST (line numbers must map
  // to the author's source), skipping `<code>`/`<pre>` subtrees. The raw walk
  // (not a flat regex over the string) is what lets the exempt subtrees survive.
  const placeholderLines = findPlaceholderLines(rawRoot as unknown as WalkableNode, raw);
  if (placeholderLines.length > 0) {
    return { ok: false, code: "placeholder_residue", lines: placeholderLines };
  }

  // Step 3 — D8 column-cap check on the already-parsed sanitized AST.
  // We reuse `root` (no second parse) so this stays O(table count) on top of
  // the existing single-parse pipeline. Cap sourced from the JSON SoT.
  const violation = findComparisonTableViolation(root, thresholds.comparisonTable.maxColumns);
  if (violation !== null) {
    return { ok: false, code: "d8_p2_violation", details: violation };
  }

  // Step 4 — D8 style-lint. Inline color literals (raw AST, line-anchored),
  // `<style>`-block screen-context literals (line-anchored), and the dark-base
  // presence check (document-level) — ALL findings reported in one array.
  const findings = findStyleViolations(rawRoot as unknown as WalkableNode, raw);
  if (findings.length > 0) {
    return { ok: false, code: "d8_style_violation", findings };
  }

  return { ok: true };
}

/**
 * Inspect parsed sanitized HTML for the first comparison table (a `<table>`
 * containing at least one `<th>`) whose column count exceeds the cap. Returns
 * the violation payload, or `null` when every comparison table is within cap.
 *
 * Layout tables (no `<th>`) are skipped — the cap enforces decision-aid tables
 * only. Empty tables are skipped (no columns to count).
 *
 * @param maxColumns - the cap, sourced from the JSON SoT (single SoT —
 *                     no literal `5` here or in the payload's `maxAllowed`).
 */
function findComparisonTableViolation(
  root: QueryableNode,
  maxColumns: number,
): D8P2ViolationDetails | null {
  const tables = root.querySelectorAll("table");
  for (let i = 0; i < tables.length; i += 1) {
    const table = tables[i];
    const ths = table.querySelectorAll("th");
    // Skip layout tables — `<th>` absence is the comparison-intent signal.
    if (ths.length === 0) continue;

    // Column count = max(row.cell.count) — handles tables with merged cells
    // or asymmetric header/body rows by taking the widest row.
    const columnCount = countTableColumns(table);
    if (columnCount > maxColumns) {
      return {
        tableIndex: i + 1, // 1-based nth-of-type
        columnCount,
        maxAllowed: maxColumns,
      };
    }
  }
  return null;
}

/**
 * Column count of a `<table>` = max cell-count across all `<tr>` rows.
 * Uses the AST's row + cell traversal instead of CSS counting — `<thead>`
 * and `<tbody>` wrapping does not affect the result.
 */
function countTableColumns(table: QueryableNode): number {
  const rows = table.querySelectorAll("tr");
  let max = 0;
  for (const row of rows) {
    // First-level row cells — both `<th>` and `<td>` count toward the row width.
    const cells = row.querySelectorAll("th, td");
    if (cells.length > max) max = cells.length;
  }
  return max;
}

/**
 * Standalone D8 column-cap enforcement — for callers outside the structure pipeline
 * (batch checkers, viewer integrity probes). Throws `D8P2ViolationError` on
 * cap exceedance; returns void on pass or when no comparison table exists.
 *
 * Wraps node-html-parser invocation directly so callers pass the HTML string
 * without managing the raw/sanitized split required by `validateHtmlStructure`.
 */
export function assertComparisonTableColumns(html: string): void {
  if (html.length === 0 || html.length > MAX_INPUT_BYTES) return;
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    voidTag: { closingSlash: true },
  });
  // Cap sourced from the JSON SoT — no literal here either.
  const violation = findComparisonTableViolation(root, D8_THRESHOLDS.comparisonTable.maxColumns);
  if (violation !== null) throw new D8P2ViolationError(violation);
}

/**
 * Tiny constructor for the `html_structure_invalid` failure variant. Keeps
 * the three call sites in `validateHtmlStructure` from re-stating the
 * discriminator literal — single edit point if the wire code ever changes.
 */
function structureInvalid(
  missing: HtmlStructureMissingField[],
): Extract<HtmlStructureCheck, { code: "html_structure_invalid" }> {
  return { ok: false, code: "html_structure_invalid", missing };
}

// node-html-parser surfaces its root as something with `querySelector` /
// `querySelectorAll`. We avoid importing the concrete `HTMLElement` type to
// keep this module's import surface narrow — local interface narrowing
// serves the same purpose.
//
// `QueryableElement extends QueryableNode` because every node-html-parser
// element supports recursive traversal (`querySelectorAll` from any node).
// This lets D8 column counting walk from a `<table>` element down to its
// rows / cells without re-parsing.
interface QueryableNode {
  querySelector(selector: string): QueryableElement | null;
  querySelectorAll(selector: string): QueryableElement[];
}

interface QueryableElement extends QueryableNode {
  text: string;
  getAttribute(name: string): string | null | undefined;
}

/**
 * <title> presence + non-empty text after whitespace trim. Empty <title></title>
 * is treated as missing — the validator's intent is "agent provided a real
 * document title", not "the <title> tag exists".
 */
function hasNonEmptyTitle(root: QueryableNode): boolean {
  const titleNode = root.querySelector("title");
  if (titleNode === null) return false;
  return titleNode.text.trim().length > 0;
}

/**
 * Charset-meta presence check via AST traversal. Accepts both modern
 * (<meta charset="..."> with non-empty value) and legacy
 * (<meta http-equiv="Content-Type" content="...; charset=..."> with the
 * charset substring present) forms.
 *
 * Inspects ALL <meta> elements (querySelectorAll) — agents sometimes put
 * the charset declaration in the middle of <head> rather than at the very
 * top, so a single querySelector with attribute filter could miss it.
 */
function hasCharsetMeta(root: QueryableNode): boolean {
  const metas = root.querySelectorAll("meta");
  for (const meta of metas) {
    const charsetAttr = meta.getAttribute("charset");
    if (typeof charsetAttr === "string" && charsetAttr.trim().length > 0) {
      return true;
    }
    const httpEquiv = meta.getAttribute("http-equiv");
    if (typeof httpEquiv === "string" && httpEquiv.toLowerCase() === "content-type") {
      const content = meta.getAttribute("content");
      // Substring contract: legacy Content-Type meta must include a
      // `charset=…` token. We accept any non-empty token after the `=`.
      if (typeof content === "string" && /charset\s*=\s*[\w-]+/i.test(content)) {
        return true;
      }
    }
  }
  return false;
}

// placeholder-residue + style-lint — raw-AST walks with byte-offset → line
// mapping (node-html-parser exposes `.range`, NOT `.line`).

// Minimal recursive-walk view of a node-html-parser node. `childNodes` +
// `nodeType` + `range` + `rawText` + `rawTagName` are the only members the
// raw-AST walks touch — narrowing keeps the import surface small (mirrors the
// QueryableNode rationale above). `getAttribute` is present on elements only.
interface WalkableNode {
  nodeType: number;
  rawTagName: string;
  range: readonly [number, number];
  rawText: string;
  childNodes: WalkableNode[];
  getAttribute?(name: string): string | null | undefined;
}

/** 1-based line of a byte offset in `raw` (newline count before it + 1). */
function lineAtOffset(raw: string, offset: number): number {
  return raw.slice(0, offset).split("\n").length;
}

/**
 * Walk the RAW AST collecting 1-based line numbers of residual `{{…}}`
 * placeholder tokens, skipping `<code>`/`<pre>` subtrees (their text is
 * verbatim by design). A raw-string flat regex CANNOT satisfy both the residue
 * and the exempt-subtree requirement — it would flag tokens inside
 * `<code>`/`<pre>` — so the walk prunes the
 * exempt subtrees at the element boundary instead.
 *
 * Line derivation reuses the SAME node.range byte-offset → line mapping as the
 * style-lint (consistency). Returned lines are deduped + ascending.
 */
function findPlaceholderLines(root: WalkableNode, raw: string): number[] {
  const lines = new Set<number>();
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, "g");

  const walk = (node: WalkableNode): void => {
    if (node.nodeType === ELEMENT_NODE_TYPE) {
      // Prune exempt subtrees — do not descend into <code>/<pre>.
      if (PLACEHOLDER_EXEMPT_TAGS.has(node.rawTagName)) return;
    } else if (node.nodeType === TEXT_NODE_TYPE) {
      // Scan this text node for every placeholder occurrence. Offset is the
      // node's raw start + the match index within the node's rawText.
      const base = node.range[0];
      for (const match of node.rawText.matchAll(pattern)) {
        lines.add(lineAtOffset(raw, base + (match.index ?? 0)));
      }
    }
    for (const child of node.childNodes) walk(child);
  };

  walk(root);
  return [...lines].sort((a, b) => a - b);
}

/**
 * Collect ALL D8 style-lint findings from the RAW AST. Three surfaces:
 *
 *  1. inline `style=` color literal (hex/rgb/rgba/named) → line-anchored
 *     `inline-color-literal` (line = the carrying element's range start).
 *  2. `<style>`-block color literal in a SCREEN context (i.e. NOT inside an
 *     `@media print` block) → line-anchored `inline-color-literal`. Literals
 *     inside `@media print` are EXEMPT (the print branch is mandated).
 *  3. EXPLICIT light-default body — `<html>`/`<body>` carries a light Tailwind
 *     bg token (bg-white / bg-*-(50|100|200)) or an inline light bg / scheme,
 *     OUTSIDE `@media print` → document-level `light-default-body` (NO line
 *     field — a whole-document scheme property). Dark-token ABSENCE does NOT
 *     fire — that is a semantic authoring recommendation, not a hard gate.
 *
 * Findings are returned in document order; the caller wraps them in the single
 * `d8_style_violation` variant (at-most-one-code-per-response — the array lives
 * inside the one variant).
 */
function findStyleViolations(root: WalkableNode, raw: string): StyleFinding[] {
  const findings: StyleFinding[] = [];
  let sawLightDefault = false;

  const walk = (node: WalkableNode): void => {
    if (node.nodeType === ELEMENT_NODE_TYPE) {
      const tag = node.rawTagName;

      // (3) explicit light-default — flag if <html>/<body> declares a light
      // background/scheme via class token OR inline style. (Document-level —
      // recorded once, emitted after the walk.)
      if ((tag === "html" || tag === "body") && node.getAttribute) {
        const cls = node.getAttribute("class");
        if (typeof cls === "string" && hasLightBgClass(cls)) sawLightDefault = true;
        const style = node.getAttribute("style");
        if (typeof style === "string" && LIGHT_INLINE_PATTERN.test(style)) sawLightDefault = true;
      }

      // (1) inline style= color literal.
      if (node.getAttribute) {
        const style = node.getAttribute("style");
        if (typeof style === "string" && COLOR_LITERAL_PATTERN.test(style)) {
          findings.push({
            kind: "line-anchored",
            line: lineAtOffset(raw, node.range[0]),
            rule: "inline-color-literal",
          });
        }
      }

      // (2) <style>-block screen-context literals — parse the block text with
      // @media-print awareness. The TextNode child carries the CSS + its range.
      if (tag === "style") {
        for (const child of node.childNodes) {
          if (child.nodeType === TEXT_NODE_TYPE) {
            for (const offset of findScreenContextColorOffsets(child.rawText)) {
              findings.push({
                kind: "line-anchored",
                line: lineAtOffset(raw, child.range[0] + offset),
                rule: "inline-color-literal",
              });
            }
          }
        }
      }
    }
    for (const child of node.childNodes) walk(child);
  };

  walk(root);

  if (sawLightDefault) {
    findings.push({ kind: "document-level", rule: "light-default-body" });
  }
  return findings;
}

/** True when any whitespace-delimited class token is an explicit light bg token. */
function hasLightBgClass(classAttr: string): boolean {
  return classAttr.split(/\s+/).some((token) => LIGHT_BG_CLASS_PATTERN.test(token));
}

/**
 * Scan CSS block text for color literals that sit in a SCREEN context — i.e.
 * NOT nested inside an `@media print` (or print-including) at-rule block. The
 * print contract MANDATES `background:white; color:black` inside the print
 * branch, so those must be exempt; the same literals outside print RAISE.
 *
 * Returns the byte offsets (relative to the CSS text start) of each offending
 * literal so the caller can map them to source lines. CSS-context-aware via a
 * brace-depth scan that marks the byte range owned by each `@media print`
 * block — not a naive "any hex anywhere" match.
 */
function findScreenContextColorOffsets(css: string): number[] {
  // Pass 1 — identify [start,end) byte ranges of every `@media …print…` block
  // body. A print media query is one whose prelude (between `@media` and `{`)
  // mentions `print` (covers `@media print`, `@media screen and (...), print`,
  // etc. — any rule that applies to print is treated as the exempt branch).
  const printRanges: Array<[number, number]> = [];
  const mediaRe = /@media([^{]*)\{/gi;
  for (const media of css.matchAll(mediaRe)) {
    const prelude = media[1];
    const bodyStart = (media.index ?? 0) + media[0].length; // char after `{`
    const bodyEnd = matchBlockEnd(css, bodyStart);
    if (/\bprint\b/i.test(prelude)) {
      printRanges.push([bodyStart, bodyEnd]);
    }
  }

  const inPrint = (offset: number): boolean =>
    printRanges.some(([s, e]) => offset >= s && offset < e);

  // Pass 2 — every color literal whose offset is NOT inside a print range.
  const offsets: number[] = [];
  const colorRe = new RegExp(COLOR_LITERAL_PATTERN.source, "gi");
  for (const color of css.matchAll(colorRe)) {
    const at = color.index ?? 0;
    if (!inPrint(at)) offsets.push(at);
  }
  return offsets;
}

/**
 * Given the offset just AFTER an opening `{`, return the offset of the matching
 * close `}` (exclusive end of the block body). Brace-depth balanced; if the
 * block is unterminated, returns the string length (best-effort).
 */
function matchBlockEnd(css: string, bodyStart: number): number {
  let depth = 1;
  for (let i = bodyStart; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return css.length;
}
