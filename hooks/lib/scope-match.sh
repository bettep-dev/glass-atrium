#!/usr/bin/env bash
# scope-match.sh — the single allowed-path comparison predicate plus the `[SCOPE]` delegation-
# declaration parsers. Extracted from validate-scope-drift.sh so the drift advisory (PreToolUse)
# and the recorder's scope-excess leg (SubagentStop) compare against ONE predicate; a second
# implementation would reproduce the drift-class this consolidation exists to remove.
# Bash 3.2+ (macOS stock).
#
# match_file_against_allowed — path vs newline list (full/partial path OR basename).
# scope_task_type_is_code    — the code task_type set of the files: comparison leg.
# scope_decl_files           — `[SCOPE] files=` field → newline list.
# scope_decl_select          — first line-opening `[SCOPE] files=` declaration of a text; the ONE
#                              selector of every reader (drift advisory, recorder, verification gate).
# scope_decl_from_record0    — that declaration, read from a subagent transcript's record 0.
# extract_target_files_section / extract_target_files_heading — a plan's Target Files list (html
#                              section / md heading) → newline list; the drift advisory and the
#                              delegation gate read plans through this one pair.

# shellcheck disable=SC2317  # source-context-unaware false positive on this double-source guard
if [[ -n "${_SCOPE_MATCH_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _SCOPE_MATCH_LOADED=1

if [[ -r "${BASH_SOURCE[0]%/*}/pipe-drain.sh" ]]; then
  # shellcheck source-path=SCRIPTDIR source=pipe-drain.sh
  source "${BASH_SOURCE[0]%/*}/pipe-drain.sh"
else
  # Library missing or unreadable → the same drain_after in place, so the readers keep their verdict.
  # A test, not a failed source: bash 3.2 exits on a missing sourced file even inside a condition.
  drain_after() {
    local rc=0
    "$@" || rc=$?
    cat >/dev/null || true
    return "${rc}"
  }
fi

# Matcher locals holding a payload path or list: an inherited export would carry them into every child's environment, capped per string on Linux.
export -n file_path allowed_files line clean

# Match file_path against the target-file list (newline-separated): full/partial path OR basename.
# Strips markdown list prefixes (- * N.), backticks, whitespace. Deliberately LENIENT — on an
# advisory surface a false silence costs less than a false accusation.
# Args: $1=file_path  $2=allowed_files. Returns: 0 = match, 1 = no match.
match_file_against_allowed() {
  local file_path="${1}" allowed_files="${2}"
  local file_basename line clean clean_basename
  file_basename="$(basename "${file_path}")"

  while IFS= read -r line; do
    [[ "${line}" =~ ^[[:space:]]*$ ]] && continue

    clean="$(echo "${line}" | sed -e 's/^[[:space:]]*[-*][[:space:]]*//' -e 's/^[[:space:]]*[0-9]*\.[[:space:]]*//')"
    clean="$(echo "${clean}" | tr -d '`')"
    clean="$(echo "${clean}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

    [[ -z "${clean}" ]] && continue

    if [[ "${file_path}" == *"${clean}"* ]]; then
      return 0
    fi

    clean_basename="$(basename "${clean}")"
    if [[ "${file_basename}" == "${clean_basename}" ]]; then
      return 0
    fi
  done <<<"${allowed_files}"

  return 1
}

# The code task_type set the recorder's files: comparison leg is restricted to. A THIRD set,
# deliberately distinct from both the grader hard-bar pair (bug-fix|feature) and the DEV role
# allowlist: a non-code row routinely lists READ paths in files:, so comparing them would fire
# on ~a fifth of review rows. Named once here — an inline case would be the duplication this
# lib exists to prevent.
# Args: $1=task_type. Returns: 0 = code task_type, 1 = otherwise.
scope_task_type_is_code() {
  case "${1:-}" in
    bug-fix | feature | refactor | cleanup) return 0 ;;
    *) return 1 ;;
  esac
}

