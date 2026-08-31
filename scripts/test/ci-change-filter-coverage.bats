#!/usr/bin/env bats
# ci-change-filter-coverage.bats — every root-level file this cycle's suites read as a policy
# input MUST trigger the CI bash leg. The check EVALUATES the globs parsed out of the workflow:
# a literal-presence check would pass a glob that can never match the path it is meant to guard.
#
# Repo-only input: .github/workflows/ci.yml is a manifest NON-member and a consumer install has
# no `.github` directory at all, while scripts/test ships — hence the work-tree guard + a skip
# carrying its reason, same placement rule as the other repo-only suites.
#
# Run via: bats scripts/test/ci-change-filter-coverage.bats
# Requires: bats >= 1.5.0, bash 3.2+ (static read of one file — no CI run)

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
CI_YML="${GA}/.github/workflows/ci.yml"

# Hand-maintained list — a new root-level policy input must be added here AND to the filter.
# The glob evaluation below catches a filter-side regression; a missing entry here is invisible.
POLICY_PATHS='requirements.txt
requirements-dev.txt
config.toml.example
agent-registry.json
.github/workflows/ci.yml'

# Emits one glob per `- '<glob>'` line of the detect-changes `bash:` filter. The range ends at
# the next bare key at any indent (`python:`), so a renamed sibling cannot silently widen it.
_bash_filter_globs() {
  sed -n "/^[[:space:]]*bash:[[:space:]]*\$/,/^[[:space:]]*[a-z_][a-z_]*:[[:space:]]*\$/p" "$1" \
    | sed -n "s/^[[:space:]]*-[[:space:]]*'\\(.*\\)'[[:space:]]*\$/\\1/p"
}

_matches_any_glob() {
  local path="$1" glob
  shift
  for glob in "$@"; do
    # shellcheck disable=SC2053
    # RHS stays unquoted on purpose — quoting it would force a literal compare, not a glob match.
    if [[ "${path}" == ${glob} ]]; then
      return 0
    fi
  done
  return 1
}

@test "coverage: every policy path matches at least one bash filter glob" {
  git -C "${GA}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || skip "Repo-only: .github/workflows/ci.yml is a manifest non-member, absent from a consumer install"
  local -a globs=()
  local g p uncovered=""
  while IFS= read -r g; do
    [[ -n "${g}" ]] || continue
    globs+=("${g}")
  done < <(_bash_filter_globs "${CI_YML}")
  [[ "${#globs[@]}" -gt 0 ]] || {
    printf 'no bash filter globs parsed from %s — the parser lost its anchor\n' "${CI_YML}" >&2
    return 1
  }
  while IFS= read -r p; do
    [[ -n "${p}" ]] || continue
    _matches_any_glob "${p}" "${globs[@]}" || uncovered="${uncovered}${p} "
  done <<EOF
${POLICY_PATHS}
EOF
  [[ -z "${uncovered}" ]] || {
    printf 'policy path matches NO bash filter glob (a single-file PR would skip test-bash): %s\n' \
      "${uncovered}" >&2
    printf -- '--- parsed globs ---\n%s\n' "$(printf '%s\n' "${globs[@]}")" >&2
    return 1
  }
}
