#!/usr/bin/env bats
# deploy-coverage-partition suite — pins that the two deploy consumers PARTITION
# the manifest: the E4 agent three-anchor merge (update.sh) and the deterministic
# hash-verified non-agent sync (apply-spine.sh). Before this suite the two scopes
# were written independently and asserted to be complements without anything
# checking it, so nine manifest-listed hash-bearing files — the Tier-1 charter,
# six reference documents, two templates — were claimed by NEITHER: skipped by
# the spine BEFORE their hash was ever compared, and below the merge's
# non-recursive glob. The deploy reported success without delivering them.
#
# The partition assertion is COUNT-AGNOSTIC: the uncovered set is printed by
# name and asserted EMPTY, so a tenth orphan cannot pass silently as the corpus
# grows. The merge side is measured BEHAVIOURALLY (the real loop is run and its
# per-file log read) rather than by restating its rule here, so the test cannot
# agree with a drifted predicate.
#
# Three regression pins guard the scoping: the spine's exclusion is EXACTLY the
# merge's complement, so a learned local-overlay path and the rendered runtime
# config are selected like any other row rather than carved out of both scopes.
# A second exclusion arm would put a row back in the state this suite exists to
# detect — reached by neither consumer and hash-verified by no deploy path.
#
# One invariant sits above those pins, scoped to the CHANGE SELECTION: the rows the
# selection holds back are EXACTLY the agent bodies the merge delivers, compared
# against an expectation spelled out in the test rather than read from the predicate.
# Scoped because one non-agent row is held back DOWNSTREAM of the selection and so
# outside what this measures — the registry withhold drops agent-registry.json from
# the apply set for a run whose added agent body did not install. That mechanism is
# owned by the roster work at clauded-docs/12418, which also widens the held-back
# claim to the roster files; when it lands this suite is owed a presence guard over
# those roster paths, and it carries none today.
#
# Hermetic: every fixture is built in a per-test mktemp sandbox; the repo
# manifest is read read-only and the live install is never touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
export GA
export MANIFEST="${GA}/manifest.json"

setup() {
  [[ -f "${MANIFEST}" ]] || skip "manifest.json not found: ${MANIFEST}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  WORK="$(cd -- "$(mktemp -d -t deploy-coverage-bats.XXXXXX)" && pwd -P)"
  # Baseline/merge state is pinned into the sandbox so the live ~/.claude tree is
  # never read or written by the merge-loop oracle below.
  export ATRIUM_UPDATE_STATE_DIR="${WORK}/state"
  export ATRIUM_UPDATE_MERGE_LIB_DIR="${GA}/autoagent/lib"
  mkdir -p "${ATRIUM_UPDATE_STATE_DIR}"
  # shellcheck source=/dev/null
  source "${GA}/scripts/lib/apply-spine.sh"
  # shellcheck source=/dev/null
  source "${GA}/scripts/update.sh"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# helpers

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
}

# Every manifest path (one per line).
manifest_paths() { jq -r '.files[]' -- "${MANIFEST}"; }

# Every manifest path under the agents subtree carrying a .md extension — the
# only domain in which the two consumers' scopes overlap at all.
manifest_agent_md_paths() {
  jq -r '.files[] | select(startswith("agents/")) | select(endswith(".md"))' -- "${MANIFEST}"
}

# Newline-delimited membership test (bash 3.2: no associative arrays).
# Args: $1 = newline-delimited set · $2 = candidate.
set_has() {
  case $'\n'"$1"$'\n' in
    *$'\n'"$2"$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}

