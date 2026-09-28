#!/usr/bin/env bash
# audit-rm.sh — audit of recursive or forced delete targets against the shared path guard
# Usage: audit-rm.sh [--path <file>]... [--root <dir>] [--quiet] [--advisory|--strict]
#
# Behavior:
#   1. Walk the shell files of the SCOPE_DIRS trees plus the SCOPE_FILES root scripts, or the --path
#      overrides. A scope run then prints a NOT_READ line for every tracked shell file it skips —
#      EXCLUDED_FILE plus the UNREAD_FILES list — so a green run never reads as full coverage.
#   2. Find each recursive or forced delete on a non-comment physical line (one line is one site)
#   3. Count the one converted shape: an `if ga_guard_path "${V}"; then` whose first command deletes
#      the single operand "${V:?}" (a literal sub-path allowed), on one line or under that if line
#   4. Else accept a `# GA-RM[unvalidatable|not-executed]: <reason>` annotation trailing the site or
#      on the comment line directly above it; any other label or an empty reason is a grammar reject
#   5. Report every other site: NONEMPTY_ONLY · UNQUOTED_TARGET · GLOB_TARGET · UNCONVERTED
#
# Surface split: a default scope run BLOCKS (the enforced surface = SCOPE_DIRS + SCOPE_FILES), while a
# `--path` run stays ADVISORY — an ad-hoc probe cannot red a build by accident. `--strict` blocks on a
# `--path` run, `--advisory` reports without failing anywhere; the findings print identically in every mode.
#
# Exit codes (the shared set of scripts/lib/audit-cli.sh):
#   0 = audit completed with no blocking findings (or an advisory-surface run)
#   1 = blocking run reporting findings (an unconverted site or a grammar reject)
#   2 = usage error
#   3 = IO/scope error (a scope tree, scope file or --path target is missing or unreadable)
#
# Rule: agents/GLASS_ATRIUM_GLOBAL_RULES.md → File Deletion Policy.
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# shellcheck source-path=SCRIPTDIR source=lib/audit-cli.sh
source "${SCRIPT_DIR}/lib/audit-cli.sh"
# scope_blocking=1 — promoted, so a bare scope run fails on findings.
audit_cli_init 'audit-rm.sh' 'directories' 1 15

SCOPE_DIRS=(hooks scripts autoagent lib test)
readonly SCOPE_DIRS
# Shell entry points at the repository root, which no scope tree reaches.
SCOPE_FILES=(glass-atrium install.sh)
readonly SCOPE_FILES
# The scratch-cwd violation probe deletes its own canary through a cwd glob on purpose — that delete
# is what it proves the suite seat confines.
readonly EXCLUDED_FILE='test/scratch-cwd-violation-probe.bats'
# Tracked shell files no scope entry reaches — the scope itself is the owner's decision:
#   - monitor/scripts/*: the monitor session's area;
#   - build-glass-atrium.sh and the two skills scripts: widening the scope to them is the owner's call.
# scripts/test/audit-rm.bats fails when a tracked shell file sits outside scope without an entry here.
UNREAD_FILES=(
  build-glass-atrium.sh
  monitor/scripts/oss-db-setup.sh
  monitor/scripts/prune-dist.sh
  skills/glass-atrium-design-md-lint/lint.sh
  skills/glass-atrium-ops-token-audit/mcp-scan.sh
)
readonly UNREAD_FILES

readonly RE_COMMENT='^[[:space:]]*#'
readonly RE_SHEBANG='^#!.*[/[:space:]](ba|da|k)?sh([[:space:]]|$)'
readonly RE_PREFILTER='rm[[:space:]]+-'
# Command-word boundary: line start, a separator, a quote, a slash, a backslash, or a \n / \t escape.
readonly RE_SITE="(^|[;&|(){}\`!\"'\\\\/[:space:]]|\\\\[nt])rm(([[:space:]]+-[^[:space:]]*)+)"
readonly RE_FORCEFUL='[[:space:]]-[[:alpha:]]*[rRf]|[[:space:]]--(recursive|force)([[:space:]]|$)'
readonly RE_VAR='[A-Za-z_][A-Za-z0-9_]*'
readonly RE_GATE="if[[:space:]]+ga_guard_path[[:space:]]+\"\\\$\\{(${RE_VAR})(:-)?\\}\";[[:space:]]*then"
readonly RE_TARGET="\"\\\$\\{(${RE_VAR}):\\?\\}((/[A-Za-z0-9._@+-]+)*)\""
readonly RE_DELETE="rm([[:space:]]+-[[:alpha:]]+|[[:space:]]+--(recursive|force))+([[:space:]]+--)?[[:space:]]+${RE_TARGET}"
readonly RE_TAIL='([[:space:]]+#.*)?$'
readonly RE_ONE_LINE="^${RE_GATE}[[:space:]]+${RE_DELETE};[[:space:]]*fi${RE_TAIL}"
readonly RE_GATE_LINE="^${RE_GATE}${RE_TAIL}"
readonly RE_GATE_HEAD="^${RE_GATE}"
readonly RE_DELETE_LINE="^${RE_DELETE}${RE_TAIL}"
readonly RE_ANNOTATION='GA-RM\[([^]]*)\]:(.*)$'
readonly RE_QUOTED="(\"[^\"]*\"|'[^']*')"
readonly RE_BRACED='\$\{[^}]*\}'
readonly RE_GLOB='[][*?]'
readonly RE_NONEMPTY='\[\[?[[:space:]]+-n[[:space:]]'

