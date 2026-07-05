#!/usr/bin/env bash
# validate-compliance-matrix.sh — Two-layer audit of core-compliance-matrix.md.
#
# Layer A (advisory, exit 0): filename-set drift between the matrix's declared
#   rule files and the actual ~/.claude/rules/ (+ ~/.glass-atrium/
#   scoped/) filesystem. A renamed/deleted file without a matrix update (broken
#   pointer) or a new undeclared file (governance gap) surfaces as a single
#   banner line.
#
# Layer B (enforcement, exit 2 on a CONFIRMED inconsistency): MATRIX-INTERNAL
#   consistency — verifies the matrix table agrees with its own declarations:
#     B1. Tier-1 Core rules keep their ALL-column ✓ (a Tier-1 security rule
#         silently set to un-loaded is DETECTED).
#     B2. Footnote markers in table cells (†/‡/§/¶) ↔ their `>` blockquote
#         footnote definitions are 1:1 (a marker with no footnote, or a
#         footnote with no cell usage, is DETECTED).
#     B3. Every Compliance Matrix column header is a legal Scope Legend scope
#         (a row claiming a non-legend scope column is DETECTED).
#
# Fail-OPEN contract (the load-bearing safety property):
#   When the matrix TABLE STRUCTURE cannot be parsed (missing section anchors,
#   absent header row, zero data rows) Layer B emits an advisory STDERR note and
#   exits 0. Format drift MUST NOT exit-2 false-block a session — only a
#   CONFIRMED inconsistency in a parseable matrix warrants exit 2.
#
# Trigger (REGISTERED — settings.json SessionStart array):
#   Fires once per session start. SessionStart has no PreToolUse-style block
#   channel; exit 2 here is an audit-grade signal (visible in logs, asserted by
#   the Bats suite + manual/CI invocation), not a session abort.
#
# Testability:
#   The matrix path is overridable via COMPLIANCE_MATRIX_FILE so the Bats suite
#   can drive Layer B against controlled fixtures (flipped Tier-1 ✓, orphan
#   marker, format-drift) without touching the live matrix. The filesystem dirs
#   (Layer A) are likewise overridable via COMPLIANCE_RULES_DIR /
#   COMPLIANCE_SCOPED_DIR.
#
# Exit codes:
#   0 = no inconsistency (or fail-open: unparseable matrix / missing inputs)
#   2 = CONFIRMED matrix-internal inconsistency (Layer B)

set -Eeuo pipefail
IFS=$'\n\t'

# Native rules live FOLDERED at ~/.claude/rules/glass-atrium/*.md — the
# rules-recursion probe settled RECURSIVE (native autoload discovers nested
# rule files), so foldering is safe. MATRIX_FILE + RULES_DIR default to that
# folder; both stay ENV-overridable so the Bats suite can drive Layer B against
# controlled fixtures. These SessionStart hooks are client-fired (a
# settings.json env block may not reach them), so the DEFAULT constants — not
# an env block — carry the foldered paths.
readonly MATRIX_FILE="${COMPLIANCE_MATRIX_FILE:-${HOME}/.claude/rules/glass-atrium/core-compliance-matrix.md}"
readonly RULES_DIR="${COMPLIANCE_RULES_DIR:-${HOME}/.claude/rules/glass-atrium}"
# Scoped-rules dir — Tier-2/Tier-3 rule files relocated OUT of the native rules
# autoload glob (Approach A diet) are consumed IN PLACE from ~/.glass-atrium/scoped
# (dropped from the ~/.claude farm), reachable for on-demand + hook-injected reads.
# They remain matrix-declared, so the drift scan MUST union this dir into the
# actual-present set; otherwise every relocated file would falsely show as
# declared-missing each session.
readonly SCOPED_DIR="${COMPLIANCE_SCOPED_DIR:-${HOME}/.glass-atrium/scoped}"

# Files that physically live in rules/ but are not loadable rules themselves.
# core-compliance-matrix.md is the governance manifest (this script reads it as
# input) — listing it as a matrix row would be self-referential. Treat as a
# documented exemption rather than flagging it every session.
readonly EXEMPT_FILES="core-compliance-matrix.md"

# Footnote markers the matrix uses for conditional-exception cells. The B2 check
# never hard-codes which markers must exist — it derives both the cell set and
# the footnote set from THIS list, so a future marker addition needs one edit
# here. NOTE: multibyte glyph classes ([†‡§¶]) are unreliable in grep -E under
# a UTF-8 locale, so B2 matches each marker as a fixed string (grep -F).
readonly FOOTNOTE_MARKERS=$'\xe2\x80\xa0\n\xe2\x80\xa1\n\xc2\xa7\n\xc2\xb6'

