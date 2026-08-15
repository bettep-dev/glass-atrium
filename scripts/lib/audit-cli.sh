#!/usr/bin/env bash
# audit-cli.sh — shared command-line spine for the repository's presence-only auditors
# (scripts/audit-absorption.sh, scripts/audit-test-smells.sh). Sourced, not executable.
#
# The two auditors detect nothing in common — absorption idioms on non-comment shell lines versus
# heredoc-aware `@test` body splitting — and they stay two tools on independent promotion
# timelines. What they share is a SURFACE: the same five flags, the same four exit codes, the same
# summary-then-exit tail. That surface lives here so the two cannot drift apart on it, which they
# already had: `--root` was validated in one and silently accepted in the other.
#
# ONE behavioural difference is intended, and it is carried as an explicit init argument rather
# than as an accident of copied code: a PROMOTED auditor blocks on its scope-list run, while an
# UNPROMOTED one blocks only under `--strict`. See the <scope_blocking> argument of
# audit_cli_init. Promotion is a governance decision, never a side effect of an edit here.
#
# Contract:
#   audit_cli_init <name> <scope_noun> <scope_blocking> <kind_width>
#       Records the four per-auditor traits. MUST run before any other call.
#   audit_cli_usage
#       Prints the usage block derived from those traits.
#   audit_cli_parse_args "$@"
#       Parses the shared flag set, then derives `blocking`. Exits 2 on a usage error, 0 on --help.
#   audit_cli_resolve_root <default_root>
#       Validates a --root override (exit 3 when the directory is absent) or resolves the default.
#   audit_cli_slurp <file>
#       Reads the file into AUDIT_CLI_LINES / AUDIT_CLI_LINE_COUNT.
#   audit_cli_walk_paths
#       Walks the --path overrides, calling the caller's `audit_file <rel> <abs>` on each. The
#       caller MUST define that function; a --path target that is missing or unreadable exits 3.
#   audit_cli_report <kind> <location> <detail>
#       Prints one finding line unless QUIET.
#   audit_cli_finish <blocking> <count> <message>
#       Exits 1 when a blocking run reported findings; returns 0 otherwise.
#
# Globals set for the caller (the output contract):
#   QUIET ADVISORY STRICT                     flag state, 0/1
#   paths                                     --path overrides, empty on a scope run
#   root_dir                                  resolved repo root, after audit_cli_resolve_root
#   blocking                                  1 when findings must fail this run
#   AUDIT_CLI_LINES / AUDIT_CLI_LINE_COUNT    last audit_cli_slurp result
#
# Four of these functions call `exit` deliberately: the consumers are executed scripts whose exit
# codes (0 no blocking findings · 1 findings on a blocking run · 2 usage error · 3 IO/scope error)
# are their published contract, and audit-absorption.sh runs as a blocking CI step on that
# contract. Do NOT source this lib from another sourced library, where an exit would kill the
# unrelated sourcing script.
#
# bash 3.2 (macOS system bash): no namerefs, which is why the slurp result lands in a fixed global
# pair rather than an array named by the caller.
#
# shellcheck disable=SC2034  # the globals above are the output contract, read by the sourcing script

if [[ -n "${AUDIT_CLI_LIB_LOADED:-}" ]]; then
  return 0
fi
AUDIT_CLI_LIB_LOADED=1

AUDIT_CLI_NAME="audit.sh"
AUDIT_CLI_SCOPE_NOUN="paths"
AUDIT_CLI_SCOPE_BLOCKING=0
AUDIT_CLI_KIND_WIDTH=14
AUDIT_CLI_LINES=()
AUDIT_CLI_LINE_COUNT=0

QUIET=0
ADVISORY=0
STRICT=0
blocking=0
root_dir=""
paths=()

audit_cli_init() {
  AUDIT_CLI_NAME="${1}"
  AUDIT_CLI_SCOPE_NOUN="${2}"
  AUDIT_CLI_SCOPE_BLOCKING="${3}"
  AUDIT_CLI_KIND_WIDTH="${4}"
}

