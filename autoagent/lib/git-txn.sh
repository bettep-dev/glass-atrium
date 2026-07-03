#!/usr/bin/env bash
# git-txn.sh — the reusable git-FREE file-copy apply transaction. Pure, SOURCED
# library: function definitions + outcome constants ONLY, no top-level side
# effects, no executable entry point — the same convention as
# scripts/lib/apply-spine.sh and hooks/lib/style-ref-consts.sh.
#
# Usage: source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/git-txn.sh"
#
# Provides:
#   git_txn_apply  — run one before-image -> apply -> verify -> (leave | restore)
#                    transaction, reporting the structured outcome in GIT_TXN_RC.
#   GIT_TXN_OK / GIT_TXN_BACKUP_CAPTURE_FAIL / GIT_TXN_APPLY_REGEN /
#   GIT_TXN_APPLY_FAIL / GIT_TXN_VERIFY_FAIL — the GIT_TXN_RC outcome constants.
#
# WHY this is git-free (the linchpin refactor): the transaction no longer relies
# on a git worktree. Instead of a WIP snapshot commit + soft-reset/checkout
# rollback, it captures a BEFORE-IMAGE copy of the single target into a
# caller-provided backup dir, runs apply, runs verify, and on verify failure
# ATOMICALLY restores the target from that before-image (sibling temp + rename,
# same-FS, no EXDEV). No commit/checkout/reset/stash/rev-parse anywhere. The
# patch-application mechanism itself lives in the injected apply callback (the
# daemon's apply_diff still uses `git apply --recount`, which works outside a git
# repo) — this lib invokes NO git subcommand of any kind.
#
# WHY this is shared (the seam): the before-image capture, the atomic restore,
# and the outcome bucketing are the HARDENED, reusable scaffold. The two variable
# steps — APPLY and VERIFY — are injected as callback function NAMES so the SAME
# transaction serves two callers with different apply/verify implementations:
#   * daemon-apply.sh  passes  apply_diff  +  verify_patched  (unified-diff apply).
#   * the updater (scripts/update.sh) E4 agent-merge path passes its own EDITABLE-
#     region merge + verify callbacks.
# Because this lib is SOURCED (not a subprocess), the injected callbacks resolve
# against the caller's full environment (its globals + helper functions); this
# lib references NO caller global directly — only its parameters and the
# callbacks — which keeps it decoupled and reusable.
#
# ATOMICITY MODEL (kept DISTINCT from apply-spine.sh on purpose): this is the
# PER-FILE single-target atomic temp+rename transaction for the AGENT-merge path.
# It is NOT apply-spine.sh's staged, rollback-guarded MULTI-file non-agent sync
# (spine_apply, apply-spine.sh:29-33). One target, one before-image, one atomic
# swap. Do not conflate the two.
#
# Caller-scope contract:
#   reads:  none (every input is a positional parameter)
#   writes: GIT_TXN_RC — the structured outcome (one of the GIT_TXN_* constants).
#           Read it AFTER the call; the function's own return status is 0 on every
#           HANDLED outcome (see "set -e contract" below).
#
# set -e contract (behavior-preserving — read before changing the call site):
#   git_txn_apply MUST be invoked BARE (NOT `git_txn_apply ... || rc=$?`). It
#   sets GIT_TXN_RC and returns 0 for ALL handled transaction outcomes, so a bare
#   call under `set -Eeuo pipefail` does not trip on the structured result. The
#   ONE exception is a CONTRACT VIOLATION (wrong-arity or non-function callback —
#   a miswired call site, not a data outcome): that returns NON-ZERO on purpose,
#   so a bare call loud-fails via the caller's set -e rather than silently
#   misparsing an old-signature invocation.
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