# SessionStart hooks may receive JSON on stdin. Drain it so an upstream writer
# never blocks; the payload itself is unused by this advisory check.
if [[ ! -t 0 ]]; then
  cat >/dev/null 2>&1 || true
fi

# --- Guards (fail-open: missing inputs never fail the session) -----------------

if [[ ! -r "${MATRIX_FILE}" ]]; then
  printf '[compliance-matrix-drift] skipped: matrix file unreadable (%s)\n' "${MATRIX_FILE}"
  exit 0
fi

# ==============================================================================
# Layer B — MATRIX-INTERNAL CONSISTENCY (enforcement; exit 2 on confirmed fault)
# Runs FIRST so a confirmed inconsistency surfaces even if Layer A is skipped.
# ==============================================================================

# Slice the Compliance Matrix table (the `## Compliance Matrix` section's
# pipe-delimited block). Returns the header row + data rows, header-separator
# (|---|) lines stripped. Empty output ⇒ table not found / unparseable.
matrix_table_block() {
  awk '
    /^## Compliance Matrix[ \t]*$/ { in_sec = 1; next }
    in_sec && /^## / { in_sec = 0 }
    in_sec && /^\|/ {
      if ($0 ~ /^\|[ \t]*-+/) next   # skip the |---|---| separator row
      print
    }
  ' "${MATRIX_FILE}"
}

# Extract the column-header scope tokens from the matrix header row (the first
# table row, column 1 = "Rule File", columns 2..N = scope names).
matrix_header_scopes() {
  local block="${1}"
  printf '%s\n' "${block}" | head -1 | awk -F'|' '
    {
      for (i = 3; i <= NF; i++) {     # i=2 is "Rule File"; scopes start at i=3
        gsub(/^[ \t]+|[ \t]+$/, "", $i)
        if ($i != "") print $i
      }
    }
  '
}

# Legal scope tokens from the Scope Legend table (## Scope Legend, column 1).
# Strikethrough (~~DATA~~) and the "Scope" header are excluded.
legend_scopes() {
  awk '
    /^## Scope Legend[ \t]*$/ { in_sec = 1; next }
    in_sec && /^## / { in_sec = 0 }
    in_sec && /^\|/ {
      if ($0 ~ /^\|[ \t]*-+/) next
      n = split($0, c, "|")
      tok = c[2]
      gsub(/^[ \t]+|[ \t]+$/, "", tok)
      if (tok == "" || tok == "Scope") next
      if (tok ~ /~~/) next            # ~~DATA~~ = archived/inactive
      print tok
    }
  ' "${MATRIX_FILE}"
}

