#!/usr/bin/env bash
# audit-inert-assert.sh — advisory census of bare `[[ ]]` assertions sitting mid-body in a Bats @test,
# where bash 3.2 exempts a failing `[[ ]]` from errexit so the test passes on the line after it.
# Usage: audit-inert-assert.sh [--path <file>]... [--root <dir>] [--quiet] [--advisory|--strict]
#
# Classification of each bare `[[ ]]` statement line (optionally `!`-negated, ending at `]]`):
#   - MID_BODY  at body depth 0 with a later statement in the body — the finding
#   - TERMINAL  the body's last statement — its status IS the test's status, so exempt
#   - NESTED    inside if/for/while/until/case or a `{ }` group — counted in nested=, never a finding,
#               because whether it is inert depends on the enclosing construct's own last command
# A `[[ ]] || ...` line ends past the bracket and is the guarded form, never classified.
#
# Quote spans are carried across lines: the lines of a multi-line `run bash -c '...'` string are data,
# not assertions. A body whose quote or heredoc state never resolves before the next @test or EOF is
# counted in unscanned= and contributes no finding, so the census never reads as a floor.
#
# Surface: ADVISORY on every path (scope_blocking=0); only `--strict` blocks. Exit codes are the
# shared contract of scripts/lib/audit-cli.sh. The baseline is read from a `--quiet` scope run, never
# quoted here. Convention SoT: agents/glass-atrium-dev-shell.md → Bats + test-run discipline.
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# shellcheck source=lib/audit-cli.sh
source "${SCRIPT_DIR}/lib/audit-cli.sh"
audit_cli_init 'audit-inert-assert.sh' 'directories' 0 10

# Explicit list, never a glob: test/ is walked here although audit-test-smells.sh does not walk it.
SCOPE_DIRS=(
  hooks/test
  scripts/test
  autoagent/test
  test
)
readonly SCOPE_DIRS

readonly RE_TEST_OPEN='^@test[[:space:]]+(.*[^[:space:]])[[:space:]]*\{[[:space:]]*$'
readonly RE_TEST_CLOSE='^\}[[:space:]]*$'
readonly RE_HEREDOC='<<(-?)[[:space:]]*["'"'"']?([A-Za-z_][A-Za-z0-9_]*)'
readonly RE_MARK='^([^'"'"'"#\\]*)(['"'"'"#\\])(.*)$'
readonly RE_DQ_CLOSE='^(([^"\\]|\\.)*)"(.*)$'
readonly RE_BARE='^(![[:space:]]+)?\[\[[[:space:]].*\]\][[:space:]]*;?$'

mid_body=0
nested=0
unscanned=0
tests_scanned=0

LINE_CODE=""
QUOTE_OPEN=""
QUOTE_REST=""
body_depth=0
body_nested=0
body_last=0
body_bare=()

# Closes the carried QUOTE_OPEN span within the given text; QUOTE_REST receives the text after it.
close_quote() {
  local rest="${1}"
  if [[ "${QUOTE_OPEN}" == "'" ]]; then
    [[ "${rest}" == *"'"* ]] || return 1
    QUOTE_REST="${rest#*\'}"
  else
    [[ "${rest}" =~ ${RE_DQ_CLOSE} ]] || return 1
    QUOTE_REST="${BASH_REMATCH[3]}"
  fi
  QUOTE_OPEN=""
}

# Sets LINE_CODE to the line with quoted spans blanked and any trailing comment dropped, carrying an
# unclosed quote into QUOTE_OPEN for the next line. A line closing a carried span starts with `_`.
scan_line() {
  local rest="${1}" code="" mark=""
  if [[ -n "${QUOTE_OPEN}" ]]; then
    # shellcheck disable=SC2310  # an unclosed span is the expected outcome on an inner string line
    close_quote "${rest}" || {
      LINE_CODE=""
      return 0
    }
    rest="${QUOTE_REST}"
    code="_"
  fi
  while [[ "${rest}" =~ ${RE_MARK} ]]; do
    code+="${BASH_REMATCH[1]}"
    mark="${BASH_REMATCH[2]}"
    rest="${BASH_REMATCH[3]}"
    case "${mark}" in
      \\)
        code+="\\${rest:0:1}"
        rest="${rest:1}"
        ;;
      '#')
        if [[ -z "${code}" || "${code}" =~ [[:space:]]$ ]]; then
          rest=""
          break
        fi
        code+='#'
        ;;
      *)
        QUOTE_OPEN="${mark}"
        code+=' '
        # shellcheck disable=SC2310  # an unclosed span carries into the next line
        close_quote "${rest}" || {
          rest=""
          break
        }
        rest="${QUOTE_REST}"
        ;;
    esac
  done
  LINE_CODE="${code}${rest}"
}

# Moves body_depth by the compound openers and closers among the code view's words.
update_depth() {
  local code="${1//;/ }" word=""
  local -a words=()
  IFS=$' \t' read -r -a words <<<"${code}"
  for word in ${words[@]+"${words[@]}"}; do
    case "${word}" in
      if | for | while | until | case | '{') body_depth=$((body_depth + 1)) ;;
      'fi' | 'done' | 'esac' | '}') ((body_depth == 0)) || body_depth=$((body_depth - 1)) ;;
      *) ;;
    esac
  done
}

