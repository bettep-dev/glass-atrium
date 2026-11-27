#!/usr/bin/env bats
# shellcheck disable=SC2154  # bats injects BATS_TEST_DIRNAME and BATS_TEST_TMPDIR
# shipped-suite reference guard — the install runs the four suite roots in place from the
# manifest's members alone, so a shipped bats file or helper that reads any other tracked path
# passes in a repo checkout and fails in the install.
#
# Every path a shipped .bats/.bash/.sh names through the repository root (`${GA}/…` or
# `${BATS_TEST_DIRNAME}/…`) and git tracks must be a manifest member (a shipped file, or a
# directory holding one) or a REPO_ONLY_PATHS entry. Untracked paths are runtime data or
# sandbox output and are not judged.
#
# Hermetic: reads manifest.json, git's tracked set and the shipped test sources read-only.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"

# Tracked non-members a shipped test names on purpose; each reader skips where the path is absent.
REPO_ONLY_PATHS='install.sh
scripts/publish-release.sh
.github/workflows/ci.yml
autoagent/reviewer-catch-rate'

setup() {
  local top=""
  # GA's own toplevel, never BATS_TEST_DIRNAME's → an install's test roots are their own repos
  top="$(git -C "${GA}" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ "${top}" -ef "${GA}" ]] \
    || skip "not a repo checkout root: ${GA} — membership is judged against git's tracked set"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  jq -r '.files[]' -- "${GA}/manifest.json" >"${BATS_TEST_TMPDIR}/members.txt"
  git -C "${GA}" ls-files >"${BATS_TEST_TMPDIR}/tracked.txt"
}

# file<TAB>path for each root-anchored reference in a shipped bats file or helper whose path git
# tracks but the manifest does not ship and REPO_ONLY_PATHS does not declare.
get_unshipped_references() {
  (cd -- "${GA}" && grep -rHoE --include='*.bats' --include='*.bash' --include='*.sh' \
    '\$\{(GA|BATS_TEST_DIRNAME)\}/[A-Za-z0-9_.@/-]+' test hooks/test scripts/test autoagent/test) \
    >"${BATS_TEST_TMPDIR}/references.txt" || return 1
  # ENVIRON, not -v: BSD awk rejects a newline inside a -v value
  REPO_ONLY_PATHS="${REPO_ONLY_PATHS}" awk '
    function add_with_parents(set, path,    n, parts, i, dir) {
      set[path] = 1
      n = split(path, parts, "/")
      dir = parts[1]
      for (i = 1; i < n; i++) {
        set[dir] = 1
        dir = dir "/" parts[i + 1]
      }
    }
    function normalize(path,    n, parts, depth, stack, i, out) {
      n = split(path, parts, "/")
      depth = 0
      for (i = 1; i <= n; i++) {
        if (parts[i] == "" || parts[i] == ".") continue
        if (parts[i] == "..") { if (depth > 0) depth--; continue }
        stack[++depth] = parts[i]
      }
      out = ""
      for (i = 1; i <= depth; i++) out = (i == 1 ? stack[i] : out "/" stack[i])
      return out
    }
    BEGIN {
      n_allow = split(ENVIRON["REPO_ONLY_PATHS"], allowed, "\n")
      shipped["manifest.json"] = 1 # the release stages it beside the members it lists
    }
    FILENAME == ARGV[1] { shipped_file[$0] = 1; add_with_parents(shipped, $0); next }
    FILENAME == ARGV[2] { add_with_parents(tracked, $0); next }
    {
      colon = index($0, ":")
      file = substr($0, 1, colon - 1)
      reference = substr($0, colon + 1)
      if (!(file in shipped_file)) next
      if (reference ~ /^\$\{GA\}\//) {
        path = normalize(substr(reference, 7))
      } else {
        dir = file
        sub(/\/[^\/]*$/, "", dir)
        path = normalize(dir "/" substr(reference, 22))
      }
      if (path == "" || (path in shipped) || !(path in tracked)) next
      for (i = 1; i <= n_allow; i++) {
        if (path == allowed[i] || index(path, allowed[i] "/") == 1) next
      }
      print file "\t" path
    }
  ' "${BATS_TEST_TMPDIR}/members.txt" "${BATS_TEST_TMPDIR}/tracked.txt" "${BATS_TEST_TMPDIR}/references.txt" \
    >"${BATS_TEST_TMPDIR}/unshipped.txt" || return 1
  LC_ALL=C sort -u "${BATS_TEST_TMPDIR}/unshipped.txt"
}

@test "every tracked path a shipped bats file or helper names from the repo root is shipped or declared repo-only" {
  local offenders
  offenders="$(get_unshipped_references)"
  [[ -s "${BATS_TEST_TMPDIR}/references.txt" ]] || {
    echo "no root-anchored references read"
    return 1
  }
  [[ -z "${offenders}" ]] || {
    printf 'shipped test reads a tracked path the manifest does not ship (move it into a shipped root):\n%s\n' \
      "${offenders}"
    return 1
  }
}

@test "every declared repo-only path is tracked and outside the manifest" {
  local path
  while IFS= read -r path; do
    grep -qE "^${path//./[.]}(/|$)" "${BATS_TEST_TMPDIR}/tracked.txt" || {
      echo "not tracked: ${path}"
      return 1
    }
    ! grep -qE "^${path//./[.]}(/|$)" "${BATS_TEST_TMPDIR}/members.txt" || {
      echo "shipped: ${path}"
      return 1
    }
  done <<<"${REPO_ONLY_PATHS}"
}
