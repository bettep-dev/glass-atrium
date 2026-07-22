#!/usr/bin/env bats
# data-root-seam-wiki-audit.bats — pins the T4a consumer-side data-root seam for the
# wiki daemon stage runners (wiki-dedup.sh / wiki-deadlinks.sh / wiki-daemon-cycle.sh)
# + the context-audit script (audit-context.sh). Each consumer resolves its runtime
# output store via the HOME-anchored ${GA_DATA_ROOT:-$HOME/.glass-atrium} default (the
# T1 seam), DECOUPLED from the install-tree GA_ROOT so a launchd-spawned daemon (GA_ROOT
# unset) still resolves correctly.
#
# Run via: bats test/data-root-seam-wiki-audit.bats
# Hermetic: HOME → mktemp sandbox; a stub python3 on PATH short-circuits the real Python
# stages (no wiki compile, no token scan) — the shell resolves + mkdir's the store BEFORE
# the now-no-op Python call, so the resolved location is observable. WIKI_COMPILE_LOCK_HELD=1
# bypasses the shared /tmp compile lock for the leaf stages. No live ~/.claude or
# ~/.glass-atrium state is read or written.
#
# Every assertion carries a `|| return 1` fail-fast guard: bats enforces only the test
# body's LAST command status, so an unguarded intermediate assertion would be masked.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
DEDUP_SH="${GA}/scripts/wiki-dedup.sh"
DEADLINKS_SH="${GA}/scripts/wiki-deadlinks.sh"
CYCLE_SH="${GA}/scripts/wiki-daemon-cycle.sh"
AUDIT_SH="${GA}/scripts/audit-context.sh"

setup() {
  SANDBOX="$(mktemp -d -t data-root-seam-wa.XXXXXX)"
  FAKE_BIN="${SANDBOX}/bin"
  mkdir -p -- "${FAKE_BIN}"
  # Stub python3 — no-op exit 0. Echoes CLAUDE_AUDIT_OUT_PATH when audit-context.sh
  # exports it (so the audit store is assertable); silent for the wiki stages.
  cat >"${FAKE_BIN}/python3" <<'STUB'
#!/usr/bin/env bash
[[ -n "${CLAUDE_AUDIT_OUT_PATH:-}" ]] && printf '%s\n' "${CLAUDE_AUDIT_OUT_PATH}"
exit 0
STUB
  chmod +x "${FAKE_BIN}/python3"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

@test "wiki-dedup.sh: no override → daemon-reports under \$HOME/.glass-atrium" {
  run env -u GA_DATA_ROOT -u GA_ROOT HOME="${SANDBOX}" PATH="${FAKE_BIN}:${PATH}" \
    WIKI_COMPILE_LOCK_HELD=1 "${DEDUP_SH}" --skip-llm
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${output}" == *"/.glass-atrium/data/daemon-reports/"* ]] || { echo "out=${output}" >&2; return 1; }
  [[ "${output}" != *"/.claude/data/daemon-reports/"* ]] || { echo "leaked .claude: ${output}" >&2; return 1; }
  [[ -d "${SANDBOX}/.glass-atrium/data/daemon-reports" ]] || { echo "seam dir not created" >&2; return 1; }
  [[ ! -d "${SANDBOX}/.claude/data/daemon-reports" ]] || { echo ".claude dir created (seam leaked)" >&2; return 1; }
}

@test "wiki-dedup.sh: GA_DATA_ROOT override honored (seam override keeps working)" {
  run env -u GA_ROOT HOME="${SANDBOX}" PATH="${FAKE_BIN}:${PATH}" \
    GA_DATA_ROOT="${SANDBOX}/custom-root" WIKI_COMPILE_LOCK_HELD=1 "${DEDUP_SH}" --skip-llm
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${output}" == *"${SANDBOX}/custom-root/data/daemon-reports/"* ]] || { echo "out=${output}" >&2; return 1; }
  [[ -d "${SANDBOX}/custom-root/data/daemon-reports" ]] || { echo "override dir not created" >&2; return 1; }
}

@test "wiki-deadlinks.sh: no override → daemon-reports under \$HOME/.glass-atrium" {
  run env -u GA_DATA_ROOT -u GA_ROOT HOME="${SANDBOX}" PATH="${FAKE_BIN}:${PATH}" \
    WIKI_COMPILE_LOCK_HELD=1 "${DEADLINKS_SH}"
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${output}" == *"/.glass-atrium/data/daemon-reports/"* ]] || { echo "out=${output}" >&2; return 1; }
  [[ "${output}" != *"/.claude/data/daemon-reports/"* ]] || { echo "leaked .claude: ${output}" >&2; return 1; }
  [[ -d "${SANDBOX}/.glass-atrium/data/daemon-reports" ]] || { echo "seam dir not created" >&2; return 1; }
  [[ ! -d "${SANDBOX}/.claude/data/daemon-reports" ]] || { echo ".claude dir created (seam leaked)" >&2; return 1; }
}

@test "wiki-daemon-cycle.sh: no override → daemon-reports under \$HOME/.glass-atrium" {
  # The cycle orchestrator takes the shared /tmp wiki-compile lock unconditionally; a
  # concurrent live daemon holding it makes the run skip BEFORE the store resolves, so
  # a contention skip is treated as inconclusive rather than a false failure.
  run env -u GA_DATA_ROOT -u GA_ROOT HOME="${SANDBOX}" PATH="${FAKE_BIN}:${PATH}" \
    "${CYCLE_SH}" --cycle-only
  [[ "${output}" == *"holds wiki-compile lock"* ]] && skip "wiki-compile lock held by a live daemon"
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${output}" == *"/.glass-atrium/data/daemon-reports/"* ]] || { echo "out=${output}" >&2; return 1; }
  [[ "${output}" != *"/.claude/data/daemon-reports/"* ]] || { echo "leaked .claude: ${output}" >&2; return 1; }
  [[ -d "${SANDBOX}/.glass-atrium/data/daemon-reports" ]] || { echo "seam dir not created" >&2; return 1; }
  [[ ! -d "${SANDBOX}/.claude/data/daemon-reports" ]] || { echo ".claude dir created (seam leaked)" >&2; return 1; }
}

@test "audit-context.sh: no override → audit store under \$HOME/.glass-atrium (scan target stays ~/.claude)" {
  # The audit MEASURES the ~/.claude ecosystem but WRITES to the relocated data store.
  # Seed the ~/.claude threshold precondition so the script reaches the store-resolving
  # mkdir; the stub python3 echoes the resolved CLAUDE_AUDIT_OUT_PATH.
  local skill_dir="${SANDBOX}/.claude/skills/glass-atrium-ops-token-audit"
  mkdir -p -- "${skill_dir}"
  printf 'warn: 1000\nalert: 2000\n' >"${skill_dir}/thresholds.yaml"
  run env -u GA_DATA_ROOT -u GA_ROOT HOME="${SANDBOX}" PATH="${FAKE_BIN}:${PATH}" \
    "${AUDIT_SH}"
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${output}" == *"/.glass-atrium/data/audit/"* ]] || { echo "out=${output}" >&2; return 1; }
  [[ "${output}" != *"/.claude/data/audit/"* ]] || { echo "leaked .claude: ${output}" >&2; return 1; }
  [[ -d "${SANDBOX}/.glass-atrium/data/audit" ]] || { echo "audit store not created" >&2; return 1; }
  [[ ! -d "${SANDBOX}/.claude/data/audit" ]] || { echo ".claude audit dir created (seam leaked)" >&2; return 1; }
}
