#!/usr/bin/env bash
# audit-absorption.sh — presence-only audit of silent-fail absorption annotations
# Usage: audit-absorption.sh [--path <file>]... [--root <dir>] [--quiet] [--advisory|--strict]
#
# Behavior:
#   1. Walk the in-script SCOPE_FILES list (the unattended-execution surface) or the --path overrides
#   2. Match the absorption idiom pattern set on non-comment physical lines
#   3. Require an adjacent `# GA-ABSORB[...]` / `# GA-CONVERTED:` annotation on each matched site
#   4. Emit per-finding lines plus a summary carrying four distinct counts
#   5. Fail on findings when the run is blocking (see the surface split below)
#
# Surface split: a default scope-list run BLOCKS (the enforced surface = the SCOPE_FILES list below,
# its single source of truth, promoted once its coverage condition was met), while a `--path` run stays ADVISORY — the deferred hooks surface and
# ad-hoc probes cannot red a build by accident. `--strict` blocks on a `--path` run, `--advisory`
# reports without failing anywhere; the findings print identically in every mode.
#
# Exit codes:
#   0 = audit completed with no blocking findings (or an advisory-surface run)
#   1 = blocking run reporting findings (unannotated site or grammar reject)
#   2 = usage error
#   3 = IO/scope error (a scope-listed or --path file is missing or unreadable)
#
# The auditor never adjudicates a category: the disambiguating evidence for a suppression is
# block-scoped, so presence + annotation grammar are mechanical here and truthfulness stays the
# annotator's. Convention SoT: rules/glass-atrium/shared-self-improve-hygiene.md
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# The flag set, the four exit codes and the summary-then-exit tail are shared with
# scripts/audit-test-smells.sh; only the detection logic below is this auditor's own.
# shellcheck source=lib/audit-cli.sh
source "${SCRIPT_DIR}/lib/audit-cli.sh"
# scope_blocking=1 — this auditor was promoted, so a bare scope run fails on findings.
audit_cli_init 'audit-absorption.sh' 'paths' 1 14

# Explicit list, never a glob: the scope is a judgment about unattended execution (which surfaces
# fossilize a lost first failure), not a directory shape, so drift must be loud rather than silent.
SCOPE_FILES=(
  autoagent/autoagents-eval.sh
  autoagent/daemon-apply.sh
  autoagent/daemon-cycle.sh
  autoagent/lib/git-txn.sh
  scripts/daemon-daily-restart.sh
  scripts/wiki-daily-compile.sh
  scripts/autoagent-daemon-healthcheck.sh
  scripts/wiki-daemon-healthcheck.sh
  scripts/pii-scan.sh
  scripts/daemon-inject-entry.sh
  scripts/pg-backup.sh
  scripts/monitor-log-rotate.sh
  scripts/lib/apply-lock.sh
  scripts/lib/daemon-bootstrap-common.sh
  scripts/lib/daemon-lock.sh
  scripts/lib/pg-report-drop.sh
  scripts/lib/wiki-envelope.sh
)
readonly SCOPE_FILES

readonly RE_COMMENT='^[[:space:]]*#'
# The terminator is any non-word character or end of line: a closer abutting the idiom (`)`, a
# backtick, a no-space pipe or ampersand) ends it just as a space or semicolon does, while the class
# still denies the word boundary — `|| trueish`, `|| true_flag` and `|| exit 01` stay non-sites.
readonly RE_TERM='([^[:alnum:]_]|$)'
# P1 `|| true` · P2 `|| :` (anti-evasion synonym) · P3 stderr-only suppression · P4 `|| return 0`
readonly RE_SITE_BASE="\\|\\|[[:space:]]*true${RE_TERM}|\\|\\|[[:space:]]*:${RE_TERM}|2>[[:space:]]*/dev/null|\\|\\|[[:space:]]*return[[:space:]]+0${RE_TERM}"
# P5 `|| exit 0` — required only in sourced libraries, where a success-exit terminates the SOURCING
# script; in an executed script the same shape is frequently the correct no-op-and-succeed contract.
readonly RE_SITE_EXIT="\\|\\|[[:space:]]*exit[[:space:]]+0${RE_TERM}"
readonly RE_ABSORB='GA-ABSORB\[([^]]*)\]:(.*)$'
readonly RE_BARE_LINE_REF='^:?[0-9]+$'

annotated=0
converted=0
unannotated=0
quality_reject=0

