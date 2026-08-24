#!/usr/bin/env bash
# derive-retired-seed.sh — reproduce the manifest `retired` map from git history.
#
# The generator (generate-manifest.sh) can only carry a map forward and append to
# it: it reads the COMMITTED manifest, so a path dropped before the map existed is
# invisible to it. This walks every historical manifest.json instead, which is
# where the hashes of already-dropped paths still live, and prints the map that
# seeds the generator once.
#
# Selection, identical to the generator's retired-map contract by construction —
# both ask spine_is_retired_excluded_path, and both call a path dropped only when
# git no longer knows it (absent from the RAW whole-repo `git ls-files`) AND it is
# absent from the working tree:
#   collect  every {path: sha256} pair any historical manifest.json ever recorded
#   drop     every path the tree still tracks or still holds on disk
#   drop     every path a barred family claims (applied Prisma migrations,
#            merge-claimed paths)
#
# NOT run by --check, by CI, or by any release path: it needs full history and
# those checkouts are depth-1. It is a maintainer tool, run by hand, and its output
# for this repo is committed as scripts/fixtures/retired-seed.json.
#
# Usage:
#   derive-retired-seed.sh          print the map as JSON on stdout
#
# Named exit codes: 2=usage · 3=git absent/not a work tree · 4=jq absent ·
# 5=shallow clone (no history to walk) · 6=no manifest.json in history ·
# 7=apply-spine.sh not found.
set -Eeuo pipefail
IFS=$'\n\t'

GA_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
readonly GA_ROOT
readonly SPINE_LIB="${GA_ROOT}/scripts/lib/apply-spine.sh"

[[ $# -eq 0 ]] || {
  echo "usage: ${0##*/}" >&2
  exit 2
}

command -v jq >/dev/null 2>&1 || {
  echo "derive-retired-seed: jq required" >&2
  exit 4
}

git -C "${GA_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "derive-retired-seed: ${GA_ROOT} is not a git work tree" >&2
  exit 3
}

[[ -f "${SPINE_LIB}" ]] || {
  echo "derive-retired-seed: ${SPINE_LIB} required (retired-map family predicate)" >&2
  exit 7
}
# shellcheck source=/dev/null
source "${SPINE_LIB}"

# A shallow clone silently yields a SHORT map — the walk would find only the
# commits it happens to hold — so refuse rather than print a partial seed.
if [[ "$(git -C "${GA_ROOT}" rev-parse --is-shallow-repository)" == "true" ]]; then
  echo "derive-retired-seed: shallow clone — the history walk needs a full clone" >&2
  exit 5
fi

# Emit the OID of every distinct manifest.json blob in history, one per line.
# Deduplicated at the OBJECT level rather than walked per commit: a merge-heavy
# history reaches the same blob from many commits, and reading each one again is
# the whole cost of the walk. A manifest predating the hashes map contributes
# nothing, which is the union's identity element.
history_manifest_oids() {
  git -C "${GA_ROOT}" rev-list --all --objects -- manifest.json \
    | awk '$2 == "manifest.json" { print $1 }' \
    | LC_ALL=C sort -u
}

# Emit `<path>\t<sha256>` for every pair any historical manifest.json recorded.
# ONE jq reads the concatenated blobs: 500-odd separate parses of a half-megabyte
# document is minutes, and the same filter over the concatenated stream is seconds.
history_hash_lines() {
  local oid
  while IFS= read -r oid; do
    [[ -n "${oid}" ]] || continue
    git -C "${GA_ROOT}" cat-file blob "${oid}"
  done < <(history_manifest_oids) \
    | jq -r '(.hashes // {}) | to_entries[] | "\(.key)\t\(.value)"'
}

# Emit the surviving `<path>\t<sha256>` lines — the pairs whose path the vendor no
# longer ships and no barred family claims.
#
# The set operations run in `comm`, not in the shell: history emits a pair per
# manifest revision per path, so the union before deduplication is six figures of
# lines and a per-line substring scan of the tracked set costs minutes. Only the
# handful of paths that survive the tracked-set difference reach the shell, where
# the two per-path predicates it alone can answer are applied.
seed_lines() {
  local pairs kept path
  pairs="$(history_hash_lines | LC_ALL=C sort -u)"
  kept=""
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    if [[ -e "${GA_ROOT}/${path}" ]]; then continue; fi
    if spine_is_retired_excluded_path "${path}"; then continue; fi
    kept+="${path}"$'\n'
  done < <(LC_ALL=C comm -23 \
    <(printf '%s\n' "${pairs}" | cut -f1 | LC_ALL=C sort -u) \
    <(git -C "${GA_ROOT}" ls-files | LC_ALL=C sort -u))
  [[ -n "${kept}" ]] || return 0
  LC_ALL=C join -t "$(printf '\t')" \
    <(printf '%s' "${kept}" | LC_ALL=C sort) \
    <(printf '%s\n' "${pairs}")
}

main() {
  local revisions
  # shellcheck disable=SC2312  # a wc over the emitter is the count itself; an empty emitter yields 0 and hits the guard
  revisions="$(history_manifest_oids | wc -l | tr -d ' ')"
  [[ "${revisions}" -gt 0 ]] || {
    echo "derive-retired-seed: no manifest.json anywhere in history" >&2
    exit 6
  }
  seed_lines | LC_ALL=C sort -u | spine_build_retired_map
}

main
