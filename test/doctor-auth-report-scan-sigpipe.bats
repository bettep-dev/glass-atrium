#!/usr/bin/env bats
# doctor-auth-report-scan-sigpipe.bats — falsifiable coverage for the daemon-report scan in
# doctor_headless_auth_advisory (lib/ga-tui-preflight.sh) step 3.
#
# Defect: the scan iterated a process substitution whose last stage was `... | sort -rn | cut -f2-`
# (`done < <(… | cut -f2-)`). Under the loader's `set -Eeuo pipefail` + file-scope ERR trap, an early
# `break` (a signature match, or the newest-5 limit) closed the read end while `cut` was still writing
# a large backlog → cut died on SIGPIPE (141) → pipefail fired the ERR trap, emitting a spurious
# "ERROR: line …: cut -f2-" to stderr AFTER doctor already printed its PASS verdict. Cosmetic noise,
# but a violation of the zero-error goal. It surfaced only on the break path (a match present / >5
# reports), never when the loop drained naturally.
#
# Fix: materialize the mtime-sorted list into a var via a fully-drained command substitution, then
# iterate it via a here-string (`done <<<"${sorted}"`). No live pipe writer remains to receive SIGPIPE
# when the loop breaks early. Ordering (newest-first), the newest-5 limit, the grep signature, the
# hit/advise outcome, and the empty/absent-dir paths are all unchanged.
#
# Falsifiability: T1 runs the PRE-FIX process-sub structure verbatim over the same large fixture and
# asserts the ERR trap DID fire (proves the fixture genuinely triggers the SIGPIPE). T2 runs the real
# FIXED function over that identical fixture and asserts stderr is clean.
# The ERR line is written by the unwaited process-substitution subshell,
# so stderr is captured to EOF (_run_strict) before any assertion reads it —
# otherwise T1 races that late write and T2's negative check passes vacuously.
#
# Hermetic: the three real functions (__ga_detect_stat_os, stat_mtime, doctor_headless_auth_advisory)
# are eval'd into the test shell (extract_fn); log / stat_perms / headless_auth_selftest are sandbox
# stubs, GA_ROOT points into an empty sandbox, and the report dir is DOCTOR_AUTH_REPORTS_DIR. No TTY,
# no real claude, no credential.
#
# Run via: bats test/doctor-auth-report-scan-sigpipe.bats
# Requires: bats, bash 3.2+, BSD/GNU stat + touch (macOS)

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

# LARGE fixture size: cut's output must exceed the ~64KB pipe buffer,
# else cut finishes before the reader breaks and no SIGPIPE occurs at all.
# Linux CI /tmp (~73B/line) is ~half macOS (~128B/line):
# 3000 files ≈ 219KB ≈ 3.3x the buffer on Linux.
# Flake-freedom comes from _run_strict's drained stderr capture, not from this margin.
REPORT_FANOUT=3000

setup() {
  [[ -f "${GA}/lib/ga-env.sh" ]] || skip "lib not found: ${GA}/lib/ga-env.sh"
  [[ -f "${GA}/lib/ga-tui-preflight.sh" ]] || skip "lib not found: ${GA}/lib/ga-tui-preflight.sh"
  # the libs are strict-mode when sourced whole; suspend any inherited ERR trap before eval.
  trap - ERR
  SANDBOX="$(mktemp -d -t ga-auth-scan.XXXXXX)"
  OUT="${SANDBOX}/out"
  ERRF="${SANDBOX}/err"
  # the daemon_cycle.py auth-signature set (one alternative of the advisory's grep pattern).
  AUTH_FAIL_RE='API Error: *(401|403)|HTTP *(401|403)|Invalid authentication credentials|Failed to authenticate'
  # GA_ROOT into the empty sandbox → the step-1 secrets file is absent (hermetic, no real machine state).
  GA_ROOT="${SANDBOX}"
  # stubs: log to STDOUT (keeps stderr reserved for the ERR trap); the two step-1/step-2 helpers no-op.
  log() { printf '%s\n' "$*"; }
  stat_perms() { return 1; }
  headless_auth_selftest() { return 2; }
  # extract the three REAL functions under test.
  extract_fn __ga_detect_stat_os
  extract_fn stat_mtime
  extract_fn doctor_headless_auth_advisory
}

teardown() {
  # shellcheck disable=SC2310  # pure predicate — nothing inside it for errexit to catch
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

# extract_fn — eval a single named function from ga-env.sh / ga-tui-preflight.sh into the test shell.
extract_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' \
    "${GA}/lib/ga-env.sh" "${GA}/lib/ga-tui-preflight.sh")"
}

# _make_reports <dir> <n> [match] — create n empty *.json reports; "match" adds one auth-failure report
# forced to a future mtime so it sorts newest → the loop breaks on it at count=1 (max cut backlog).
# Batch-create via `xargs -0 touch` (a few execs) rather than an n-iteration in-process open/close loop.
_make_reports() {
  local dir="$1" n="$2" mode="${3:-nomatch}"
  # `{0..$n}` brace expansion does NOT honor a variable in bash 3.2 → seq|awk|xargs.
  seq 0 "$((n - 1))" \
    | awk -v d="${dir}" '{print d"/report-daemon-cycle-000000000000000000-"$0".json"}' \
    | tr '\n' '\0' | xargs -0 touch
  if [[ "${mode}" == "match" ]]; then
    printf '%s\n' '{"parse_mode": "auth-failure"}' >"${dir}/report-daemon-cycle-000000000000000000-MATCH.json"
    touch -t 203012312359.59 "${dir}/report-daemon-cycle-000000000000000000-MATCH.json"
  fi
}

