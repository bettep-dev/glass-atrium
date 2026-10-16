#!/usr/bin/env bash
# audit-pipe-drain.sh — audit of pipe readers that can stop before EOF in the hooks/ shell files
# Usage: audit-pipe-drain.sh [--path <file>]... [--root <dir>] [--quiet] [--advisory|--strict]
#
# Why: under `set -Eeuo pipefail` a reader that exits early (grep -q, grep -m, head, awk exit) leaves its writer to
# die of SIGPIPE above the 64 KiB pipe capacity, and the pipe then reports 141 instead of the reader's verdict.
#
# Behavior:
#   1. Walk the shell files under hooks/ (libraries included, hooks/test/ excluded), or the --path overrides
#   2. Join each logical line (a trailing backslash, a trailing pipe or a still-open single quote continues
#      it); skip comments, heredoc bodies and quoted text, where quotes nest inside `$( )` and backticks
#   3. At every pipe stage, find a reader that can stop before EOF: grep with -q/-m (or --quiet,
#      --silent, --max-count), head, awk whose quoted program text holds the word `exit`, or a helper in
#      READER_HELPERS
#   4. Count the reader drained when drain_after wraps it (hooks/lib/pipe-drain.sh), discarded when the
#      list operator right after its pipeline, or after a subshell closing it, is `|| true` / `|| :` (never
#      one past the close of a `$( )`, backtick, `<( )` or `>( )` substitution holding the pipeline); report
#      every other one UNDRAINED
#
# Surface split: a default scope run BLOCKS, while a `--path` run stays ADVISORY; `--strict` blocks on a
# `--path` run and `--advisory` reports without failing anywhere.
#
# Exit codes (the shared set of scripts/lib/audit-cli.sh):
#   0 = audit completed with no blocking findings (or an advisory-surface run)
#   1 = blocking run reporting an UNDRAINED site
#   2 = usage error
#   3 = IO/scope error (the hooks tree or a --path target is missing or unreadable)
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# shellcheck source-path=SCRIPTDIR source=lib/audit-cli.sh
source "${SCRIPT_DIR}/lib/audit-cli.sh"
audit_cli_init 'audit-pipe-drain.sh' 'directories' 1 10

readonly SCOPE_DIR=hooks
readonly EXCLUDED_PREFIX=hooks/test/
# Functions whose body ends in an early-exit reader of their stdin, so a pipe into them races the same way.
READER_HELPERS=(scope_decl_select)
readonly READER_HELPERS

readonly RE_COMMENT='^[[:space:]]*#'
readonly RE_SHEBANG='^#!.*[/[:space:]](ba|da|k)?sh([[:space:]]|$)'
readonly RE_PREFILTER='(grep|head|awk|scope_decl_select)'
readonly RE_HEREDOC="(^|[^<])<<-?[[:space:]]*[\\\\\"']?([A-Za-z_][A-Za-z0-9_]*)"
readonly RE_EXIT_WORD='(^|[^[:alnum:]_])exit([^[:alnum:]_]|$)'
# An or-list operator, swapped out before the split on single pipes (\x01 is bash's internal quote marker).
readonly OR_MARK=$'\x1e'
# The close of a `$( )`, `<( )`, `>( )` or backtick substitution, told apart from a subshell's `)` before the stage split.
readonly SUB_MARK=$'\x1d'
# Stands in for quoted text holding the word `exit` — an awk program that can stop before EOF.
readonly EXIT_MARK=$'\x1c'
readonly RE_DISCARD='^[[:space:]]*(true|:)([^[:alnum:]_]|$)'

drained=0
discarded=0
undrained=0
heredoc_end=""
in_squote=0
logical_text=""
logical_start=0
logical_extra=0
code_text=""
is_code_current=0

audit_tree() {
  local abs="${root_dir}/${SCOPE_DIR}" found="" sorted="" file="" rel=""
  if [[ ! -d "${abs}" || ! -r "${abs}" ]] || ! found="$(find "${abs}" -type f)"; then
    printf 'ERROR: scope directory missing or unwalkable: %s\n' "${abs}" >&2
    exit 3
  fi
  [[ -n "${found}" ]] || return 0
  sorted="$(LC_ALL=C sort <<<"${found}")"
  while IFS= read -r file; do
    rel="${file#"${root_dir}/"}"
    # shellcheck disable=SC2310  # predicate of tests and expansions only — nothing for errexit to catch
    if [[ "${rel}" == "${EXCLUDED_PREFIX}"* ]] || ! is_shell_file "${file}"; then
      continue
    fi
    audit_file "${rel}" "${file}"
  done <<<"${sorted}"
}

