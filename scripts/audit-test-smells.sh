#!/usr/bin/env bash
# audit-test-smells.sh — advisory audit of three mechanically-detectable Bats test smells, plus two
# advisory naming counts over Bats and TS tests
# Usage: audit-test-smells.sh [--path <file>]... [--root <dir>] [--quiet] [--advisory|--strict]
#
# Behavior:
#   1. Walk the in-script SCOPE_DIRS list (its single source of truth) or the --path overrides
#   2. Split each Bats file into @test bodies with a heredoc-aware extractor
#   3. Report signal (a) — a body whose last non-exempt `run` result is never inspected
#   4. Report signal (b) — a comparison whose two operands are the same literal or variable token
#   5. Report signal (c) — a count pin: an assertion comparing a non-zero integer literal against a
#      value the SAME assertion derives by counting the tree or a source file
#   6. Count id_title and incident_header over Bats and TS files (method below)
#   7. Emit per-finding lines plus a summary carrying the five counts and the bodies scanned
#
# Method of the two advisory counts — neither ever changes the exit status, `--strict` included:
#   - An ID is `[A-Z]+-?[0-9]+(-[0-9]+)?` or `#[0-9]+`, bounded by a non-word character or line edge
#     on both sides — the shapes scoped/shared-testing.md → ID ban names (`AC-…`, `T19`, `P0-2`,
#     `#14`). The optional hyphen admits `AC-4`; a `SHA-256`-style name matches too, and whether it
#     is an ID stays the reviewer's.
#   - id_title: a Bats `@test` title, or the first string-literal argument of a single-line `test(`
#     or `it(` call in a `.ts` file, that carries an ID.
#   - incident_header: a file whose leading comment block — `#`, `//` or `/* */` lines after an
#     optional shebang and leading blank lines, ending at the first blank or code line — carries an
#     ID or a `YYYY-MM-DD` date. A `# shellcheck` directive line is tooling and is skipped.
#   - Scope: every `.bats` and `.ts` file under SCOPE_DIRS; monitor/test is the only TS root.
#
# Surface: ADVISORY by default — findings still exit 0 on every surface, including the scope-list
# run. Only `--strict` applies blocking exit semantics; `--advisory` reports without failing
# anywhere. The findings print identically in every mode. Promotion to blocking (and to CI wiring)
# follows the in-house precedent set by scripts/audit-absorption.sh, and the promotion condition it
# must meet is stated ONCE, in rules/glass-atrium/shared-self-improve-hygiene.md → Auditor. Read it
# there; a copy here is the drift this repo names. A day-one blocking gate is forbidden.
#
# Exit codes (shared with scripts/audit-absorption.sh via scripts/lib/audit-cli.sh):
#   0 = audit completed with no blocking findings (or an advisory run)
#   1 = blocking run reporting findings
#   2 = usage error
#   3 = IO/scope error (a scope directory or --path file is missing or unreadable)
#
# Measured baseline — a measured quantity, never a target band, and deliberately NOT quoted here:
# a hand-copied census re-drifts on the next edit exactly as a hand-copied file count does (the
# lesson is already written down in rules/glass-atrium/shared-self-improve-hygiene.md). Read the
# current numbers from an actual `scripts/audit-test-smells.sh --quiet` run over the scope list.
# What is stable is the METHOD and its acceptance criterion, both of which outlive any count:
#   - The baseline was established in two stages. Stage 1 ran the DRAFT vocabulary — the literal
#     wording carrying neither the `run -N` / `--separate-stderr` exemptions nor the custom
#     `assert_*` helper vocabulary. Stage 2 hand-adjudicated every stage-1 finding; the large
#     majority were false positives of that under-inclusive vocabulary, which is what produced the
#     named exemptions below.
#   - The acceptance criterion is a NON-ZERO signal-(a) count on the corrected vocabulary: an
#     auditor that reports nothing has demonstrated nothing.
#   - Heredoc awareness is a correctness and false-positive requirement, NOT the source of the
#     non-zero baseline — blinding the extractor to heredocs raises the count rather than creating
#     it, and the genuine finding is present in both scans.
#   - Signal (b) measures 0 on the current corpus. That is the EXPECTED result, not a defect: the
#     empirical burden is carried by signal (a), and (b) is kept in a portable form for other
#     corpora.
#   - Signal (c) measures 0 on the current corpus, and that clean run is its acceptance
#     demonstration rather than a null result: the conversion set that removed every known count pin
#     landed first, so the detector is reading a tree those conversions emptied. It is proved to
#     FIRE by planting a synthetic pin in a copy of a suite outside the tree.
#
# Signal (c) scope, and what it deliberately does not claim. It fires only where all three hold in
# ONE assertion: the count is taken over a TREE or SOURCE anchor (a `git ls-files`/`git grep` walk, or
# a path rooted at the suite's own directory or a repository root), the literal sits in the same
# assertion, and the comparison states an exact or bounded census. Three neighbouring shapes are
# exempt BY CONSTRUCTION rather than by adjudication:
#   - a literal `0` — a "no occurrence" assertion states a property, not a census;
#   - a membership floor (`-ge 1`, `-gt 0`) — the shape the conversions in this repository adopted as
#     the CORRECT replacement for a pin, so reporting it would argue against the fix;
#   - a count over a sandbox artifact the test itself produced (call logs, captured output, seeded
#     fixtures) — its expected value is a behavioural expectation the test controls end to end, and
#     nothing in the tree can drift it. These are numerous and legitimate; reporting them would bury
#     the signal.
# A comparison whose two sides are both derived (a drift check) matches no literal and so falls out
# on its own. A pin split across two lines — a count captured into a variable, compared further down —
# is out of reach and is not reported; the reviewer keeps that one.
#
# Named exemptions for signal (a): the self-asserting `run !` form; the `run -N` forms that assert
# status at the call site; `run --separate-stderr` (whose bodies inspect `$stderr`); a `run` token
# inside a quoted string or a comment; and a call to any `assert_*` helper (`assert_status`,
# `assert_output`, `assert_contains`, `assert_ctx_contains`, `assert_no_drop` and siblings, defined
# by the bats files themselves) — those consume status and output internally, so the call IS the
# inspection.
#
# Deliberately NOT a signal: conditional test logic. An `if`/`while`/`try` inside a test body is the
# smell only when the assertion sits on one branch, and a loop whose body asserts on EVERY element is
# the idiomatic parameterized form the Test Quality decision procedure prefers. Deciding between them
# requires reading which branch the assertion sits on, so keyword presence would report legitimate
# code in bulk (`for ` appears on 500 lines across the three corpora). That row stays JUDGMENT.
#
# The auditor never adjudicates a smell CATEGORY: it reports a shape, and whether the shape is a
# defect stays the reviewer's. Convention SoT: scoped/shared-testing.md → Meaningless-Test
# Prohibitions.
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# The flag set, the four exit codes and the summary-then-exit tail are shared with
# scripts/audit-absorption.sh; only the detection logic below is this auditor's own.
# shellcheck source=lib/audit-cli.sh
source "${SCRIPT_DIR}/lib/audit-cli.sh"
# scope_blocking=0 — this auditor is UNPROMOTED, so even a scope run stays advisory. Flipping this
# argument promotes it to blocking; that is a governance decision gated on the condition named in
# the header, never a cleanup edit.
audit_cli_init 'audit-test-smells.sh' 'directories' 0 16

