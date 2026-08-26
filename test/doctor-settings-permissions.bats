#!/usr/bin/env bats
# doctor-settings-permissions.bats — pins run_doctor §20 (settings permissions coverage).
#
# The shipped settings.template.json carries the RECOMMENDED permissions shape and nothing applies
# it: wire_hooks merges hooks only, so a live settings.json can sit years away from the template
# with no surface reporting the distance. This section reports that distance and changes nothing —
# it never writes the live file and never moves the exit code (registration kind B: no counter).
#
# Each row asserts a token or a property the others cannot produce:
#   AC1  template rules partly present -> the per-key coverage count AND the missing rule names
#   AC2  every template rule present, reordered, plus live-only rules -> stays green, and the
#        live-only rules are never named (the comparison is template -> live, one direction)
#   AC3  no live settings.json         -> one note line, exit status identical to the present case
#   AC4  warning count                 -> identical with and without the reported gap (kind B)
#   AC5  GA_DOCTOR_SKIP_PERMISSIONS    -> zero detail rows, ONE suppression line, count still equal
#   AC6  the basis wording             -> the block says it is a literal match, not a security claim
#   AC7  the live file's bytes         -> identical after a run that reported a gap (never writes)
#
# Hermetic: GA_ROOT is a throwaway sandbox passed to ga_init_env in a subprocess, the target home,
# runtime-data root and update state dir are temp dirs, the manifest generator path does not exist
# (§8 hashing skipped) and the monitor port is dead (§16 curls nothing). The template and the live
# settings.json under test are both sandbox files — no ~/.claude or ~/.glass-atrium state is read
# or written.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` / `(( ))` does NOT gate — the keyword is read as a
# tested condition — whereas a plain command's non-zero return IS caught mid-body. Every assertion
# here `return 1`s on mismatch, so each one independently fails the test.
#
# Run via: bats test/doctor-settings-permissions.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"

  SANDBOX="$(mktemp -d -t ga-doctor-perms-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga"
  TARGET="${SANDBOX}/target"
  MANIFEST="${SANDBOX}/manifest.json"
  mkdir -p "${TARGET}" "${GA_SANDBOX}/agents"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
  printf '{"version":"1.0.0","agents":{}}\n' >"${GA_SANDBOX}/agent-registry.json"
  seed_template
}