# GIT_TXN_RC outcome codes. The values 10-13 deliberately match daemon-apply.sh's
# documented exit-code namespace style so the structured outcome reads
# consistently with the daemon's own codes; 0 == success. The value 14
# (formerly COMMIT_FAIL) is retired: this transaction never commits, so there is
# no apply-commit outcome to report.
readonly GIT_TXN_OK=0
# Before-image capture failed (backup dir uncreatable, source unreadable, or the
# captured copy failed its post-write existence/readability check). Hard
# pre-apply abort: NOTHING was applied, so there is nothing to restore.
readonly GIT_TXN_BACKUP_CAPTURE_FAIL=10
# apply callback returned 3 (a located diff that will not land, no bytes written).
readonly GIT_TXN_APPLY_REGEN=11
# apply callback returned non-0/non-3 (malformed, no bytes written), OR the diff
# spanned more than one file (rejected by the single-file scope guard).
readonly GIT_TXN_APPLY_FAIL=12
# verify callback failed; the target is restored from the before-image via the
# atomic sibling-temp + rename swap.
readonly GIT_TXN_VERIFY_FAIL=13

# _git_txn_valid_callback — assert an injected callback name is a defined function.
# Guards against an old-signature call site whose positional shape shifts a
# commit-message STRING into a callback slot (silent misparse). Args: $1 name,
# $2 role (for the message), $3 install_root (diagnostic context). Returns 0 when
# ${name} is a function, else loud-fails to stderr and returns 1.
_git_txn_valid_callback() {
  local name="$1" role="$2" install_root="$3"
  if ! declare -F "${name}" >/dev/null 2>&1; then
    printf 'git-txn: %s "%s" is not a defined function — wrong-arity/shape call (old signature?) install_root=%s\n' \
      "${role}" "${name}" "${install_root}" >&2
    return 1
  fi
  return 0
}

# _git_txn_count_file_headers — count the distinct file targets a unified/git diff
# touches, robustly under Bash 3.2. Two signals, whichever is larger:
#   * `diff --git ` header lines (git-format diffs), and
#   * adjacent `--- ` -> `+++ ` unified-diff header pairs (the adjacency check
#     rejects isolated content lines that merely begin with `---`/`+++`).
# A header-LESS append-only fragment (daemon apply_diff Strategy B) yields 0,
# which is a VALID single-target case. Arg: $1 diff text. Echoes the count.
_git_txn_count_file_headers() {
  local diff="$1"
  local gitdiff pairs
  gitdiff="$(printf '%s\n' "${diff}" | grep -c '^diff --git ' || true)"
  [[ -z "${gitdiff}" ]] && gitdiff=0
  pairs="$(printf '%s\n' "${diff}" | awk '
    prev ~ /^--- / && $0 ~ /^\+\+\+ / { c++ }
    { prev = $0 }
    END { print c + 0 }
  ')"
  [[ -z "${pairs}" ]] && pairs=0
  if [[ "${gitdiff}" -ge "${pairs}" ]]; then
    printf '%s\n' "${gitdiff}"
  else
    printf '%s\n' "${pairs}"
  fi
}

# _git_txn_capture_before_image — copy the single real target into the
# caller-provided backup dir and verify the copy exists + is readable BEFORE any
# apply touches the live file. Args: $1 real_target, $2 backup_dir, $3
# install_root (diagnostic context). Echoes the before-image path on success;
# loud-fails to stderr and returns 1 on any capture failure.
_git_txn_capture_before_image() {
  local real_target="$1" backup_dir="$2" install_root="$3"
  local before_image
  if ! mkdir -p -- "${backup_dir}"; then
    printf 'git-txn: backup dir create FAILED (backup=%s install_root=%s)\n' \
      "${backup_dir}" "${install_root}" >&2
    return 1
  fi
  # Bash parameter expansion basename (no subshell): strip the longest leading
  # path so the before-image sits beside its peers as <agent>.md.bak.
  before_image="${backup_dir}/${real_target##*/}.bak"
  if ! cp -p -- "${real_target}" "${before_image}"; then
    printf 'git-txn: before-image capture FAILED (real_target=%s backup=%s install_root=%s)\n' \
      "${real_target}" "${before_image}" "${install_root}" >&2
    return 1
  fi
  if [[ ! -f "${before_image}" || ! -r "${before_image}" ]]; then
    printf 'git-txn: before-image unverified after capture (before_image=%s install_root=%s)\n' \
      "${before_image}" "${install_root}" >&2
    return 1
  fi
  printf '%s\n' "${before_image}"
}

