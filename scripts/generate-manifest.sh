#!/usr/bin/env bash
# generate-manifest.sh — regenerate manifest.json from git ls-files.
# manifest.json is the SoT: never hand-edited, only regenerated here (or --check).
#
# Schema (v1.0.0):
#   version              single Atrium system version SoT
#   _doc_settings_json   settings.json never-touch contract doc
#   files                DEPLOY LIST — array of path STRINGS e.g. "agents/foo.md"
#   hashes               parallel {path: sha256} map, one entry per files[] path
#   modes                parallel {path: octal} map, one entry per files[] path —
#                        the post-extract mode-enforcement SoT (FB-2). ALL files,
#                        not executables only, so every landing surface (tar
#                        extract, spine cp -p, agent-merge copy) has a map target.
#                        Additive optional key: pre-modes consumers ignore it.
# files[] stays a string array (NOT files-as-objects) so every `jq -r '.files[]'`
# consumer (ga-core.sh read/remove_manifest_links + doctor, validate-compliance-matrix,
# acceptance/e2e) works UNCHANGED; hashes adds integrity + O(1) hashes["agents/foo.md"] lookup.
#
# Deploy-scope policy (single authority). manifest.files is BOTH the release-bundle
# member list AND the ~/.claude symlink-farm source, so it carries two categories:
#   INCLUDE-A  SYMLINKED harness — git-tracked agents/ autoagent/ rules/ scripts/
#              skills/ (farmed into ~/.claude).
#   INCLUDE-B  INSTALL-INTERNAL runtime — bundled + hash-verified but consumed IN PLACE
#              from ~/.glass-atrium, NEVER symlinked (ga-core.sh::is_symlink_excluded
#              SYMLINK_EXCLUDE_PREFIXES/EXACT filters them out): hooks/ scoped/,
#              agent-registry.json + the glass-atrium launcher, lib/ (the
#              install/update ENGINE the launcher SOURCES), config.toml.example,
#              requirements.txt, monitor/ (dashboard built + run in place; its
#              gitignored data/node_modules/dist + monitor/test/* auto-excluded),
#              docs/assets/bulldog-braille.txt (the ONE shipped TUI art asset the
#              launcher WHOLESALE-loads at runtime — its build-time generator .py +
#              reference .webp are NOT scoped, runtime dep 0), and the four
#              executable-suite roots test/ hooks/test/ scripts/test/ autoagent/test/
#              (the daemon-apply preflight runs the suite in place, so it must ship;
#              the root test/ rides the ga-env.sh SYMLINK_EXCLUDE_PREFIXES "test/"
#              prefix to stay install-internal, the three sub-roots ride their parent
#              prefixes). Without lib/ + monitor/ a fresh no-.git bundle is
#              dead-on-arrival (launcher source + monitor build/run have no target).
#   EXCLUDE    dev-only: monitor/test/ (dashboard .test.ts, NOT the harness suite —
#              no other pattern here catches .test.ts, .ts != .js), *.test.js basenames,
#              */archive/*, publish-release.sh (maintainer/CI-only). Untracked/gitignored
#              excluded by construction — listing one hard-fails doctor §4 on a fresh clone.
#
# settings.json stays OUT of .files (user-owned config the installer must never
# overwrite) — rationale in _doc_settings_json, carried over verbatim on regen.
#
# Output is LC_ALL=C sorted and written atomically (temp + jq re-validation + mv).
#
# Usage:
#   generate-manifest.sh           regenerate manifest.json in place
#   generate-manifest.sh --check   verify-only: exit 1 + both-direction delta on
#                                  orphan/missing paths, VERSION mismatch, OR per-file
#                                  HASH mismatch (content changed, path unchanged)
#
# Named exit codes: 1=--check divergence · 3=git absent/not a work tree ·
# 4=jq or sha256 tool absent · 5=manifest or _doc_settings_json missing · 6=empty generation.
set -euo pipefail

# Single Atrium system version-of-record. Stamped into manifest.version on
# regeneration and asserted by --check. The monitor health endpoint and the
# update badge read THIS via the manifest (D1 — one version SoT).
readonly ATRIUM_VERSION="1.0.1"

# Repo root = parent of this script's scripts/ dir (portable, same idiom as
# the engine's root resolution).
GA_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
readonly GA_ROOT
readonly MANIFEST="${GA_ROOT}/manifest.json"

