#!/usr/bin/env bash
# apply-spine.sh — deterministic safe-apply spine for the Glass Atrium update
# system. Pure sourced library: function defs only, no top-level side effects
# (same convention as atrium-config.sh / daemon-lock.sh).
#
# Strict mode is the CALLER's responsibility — a sourced lib must not mutate the
# caller's shell options; every fn is safe under `set -Eeuo pipefail` (the bats
# suite sources it under strict mode to prove that).
#
# Scope (E3 capabilities): spine_find_changed_files (T13, non-agent hash-diff
# selection) · spine_stage_and_verify then spine_commit_staged (T11, stage +
# per-file SHA-256 verify, then atomic swap with rollback — each caller sequences
# the two phases itself) · spine_set_baseline + spine_get_baseline (T14,
# base@install anchor capture/read).
#
# Manifest schema (from generate-manifest.sh, v1.0.0):
#   { "version": "1.0.0", "files": ["agents/foo.md", …],
#     "hashes": { "agents/foo.md": "<64-hex sha256>", … } }
# expected content hash = hashes[path] (O(1) lookup).
#
# Atomicity caveat (accurate): each per-file swap AND each rollback restore is
# atomic — a sibling temp in the destination dir is written, then rename(2)-moved
# over the target (same FS → no EXDEV). A process holding the old inode open
# (e.g. the RUNNING update.sh / glass-atrium launcher mid self-update) keeps its
# now-unlinked inode intact and reaches clean EOF — never a truncated tail an
# in-place cp would expose. NOT atomic is the CROSS-file set: the apply is STAGED
# and ROLLBACK-GUARDED, and a mid-swap failure restores every already-swapped
# file from a pre-swap snapshot. No cross-file all-or-nothing primitive exists.
#
# Symlink rows travel the same chain without being flattened into regular files:
# the source test, the staged-file test and the snapshot test all read link-ness
# first, the staging, snapshot and swap copies reproduce a link as a link, and a
# link row is hash-verified at its release-tree position, where its target
# resolves.
#
# Loud-fail contract (shared-self-improve-hygiene Precondition Loud-Fail): every
# verify mismatch, missing source, or missing manifest hash returns non-zero +
# stderr, never a silent skip.
#
# Portability: SHA-256 via `shasum -a 256` (macOS) with a `sha256sum` (GNU)
# fallback — same precedence as generate-manifest.sh. jq reads the manifest,
# with a runnable-python3 fallback on the install.sh bootstrap surface
# (spine_get_manifest_hash / spine_stage_and_verify) — that path runs from the
# fresh bundle BEFORE ga-deps can install jq, so it must verify jq-less.

# Internal helpers

# Loud-fail when a required external tool is absent. Args: tool names.
spine_require_tools() {
  local tool missing=0
  for tool in "$@"; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      printf 'apply-spine: required tool not found: %s\n' "${tool}" >&2
      missing=1
    fi
  done
  [[ "${missing}" -eq 0 ]]
}

# Echo the lowercase 64-hex SHA-256 of a single file. BSD/GNU portable: prefer
# shasum (macOS), fall back to sha256sum (Linux). The hash is the first
# whitespace-delimited field; `${out%% *}` drops the trailing filename column
# without forking awk.
spine_sha256_of() {
  local file="$1" out
  if command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 -- "${file}")" || return 1
  elif command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum -- "${file}")" || return 1
  else
    printf 'apply-spine: no sha256 tool (shasum/sha256sum)\n' >&2
    return 1
  fi
  printf '%s\n' "${out%% *}"
}

# Link-aware existence test — the shared predicate for every path in the apply
# chain that may be a symlink (the release source, the staged file, the live
# destination, the snapshot entry). A dereferencing `-f` reads FALSE for a link
# whose target is absent, and a staged or snapshotted link is dangling whenever
# its target is not copied into the same directory, so link-ness is tested FIRST
# and regular-file-ness second. Each caller's default on false is destructive in
# a different way — abort the apply, skip the snapshot, delete the live row.
spine_is_present_path() {
  [[ -L "$1" ]] || [[ -f "$1" ]]
}

