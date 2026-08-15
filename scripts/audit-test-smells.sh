#!/usr/bin/env bash
# audit-test-smells.sh — advisory audit of two mechanically-detectable Bats test smells
# Usage: audit-test-smells.sh [--path <file>]... [--root <dir>] [--quiet] [--advisory|--strict]
#
# Behavior:
#   1. Walk the in-script SCOPE_DIRS list (its single source of truth) or the --path overrides
#   2. Split each file into @test bodies with a heredoc-aware extractor
#   3. Report signal (a) — a body whose last non-exempt `run` result is never inspected
#   4. Report signal (b) — a comparison whose two operands are the same literal or variable token
#   5. Emit per-finding lines plus a summary carrying the two counts and the bodies scanned
#
# Surface: ADVISORY by default — findings still exit 0 on every surface, including the scope-list
# run. Only `--strict` applies blocking exit semantics; `--advisory` reports without failing
# anywhere. The findings print identically in every mode. Promotion to blocking (and to CI wiring)
# follows the in-house precedent set by scripts/audit-absorption.sh and requires, verbatim:
# "coverage complete, auditor false-positive rate zero across the scope, and the conversion set
# landed." A day-one blocking gate is forbidden.
#
# Exit codes (ported from scripts/audit-absorption.sh):
#   0 = audit completed with no blocking findings (or an advisory run)
#   1 = blocking run reporting findings
#   2 = usage error
#   3 = IO/scope error (a scope directory or --path file is missing or unreadable)
#
# Measured baseline (two-stage — a measured baseline, not a target band; the retired 10-20 range was
# an artefact of an under-inclusive vocabulary). Stage 1: the first advisory run on the DRAFT
# vocabulary — the literal wording carrying neither the `run -N` / `--separate-stderr` exemptions nor
# the custom `assert_*` helper vocabulary — reported 11 signal-(a) findings over 2059 test bodies.
# Stage 2: every one of the 11 was hand-adjudicated (6 `assert_status`/`assert_empty` helper calls, 3
# `run -0` call-site status assertions, 1 further helper call — 10 false positives; the survivor
# discards the captured result and asserts on a spooled file instead), and after correcting the
# vocabulary to the named exemptions below the count is 1 — still non-zero, which is the acceptance
# criterion. Heredoc awareness is a correctness and false-positive requirement, NOT the source of the
# non-zero baseline: the same corrected vocabulary reports 4 signal-(a) findings with the extractor
# blinded to heredocs and 1 with it, and the genuine finding is present in both scans. Signal (b)
# measures 0 on the current corpus; that is the EXPECTED result, not a defect — the empirical burden
# is carried by signal (a), and (b) is kept in a portable form for other corpora.
#
# Named exemptions for signal (a), each measured on this corpus: the self-asserting `run !` form
# (17); the `run -N` forms that assert status at the call site (`run -0` 16, `run -1` 4, `run -19`
# 1); `run --separate-stderr` (13, whose bodies inspect `$stderr`); a `run` token inside a quoted
# string or a comment; and a call to any `assert_*` helper (`assert_status`, `assert_output`,
# `assert_contains`, `assert_ctx_contains`, `assert_no_drop` and siblings, defined by 14 bats files
# themselves) — those consume status and output internally, so the call IS the inspection.
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

# Explicit list, never a glob: the audited surface is a judgment about which corpora hold Bats
# suites, so a new corpus must be added here loudly rather than picked up silently.
SCOPE_DIRS=(
  hooks/test
  scripts/test
  autoagent/test
)
readonly SCOPE_DIRS

readonly RE_TEST_OPEN='^@test[[:space:]]+(.*[^[:space:]])[[:space:]]*\{[[:space:]]*$'
readonly RE_TEST_CLOSE='^\}[[:space:]]*$'
readonly RE_HEREDOC='<<(-?)[[:space:]]*["'"'"']?([A-Za-z_][A-Za-z0-9_]*)'
readonly RE_RUN='(^|[[:space:]])run([[:space:]]|$)'
readonly RE_RUN_EXEMPT='(^|[[:space:]])run[[:space:]]+(!|-[0-9]+|--separate-stderr)([[:space:]]|$)'
readonly RE_HELPER='(^|[^[:alnum:]_])assert_[a-zA-Z_]+'
# Both operands are captured with a class that excludes brackets, so a subscripted operand simply
# falls out of the signal rather than being guessed at.
readonly RE_COMPARE='(^|[^[:alnum:]_])\[\[?[[:space:]]+([^][:space:]]+)[[:space:]]+(=|==|-eq)[[:space:]]+([^][:space:]]+)[[:space:]]+\]\]?([^[:alnum:]_]|$)'

