#!/usr/bin/env bats
# Pins the frontmatter identity — `name`, `tools`, `scope` — of the two intel
# agent files: what those keys say at the cycle base must be what they say at
# HEAD, so an edit to either body cannot carry a renamed agent or a widened
# tool grant along with it. enforce-harness-critical.sh guards the LIVE install
# paths only, so this suite is the only judge for the repository tree.
#
# `tools` folds to a SORTED item set, so the inline-flow and block-list
# spellings of one grant read alike; an absent key emits no line, so
# absent-vs-absent compares equal and ADDING a key is drift.
#
# Skip predicate (base resolution, best-effort by design): a row runs only
# where a merge-base with HEAD resolves AND the base blobs are present. Outside
# a git work tree — the live install's run-bats-parallel.sh executes every
# on-disk .bats — and on a shallow clone, which keeps the ref without the
# object, every row SKIPS rather than fails. CI checks this leg out at
# fetch-depth 0 so the rows actually run there.
#
# Run via: bats scripts/test/agent-frontmatter-identity.bats
# Requires: bats, bash 3.2+, git, awk.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
GUARDED_FILES=(agents/glass-atrium-intel-reporter.md agents/glass-atrium-intel-planner.md)

# Canonical identity lines for one agent file: `name=…`, `scope=…`, a bare
# `tools=` presence marker (a `tools:` granting nothing differs from an absent
# key) and one `tools+<item>` line per grant. Output is buffered to the closing
# fence, so a file with no frontmatter block yields nothing at all. A `tools:`
# value that is neither empty nor a closed inline flow is emitted raw as
# `tools?<value>` — left unparsed rather than silently folded to equal.
IDENTITY_AWK="$(
  cat <<'AWK'
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }

function emit(s) { out[++n] = s }

# One scalar or one list item: trimmed, a trailing " #" comment that opens
# outside a quoted span dropped, one balanced surrounding quote pair removed.
function canon(s,   i, ch, q, len, edge) {
  s = trim(s)
  q = ""
  for (i = 1; i <= length(s); i++) {
    ch = substr(s, i, 1)
    if (q != "") { if (ch == q) q = "" }
    else if (ch == "\"" || ch == "'") q = ch
    else if (ch == "#" && i > 1) {
      edge = substr(s, i - 1, 1)
      if (edge == " " || edge == "\t") { s = substr(s, 1, i - 1); break }
    }
  }
  s = trim(s)
  len = length(s)
  edge = substr(s, 1, 1)
  if (len >= 2 && edge == substr(s, len, 1) && (edge == "\"" || edge == "'")) s = substr(s, 2, len - 2)
  return s
}

# Inline-flow body → one item per comma that sits outside a quoted span.
function emit_flow(s,   i, ch, q, buf, item) {
  s = substr(s, 2, length(s) - 2)
  q = ""
  buf = ""
  for (i = 1; i <= length(s); i++) {
    ch = substr(s, i, 1)
    if (q != "") { buf = buf ch; if (ch == q) q = "" }
    else if (ch == "\"" || ch == "'") { q = ch; buf = buf ch }
    else if (ch == ",") { item = canon(buf); if (item != "") emit("tools+" item); buf = "" }
    else buf = buf ch
  }
  item = canon(buf)
  if (item != "") emit("tools+" item)
}

NR == 1 { if (trim($0) != "---") exit; fm = 1; next }
fm && trim($0) == "---" { for (i = 1; i <= n; i++) print out[i]; exit }
!fm { next }

# Blank lines and full-line comments preserve an open block list — a live agent
# file puts a comment between two grants.
trim($0) == "" || $0 ~ /^[ \t]*#/ { next }

$0 !~ /^[ \t]/ && match($0, /:/) {
  key = canon(substr($0, 1, RSTART - 1))
  rest = canon(substr($0, RSTART + 1))
  intools = 0
  if (key == "name" || key == "scope") emit(key "=" rest)
  else if (key == "tools") {
    emit("tools=")
    if (rest == "") intools = 1
    else if (substr(rest, 1, 1) == "[" && substr(rest, length(rest), 1) == "]") emit_flow(rest)
    else emit("tools?" rest)
  }
  next
}

intools && match($0, /^[ \t]*-[ \t]+/) { emit("tools+" canon(substr($0, RLENGTH + 1))); next }

# Any other column-0 line closes the block list.
$0 !~ /^[ \t]/ { intools = 0 }
AWK
)"

# Sorted canonical identity of one agent file on disk.
identity_of_file() {
  awk "${IDENTITY_AWK}" "$1" | LC_ALL=C sort
}

# Same, for the blob a revision carries at that path.
identity_of_rev() {
  git -C "${GA}" show "$1:$2" | awk "${IDENTITY_AWK}" | LC_ALL=C sort
}