# Which manifest paths does the MERGE consumer actually claim? Measured, not
# restated: a release tree carrying every agents-subtree markdown path is handed
# to the real merge loop against an EMPTY live install, so each path the loop
# reaches is reported by its own "is release-only (ADD)" line and each path it
# never reaches is silent. No python plan runs on this path, so the probe is
# cheap and has no dependency beyond the loop itself.
merge_claimed_paths() {
  local new="${WORK}/oracle/new" live="${WORK}/oracle/live" log="${WORK}/oracle/log"
  local path base claimed=""
  rm -rf -- "${WORK}/oracle"
  mkdir -p -- "${new}/agents" "${live}"
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    mkdir -p -- "$(dirname -- "${new}/${path}")"
    printf 'release %s\n' "${path}" >"${new}/${path}"
  done < <(manifest_agent_md_paths)
  printf '{"version":"oracle","files":[],"hashes":{}}\n' >"${new}/manifest.json"
  update_merge_agent_editable_regions "${new}" "${new}/manifest.json" "${live}" \
    >/dev/null 2>"${log}"
  claimed="$(sed -n 's/^.*agent merge: \(.*\) is release-only.*$/\1/p' "${log}")"
  # Map the reported basenames back to manifest paths. Basenames are asserted
  # unique across the domain (see the partition test), so the mapping is exact.
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    base="${path##*/}"
    if set_has "${claimed}" "${base}"; then
      printf '%s\n' "${path}"
    fi
  done < <(manifest_agent_md_paths)
}

# Build a release tree + live install in which every path given differs from the
# release, write a manifest over exactly those paths, and echo the spine's
# changed-file selection. Args: the relative paths.
selection_for() {
  local dir="${WORK}/sel"
  local path files="" hashes="" hash
  rm -rf -- "${dir}"
  mkdir -p -- "${dir}/new" "${dir}/live"
  for path in "$@"; do
    mkdir -p -- "$(dirname -- "${dir}/new/${path}")" "$(dirname -- "${dir}/live/${path}")"
    printf 'release %s\n' "${path}" >"${dir}/new/${path}"
    printf 'local %s\n' "${path}" >"${dir}/live/${path}"
    hash="$(sha256_of "${dir}/new/${path}")"
    files="${files}$(printf '%s' "${path}" | jq -R .),"
    hashes="${hashes}$(printf '%s' "${path}" | jq -R .):$(printf '%s' "${hash}" | jq -R .),"
  done
  printf '{"version":"t","files":[%s],"hashes":{%s}}\n' "${files%,}" "${hashes%,}" \
    >"${dir}/manifest.json"
  spine_find_changed_files "${dir}/manifest.json" "${dir}/live"
}

# The first manifest path matching a prefix — derived rather than hardcoded so
# the pin survives a renamed reference document or template.
first_manifest_path_under() {
  manifest_paths | grep -m 1 -- "^$1" || true
}

# tests — the partition itself

@test "every manifest path is claimed by exactly one deploy consumer" {
  local claimed_paths uncovered="" double="" path merge spine dups
  claimed_paths="$(merge_claimed_paths)"

  # The behavioural oracle maps basenames back to paths, so a duplicated
  # basename in the domain would make it ambiguous — fail loudly rather than
  # report a partition verdict the mapping cannot support.
  dups="$(manifest_agent_md_paths | sed 's#.*/##' | sort | uniq -d)"
  if [[ -n "${dups}" ]]; then
    echo "ambiguous oracle: duplicate agents-subtree basename(s):"
    echo "${dups}"
    return 1
  fi

  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    merge=0
    set_has "${claimed_paths}" "${path}" && merge=1
    spine=1
    spine_is_excluded_path "${path}" && spine=0
    if [[ $((merge + spine)) -eq 0 ]]; then
      uncovered="${uncovered}${path}"$'\n'
    fi
    if [[ $((merge + spine)) -eq 2 ]]; then
      double="${double}${path}"$'\n'
    fi
  done < <(manifest_paths)

  if [[ -n "${uncovered}" ]]; then
    echo "manifest path(s) claimed by NEITHER consumer (never delivered, never hash-verified):"
    printf '%s' "${uncovered}"
  fi
  if [[ -n "${double}" ]]; then
    echo "manifest path(s) claimed by BOTH consumers:"
    printf '%s' "${double}"
  fi
  # One assertion per line: a `[[ a ]] && [[ b ]]` compound whose FIRST half
  # fails is exempt from set -e, so it would read green while asserting nothing.
  [ -z "${uncovered}" ]
  [ -z "${double}" ]

  # The shipped detection helper must agree with the independent computation.
  run spine_find_uncovered_paths "${MANIFEST}"
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
}