converted=0
annotated=0
unconverted=0
quality_reject=0
SITE_PREFIX=""
SITE_REST=""
SITE_KIND=""

audit_tree() {
  local abs="${root_dir}/${1}" found="" sorted="" file="" rel=""
  if [[ ! -d "${abs}" || ! -r "${abs}" ]] || ! found="$(find "${abs}" -type f)"; then
    printf 'ERROR: scope directory missing or unwalkable: %s\n' "${abs}" >&2
    exit 3
  fi
  if [[ -z "${found}" ]]; then
    return 0
  fi
  sorted="$(LC_ALL=C sort <<<"${found}")"
  while IFS= read -r file; do
    rel="${file#"${root_dir}/"}"
    # shellcheck disable=SC2310  # predicate of tests and expansions only — nothing for errexit to catch
    if [[ "${rel}" == "${EXCLUDED_FILE}" ]] || ! is_shell_file "${file}"; then
      continue
    fi
    audit_file "${rel}" "${file}"
  done <<<"${sorted}"
}

# The ShellCheck SC2115 CI step's selection: a shell extension, or an extensionless sh-family shebang.
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
  local rel="${1}" abs="${2}" idx=0 line="" prev=""
  # shellcheck disable=SC2310  # predicate whose one failure path exits the script itself
  if ! has_site_candidate "${abs}"; then
    return 0
  fi
  audit_cli_slurp "${abs}"
  for ((idx = 0; idx < AUDIT_CLI_LINE_COUNT; idx++)); do
    line="${AUDIT_CLI_LINES[idx]:-}"
    # shellcheck disable=SC2310  # predicate of tests and expansions only — nothing for errexit to catch
    if [[ "${line}" =~ ${RE_COMMENT} ]] || ! find_site "${line}"; then
      continue
    fi
    prev=""
    if ((idx > 0)); then
      prev="${AUDIT_CLI_LINES[idx - 1]:-}"
    fi
    audit_site "${rel}:$((idx + 1))" "${line#"${line%%[![:space:]]*}"}" "${prev#"${prev%%[![:space:]]*}"}"
  done
}

# 0 when some line carries a flagged delete candidate, 1 when none; exits 3 when the file cannot be read.
has_site_candidate() {
  local abs="${1}" rc=0
  grep -q -E "${RE_PREFILTER}" -- "${abs}" || rc=$?
  if ((rc > 1)); then
    printf 'ERROR: cannot read %s\n' "${abs}" >&2
    exit 3
  fi
  return "${rc}"
}

# Sets SITE_PREFIX / SITE_REST around the first recursive or forced delete on the line; 1 when none.
find_site() {
  local text="${1}" consumed="" match=""
  while [[ "${text}" =~ ${RE_SITE} ]]; do
    match="${BASH_REMATCH[0]}"
    if [[ "${BASH_REMATCH[2]}" =~ ${RE_FORCEFUL} ]]; then
      SITE_PREFIX="${consumed}${text%%"${match}"*}"
      SITE_REST="${text#*"${match}"}"
      return 0
    fi
    consumed="${consumed}${text%%"${match}"*}${match}"
    text="${text#*"${match}"}"
  done
  return 1
}

