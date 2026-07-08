#!/usr/bin/env bash
# sensitive-refusal.sh — the update skill's shared sensitive-file refusal gate.
# Pure sourced library: function defs only, no side effects (same convention as
# apply-spine.sh / apply-gate.sh / atrium-config.sh); strict mode is the CALLER's
# responsibility (a sourced lib must not mutate caller shell options).
#
# Role (gate G7): the skill MUST refuse to sync a sensitive harness file
# (GLOBAL_RULES, security scope rules, a credential file, a launchd plist) or a
# diff body carrying an irreversible/external-effect command. CRITICAL: the
# refusal set is the COMPILED regex tuples in autoagent/daemon_cycle.py — the
# SINGLE source; the skill consults it ONLY by shelling out to the python helper
# autoagent/lib/sensitive_patterns.py (which imports those tuples). A shell-ERE
# data file is deliberately NOT used — a shell-regex dialect would silently
# diverge from Python `re` (forbidden re-implementation), so daemon and skill
# provably refuse the SAME set.
#
# Loud-fail contract (shared-self-improve-hygiene Precondition Loud-Fail): a
# missing python3, missing helper, or unreachable compiled source returns
# non-zero + stderr — never a silent skip (which would let a sensitive file slip
# through unchecked).
#
# Helper exit-code contract (mirrored from sensitive_patterns.py):
#   0  CLEAN      — not sensitive, safe to proceed
#   3  SENSITIVE  — refuse; the helper printed the matched pattern + reason
#   2  USAGE      — bad invocation
#   4  ENV        — compiled source unreachable

# Resolve the python helper path. Honors GA_ROOT (test seam), falling back to
# ${HOME}/.glass-atrium — same precedence as atrium-config.sh.
sensitive_helper_path() {
  printf '%s\n' \
    "${ATRIUM_SENSITIVE_HELPER:-${GA_ROOT:-${HOME}/.glass-atrium}/autoagent/lib/sensitive_patterns.py}"
}

# Resolve the python interpreter. Honors ATRIUM_PYTHON (test seam), else python3.
sensitive_python_bin() {
  printf '%s\n' "${ATRIUM_PYTHON:-python3}"
}

# Loud-fail preflight: python3 present AND helper file present. rc 0 on success,
# rc 4 (ENV) with an explicit stderr line otherwise — so a broken environment is
# never mistaken for a CLEAN verdict.
sensitive_preflight() {
  local py helper
  py="$(sensitive_python_bin)"
  helper="$(sensitive_helper_path)"
  if ! command -v "${py}" >/dev/null 2>&1; then
    printf 'sensitive-refusal: python interpreter not found: %s\n' "${py}" >&2
    return 4
  fi
  if [[ ! -f "${helper}" ]]; then
    printf 'sensitive-refusal: helper not found: %s\n' "${helper}" >&2
    return 4
  fi
  return 0
}

# Shared invocation: preflight, then run the helper in the requested mode. Args:
# $1 = mode (path|diff) · $2 = subject (path, or '-' for stdin). Propagates the
# helper's rc verbatim (0 CLEAN · 3 SENSITIVE · 2 USAGE), or rc 4 (ENV) on preflight fail.
sensitive_invoke() {
  local mode="$1" subject="$2" py helper
  sensitive_preflight || return 4
  py="$(sensitive_python_bin)"
  helper="$(sensitive_helper_path)"
  "${py}" "${helper}" "${mode}" "${subject}"
}

# Test a single file PATH. Args: $1 = path.
# rc 0   → CLEAN (safe to sync)
# rc 3   → SENSITIVE (refuse — helper printed the matched pattern + reason)
# rc 2/4 → USAGE / ENV (loud-fail; treat as refuse — never sync on uncertainty)
sensitive_check_path() {
  sensitive_invoke path "$1"
}

# Test a unified DIFF. Args: $1 = diff file path; omit or '-' → read stdin.
# Same rc contract as sensitive_check_path.
sensitive_check_diff() {
  sensitive_invoke diff "${1:--}"
}

# Higher-order guard: returns 0 ONLY when the path is provably CLEAN. ANY other
# outcome (sensitive, usage, env, preflight failure) returns non-zero so a
# caller `if sensitive_path_ok "$p"; then sync; fi` fails CLOSED — an unchecked
# or refused path is NEVER synced.
sensitive_path_ok() {
  sensitive_check_path "$1" && return 0
  return 1
}

# Higher-order guard for diffs — fail-closed twin of sensitive_path_ok.
sensitive_diff_ok() {
  sensitive_check_diff "${1:--}" && return 0
  return 1
}
