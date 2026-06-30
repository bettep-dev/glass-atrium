#!/usr/bin/env bats
# lib/git-txn.sh — git_txn_apply transaction suite. Pins the structured outcome
# (GIT_TXN_RC) and the git-state rollback for each of the 6 paths the daemon's
# apply_patch_rows row loop maps to its counter buckets:
#   GIT_TXN_OK            → apply commit at HEAD, WIP snapshot at HEAD~1, file changed
#   GIT_TXN_SNAPSHOT_FAIL → WIP commit blocked → HEAD unchanged, NO rollback needed
#   GIT_TXN_APPLY_REGEN   → apply cb rc 3 → WIP rolled back, tree clean, file unchanged
#   GIT_TXN_APPLY_FAIL    → apply cb rc !=0,3 → WIP rolled back, tree clean
#   GIT_TXN_VERIFY_FAIL   → verify cb fails → working tree restored + WIP rolled back
#   GIT_TXN_COMMIT_FAIL   → apply commit fails → WIP rolled back
# Also pins the "set -e contract": git_txn_apply returns 0 on every handled
# outcome (so a bare call under the daemon's set -Eeuo pipefail never aborts).
#
# Run via: bats autoagent/test/git-txn.bats
# Requires: bats >= 1.5.0, bash 3.2+, git
#
# Hermetic: a per-test standalone git repo under a realpath-resolved temp root.
# git_txn_apply touches only git + its injected callbacks, so no PATH masking,
# no psql, no live agents/ dir is involved.

bats_require_minimum_version 1.5.0

LIB="${HOME}/.glass-atrium/autoagent/lib/git-txn.sh"

setup() {
  [[ -f "${LIB}" ]] || skip "git-txn.sh not found: ${LIB}"
  # pwd -P resolves /var -> /private/var so any future containment check passes.
  WORK="$(cd -- "$(mktemp -d -t git-txn-bats.XXXXXX)" && pwd -P)"
  REPO="${WORK}/repo"
  TARGET="${REPO}/probe.md"
  mkdir -p "${REPO}"
  git -C "${REPO}" init -q
  git -C "${REPO}" config user.email bats@test.local
  git -C "${REPO}" config user.name bats
  printf '%s\n' '# Probe Agent' 'original line' >"${TARGET}"
  git -C "${REPO}" add -A
  git -C "${REPO}" commit -qm "fixture"
  HEAD_BEFORE="$(git -C "${REPO}" rev-parse HEAD)"
  # shellcheck source=/dev/null
  source "${LIB}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}"
}

# -- Injected callback stubs (apply_fn / verify_fn). The lib calls
#    apply_fn target diff label diff_target  and  verify_fn target. ----------
_apply_ok() {
  printf '%s\n' 'inserted line' >>"$1"
  return 0
}
_apply_noop() { return 0; } # leaves the file unchanged → nothing staged to commit
_apply_regen() { return 3; }
_apply_malformed() { return 1; }
_verify_ok() { return 0; }
_verify_fail() { return 1; }

# tree_is_clean — 0 when the worktree has no uncommitted change.
tree_is_clean() {
  [[ -z "$(git -C "${REPO}" status --porcelain)" ]]
}

# ---------------------------------------------------------------------------
# (a) success → GIT_TXN_OK
# ---------------------------------------------------------------------------
@test "OK: apply commit lands at HEAD, WIP at HEAD~1, messages + file content correct" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${REPO}" "${TARGET}" "${TARGET}" "the-diff" \
    "WIP snapshot msg" "AUTO apply msg" \
    _apply_ok _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]                          # bare-call-safe contract
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_OK}" ]
  # apply commit at HEAD, WIP snapshot at HEAD~1
  [ "$(git -C "${REPO}" log -1 --format=%s HEAD)" = "AUTO apply msg" ]
  [ "$(git -C "${REPO}" log -1 --format=%s HEAD~1)" = "WIP snapshot msg" ]
  [ "$(git -C "${REPO}" rev-parse HEAD~2)" = "${HEAD_BEFORE}" ]
  # file change committed, worktree clean
  grep -q 'inserted line' "${TARGET}"
  tree_is_clean
}

