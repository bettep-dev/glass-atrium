#!/usr/bin/env bash
# generate-manifest.sh — regenerate manifest.json from git ls-files.
# This script is the manifest SoT generator: manifest.json MUST never be
# hand-edited, only regenerated here (or verified with --check).
#
# Schema (v1.0.0 — version + per-file integrity added for the update system):
#   {
#     "version": "1.0.0",            top-level SINGLE Atrium system version SoT
#     "_doc_settings_json": "…",     settings.json never-touch contract doc
#     "files": ["agents/foo.md", …], DEPLOY LIST — array of path STRINGS (the
#                                    installer symlink farm + doctor read this
#                                    shape verbatim; kept byte-compatible)
#     "hashes": {                    PARALLEL per-file SHA-256 map (path → hash)
#       "agents/foo.md": "<64-hex>", one entry per files[] path, same count;
#       …                            O(1) hashes[path] lookup for the update
#     }                              skill's hash-diff sync + integrity verify
#   }
# Schema rationale (parallel map, NOT files-as-objects): keeping files[] an
# array of strings leaves the installer (lib/ga-core.sh read_manifest_files /
# remove_manifest_links / doctor), validate-compliance-matrix.sh, and the
# acceptance/e2e suites — all of which do `jq -r '.files[]'` — working
# UNCHANGED. The hashes map adds integrity without breaking those consumers and
# gives downstream a direct hashes[path] lookup.
#
# Deploy-scope policy (codified HERE — the single authority):
#   INCLUDE  git-TRACKED files under the harness component dirs the engine
#            symlinks into ~/.claude — agents/ autoagent/ hooks/ rules/ scoped/
#            scripts/ skills/ — plus the top-level agent-registry.json and the
#            top-level glass-atrium launcher (deployed to ~/.claude/glass-atrium).
#   EXCLUDE  dev-only artifacts that must never deploy to ~/.claude:
#            */test/* trees + test_*.py / *.bats / *.test.js basenames (bats,
#            pytest, and node test suites run from the repo checkout, nothing
#            under ~/.claude consumes them), */archive/* (historical
#            snapshots, not live runtime), and publish-release.sh (the
#            maintainer/CI-only release-cutting tool — git-tracked for version
#            control but never deployed to a consumer ~/.claude).
#   Untracked/gitignored files are excluded by construction (git ls-files):
#   a fresh clone cannot contain them, so listing one hard-fails doctor §4
#   ("manifest source missing") on every fresh install.
#
# settings.json stays OUT of .files by contract (user-owned config the
# installer must never overwrite) — the rationale doc lives in the manifest's
# _doc_settings_json key, which regeneration carries over verbatim.
#
# Output is LC_ALL=C sorted (deterministic, diff-friendly) and written
# atomically (temp + jq re-validation + mv — never a half file).
#
# Usage:
#   generate-manifest.sh           regenerate manifest.json in place
#   generate-manifest.sh --check   verify-only: exit 1 + both-direction delta
#                                  listing when the tracked manifest diverges
#                                  from the generated set — orphan/missing
#                                  paths, a VERSION mismatch, OR a per-file
#                                  HASH mismatch (content changed, path
#                                  unchanged) all diverge (CI/acceptance gate)
#
# Named exit codes: 1=--check divergence · 3=git absent or not a work tree ·
# 4=jq or sha256 tool absent · 5=manifest or _doc_settings_json missing ·
# 6=empty generation.
set -euo pipefail

# Single Atrium system version-of-record. Stamped into manifest.version on
# regeneration and asserted by --check. The monitor health endpoint and the
# update badge read THIS via the manifest (D1 — one version SoT).
readonly ATRIUM_VERSION="1.0.0"

# Repo root = parent of this script's scripts/ dir (portable, same idiom as
# the engine's root resolution).
GA_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
readonly GA_ROOT
readonly MANIFEST="${GA_ROOT}/manifest.json"

# Deploy scope — the component paths the engine farms into ~/.claude. A new
# top-level component dir must be added here DELIBERATELY (policy change),
# never inferred.
readonly -a SCOPE_PATHS=(
  "agent-registry.json"
  "agents"
  "autoagent"
  "glass-atrium"
  "hooks"
  "rules"
  "scoped"
  "scripts"
  "skills"
)

# Dev-only exclusions (test trees, test-file basenames, archive snapshots).
readonly EXCLUDE_RE='(^|/)test/|(^|/)test_[^/]*\.py$|\.bats$|\.test\.js$|(^|/)archive/|(^|/)publish-release\.sh$'