# Copy src to dst preserving link-ness: a symlink source is reproduced at dst as
# a symlink carrying the same target text, never dereferenced into a regular
# file; every other source takes the mode-preserving file copy. Every dst passed
# here is a staging entry, a snapshot entry or an atomic swap's sibling temp —
# never a live row — so the force flag replaces nothing an operator owns.
spine_copy_entry() {
  local src="$1" dst="$2" link_target
  if [[ -L "${src}" ]]; then
    link_target="$(readlink -- "${src}")" || return 1
    ln -sfn -- "${link_target}" "${dst}"
    return
  fi
  cp -p -- "${src}" "${dst}"
}

# NON-INTERACTIVE python3 runnability probe (bootstrap parity with install.sh's
# python3_runnable — this lib is self-contained, so the idiom is mirrored, not
# sourced). Stock macOS ships /usr/bin/python3 as an Apple CLT shim that pops a
# GUI install dialog when executed without the Command Line Tools — PATH
# visibility alone is NOT runnability. The CLT gate (xcode-select -p) applies
# ONLY to that Apple shim path; a brew/pyenv python3 runs without CLT.
spine_python3_runnable() {
  local py
  py="$(command -v python3 2>/dev/null)" || return 1
  if [[ "${py}" == "/usr/bin/python3" ]]; then
    xcode-select -p >/dev/null 2>&1 || return 1
  fi
}

# Loud-fail unless a manifest JSON parser is usable: jq, else runnable python3.
# The jq-less window is REAL on the install.sh bootstrap path — this lib is
# sourced from the fresh bundle BEFORE ga-deps can ever install jq.
spine_require_manifest_parser() {
  command -v jq >/dev/null 2>&1 && return 0
  # shellcheck disable=SC2310  # probe in a condition by design — verdict branched on
  spine_python3_runnable && return 0
  printf 'apply-spine: no JSON parser (jq or runnable python3) available\n' >&2
  return 1
}

# Echo the expected hash for a path from the manifest's hashes map; empty when
# the path carries no recorded hash. jq when present; the python3 backend keeps
# the jq-less install bootstrap verifiable — identical output contract to
# `jq -r '.hashes[$p] // empty'`.
spine_get_manifest_hash() {
  local manifest="$1" path="$2"
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg p "${path}" '.hashes[$p] // empty' -- "${manifest}"
    return
  fi
  # python3 backend: source captured FIRST, then run — an inline heredoc on the
  # python3 -c command line itself would swallow stdin (SC2259).
  local py_src
  py_src="$(
    cat <<'PY'
import json, sys

with open(sys.argv[2]) as fh:
    data = json.load(fh)
v = (data.get("hashes") or {}).get(sys.argv[1])
if v is not None and v is not False:
    print(v)
PY
  )"
  python3 -c "${py_src}" "${path}" "${manifest}"
}

# Predicate: does the E4 agent three-anchor merge path CLAIM this manifest path?
# Returns 0 (claimed) / 1 (not claimed). The merge iterates a NON-recursive
# agents/*.md glob and skips the non-agent charter by basename before its lib is
# ever invoked (update.sh update_merge_agent_editable_regions), so its claim is
# exactly "a top-level agents/<name>.md that is not the charter".
#
# SINGLE source of truth for both deploy consumers: the merge loop iterates
# through this predicate and the spine's agents-markdown exclusion below is its
# complement, so the two scopes cannot drift apart into a path claimed by neither
# (which is how the charter, the reference documents and the templates were
# excluded here AND unreachable there, hash-verified by no deploy path at all).
spine_is_merge_claimed_path() {
  local path="$1" rest
  [[ "${path}" == agents/*.md ]] || return 1
  rest="${path#agents/}"
  [[ "${rest}" == */* ]] && return 1                            # below the non-recursive glob
  [[ "${rest}" == 'GLASS_ATRIUM_GLOBAL_RULES.md' ]] && return 1 # non-agent charter
  return 0
}

# Predicate: is this manifest path EXCLUDED from the deterministic non-agent
# sync? Returns 0 (excluded) / 1 (included). ONE arm, so the exclusion is the
# merge's claim and nothing else: a claimed body is resolved by the separate
# three-anchor merge path (base@install / vendor / local) rather than here. That
# equality is what makes the two deploy consumers a partition of the manifest —
# a second arm would carve a row out of both scopes and leave it hash-verified by
# no deploy path at all. The name is kept because the two consumers ask opposite
# questions of the same fact, and the spine's callers read better asking this one.
spine_is_excluded_path() {
  spine_is_merge_claimed_path "$1"
}