@test "the shared predicate answers for the merge consumer exactly as the loop behaves" {
  local claimed_paths path expected actual mismatch=""
  claimed_paths="$(merge_claimed_paths)"
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    expected=0
    set_has "${claimed_paths}" "${path}" && expected=1
    actual=0
    spine_is_merge_claimed_path "${path}" && actual=1
    if [[ "${expected}" -ne "${actual}" ]]; then
      mismatch="${mismatch}${path} (loop=${expected} predicate=${actual})"$'\n'
    fi
  done < <(manifest_agent_md_paths)
  if [[ -n "${mismatch}" ]]; then
    echo "shared predicate disagrees with the merge loop it speaks for:"
    printf '%s' "${mismatch}"
  fi
  [ -z "${mismatch}" ]
}

# The set of manifest rows the change selection holds back, pinned as an invariant
# so a re-added exclusion cannot grow it silently. Held-back rows produced after
# the selection are out of this reading, per the suite header.
#
# Observed side: the shipped change selection, run over the real manifest against
# an EMPTY install root. Every row it does not name is a row some mechanism inside
# the selection held back — measured through the real path rather than restated.
# The empty root makes every present row differ, so nothing narrows the reading.
#
# Expected side: the manifest's own file list filtered by a glob spelled out
# here. Deriving it from the exclusion predicate would compare that predicate
# against itself: a wrong predicate moves both sides identically and the check
# could not go red in either direction. Spelled out, a predicate change moves the
# observed side alone and this list is what must then be re-spelled.
@test "the change selection holds back exactly the merge-delivered agent bodies" {
  local all_paths selected observed="" expected="" path rest
  local extra="" missing="" mechanism
  all_paths="$(manifest_paths)"
  mkdir -p -- "${WORK}/emptyroot"
  selected="$(spine_find_changed_files "${MANIFEST}" "${WORK}/emptyroot")"

  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    if ! set_has "${selected}" "${path}"; then
      observed="${observed}${path}"$'\n'
    fi
    if [[ "${path}" == agents/*.md ]]; then
      rest="${path#agents/}"
      if [[ "${rest}" != */* && "${rest}" != 'GLASS_ATRIUM_GLOBAL_RULES.md' ]]; then
        expected="${expected}${path}"$'\n'
      fi
    fi
  done <<<"${all_paths}"

  # Guards against a silently degrading derivation: an empty agent set or a
  # renamed charter would shrink the expectation instead of failing.
  [ -n "${expected}" ]
  set_has "${all_paths}" 'agents/GLASS_ATRIUM_GLOBAL_RULES.md' || return 1

  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    if ! set_has "${expected}" "${path}"; then
      mechanism='a mechanism this suite does not name'
      if spine_is_merge_claimed_path "${path}"; then
        mechanism='the merge claim'
      fi
      extra="${extra}${path} (held back by ${mechanism})"$'\n'
    fi
  done <<<"${observed}"

  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    if ! set_has "${observed}" "${path}"; then
      missing="${missing}${path}"$'\n'
    fi
  done <<<"${expected}"

  if [[ -n "${extra}" ]]; then
    echo "manifest path(s) the change selection holds back that the merge does not deliver:"
    printf '%s' "${extra}"
  fi
  if [[ -n "${missing}" ]]; then
    echo "merge-delivered agent body(ies) that reached plain replacement:"
    printf '%s' "${missing}"
  fi
  [ -z "${extra}" ]
  [ -z "${missing}" ]
}

# tests — the orphan class now reaches the deterministic sync

@test "the charter appears in the spine's changed-file selection when it differs" {
  run selection_for 'agents/GLASS_ATRIUM_GLOBAL_RULES.md'
  [ "${status}" -eq 0 ]
  [ "${output}" = 'agents/GLASS_ATRIUM_GLOBAL_RULES.md' ]
}