# _run_strict <fn> [args…] — run fn under the loader's strict mode + ERR trap; stdout → OUT, stderr → ERRF.
# A nonzero status prints OUT and ERRF, so a failing status check names its cause.
# cat reads stderr to EOF and the pipeline waits for cat,
# so every holder of that fd has exited before any assertion reads ERRF —
# an unwaited process substitution and its cut included.
# pipefail carries fn's status, since bats' DEBUG trap resets PIPESTATUS on bash 3.2.
# The outer subshell keeps pipefail out of the test body.
_run_strict() {
  local exit_code=0
  (
    set -o pipefail
    (
      set -Eeuo pipefail
      IFS=$'\n\t'
      trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
      "$@"
    ) 2>&1 >"${OUT}" | cat >"${ERRF}"
  ) || exit_code=$?
  if [[ "${exit_code}" -ne 0 ]]; then
    printf '%s exited %s; stdout:\n' "$1" "${exit_code}"
    cat -- "${OUT}"
    printf 'stderr:\n'
    cat -- "${ERRF}"
  fi
  return "${exit_code}"
}

# _scan_procsub <dir> — the PRE-FIX process-sub structure verbatim (the neutered fix).
# Exists solely to prove the fixture triggers the SIGPIPE the fix removes.
_scan_procsub() {
  local dir="$1" hit=0 latest report_count=0
  while IFS= read -r latest; do
    [[ -n "${latest}" ]] || continue
    report_count=$((report_count + 1))
    [[ "${report_count}" -gt 5 ]] && break
    if grep -qiE 'auth-failure' "${latest}" 2>/dev/null; then
      hit=1
      break
    fi
  done < <(find "${dir}" -maxdepth 1 -type f -name '*.json' 2>/dev/null \
    | while IFS= read -r f; do
      printf '%s\t%s\n' "$(stat_mtime "${f}" 2>/dev/null || printf '0')" "${f}"
    done | sort -rn | cut -f2-)
}

# === T1 — FAIL-BEFORE: the pre-fix process-sub form fires the ERR trap on the break path ===========

@test "scan(pre-fix): the process-sub + cut form SIGPIPEs on early break → spurious 'cut -f2-' ERR" {
  _make_reports "${SANDBOX}" "${REPORT_FANOUT}" match || return 1
  _run_strict _scan_procsub "${SANDBOX}" || return 1
  # the defect the fix removes: the ERR trap attributed a SIGPIPE to cut.
  grep -qE 'cut -f2-|ERROR: line' "${ERRF}" || return 1
}

# === T2 — PASS-AFTER + match behavior: identical fixture, real fixed fn → clean stderr + warn =======

@test "scan(fixed): the here-string form emits NO 'cut -f2-'/ERROR on the same break fixture" {
  _make_reports "${SANDBOX}" "${REPORT_FANOUT}" match || return 1
  DOCTOR_AUTH_REPORTS_DIR="${SANDBOX}" _run_strict doctor_headless_auth_advisory || return 1
  # zero spurious ERR-trap noise on stderr.
  ! grep -qE 'cut -f2-|ERROR: line' "${ERRF}" || return 1
  # hit=1 → the auth-failure warn line still fires.
  grep -qF 'a recent daemon report shows an auth-failure' "${OUT}" || return 1
}

# === T3 — behavior: a clean dir (reports present, none matching) → ok, no error ====================

@test "scan(fixed): a clean report dir reports the ok/no-history line and no error" {
  local i=0
  while [[ "${i}" -lt 5 ]]; do
    printf '%s\n' '{"parse_mode": "ok"}' >"${SANDBOX}/report-clean-${i}.json"
    i=$((i + 1))
  done
  DOCTOR_AUTH_REPORTS_DIR="${SANDBOX}" _run_strict doctor_headless_auth_advisory || return 1
  ! grep -qE 'cut -f2-|ERROR: line' "${ERRF}" || return 1
  grep -qF 'recent daemon reports show no auth-failure' "${OUT}" || return 1
}

# === T4 — behavior: an empty (present but 0-json) dir → ok, no error ================================

@test "scan(fixed): an empty report dir reports the ok/no-history line and no error" {
  DOCTOR_AUTH_REPORTS_DIR="${SANDBOX}" _run_strict doctor_headless_auth_advisory || return 1
  ! grep -qE 'cut -f2-|ERROR: line' "${ERRF}" || return 1
  grep -qF 'recent daemon reports show no auth-failure' "${OUT}" || return 1
}

@test "teardown succeeds silently when setup skipped before creating the temp dir" {
  local saved="${SANDBOX}"
  unset SANDBOX
  run teardown
  SANDBOX="${saved}"
  [[ "${status}" -eq 0 ]] || {
    echo "teardown without a temp dir failed (status ${status}): ${output}" >&2
    return 1
  }
  [[ -z "${output}" ]] || {
    echo "teardown without a temp dir wrote: ${output}" >&2
    return 1
  }
}