# _git_txn_restore — ATOMICALLY restore the target from its before-image. Copy
# the before-image to a sibling temp NEXT TO the target (same directory -> same
# filesystem -> no EXDEV), then `mv -f` rename it over the target. A crash
# between the cp and the rename leaves the target UNTOUCHED (it still holds the
# applied bytes) plus a stray temp; the rename itself is atomic on one FS, so the
# target is never observed truncated. Mirrors spine_set_baseline (apply-spine.sh
# :305-306) — deliberately NOT spine_rollback's non-atomic in-place `cp`. Args:
# $1 real_target, $2 before_image, $3 install_root. Returns 0 on success; loud-
# fails to stderr and returns 1 if either step fails (target may hold applied
# bytes — recover from the persistent agents-bak before-image).
_git_txn_restore() {
  local real_target="$1" before_image="$2" install_root="$3"
  local tmp="${real_target}.rollback.$$"
  if ! cp -p -- "${before_image}" "${tmp}"; then
    rm -f -- "${tmp}" 2>/dev/null || true
    printf 'git-txn: rollback stage FAILED (before_image=%s target=%s install_root=%s) — target NOT restored; recover from agents-bak\n' \
      "${before_image}" "${real_target}" "${install_root}" >&2
    return 1
  fi
  if ! mv -f -- "${tmp}" "${real_target}"; then
    rm -f -- "${tmp}" 2>/dev/null || true
    printf 'git-txn: rollback rename FAILED (target=%s install_root=%s) — target may hold applied bytes; recover from agents-bak\n' \
      "${real_target}" "${install_root}" >&2
    return 1
  fi
  return 0
}