@test "a reference document appears in the spine's changed-file selection when it differs" {
  local reference
  reference="$(first_manifest_path_under 'agents/references/')"
  [ -n "${reference}" ]
  run selection_for "${reference}"
  [ "${status}" -eq 0 ]
  [ "${output}" = "${reference}" ]
}

@test "a template document appears in the spine's changed-file selection when it differs" {
  local template
  template="$(first_manifest_path_under 'agents/templates/')"
  [ -n "${template}" ]
  run selection_for "${template}"
  [ "${status}" -eq 0 ]
  [ "${output}" = "${template}" ]
}

# tests — the three exclusion arms, one regression pin each

@test "every merge-claimed agent body stays excluded from the spine's selection" {
  local claimed_paths
  claimed_paths="$(merge_claimed_paths)"
  [ -n "${claimed_paths}" ]
  # shellcheck disable=SC2086  # deliberate word-split: one arg per claimed path
  run selection_for ${claimed_paths}
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
}

# An overlay UNDER agents/ is claimed by the merge's own glob, so it is covered by
# the merge-claimed test above; this one probes a spelling outside that glob,
# where the selection is the sole consumer.
@test "a learned local-overlay path outside the agents glob is SELECTED" {
  run selection_for 'rules/glass-atrium/scope-dev.local.md'
  [ "${status}" -eq 0 ]
  [ "${output}" = 'rules/glass-atrium/scope-dev.local.md' ]
}

@test "the rendered runtime config path is SELECTED like any other unclaimed row" {
  run selection_for 'config.toml'
  [ "${status}" -eq 0 ]
  [ "${output}" = 'config.toml' ]
}

# tests — the merge consumer, and the loud detection line

@test "the merge loop still skips the charter" {
  local new="${WORK}/charter/new" live="${WORK}/charter/live"
  mkdir -p -- "${new}/agents" "${live}/agents"
  printf 'release charter\n' >"${new}/agents/GLASS_ATRIUM_GLOBAL_RULES.md"
  printf 'local charter\n' >"${live}/agents/GLASS_ATRIUM_GLOBAL_RULES.md"
  printf '{"version":"t","files":[],"hashes":{}}\n' >"${new}/manifest.json"
  run update_merge_agent_editable_regions "${new}" "${new}/manifest.json" "${live}"
  [ "${status}" -eq 0 ]
  # `|| return 1` is load-bearing: under bats a FAILING bare `[[ ]]` that is not
  # the test's final command does not fail the test, so a glob assertion written
  # bare would read green while asserting nothing.
  [[ "${output}" == *'no agent files to merge'* ]] || return 1
  [[ "${output}" != *'GLASS_ATRIUM_GLOBAL_RULES'* ]] || return 1
  # untouched: the charter is moved to the OTHER consumer, not handed to a merge
  # that cannot resolve it.
  [ "$(cat "${live}/agents/GLASS_ATRIUM_GLOBAL_RULES.md")" = 'local charter' ]
}

# The scan is the tripwire for a re-added exclusion arm, driven on the two
# spellings a second arm would carve out of both scopes: while the exclusion is
# the merge's complement they are covered, and an arm re-added around either one
# makes this test name it.
@test "the paths a second exclusion arm would orphan are covered by a consumer" {
  local dir="${WORK}/orphan" overlay='rules/glass-atrium/scope-dev.local.md' config='config.toml'
  mkdir -p -- "${dir}"
  printf '{"version":"t","files":["%s","%s"],"hashes":{"%s":"deadbeef","%s":"deadbeef"}}\n' \
    "${overlay}" "${config}" "${overlay}" "${config}" >"${dir}/manifest.json"
  run spine_find_uncovered_paths "${dir}/manifest.json"
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
  run update_report_uncovered_paths "${dir}/manifest.json"
  [ "${status}" -eq 0 ]
  [[ "${output}" != *'deploy coverage gap'* ]] || return 1
}
