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

# Emit the declared roster paths by reading the ONE declaration, in a contained
# subshell. A literal list here would be a second declaration of the fact the single
# declaration exists to hold.
roster_paths() {
  bash -c '
    set -Eeuo pipefail
    # shellcheck source=/dev/null
    source "$1"
    spine_get_roster_paths
  ' _ "${REAL_SPINE}"
}

# Drive update_restore_base_entry DIRECTLY. Arm A takes a capture key rather than a
# live target, and its only production caller is the restore loop that does not yet
# iterate roster paths — so a roster key reaches it here and nowhere else. $1 = key.
run_restore_base_entry() {
  run env GA_ROOT="${ROOT}" AUTOAGENT_BACKUP_DIR="${BAKBASE}" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}" bash -c '
      set -Eeuo pipefail
      # shellcheck source=/dev/null
      source "$1"
      # shellcheck source=/dev/null
      source "$2"
      update_restore_base_entry "$3" "$4" "$5"
    ' _ "${REAL_UPDATE}" "${REAL_SPINE}" "$1" "${CYCLEDIR}" "${STORE}"
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

@test "Arm B restores every declared roster path to the target the index recorded" {
  local rel bn index="${CYCLEDIR}/restore-index.tsv"
  : >"${index}"
  while IFS= read -r rel; do
    bn="${rel##*/}"
    case "${rel}" in */*) mkdir -p "${ROOT}/${rel%/*}" ;; *) ;; esac
    printf 'MERGED %s\n' "${rel}" >"${ROOT}/${rel}"    # the applied body restore reverts AWAY
    printf 'LOCAL %s\n' "${rel}" >"${CYCLEDIR}/${bn}.bak"
    printf '%s\t%s\n' "${bn}.bak" "${rel}" >>"${index}"
  done < <(roster_paths)

  run_restore
  [[ "${status}" -eq 0 ]] || return 1
  while IFS= read -r rel; do
    [[ "$(cat "${ROOT}/${rel}")" == "LOCAL ${rel}" ]] || return 1
  done < <(roster_paths)
  # One declared roster path is a `.md` under a NON-agents directory, so the
  # convention the index replaces would have rebuilt it under agents/ while the real
  # file stayed unrestored. Its absence there is what the index bought.
  [[ ! -e "${ROOT}/agents/scope-dev.md" ]] || return 1
}

@test "a cycle dir with NO index restores agent bodies exactly as the convention did" {
  printf 'BASE RELEASE\n' >"${STORE}/dev-x.md"
  printf 'PRIOR BASE\n' >"${CYCLEDIR}/dev-x.md.base.bak"
  printf 'LOCAL orig\n' >"${CYCLEDIR}/dev-x.md.bak"
  printf 'MERGED body\n' >"${ROOT}/agents/dev-x.md"
  [[ ! -e "${CYCLEDIR}/restore-index.tsv" ]] || return 1 # the fixture IS a pre-index cycle

  run_restore
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(cat "${ROOT}/agents/dev-x.md")" == "LOCAL orig" ]] || return 1 # live body, agents/ convention
  [[ "$(cat "${STORE}/dev-x.md")" == "PRIOR BASE" ]] || return 1       # base reversed under the flat key
}

@test "the restore refuses an index row naming a target outside the install root" {
  printf 'LOCAL orig\n' >"${CYCLEDIR}/dev-x.md.bak"
  printf '%s\t%s\n' 'dev-x.md.bak' '../escape.md' >"${CYCLEDIR}/restore-index.tsv"

  run_restore
  [[ "${status}" -ne 0 ]] || return 1
  [[ "${output}" == *"outside the install root"* ]] || return 1
  [[ ! -e "${SANDBOX}/escape.md" ]] || return 1
}

@test "Arm A reverses a ROSTER base entry against its PATH key, leaving the flat namespace alone" {
  local rel='hooks/lib/styleref-roster.sh' bn='styleref-roster.sh'
  local roster_store="${STATE}/base-roster"
  mkdir -p "${roster_store}/hooks/lib"
  printf 'ROSTER RELEASE\n' >"${roster_store}/${rel}"
  # The before-image sink is one flat directory, so the snapshot is keyed by basename
  # while the store entry it reverses is keyed by path.
  printf 'ROSTER BASE v0\n' >"${CYCLEDIR}/${bn}.base.bak"
  # A flat entry under the same basename: a roster key must not reach it.
  printf 'AGENT BASE\n' >"${STORE}/${bn}"

  run_restore_base_entry "${rel}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(cat "${roster_store}/${rel}")" == "ROSTER BASE v0" ]] || return 1
  [[ "$(cat "${STORE}/${bn}")" == "AGENT BASE" ]] || return 1

  # No snapshot → DELETE the entry (safe gated 2-way), still under the path key.
  rm -f "${CYCLEDIR}/${bn}.base.bak"
  printf 'ROSTER RELEASE\n' >"${roster_store}/${rel}"
  run_restore_base_entry "${rel}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -e "${roster_store}/${rel}" ]] || return 1
  [[ -f "${STORE}/${bn}" ]] || return 1
}