# git_txn_apply — one git-FREE file-copy apply transaction.
#
# Positional parameters (7 required + 2 optional = 7-9 args):
#   $1 install_root — the install root the operation runs under; carried for
#                     caller call-shape symmetry and included in every loud-fail
#                     line as diagnostic context. This lib runs no git op, so it
#                     is NOT a git worktree root.
#   $2 target       — the logical/facade path handed to the apply + verify
#                     callbacks (the daemon's PATCH_TARGET).
#   $3 real_target  — the resolved REAL path on disk. The before-image is a copy
#                     OF this file, and the atomic restore renames over it.
#   $4 diff         — the patch text handed to the apply callback (also scanned
#                     by the single-file scope guard).
#   $5 backup_dir   — caller-provided backup dir the before-image is written into
#                     (e.g. ~/.glass-atrium/agents-bak/<cycle_date>_p<id>/). This
#                     lib only receives + uses it; retention/prune is the caller's.
#   $6 apply_fn     — apply callback NAME. Called: apply_fn target diff label
#                     diff_target. Return contract (mirrors apply_diff): 0=applied,
#                     3=located-diff-won't-land (no bytes written), other=malformed.
#   $7 verify_fn    — verify callback NAME. Called: verify_fn target. 0=ok, non-0=fail.
#   $8 label        — OPTIONAL, attribution passed through to apply_fn (3rd arg).
#   $9 diff_target  — OPTIONAL, attribution passed through to apply_fn (4th arg).
#
# Result: sets GIT_TXN_RC to one of the GIT_TXN_* constants and returns 0 on every
# handled outcome. Returns NON-ZERO only on a contract violation (wrong arity /
# non-function callback) — see the "set -e contract" in the file header.
#
# shellcheck disable=SC2034
#   GIT_TXN_RC is the caller-scope output contract — assigned here, read by the
#   source-er (daemon-apply.sh apply_patch_rows). Not used inside this lib.
git_txn_apply() {
  # -- Contract guard: arity FIRST (before any $N read, so it is safe under
  #    set -u), then callback shape. A wrong-arity/shape call is a miswired call
  #    site, not a data outcome — loud-fail with a non-zero return.
  if (($# < 7 || $# > 9)); then
    printf 'git-txn: git_txn_apply needs 7-9 args, got %d — wrong-arity call (old 8-10 arg signature?)\n' "$#" >&2
    return 1
  fi
  local install_root="$1" target="$2" real_target="$3" diff="$4"
  local backup_dir="$5" apply_fn="$6" verify_fn="$7"
  local label="${8:-}" diff_target="${9:-}"

  # shellcheck disable=SC2310
  #   Invoked in an `if !` so set -e is intentionally suppressed here — the
  #   callback-shape check IS the error handler; we return 1 on its failure.
  if ! _git_txn_valid_callback "${apply_fn}" apply_fn "${install_root}" \
    || ! _git_txn_valid_callback "${verify_fn}" verify_fn "${install_root}"; then
    return 1
  fi

  # -- Single-file scope guard. The before-image covers exactly ONE target, so a
  #    multi-file diff would escape rollback. A header-less fragment (0 headers)
  #    and a single located file (1 header) are fine; 2+ is rejected loudly and
  #    mapped to APPLY_FAIL (malformed input), BEFORE any file is touched.
  local n_files
  n_files="$(_git_txn_count_file_headers "${diff}")"
  if [[ "${n_files}" -gt 1 ]]; then
    printf 'git-txn: multi-file diff rejected (%s file headers > 1) — single-file transaction only (target=%s install_root=%s)\n' \
      "${n_files}" "${target}" "${install_root}" >&2
    GIT_TXN_RC="${GIT_TXN_APPLY_FAIL}"
    return 0
  fi

  # -- Capture the before-image + verify it BEFORE apply. A capture failure is a
  #    hard pre-apply abort: nothing was applied, so there is nothing to restore.
  local before_image
  # shellcheck disable=SC2310
  #   Invoked in an `if !` so set -e is intentionally suppressed — the capture
  #   failure is handled here (BACKUP_CAPTURE_FAIL), not propagated.
  if ! before_image="$(_git_txn_capture_before_image "${real_target}" "${backup_dir}" "${install_root}")"; then
    GIT_TXN_RC="${GIT_TXN_BACKUP_CAPTURE_FAIL}"
    return 0
  fi

  # -- Apply. Branch on the callback's rc: 0=applied · 3=located diff rejected
  #    (kept pending, no bytes) · other=malformed (no bytes). On 3 and other the
  #    callback wrote NO bytes, so the live file is untouched — no restore needed;
  #    the before-image simply stays in the backup dir (caller retention prunes).
  local apply_rc=0
  "${apply_fn}" "${target}" "${diff}" "${label}" "${diff_target}" || apply_rc=$?
  if [[ "${apply_rc}" -eq 3 ]]; then
    GIT_TXN_RC="${GIT_TXN_APPLY_REGEN}"
    return 0
  fi
  if [[ "${apply_rc}" -ne 0 ]]; then
    GIT_TXN_RC="${GIT_TXN_APPLY_FAIL}"
    return 0
  fi

  # -- Verify. On failure the apply DID write bytes, so atomically restore the
  #    target from the before-image (sibling temp + rename). Restore is best-
  #    effort + LOUD: a failed restore leaves the persistent agents-bak before-
  #    image as the recovery source (P3-T5 post-hoc restore).
  # shellcheck disable=SC2310
  #   Invoked in an `if !` so set -e is intentionally suppressed — a failed
  #   verify is the expected branch that triggers the restore below.
  if ! "${verify_fn}" "${target}"; then
    _git_txn_restore "${real_target}" "${before_image}" "${install_root}" || true
    GIT_TXN_RC="${GIT_TXN_VERIFY_FAIL}"
    return 0
  fi

  # Success: the applied bytes stay in place; the before-image remains in the
  # backup dir as the recovery anchor until the caller's retention prunes it.
  GIT_TXN_RC="${GIT_TXN_OK}"
  return 0
}