# Presence check for one file: no classification, no proposed edit — only "did a human annotate".
audit_file() {
  local rel="${1}" abs="${2}"
  local re_site="${RE_SITE_BASE}"
  local line="" tok_line="" note="" label="" reason="" where="" trimmed="" code=""
  local count=0 idx=0 tok_idx=-1 walk=0

  case "${abs}" in
    */lib/*.sh) re_site="${RE_SITE_BASE}|${RE_SITE_EXIT}" ;;
    *) ;;
  esac

  # The slurp result lands in a fixed global pair — bash 3.2 has no nameref to write a local array.
  audit_cli_slurp "${abs}"
  count="${AUDIT_CLI_LINE_COUNT}"

  # Pass 1 — converted markers are counted from their own occurrences, not from site adjacency: a
  # conversion replaces the absorbing idiom, so its marker line carries no pattern hit to attach to.
  for ((idx = 0; idx < count; idx++)); do
    line="${AUDIT_CLI_LINES[idx]:-}"
    if [[ "${line}" != *GA-CONVERTED* ]]; then
      continue
    fi
    note=""
    if [[ "${line}" == *GA-CONVERTED:* ]]; then
      note="${line#*GA-CONVERTED:}"
    fi
    if [[ -z "${note//[[:space:]]/}" ]]; then
      quality_reject=$((quality_reject + 1))
      trimmed="${line#"${line%%[![:space:]]*}"}"
      audit_cli_report QUALITY_REJECT "${rel}:$((idx + 1))" "empty-reason ${trimmed}"
    else
      converted=$((converted + 1))
    fi
  done

  # Pass 2 — one physical line is one site regardless of how many alternatives matched it.
  for ((idx = 0; idx < count; idx++)); do
    line="${AUDIT_CLI_LINES[idx]:-}"
    if [[ "${line}" =~ ${RE_COMMENT} ]]; then
      continue
    fi
    if ! [[ "${line}" =~ ${re_site} ]]; then
      continue
    fi

    tok_idx=-1
    if [[ "${line}" == *GA-ABSORB* || "${line}" == *GA-CONVERTED* ]]; then
      tok_idx="${idx}"
    elif ((idx > 0)) && [[ "${AUDIT_CLI_LINES[idx - 1]:-}" == *GA-ABSORB* || "${AUDIT_CLI_LINES[idx - 1]:-}" == *GA-CONVERTED* ]]; then
      tok_idx=$((idx - 1))
    elif ((idx > 1)) && [[ "${line}" == *\\ && "${AUDIT_CLI_LINES[idx - 1]:-}" == *\\ ]]; then
      # Both the site and its predecessor are `\`-continued, so a trailing comment is illegal on
      # either — walk back to the first line of the continued statement and accept the token there.
      walk=$((idx - 1))
      while ((walk > 0)) && [[ "${AUDIT_CLI_LINES[walk]:-}" == *\\ ]]; do
        walk=$((walk - 1))
      done
      if [[ "${AUDIT_CLI_LINES[walk]:-}" == *GA-ABSORB* || "${AUDIT_CLI_LINES[walk]:-}" == *GA-CONVERTED* ]]; then
        tok_idx="${walk}"
      fi
    fi

    trimmed="${line#"${line%%[![:space:]]*}"}"
    if ((tok_idx < 0)); then
      unannotated=$((unannotated + 1))
      audit_cli_report UNANNOTATED "${rel}:$((idx + 1))" "${trimmed}"
      continue
    fi

    tok_line="${AUDIT_CLI_LINES[tok_idx]:-}"
    if [[ "${tok_line}" != *GA-ABSORB* ]]; then
      continue # accepted by a GA-CONVERTED marker, already counted in pass 1
    fi
    if ! [[ "${tok_line}" =~ ${RE_ABSORB} ]]; then
      quality_reject=$((quality_reject + 1))
      audit_cli_report QUALITY_REJECT "${rel}:$((idx + 1))" "bad-label ${trimmed}"
      continue
    fi

    label="${BASH_REMATCH[1]}"
    reason="${BASH_REMATCH[2]}"
    code=""
    if [[ "${label}" == "benign" ]]; then
      code=""
    elif [[ "${label}" == "handled" ]]; then
      code="handled-no-location"
    elif [[ "${label}" == handled@* ]]; then
      # A bare line number is the one thing the location may not be: it drifts on the next edit.
      where="${label#handled@}"
      if [[ -z "${where}" || "${where}" =~ ${RE_BARE_LINE_REF} ]]; then
        code="handled-no-location"
      fi
    else
      code="bad-label"
    fi
    if [[ -z "${code}" && -z "${reason//[[:space:]]/}" ]]; then
      code="empty-reason"
    fi

    if [[ -n "${code}" ]]; then
      quality_reject=$((quality_reject + 1))
      audit_cli_report QUALITY_REJECT "${rel}:$((idx + 1))" "${code} ${trimmed}"
    else
      annotated=$((annotated + 1))
    fi
  done
}

main() {
  local rel="" abs="" fail_msg=""

  audit_cli_parse_args "$@"
  audit_cli_resolve_root "${SCRIPT_DIR}/.."

  if ((${#paths[@]} > 0)); then
    audit_cli_walk_paths
  else
    for rel in "${SCOPE_FILES[@]}"; do
      abs="${root_dir}/${rel}"
      if [[ ! -f "${abs}" || ! -r "${abs}" ]]; then
        printf 'ERROR: scope file missing or unreadable: %s\n' "${abs}" >&2
        exit 3
      fi
      audit_file "${rel}" "${abs}"
    done
  fi

  printf 'annotated=%d converted=%d unannotated=%d quality_reject=%d\n' \
    "${annotated}" "${converted}" "${unannotated}" "${quality_reject}"

  printf -v fail_msg 'FAIL: %d unannotated site(s) and %d grammar reject(s) in the audited surface' \
    "${unannotated}" "${quality_reject}"
  audit_cli_finish "${blocking}" "$((unannotated + quality_reject))" "${fail_msg}"
}

main "$@"
