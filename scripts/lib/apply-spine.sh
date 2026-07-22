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
# selection) · spine_find_removed_files (T13, vendor-removal provenance selection
# — files the prior baseline shipped but the new release dropped) ·
# spine_stage_and_verify + spine_commit_staged + spine_apply (T11, stage +
# per-file SHA-256 verify, then atomic swap with rollback) · spine_set_baseline +
# spine_get_baseline (T14, base@install anchor capture/read).
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

# Predicate: is this manifest path EXCLUDED from the deterministic non-agent
# sync? Returns 0 (excluded) / 1 (included). Exclusions (T13 CRITICAL):
#   * any markdown under agents/ — resolved by the SEPARATE E4 agent three-anchor
#     merge path (base@install / vendor / local), never here
#   * *.local.md   — learned local-overlay files (never vendor-owned)
#   * config.toml  — rendered, git-ignored runtime config (user-owned)
spine_is_excluded_path() {
  local path="$1"
  # any markdown anywhere under agents/ → E4 merge path
  if [[ "${path}" == agents/* && "${path}" == *.md ]]; then
    return 0
  fi
  if [[ "${path}" == *.local.md ]]; then
    return 0
  fi
  case "${path}" in
    config.toml | */config.toml) return 0 ;;
  esac
  return 1
}

# T13 — non-agent hash-diff change selection

# Emit (one relative path per line) the NON-AGENT files whose live content
# differs from the staged new-release manifest, with the agent/overlay/config
# exclusions applied. A path absent from the live install is reported as changed
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

# T13 — vendor-removal provenance selection

# Emit (one relative path per line) the NON-AGENT files that the PRIOR-VENDOR
# baseline shipped but the new release DROPPED, restricted to files still holding
# their pristine vendor content — i.e. safe to sweep. A live file whose content
# diverges from the baseline hash is a USER edit and is PRESERVED (never listed).
# The agent/overlay/config exclusions apply (those paths are owned by the E4
# merge / user, not the vendor sync). A path already absent locally is a no-op.
# This is the detection half of the deletion pass; the CALLER wires the list into
# the confirm-gate preview + the Trash removal (removal policy stays caller-side,
# same split as spine_find_changed_files → update_commit_callback). Args: $1 =
# prior-vendor baseline manifest.json · $2 = new-release manifest.json · $3 = live
# install root. Loud-fails (rc 1) on a missing manifest or a baseline path that
# carries no hash.
spine_find_removed_files() {
  local baseline_manifest="$1" new_manifest="$2" install_root="$3"
  local path want live target new_files
  spine_require_tools jq || return 1
  if [[ ! -f "${baseline_manifest}" ]]; then
    printf 'apply-spine: removal scan needs a baseline manifest: %s\n' \
      "${baseline_manifest}" >&2
    return 1
  fi
  if [[ ! -f "${new_manifest}" ]]; then
    printf 'apply-spine: removal scan needs a new-release manifest: %s\n' \
      "${new_manifest}" >&2
    return 1
  fi
  # Materialise the new release's file set ONCE for a fork-free membership test.
  new_files="$(jq -r '.files[]' -- "${new_manifest}")" || return 1
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    # agent/overlay/config paths are owned by other merge paths, never swept.
    if spine_is_excluded_path "${path}"; then
      continue
    fi
    # Still shipped by the new release → not a removal. Quoted pattern = literal.
    case $'\n'"${new_files}"$'\n' in
      *$'\n'"${path}"$'\n'*) continue ;;
      *) ;; # dropped by the new release → fall through to the provenance check
    esac
    target="${install_root}/${path}"
    # Already gone (or not a regular file we own) → nothing to remove.
    [[ -f "${target}" ]] || continue
    want="$(spine_get_manifest_hash "${baseline_manifest}" "${path}")"
    if [[ -z "${want}" ]]; then
      printf 'apply-spine: baseline has no hash for %s\n' "${path}" >&2
      return 1
    fi
    live="$(spine_sha256_of "${target}")" || return 1
    # User-modified vs the prior-vendor baseline → PRESERVE (never sweep an edit).
    if [[ "${live}" != "${want}" ]]; then
      continue
    fi
    printf '%s\n' "${path}"
  done < <(jq -r '.files[]' -- "${baseline_manifest}")
}

