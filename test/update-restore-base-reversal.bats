#!/usr/bin/env bats
# update.sh --restore-agents base-content store reversal (finding #9 part 4).
#
# Finding #9 made the FORWARD base-content capture outcome-keyed. Part 4 closes the
# REVERSE side: --restore-agents must reverse the base-content store alongside the live
# agent body, or the next update's 3-way merge is left keyed on the reverted-away
# RELEASE base (a stale/poisoned anchor). Two coordinated halves under test:
#   * capture (update_capture_base_content) — before overwriting a PRIOR base entry it
#     snapshots the prior base into <cycle>/<name>.md.base.bak, beside the live
#     <name>.md.bak before-image (gated on that .md.bak existing = a git_txn-applied,
#     restorable file).
#   * restore (update_restore_agents) — after reverting the live body from <name>.md.bak
#     it reverses the base store: a .base.bak snapshot → restore it; NO snapshot (first
#     base for this agent) → DELETE the base entry so the next merge falls back to the
#     safe gated 2-way path.
# FAIL-BEFORE (the bug this pins): pre-fix, restore reverts ONLY the live body and the
# base store keeps the RELEASE body → next 3-way merge anchors on the wrong base.
#
# Every assertion is gated `|| return 1`: this bats version fails a test ONLY on the
# LAST command's status, so a bare mid-body `[[ ]]` would be silently ignored.
#
# Run via: bats test/update-restore-base-reversal.bats
# Requires: bats (brew install bats-core), python3 (update_realpath / prune mtime), bash 3.2+
#
# Hermetic strategy: update.sh + apply-spine.sh are SOURCED inside a `run bash -c`
# subshell so their strict-mode ERR trap stays contained (never leaks into the bats
# shell), and the BASH_SOURCE==$0 guard keeps update_main from running. All state is
# env-seamed into a mktemp sandbox (GA_ROOT / AUTOAGENT_BACKUP_DIR / ATRIUM_UPDATE_STATE_DIR);
# update_serialize_begin is stubbed to a no-op so the test never touches the real
# pause-flag / apply-lock infra. Nothing touches ~/.claude or the live ~/.glass-atrium.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_UPDATE="${GA}/scripts/update.sh"
REAL_SPINE="${GA}/scripts/lib/apply-spine.sh"

setup() {
  command -v python3 >/dev/null 2>&1 || skip "python3 required (update_realpath / prune mtime)"
  [[ -f "${REAL_UPDATE}" ]] || skip "updater not found: ${REAL_UPDATE}"
  [[ -f "${REAL_SPINE}" ]] || skip "apply-spine not found: ${REAL_SPINE}"

  SANDBOX="$(mktemp -d -t ga-restore-base.XXXXXX)"
  ROOT="${SANDBOX}/root"                 # live install root (holds agents/)
  STATE="${SANDBOX}/state"               # ATRIUM_UPDATE_STATE_DIR (base-content store parent)
  BAKBASE="${SANDBOX}/agents-bak"        # AUTOAGENT_BACKUP_DIR (per-run cycle dirs live here)
  NEWDIR="${SANDBOX}/new"                # staged new-release tree
  STORE="${STATE}/base-agents"           # the base-content store dir (spine layout)
  CYCLE="2026-07-13_update-1.0.1"        # a plain <cycle_date>_update-<version> token
  CYCLEDIR="${BAKBASE}/${CYCLE}"
  LEDGER="${SANDBOX}/agent-outcomes.ledger"
  mkdir -p "${ROOT}/agents" "${STORE}" "${CYCLEDIR}" "${NEWDIR}/agents"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# Drive update_capture_base_content in an isolated strict-mode subshell. The per-run
# cycle dir + outcome ledger are injected as the globals the forward merge sets.
run_capture() {
  run env GA_ROOT="${ROOT}" AUTOAGENT_BACKUP_DIR="${BAKBASE}" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}" bash -c '
      set -Eeuo pipefail
      # shellcheck source=/dev/null
      source "$1"
      # shellcheck source=/dev/null
      source "$2"
      _update_agent_backup_dir="$3"
      _update_agent_outcomes_file="$4"
      update_capture_base_content "$5"
    ' _ "${REAL_UPDATE}" "${REAL_SPINE}" "${CYCLEDIR}" "${LEDGER}" "${NEWDIR}"
}