# The three mode-dependent lines are derived from the promotion trait, so the help text can never
# claim a blocking default the exit path does not implement.
audit_cli_usage() {
  local advisory_help="report findings without failing (exit 0 even with findings)"
  local strict_help="apply the blocking exit semantics to a --path run too"
  local exit_help='Exit: 0 no blocking findings · 1 findings on a blocking run · 2 usage error · 3 IO/scope error'
  if ((AUDIT_CLI_SCOPE_BLOCKING == 0)); then
    advisory_help="report findings without failing (the default on every surface)"
    strict_help="apply blocking exit semantics to this run"
    exit_help='Exit: 0 no blocking findings · 1 findings on a strict run · 2 usage error · 3 IO/scope error'
  fi
  printf '%s\n' \
    "Usage: ${AUDIT_CLI_NAME} [--path <file>]... [--root <dir>] [--quiet] [--advisory|--strict]" \
    '' \
    '  --path <file>  audit the given file instead of the scope list (repeatable)' \
    "  --root <dir>   repo root used to resolve scope-relative ${AUDIT_CLI_SCOPE_NOUN}" \
    '  --quiet        print the summary line only' \
    "  --advisory     ${advisory_help}" \
    "  --strict       ${strict_help}" \
    '  -h, --help     this message' \
    '' \
    "${exit_help}"
}

audit_cli_report() {
  local kind="${1}" location="${2}" detail="${3}" fmt=""
  if ((QUIET == 1)); then
    return 0
  fi
  printf -v fmt '%%-%ds %%s: %%s\n' "${AUDIT_CLI_KIND_WIDTH}"
  # shellcheck disable=SC2059  # fmt is assembled from an integer column width, never from caller text
  printf "${fmt}" "${kind}" "${location}" "${detail}"
}

audit_cli_parse_args() {
  while (($# > 0)); do
    case "${1}" in
      --path)
        if [[ -z "${2:-}" ]]; then
          printf 'ERROR: --path requires a file argument\n' >&2
          exit 2
        fi
        paths+=("${2}")
        shift 2
        ;;
      --root)
        if [[ -z "${2:-}" ]]; then
          printf 'ERROR: --root requires a directory argument\n' >&2
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
        audit_cli_usage
        exit 0
        ;;
      *)
        printf 'ERROR: unknown argument: %s\n' "${1}" >&2
        audit_cli_usage >&2
        exit 2
        ;;
    esac
  done

  if ((ADVISORY == 1 && STRICT == 1)); then
    printf 'ERROR: --advisory and --strict are mutually exclusive\n' >&2
    exit 2
  fi

  # --strict blocks on any surface; a bare scope run blocks only for a promoted auditor.
  blocking=0
  if ((ADVISORY == 0)) && { ((STRICT == 1)) || { ((AUDIT_CLI_SCOPE_BLOCKING == 1)) && ((${#paths[@]} == 0)); }; }; then
    blocking=1
  fi
}

# A bogus --root is an IO/scope error at the point it is given, not a confusing scope-walk failure
# several frames later: the two auditors documented the same exit 3 and only one delivered it.
audit_cli_resolve_root() {
  local default_root="${1}"
  if [[ -n "${root_dir}" ]]; then
    if [[ ! -d "${root_dir}" ]]; then
      printf 'ERROR: --root directory not found: %s\n' "${root_dir}" >&2
      exit 3
    fi
    return 0
  fi
  root_dir="$(cd -- "${default_root}" && pwd)"
}

audit_cli_slurp() {
  local file="${1}" line=""
  AUDIT_CLI_LINES=()
  AUDIT_CLI_LINE_COUNT=0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    AUDIT_CLI_LINES[AUDIT_CLI_LINE_COUNT]="${line}"
    AUDIT_CLI_LINE_COUNT=$((AUDIT_CLI_LINE_COUNT + 1))
  done <"${file}"
}

audit_cli_walk_paths() {
  local target=""
  if ((${#paths[@]} == 0)); then
    return 0
  fi
  for target in "${paths[@]}"; do
    if [[ ! -f "${target}" || ! -r "${target}" ]]; then
      printf 'ERROR: --path target missing or unreadable: %s\n' "${target}" >&2
      exit 3
    fi
    audit_file "${target}" "${target}"
  done
}

audit_cli_finish() {
  local blocking_run="${1}" finding_count="${2}" message="${3}"
  # The findings are already printed by the caller — this branch only decides the exit status, so
  # an advisory run loses no information relative to a blocking one.
  if ((blocking_run == 1)) && ((finding_count > 0)); then
    printf '%s\n' "${message}" >&2
    exit 1
  fi
}