# Tier-1 Core rule basenames from the `### Tier 1 — Core` bullet list.
# Strips the path prefix (agents/, rules/) and backtick wrapping.
tier1_core_rules() {
  awk '
    /^### Tier 1/ { in_sec = 1; next }
    in_sec && /^### / { in_sec = 0 }
    in_sec && /^- / {
      line = $0
      gsub(/`/, "", line)
      sub(/^- /, "", line)
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      n = split(line, p, "/")
      print p[n]
    }
  ' "${MATRIX_FILE}"
}

# For a given rule basename, report the matrix row's ALL-column state. Prints
# one of three sentinels so the caller distinguishes a flipped cell from an
# absent row (column index 3 in the pipe split: 1=empty, 2=Rule File, 3=ALL):
#   ABSENT  — no matrix row for this rule (structural gap → Layer A territory)
#   EMPTY   — row present but ALL cell blank (B1 violation: ✓ flipped off)
#   HAS     — row present, ALL cell carries ✓ (consistent)
matrix_all_cell() {
  local block="${1}" rule="${2}"
  printf '%s\n' "${block}" | awk -F'|' -v rule="${rule}" '
    {
      name = $2
      gsub(/^[ \t]+|[ \t]+$/, "", name)
      if (name == rule) {
        found = 1
        cell = $3
        gsub(/^[ \t]+|[ \t]+$/, "", cell)
        # U+2713 ✓ encoded as the literal UTF-8 byte triple to stay
        # locale-independent (glyph classes are unreliable under UTF-8 awk).
        state = (index(cell, "\342\234\223") > 0) ? "HAS" : "EMPTY"
        exit
      }
    }
    END { print (found ? state : "ABSENT") }
  '
}

run_layer_b() {
  local block
  block="$(matrix_table_block)"

  # --- Fail-OPEN parse guards -------------------------------------------------
  # Need a header row + at least one data row; an absent table or a header-only
  # slice is format drift, NOT a confirmed inconsistency → advise + exit 0.
  local row_count
  row_count="$(printf '%s\n' "${block}" | grep -c '^|' || true)"
  [[ -z "${row_count}" ]] && row_count=0
  if [[ "${row_count}" -lt 2 ]]; then
    printf '[compliance-matrix-consistency] fail-open: matrix table unparseable (rows=%s) — advisory only\n' \
      "${row_count}" >&2
    return 0
  fi

  # Header row column 2 must literally read "Rule File"; otherwise the column
  # geometry assumption is broken → fail open rather than mis-judge cells.
  local header_c2
  header_c2="$(printf '%s\n' "${block}" | head -1 | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}')"
  if [[ "${header_c2}" != "Rule File" ]]; then
    printf '[compliance-matrix-consistency] fail-open: matrix header geometry unexpected (col2=%q) — advisory only\n' \
      "${header_c2}" >&2
    return 0
  fi

  local violations=""

  # --- B1: Tier-1 Core rules keep ALL-column ✓ --------------------------------
  local tier1 rule all_cell
  tier1="$(tier1_core_rules)"
  if [[ -z "${tier1}" ]]; then
    printf '[compliance-matrix-consistency] fail-open: Tier-1 Core list unparseable — advisory only\n' >&2
    return 0
  fi
  while IFS= read -r rule; do
    [[ -z "${rule}" ]] && continue
    all_cell="$(matrix_all_cell "${block}" "${rule}")"
    # ABSENT row = structural gap, surfaces via Layer A drift — not a flip.
    # EMPTY cell on a PRESENT row = the ✓ was silently removed → B1 violation.
    if [[ "${all_cell}" == "EMPTY" ]]; then
      violations+="B1: Tier-1 rule '${rule}' lost its ALL-column ✓ (cell is blank)"$'\n'
    fi
  done <<<"${tier1}"

  # --- B2: marker ↔ footnote 1:1 ---------------------------------------------
  # Cell markers: each FOOTNOTE_MARKERS glyph present anywhere in a table cell.
  # Footnote definitions: a `> MARKER ` blockquote line. Mismatch either way.
  local marker in_cells has_footnote
  while IFS= read -r marker; do
    [[ -z "${marker}" ]] && continue
    in_cells="no"
    if printf '%s\n' "${block}" | grep -qF -- "${marker}"; then
      in_cells="yes"
    fi
    has_footnote="no"
    # Footnote line form: `> <marker> <text>` (marker immediately after "> ").
    if grep -qE "^> ." "${MATRIX_FILE}" \
      && grep -E '^> .' "${MATRIX_FILE}" | grep -qF -- "> ${marker} "; then
      has_footnote="yes"
    fi
    if [[ "${in_cells}" == "yes" && "${has_footnote}" == "no" ]]; then
      violations+="B2: marker '${marker}' used in a cell but has no footnote definition"$'\n'
    elif [[ "${in_cells}" == "no" && "${has_footnote}" == "yes" ]]; then
      violations+="B2: marker '${marker}' has a footnote but is used in no cell"$'\n'
    fi
  done <<<"${FOOTNOTE_MARKERS}"

  # --- B3: every matrix column header is a legal legend scope ------------------
  local legend cols col
  legend="$(legend_scopes)"
  cols="$(matrix_header_scopes "${block}")"
  if [[ -z "${legend}" ]]; then
    printf '[compliance-matrix-consistency] fail-open: Scope Legend unparseable — advisory only\n' >&2
    return 0
  fi
  while IFS= read -r col; do
    [[ -z "${col}" ]] && continue
    if ! printf '%s\n' "${legend}" | grep -qxF -- "${col}"; then
      violations+="B3: matrix column '${col}' is not a Scope Legend scope"$'\n'
    fi
  done <<<"${cols}"

  # --- Verdict ----------------------------------------------------------------
  if [[ -n "${violations}" ]]; then
    printf '[compliance-matrix-consistency] CONFIRMED inconsistency:\n' >&2
    printf '%s' "${violations}" | sed '/^$/d; s/^/  - /' >&2
    return 2
  fi
  return 0
}

# Run Layer B; capture its exit so a confirmed inconsistency exits 2 AFTER
# Layer A's advisory banner still runs (audit completeness). Disabling set -e
# for this capture is INTENTIONAL — exit 2 is a return value to propagate, not
# an abort point; SC2310 flags the deliberate -e suppression under --enable=all.
layer_b_rc=0
# shellcheck disable=SC2310
if run_layer_b; then
  layer_b_rc=0
else
  layer_b_rc=$?
fi

# ==============================================================================
# Layer A — FILENAME-SET DRIFT (advisory; exit 0)
# ==============================================================================

if [[ ! -d "${RULES_DIR}" ]]; then
  printf '[compliance-matrix-drift] skipped: rules dir missing (%s)\n' "${RULES_DIR}"
  exit "${layer_b_rc}"
fi

# Extract declared rule filenames from the Compliance Matrix table.
# Table rows have the form: `| filename.md | ... |` (first column = filename).
# Using a structural awk parse rather than free-form grep avoids prose-noise
# false positives (e.g., `scope-meta.md` mentioned in narrative footnotes).
declared="$(
  awk -F'|' '/^\| [^|]+\.md \|/ {
    gsub(/^[ \t]+|[ \t]+$/, "", $2)
    print $2
  }' "${MATRIX_FILE}" | sort -u
)"

# Enumerate actual rule files. Glob expands to literal pattern when no match,
# so use find for stable behavior.
actual="$(
  find "${RULES_DIR}" -maxdepth 1 -type f -name '*.md' -exec basename {} \; 2>/dev/null \
    | sort -u
)"

# Symlinked entries (e.g. GLASS_ATRIUM_GLOBAL_RULES.md -> agents/GLASS_ATRIUM_GLOBAL_RULES.md) count as
# present; -type l catches them.
actual_links="$(
  find "${RULES_DIR}" -maxdepth 1 -type l -name '*.md' -exec basename {} \; 2>/dev/null \
    | sort -u
)"

if [[ -n "${actual_links}" ]]; then
  actual="$(printf '%s\n%s\n' "${actual}" "${actual_links}" | sort -u)"
fi

# Union relocated scoped-rules dir (Approach A diet) — these are still
# matrix-declared rules, just outside the rules/*.md autoload glob. Catch both
# real files and symlinks (the install farm materializes them as symlinks).
# Missing dir is benign (pre-diet install) — find emits nothing, no drift.
if [[ -d "${SCOPED_DIR}" ]]; then
  scoped_present="$(
    find "${SCOPED_DIR}" -maxdepth 1 \( -type f -o -type l \) -name '*.md' \
      -exec basename {} \; 2>/dev/null | sort -u
  )"
  if [[ -n "${scoped_present}" ]]; then
    actual="$(printf '%s\n%s\n' "${actual}" "${scoped_present}" | sort -u)"
  fi
fi

# Subtract documented exemptions from the actual list so they neither show up
# as undeclared nor get treated as missing-from-matrix.
exempt_sorted="$(printf '%s\n' "${EXEMPT_FILES}" | tr ',' '\n' | sed '/^$/d' | sort -u)"
actual="$(comm -23 <(printf '%s\n' "${actual}") <(printf '%s\n' "${exempt_sorted}"))"

# comm requires sorted input; both streams are already sorted via sort -u above.
declared_missing="$(comm -23 <(printf '%s\n' "${declared}") <(printf '%s\n' "${actual}"))"
undeclared_present="$(comm -13 <(printf '%s\n' "${declared}") <(printf '%s\n' "${actual}"))"

# Strip leading/trailing blank lines that comm may emit on empty input.
declared_missing="$(printf '%s' "${declared_missing}" | sed '/^$/d')"
undeclared_present="$(printf '%s' "${undeclared_present}" | sed '/^$/d')"

# Format list to comma-separated single line; "none" placeholder when empty.
format_list() {
  local raw="${1}"
  if [[ -z "${raw}" ]]; then
    printf '%s' 'none'
    return
  fi
  printf '%s' "${raw}" | tr '\n' ',' | sed 's/,$//; s/,/, /g'
}

if [[ -z "${declared_missing}" && -z "${undeclared_present}" ]]; then
  printf '[compliance-matrix-drift] OK\n'
  exit "${layer_b_rc}"
fi

# Capture formatted output into named vars so SC2312 (return-value masking)
# does not flag the printf-with-command-substitution pattern.
missing_fmt="$(format_list "${declared_missing}")"
present_fmt="$(format_list "${undeclared_present}")"
printf '[compliance-matrix-drift] declared-missing: %s | undeclared-present: %s\n' \
  "${missing_fmt}" "${present_fmt}"

exit "${layer_b_rc}"