# Manifest scope — the paths hashed + bundled + integrity-verified. A new
# top-level entry must be added here DELIBERATELY (policy change), never inferred.
# INCLUDE-A/B membership is decided by ga-core.sh::is_symlink_excluded
# (SYMLINK_EXCLUDE_PREFIXES/EXACT), NOT by position in this array — array order
# is manifest-output order only. Symlinked (INCLUDE-A): agents, autoagent,
# rules, scripts, skills. Install-internal (INCLUDE-B): agent-registry.json,
# glass-atrium, hooks, scoped, plus the tail entries below. See the
# Deploy-scope policy note above.
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
  # INCLUDE-B tail — install-internal runtime (full membership in the note above)
  "config.toml.example"
  "lib"
  "monitor"
  "requirements.txt"
  # Root executable-suite dir. hooks/test, scripts/test, autoagent/test ride their
  # parent scope entries above; the root test/ has no parent, so it needs an explicit
  # entry to enter git ls-files scope. Install-internal (run in place by the
  # daemon-apply preflight, never symlinked — its farm exclusion rides the
  # lib/ga-env.sh SYMLINK_EXCLUDE_PREFIXES "test/" prefix).
  "test"
  # The ONE shipped bulldog art asset — draw_bulldog_art WHOLESALE-loads it at runtime from
  # ${GA_ROOT}/docs/assets/bulldog-braille.txt, so it must bundle + hash-verify like any other
  # install-internal runtime file. Scoped as an EXACT single path (NOT "docs/"): the offline
  # generator bulldog-braille-gen.py + the reference webp are BUILD-TIME only (runtime dep 0),
  # so they stay OUT of the runtime bundle.
  "docs/assets/bulldog-braille.txt"
)

# Dev-only exclusions. monitor/test is carved out surgically — its .test.ts
# dashboard tests are not the harness suite, and no other alternation here catches
# .test.ts (.ts != .js). The four executable-suite roots (test/, hooks/test/,
# scripts/test/, autoagent/test/) are deliberately NOT excluded: they bundle
# install-internal so the daemon-apply preflight can run them in place, which is why
# there is no blanket test/ dir alternation and no .bats / test_*.py basename drop.
readonly EXCLUDE_RE='(^|/)monitor/test/|\.test\.js$|(^|/)archive/|(^|/)publish-release\.sh$'

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

# Octal-mode reader variant — resolve the working `stat` format string ONCE (BSD
# `%Lp` vs GNU `%a`), same dual-tool `command -v` posture as SHA256_CMD, so mode_of
# forks a SINGLE stat per file instead of re-probing BSD-then-GNU every call. Both
# forms carry `-L` (DEREFERENCE symlinks — record the target's mode, not the link's
# lstat bits; rationale in mode_of). Empty array = no working stat variant → mode_of
# falls back to 644 (regular-file default) so the modes map stays count-complete.
if stat -L -f '%Lp' . >/dev/null 2>&1; then
  readonly -a STAT_MODE_CMD=(stat -L -f '%Lp')
elif stat -L -c '%a' . >/dev/null 2>&1; then
  readonly -a STAT_MODE_CMD=(stat -L -c '%a')
else
  readonly -a STAT_MODE_CMD=()
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