no_result_check=0
tautology=0
tests_scanned=0
QUIET=0
ADVISORY=0
STRICT=0
LINE_CODE=""
LINE_TEXT=""

usage() {
  printf '%s\n' \
    'Usage: audit-test-smells.sh [--path <file>]... [--root <dir>] [--quiet] [--advisory|--strict]' \
    '' \
    '  --path <file>  audit the given file instead of the scope list (repeatable)' \
    '  --root <dir>   repo root used to resolve scope-relative directories' \
    '  --quiet        print the summary line only' \
    '  --advisory     report findings without failing (the default on every surface)' \
    '  --strict       apply blocking exit semantics to this run' \
    '  -h, --help     this message' \
    '' \
    'Exit: 0 no blocking findings · 1 findings on a strict run · 2 usage error · 3 IO/scope error'
}

report() {
  local kind="${1}" location="${2}" detail="${3}"
  if ((QUIET == 1)); then
    return 0
  fi
  printf '%-16s %s: %s\n' "${kind}" "${location}" "${detail}"
}

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
  [[ "${code}" =~ ${RE_HELPER} ]]
}

audit_file() {
  local rel="${1}" abs="${2}"
  local line="" trimmed="" probe="" text="" code="" detail=""
  local count=0 idx=0 pos=0
  local in_heredoc=0 heredoc_delim=""
  local in_test=0 test_name="" test_line=0 last_run=-1 last_run_line=0 inspected=0
  local -a raw=() body_text=() body_code=()

  while IFS= read -r line || [[ -n "${line}" ]]; do
    raw[count]="${line}"
    count=$((count + 1))
  done <"${abs}"

  for ((idx = 0; idx < count; idx++)); do
    line="${raw[idx]:-}"

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
          report NO_RESULT_CHECK "${rel}:${last_run_line}" "@test ${test_name} — run result never inspected"
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
        report TAUTOLOGY "${rel}:$((idx + 1))" "@test ${test_name} — ${detail}"
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
    report UNTERMINATED "${rel}:${test_line}" "@test ${test_name} — body never closed at column 0"
  fi
}

main() {
  local root_dir="" target="" rel="" abs="" dir=""
  local blocking=0
  local -a paths=() found=()

  while (($# > 0)); do
    case "${1}" in
      --path)
        if (($# < 2)); then
          printf 'ERROR: --path requires a value\n' >&2
          exit 2
        fi
        paths+=("${2}")
        shift 2
        ;;
      --root)
        if (($# < 2)); then
          printf 'ERROR: --root requires a value\n' >&2
          exit 2
        fi
        root_dir="${2}"
        shift 2
        ;;
      --quiet)
        QUIET=1
        shift
        ;;
      --advisory)
        ADVISORY=1
        shift
        ;;
      --strict)
        STRICT=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        printf 'ERROR: unknown argument: %s\n' "${1}" >&2
        usage >&2
        exit 2
        ;;
    esac
  done

  if ((ADVISORY == 1)) && ((STRICT == 1)); then
    printf 'ERROR: --advisory and --strict are mutually exclusive\n' >&2
    exit 2
  fi
  if ((ADVISORY == 0)) && ((STRICT == 1)); then
    blocking=1
  fi

  if [[ -z "${root_dir}" ]]; then
    root_dir="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
  fi

  if ((${#paths[@]} > 0)); then
    for target in "${paths[@]}"; do
      if [[ ! -f "${target}" || ! -r "${target}" ]]; then
        printf 'ERROR: --path target missing or unreadable: %s\n' "${target}" >&2
        exit 3
      fi
      audit_file "${target}" "${target}"
    done
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
      for target in "${found[@]}"; do
        rel="${dir}/${target##*/}"
        audit_file "${rel}" "${target}"
      done
    done
  fi

  printf 'no_result_check=%d tautology=%d tests_scanned=%d\n' \
    "${no_result_check}" "${tautology}" "${tests_scanned}"

  # The findings are already printed above — this branch only decides the exit status, so an
  # advisory run loses no information relative to a blocking one.
  if ((blocking == 1)) && ((no_result_check + tautology > 0)); then
    printf 'FAIL: %d uninspected run result(s) and %d tautological assertion(s) in the audited surface\n' \
      "${no_result_check}" "${tautology}" >&2
    exit 1
  fi
}

main "$@"