# First base candidate whose merge-base with HEAD exists AND whose blobs for the
# guarded paths are present: a depth-1 checkout carries the ref without the
# object, and an unreadable base is a skip rather than a failure.
resolve_base() {
  local root="$1" ref base f
  git -C "${root}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  for ref in main origin/main HEAD^1; do
    base="$(git -C "${root}" merge-base "${ref}" HEAD 2>/dev/null)" || continue
    [[ -n "${base}" ]] || continue
    for f in "${GUARDED_FILES[@]}"; do
      git -C "${root}" cat-file -e "${base}:${f}" 2>/dev/null || continue 2
    done
    printf '%s\n' "${base}"
    return 0
  done
  return 1
}

# One extra grant on the `tools:` line, in whichever notation the file uses.
widen_tools() {
  awk '
    !widened && /^tools:/ {
      if ($0 ~ /\][ \t]*$/) { sub(/\][ \t]*$/, ", BatsFixtureGrant]"); print; widened = 1; next }
      print
      print "  - BatsFixtureGrant"
      widened = 1
      next
    }
    { print }
  ' "$1"
}

setup() {
  command -v git >/dev/null 2>&1 || skip "git required"
  BASE="$(resolve_base "${GA}")" || skip "no readable cycle base at ${GA} — outside a git work tree, or the base blob is unfetched"
}

@test "the intel agent files carry the same frontmatter identity at base and at HEAD" {
  local f base_id head_id
  for f in "${GUARDED_FILES[@]}"; do
    [[ -f "${GA}/${f}" ]] || { echo "missing at HEAD: ${f}"; return 1; }
    base_id="$(identity_of_rev "${BASE}" "${f}")"
    head_id="$(identity_of_file "${GA}/${f}")"
    # Non-vacuity: an empty parse would compare equal to another empty parse.
    [[ "${head_id}" == *"name="* && "${head_id}" == *"tools="* ]] || {
      echo "unparseable frontmatter at HEAD: ${f}"
      return 1
    }
    [[ "${base_id}" == "${head_id}" ]] || {
      echo "frontmatter identity drift in ${f} (base ${BASE}):"
      diff <(printf '%s\n' "${base_id}") <(printf '%s\n' "${head_id}")
      return 1
    }
  done
}

@test "the judge catches a tools grant widened on the HEAD side" {
  local f="${GUARDED_FILES[0]}"
  local orig="${BATS_TEST_TMPDIR}/base.md"
  local widened="${BATS_TEST_TMPDIR}/widened.md"
  git -C "${GA}" show "${BASE}:${f}" >"${orig}"
  widen_tools "${orig}" >"${widened}"
  # The fixture must genuinely differ, or the row demonstrates nothing.
  ! cmp -s "${orig}" "${widened}"
  [[ "$(identity_of_file "${orig}")" != "$(identity_of_file "${widened}")" ]]
}

@test "the judge is notation-blind: block-list and inline-flow spellings of one grant read alike" {
  local flow="${BATS_TEST_TMPDIR}/flow.md"
  local block="${BATS_TEST_TMPDIR}/block.md"
  cat >"${flow}" <<'MD'
---
name: twin
tools: [Read, Glob, Bash]
maxTurns: 80
---
# Body

- an ordinary prose bullet
MD
  cat >"${block}" <<'MD'
---
name: twin
tools:
  - Read
  # a comment between two grants
  - Glob
  - Bash   # a trailing comment
maxTurns: 80
---
# Body

- a different prose bullet
MD
  [[ "$(identity_of_file "${flow}")" == "$(identity_of_file "${block}")" ]]
}

@test "an absent scope key reads as equal, and adding one reads as drift" {
  local bare="${BATS_TEST_TMPDIR}/bare.md"
  local other_body="${BATS_TEST_TMPDIR}/other-body.md"
  local scoped="${BATS_TEST_TMPDIR}/scoped.md"
  cat >"${bare}" <<'MD'
---
name: twin
tools: [Read, Glob]
---
# Body
MD
  cat >"${other_body}" <<'MD'
---
name: twin
tools: [Read, Glob]
---
# A wholly different body

scope: PLANNING
MD
  cat >"${scoped}" <<'MD'
---
name: twin
scope: PLANNING
tools: [Read, Glob]
---
# Body
MD
  [[ "$(identity_of_file "${bare}")" == "$(identity_of_file "${other_body}")" ]]
  [[ "$(identity_of_file "${bare}")" != "$(identity_of_file "${scoped}")" ]]
}

@test "a copy outside any git work tree skips instead of failing" {
  local bats_bin outside copy
  bats_bin="$(command -v bats)" || skip "bats not on PATH"
  outside="${BATS_TEST_TMPDIR}/live-install/scripts/test"
  mkdir -p "${outside}"
  copy="${outside}/$(basename "${BATS_TEST_FILENAME}")"
  cp "${BATS_TEST_FILENAME}" "${copy}"
  run "${bats_bin}" "${copy}"
  [[ "${status}" -eq 0 ]] || {
    printf '%s\n' "${output}"
    return 1
  }
  [[ "${output}" == *"# skip"* ]] || {
    printf '%s\n' "${output}"
    return 1
  }
}
