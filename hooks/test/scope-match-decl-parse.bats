#!/usr/bin/env bats
# scope-match-decl-parse.bats — unit pins for `scope_decl_files`, the `[SCOPE] files=` field parser
# shared by the drift advisory (PreToolUse) and the recorder's scope-excess leg (SubagentStop).
#
# What this suite exists to prevent: a mis-SPLIT field is not a cosmetic parse bug. The separator-less
# form parsed as ONE entry whose basename was `out=none`, so the correctly-declared path failed to
# match and the caller fired a FALSE excess — an advisory accusing compliant work, which is strictly
# worse than emitting no signal at all. The rows below pin both directions: a declared path matches in
# EITHER separator form, and an undeclared path still misses in either (the tolerance defangs nothing) —
# including when a separator-less field carries prose in a sibling out=, the shape that made the
# second half of that claim false.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail —
# every assertion here `return 1`s on mismatch.

LIB_SH="${BATS_TEST_DIRNAME}/../lib/scope-match.sh"

setup() {
  [[ -f "${LIB_SH}" ]] || skip "scope-match.sh not found: ${LIB_SH}"
  # shellcheck source=../lib/scope-match.sh
  source "${LIB_SH}"
}

# $1=[SCOPE] line, $2=expected newline-joined entry list ('' = no entries at all).
assert_entries() {
  local got
  got="$(scope_decl_files "${1}")"
  [[ "${got}" == "${2}" ]] || {
    echo "line: ${1}" >&2
    echo "expected entries [${2}], got [${got}]" >&2
    return 1
  }
}

# $1=candidate path, $2=[SCOPE] line — the path is inside the declaration (no excess).
assert_declared() {
  match_file_against_allowed "${1}" "$(scope_decl_files "${2}")" || {
    echo "expected [${1}] to match declaration [${2}]" >&2
    return 1
  }
}

# $1=candidate path, $2=[SCOPE] line — the path is outside the declaration (excess stays detectable).
refute_declared() {
  ! match_file_against_allowed "${1}" "$(scope_decl_files "${2}")" || {
    echo "expected [${1}] NOT to match declaration [${2}]" >&2
    return 1
  }
}

@test "canonical ' · ' form parses to the declared paths" {
  assert_entries '[SCOPE] files=hooks/a.sh, hooks/b.sh · deliverable=bug-fix · out=none' \
    'hooks/a.sh
hooks/b.sh'
}

@test "separator-less form parses identically (the false-excess regression)" {
  assert_entries '[SCOPE] files=hooks/a.sh hooks/b.sh deliverable=bug-fix out=none' \
    'hooks/a.sh
hooks/b.sh'
}

@test "mixed comma list with a missing final separator keeps every declared path" {
  assert_entries '[SCOPE] files=hooks/a.sh, hooks/b.sh deliverable=fix out=none' \
    'hooks/a.sh
hooks/b.sh'
}

@test "a declared path matches in BOTH separator forms" {
  assert_declared 'hooks/X.sh' '[SCOPE] files=hooks/X.sh · deliverable=bug-fix · out=none' \
    && assert_declared 'hooks/X.sh' '[SCOPE] files=hooks/X.sh deliverable=bug-fix out=none'
}

@test "an undeclared path still misses in BOTH forms (tolerance defangs nothing)" {
  refute_declared 'hooks/undeclared.sh' '[SCOPE] files=hooks/a.sh · deliverable=fix · out=none' \
    && refute_declared 'hooks/undeclared.sh' '[SCOPE] files=hooks/a.sh deliverable=fix out=none'
}

# Plan 3631 §7 step 1's literal — the row above pinned that generalization while exercising only
# `out=none`, and it was false here. TWO conditions are needed together: files= unterminated by a
# middot AND a prose out=. The bare word `helper` used to survive the `=`-token drop into the
# allow-list, where the lenient matcher swallowed hooks/lib/helper.sh and the excess went silent.
@test "prose in a separator-less out= leaks no bare word into the allow-list" {
  local lit='[SCOPE] files=hooks/X.sh,hooks/test/X.bats deliverable=bug-fix out=인접 helper, 신규 테스트 3종'
  assert_entries "${lit}" 'hooks/X.sh
hooks/test/X.bats' \
    && refute_declared 'hooks/lib/helper.sh' "${lit}" \
    && assert_declared 'hooks/X.sh' "${lit}"
}

# The bare-word drop is GATED on a preceding `=` token precisely so an extensionless path — no `/`
# and no `.` — survives inside the files= list itself. Ungating it would make Makefile a FALSE
# excess, the one outcome this parser must never produce.
@test "an extensionless declared path survives the bare-word drop" {
  assert_entries '[SCOPE] files=Makefile, scripts/build.sh deliverable=fix out=none' 'Makefile
scripts/build.sh' \
    && assert_declared 'Makefile' '[SCOPE] files=Makefile, scripts/build.sh deliverable=fix out=none'
}

@test "a literally-copied <placeholder> template yields NO entries (callers skip, never accuse)" {
  assert_entries '[SCOPE] files=<comma-separated allowed paths> · deliverable=<type> · out=none' ''
}

@test "a pipe inside a later field cannot truncate the file list" {
  assert_entries '[SCOPE] files=hooks/a.sh deliverable=fix out=<exclusions|none>' 'hooks/a.sh'
}

@test "backtick-wrapped paths and a pipe-terminated field keep their existing shapes" {
  assert_entries '[SCOPE] files=`hooks/a.sh` | deliverable=fix' 'hooks/a.sh'
}