# Echo the octal permission mode (e.g. 644 / 755) of a single file. `-L`
# DEREFERENCES symlinks so a git symlink records its TARGET's mode, not the
# link's own lstat bits: a symlink lstats 0755 (macOS) / 0777 (Linux), but the
# post-extract enforcers `chmod` the path and chmod FOLLOWS the link to its
# target — recording the target's 0644 keeps enforcement consistent (recording
# the link's 0755 would wrongly chmod the target, exactly the FB-2 defect that
# flipped GLASS_ATRIUM_GLOBAL_RULES.md to 755). BSD stat (macOS) first, GNU
# coreutils fallback (same dual-tool posture as SHA256_CMD). A dangling symlink
# (target absent) has no dereferenceable mode — fall back to 644 (regular-file
# default) so the modes map stays complete (one entry per files[] path, as the
# count-parity gate requires) instead of aborting the whole regen over one
# broken link.
mode_of() {
  if ((${#STAT_MODE_CMD[@]})); then
    "${STAT_MODE_CMD[@]}" "$1" 2>/dev/null || echo 644
  else
    echo 644
  fi
}

# Emit the generated deploy file list, one path per line, sorted.
# grep exit 1 (= every tracked file excluded) is absorbed so the empty set
# reaches the named exit-6 guard instead of dying as an opaque pipefail.
generate_files() {
  git -C "${GA_ROOT}" ls-files -- "${SCOPE_PATHS[@]}" \
    | { grep -vE "${EXCLUDE_RE}" || true; } \
    | LC_ALL=C sort
}

# Emit `<path>\t<sha256>` for each path read from stdin, sorted by path. The
# caller feeds the memoized generate_files list so ONE git ls-files pass serves
# both this and emit_mode_lines. Reused by regen + the --check hash gate.
emit_hash_lines() {
  local f
  while IFS= read -r f; do
    printf '%s\t%s\n' "${f}" "$(sha256_of "${GA_ROOT}/${f}")"
  done | LC_ALL=C sort
}

# Emit `<path>\t<octal mode>` for each path read from stdin, sorted by path — the
# modes-map source. Same memoized-list stdin contract as emit_hash_lines.
emit_mode_lines() {
  local f
  # shellcheck disable=SC2312  # mode_of's rc is intentionally unused — it always prints a mode or the 644 fallback
  while IFS= read -r f; do
    printf '%s\t%s\n' "${f}" "$(mode_of "${GA_ROOT}/${f}")"
  done | LC_ALL=C sort
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

# Emit the tracked manifest's `<path>\t<mode>` lines, sorted by path. `.modes // {}`
# tolerates a pre-modes manifest (the count gate flags that gap separately).
read_manifest_mode_lines() {
  jq -r '(.modes // {}) | to_entries[] | "\(.key)\t\(.value)"' -- "${MANIFEST}" \
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
  local modes_count mode_mismatches files
  doc="$(read_doc_key)" || exit $?
  [[ -n "${doc}" ]] || exit 5

  # Single git ls-files pass — the sorted list feeds the count, both comm diffs,
  # and both emitters. An empty set means the scope/exclusion config is broken —
  # the same fatal condition run_generate guards (exit 6), surfaced from --check.
  files="$(generate_files)"
  [[ -n "${files}" ]] || {
    echo "generate-manifest --check: generated file set is EMPTY — scope/exclusion misconfigured" >&2
    exit 6
  }
  gen_count="$(printf '%s\n' "${files}" | wc -l | tr -d ' ')"

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
  orphans="$(LC_ALL=C comm -23 <(read_manifest_files) <(printf '%s\n' "${files}"))"
  # missing = tracked in-scope but unlisted — deploy gap doctor cannot see
  # (doctor only checks listed→present, never tracked→listed).
  missing="$(LC_ALL=C comm -13 <(read_manifest_files) <(printf '%s\n' "${files}"))"
  # hash mismatches = paths present in BOTH the manifest and the generated set
  # whose recorded hash differs from the freshly computed one (content drift
  # with an unchanged path). `join` on the path field restricts to the
  # intersection, so orphan/missing paths are not double-reported here.
  mismatches="$(LC_ALL=C join -t "$(printf '\t')" \
    <(read_manifest_hash_lines) <(printf '%s\n' "${files}" | emit_hash_lines) \
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

  # mode gate — a chmod with unchanged content is INVISIBLE to the hash gate,
  # yet a stale modes map would make the installers ENFORCE the wrong mode (the
  # FB-2 inert-hook class one level up). Count gap catches an absent/incomplete
  # map; the join catches per-file drift on the intersection.
  modes_count="$(jq -r '(.modes // {}) | length' -- "${MANIFEST}")"
  # shellcheck disable=SC2312  # same join-on-intersection contract as the hash gate
  mode_mismatches="$(LC_ALL=C join -t "$(printf '\t')" \
    <(read_manifest_mode_lines) <(printf '%s\n' "${files}" | emit_mode_lines) \
    | awk -F'\t' '$2 != $3 { printf "%s (manifest=%s actual=%s)\n", $1, $2, $3 }')"
  if [[ "${modes_count}" != "${gen_count}" ]]; then
    echo "generate-manifest --check: MODES map incomplete (${modes_count} entries, expected ${gen_count})" >&2
    rc=1
  fi
  if [[ -n "${mode_mismatches}" ]]; then
    echo "generate-manifest --check: MODE mismatches (permission changed, content unchanged):" >&2
    printf '%s\n' "${mode_mismatches}" | sed 's/^/  ~ /' >&2
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
  local doc count tmp files files_json hashes_json modes_json
  doc="$(read_doc_key)" || exit $?
  # Single git ls-files pass — the sorted list feeds count, files_json, and BOTH
  # emitters (one pass instead of four independent re-runs).
  files="$(generate_files)"
  # an empty list means the scope/exclusion config is broken, never a valid
  # deploy set — refuse to write a manifest that would install nothing.
  [[ -n "${files}" ]] || {
    echo "generate-manifest: generated file set is EMPTY — scope/exclusion misconfigured, aborting" >&2
    exit 6
  }
  count="$(printf '%s\n' "${files}" | wc -l | tr -d ' ')"

  # files[] = sorted array of path strings (unchanged shape).
  files_json="$(printf '%s\n' "${files}" | jq -R . | jq -s .)"
  # hashes = {path: sha256} merged from the per-file tab lines (one single-key
  # object per line → add). `// {}` keeps a defined object if the stream is
  # empty (the emptiness guard above already precludes that).
  hashes_json="$(printf '%s\n' "${files}" | emit_hash_lines | jq -R 'split("\t") | {(.[0]): .[1]}' | jq -s 'add // {}')"
  # modes = {path: octal}, same per-line merge as hashes (FB-2 enforcement SoT).
  modes_json="$(printf '%s\n' "${files}" | emit_mode_lines | jq -R 'split("\t") | {(.[0]): .[1]}' | jq -s 'add // {}')"

  tmp="${MANIFEST}.ga-gen.$$"
  jq -n \
    --arg ver "${ATRIUM_VERSION}" \
    --arg doc "${doc}" \
    --argjson files "${files_json}" \
    --argjson hashes "${hashes_json}" \
    --argjson modes "${modes_json}" \
    '{version: $ver, _doc_settings_json: $doc, files: $files, hashes: $hashes, modes: $modes}' \
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
    and (.modes | type == "object")
    and ((.modes | length) == (.files | length))
    and (.modes | to_entries | all(.value | test("^[0-7]{3,4}$")))
  ' -- "${tmp}" >/dev/null 2>&1 || {
    rm -f -- "${tmp}"
    echo "generate-manifest: generated manifest failed validation — aborting" >&2
    exit 6
  }

  mv -f -- "${tmp}" "${MANIFEST}"
  echo "generate-manifest: wrote ${MANIFEST} (${count} files, version ${ATRIUM_VERSION}, ${count} hashes, ${count} modes)"
  refresh_deployed_farm
}

# deployed-facade refresh (maintainer flow — incident #58325)
# A dev-added file enters the regenerated manifest above, but nothing re-ran
# the ~/.claude symlink farm — the facade drifted until the next incidental
# agent add/delete (the doctor only REPORTS undeployed entries). When THIS repo
# root is a live deployment (its launcher exists AND the facade already holds
# symlinks pointing into this root), refresh the farm via the shared lib ->
# canonical `glass-atrium agents-only` (idempotent). A fixture/CI checkout has
# no launcher (and its facade holds no links into it) -> the cheap gates skip
# before any facade scan. Best-effort + loud: the manifest write above already
# succeeded — a farm hiccup WARNs with a manual remediation hint instead of
# failing the regeneration (agent_lifecycle rolls its chain back on non-zero
# and runs its own farm step right after this script).
refresh_deployed_farm() {
  local farm_lib="${GA_ROOT}/scripts/lib/mirror-farm.sh" home linked rc=0
  [[ -x "${GA_ROOT}/glass-atrium" ]] || return 0 # not a deployable root
  [[ -f "${farm_lib}" ]] || return 0             # lib not shipped here
  # shellcheck source=/dev/null
  source "${farm_lib}"
  home="$(farm_target_home)"
  # stdout-verdict helper (always exits 0) — the $( ) masking is its contract.
  # shellcheck disable=SC2311,SC2312
  linked="$(farm_has_ga_links "${home}" "${GA_ROOT}")"
  [[ "${linked}" == "yes" ]] || return 0 # facade not deployed from this root
  # rc 3 = clean skip (logged by the lib) · rc 1 = farm failed -> loud WARN.
  # shellcheck disable=SC2310
  farm_refresh "${GA_ROOT}" || rc=$?
  if [[ "${rc}" -ne 0 && "${rc}" -ne 3 ]]; then
    echo "generate-manifest: WARN: mirror-farm refresh failed — run '${GA_ROOT}/glass-atrium agents-only' manually" >&2
  fi
  return 0
}

case "${1:-}" in
  --check) run_check ;;
  "") run_generate ;;
  *)
    echo "usage: ${0##*/} [--check]" >&2
    exit 2
    ;;
esac