# A shell extension, or an extensionless sh-family shebang — the selection scripts/audit-rm.sh uses.
is_shell_file() {
  local file="${1}" first=""
  case "${file##*/}" in
    *.sh | *.bash | *.bats) return 0 ;;
    *.*) return 1 ;;
    *) ;;
  esac
  first="$(head -n 1 -- "${file}" | LC_ALL=C tr -d '\000')"
  [[ "${first}" =~ ${RE_SHEBANG} ]]
}

audit_file() {
  local rel="${1}" abs="${2}" idx=0 line=""
  if ! grep -q -E "${RE_PREFILTER}" -- "${abs}"; then
    [[ -r "${abs}" ]] || {
      printf 'ERROR: cannot read %s\n' "${abs}" >&2
      exit 3
    }
    return 0
  fi
  audit_cli_slurp "${abs}"
  heredoc_end=""
  while ((idx < AUDIT_CLI_LINE_COUNT)); do
    line="${AUDIT_CLI_LINES[idx]:-}"
    idx=$((idx + 1))
    # shellcheck disable=SC2310  # predicate of tests and expansions only — nothing for errexit to catch
    if ! take_code_line "${line}"; then
      continue
    fi
    join_logical_line "${idx}"
    idx="${logical_start}"
    audit_logical_line "${rel}" "$((idx - logical_extra))"
  done
}

# Sets logical_text to the line; 1 when the whole line is comment or heredoc text.
take_code_line() {
  local line="${1}" trimmed=""
  if [[ -n "${heredoc_end}" ]]; then
    trimmed="${line#"${line%%[!$'\t']*}"}"
    [[ "${trimmed}" == "${heredoc_end}" ]] && heredoc_end=""
    return 1
  fi
  [[ ! "${line}" =~ ${RE_COMMENT} ]] || return 1
  logical_text="${line}"
}

