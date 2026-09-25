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
# BATS GATING NOTE: @test bodies run under errexit; a mid-body bare `[[ ]]` / `(( ))` is inert on
# bash 3.2.57 but GATES on CI's bash 5.3.9 — `[ ]` and plain commands gate on BOTH (measured, bats
# 1.13.0 on both legs, so bash is the variable, not bats). Every assertion here `return 1`s on
# mismatch.

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

# --- opening-`files=` anchoring -------------------------------------------------------------
# The bind used to be greedy and unanchored, so the LAST `files=` in the line won. Both shapes
# below replaced the declared list wholesale, which turned the declared path into a FALSE excess.

@test "a later files= inside another field cannot rebind the file list" {
  local lit='[SCOPE] files=hooks/a.sh · deliverable=fix · out=legacy files=none'
  assert_entries "${lit}" 'hooks/a.sh' \
    && assert_declared 'hooks/a.sh' "${lit}" \
    && refute_declared 'hooks/zzz.sh' "${lit}"
}

@test "a mid-word files= match cannot rebind the file list" {
  local lit='[SCOPE] files=hooks/a.sh profiles=data · out=none'
  assert_declared 'hooks/a.sh' "${lit}" \
    && refute_declared 'hooks/zzz.sh' "${lit}"
}

@test "a bare files= at the start of the line still binds" {
  assert_entries 'files=hooks/a.sh · out=none' 'hooks/a.sh'
}

@test "a line with no files= field at all yields no entries" {
  assert_entries '[SCOPE] deliverable=fix · out=none' ''
}

# --- `=`-bearing declared paths -------------------------------------------------------------
# The sibling-field drop is keyed on the grammar's OWN three field names. Dropping every
# `=`-bearing token also dropped a genuine declared path, and an edit to it then read as excess.

@test "a declared path containing = survives alongside its siblings" {
  local lit='[SCOPE] files=docs/a=b.md, hooks/x.sh · deliverable=fix · out=none'
  assert_entries "${lit}" 'docs/a=b.md
hooks/x.sh' \
    && assert_declared 'docs/a=b.md' "${lit}" \
    && assert_declared 'hooks/x.sh' "${lit}" \
    && refute_declared 'hooks/zzz.sh' "${lit}"
}

@test "the grammar's own field names are still dropped in the separator-less form" {
  assert_entries '[SCOPE] files=hooks/a.sh deliverable=bug-fix out=none' 'hooks/a.sh'
}

# The drop vocabulary is matched case-insensitively because the opening bind accepts `[Ff]iles=`.
# A narrower drop set let an uppercase field spelling through as an unknown key, which stopped the
# bare-word drop firing and leaked the swallowed field's prose into the allow-list — the plan-3631
# §7 leak the second refusal exists to close.
@test "an uppercase field spelling leaks no prose into the allow-list" {
  local lit='[SCOPE] files=hooks/a.sh OUT=none legacy'
  refute_declared 'monitor/legacy/x.ts' "${lit}" \
    && assert_declared 'hooks/a.sh' "${lit}"
}

@test "every field name drops in either case" {
  assert_entries '[SCOPE] Files=hooks/a.sh DELIVERABLE=bug-fix Out=none' 'hooks/a.sh'
}

# --- declaration-line selection from record 0 ------------------------------------------------
# A delegation prompt routinely quotes earlier `[SCOPE]`-bearing text (a verdict, a rule excerpt)
# ahead of its own declaration. Selecting that quoted line either read a wrong file list (a FALSE
# excess on the declared path) or read nothing and skipped the comparison (a silently lost signal).

# $1 = record-0 prompt text → prints the entries scope_decl_from_record0 hands the field parser.
record0_entries() {
  # shellcheck disable=SC2154  # BATS_TEST_TMPDIR is set by bats per test.
  local tpath="${BATS_TEST_TMPDIR}/transcript.jsonl" line
  jq -cn --arg t "${1}" '{type:"user", message:{role:"user", content:$t}}' >"${tpath}"
  line="$(scope_decl_from_record0 "${tpath}")"
  scope_decl_files "${line}"
}