# Emit (one relative path per line) every manifest path claimed by NEITHER deploy
# consumer — the merge does not reach it and the spine excludes it, so no path
# ever hash-verifies it and a deploy reports success without having considered it.
# Detection only: the CALLER owns the loud line (same split as
# spine_find_changed_files → update_commit_callback). Arg: $1 = manifest.json.
#
# While the spine's exclusion is exactly the merge's claim this emits NOTHING for
# any input, which is the invariant rather than a defect: the two guards below are
# the general definition, and they are what re-arms the scan the moment a second
# exclusion arm makes the two predicates differ again.
spine_find_uncovered_paths() {
  local manifest="$1" path
  spine_require_tools jq || return 1
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    # Exclusion first: a path the spine syncs is covered whatever the merge says.
    # shellcheck disable=SC2310  # predicate in a condition by design — verdict branched on
    if ! spine_is_excluded_path "${path}"; then
      continue
    fi
    # shellcheck disable=SC2310
    if spine_is_merge_claimed_path "${path}"; then
      continue
    fi
    printf '%s\n' "${path}"
  done < <(jq -r '.files[]' -- "${manifest}")
}

# T13 — non-agent hash-diff change selection

# Emit (one relative path per line) the NON-AGENT files whose live content
# differs from the staged new-release manifest, with the merge-claimed agent
# exclusion applied. A path absent from the live install is reported as changed
# (it must be installed). Args: $1 = new-release manifest.json · $2 = live
# install root. Loud-fails (rc 1) on a manifest path that carries no hash.
spine_find_changed_files() {
  local manifest="$1" install_root="$2"
  local path want live target
  spine_require_tools jq || return 1
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    if spine_is_excluded_path "${path}"; then
      continue
    fi
    want="$(spine_get_manifest_hash "${manifest}" "${path}")"
    if [[ -z "${want}" ]]; then
      printf 'apply-spine: manifest has no hash for %s\n' "${path}" >&2
      return 1
    fi
    target="${install_root}/${path}"
    if [[ ! -f "${target}" ]]; then
      printf '%s\n' "${path}" # missing locally → must be installed
      continue
    fi
    live="$(spine_sha256_of "${target}")" || return 1
    if [[ "${live}" != "${want}" ]]; then
      printf '%s\n' "${path}"
    fi
  done < <(jq -r '.files[]' -- "${manifest}")
}

# T11 — staged apply + rollback

# Phase 1: copy each changed file from the new-release tree into a staging dir
# and verify its SHA-256 equals the manifest hashes[path]. Reads the change set
# (one relative path per line) from STDIN. Touches ONLY the staging dir — the
# live install is never modified here, so any mismatch is a clean loud-fail
# (rc 1) with zero rollback needed. A symlink row is staged as a symlink and
# verified at its release-tree position (see the hash-subject branch below).
# Args: $1 = new-release tree root · $2 = manifest.json · $3 = staging dir.
spine_stage_and_verify() {
  local new_dir="$1" manifest="$2" staging="$3"
  local path src dst want got verify_src
  # jq OR runnable python3 — the install.sh bootstrap verifies jq-less (pre-ga-deps).
  # shellcheck disable=SC2310
  spine_require_manifest_parser || return 1
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    src="${new_dir}/${path}"
    # shellcheck disable=SC2310  # predicate in a condition by design — verdict branched on
    if ! spine_is_present_path "${src}"; then
      printf 'apply-spine: staged source missing: %s\n' "${src}" >&2
      return 1
    fi
    want="$(spine_get_manifest_hash "${manifest}" "${path}")"
    if [[ -z "${want}" ]]; then
      printf 'apply-spine: manifest has no hash for %s\n' "${path}" >&2
      return 1
    fi
    dst="${staging}/${path}"
    mkdir -p -- "$(dirname -- "${dst}")"
    # The copy's status is the ONLY detection a link row has: the hash below
    # reads the release-tree source for a link, so a staged link that never
    # landed still verifies clean and the swap would then find nothing to move.
    # shellcheck disable=SC2310  # copy in a condition by design — verdict branched on
    if ! spine_copy_entry "${src}" "${dst}"; then
      printf 'apply-spine: staging copy failed: %s -> %s\n' "${src}" "${dst}" >&2
      return 1
    fi
    # A staged link is dangling whenever its target is not co-staged, and hashing
    # a dangling link fails, so a link row is hashed at its position in the
    # release tree, where its target resolves. The manifest records the target's
    # content hash either way, so the comparison itself is unchanged.
    verify_src="${dst}"
    if [[ -L "${src}" ]]; then
      verify_src="${src}"
    fi
    got="$(spine_sha256_of "${verify_src}")" || return 1
    if [[ "${got}" != "${want}" ]]; then
      printf 'apply-spine: hash mismatch staging %s (want=%s got=%s)\n' \
        "${path}" "${want}" "${got}" >&2
      return 1
    fi
  done
}

