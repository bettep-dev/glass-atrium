#!/usr/bin/env bats
# Retired-name sweep for the update system.
#
# The names in retired_names below have no definition anywhere in the tree, so every file
# carrying one names a mechanism that is absent — recorded below with its reason, or a
# stale reference to correct. The two assertions are inverses, which is what keeps the
# retained list exact: nothing outside it may carry a retired name, and every entry in it
# must still carry one, so an entry whose reference is gone is dropped rather than left
# to fossilise.
#
# Retained entries and why each keeps its reference:
#   autoagent/lib/git-txn.sh
#     do-not-edit surface; its transaction header names the two-phase apply wrapper
#   autoagent/daemon_cycle.py
#     do-not-edit surface; the pause-honor block names the shell library it twinned
#   autoagent/lib/autoagent_pause.py
#     do-not-edit surface; the twin has no writer left, and removing it would turn a
#     silent inert manifest row into a per-cycle WARN from its importer's except branch
#   autoagent/test/test_sensitive_patterns.py
#     the path-sync mention IS the assertion that the second path mode is a usage error
#   scripts/test/update-deletion-shape-tripwire.bats
#   scripts/test/update-resolved-gap-recording.bats
#   test/update-restore-base-reversal.bats
#     each is another change's declared target and is corrected there; when that lands,
#     the fossil direction below reds and the row comes out
#   hooks/test/corpus/blocked_9599.js
#   hooks/test/corpus/passed_9599_resubmit.js
#   hooks/test/corpus/variant_A.js
#   hooks/test/corpus/variant_resubmit.js
#     recorded proposal fixtures — the text is captured classifier input, never a claim
#     about the tree, so rewriting it would falsify the fixture
#
# Repo-only: the scan is `git grep` over tracked files, so a consumer install skips.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
export GA
SELF="scripts/test/retired-name-sweep.bats"
export SELF

setup() {
  command -v git >/dev/null 2>&1 || skip "git required"
  command -v comm >/dev/null 2>&1 || skip "comm required"
  git -C "${GA}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || skip "not a git work tree"
  WORK="$(cd -- "$(mktemp -d -t retired-name-sweep.XXXXXX)" && pwd -P)"
  retired_names >"${WORK}/names"
  observed_paths >"${WORK}/observed"
  retained_paths | LC_ALL=C sort >"${WORK}/retained"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Fixed strings, one per line. Identifiers first, then the phrases prose uses for the
# same mechanisms, since a comment names a gate or a flag rather than a function.
retired_names() {
  cat <<'NAMES'
sensitive_helper_path
sensitive_python_bin
sensitive_preflight
sensitive_invoke
sensitive_check_path
sensitive_check_diff
sensitive_path_ok
sensitive_diff_ok
sensitive-refusal.sh
SENSITIVE_REFUSAL_LIB
gate_render_diff
gate_read_answer
gate_prompt_confirm
gate_build_nonagent_records
gate_confirm_changes
gate_apply_confirmed
apply-gate.sh
APPLY_GATE_LIB
update_pause_
update-pause-flag.sh
PAUSE_FLAG_LIB
spine_apply
spine_find_removed_files
update_preview
update_sweep_removed_files
update_trash_dir
update_retire_swept_hook_bindings
_update_removal_commit_callback
update_normalize_relpath
update_partition_sensitive
_sensitive_path_for_sync
_SYNC_EXEMPT_RELPATHS
path-sync
confirm gate
pause flag
pause-flag
NAMES
}

retained_paths() {
  cat <<'PATHS'
autoagent/daemon_cycle.py
autoagent/lib/autoagent_pause.py
autoagent/lib/git-txn.sh
autoagent/test/test_sensitive_patterns.py
hooks/test/corpus/blocked_9599.js
hooks/test/corpus/passed_9599_resubmit.js
hooks/test/corpus/variant_A.js
hooks/test/corpus/variant_resubmit.js
scripts/test/update-deletion-shape-tripwire.bats
scripts/test/update-resolved-gap-recording.bats
test/update-restore-base-reversal.bats
PATHS
}

# Tracked files carrying at least one retired name, this suite excluded — it holds every
# name as data. A no-match grep exits 1, which is a clean empty result here.
observed_paths() {
  git -C "${GA}" grep -l -F -f "${WORK}/names" -- . ":!${SELF}" 2>/dev/null \
    | LC_ALL=C sort || true
}

@test "no file outside the retained list carries a retired update-system name" {
  comm -23 "${WORK}/observed" "${WORK}/retained" >"${WORK}/unrecorded"
  [[ ! -s "${WORK}/unrecorded" ]] \
    || { printf 'unrecorded stale reference(s):\n' >&2 && cat "${WORK}/unrecorded" >&2 && return 1; }
}

@test "every retained entry still carries a retired name" {
  comm -13 "${WORK}/observed" "${WORK}/retained" >"${WORK}/fossil"
  [[ ! -s "${WORK}/fossil" ]] \
    || { printf 'retained entry with no remaining reference — drop the row:\n' >&2 && cat "${WORK}/fossil" >&2 && return 1; }
}