# Explicit list, never a glob: the audited surface is a judgment about which corpora hold test
# suites, so a new corpus must be added here loudly rather than picked up silently.
SCOPE_DIRS=(
  hooks/test
  scripts/test
  autoagent/test
  monitor/test
)
readonly SCOPE_DIRS

readonly RE_TEST_OPEN='^@test[[:space:]]+(.*[^[:space:]])[[:space:]]*\{[[:space:]]*$'
readonly RE_TEST_CLOSE='^\}[[:space:]]*$'
readonly RE_HEREDOC='<<(-?)[[:space:]]*["'"'"']?([A-Za-z_][A-Za-z0-9_]*)'
readonly RE_RUN='(^|[[:space:]])run([[:space:]]|$)'
readonly RE_RUN_EXEMPT='(^|[[:space:]])run[[:space:]]+(!|-[0-9]+|--separate-stderr)([[:space:]]|$)'
readonly RE_HELPER='(^|[^[:alnum:]_])_?assert_[a-zA-Z_]+'
# A substitution that fails yields empty text, which can never equal a non-empty literal — so a
# positive `==` against one reads the run's effect loudly; `""`, `!=` and negative helpers do not.
readonly RE_POSITIVE_COMPARE='\[\[[[:space:]]+"\$\(.*\)"[[:space:]]+==[[:space:]]+("[^"]+"|'"'"'[^'"'"']+'"'"')[[:space:]]+\]\]'
# Both operands are captured with a class that excludes brackets, so a subscripted operand simply
# falls out of the signal rather than being guessed at.
readonly RE_COMPARE='(^|[^[:alnum:]_])\[\[?[[:space:]]+([^][:space:]]+)[[:space:]]+(=|==|-eq)[[:space:]]+([^][:space:]]+)[[:space:]]+\]\]?([^[:alnum:]_]|$)'