# Atomic file swap — the SINGLE source of truth for every install/baseline write
# in this lib (commit swap, rollback restore, baseline capture). Writes a sibling
# temp in the dst dir then rename(2)-moves it over dst: same FS → atomic, and a
# process holding the old inode open (a self-updating update.sh / launcher) keeps
# its now-unlinked inode intact and reaches clean EOF — never a truncated tail an
# in-place cp would expose. On any failure the partial temp is removed and rc 1
# returned; the CALLER owns the failure policy (warn-and-continue / break-and-
# rollback / set -e abort). Args: $1 = src file · $2 = dst path.
#
# A symlink src is reproduced as a symlink at the temp and rename(2) moves the
# link itself over dst, so the forward swap and the rollback restore both land a
# link row as a link rather than as a regular file holding the target's bytes.
#
# Residue: the temp is a SIBLING of dst, so it sits inside the install root, while
# the updater's cleanup tears down only its own work dir. A process killed between
# the copy and the rename therefore leaves that temp behind. It carries no manifest
# row, so the manifest-scoped stages (change selection, mode enforcement, the mirror
# refresh) never reach it and the swap stays atomic — clearing it is a manual sweep.
spine_atomic_swap() {
  local src="$1" dst="$2" tmp
  tmp="${dst}.tmp.$$"
  # shellcheck disable=SC2310  # copy in a condition by design — verdict branched on
  if ! { spine_copy_entry "${src}" "${tmp}" && mv -f -- "${tmp}" "${dst}"; }; then
    rm -f -- "${tmp}"
    return 1
  fi
}

# Restore the live install to its pre-swap state from the snapshot dir. For each
# touched path: a snapshot copy exists → restore it; no snapshot → the file was
# newly created by the swap → remove it. Args: $1 = install root · $2 = snapshot
# dir · $3.. = touched relative paths. Best-effort: a failed restore is reported
# but does not abort the remaining restores (partial-recovery beats no recovery).
#
# The "no snapshot → created by the swap" reading is safe only because the
# snapshot test is link-aware: a snapshotted link is dangling inside the snapshot
# dir whenever its target is not co-copied, and a dereferencing test would read
# that entry as absent and DELETE the live row it was taken to protect.
spine_rollback() {
  local install_root="$1" snapshot="$2"
  shift 2
  local path snap dst
  for path in "$@"; do
    [[ -n "${path}" ]] || continue
    snap="${snapshot}/${path}"
    dst="${install_root}/${path}"
    # shellcheck disable=SC2310  # predicate in a condition by design — verdict branched on
    if spine_is_present_path "${snap}"; then
      # Atomic restore via the shared swap (sibling temp + rename, never in-place).
      spine_atomic_swap "${snap}" "${dst}" \
        || printf 'apply-spine: rollback restore FAILED: %s\n' "${path}" >&2
    else
      rm -f -- "${dst}" \
        || printf 'apply-spine: rollback remove FAILED: %s\n' "${path}" >&2
    fi
  done
}

