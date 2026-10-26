#!/usr/bin/env bats
# The always-loaded startup set must stay within STARTUP_BUDGET utf-16 units.
# Claude Code loads these files into every session, and the owner's goal is to
# keep that load under 150,000 chars; 145,000 leaves room for text the guard
# cannot see (the user memory index, a user CLAUDE.md).
#
# The set is DERIVED, never listed: agents/GLASS_ATRIUM_GLOBAL_RULES.md by
# name, plus every rules/glass-atrium/*.md that is a regular file and has no
# `paths:` key in its leading `---` block. A symlink is skipped, since the
# rules/ copy of the global rules links back to agents/ and would count twice;
# a `paths:` file loads on demand, not at startup.
#
# Run via: bats scripts/test/startup-budget.bats
# Requires: bats, bash 3.2+, python3.

# shellcheck disable=SC2154  # bats sets BATS_TEST_DIRNAME and BATS_TEST_TMPDIR
bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
STARTUP_BUDGET=145000

COUNT_PY="$(
  cat <<'PY'
import glob, os, sys

root = sys.argv[1]
named = "agents/GLASS_ATRIUM_GLOBAL_RULES.md"


def has_paths_key(path):
    with open(path, encoding="utf-8", newline="") as fh:
        lines = fh.read().split("\n")
    if not lines or lines[0].rstrip("\r") != "---":
        return False
    for line in lines[1:]:
        line = line.rstrip("\r")
        if line == "---":
            return False
        if line.startswith("paths:"):
            return True
    return False


if not os.path.isfile(os.path.join(root, named)):
    sys.stderr.write("startup file absent: %s\n" % named)
    sys.exit(2)
rels = [named]
for path in sorted(glob.glob(os.path.join(root, "rules/glass-atrium/*.md"))):
    if os.path.islink(path) or not os.path.isfile(path) or has_paths_key(path):
        continue
    rels.append(os.path.relpath(path, root))
total = 0
for rel in rels:
    with open(os.path.join(root, rel), encoding="utf-8", newline="") as fh:
        units = len(fh.read().encode("utf-16-le")) // 2
    total += units
    print("%d\t%s" % (units, rel))
print("total\t%d" % total)
PY
)"

# `<count>\t<path>` per startup file under the root $1, then `total\t<n>`.
startup_counts() { python3 -c "${COUNT_PY}" "$1"; }

# Status 1 with the per-file listing when the startup total under $1 is over budget.
check_startup_budget() {
  local counts total
  counts="$(startup_counts "$1")" || return 2
  total="${counts##*$'total\t'}"
  ((total <= STARTUP_BUDGET)) && return 0
  printf '%s\n' "${counts}"
  printf 'startup set is %s utf-16 units, over the %s budget\n' "${total}" "${STARTUP_BUDGET}"
  printf 'the guard counts Atrium files only (not the user memory index or a user CLAUDE.md)\n'
  return 1
}

# Fixture tree under BATS_TEST_TMPDIR holding the two startup locations.
make_tree() {
  local root="${BATS_TEST_TMPDIR}/tree"
  mkdir -p "${root}/agents" "${root}/rules/glass-atrium"
  printf '%s\n' "${root}"
}

@test "the agents/ global rules file is counted by name, outside the rules glob" {
  local root
  root="$(make_tree)"
  printf 'abc' >"${root}/agents/GLASS_ATRIUM_GLOBAL_RULES.md"
  printf 'de' >"${root}/rules/glass-atrium/core-a.md"

  run startup_counts "${root}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *$'3\tagents/GLASS_ATRIUM_GLOBAL_RULES.md'* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${lines[${#lines[@]} - 1]}" == $'total\t5' ]] || {
    echo "${output}"
    return 1
  }
}

@test "a missing agents/ global rules file fails rather than shrinking the set" {
  local root
  root="$(make_tree)"
  printf 'de' >"${root}/rules/glass-atrium/core-a.md"

  run startup_counts "${root}"
  [[ "${status}" -ne 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"agents/GLASS_ATRIUM_GLOBAL_RULES.md"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "a symlinked rules file is skipped, so the global rules count once" {
  local root
  root="$(make_tree)"
  printf 'abc' >"${root}/agents/GLASS_ATRIUM_GLOBAL_RULES.md"
  printf 'de' >"${root}/rules/glass-atrium/core-a.md"
  ln -s ../../agents/GLASS_ATRIUM_GLOBAL_RULES.md "${root}/rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md"

  run startup_counts "${root}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" != *"rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md"* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${lines[${#lines[@]} - 1]}" == $'total\t5' ]] || {
    echo "${output}"
    return 1
  }
}

@test "only a paths: key inside the leading frontmatter block excludes a rules file" {
  local root
  root="$(make_tree)"
  printf 'abc' >"${root}/agents/GLASS_ATRIUM_GLOBAL_RULES.md"
  printf -- '---\npaths:\n  - "**/x"\n---\nbody\n' >"${root}/rules/glass-atrium/scoped-on-demand.md"
  printf -- '---\ndescription: d\n---\nb\n' >"${root}/rules/glass-atrium/fm-no-paths.md"
  printf 'b\n---\npaths:\n---\n' >"${root}/rules/glass-atrium/paths-in-body.md"

  run startup_counts "${root}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" != *"scoped-on-demand.md"* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *$'25\trules/glass-atrium/fm-no-paths.md'* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *$'17\trules/glass-atrium/paths-in-body.md'* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${lines[${#lines[@]} - 1]}" == $'total\t45' ]] || {
    echo "${output}"
    return 1
  }
}

@test "counts are utf-16 code units, not bytes or code points" {
  local root
  root="$(make_tree)"
  # a (1 unit, 1 byte) + em dash (1 unit, 3 bytes) + U+1F600 (2 units, 4 bytes, 1 code point)
  printf 'a\xe2\x80\x94\xf0\x9f\x98\x80' >"${root}/agents/GLASS_ATRIUM_GLOBAL_RULES.md"

  run startup_counts "${root}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${lines[${#lines[@]} - 1]}" == $'total\t4' ]] || {
    echo "${output}"
    return 1
  }
}

@test "the budget passes at the threshold and fails one unit over with per-file counts" {
  local root
  root="$(make_tree)"
  printf '%*s' "${STARTUP_BUDGET}" '' >"${root}/agents/GLASS_ATRIUM_GLOBAL_RULES.md"

  run check_startup_budget "${root}"
  [[ "${status}" -eq 0 ]] || {
    echo "at the threshold: ${output}"
    return 1
  }

  printf 'x' >"${root}/rules/glass-atrium/core-a.md"
  run check_startup_budget "${root}"
  [[ "${status}" -eq 1 ]] || {
    echo "one over: ${output}"
    return 1
  }
  [[ "${output}" == *$'145000\tagents/GLASS_ATRIUM_GLOBAL_RULES.md'* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *$'1\trules/glass-atrium/core-a.md'* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *$'total\t145001'* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"Atrium files only"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "the real tree's startup set is within the budget" {
  run startup_counts "${GA}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  # Non-vacuity: a derivation that found no rules file would pass on agents/ alone.
  [[ "${#lines[@]}" -ge 3 && "${output}" == *$'\trules/glass-atrium/'* ]] || {
    echo "${output}"
    return 1
  }

  run check_startup_budget "${GA}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
}