# Counts the site as converted or annotated, or reports it; the annotation trailing the site wins.
audit_site() {
  local location="${1}" line="${2}" prev="${3}"
  # shellcheck disable=SC2310  # predicate of tests and expansions only — nothing for errexit to catch
  if is_converted "${line}" "${prev}"; then
    converted=$((converted + 1))
  elif [[ "${SITE_REST}" == *GA-RM* ]]; then
    audit_annotation "${location}" "${line}" "${SITE_REST}"
  elif [[ "${prev}" == \#* && "${prev}" == *GA-RM* ]]; then
    audit_annotation "${location}" "${line}" "${prev}"
  else
    set_site_kind
    unconverted=$((unconverted + 1))
    audit_cli_report "${SITE_KIND}" "${location}" "${line}"
  fi
}

# 0 for the one converted shape; the gate and the operand must name the same variable.
is_converted() {
  local line="${1}" prev="${2}" gate="" gate_var="" suffix=""
  if [[ "${line}" =~ ${RE_ONE_LINE} ]]; then
    gate="${line}"
  elif [[ "${line}" =~ ${RE_DELETE_LINE} && "${prev}" =~ ${RE_GATE_LINE} ]]; then
    gate="${prev}"
  else
    return 1
  fi
  [[ "${gate}" =~ ${RE_GATE_HEAD} ]] && gate_var="${BASH_REMATCH[1]}"
  [[ "${line}" =~ ${RE_TARGET} ]] && suffix="${BASH_REMATCH[2]}"
  # A `.` or `..` segment steps outside the guarded path.
  [[ "${BASH_REMATCH[1]}" == "${gate_var}" && "${suffix}/" != */./* && "${suffix}/" != */../* ]]
}

audit_annotation() {
  local location="${1}" line="${2}" note="${3}" label="" reason="" code=""
  if [[ "${note}" =~ ${RE_ANNOTATION} ]]; then
    label="${BASH_REMATCH[1]}"
    reason="${BASH_REMATCH[2]}"
  fi
  if [[ "${label}" != unvalidatable && "${label}" != not-executed ]]; then
    code="bad-label"
  elif [[ -z "${reason//[[:space:]]/}" ]]; then
    code="empty-reason"
  fi
  if [[ -n "${code}" ]]; then
    quality_reject=$((quality_reject + 1))
    audit_cli_report QUALITY_REJECT "${location}" "${code} ${line}"
  else
    annotated=$((annotated + 1))
  fi
}

# Sets SITE_KIND from the operands of this command: quoted spans neither glob nor split, so they drop out.
set_site_kind() {
  local bare="${SITE_REST}" unbraced=""
  while [[ "${bare}" =~ ${RE_QUOTED} ]]; do
    bare="${bare/"${BASH_REMATCH[1]}"/Q}"
  done
  bare="${bare%%[;|&#)]*}"
  unbraced="${bare}"
  while [[ "${unbraced}" =~ ${RE_BRACED} ]]; do
    unbraced="${unbraced/"${BASH_REMATCH[0]}"/V}"
  done
  if [[ "${unbraced}" =~ ${RE_GLOB} ]]; then
    SITE_KIND="GLOB_TARGET"
  elif [[ "${bare}" == *'$'* ]]; then
    SITE_KIND="UNQUOTED_TARGET"
  elif [[ "${SITE_PREFIX}" =~ ${RE_NONEMPTY} ]]; then
    SITE_KIND="NONEMPTY_ONLY"
  else
    SITE_KIND="UNCONVERTED"
  fi
}

# Walks every scope entry — a root script whatever its first line holds — then names each skipped shell file.
audit_scope() {
  local tree="" rel="" abs=""
  for tree in "${SCOPE_DIRS[@]}"; do
    audit_tree "${tree}"
  done
  for rel in "${SCOPE_FILES[@]}"; do
    abs="${root_dir}/${rel}"
    if [[ ! -f "${abs}" || ! -r "${abs}" ]]; then
      printf 'ERROR: scope file missing or unreadable: %s\n' "${abs}" >&2
      exit 3
    fi
    audit_file "${rel}" "${abs}"
  done
  for rel in "${EXCLUDED_FILE}" "${UNREAD_FILES[@]}"; do
    audit_cli_report NOT_READ "${rel}" 'tracked shell file outside the audited surface'
  done
}

main() {
  local fail_msg=""

  audit_cli_parse_args "$@"
  audit_cli_resolve_root "${SCRIPT_DIR}/.."

  if ((${#paths[@]} > 0)); then
    audit_cli_walk_paths
  else
    audit_scope
  fi

  printf 'converted=%d annotated=%d unconverted=%d quality_reject=%d\n' \
    "${converted}" "${annotated}" "${unconverted}" "${quality_reject}"

  printf -v fail_msg 'FAIL: %d unconverted site(s) and %d grammar reject(s) in the audited surface' \
    "${unconverted}" "${quality_reject}"
  audit_cli_finish "${blocking}" "$((unconverted + quality_reject))" "${fail_msg}"
}

main "$@"