# Phase 2: snapshot then swap each staged file into the live install, rolling
# back on ANY failure mid-swap. Reads the change set (one relative path per line)
# from STDIN. Processing order, per file: snapshot the live target (if it
# exists) → mark it touched → atomically swap the staged file into place (sibling
# temp + rename). On the first failure, every touched file is rolled back to its
# pre-swap state and rc 1 is returned. Args: $1 = staging dir · $2 = install root
# · $3 = snapshot dir.
#
# A link row is carried through both steps as a link: the staged-source test is
# link-aware (a staged link is dangling whenever its target is not co-staged),
# and the snapshot copy preserves the live link's target text so the rollback
# restores a link rather than a regular file holding the old target's bytes.
spine_commit_staged() {
  local staging="$1" install_root="$2" snapshot="$3"
  local -a paths=() touched=()
  local path src dst snap rc=0 failed=""
  while IFS= read -r path; do
    [[ -n "${path}" ]] && paths+=("${path}")
  done
  for path in "${paths[@]:-}"; do
    [[ -n "${path}" ]] || continue
    src="${staging}/${path}"
    dst="${install_root}/${path}"
    snap="${snapshot}/${path}"
    # shellcheck disable=SC2310  # predicate in a condition by design — verdict branched on
    if ! spine_is_present_path "${src}"; then
      failed="${path}"
      rc=1
      break
    fi
    # snapshot the pre-swap live file BEFORE marking touched / overwriting.
    # shellcheck disable=SC2310
    if spine_is_present_path "${dst}"; then
      mkdir -p -- "$(dirname -- "${snap}")"
      # shellcheck disable=SC2310
      if ! spine_copy_entry "${dst}" "${snap}"; then
        failed="${path}"
        rc=1
        break
      fi
    fi
    touched+=("${path}")
    mkdir -p -- "$(dirname -- "${dst}")"
    # Atomic swap via the shared helper — the running update.sh / launcher keeps
    # its old, now-unlinked inode and reaches clean EOF, never a half-written tail
    # of the script being self-updated.
    if ! spine_atomic_swap "${src}" "${dst}"; then
      failed="${path}"
      rc=1
      break
    fi
  done
  if [[ "${rc}" -ne 0 ]]; then
    printf 'apply-spine: commit FAILED at %s — rolling back %s touched file(s)\n' \
      "${failed}" "${#touched[@]}" >&2
    spine_rollback "${install_root}" "${snapshot}" "${touched[@]:-}"
    return 1
  fi
}

# T14 — baseline (base@install) anchor capture + read

# Resolve the update-state directory holding the baseline anchor. Precedence:
# $1 arg → ATRIUM_UPDATE_STATE_DIR env → ${HOME}/.claude/data/update. This Tier-C
# spine baseline stays under ~/.claude by design — the updater reads its own
# baseline DURING the update that would relocate it, so unlike the Tier-A daemon
# reports (now ${GA_DATA_ROOT:-~/.glass-atrium}/data) it needs a separate
# teach-then-migrate cycle before it can move.
spine_baseline_dir() {
  printf '%s\n' "${1:-${ATRIUM_UPDATE_STATE_DIR:-${HOME}/.claude/data/update}}"
}

# Echo the resolved baseline-manifest path (file need not exist). Arg: $1 =
# optional state-dir override.
spine_baseline_path() {
  printf '%s\n' "$(spine_baseline_dir "${1:-}")/baseline-manifest.json"
}

# Capture (store) the just-applied manifest as the base@install baseline anchor —
# the PRIMARY 3-anchor base (prior-release hashes) for the next update. Written
# atomically (temp + mv). Echoes the stored path. Args: $1 = applied
# manifest.json · $2 = optional state-dir override. Loud-fails (rc 1) when the
# source manifest is missing.
spine_set_baseline() {
  local manifest="$1" dir dst
  if [[ ! -f "${manifest}" ]]; then
    printf 'apply-spine: baseline source manifest missing: %s\n' "${manifest}" >&2
    return 1
  fi
  dir="$(spine_baseline_dir "${2:-}")"
  mkdir -p -- "${dir}"
  dst="${dir}/baseline-manifest.json"
  # Atomic capture via the shared swap (temp + rename); set -e aborts on failure.
  spine_atomic_swap "${manifest}" "${dst}"
  printf '%s\n' "${dst}"
}

# Read the stored base@install anchor: echo its path and return 0 when present,
# else return 1 (the `get` contract — absence is a normal non-error result the
# caller branches on, NOT a thrown failure). Arg: $1 = optional state-dir
# override.
spine_get_baseline() {
  local dst
  dst="$(spine_baseline_path "${1:-}")"
  if [[ -f "${dst}" ]]; then
    printf '%s\n' "${dst}"
    return 0
  fi
  return 1
}
