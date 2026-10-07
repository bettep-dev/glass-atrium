#!/usr/bin/env bats
# ci-change-filter-coverage.bats — every file a CI leg's suites read MUST trigger that leg's
# detect-changes filter (bash, python, monitor). The check EVALUATES the globs parsed out of the
# workflow: a literal-presence check would pass a glob that can never match the path it guards.
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

# Hand-maintained `<leg> <path>` rows — a new cross-tree read must be added here AND to the
# filter. The glob evaluation below catches a filter-side regression; a missing row is invisible.
# bash rows: the three doc entries stand for the markdown/rule surface, each pinning a DIFFERENT
# covering set: the rule doc is reachable by `rules/**` too, thresholds.yaml by `skills/**`
# alone, and LICENSES-THIRD-PARTY.md by `**/*.md` and nothing else — so it is the only one of
# the three whose loss would follow from dropping that glob. It is a real bash-leg policy input:
# test/licenses-audit-gate.bats reads that document as its sole input, so a licenses-only PR
# that skipped the bash leg would retire the gate on exactly the change kind it polices.
# python / monitor rows: hook files outside each leg's own source globs that its tests read by
# path (test-python + test-python-pytest share the `python` output).
LEG_PATHS='bash requirements.txt
bash requirements-dev.txt
bash config.toml.example
bash agent-registry.json
bash glass-atrium
bash .github/workflows/ci.yml
bash rules/glass-atrium/core-security.md
bash skills/glass-atrium-ops-token-audit/thresholds.yaml
bash LICENSES-THIRD-PARTY.md
python hooks/track-outcome.sh
python hooks/pricing.json
python hooks/inject-scope-rules.sh
python hooks/validate-compliance-matrix.sh
monitor hooks/lib/review-flag-reasons.sh
monitor hooks/lib/style-ref-consts.sh
monitor hooks/lib/styleref-roster.sh
monitor hooks/pricing.json'

LEGS=(bash python monitor)

# Emits one glob per `- '<glob>'` line of the detect-changes `<key>:` filter. The range ends at
# the next bare key at any indent, so a renamed sibling cannot silently widen it.
_filter_globs() {
  local ci_yml="$1" key="$2"
  sed -n "/^[[:space:]]*${key}:[[:space:]]*\$/,/^[[:space:]]*[a-z_][a-z_]*:[[:space:]]*\$/p" "${ci_yml}" \
    | sed -n "s/^[[:space:]]*-[[:space:]]*'\\(.*\\)'[[:space:]]*\$/\\1/p"
}

# The filter is evaluated by dorny/paths-filter, i.e. picomatch, where a leading `**/` matches
# ZERO or more segments — so `**/*.md` covers a root-level `LICENSES-THIRD-PARTY.md`. Bash has
# no globstar inside `[[ ]]`: `**` collapses to `*` and the literal `/` then demands a slash, so
# a root-level path would read as uncovered against a filter that in fact covers it. The
# zero-segment form is therefore tried explicitly — without it this check mis-models the engine
# for every root-level path, which is the same defect class it exists to catch.
_matches_any_glob() {
  local path="$1" glob
  shift
  for glob in "$@"; do
    # shellcheck disable=SC2053
    # RHS stays unquoted on purpose — quoting it would force a literal compare, not a glob match.
    if [[ "${path}" == ${glob} ]]; then
      return 0
    fi
    if [[ "${glob}" == '**/'* ]]; then
      # shellcheck disable=SC2053
      if [[ "${path}" == ${glob#'**/'} ]]; then
        return 0
      fi
    fi
  done
  return 1
}

# Succeeds when <path> matches at least one glob of the <leg> filter.
_leg_covers() {
  local leg="$1" path="$2" g
  local -a globs=()
  while IFS= read -r g; do
    [[ -n "${g}" ]] && globs+=("${g}")
  done < <(_filter_globs "${CI_YML}" "${leg}")
  [[ "${#globs[@]}" -gt 0 ]] && _matches_any_glob "${path}" "${globs[@]}"
}

@test "coverage: every leg's cross-tree read matches at least one glob of that leg's filter" {
  git -C "${GA}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || skip "Repo-only: .github/workflows/ci.yml is a manifest non-member, absent from a consumer install"
  # `every` ANDs a filter's positive-only globs so none can match — every leg skips green, and
  # the `- '<glob>'` parse below cannot see the key that did it.
  ! grep -qE "^[[:space:]]*predicate-quantifier:" "${CI_YML}" || {
    printf 'predicate-quantifier key set in %s — `every` ANDs the positive-only globs, skipping every leg green\n' \
      "${CI_YML}" >&2
    return 1
  }
  local leg path uncovered=""
  for leg in "${LEGS[@]}"; do
    [[ -n "$(_filter_globs "${CI_YML}" "${leg}")" ]] || {
      printf 'no %s filter globs parsed from %s — the parser lost its anchor\n' "${leg}" "${CI_YML}" >&2
      return 1
    }
  done
  while read -r leg path; do
    [[ -n "${leg}" ]] || continue
    _leg_covers "${leg}" "${path}" || uncovered="${uncovered}${leg} ${path}"$'\n'
  done <<EOF
${LEG_PATHS}
EOF
  [[ -z "${uncovered}" ]] || {
    printf 'path matches NO glob of its leg filter (a PR touching only it would skip that leg):\n%s' \
      "${uncovered}" >&2
    return 1
  }
}
