#!/usr/bin/env bats
# doctor-inject-drop-seam.bats — pins run_doctor §10 (inject-scope-rules drop marker)
# to the migrated Tier-A seam. The producer (inject-scope-rules.sh) persists each
# block-drop to INJECT_DROP_LOG = HOOK_LOG_DIR = ${GA_DATA_ROOT}/logs/inject-scope-rules.diag.log;
# §10 MUST read the SAME root. The prior default (${TARGET_HOME}/.claude/logs/…) was
# doubly wrong: TARGET_HOME already = ~/.claude so it named a ~/.claude/.claude/logs
# path that never exists, AND it missed the ~/.glass-atrium/logs relocation — §10 could
# never surface a real recorded drop. This suite seeds a drop log at the seam and asserts
# §10 WARNs (fails at HEAD, where §10 reads the doubled legacy path and sees nothing).
#
# Run via: bats test/doctor-inject-drop-seam.bats
# Requires: bats, jq, bash 3.2+
#
# Hermetic: GA_TARGET_HOME + GA_DATA_ROOT point the target + runtime-data roots at
# throwaway temp dirs, and the doctor-hook-bindings seam set (nonexistent manifest-gen,
# echo-OK claude stub, empty daemon-reports dir) skips §8 SHA hashing + neutralizes the
# post-§10 headless-auth advisory's live `claude -p` probe. No ~/.claude or ~/.glass-atrium
# state is read or written.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA}/glass-atrium"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium not found: ${REAL_GA}"
  TARGET="$(mktemp -d -t ga-doctor-drop-target.XXXXXX)"
  DATA_ROOT="$(mktemp -d -t ga-doctor-drop-data.XXXXXX)"
  mkdir -p "${TARGET}/bin" "${TARGET}/empty-reports"
  # echo-OK claude stub → the post-§10 headless-auth advisory's self-test never networks.
  cat >"${TARGET}/bin/claude" <<'SH'
#!/bin/bash
echo OK
exit 0
SH
  chmod +x "${TARGET}/bin/claude"
  export GA_GENERATE_MANIFEST="${TARGET}/no-such-manifest-gen" # nonexistent → §8 SHA hashing skipped
  export GA_AUTH_CLAUDE_BIN="${TARGET}/bin/claude"             # echo-OK stub → no live claude -p probe
  export DOCTOR_AUTH_REPORTS_DIR="${TARGET}/empty-reports"     # empty dir → trivial daemon-report scan
}

teardown() {
  [[ -n "${TARGET:-}" && -d "${TARGET}" ]] && rm -rf -- "${TARGET}" || true
  [[ -n "${DATA_ROOT:-}" && -d "${DATA_ROOT}" ]] && rm -rf -- "${DATA_ROOT}" || true
}

# Drive the REAL doctor with the target + data-root seams redirected at the sandbox.
# `run` records the exit in $status; run_doctor returns 1 on any §1-12 FAIL, so we assert
# on the merged output lines (log() → stderr, captured by bats `run`), never $status.
run_doctor_seam() {
  GA_TARGET_HOME="${TARGET}" GA_DATA_ROOT="${DATA_ROOT}" run "${REAL_GA}" doctor
}

# Seed a recorded drop at the producer's real path (the GA_DATA_ROOT/logs seam).
seed_drop_at_seam() {
  mkdir -p "${DATA_ROOT}/logs"
  printf '%s [inject-scope-rules] DROP agent=%s block=%s pre_drop_bytes=%s ceiling=%s\n' \
    "2026-07-22T02:00:00" "glass-atrium-dev-shell" "NAMING" "10240" "9984" \
    >"${DATA_ROOT}/logs/inject-scope-rules.diag.log"
}

@test "§10 reads the GA_DATA_ROOT/logs seam → WARNs on a recorded drop (fails at HEAD's doubled path)" {
  seed_drop_at_seam
  # A drop log ALSO seeded at the doubled legacy path (~/.claude/.claude/logs equivalent)
  # would be the HEAD reader's target — leave it ABSENT so a passing WARN can only come
  # from reading the seam, making the HEAD-vs-fixed discrimination unambiguous.
  run_doctor_seam
  [[ "${output}" == *"inject-scope-rules block-drop event(s) recorded"* ]] \
    || { echo "§10 did not surface the seam drop log — output:" >&2; echo "${output}" >&2; return 1; }
  # the WARN must name the seam path, not a ~/.claude root
  [[ "${output}" == *"${DATA_ROOT}/logs/inject-scope-rules.diag.log"* ]] \
    || { echo "WARN did not name the seam path — output:" >&2; echo "${output}" >&2; return 1; }
  [[ "${output}" != *"/.claude/.claude/logs/"* ]] \
    || { echo "§10 referenced the doubled legacy path — output:" >&2; echo "${output}" >&2; return 1; }
}

@test "§10 clean-ok when no drop log exists at the seam" {
  # no seed → the seam logs dir has no drop log
  [[ ! -e "${DATA_ROOT}/logs/inject-scope-rules.diag.log" ]] || return 1
  run_doctor_seam
  [[ "${output}" == *"no inject-scope-rules drop log"* ]] \
    || { echo "§10 no-drop-log OK line absent — output:" >&2; echo "${output}" >&2; return 1; }
}