# `[SCOPE] files=a, b, c · deliverable=…` → one path per line. The field ends at the next ` · `
# separator, a `|` separator or end of line; empty output on any other shape (fail-open — the
# callers skip the comparison entirely rather than compare against a mis-parsed list).
#
# The opening `files=` is bound to the FIRST occurrence that STARTS a field — at the start of the
# line, or preceded by whitespace or `·`. An unanchored, greedy bind (`s/.*files=//`) rebound to a
# LATER occurrence and replaced the declared list wholesale: `out=legacy files=none` re-read the
# list as `none`, and the mid-word `profiles=data` re-read it as `data`. Either way the declared
# path stopped matching and the caller fired a FALSE excess — the one outcome this parser's
# leniency exists to rule out.
#
# Entries split on commas AND whitespace, because the separator-less form
# (`files=a.sh deliverable=fix out=none`) used to parse as ONE entry whose basename was `out=none`:
# the correctly-declared path then missed and the caller fired a FALSE excess — an advisory
# accusing compliant work, the worst outcome available to it. Two refusals keep that mis-parse from
# becoming an accusation again, at different granularity because they mean different things:
#   - an `=`-bearing TOKEN whose KEY (the text before its first `=`) is one of the grammar's own
#     three field names — matched case-insensitively, exactly as the opening bind above accepts
#     `[Ff]iles=`; a drop vocabulary narrower than the bind would let the two halves of this parser
#     disagree about what a field name IS, and `OUT=none legacy` would leak `legacy` into the list
#     ⇒ a sibling field swallowed by a missing separator ⇒ that token alone is
#     dropped. The vocabulary is CLOSED rather than shape-based on purpose: dropping every
#     `=`-bearing token also dropped a genuine declared path (`docs/a=b.md`), and an edit to it
#     then read as excess — a false accusation, the one cost this parser refuses. An unknown key
#     is therefore kept as a path; if it really was a field, the lenient matcher merely swallows
#     something, which is silence — the direction this module is allowed to fail in;
#   - a token carrying neither `/` nor `.` AFTER such a token ⇒ prose from that same swallowed field
#     ⇒ dropped too. Dropping the `=` token alone left the rest of its prose in the list, where the
#     lenient matcher below swallowed any path containing it: plan 3631 §7's literal
#     `out=인접 helper, …` hid an edit to hooks/lib/helper.sh. The gate on a PRECEDING `=` token is
#     what keeps an extensionless declared path (`Makefile`) safe — it sits in the files= list
#     itself, ahead of any sibling field. Truncating the whole remainder instead would drop
#     path-shaped tokens too, flipping silence into a false accusation;
#   - an angle bracket on a token that SURVIVES those drops ⇒ the file list itself is an
#     uninstantiated `<placeholder>` ⇒ the whole list is refused (empty output, callers skip).
# Consequence, accepted: a declared path containing a space cannot be expressed, and a prose word
# that happens to carry a dot still matches loosely — both cost SILENCE, never a false accusation.
# Args: $1=[SCOPE] line. Prints the list (possibly empty), always returns 0.
scope_decl_files() {
  local line="${1:-}" field entry key kept="" seen_field_token=0
  local scan="${line}" pre rest first=1 found=0
  # Leftmost `files=` that starts a field. `%%pat*` leaves the prefix before the FIRST occurrence
  # and `#*pat` the text after it, so the pair walks occurrences left to right.
  while [[ "${scan}" == *[Ff]iles=* ]]; do
    pre="${scan%%[Ff]iles=*}"
    rest="${scan#*[Ff]iles=}"
    if [[ "${pre}" == *[[:space:]] ]] || [[ "${pre}" == *"·" ]] \
      || { [[ -z "${pre}" ]] && [[ "${first}" -eq 1 ]]; }; then
      found=1
      break
    fi
    first=0
    scan="${rest}"
  done
  [[ "${found}" -eq 1 ]] || return 0
  field="${rest%%·*}"
  field="${field%%|*}"
  # The selector's two value-wrap characters — a value wrap never belongs to a path.
  field="${field//\`/}"
  field="${field//\*\*/}"
  [[ -z "${field}" ]] && return 0
  # Commas and tabs collapse into the space delimiter, so one expansion splits every accepted form.
  field="${field//,/ }"
  field="${field//$'\t'/ }"
  while IFS= read -r entry; do
    [[ -n "${entry}" ]] || continue
    if [[ "${entry}" == *=* ]]; then
      key="${entry%%=*}"
      # Only the grammar's OWN three keys mark a swallowed sibling field. Anything else carrying
      # an `=` is treated as a declared path and kept.
      case "${key}" in
        [Ff][Ii][Ll][Ee][Ss] | [Dd][Ee][Ll][Ii][Vv][Ee][Rr][Aa][Bb][Ll][Ee] | [Oo][Uu][Tt])
          seen_field_token=1
          continue
          ;;
        *) ;;
      esac
    fi
    case "${entry}" in
      *'<'* | *'>'*) return 0 ;;
      *) ;;
    esac
    # Past the first `=` token the grammar (files= deliverable= out=) puts us inside a sibling
    # field, so a token with no `/` and no `.` there is prose rather than a path.
    if [[ "${seen_field_token}" -eq 1 ]]; then
      case "${entry}" in
        */* | *.*) ;;
        *) continue ;;
      esac
    fi
    kept="${kept}${entry}"$'\n'
  done <<<"${field// /$'\n'}"
  printf '%s' "${kept}"
}

# A companion test file of a declared path is not excess: delegation-size discipline makes the
# test travel with the implementation, so `[SCOPE] files=hooks/X.sh` licenses hooks/test/X.bats.
# Matched on the stem, and only under a test/ tests/ __tests__/ segment.
# Args: $1=path  $2=allowed_files. Returns: 0 = companion test of a declared path.
scope_path_is_test_sibling() {
  local path="${1:-}" allowed_files="${2:-}" stem line declared_stem
  case "/${path}" in
    */test/* | */tests/* | */__tests__/*) ;;
    *) return 1 ;;
  esac
  stem="$(basename "${path}")"
  stem="${stem%%.*}"
  [[ -n "${stem}" ]] || return 1
  while IFS= read -r line; do
    line="${line//\`/}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -n "${line}" ]] || continue
    declared_stem="$(basename "${line}")"
    declared_stem="${declared_stem%%.*}"
    [[ "${stem}" == "${declared_stem}" ]] && return 0
  done <<<"${allowed_files}"
  return 1
}

# Standing-rule vocabulary — CLOSED on purpose. The exemption below reads the agent's own
# concerns field, so an open prose match would let any excess write its own permission slip;
# a closed vocabulary keeps the surface to the standing rules that genuinely force a side edit.
readonly SCOPE_STANDING_RULE_PHRASES='0-consumer export
unused export
stale comment
false comment
comment-logging
manifest regeneration
shellcheck
GA-ABSORB
absorption annotation'

# Standing-rule exemption. DISCLOSURE-GATED, NOT verification-gated: `concerns` is authored by the
# same agent inside the same [COMPLETION] block, so this exemption trusts a self-declaration —
# it is weaker than the artifact and test-sibling exemptions and must never be read as their equal.
# Two guards keep the surface small: a closed-vocabulary phrase must appear, AND the path (or its
# basename) must be named — a blanket sentence exempts nothing.
# Args: $1=path  $2=concerns text. Returns: 0 = exempt.
scope_concerns_exempts_path() {
  local path="${1:-}" concerns="${2:-}" phrase matched=1
  [[ -n "${path}" ]] && [[ -n "${concerns}" ]] || return 1
  while IFS= read -r phrase; do
    [[ -n "${phrase}" ]] || continue
    if printf '%s' "${concerns}" | drain_after grep -qiF -- "${phrase}"; then
      matched=0
      break
    fi
  done <<<"${SCOPE_STANDING_RULE_PHRASES}"
  [[ "${matched}" -eq 0 ]] || return 1
  printf '%s' "${concerns}" | drain_after grep -qF -- "${path}" && return 0
  printf '%s' "${concerns}" | drain_after grep -qF -- "$(basename "${path}")" && return 0
  return 1
}

# A declaration is a line the bare `[SCOPE]` token OPENS: optional indentation and one list marker,
# then the token and a `files=` value that is neither empty nor a `<placeholder>`; any text may follow
# the value, and the value alone may sit in backticks or `**`.
# A substring match would select quoted `[SCOPE]` text (a verdict, a rule excerpt) ahead of the
# real line → a wrong list (false excess) or an empty one (the real declaration never read).
# Purely syntactic on purpose — no reader re-implements the field parser to choose a line.
# Shapes that fail OPEN (no declaration → comparison skipped, never a false excess):
#   - the token mid-line (`Implement it. [SCOPE] files=…`) or behind a label (`Scope: [SCOPE] …`);
#   - a block-quoted line (`> [SCOPE] files=…`, `> - [SCOPE] files=…`);
#   - any line-opening wrap — a wrapped token (`` `[SCOPE]` `` / `**[SCOPE]**`), or a backtick or
#     `**` opened before the token;
#   - a space after `files=`, or a field order not opening with `files=`;
#   - recorder only: a declaration ending past its 2000-char emit transport, dropped whole.
# Not closed — a quoted line still selected, winning over a later real declaration (first wins):
#   - a relayed declaration opening its own line in the bare form — relaying by block-quote is the fix.
readonly _SCOPE_DECL_OPEN='^[[:space:]]*(([-*+]|[0-9]+[.)])[[:space:]]+)?'
# shellcheck disable=SC2016  # the backtick is a literal wrap character, not an expansion.
readonly _SCOPE_DECL_BARE_FORM='[[]SCOPE[]][[:space:]]+[Ff]iles=(`|[*][*])?[^<[:space:]`*]'
readonly SCOPE_DECL_LINE_RE="${_SCOPE_DECL_OPEN}${_SCOPE_DECL_BARE_FORM}"

# Stdin text → its first declaration line.
# Returns: 0 = line printed, or none found (empty output) · 2 = the text could not be read (grep
# status 2 or higher): empty output plus a reason on stderr. Each caller handles 2 itself — an
# unread declaration is not an absent one.
scope_decl_select() {
  local rc=0
  grep -m 1 -E -- "${SCOPE_DECL_LINE_RE}" 2>/dev/null || rc=$?
  [[ "${rc}" -le 1 ]] && return 0
  (printf 'scope_decl_select: grep status %s, [SCOPE] declaration not read\n' "${rc}") >&2 || true
  return 2
}

# The first declaration in a subagent transcript's record 0 — the parent-authored delegation
# prompt. Pinned to record 0 on purpose: a whole-transcript grep would let the child emit a wider
# `[SCOPE]` line of its own and nullify the very check that exists to sit outside its control.
# Two or more declarations inside record 0 → the first wins (deterministic, never merged).
# Args: $1=transcript path. Prints the line (empty when absent/unreadable). Returns the pipeline
# status, so scope_decl_select's 2 reaches the caller.
scope_decl_from_record0() {
  local tpath="${1:-}"
  [[ -r "${tpath}" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  # shellcheck disable=SC2312  # a failed head/jq stage → empty text + its nonzero status, reported as unread.
  head -n 1 "${tpath}" \
    | jq -r 'if (.message.content | type) == "string" then .message.content
             elif (.message.content | type) == "array" then ([.message.content[]? | .text? // ""] | join("\n"))
             else "" end' 2>/dev/null \
    | drain_after scope_decl_select
}

# Extract path-like tokens from the `<section id="target-files">` slice → newline list.
# Relies on the T1 flat-leaf contract (slices to the first </section>). sed-only (no awk).
# P1 nesting guard: a nested opening <section> in the slice violates the leaf contract → a
# truncated list could mis-fire SCOPE-070, so emit empty (fail-open, no guessing).
# Args: $1=html body. Prints cleaned list to stdout (empty on parse anomaly · always return 0).
extract_target_files_section() {
  local body="${1}"
  # Flatten to one line, then slice between opening tag and first </section>.
  local flattened from_open sliced
  flattened="$(printf '%s' "${body}" | tr '\n' ' ')"

  # After the opening tag (close not yet applied) — source for the nesting guard.
  from_open="$(printf '%s' "${flattened}" \
    | sed -n 's/.*<section[^>]*id="target-files"[^>]*>\(.*\)/\1/p')"
  [[ -z "${from_open}" ]] && return 0

  sliced="$(printf '%s' "${from_open}" | sed 's/<\/section>.*//')"
  [[ -z "${sliced}" ]] && return 0

  # P1 guard: nested opening <section> → leaf violation → fail-open.
  # shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
  if printf '%s' "${sliced}" | drain_after grep -q '<section[^>]*>'; then
    return 0
  fi

  # <li>/<br> → newlines (one item per line), then strip remaining tags + decode entities.
  # shellcheck disable=SC2312  # a failed stage yields an empty list, which every caller reads as absent
  printf '%s' "${sliced}" \
    | sed 's/<li[^>]*>/\n/g; s/<\/li>/\n/g; s/<br[^>]*>/\n/g' \
    | sed 's/<[^>]*>//g' \
    | sed 's/&amp;/\&/g; s/&lt;/</g; s/&gt;/>/g'
}

# Extract the md `## Target Files` list, up to the next `## ` heading (case-insensitive initials,
# English-only). One definition for the PLAN_FILE leg and the monitor leg's md plans.
# Args: $1=md body. Prints the list to stdout (empty when the heading is absent).
extract_target_files_heading() {
  local heading_re='^##[[:space:]]+[Tt]arget [Ff]iles'
  printf '%s\n' "${1}" | sed -E -n "/${heading_re}/,/^## /{ /${heading_re}/d; /^## /d; p; }"
}