# A counting idiom inside a command substitution is what makes the other operand a census rather
# than a constant: `wc` in any counting mode, and `grep -c` in any flag cluster.
readonly RE_COUNT_SOURCE='\$\('
readonly RE_COUNT_CMD='(wc[[:space:]]+-[lcwm]|grep[[:space:]]+-[A-Za-z]*c([[:space:]]|$))'
# The counted target must be the tree or a source file under it — a sandbox artifact the test wrote
# itself carries a behavioural expectation, not a census, and is out of scope (see the header).
readonly RE_TREE_ANCHOR='(git[[:space:]]+(ls-files|grep)|BATS_TEST_DIRNAME|REPO_ROOT|PROJECT_ROOT|SRC_ROOT|REAL_SCRIPT|\.\./)'
# The literal may sit on either side of a test operator, or trail an assert_equal call.
readonly RE_PIN_RHS='(-eq|-ne|-gt|-ge|-lt|-le|==|=)[[:space:]]+["'"'"']?([0-9]+)["'"'"']?([^[:alnum:]_]|$)'
readonly RE_PIN_LHS='(^|[[:space:]])["'"'"']?([0-9]+)["'"'"']?[[:space:]]+(-eq|-ne|-gt|-ge|-lt|-le|==|=)[[:space:]]'
readonly RE_PIN_HELPER='assert_equal[[:space:]].*[[:space:]]["'"'"']?([0-9]+)["'"'"']?[[:space:]]*$'
readonly RE_ASSERTION_HEAD='^(\[|assert_)'

readonly RE_ID_TAG='(^|[^[:alnum:]_])([A-Z]+-?[0-9]+(-[0-9]+)?|#[0-9]+)([^[:alnum:]_]|$)'
readonly RE_DATE_STAMP='(^|[^0-9])[0-9]{4}-[0-9]{2}-[0-9]{2}([^0-9]|$)'
# shellcheck disable=SC2016  # the backticks match a literal TS template quote, never a substitution
readonly RE_TS_TITLE='(^|[^[:alnum:]_.$])(test|it)\([[:space:]]*("[^"]*"|'"'"'[^'"'"']*'"'"'|`[^`]*`)'
readonly RE_SHELLCHECK_DIRECTIVE='^#[[:space:]]*shellcheck[[:space:]]'

no_result_check=0
tautology=0
count_pin=0
tests_scanned=0
id_title=0
incident_header=0
LINE_CODE=""
LINE_TEXT=""

