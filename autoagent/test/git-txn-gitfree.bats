#!/usr/bin/env bats
# lib/git-txn.sh — git-FREE file-copy transaction suite (P1-T1). Pins the new
# before-image -> apply -> verify -> (leave | atomic restore) transaction and the
# remapped GIT_TXN_RC outcomes:
#   GIT_TXN_OK                 → applied bytes stay, before-image left in backup dir
#   GIT_TXN_BACKUP_CAPTURE_FAIL→ capture aborts BEFORE apply, target untouched
#   GIT_TXN_APPLY_REGEN        → apply cb rc 3 → no bytes, target unchanged
#   GIT_TXN_APPLY_FAIL         → apply cb rc !=0,3 OR multi-file diff → target unchanged
#   GIT_TXN_VERIFY_FAIL        → verify cb fails → target restored byte-for-byte
# Also pins: the "set -e contract" (git_txn_apply returns 0 on every HANDLED
# outcome), the wrong-arity / non-function-callback loud-fail (NON-zero return),
# the atomic temp+rename restore (inode changes → no in-place truncate-write), and
# the single-file scope guard.
#
# Run via: bats autoagent/test/git-txn-gitfree.bats
# Requires: bats >= 1.5.0, bash 3.2+
#
# MECHANICAL git-free PROOF: a PATH-front `git` shim delegates ONLY `git apply` to
# real git and HARD-FAILS every other git subcommand. The shim is active for ALL
# tests, so if the lib made ANY non-apply git call the corresponding test would
# break. The fixture tree is NOT a git repo — the transaction must run without one.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
LIB="${GA}/autoagent/lib/git-txn.sh"

setup() {
  [[ -f "${LIB}" ]] || skip "git-txn.sh not found: ${LIB}"

  # Resolve the REAL git BEFORE we mask $PATH with the allow-only-apply shim.
  REAL_GIT="$(command -v git)"

  # pwd -P resolves /var -> /private/var so sibling-temp rename stays same-FS.
  WORK="$(cd -- "$(mktemp -d -t git-txn-gitfree.XXXXXX)" && pwd -P)"
  INSTALL_ROOT="${WORK}/tree"
  TARGET="${INSTALL_ROOT}/probe.md"
  BACKUP_DIR="${WORK}/agents-bak/2026-07-01_p42"
  mkdir -p -- "${INSTALL_ROOT}"

  # Fixture target content + a pristine snapshot for byte-for-byte comparison.
  printf '%s\n' '# Probe Agent' 'original line' >"${TARGET}"
  PRISTINE="${WORK}/pristine.md"
  cp -p -- "${TARGET}" "${PRISTINE}"

  # git shim: allow ONLY `git apply`, hard-fail everything else.
  mkdir -p -- "${WORK}/bin"
  cat >"${WORK}/bin/git" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == "apply" ]]; then
  exec "${REAL_GIT}" "\$@"
fi
printf 'git-shim: BLOCKED non-apply git subcommand: %s\n' "\$1" >&2
exit 97
EOF
  chmod +x "${WORK}/bin/git"
  PATH="${WORK}/bin:${PATH}"

  # shellcheck source=/dev/null
  source "${LIB}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# -- Injected callback stubs. The lib calls apply_fn target diff label diff_target
#    and verify_fn target. ------------------------------------------------------
_apply_ok() {
  printf '%s\n' 'inserted line' >>"$1"
  return 0
}
_apply_regen() { return 3; }
_apply_malformed() { return 1; }
_verify_ok() { return 0; }
_verify_fail() { return 1; }

# _apply_via_gitapply — apply the diff through REAL `git apply` (via the shim), in
#    a NON-git tree. Proves `git apply` is the ONLY git call the transaction path
#    ever makes and that it works with no worktree.
_apply_via_gitapply() {
  local target="$1" diff="$2"
  local dir tmp rc
  dir="$(dirname -- "${target}")"
  tmp="$(mktemp -t git-txn-diff.XXXXXX)"
  printf '%s\n' "${diff}" >"${tmp}"
  (cd "${dir}" && git apply --recount --whitespace=nowarn "${tmp}")
  rc=$?
  rm -f -- "${tmp}"
  return "${rc}"
}

# inode number, portable across BSD (macOS) and GNU stat.
_inode_of() {
  stat -f '%i' "$1" 2>/dev/null || stat -c '%i' "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
# (1) success leaves the applied content, before-image captured
# ---------------------------------------------------------------------------
@test "OK: success leaves applied bytes and captures the before-image" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${BACKUP_DIR}" _apply_ok _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ] # bare-call-safe (set -e) contract
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_OK}" ]
  grep -q 'inserted line' "${TARGET}" # applied bytes remain
  [ -f "${BACKUP_DIR}/probe.md.bak" ] # before-image in caller backup dir
  # before-image holds the PRE-apply content (captured before apply ran)
  cmp -s "${PRISTINE}" "${BACKUP_DIR}/probe.md.bak"
}