# Records one body line: its statement position, a bare `[[ ]]` at its depth, then the depth change.
classify_line() {
  local lineno="${1}" code="${2}"
  code="${code#"${code%%[![:space:]]*}"}"
  code="${code%"${code##*[![:space:]]}"}"
  [[ -n "${code}" ]] || return 0
  body_last="${lineno}"
  if [[ "${code}" =~ ${RE_BARE} ]]; then
    if ((body_depth > 0)); then
      body_nested=$((body_nested + 1))
    else
      body_bare+=("${lineno}")
    fi
  fi
  update_depth "${code}"
}

open_body() {
  body_depth=0
  body_nested=0
  body_last=0
  body_bare=()
  QUOTE_OPEN=""
}

# Settles a closed body: every depth-0 bare line but the last statement is a finding.
close_body() {
  local rel="${1}" name="${2}" lineno="" text=""
  tests_scanned=$((tests_scanned + 1))
  nested=$((nested + body_nested))
  for lineno in ${body_bare[@]+"${body_bare[@]}"}; do
    ((lineno != body_last)) || continue
    mid_body=$((mid_body + 1))
    text="${AUDIT_CLI_LINES[lineno - 1]}"
    audit_cli_report MID_BODY "${rel}:${lineno}" "@test ${name} — ${text#"${text%%[![:space:]]*}"}"
  done
}

abandon_body() {
  local rel="${1}" name="${2}" lineno="${3}"
  unscanned=$((unscanned + 1))
  audit_cli_report UNSCANNED "${rel}:${lineno}" "@test ${name} — quote or heredoc state never resolved"
}

audit_file() {
  local rel="${1}" abs="${2}"
  local line="" trimmed="" probe="" idx=0
  local in_heredoc=0 heredoc_delim="" in_test=0 test_name="" test_line=0

  audit_cli_slurp "${abs}"
  for ((idx = 0; idx < AUDIT_CLI_LINE_COUNT; idx++)); do
    line="${AUDIT_CLI_LINES[idx]:-}"
    if ((in_heredoc == 1)); then
      trimmed="${line#"${line%%[![:space:]]*}"}"
      [[ "${trimmed}" != "${heredoc_delim}" ]] || in_heredoc=0
      continue
    fi
    if [[ "${line}" =~ ${RE_TEST_OPEN} && (${in_test} -eq 0 || -n "${QUOTE_OPEN}") ]]; then
      ((in_test == 0)) || abandon_body "${rel}" "${test_name}" "${test_line}"
      test_name="${BASH_REMATCH[1]}"
      test_name="${test_name%\"}"
      test_name="${test_name#\"}"
      test_line=$((idx + 1))
      in_test=1
      open_body
      continue
    fi
    if ((in_test == 1)) && [[ -z "${QUOTE_OPEN}" && "${line}" =~ ${RE_TEST_CLOSE} ]]; then
      close_body "${rel}" "${test_name}"
      in_test=0
      continue
    fi
    scan_line "${line}"
    if ((in_test == 1)); then
      classify_line "$((idx + 1))" "${LINE_CODE}"
    else
      QUOTE_OPEN=""
    fi
    # A `<<` inside a quoted span opens no heredoc, so detection reads the code view.
    probe="${LINE_CODE//<<</ }"
    if [[ "${probe}" =~ ${RE_HEREDOC} ]]; then
      heredoc_delim="${BASH_REMATCH[2]}"
      in_heredoc=1
    fi
  done
  ((in_test == 0)) || abandon_body "${rel}" "${test_name}" "${test_line}"
}

main() {
  local target="" abs="" dir="" fail_msg=""
  local -a found=()

  audit_cli_parse_args "$@"
  audit_cli_resolve_root "${SCRIPT_DIR}/.."

  if ((${#paths[@]} > 0)); then
    audit_cli_walk_paths
  else
    for dir in "${SCOPE_DIRS[@]}"; do
      abs="${root_dir}/${dir}"
      if [[ ! -d "${abs}" || ! -r "${abs}" ]]; then
        printf 'ERROR: scope directory missing or unreadable: %s\n' "${abs}" >&2
        exit 3
      fi
      found=()
      # shellcheck disable=SC2312  # the scope dir proved readable above; the sort cannot fail
      while IFS= read -r target; do
        found+=("${target}")
      done < <(find "${abs}" -type f -name '*.bats' | LC_ALL=C sort)
      for target in ${found[@]+"${found[@]}"}; do
        audit_file "${dir}/${target#"${abs}/"}" "${target}"
      done
    done
  fi

  printf 'mid_body=%d nested=%d unscanned=%d tests_scanned=%d\n' \
    "${mid_body}" "${nested}" "${unscanned}" "${tests_scanned}"
  printf -v fail_msg 'FAIL: %d mid-body bare [[ ]] assertion(s) in the audited surface' "${mid_body}"
  audit_cli_finish "${blocking}" "${mid_body}" "${fail_msg}"
}

main "$@"