# Splits one physical line into two views. LINE_CODE blanks quoted spans so a `run` inside a string
# is not a call; LINE_TEXT keeps them so a `$status` inside a string is still an inspection. Both
# drop an unquoted trailing comment.
scan_line() {
  local rest="${1}"
  local blanked="" kept="" head="" mark="" prev="" span=""
  while [[ "${rest}" =~ ^([^\'\"#]*)([\'\"#])(.*)$ ]]; do
    head="${BASH_REMATCH[1]}"
    mark="${BASH_REMATCH[2]}"
    rest="${BASH_REMATCH[3]}"
    if [[ "${mark}" == '#' ]]; then
      prev="${blanked}${head}"
      if [[ -z "${prev}" || "${prev}" =~ [[:space:]]$ ]]; then
        blanked+="${head}"
        kept+="${head}"
        rest=""
        break
      fi
      blanked+="${head}#"
      kept+="${head}#"
      continue
    fi
    prev="${blanked}${head}"
    if [[ "${rest}" == *"${mark}"* ]]; then
      span="${rest%%"${mark}"*}"
      kept+="${head}${mark}${span}${mark}"
      rest="${rest#*"${mark}"}"
    else
      span="${rest}"
      kept+="${head}${mark}${span}"
      rest=""
    fi
    if [[ "${prev}" =~ \<\<-?$ ]]; then
      # A heredoc delimiter is routinely quoted (`<<'EOF'`), so that one span survives into the code
      # view for the extractor to read; every other quoted span stays blanked.
      blanked+="${head}${span}"
    else
      blanked+="${head} "
    fi
  done
  LINE_CODE="${blanked}${rest}"
  LINE_TEXT="${kept}${rest}"
}

# True when the line reads back the result of a preceding `run`, either through the Bats result
# variables or through a helper that consumes them internally.
line_inspects() {
  local text="${1}" code="${2}"
  # shellcheck disable=SC2016  # the Bats result variables are matched as literal tokens, never expanded
  case "${text}" in
    *'$status'* | *'${status'* | *'$output'* | *'${output'* | *'${lines['* | *'$lines['* | *'$stderr'* | *'${stderr'*)
      return 0
      ;;
    *) ;;
  esac
  # Read from the text view: the code view blanks the quoted operands this shape depends on.
  [[ "${text}" =~ ${RE_POSITIVE_COMPARE} ]] && return 0
  [[ "${code}" =~ ${RE_HELPER} ]]
}

# True when the operator/literal pair states a census rather than a presence claim: zero and the two
# membership-floor forms are the shapes the conversions in this repository adopted, never pins.
pin_is_census() {
  local op="${1}" lit=$((10#${2}))
  ((lit != 0)) || return 1
  case "${op}" in
    -ge | -gt) ((lit > 1)) || return 1 ;;
    *) ;;
  esac
  return 0
}

# True when one assertion both derives a count and compares it against a non-zero integer literal.
# The assertion head is read from the code view so a comparison quoted inside a fixture row is not a
# claim the test makes; the operands are read from the text view so a quoted literal survives.
line_pins_count() {
  local text="${1}" code="${2}" trimmed=""
  trimmed="${code#"${code%%[![:space:]]*}"}"
  [[ "${trimmed}" =~ ${RE_ASSERTION_HEAD} ]] || return 1
  [[ "${text}" =~ ${RE_COUNT_SOURCE} ]] || return 1
  [[ "${text}" =~ ${RE_COUNT_CMD} ]] || return 1
  [[ "${text}" =~ ${RE_TREE_ANCHOR} ]] || return 1
  # shellcheck disable=SC2310  # each predicate's false branch continues the scan, it is not an error
  if [[ "${text}" =~ ${RE_PIN_RHS} ]] && pin_is_census "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"; then
    return 0
  fi
  # shellcheck disable=SC2310  # as above
  if [[ "${text}" =~ ${RE_PIN_LHS} ]] && pin_is_census "${BASH_REMATCH[3]}" "${BASH_REMATCH[2]}"; then
    return 0
  fi
  if [[ "${text}" =~ ${RE_PIN_HELPER} ]] && ((10#${BASH_REMATCH[1]} != 0)); then
    return 0
  fi
  return 1
}

# True when the slurped file's leading comment block carries an ID or a date stamp.
header_is_incident() {
  local idx=0 trimmed="" started=0 in_block=0
  for ((idx = 0; idx < AUDIT_CLI_LINE_COUNT; idx++)); do
    trimmed="${AUDIT_CLI_LINES[idx]#"${AUDIT_CLI_LINES[idx]%%[![:space:]]*}"}"
    if ((in_block == 0)); then
      if [[ -z "${trimmed}" ]]; then
        ((started == 0)) || return 1
        continue
      fi
      if ((idx == 0)) && [[ "${trimmed}" == '#!'* ]]; then
        continue
      fi
      if [[ "${trimmed}" == '/*'* ]]; then
        in_block=1
      elif [[ "${trimmed}" != '#'* && "${trimmed}" != '//'* ]]; then
        return 1
      fi
      started=1
    fi
    if [[ "${trimmed}" == *'*/'* ]]; then
      in_block=0
    fi
    if [[ "${trimmed}" =~ ${RE_SHELLCHECK_DIRECTIVE} ]]; then
      continue
    fi
    if [[ "${trimmed}" =~ ${RE_ID_TAG} || "${trimmed}" =~ ${RE_DATE_STAMP} ]]; then
      return 0
    fi
  done
  return 1
}

# Counts the TS test titles carrying an ID; the Bats signals do not apply to a TS file.
audit_ts_titles() {
  local rel="${1}" idx=0 title=""
  for ((idx = 0; idx < AUDIT_CLI_LINE_COUNT; idx++)); do
    [[ "${AUDIT_CLI_LINES[idx]}" =~ ${RE_TS_TITLE} ]] || continue
    title="${BASH_REMATCH[3]}"
    title="${title:1:${#title}-2}"
    if [[ "${title}" =~ ${RE_ID_TAG} ]]; then
      id_title=$((id_title + 1))
      audit_cli_report ID_TITLE "${rel}:$((idx + 1))" "test ${title}"
    fi
  done
}

audit_file() {
  local rel="${1}" abs="${2}"
  # The slurp result lands in a fixed global pair — bash 3.2 has no nameref to write a local array.
  audit_cli_slurp "${abs}"
  # shellcheck disable=SC2310  # a false predicate is the unreported outcome, not an error
  if header_is_incident; then
    incident_header=$((incident_header + 1))
    audit_cli_report INCIDENT_HEADER "${rel}:1" "leading comment block carries an ID or a date stamp"
  fi
  if [[ "${abs}" == *.ts ]]; then
    audit_ts_titles "${rel}"
  else
    audit_bats_bodies "${rel}"
  fi
}

audit_bats_bodies() {
  local rel="${1}"
  local line="" trimmed="" probe="" text="" code="" detail=""
  local count="${AUDIT_CLI_LINE_COUNT}" idx=0 pos=0
  local in_heredoc=0 heredoc_delim=""
  local in_test=0 test_name="" test_line=0 last_run=-1 last_run_line=0 inspected=0
  local -a body_text=() body_code=()

  for ((idx = 0; idx < count; idx++)); do
    line="${AUDIT_CLI_LINES[idx]:-}"

    # A heredoc body is data, not code: it feeds neither signal, and a column-0 `}` inside one must
    # not be mistaken for the end of the enclosing test body.
    if ((in_heredoc == 1)); then
      trimmed="${line#"${line%%[![:space:]]*}"}"
      if [[ "${trimmed}" == "${heredoc_delim}" ]]; then
        in_heredoc=0
      fi
      continue
    fi

    scan_line "${line}"
    code="${LINE_CODE}"
    text="${LINE_TEXT}"

    if ((in_test == 0)); then
      if [[ "${line}" =~ ${RE_TEST_OPEN} ]]; then
        in_test=1
        test_name="${BASH_REMATCH[1]}"
        test_name="${test_name%\"}"
        test_name="${test_name#\"}"
        test_line=$((idx + 1))
        if [[ "${test_name}" =~ ${RE_ID_TAG} ]]; then
          id_title=$((id_title + 1))
          audit_cli_report ID_TITLE "${rel}:${test_line}" "@test ${test_name}"
        fi
        body_text=()
        body_code=()
        last_run=-1
        last_run_line=0
      fi
    elif [[ "${line}" =~ ${RE_TEST_CLOSE} ]]; then
      in_test=0
      tests_scanned=$((tests_scanned + 1))

      if ((last_run >= 0)); then
        inspected=0
        for ((pos = last_run + 1; pos < ${#body_text[@]}; pos++)); do
          # shellcheck disable=SC2310  # a false predicate is the reportable outcome, not an error
          if line_inspects "${body_text[pos]}" "${body_code[pos]}"; then
            inspected=1
            break
          fi
        done
        if ((inspected == 0)); then
          no_result_check=$((no_result_check + 1))
          audit_cli_report NO_RESULT_CHECK "${rel}:${last_run_line}" "@test ${test_name} — run result never inspected"
        fi
      fi
    else
      pos=${#body_text[@]}
      body_text[pos]="${text}"
      body_code[pos]="${code}"

      if [[ "${code}" =~ ${RE_RUN} ]] && ! [[ "${code}" =~ ${RE_RUN_EXEMPT} ]]; then
        last_run="${pos}"
        last_run_line=$((idx + 1))
      fi

      # The operands are read from the text view so a quoted literal survives, but the test bracket
      # must sit at command position in the CODE view — otherwise a comparison quoted inside a
      # fixture table row reads as an assertion the test never makes.
      trimmed="${code#"${code%%[![:space:]]*}"}"
      if [[ "${trimmed}" == '['* ]] && [[ "${text}" =~ ${RE_COMPARE} ]] && [[ "${BASH_REMATCH[2]}" == "${BASH_REMATCH[4]}" ]]; then
        tautology=$((tautology + 1))
        detail="${text#"${text%%[![:space:]]*}"}"
        audit_cli_report TAUTOLOGY "${rel}:$((idx + 1))" "@test ${test_name} — ${detail}"
      fi

      # shellcheck disable=SC2310  # a false predicate is the reportable outcome, not an error
      if line_pins_count "${text}" "${code}"; then
        count_pin=$((count_pin + 1))
        detail="${text#"${text%%[![:space:]]*}"}"
        audit_cli_report COUNT_PIN "${rel}:$((idx + 1))" "@test ${test_name} — ${detail}"
      fi
    fi

    # Detected on the code view, never the raw line: a `<<` inside a quoted string (a test
    # description, a grep pattern) opens no heredoc, and mistaking one swallows the rest of the file.
    probe="${code//<<</ }"
    if [[ "${probe}" =~ ${RE_HEREDOC} ]]; then
      heredoc_delim="${BASH_REMATCH[2]}"
      in_heredoc=1
    fi
  done

  if ((in_test == 1)); then
    audit_cli_report UNTERMINATED "${rel}:${test_line}" "@test ${test_name} — body never closed at column 0"
  fi
}

main() {
  local target="" rel="" abs="" dir="" fail_msg=""
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
      done < <(find "${abs}" -type f \( -name '*.bats' -o -name '*.ts' \) | LC_ALL=C sort)
      for target in "${found[@]}"; do
        rel="${dir}/${target##*/}"
        audit_file "${rel}" "${target}"
      done
    done
  fi

  printf 'no_result_check=%d tautology=%d count_pin=%d tests_scanned=%d id_title=%d incident_header=%d\n' \
    "${no_result_check}" "${tautology}" "${count_pin}" "${tests_scanned}" "${id_title}" "${incident_header}"

  printf -v fail_msg 'FAIL: %d uninspected run result(s), %d tautological assertion(s) and %d count pin(s) in the audited surface' \
    "${no_result_check}" "${tautology}" "${count_pin}"
  audit_cli_finish "${blocking}" "$((no_result_check + tautology + count_pin))" "${fail_msg}"
}

main "$@"