command -v jq >/dev/null 2>&1 || {
  echo "generate-manifest: jq required" >&2
  exit 4
}

# SHA-256 tool — shasum (macOS / perl-backed, also on CI ubuntu) preferred,
# coreutils sha256sum as the Linux fallback. Both honor `--` end-of-options.
if command -v shasum >/dev/null 2>&1; then
  readonly -a SHA256_CMD=(shasum -a 256)
elif command -v sha256sum >/dev/null 2>&1; then
  readonly -a SHA256_CMD=(sha256sum)
else
  echo "generate-manifest: neither shasum nor sha256sum found (per-file integrity required)" >&2
  exit 4
fi

git -C "${GA_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "generate-manifest: ${GA_ROOT} is not a git work tree (git ls-files is the file-list SoT)" >&2
  exit 3
}

# Echo the lowercase 64-hex SHA-256 of a single file (first whitespace field of
# the tool output, dropping the trailing filename column).
sha256_of() {
  "${SHA256_CMD[@]}" -- "$1" | awk '{print $1}'
}

# Emit the generated deploy file list, one path per line, sorted.
# grep exit 1 (= every tracked file excluded) is absorbed so the empty set
# reaches the named exit-6 guard instead of dying as an opaque pipefail.
generate_files() {
  git -C "${GA_ROOT}" ls-files -- "${SCOPE_PATHS[@]}" \
    | { grep -vE "${EXCLUDE_RE}" || true; } \
    | LC_ALL=C sort
}

# Emit `<path>\t<sha256>` for every generated file, sorted by path. Reused by
# both the regenerate assembly and the --check hash gate.
emit_hash_lines() {
  local f
  while IFS= read -r f; do
    printf '%s\t%s\n' "${f}" "$(sha256_of "${GA_ROOT}/${f}")"
  done < <(generate_files) | LC_ALL=C sort
}

# Emit the tracked manifest's file list, sorted (for --check comparison).
read_manifest_files() {
  jq -r '.files[]' -- "${MANIFEST}" | LC_ALL=C sort
}

# Emit the tracked manifest's `<path>\t<sha256>` hash lines, sorted by path.
# `.hashes // {}` tolerates a pre-v1.0.0 manifest with no hashes key (the
# version gate flags that divergence separately) instead of a jq null error.
read_manifest_hash_lines() {
  jq -r '(.hashes // {}) | to_entries[] | "\(.key)\t\(.value)"' -- "${MANIFEST}" \
    | LC_ALL=C sort
}

# The _doc_settings_json contract doc must survive every regeneration —
# losing it silently drops the settings.json never-touch documentation.
read_doc_key() {
  [[ -f "${MANIFEST}" ]] || {
    echo "generate-manifest: manifest not found: ${MANIFEST}" >&2
    exit 5
  }
  jq -er '._doc_settings_json' -- "${MANIFEST}" || {
    echo "generate-manifest: _doc_settings_json missing from ${MANIFEST} — refusing to regenerate without the settings.json contract doc" >&2
    exit 5
  }
}