# Appends continuation lines to logical_text, from line index $1: after a trailing backslash or pipe, or while
# a single-quoted span is still open, so a program over several lines reads with its command.
join_logical_line() {
  local idx="${1}" next="" should_strip=1
  logical_extra=0
  is_code_current=0
  while ((idx < AUDIT_CLI_LINE_COUNT)); do
    next="${AUDIT_CLI_LINES[idx]:-}"
    # shellcheck disable=SC2310  # predicate of tests and expansions only — nothing for errexit to catch
    if is_continued "${logical_text}"; then
      logical_text="${logical_text%\\} ${next}"
      should_strip=1
    else
      # Only a quote can open or close a span → a line without one keeps the last verdict (linear, not quadratic).
      if ((should_strip == 1)); then
        [[ "${logical_text}" == *\'* ]] || break
        strip_quotes "${logical_text}"
        is_code_current=1
      fi
      ((in_squote == 1)) || break
      is_code_current=0
      logical_text="${logical_text}"$'\n'"${next}"
      should_strip=0
      [[ "${next}" != *\'* ]] || should_strip=1
    fi
    idx=$((idx + 1))
    logical_extra=$((logical_extra + 1))
  done
  logical_start="${idx}"
}

is_continued() {
  local text="${1%"${1##*[![:space:]]}"}"
  [[ "${text}" == *\\ || ("${text}" == *\| && "${text}" != *\|\|) ]]
}

# Strips quoted text and comments from logical_text, then audits every pipe stage left in it.
audit_logical_line() {
  local rel="${1}" lineno="${2}" text="${logical_text}" rest="" stage=""
  ((is_code_current == 1)) || strip_quotes "${text}"
  # A `<<` left in the code part opens a heredoc; its word is read from the raw text, where quotes still name it.
  if [[ "${code_text}" == *'<<'* && "${text}" =~ ${RE_HEREDOC} ]]; then
    heredoc_end="${BASH_REMATCH[2]}"
  fi
  [[ "${code_text}" != *'|'* ]] || mark_substitution_closes
  text="${code_text//||/${OR_MARK}}"
  text="${text//>|/>}"
  rest="${text#*|}"
  while [[ "${rest}" != "${text}" ]]; do
    text="${rest}"
    stage="${text#&}"
    stage="${stage%%[|;&)\`"${OR_MARK}${SUB_MARK}"]*}"
    audit_stage "${rel}:${lineno}" "${stage}" "${text}"
    rest="${text#*|}"
  done
}

# Sets code_text to $1 with quoted text replaced by Q (EXIT_MARK when it holds the word `exit`) and comments
# dropped. Contexts stack — d = double quotes, p = `$( )` or a subshell, b = backticks — so the code of a
# substitution inside double quotes stays code. An unclosed single quote ends the code and sets in_squote.
strip_quotes() {
  local rest="${1}" pre="" char="" body="" stack="" top=""
  rest="${rest//\\\\/E}"
  rest="${rest//\\\"/E}"
  rest="${rest//\\\'/E}"
  rest="${rest//\\\`/E}"
  rest="${rest//\\\$/E}"
  code_text=""
  in_squote=0
  while [[ -n "${rest}" ]]; do
    top="${stack: -1}"
    if [[ "${top}" == d ]]; then
      pre="${rest%%[\"\`\$]*}"
      [[ ! "${pre}" =~ ${RE_EXIT_WORD} ]] || code_text="${code_text}${EXIT_MARK}"
    else
      pre="${rest%%[\'\"\`()#]*}"
      code_text="${code_text}${pre}"
    fi
    [[ "${pre}" != "${rest}" ]] || return 0
    char="${rest:${#pre}:1}"
    rest="${rest:${#pre}+1}"
    case "${top}${char}" in
      d\") stack="${stack%?}" ;;
      d\$)
        [[ "${rest}" == \(* ]] || continue
        rest="${rest#\(}" code_text="${code_text}\$(" stack="${stack}p"
        ;;
      *\')
        if [[ "${rest}" != *\'* ]]; then
          in_squote=1
          return 0
        fi
        body="${rest%%\'*}" rest="${rest#*\'}" char=Q
        [[ ! "${body}" =~ ${RE_EXIT_WORD} ]] || char="${EXIT_MARK}"
        code_text="${code_text}${char}"
        ;;
      *\") code_text="${code_text}Q" stack="${stack}d" ;;
      b\`) code_text="${code_text}\`" stack="${stack%?}" ;;
      *\`) code_text="${code_text}\`" stack="${stack}b" ;;
      *\() code_text="${code_text}(" stack="${stack}p" ;;
      p\)) code_text="${code_text})" stack="${stack%?}" ;;
      *\#)
        # A word-initial `#` opens a comment to the line end; `${#x}`, `$#` and `${x#y}` stay code.
        if [[ -n "${code_text}" && "${code_text}" != *[[:space:]] ]]; then
          code_text="${code_text}#"
        elif [[ "${rest}" == *$'\n'* ]]; then
          rest="${rest#*$'\n'}" code_text="${code_text}"$'\n'
        else
          return 0
        fi
        ;;
      *) code_text="${code_text}${char}" ;;
    esac
  done
}

# Rewrites code_text so each substitution close reads as SUB_MARK; a subshell's `)` and an opening backtick stay.
mark_substitution_closes() {
  local rest="${code_text}" out="" stack="" pre="" char=""
  while [[ "${rest}" == *[\(\)\`]* ]]; do
    pre="${rest%%[()\`]*}"
    char="${rest:${#pre}:1}"
    rest="${rest:${#pre}+1}"
    # stack letters: s = `$(` / `<(` / `>(` substitution, b = backtick substitution, p = subshell
    case "${char}${stack: -1}" in
      ')s' | '`b') char="${SUB_MARK}" stack="${stack%?}" ;;
      ')'*) stack="${stack%?}" ;;
      '`'*) stack="${stack}b" ;;
      *)
        stack="${stack}p"
        [[ "${pre}" != *[\$\<\>] ]] || stack="${stack%p}s"
        ;;
    esac
    out="${out}${pre}${char}"
  done
  code_text="${out}${rest}"
}

# Classifies one pipe stage; $3 is the line text from this stage on, for the discard check.
audit_stage() {
  local location="${1}" stage="${2}" tail="${3}" words=() wrapped=0
  IFS=$' \t' read -r -a words <<<"${stage}"
  ((${#words[@]} > 0)) || return 0
  if [[ "${words[0]}" == drain_after ]]; then
    wrapped=1
    # unset + repack, not a "${words[@]:1}" slice: bash 3.2 joins a slice into one word under a non-space IFS
    unset 'words[0]'
    words=("${words[@]}")
  fi
  # shellcheck disable=SC2310  # predicate of tests and expansions only — nothing for errexit to catch
  if ((${#words[@]} == 0)) || ! is_early_reader "${words[@]}"; then
    return 0
  fi
  # shellcheck disable=SC2310  # predicate of tests and expansions only — nothing for errexit to catch
  if ((wrapped == 1)); then
    drained=$((drained + 1))
  elif is_status_discarded "${tail}"; then
    discarded=$((discarded + 1))
  else
    undrained=$((undrained + 1))
    audit_cli_report UNDRAINED "${location}" "${stage//${EXIT_MARK}/Q}"
  fi
}

# 0 when the first list operator after the pipeline in $1 is `|| true` / `|| :` — a later one guards another command.
is_status_discarded() {
  local tail="${1}" pre="" char="" depth=0
  tail="${tail//|&/|}"
  tail="${tail//>&/>}"
  tail="${tail//<&/<}"
  tail="${tail//&>/>}"
  # `;` / `&` end the list (a then / do word always follows one or a line end). A subshell's `)`, and a
  # substitution both opened and closed in the tail, hand the pipeline's status out, so the search goes on past
  # them; the close of a substitution holding the pipeline does not — errtrace fires the ERR trap inside it first.
  while :; do
    pre="${tail%%[;&\$<>\`"${SUB_MARK}${OR_MARK}"]*}"
    [[ "${pre}" != "${tail}" ]] || return 1
    char="${tail:${#pre}:1}"
    tail="${tail:${#pre}+1}"
    case "${char}" in
      "${OR_MARK}") ((depth > 0)) || break ;;
      ';' | '&') ((depth > 0)) || return 1 ;;
      "${SUB_MARK}") ((depth-- > 0)) || return 1 ;;
      '`') depth=$((depth + 1)) ;;
      *) [[ "${tail}" != \(* ]] || depth=$((depth + 1)) ;;
    esac
  done
  [[ "${tail}" =~ ${RE_DISCARD} ]]
}

# 0 when the command words name a reader that can stop before EOF.
is_early_reader() {
  local cmd="${1}" word=""
  shift
  case "${cmd}" in
    head) return 0 ;;
    awk | gawk | mawk | nawk)
      [[ "$*" == *"${EXIT_MARK}"* ]]
      return
      ;;
    grep | egrep | fgrep) ;;
    *)
      is_listed "${cmd}" "${READER_HELPERS[@]}"
      return
      ;;
  esac
  for word in "$@"; do
    case "${word}" in
      --) return 1 ;;
      --quiet | --silent | --max-count*) return 0 ;;
      --*) ;;
      -*[qm]*) return 0 ;;
      *) ;;
    esac
  done
  return 1
}

# 0 when $1 equals one of the remaining arguments.
is_listed() {
  local needle="${1}" item=""
  shift
  for item in "$@"; do
    [[ "${item}" != "${needle}" ]] || return 0
  done
  return 1
}

main() {
  local fail_msg=""

  audit_cli_parse_args "$@"
  audit_cli_resolve_root "${SCRIPT_DIR}/.."

  if ((${#paths[@]} > 0)); then
    audit_cli_walk_paths
  else
    audit_tree
  fi

  printf 'drained=%d discarded=%d undrained=%d\n' "${drained}" "${discarded}" "${undrained}"

  printf -v fail_msg 'FAIL: %d undrained early-exit pipe reader(s) in the audited surface' "${undrained}"
  audit_cli_finish "${blocking}" "${undrained}" "${fail_msg}"
}

main "$@"