# Drive update_restore_agents in an isolated strict-mode subshell; the pause/lock
# serialization is stubbed to a no-op (orthogonal to the base-reversal logic under test).
run_restore() {
  run env GA_ROOT="${ROOT}" AUTOAGENT_BACKUP_DIR="${BAKBASE}" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}" bash -c '
      set -Eeuo pipefail
      # shellcheck source=/dev/null
      source "$1"
      # shellcheck source=/dev/null
      source "$2"
      update_serialize_begin() { :; }
      update_restore_agents "$3"
    ' _ "${REAL_UPDATE}" "${REAL_SPINE}" "${CYCLE}"
}

@test "capture snapshots the PRIOR base into <name>.md.base.bak before advancing" {
  printf 'BASE v0\n' >"${STORE}/dev-x.md"            # prior base entry
  printf 'LOCAL orig\n' >"${CYCLEDIR}/dev-x.md.bak"  # live before-image → file is restorable
  printf 'RELEASE v1\n' >"${NEWDIR}/agents/dev-x.md" # release body → store advances to this
  printf 'dev-x.md\n' >"${LEDGER}"                   # outcome ledger lists the landed merge

  run_capture
  [[ "${status}" -eq 0 ]] || return 1
  # store advanced to the release body
  [[ "$(cat "${STORE}/dev-x.md")" == "RELEASE v1" ]] || return 1
  # the prior base was snapshotted beside the live before-image (the reversal artifact)
  [[ -f "${CYCLEDIR}/dev-x.md.base.bak" ]] || return 1
  [[ "$(cat "${CYCLEDIR}/dev-x.md.base.bak")" == "BASE v0" ]] || return 1
}

@test "capture does NOT snapshot a base for a file with no live before-image (unrestorable)" {
  printf 'BASE v0\n' >"${STORE}/dev-y.md"            # prior base exists
  # NO ${CYCLEDIR}/dev-y.md.bak — a byte-identical / no-net-change advance is not restorable
  printf 'RELEASE v1\n' >"${NEWDIR}/agents/dev-y.md"
  printf 'dev-y.md\n' >"${LEDGER}"

  run_capture
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(cat "${STORE}/dev-y.md")" == "RELEASE v1" ]] || return 1 # still advances the store
  [[ ! -e "${CYCLEDIR}/dev-y.md.base.bak" ]] || return 1         # but writes no orphan base snapshot
}

@test "restore reverts the live body AND the base entry from the snapshot (fail-before: base stays stale)" {
  printf 'BASE v0\n' >"${STORE}/dev-x.md"
  printf 'LOCAL orig\n' >"${CYCLEDIR}/dev-x.md.bak"
  printf 'MERGED body\n' >"${ROOT}/agents/dev-x.md"  # the applied merge result restore reverts AWAY
  printf 'RELEASE v1\n' >"${NEWDIR}/agents/dev-x.md"
  printf 'dev-x.md\n' >"${LEDGER}"

  run_capture
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(cat "${STORE}/dev-x.md")" == "RELEASE v1" ]] || return 1 # store now holds the release base

  run_restore
  [[ "${status}" -eq 0 ]] || return 1
  # the live agent body is reverted to the original local (from <name>.md.bak)
  [[ "$(cat "${ROOT}/agents/dev-x.md")" == "LOCAL orig" ]] || return 1
  # THE FIX: the base-content store is reversed to the prior base (NOT left at RELEASE v1)
  [[ "$(cat "${STORE}/dev-x.md")" == "BASE v0" ]] || return 1
}

@test "restore with NO prior base snapshot DELETES the base entry (safe gated 2-way fallback)" {
  # No ${STORE}/dev-x.md initially → capture creates a FIRST base with no .base.bak.
  printf 'LOCAL orig\n' >"${CYCLEDIR}/dev-x.md.bak"
  printf 'MERGED body\n' >"${ROOT}/agents/dev-x.md"
  printf 'RELEASE v1\n' >"${NEWDIR}/agents/dev-x.md"
  printf 'dev-x.md\n' >"${LEDGER}"

  run_capture
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(cat "${STORE}/dev-x.md")" == "RELEASE v1" ]] || return 1 # first base created
  [[ ! -e "${CYCLEDIR}/dev-x.md.base.bak" ]] || return 1         # no prior → no snapshot

  run_restore
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(cat "${ROOT}/agents/dev-x.md")" == "LOCAL orig" ]] || return 1 # live reverted
  # THE FALLBACK: the poisoned RELEASE base entry is DELETED (load_base_text → None)
  [[ ! -e "${STORE}/dev-x.md" ]] || return 1
}