run_check() {
  local doc orphans missing mismatches manifest_version gen_count rc=0
  doc="$(read_doc_key)" || exit $?
  [[ -n "${doc}" ]] || exit 5

  # An empty generated set means the scope/exclusion config is broken — the
  # same fatal condition run_generate guards (exit 6), surfaced from --check too.
  gen_count="$(generate_files | wc -l | tr -d ' ')"
  [[ "${gen_count}" -gt 0 ]] || {
    echo "generate-manifest --check: generated file set is EMPTY — scope/exclusion misconfigured" >&2
    exit 6
  }

  # version gate — the manifest must carry the current system version SoT.
  manifest_version="$(jq -r '.version // empty' -- "${MANIFEST}")"
  if [[ "${manifest_version}" != "${ATRIUM_VERSION}" ]]; then
    echo "generate-manifest --check: VERSION mismatch (manifest='${manifest_version:-<absent>}', expected='${ATRIUM_VERSION}')" >&2
    rc=1
  fi

  # orphans = listed but not in the generated (tracked, in-scope) set —
  # each one hard-fails doctor §4 on a fresh clone.
  # LC_ALL=C on comm itself is load-bearing: BSD comm collates by the session
  # locale and silently mis-diffs C-sorted input under UTF-8 collation.
  orphans="$(LC_ALL=C comm -23 <(read_manifest_files) <(generate_files))"
  # missing = tracked in-scope but unlisted — deploy gap doctor cannot see
  # (doctor only checks listed→present, never tracked→listed).
  missing="$(LC_ALL=C comm -13 <(read_manifest_files) <(generate_files))"
  # hash mismatches = paths present in BOTH the manifest and the generated set
  # whose recorded hash differs from the freshly computed one (content drift
  # with an unchanged path). `join` on the path field restricts to the
  # intersection, so orphan/missing paths are not double-reported here.
  mismatches="$(LC_ALL=C join -t "$(printf '\t')" \
    <(read_manifest_hash_lines) <(emit_hash_lines) \
    | awk -F'\t' '$2 != $3 { printf "%s (manifest=%s actual=%s)\n", $1, $2, $3 }')"

  if [[ -n "${orphans}" ]]; then
    echo "generate-manifest --check: ORPHAN entries (listed, not tracked/in-scope):" >&2
    printf '%s\n' "${orphans}" | sed 's/^/  - /' >&2
    rc=1
  fi
  if [[ -n "${missing}" ]]; then
    echo "generate-manifest --check: MISSING entries (tracked in-scope, not listed):" >&2
    printf '%s\n' "${missing}" | sed 's/^/  + /' >&2
    rc=1
  fi
  if [[ -n "${mismatches}" ]]; then
    echo "generate-manifest --check: HASH mismatches (content changed, path unchanged):" >&2
    printf '%s\n' "${mismatches}" | sed 's/^/  ~ /' >&2
    rc=1
  fi

  if [[ "${rc}" -eq 0 ]]; then
    echo "generate-manifest --check: manifest matches generated set (${gen_count} files, version ${ATRIUM_VERSION}, hashes + both directions clean)"
  else
    echo "generate-manifest --check: DIVERGED — run scripts/generate-manifest.sh to regenerate" >&2
  fi
  return "${rc}"
}

run_generate() {
  local doc count tmp files_json hashes_json
  doc="$(read_doc_key)" || exit $?
  count="$(generate_files | wc -l | tr -d ' ')"
  # an empty list means the scope/exclusion config is broken, never a valid
  # deploy set — refuse to write a manifest that would install nothing.
  [[ "${count}" -gt 0 ]] || {
    echo "generate-manifest: generated file set is EMPTY — scope/exclusion misconfigured, aborting" >&2
    exit 6
  }

  # files[] = sorted array of path strings (unchanged shape).
  files_json="$(generate_files | jq -R . | jq -s .)"
  # hashes = {path: sha256} merged from the per-file tab lines (one single-key
  # object per line → add). `// {}` keeps a defined object if the stream is
  # empty (the count guard above already precludes that).
  hashes_json="$(emit_hash_lines | jq -R 'split("\t") | {(.[0]): .[1]}' | jq -s 'add // {}')"

  tmp="${MANIFEST}.ga-gen.$$"
  jq -n \
    --arg ver "${ATRIUM_VERSION}" \
    --arg doc "${doc}" \
    --argjson files "${files_json}" \
    --argjson hashes "${hashes_json}" \
    '{version: $ver, _doc_settings_json: $doc, files: $files, hashes: $hashes}' \
    >"${tmp}"

  # re-validate before the swap — a malformed temp must never replace the live
  # manifest. Invariants: version stamped, files non-empty array, hashes an
  # object with one 64-hex entry per file (uses the wire_hooks atomic-write
  # contract: temp + validate + mv).
  jq -e '
    (.version | type == "string" and . == "'"${ATRIUM_VERSION}"'")
    and (._doc_settings_json | type == "string")
    and (.files | type == "array" and length > 0)
    and (.hashes | type == "object")
    and ((.hashes | length) == (.files | length))
    and (.hashes | to_entries | all(.value | test("^[0-9a-f]{64}$")))
  ' -- "${tmp}" >/dev/null 2>&1 || {
    rm -f -- "${tmp}"
    echo "generate-manifest: generated manifest failed validation — aborting" >&2
    exit 6
  }

  mv -f -- "${tmp}" "${MANIFEST}"
  echo "generate-manifest: wrote ${MANIFEST} (${count} files, version ${ATRIUM_VERSION}, ${count} hashes)"
}

case "${1:-}" in
  --check) run_check ;;
  "") run_generate ;;
  *)
    echo "usage: ${0##*/} [--check]" >&2
    exit 2
    ;;
esac
