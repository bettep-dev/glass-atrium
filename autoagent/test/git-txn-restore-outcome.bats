#!/usr/bin/env bats
# git-txn-restore-outcome.bats — T1c fail-at-HEAD coverage for T11 (Propagate
# rollback outcome). This suite is the ACCEPTANCE SPEC the T11 DEV implements
# against, at the git-txn.sh function boundary.
#
# THE DEFECT (HEAD a627de7): git_txn_apply emits the verify-fail signal
# IDENTICALLY whether the atomic restore SUCCEEDED (target back to pristine) or
# FAILED (target still holds applied bytes) — both collapse to GIT_TXN_VERIFY_FAIL
# (git-txn.sh:321-324, the restore rc is swallowed by `|| true`). A restore
# failure firing into an uninterpretable signal is half a fix.
#
# CONTRACT DEFINED HERE (the T11 DEV conforms to these names):
#   GIT_TXN_RESTORE_FAIL   NEW GIT_TXN_RC outcome constant, distinct from
#                          GIT_TXN_VERIFY_FAIL, set when verify fails AND the
#                          atomic restore also fails.
#   The restore-SUCCEEDED path keeps GIT_TXN_VERIFY_FAIL — so the RC value itself
#   is the restore-succeeded-vs-restore-failed discriminator (AC: verify-fail with
#   a restore-succeeded discriminator).
#
# FAIL-AT-HEAD (RED against a627de7, GREEN after T11):
#   * verify-fail + restore FAILS → GIT_TXN_RC is distinct from GIT_TXN_VERIFY_FAIL.
#   * the new GIT_TXN_RESTORE_FAIL constant is defined and GIT_TXN_RC equals it.
# REGRESSION GUARDS (GREEN at HEAD and after):
#   * verify-fail + restore SUCCEEDS → GIT_TXN_RC == GIT_TXN_VERIFY_FAIL and the
#     target is restored byte-for-byte (the discriminator's other arm).
#   * verify-fail + restore FAILS → the before-image is preserved (recovery anchor).
#   * git_txn_apply still returns 0 on the restore-fail handled outcome (set -e
#     bare-call contract).
#
# NOTE (scope): routing the distinct signal to JSONL + monitor and mapping it to
# a distinct non-zero daemon EXIT code is T11's daemon-apply.sh CALLER work
# (apply_patch_rows); this suite pins the git-txn.sh outcome-code split that the
# caller routes on. Run via: bats autoagent/test/git-txn-restore-outcome.bats
#
# Hermetic: a temp fixture tree (NOT a git repo) + a git shim that hard-fails any
# non-apply git subcommand. Restore failure is forced deterministically by making
# the target's parent directory read-only inside the verify callback, so the
# atomic sibling-temp copy cannot be created — the before-image (in the separate
# backup dir) stays intact.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
LIB="${GA}/autoagent/lib/git-txn.sh"

setup() {
  [[ -f "${LIB}" ]] || skip "git-txn.sh not found: ${LIB}"
  REAL_GIT="$(command -v git)"
  WORK="$(cd -- "$(mktemp -d -t git-txn-restore.XXXXXX)" && pwd -P)"
  INSTALL_ROOT="${WORK}/tree"
  TARGET="${INSTALL_ROOT}/probe.md"
  BACKUP_DIR="${WORK}/agents-bak/2026-07-22_p290"
  mkdir -p -- "${INSTALL_ROOT}"
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
  # Restore write perms first — a sabotage test leaves INSTALL_ROOT read-only,
  # which would otherwise block rm -rf from deleting its contents.
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && chmod -R u+w "${WORK}" 2>/dev/null
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Injected callbacks — the lib calls apply_fn target diff label diff_target and
# verify_fn target.
_apply_ok() {
  printf '%s\n' 'inserted line' >>"$1"
  return 0
}
_verify_fail_clean() { return 1; }
# Sabotage the restore: make the target's parent dir read-only so the sibling
# temp copy in _git_txn_restore cannot be created → restore fails. The
# before-image lives in BACKUP_DIR (a different dir) and stays intact.
_verify_fail_sabotage() {
  # dirname output is a controlled absolute path (no leading dash), and BSD chmod
  # does not accept a `--` end-of-options guard, so it is omitted here.
  chmod a-w "$(dirname -- "$1")"
  return 1
}

# --- REGRESSION GUARD: restore SUCCEEDS → verify-fail RC + byte-for-byte restore ---

@test "restore SUCCEEDS → GIT_TXN_RC is GIT_TXN_VERIFY_FAIL and the target is restored" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${BACKUP_DIR}" _apply_ok _verify_fail_clean "lbl" "${TARGET}"
  local fn_status=$?
  [[ "${fn_status}" -eq 0 ]] || { echo "bare-call contract: expected 0, got ${fn_status}" >&2; return 1; }
  [[ "${GIT_TXN_RC}" -eq "${GIT_TXN_VERIFY_FAIL}" ]] || { echo "expected VERIFY_FAIL on a clean restore, got ${GIT_TXN_RC}" >&2; return 1; }
  cmp -s "${PRISTINE}" "${TARGET}" || { echo "target was not restored byte-for-byte" >&2; return 1; }
}

# --- FAIL-AT-HEAD: restore FAILS → RC distinct from verify-fail ---

@test "restore FAILS → GIT_TXN_RC is distinct from GIT_TXN_VERIFY_FAIL [FAIL-AT-HEAD: HEAD collapses both to 13]" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${BACKUP_DIR}" _apply_ok _verify_fail_sabotage "lbl" "${TARGET}"
  local fn_status=$?
  [[ "${fn_status}" -eq 0 ]] || { echo "bare-call contract: expected 0 on the handled restore-fail outcome, got ${fn_status}" >&2; return 1; }
  [[ "${GIT_TXN_RC}" != "${GIT_TXN_VERIFY_FAIL}" ]] || { echo "restore-fail must NOT reuse the verify-fail RC ${GIT_TXN_VERIFY_FAIL}" >&2; return 1; }
}

@test "restore FAILS → the new GIT_TXN_RESTORE_FAIL constant is defined and GIT_TXN_RC equals it [FAIL-AT-HEAD]" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${BACKUP_DIR}" _apply_ok _verify_fail_sabotage "lbl" "${TARGET}"
  [[ -n "${GIT_TXN_RESTORE_FAIL:-}" ]] || { echo "GIT_TXN_RESTORE_FAIL constant is not defined by the lib" >&2; return 1; }
  [[ "${GIT_TXN_RC}" == "${GIT_TXN_RESTORE_FAIL:-__unset__}" ]] || { echo "expected GIT_TXN_RC == GIT_TXN_RESTORE_FAIL, got ${GIT_TXN_RC}" >&2; return 1; }
}

# --- REGRESSION GUARD: restore FAILS → before-image preserved (recovery anchor) ---

@test "restore FAILS → the before-image is preserved as the recovery anchor" {
  GIT_TXN_RC=999
  git_txn_apply \
    "${INSTALL_ROOT}" "${TARGET}" "${TARGET}" "the-diff" \
    "${BACKUP_DIR}" _apply_ok _verify_fail_sabotage "lbl" "${TARGET}"
  [[ -f "${BACKUP_DIR}/probe.md.bak" ]] || { echo "before-image was not preserved for post-hoc recovery" >&2; return 1; }
  cmp -s "${PRISTINE}" "${BACKUP_DIR}/probe.md.bak" || { echo "preserved before-image is not the pristine pre-apply content" >&2; return 1; }
}
