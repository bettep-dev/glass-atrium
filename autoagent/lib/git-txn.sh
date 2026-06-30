#!/usr/bin/env bash
# git-txn.sh — the reusable git-commit-sandboxed apply transaction, extracted
# verbatim (behavior-preserving) from daemon-apply.sh's apply_patch_rows row
# loop. Pure, SOURCED library: function definitions + outcome constants ONLY, no
# top-level side effects, no executable entry point — the same convention as
# scripts/lib/apply-spine.sh and hooks/lib/style-ref-consts.sh.
#
# Usage: source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/git-txn.sh"
#
# Provides:
#   git_txn_apply  — run one WIP-snapshot -> apply -> verify -> (commit | rollback)
#                    transaction, reporting the structured outcome in GIT_TXN_RC.
#   GIT_TXN_OK / GIT_TXN_SNAPSHOT_FAIL / GIT_TXN_APPLY_REGEN / GIT_TXN_APPLY_FAIL /
#   GIT_TXN_VERIFY_FAIL / GIT_TXN_COMMIT_FAIL — the GIT_TXN_RC outcome constants.
#
# WHY this is shared (the seam): the WIP snapshot commit, the soft-reset /
# checkout rollback mechanics, and the apply commit are the HARDENED, reusable
# scaffold. The two variable steps — APPLY and VERIFY — are injected as callback
# function NAMES so the SAME transaction serves two callers with different
# apply/verify implementations:
#   * daemon-apply.sh  passes  apply_diff  +  verify_patched  (unified-diff apply).
#   * the glass-atrium-update skill's E4 agent-merge path passes its own EDITABLE-
#     region merge + verify callbacks (T18/T19 — NOT implemented here).
# Because this lib is SOURCED (not a subprocess), the injected callbacks resolve
# against the caller's full environment (its globals + helper functions); this
# lib references NO caller global directly — only its parameters, the callbacks,
# and git — which keeps it decoupled and reusable.
#
# Caller-scope contract:
#   reads:  none (every input is a positional parameter)
#   writes: GIT_TXN_RC — the structured outcome (one of the GIT_TXN_* constants).
#           Read it AFTER the call; the function's own return status is 0 on every
#           HANDLED outcome (see "set -e contract" below).
#
# set -e contract (behavior-preserving — read before changing the call site):
#   git_txn_apply MUST be invoked BARE (NOT `git_txn_apply ... || rc=$?`). It
#   sets GIT_TXN_RC and returns 0 for ALL handled outcomes, so a bare call under
#   `set -Eeuo pipefail` does not trip on the structured result. Invoking it in a
#   `||` / `if` test context would DISABLE set -e inside the function, which would
#   change the one DELIBERATELY-bare command below (the `git add`, whose failure
#   the daemon has always let propagate via set -e) from "crash" to "continue" —
#   a semantics change. Bare invocation preserves the original exactly.
#
# Strict mode is the CALLER's responsibility (sourced-lib convention): this file
# does NOT run `set -Eeuo pipefail` (a sourced file must not mutate the caller's
# shell options). Every function here is written to be SAFE under a caller that
# has already set `set -Eeuo pipefail` + `IFS=$'\n\t'`.
#
# Compatibility: Bash 3.2+ (macOS stock). No bash-4 features.

# Double-source guard — readonly constants below would error on re-source.
if [[ -n "${_GIT_TXN_SH_LOADED:-}" ]]; then
  return 0
fi
readonly _GIT_TXN_SH_LOADED=1

# GIT_TXN_RC outcome codes. The values 10-14 deliberately match daemon-apply.sh's
# documented exit-code namespace style (10-15 already in use there) so the
# structured outcome reads consistently with the daemon's own codes; 0 == success.
#
# apply commit at HEAD, WIP snapshot at HEAD~1.
readonly GIT_TXN_OK=0
# WIP --allow-empty snapshot commit failed; NO rollback (nothing committed to undo).
readonly GIT_TXN_SNAPSHOT_FAIL=10
# apply callback returned 3 (a located diff that will not land); WIP rolled back.
readonly GIT_TXN_APPLY_REGEN=11
# apply callback returned non-0/non-3 (malformed); WIP rolled back (reset --soft).
readonly GIT_TXN_APPLY_FAIL=12
# verify callback failed; working tree restored (checkout) THEN WIP rolled back.
readonly GIT_TXN_VERIFY_FAIL=13
# apply commit failed; WIP rolled back (reset --soft).
readonly GIT_TXN_COMMIT_FAIL=14