# ---------------------------------------------------------------------------
# (b) WIP snapshot commit fails → GIT_TXN_SNAPSHOT_FAIL, no rollback
# ---------------------------------------------------------------------------
@test "SNAPSHOT_FAIL: blocked WIP commit leaves HEAD unchanged (nothing to roll back)" {
  # A pre-commit hook that always rejects blocks the FIRST (WIP) commit, so the
  # transaction returns before apply — exactly the snapshot-fail path.
  mkdir -p "${REPO}/.git/hooks"
  printf '%s\n' '#!/bin/sh' 'exit 1' >"${REPO}/.git/hooks/pre-commit"
  chmod +x "${REPO}/.git/hooks/pre-commit"

  GIT_TXN_RC=999
  git_txn_apply \
    "${REPO}" "${TARGET}" "${TARGET}" "the-diff" \
    "WIP snapshot msg" "AUTO apply msg" \
    _apply_ok _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_SNAPSHOT_FAIL}" ]
  # No commit happened; HEAD is exactly the fixture commit.
  [ "$(git -C "${REPO}" rev-parse HEAD)" = "${HEAD_BEFORE}" ]
}

# ---------------------------------------------------------------------------
# (c) apply callback rc 3 → GIT_TXN_APPLY_REGEN, WIP rolled back
# ---------------------------------------------------------------------------
@test "APPLY_REGEN: apply rc 3 rolls back the WIP commit, tree clean, file unchanged" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${REPO}" "${TARGET}" "${TARGET}" "the-diff" \
    "WIP snapshot msg" "AUTO apply msg" \
    _apply_regen _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_APPLY_REGEN}" ]
  # WIP snapshot dropped (reset --soft HEAD~1) → HEAD back at the fixture commit.
  [ "$(git -C "${REPO}" rev-parse HEAD)" = "${HEAD_BEFORE}" ]
  ! grep -q 'inserted line' "${TARGET}"
  tree_is_clean
}

# ---------------------------------------------------------------------------
# (d) apply callback rc !=0,3 → GIT_TXN_APPLY_FAIL, WIP rolled back
# ---------------------------------------------------------------------------
@test "APPLY_FAIL: malformed apply (rc 1) rolls back the WIP commit, tree clean" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${REPO}" "${TARGET}" "${TARGET}" "the-diff" \
    "WIP snapshot msg" "AUTO apply msg" \
    _apply_malformed _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_APPLY_FAIL}" ]
  [ "$(git -C "${REPO}" rev-parse HEAD)" = "${HEAD_BEFORE}" ]
  tree_is_clean
}

# ---------------------------------------------------------------------------
# (e) verify callback fails → GIT_TXN_VERIFY_FAIL, working tree restored
# ---------------------------------------------------------------------------
@test "VERIFY_FAIL: verify failure restores the working tree + rolls back the WIP commit" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${REPO}" "${TARGET}" "${TARGET}" "the-diff" \
    "WIP snapshot msg" "AUTO apply msg" \
    _apply_ok _verify_fail "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_VERIFY_FAIL}" ]
  # checkout restored the applied bytes; reset --soft dropped the WIP commit.
  [ "$(git -C "${REPO}" rev-parse HEAD)" = "${HEAD_BEFORE}" ]
  ! grep -q 'inserted line' "${TARGET}"
  tree_is_clean
}

# ---------------------------------------------------------------------------
# (f) apply commit fails → GIT_TXN_COMMIT_FAIL, WIP rolled back
# ---------------------------------------------------------------------------
@test "COMMIT_FAIL: a failing apply commit rolls back the WIP commit" {
  # _apply_noop leaves the file unchanged, so after the WIP snapshot there is
  # nothing staged → the apply commit fails ('nothing to commit'). The lib does
  # not care WHY the commit failed; this faithfully drives its commit-fail branch.
  GIT_TXN_RC=999
  git_txn_apply \
    "${REPO}" "${TARGET}" "${TARGET}" "the-diff" \
    "WIP snapshot msg" "AUTO apply msg" \
    _apply_noop _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_COMMIT_FAIL}" ]
  [ "$(git -C "${REPO}" rev-parse HEAD)" = "${HEAD_BEFORE}" ]
  tree_is_clean
}