teardown() {
  unset GA_DOCTOR_SKIP_PERMISSIONS
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# The six deny rules and the one ask rule the sandbox template recommends. Synthetic strings: the
# section compares whatever the template holds, so pinning real rules here would couple this suite
# to an unrelated file's content.
template_deny() {
  printf '%s\n' 'Bash(rm:*)' 'Bash(sudo:*)' 'Bash(chmod:*)' 'Bash(curl:*)' 'Read(./private/**)' 'WebFetch'
}

template_ask() {
  printf '%s\n' 'Bash(git commit:*)'
}

seed_template() {
  jq -n --arg deny "$(template_deny)" --arg ask "$(template_ask)" '
    {permissions: {
      defaultMode: "auto",
      allow: ["Bash(git status:*)"],
      deny: ($deny | split("\n") | map(select(length > 0))),
      ask: ($ask | split("\n") | map(select(length > 0)))
    }}' >"${GA_SANDBOX}/settings.template.json"
}

# Write the live settings.json under test. $1 = deny rules (newline-separated), $2 = ask rules.
seed_live() {
  jq -n --arg deny "$1" --arg ask "$2" '
    {permissions: {
      defaultMode: "auto",
      allow: [],
      deny: ($deny | split("\n") | map(select(length > 0))),
      ask: ($ask | split("\n") | map(select(length > 0)))
    }}' >"${TARGET}/settings.json"
}

# Run the REAL run_doctor against the sandbox GA_ROOT in a fresh strict-mode subprocess. The update
# state dir is sandboxed too: §18 reads the arbiter decision records from it, and an unpinned one
# would make this suite's verdict a property of the developer's live install.
run_doctor_sandbox() {
  run env GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    GA_GENERATE_MANIFEST="${SANDBOX}/no-such-manifest-gen" \
    GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/state" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT:-9}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      run_doctor
    ' _ "${GA}" "${GA_SANDBOX}"
}

assert_output_has() {
  [[ "${output}" == *"${1}"* ]] || {
    echo "doctor output missing '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

assert_output_lacks() {
  [[ "${output}" != *"${1}"* ]] || {
    echo "doctor output unexpectedly contains '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# Count the lines of `${output}` containing a literal substring, without grep's zero-match exit 1
# leaking into the caller's verdict.
count_output_lines() {
  local hits
  hits="$(printf '%s\n' "${output}" | grep -c -F -- "${1}" || true)"
  [[ -n "${hits}" ]] || hits=0
  printf '%s' "${hits}"
}

# The warning total the PASS summary reports: 0 on a bare PASS, the parenthesised number otherwise.
# A run with no PASS line at all is a harness defect, not a permissions verdict — say so loudly.
warn_total_of_output() {
  local pass_line
  pass_line="$(printf '%s\n' "${output}" | grep -F -- '== doctor: PASS' | head -n 1 || true)"
  [[ -n "${pass_line}" ]] || {
    echo "no doctor PASS line in output — output:" >&2
    echo "${output}" >&2
    return 1
  }
  case "${pass_line}" in
    *'PASS (with '*) printf '%s' "${pass_line}" | sed -n 's/.*PASS (with \([0-9][0-9]*\) warning.*/\1/p' ;;
    *) printf '0' ;;
  esac
}

# ── AC1 — a partly-covered live file names the count AND every uncovered rule ──────────────────

@test "AC1: template rules absent from the live file are counted and named" {
  seed_live "$(printf '%s\n' 'Bash(rm:*)' 'Bash(sudo:*)' 'Bash(curl:*)' 'Read(./private/**)')" "$(template_ask)"
  run_doctor_sandbox
  assert_output_has "deny: 4/6 template rule(s) present" || return 1
  assert_output_has "missing: Bash(chmod:*), WebFetch" || return 1
  assert_output_has "ask: 1/1 template rule(s) present" || return 1
}

# ── AC2 — full coverage stays green, and live-only rules are never reported ────────────────────

@test "AC2: reordered full coverage plus live-only rules stays green and names no live-only rule" {
  # Deliberately unlikely rule strings: an ordinary token such as `WebSearch` also occurs in the
  # hook-binding rows, so a collision there would fail this row for a reason it does not test.
  local live_only
  live_only="$(printf '%s\n' 'Bash(liveonly-alpha:*)' 'Bash(liveonly-beta:*)' 'Read(./liveonly-gamma/**)' 'Bash(liveonly-delta:*)' 'Bash(liveonly-epsilon:*)')"
  seed_live "$(printf '%s\n' 'WebFetch' 'Read(./private/**)' 'Bash(curl:*)' 'Bash(chmod:*)' 'Bash(sudo:*)' 'Bash(rm:*)' "${live_only}")" \
    "$(printf '%s\n' 'Bash(git push:*)' 'Bash(git commit:*)')"
  run_doctor_sandbox
  assert_output_has "deny: 6/6 template rule(s) present" || return 1
  assert_output_has "ask: 1/1 template rule(s) present" || return 1
  assert_output_lacks "missing:" || return 1
  local rule
  while IFS= read -r rule; do
    [[ -n "${rule}" ]] || continue
    assert_output_lacks "${rule}" || return 1
  done <<<"${live_only}"
}

# ── AC3 — an absent live file is one note, and moves no exit status ────────────────────────────

@test "AC3: no live settings.json emits a single note and the same exit status" {
  seed_live "$(template_deny)" "$(template_ask)"
  run_doctor_sandbox
  local present_status="${status}"

  rm -f -- "${TARGET}/settings.json"
  run_doctor_sandbox
  assert_output_has "no live settings.json" || return 1
  assert_output_lacks "template rule(s) present" || return 1
  local notes
  notes="$(count_output_lines "no live settings.json")"
  [[ "${notes}" -eq 1 ]] || {
    echo "expected exactly one absent-file note, got ${notes} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  [[ "${status}" -eq "${present_status}" ]] || {
    echo "absent live settings.json moved the exit status: ${present_status} -> ${status}" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC4 — kind B: a reported gap adds no warning to the PASS total ─────────────────────────────

@test "AC4: a reported coverage gap leaves the PASS warning total unchanged" {
  seed_live "$(template_deny)" "$(template_ask)"
  run_doctor_sandbox
  local covered_warns
  covered_warns="$(warn_total_of_output)" || return 1
  assert_output_lacks "missing:" || return 1

  seed_live "$(printf '%s\n' 'Bash(rm:*)')" ""
  run_doctor_sandbox
  assert_output_has "missing:" || return 1
  local gapped_warns
  gapped_warns="$(warn_total_of_output)" || return 1
  [[ "${gapped_warns}" -eq "${covered_warns}" ]] || {
    echo "the coverage gap moved the warning total: ${covered_warns} -> ${gapped_warns} — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC5 — suppression removes the detail rows but stays visible, and still counts nothing ──────

@test "AC5: GA_DOCTOR_SKIP_PERMISSIONS drops the detail rows, keeps one notice, moves no total" {
  seed_live "$(printf '%s\n' 'Bash(rm:*)')" ""
  run_doctor_sandbox
  local reported_warns
  reported_warns="$(warn_total_of_output)" || return 1

  export GA_DOCTOR_SKIP_PERMISSIONS=1
  run_doctor_sandbox
  assert_output_lacks "template rule(s) present" || return 1
  assert_output_lacks "missing:" || return 1
  assert_output_has "GA_DOCTOR_SKIP_PERMISSIONS" || return 1
  local notices
  notices="$(count_output_lines "GA_DOCTOR_SKIP_PERMISSIONS")"
  [[ "${notices}" -eq 1 ]] || {
    echo "expected exactly one suppression notice, got ${notices} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  local suppressed_warns
  suppressed_warns="$(warn_total_of_output)" || return 1
  [[ "${suppressed_warns}" -eq "${reported_warns}" ]] || {
    echo "suppression moved the warning total: ${reported_warns} -> ${suppressed_warns} — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC6 — the block declares what the comparison is, so nobody reads it as a security verdict ──

@test "AC6: the coverage block states it is a literal string match, not a security-gap claim" {
  seed_live "$(printf '%s\n' 'Bash(rm:*)')" ""
  run_doctor_sandbox
  assert_output_has "literal string match" || return 1
  assert_output_has "not a security-gap claim" || return 1
}

# ── AC7 — the never-mutates half of the report-only guarantee, asserted on the bytes ───────────

@test "AC7: a run that reports a coverage gap leaves the live settings.json byte-identical" {
  # A gapped live file is the one the section has the most reason to "help" by rewriting, so the
  # comparison runs on exactly that input rather than on an already-covered file.
  seed_live "$(printf '%s\n' 'Bash(rm:*)')" ""
  cp -- "${TARGET}/settings.json" "${SANDBOX}/settings.before.json"
  run_doctor_sandbox
  assert_output_has "missing:" || return 1
  [[ -f "${TARGET}/settings.json" ]] || {
    echo "the live settings.json no longer exists after a doctor run" >&2
    return 1
  }
  cmp -s -- "${SANDBOX}/settings.before.json" "${TARGET}/settings.json" || {
    echo "doctor mutated the live settings.json:" >&2
    diff -- "${SANDBOX}/settings.before.json" "${TARGET}/settings.json" >&2 || true
    return 1
  }
}
