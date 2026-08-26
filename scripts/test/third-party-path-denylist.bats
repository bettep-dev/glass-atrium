#!/usr/bin/env bats
# Third-party source-tree denylist — the repo's tracked file set MUST NOT carry an
# upstream diagram-design skill tree or its extractor script. The denylist is a FIXED
# literal glob list in this file (derived from the upstream skill root dir name and its
# script basename); an emptied list is itself a failure, so the check can never pass
# vacuously. Hermetic: the negative control feeds a synthetic path list, the live case
# reads git ls-files of this repo.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"

# Fixed denylist. In bash [[ == ]] pattern matching `*` already crosses `/`, so `**`
# and `*` are equivalent here; the bare basename covers a repo-root placement that
# `**/` cannot match.
DENYLIST=(
  'skills/diagram-design/**'
  '**/mermaid_extract.py'
  'mermaid_extract.py'
)

# stdin = newline-separated repo-relative paths. Prints `<pattern> :: <path>` per hit.
# exit 0 = clean · 1 = violation · 2 = empty denylist (the check itself is broken).
scan_denylist() {
  local path pattern found=0
  ((${#DENYLIST[@]} > 0)) || {
    printf 'denylist is empty — the check would pass vacuously\n' >&2
    return 2
  }
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    for pattern in "${DENYLIST[@]}"; do
      # shellcheck disable=SC2053 # pattern is a glob on purpose
      if [[ "${path}" == ${pattern} ]]; then
        printf '%s :: %s\n' "${pattern}" "${path}"
        found=1
      fi
    done
  done
  return "${found}"
}

@test "denylist carries the two required upstream globs" {
  [[ " ${DENYLIST[*]} " == *" skills/diagram-design/** "* ]] &&
    [[ " ${DENYLIST[*]} " == *" **/mermaid_extract.py "* ]]
}

@test "negative control: a planted upstream skill path is reported" {
  # bats `run` would lose the in-file function through a subshell exec, so the
  # scanner is driven in-process and its status captured directly.
  local out status=0
  out="$(printf '%s\n' 'agents/alpha.md' 'skills/diagram-design/scripts/mermaid_extract.py' | scan_denylist)" || status=$?
  [[ "${status}" -eq 1 ]] && [[ "${out}" == *'skills/diagram-design/**'* ]] && [[ "${out}" == *'mermaid_extract.py'* ]]
}

@test "negative control: an emptied denylist fails the check" {
  local status=0
  DENYLIST=()
  printf '%s\n' 'agents/alpha.md' | scan_denylist 2>/dev/null || status=$?
  [[ "${status}" -eq 2 ]]
}

@test "AC-16: no tracked repo path matches the third-party denylist" {
  local out status=0
  out="$(git -C "${GA}" ls-files | scan_denylist)" || status=$?
  [[ "${status}" -eq 0 ]] || {
    printf 'third-party paths tracked:\n%s\n' "${out}" >&2
    return 1
  }
}