# ---------------------------------------------------------------------------
# (2) success via REAL `git apply` — git-free proof (only apply reaches git)
# ---------------------------------------------------------------------------
@test "OK: transaction completes with a real git-apply callback in a NON-git tree" {
  local diff
  diff="$(printf '%s\n' \
    '--- a/probe.md' '+++ b/probe.md' '@@ -1,2 +1,3 @@' \
    ' # Probe Agent' ' original line' '+inserted line')"

  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "${diff}" \
    "${BACKUP_DIR}" _apply_via_gitapply _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_OK}" ]
  grep -q 'inserted line' "${TARGET}"
}

# ---------------------------------------------------------------------------
# (3) verify-fail restores the target byte-for-byte from the before-image
# ---------------------------------------------------------------------------
@test "VERIFY_FAIL: verify failure restores the target byte-for-byte" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${BACKUP_DIR}" _apply_ok _verify_fail "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_VERIFY_FAIL}" ]
  # target === pristine pre-apply content, byte for byte
  cmp -s "${PRISTINE}" "${TARGET}"
  ! grep -q 'inserted line' "${TARGET}"
}

# ---------------------------------------------------------------------------
# (4) atomicity regression: restore swaps via rename (inode changes), never
#     an in-place truncate-write. A crash between write and rename therefore
#     cannot leave the target truncated.
# ---------------------------------------------------------------------------
@test "VERIFY_FAIL: restore is an atomic rename (target inode changes)" {
  local ino_before ino_after
  ino_before="$(_inode_of "${TARGET}")"

  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${BACKUP_DIR}" _apply_ok _verify_fail "lbl" "${TARGET}"

  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_VERIFY_FAIL}" ]
  ino_after="$(_inode_of "${TARGET}")"
  [ -n "${ino_before}" ] && [ -n "${ino_after}" ]
  [ "${ino_before}" != "${ino_after}" ] # rename swapped a fresh file in
  # no leftover rollback temp beside the target
  ! ls "${TARGET}".rollback.* >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# (5) apply rc 3 → APPLY_REGEN, no bytes written, target unchanged
# ---------------------------------------------------------------------------
@test "APPLY_REGEN: apply rc 3 leaves the target unchanged (no bytes)" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${BACKUP_DIR}" _apply_regen _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_APPLY_REGEN}" ]
  cmp -s "${PRISTINE}" "${TARGET}"
}

# ---------------------------------------------------------------------------
# (6) apply rc !=0,3 (malformed) → APPLY_FAIL, target unchanged
# ---------------------------------------------------------------------------
@test "APPLY_FAIL: malformed apply (rc 1) leaves the target unchanged" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${BACKUP_DIR}" _apply_malformed _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_APPLY_FAIL}" ]
  cmp -s "${PRISTINE}" "${TARGET}"
}

# ---------------------------------------------------------------------------
# (7) single-file scope guard rejects a multi-file diff BEFORE any apply
# ---------------------------------------------------------------------------
@test "APPLY_FAIL: multi-file diff is rejected by the single-file guard, no apply" {
  local multi
  multi="$(printf '%s\n' \
    '--- a/foo.md' '+++ b/foo.md' '@@ -1 +1,2 @@' ' x' '+y' \
    '--- a/bar.md' '+++ b/bar.md' '@@ -1 +1,2 @@' ' a' '+b')"

  GIT_TXN_RC=999
  # _apply_ok would append 'inserted line' IF ever called — assert it is NOT.
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "${multi}" \
    "${BACKUP_DIR}" _apply_ok _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_APPLY_FAIL}" ]
  cmp -s "${PRISTINE}" "${TARGET}" # apply never ran
  ! grep -q 'inserted line' "${TARGET}"
}

# ---------------------------------------------------------------------------
# (7b) DF-1: a diff whose '+++' header basename mismatches the transaction target
#      is refused BEFORE any apply — the wrong-file-mutation guard. Without it a
#      '+++ b/other.md' diff would mutate another agent body while the before-
#      image/verify (bound to THIS target) pass vacuously.
# ---------------------------------------------------------------------------
@test "APPLY_FAIL: mismatched-header diff is refused before apply (wrong-file guard)" {
  local wrong
  wrong="$(printf '%s\n' \
    '--- a/other.md' '+++ b/other.md' '@@ -1,2 +1,3 @@' \
    ' # Probe Agent' ' original line' '+inserted line')"

  GIT_TXN_RC=999
  # _apply_ok would append 'inserted line' IF ever called — assert it is NOT.
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "${wrong}" \
    "${BACKUP_DIR}" _apply_ok _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_APPLY_FAIL}" ]
  cmp -s "${PRISTINE}" "${TARGET}" # apply never ran, target untouched
  ! grep -q 'inserted line' "${TARGET}"
  [ ! -f "${BACKUP_DIR}/probe.md.bak" ] # rejected before before-image capture
}