# T11 — staged apply + rollback

# Phase 1: copy each changed file from the new-release tree into a staging dir
# and verify the staged copy's SHA-256 equals the manifest hashes[path]. Reads
# the change set (one relative path per line) from STDIN. Touches ONLY the
# staging dir — the live install is never modified here, so any mismatch is a
# clean loud-fail (rc 1) with zero rollback needed. Args: $1 = new-release tree
# root · $2 = manifest.json · $3 = staging dir.
spine_stage_and_verify() {
  local new_dir="$1" manifest="$2" staging="$3"
  local path src dst want got
  # jq OR runnable python3 — the install.sh bootstrap verifies jq-less (pre-ga-deps).
  # shellcheck disable=SC2310
  spine_require_manifest_parser || return 1
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    src="${new_dir}/${path}"
    if [[ ! -f "${src}" ]]; then
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
    cp -p -- "${src}" "${dst}"
    got="$(spine_sha256_of "${dst}")" || return 1
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
spine_atomic_swap() {
  local src="$1" dst="$2" tmp
  tmp="${dst}.tmp.$$"
  if ! { cp -p -- "${src}" "${tmp}" && mv -f -- "${tmp}" "${dst}"; }; then
    rm -f -- "${tmp}"
    return 1
  fi
}

# Restore the live install to its pre-swap state from the snapshot dir. For each
# touched path: a snapshot copy exists → restore it; no snapshot → the file was
# newly created by the swap → remove it. Args: $1 = install root · $2 = snapshot
# dir · $3.. = touched relative paths. Best-effort: a failed restore is reported
# but does not abort the remaining restores (partial-recovery beats no recovery).
spine_rollback() {
  local install_root="$1" snapshot="$2"
  shift 2
  local path snap dst
  for path in "$@"; do
    [[ -n "${path}" ]] || continue
    snap="${snapshot}/${path}"
    dst="${install_root}/${path}"
    if [[ -f "${snap}" ]]; then
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
    if [[ ! -f "${src}" ]]; then
      failed="${path}"
      rc=1
      break
    fi
    # snapshot the pre-swap live file BEFORE marking touched / overwriting.
    if [[ -f "${dst}" ]]; then
      mkdir -p -- "$(dirname -- "${snap}")"
      if ! cp -p -- "${dst}" "${snap}"; then
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

# T11 transaction: verify the ENTIRE change set first (no install mutation),
# then commit with rollback. Reads the change set (one relative path per line)
# from STDIN. A staging/verify failure aborts before the install is touched at
# all; a commit failure rolls back. Args: $1 = new-release tree root · $2 =
# manifest.json · $3 = install root · $4 = work dir (staging/ + snapshot/ are
# created beneath it). Returns 0 only when every changed file is committed.
spine_apply() {
  local new_dir="$1" manifest="$2" install_root="$3" work_dir="$4"
  local staging="${work_dir}/staging" snapshot="${work_dir}/snapshot"
  local -a paths=()
  local path
  spine_require_tools jq || return 1
  mkdir -p -- "${staging}" "${snapshot}"
  while IFS= read -r path; do
    [[ -n "${path}" ]] && paths+=("${path}")
  done
  # Phase 1 — stage + verify ALL (loud-fail leaves the install untouched).
  printf '%s\n' "${paths[@]:-}" \
    | spine_stage_and_verify "${new_dir}" "${manifest}" "${staging}" || return 1
  # Phase 2 — snapshot + swap with rollback on any mid-swap failure.
  printf '%s\n' "${paths[@]:-}" \
    | spine_commit_staged "${staging}" "${install_root}" "${snapshot}" || return 1
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