@test "record 0 yields the line-opening declaration whatever [SCOPE] text precedes or decorates it" {
  local real='[SCOPE] files=hooks/real.sh · deliverable=fix · out=none'
  local -a names=(
    'quoted verdict first'
    'earlier-round prose declaration first'
    'placeholder rule excerpt first'
    'mention without files= first'
    'block-quoted declaration first'
    'JSON-quoted fix prose first'
    'a later line-opening declaration does not override the first'
    'harness-indented declaration'
    'list-marker bullet declaration'
    'numbered-item declaration'
    'backtick-wrapped declaration'
    'bold-wrapped token'
    'backtick-wrapped mention with an empty files= value first'
    'bulleted backtick-wrapped mention with an empty files= value first'
    'bold-wrapped mention with an empty files= value first'
    'backtick-wrapped path value'
    'bold-wrapped path value'
    'whole-line bold declaration'
    'backtick-wrapped verdict with prose after the wrap first'
    'bulleted backtick-wrapped verdict with prose after the wrap first'
    'numbered bold-wrapped verdict with prose after the wrap first'
    'backtick-wrapped token with prose after its value first'
    'bulleted bold-wrapped token with prose after a path list first'
    'backtick-wrapped token closed by a pipe separator'
    'bold-wrapped token closed by a grammar key'
    'bold-wrapped token with a wrapped value closed by end of line'
  )
  # shellcheck disable=SC2016  # backticks in the rows are literal prompt text, not expansions.
  local -a prompts=(
    "> reviewer: the [SCOPE] files= list omitted hooks/test/x.bats"$'\n'"${real}"
    "Earlier round: [SCOPE] files=hooks/old.sh · out=none"$'\n'"${real}"
    '  `[SCOPE] files=<comma-separated allowed paths/dirs> · deliverable=<type> · out=<excluded|none>`'$'\n'"${real}"
    '[SCOPE] — the 7th delegation element'$'\n'"${real}"
    '> [SCOPE] files=hooks/quoted.sh · out=none'$'\n'"${real}"
    '"fix": "Add hooks/y.sh to [SCOPE] files=. Rewrite the rest"'$'\n'"${real}"
    "${real}"$'\n''[SCOPE] files=hooks/later.sh · out=none'
    "Fix E1."$'\n'"  ${real}"
    "- ${real}"
    "1. ${real}"
    "\`${real}\`"
    '**[SCOPE]** files=hooks/real.sh · deliverable=fix · out=none'
    '`[SCOPE] files=` must list the tests'$'\n'"${real}"
    '- `[SCOPE] files=` completeness duty: declare tests'$'\n'"${real}"
    '**[SCOPE] files=** is required'$'\n'"${real}"
    '[SCOPE] files=`hooks/real.sh` · deliverable=fix · out=none'
    '[SCOPE] files=**hooks/real.sh** · deliverable=fix · out=none'
    '**[SCOPE] files=hooks/real.sh**'
    '`[SCOPE] files=hooks/real.sh` lists one path only'$'\n'"${real}"
    '- `[SCOPE] files=hooks/real.sh` omitted hooks/test/real.bats'$'\n'"${real}"
    '1. **[SCOPE] files=hooks/real.sh** is under-declared'$'\n'"${real}"
    '`[SCOPE]` files=hooks/old.sh lists one path only'$'\n'"${real}"
    '- **[SCOPE]** files=hooks/old.sh, hooks/test/old.bats omitted the manifest'$'\n'"${real}"
    '`[SCOPE]` files=hooks/real.sh | deliverable=fix'
    '**[SCOPE]** files=hooks/real.sh deliverable=fix out=none'
    '**[SCOPE]** files=`hooks/real.sh`'
  )
  local i got
  for i in "${!names[@]}"; do
    got="$(record0_entries "${prompts[${i}]}")"
    [[ "${got}" == 'hooks/real.sh' ]] || {
      echo "${names[${i}]}: expected [hooks/real.sh], got [${got}]" >&2
      return 1
    }
  done
}

@test "a wrapped token keeps every path of a comma-separated list closed by a separator or end of line" {
  local -a names=('middot-closed list' 'end-of-line-closed list')
  # shellcheck disable=SC2016  # backticks in the rows are literal prompt text, not expansions.
  local -a prompts=(
    '`[SCOPE]` files=hooks/a.sh, hooks/test/a.bats · deliverable=fix · out=none'
    '**[SCOPE]** files=`hooks/a.sh`,`hooks/test/a.bats`'
  )
  local i got
  for i in "${!names[@]}"; do
    got="$(record0_entries "${prompts[${i}]}")"
    [[ "${got}" == 'hooks/a.sh'$'\n''hooks/test/a.bats' ]] || {
      echo "${names[${i}]}: expected [hooks/a.sh hooks/test/a.bats], got [${got}]" >&2
      return 1
    }
  done
}

@test "record 0 with [SCOPE] only mid-line yields no declaration (the comparison is skipped)" {
  local got
  got="$(record0_entries 'Implement it. [SCOPE] files=hooks/a.sh · out=none')"
  [[ -z "${got}" ]] || {
    echo "mid-line prose parsed as a declaration: [${got}]" >&2
    return 1
  }
}