# ---------------------------------------------------------------------------
# (7c) DF-1: a MATCHED '+++' header basename proceeds unchanged (no false reject).
# ---------------------------------------------------------------------------
@test "OK: matched-header diff proceeds unchanged (basename guard passes)" {
  local matched
  matched="$(printf '%s\n' \
    '--- a/probe.md' '+++ b/probe.md' '@@ -1,2 +1,3 @@' \
    ' # Probe Agent' ' original line' '+inserted line')"

  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "${matched}" \
    "${BACKUP_DIR}" _apply_via_gitapply _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_OK}" ]
  grep -q 'inserted line' "${TARGET}"
}

# ---------------------------------------------------------------------------
# (7d) DF-1: a header-LESS append-only fragment (Strategy B) asserts no target,
#      so the basename guard passes it (empty basename → not a mismatch).
# ---------------------------------------------------------------------------
@test "OK: header-less fragment passes the basename guard (no +++ header)" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${BACKUP_DIR}" _apply_ok _verify_ok "lbl" "${TARGET}"

  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_OK}" ]
  grep -q 'inserted line' "${TARGET}"
}

# ---------------------------------------------------------------------------
# (8) before-image capture failure aborts BEFORE apply → BACKUP_CAPTURE_FAIL
# ---------------------------------------------------------------------------
@test "BACKUP_CAPTURE_FAIL: uncreatable backup dir aborts before apply" {
  # A regular FILE where the backup dir's parent must be → mkdir -p fails.
  local blocker="${WORK}/blocker"
  : >"${blocker}"
  local bad_backup="${blocker}/p42"

  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${bad_backup}" _apply_ok _verify_ok "lbl" "${TARGET}"
  local fn_status=$?

  [ "${fn_status}" -eq 0 ]
  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_BACKUP_CAPTURE_FAIL}" ]
  cmp -s "${PRISTINE}" "${TARGET}" # apply never ran
  ! grep -q 'inserted line' "${TARGET}"
}

# ---------------------------------------------------------------------------
# (9) before-image is written into the caller-provided backup dir (explicit)
# ---------------------------------------------------------------------------
@test "before-image lands at BACKUP_DIR/<name>.bak with pre-apply bytes" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${BACKUP_DIR}" _apply_ok _verify_ok "lbl" "${TARGET}"

  [ "${GIT_TXN_RC}" -eq "${GIT_TXN_OK}" ]
  [ -f "${BACKUP_DIR}/probe.md.bak" ]
  cmp -s "${PRISTINE}" "${BACKUP_DIR}/probe.md.bak"
}

# ---------------------------------------------------------------------------
# (10) wrong-arity loud-fail — NON-zero return (contract violation)
# ---------------------------------------------------------------------------
@test "arity guard: too few args returns non-zero (loud-fail)" {
  run git_txn_apply "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" "${BACKUP_DIR}" _apply_ok
  [ "${status}" -ne 0 ]
}

@test "arity guard: old 10-arg shape returns non-zero (loud-fail)" {
  run git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "wip msg" "apply msg" _apply_ok _verify_ok "lbl" "${TARGET}"
  [ "${status}" -ne 0 ]
}

# ---------------------------------------------------------------------------
# (11) non-function callback loud-fail — NON-zero return (shape violation)
# ---------------------------------------------------------------------------
@test "shape guard: a non-function apply_fn returns non-zero (loud-fail)" {
  run git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${BACKUP_DIR}" not_a_function _verify_ok "lbl" "${TARGET}"
  [ "${status}" -ne 0 ]
}

# ---------------------------------------------------------------------------
# (12) static git-free proof: no non-apply git subcommand in the transaction
#      lib OR its two callers (daemon-apply.sh, update.sh). The optional
#      `-C <dir>` alternative catches the daemon's `git -C <root> <sub>` call
#      shape — `git apply` is the ONLY sanctioned invocation. The tree keeps
#      comments clean of these tokens too, so no comment-stripping is needed
#      (unlike update-pause-flag.bats's stat -f / stat -c static check).
# ---------------------------------------------------------------------------
@test "static: git-txn.sh, daemon-apply.sh, update.sh contain no non-apply git subcommand" {
  local daemon="${GA}/autoagent/daemon-apply.sh"
  local update="${GA}/scripts/update.sh"
  [[ -f "${daemon}" ]]
  [[ -f "${update}" ]]
  run grep -nE 'git +(-C +[^ ]+ +)?(commit|checkout|reset|stash|rev-parse|switch|symbolic-ref|status)' \
    "${LIB}" "${daemon}" "${update}"
  [ "${status}" -ne 0 ] # grep finds nothing → non-zero
}