# git_txn_apply — one git-commit-sandboxed apply transaction.
#
# Positional parameters:
#   $1 git_root    — git worktree root for every git op (`git -C ${git_root}`).
#   $2 target      — the logical/facade path handed to the apply + verify
#                    callbacks (the daemon's PATCH_TARGET).
#   $3 git_target  — the resolved real path INSIDE the worktree, used by the git
#                    `add`/`checkout` ops (the daemon's ga_realpath result).
#   $4 diff        — the patch text handed to the apply callback.
#   $5 wip_msg     — full commit message for the [WIP-AUTO] pre-change snapshot.
#   $6 apply_msg   — full commit message for the [AUTO] apply commit.
#   $7 apply_fn    — apply callback NAME. Called: apply_fn target diff label
#                    diff_target. Return contract (mirrors apply_diff): 0=applied,
#                    3=located-diff-won't-land (no bytes written), other=malformed.
#   $8 verify_fn   — verify callback NAME. Called: verify_fn target. 0=ok, non-0=fail.
#   $9 label       — OPTIONAL, attribution passed through to apply_fn (3rd arg).
#   $10 diff_target — OPTIONAL, attribution passed through to apply_fn (4th arg).
#
# Result: sets GIT_TXN_RC to one of the GIT_TXN_* constants. Returns 0 on every
# handled outcome (see the "set e contract" in the file header).
#
# shellcheck disable=SC2034
#   GIT_TXN_RC is the caller-scope output contract — assigned here, read by the
#   source-er (daemon-apply.sh apply_patch_rows). Not used inside this lib.
git_txn_apply() {
  local git_root="$1"
  local target="$2"
  local git_target="$3"
  local diff="$4"
  local wip_msg="$5"
  local apply_msg="$6"
  local apply_fn="$7"
  local verify_fn="$8"
  local label="${9:-}"
  local diff_target="${10:-}"

  # -- WIP snapshot commit (captures orphan diffs IF any — redundant after the
  #    caller's tree_clean check, but cheap insurance). On failure NOTHING was
  #    committed, so there is nothing to roll back: report SNAPSHOT_FAIL and let
  #    the caller pop the stash + leave the row pending.
  if ! git -C "${git_root}" commit --allow-empty -m "${wip_msg}" >/dev/null 2>&1; then
    GIT_TXN_RC="${GIT_TXN_SNAPSHOT_FAIL}"
    return 0
  fi

  # -- Apply. Branch on the apply callback's specific rc: 0=success · 3=located
  #    diff rejected (keep pending, NOT applied) · other=malformed. On 3 and on
  #    other, the callback wrote NO bytes, so a single reset --soft HEAD~1 (drop
  #    the empty WIP commit) is the complete rollback.
  local apply_rc=0
  "${apply_fn}" "${target}" "${diff}" "${label}" "${diff_target}" || apply_rc=$?
  if [[ "${apply_rc}" -eq 3 ]]; then
    git -C "${git_root}" reset --soft HEAD~1 >/dev/null 2>&1 || true
    GIT_TXN_RC="${GIT_TXN_APPLY_REGEN}"
    return 0
  fi
  if [[ "${apply_rc}" -ne 0 ]]; then
    git -C "${git_root}" reset --soft HEAD~1 >/dev/null 2>&1 || true
    GIT_TXN_RC="${GIT_TXN_APPLY_FAIL}"
    return 0
  fi

  # -- Verify. On failure the apply DID write bytes, so restore the working tree
  #    from the WIP snapshot (checkout git_target) BEFORE dropping the WIP commit.
  if ! "${verify_fn}" "${target}"; then
    git -C "${git_root}" checkout -- "${git_target}" >/dev/null 2>&1 || true
    git -C "${git_root}" reset --soft HEAD~1 >/dev/null 2>&1 || true
    GIT_TXN_RC="${GIT_TXN_VERIFY_FAIL}"
    return 0
  fi

  # -- Stage + apply commit. git_target = resolved real path (git rejects an
  #    outside-worktree facade path). The `git add` is DELIBERATELY bare (no
  #    `|| true`, no `if`): the daemon has always let a git-add failure propagate
  #    via set -e, and bare invocation of this function (see header) keeps that
  #    behavior. On apply-commit failure, drop the WIP commit (prevent an orphan
  #    pre-change snapshot).
  git -C "${git_root}" add -- "${git_target}" >/dev/null 2>&1
  if ! git -C "${git_root}" commit -m "${apply_msg}" >/dev/null 2>&1; then
    git -C "${git_root}" reset --soft HEAD~1 >/dev/null 2>&1 || true
    GIT_TXN_RC="${GIT_TXN_COMMIT_FAIL}"
    return 0
  fi

  # Success: apply commit at HEAD, WIP snapshot at HEAD~1. The caller reads both
  # hashes via `git rev-parse HEAD / HEAD~1` for its applied log.
  GIT_TXN_RC="${GIT_TXN_OK}"
  return 0
}
