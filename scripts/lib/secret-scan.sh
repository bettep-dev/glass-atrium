#!/usr/bin/env bash
# secret-scan.sh — the install's one secret-pattern table and scan, shared by the PreToolUse secret hook and the
# monitor's relay check; executed, never sourced. Reads the text on stdin only; its one accepted argument is the
# list-all flag, so a caller never puts the text in an argument list or the environment.
# Exit contract (fail-closed — a caller treats every status but these two as "scan unavailable"):
#   0 → clean, nothing on stdout
#   3 → match, one stdout line "<pattern code><TAB><pattern name>" for the first matching pattern; never the text
#     --list-all → instead one line "<line index><TAB><pattern code>" per matching pattern per line; the index is
#     1-based, counted by LF only (a CR stays part of its line)
set -Eeuo pipefail
IFS=$'\n\t'
trap 'exit 1' ERR

readonly SCAN_CLEAN=0
readonly SCAN_MATCH=3
readonly SCAN_USAGE=64

# Structured-token shapes · generic credential assignments (8+ character value, so a placeholder passes) · PEM
# private-key headers · service-account JSON markers; matched case-insensitively, first match wins.
readonly -a PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'ghp_[a-zA-Z0-9]{36}'
  'sk-[a-zA-Z0-9]{20,}'
  'eyJ[a-zA-Z0-9_-]*\.eyJ'
  'postgres://[^ ]*@'
  'mongodb(\+srv)?://[^ ]*@'
  'AIza[0-9A-Za-z_-]{35}'
  'xox[bpoa]-[0-9a-zA-Z-]+'
  '(password|passwd|api[_-]?key|secret|token|access[_-]?key|aws_secret_access_key)["'"'"' ]*[:=][ ]*["'"'"']?[^[:space:]"'"'"']{8,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '"private_key"[ ]*:[ ]*"-----BEGIN'
  '"type"[ ]*:[ ]*"service_account"'
)
readonly -a CODES=(SEC-001 SEC-002 SEC-003 SEC-004 SEC-005 SEC-006 SEC-007 SEC-008 SEC-013 SEC-014 SEC-015 SEC-015)
readonly -a NAMES=(
  "AWS Access Key"
  "GitHub Token"
  "API Key (sk-)"
  "JWT Token"
  "DB connection string"
  "MongoDB connection string"
  "Google API Key"
  "Slack Token"
  "Generic credential assignment"
  "PEM private key"
  "Service-account private key"
  "Service-account JSON marker"
)

readonly LIST_ALL_FLAG="--list-all"

main() {
  local text i rc
  if (($# > 1)) || { (($# == 1)) && [[ "${1}" != "${LIST_ALL_FLAG}" ]]; }; then exit "${SCAN_USAGE}"; fi
  text="$(cat)"
  if [[ -z "${text}" ]]; then exit "${SCAN_CLEAN}"; fi
  if (($# == 1)); then find_all_matches "${text}"; fi
  for i in "${!PATTERNS[@]}"; do
    rc=0
    # here-string, not a pipe → no writer to lose to SIGPIPE · `--` keeps the dash-led PEM pattern an operand
    grep -qiE -- "${PATTERNS[${i}]}" <<<"${text}" || rc=$?
    case "${rc}" in
      0)
        # a subshell write owns no child, so no SIGCHLD interrupts it
        # GA-ABSORB[handled@exit-SCAN_MATCH]: a lost reply still exits with the match code, which every caller blocks on
        (printf '%s\t%s\n' "${CODES[${i}]}" "${NAMES[${i}]}") || true
        exit "${SCAN_MATCH}"
        ;;
      1) ;;
      *) exit 1 ;;
    esac
  done
  exit "${SCAN_CLEAN}"
}

# Every pattern over every line → only grep's "<index>:" prefix leaves, never the matched text.
find_all_matches() {
  local text="${1}" rows="" hits row i rc
  for i in "${!PATTERNS[@]}"; do
    rc=0
    # trap cleared → the inherited ERR trap would turn grep's failure status into 1, read below as "no match"
    # -a → an invalid-encoding byte never collapses the rows into one "binary file matches" notice
    hits="$(
      trap - ERR
      grep -naiE -- "${PATTERNS[${i}]}" <<<"${text}"
    )" || rc=$?
    case "${rc}" in
      0) while IFS= read -r row; do rows+="${row%%:*}"$'\t'"${CODES[${i}]}"$'\n'; done <<<"${hits}" ;;
      1) ;;
      *) exit 1 ;;
    esac
  done
  if [[ -z "${rows}" ]]; then exit "${SCAN_CLEAN}"; fi
  # GA-ABSORB[handled@exit-SCAN_MATCH]: a lost reply still exits with the match code, which every caller blocks on
  (printf '%s' "${rows}") || true
  exit "${SCAN_MATCH}"
}

main "$@"
