#!/usr/bin/env bats
# Recurrence guard for the silently-inert-binding class: a wired matcher
# alternative that names no host tool. The host emits NO warning for a dead plain matcher token,
# so such a token is otherwise invisible; the exact-set-membership rows also pin
# the matcher semantics so the unanchored-substring assumption cannot recur.
#
# S1 SoT — the matcher column of EXPECTED_HOOK_BINDINGS (lib/ga-env.sh), the
# enumeration `wire_hooks` UPSERTS into the user-owned settings.json. That is what
# the host actually dispatches on; settings.template.json is a seed the host never
# reads, so a dead token there is inert in a way a dead token here is not.
#
# Oracle: the spec-maintained literal below, read from the SPEC and the REPO —
# never from the host binary at test time (a host-derived set is an undefined
# oracle). The in-repo artifact is parsed LIVE: hardcoding the wired matchers
# would be a self-agreeing oracle that can never fail.
#
# Matcher SHAPE, not `|` tokens: a matcher alternative may itself be a regex whose
# body contains `|` (the mcp__ tool-family row), so alternatives are split at
# PAREN-DEPTH ZERO only. A naive `tr '|' '\n'` shreds that row into fragments and
# the invariant silently degrades to nonsense.
#
# Run via: bats test/hook-matcher-shape-invariant.bats
# Requires: bats (brew install bats-core), jq, awk, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
GA_ENV="${GA}/lib/ga-env.sh"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

# Tool names established as live-registered on the recorded host among the tokens
# this repo's matchers reference. Deliberately NOT a full host inventory — its
# scope is exactly those tokens. MultiEdit stays out: it has zero registrations on
# the recorded host, so a matcher naming it guards nothing.
RECORDED_HOST_TOOLS=(Agent Bash Edit WebFetch WebSearch Workflow Write)

# Regex-shaped alternatives are admitted only for the MCP tool family, whose member
# names are not knowable at wiring time. The prefix is the whole admission rule.
MCP_MATCHER_PREFIX="mcp__"

setup() {
  [[ -f "${GA_ENV}" ]] || skip "lib/ga-env.sh not found: ${GA_ENV}"
  FIXTURE="$(mktemp -d -t ga-matcher-shape.XXXXXX)"
}

teardown() {
  if ga_guard_path "${FIXTURE:-}"; then rm -rf -- "${FIXTURE:?}"; fi
}

set_contains() {
  local needle="$1" item
  shift
  for item in "$@"; do
    # POSIX test: exact string equality, never a substring or glob match.
    [ "${item}" = "${needle}" ] && return 0
  done
  return 1
}

# matcher column of every EXPECTED_HOOK_BINDINGS row (TAB-separated
# event/basename/matcher), empty matchers dropped. Anchored on the array header and
# its closing paren — function-relative, so an inserted comment does not move it.
binding_matchers() {
  awk '
    /^[[:space:]]*EXPECTED_HOOK_BINDINGS=\(/ { f = 1; next }
    !f                                       { next }
    /^[[:space:]]*\)[[:space:]]*$/           { f = 0; next }
    /^[[:space:]]*#/                         { next }
    {
      row = $0
      sub(/^[[:space:]]*"/, "", row)
      sub(/"[[:space:]]*$/, "", row)
      n = split(row, col, "\t")
      if (n >= 3 && col[3] != "") print col[3]
    }
  ' "$1" | sort -u
}

# alternatives of ONE matcher, split at PAREN-DEPTH ZERO only — a `|` inside a
# regex group belongs to that group and is not an alternative boundary.
matcher_alternatives() {
  awk -v m="$1" '
    BEGIN {
      depth = 0
      cur = ""
      for (i = 1; i <= length(m); i++) {
        c = substr(m, i, 1)
        if (c == "(") depth++
        else if (c == ")") depth--
        else if (c == "|" && depth == 0) { print cur; cur = ""; continue }
        cur = cur c
      }
      print cur
    }
  '
}

# every alternative of every wired matcher, one per line.
all_matcher_alternatives() {
  local matcher
  while read -r matcher; do
    [[ -z "${matcher}" ]] && continue
    matcher_alternatives "${matcher}"
  done < <(binding_matchers "$1")
}

# Prints each offender; non-zero when an alternative is neither an exact member of
# a recorded literal nor a well-formed MCP-family regex matcher.
validate_matcher_alternatives() {
  local file="$1" alt rc=0
  while read -r alt; do
    [[ -z "${alt}" ]] && continue
    if [[ "${alt}" =~ ^[A-Za-z][A-Za-z0-9_]*$ ]]; then
      set_contains "${alt}" "${RECORDED_HOST_TOOLS[@]}" && continue
      echo "unrecorded matcher alternative: ${alt}"
      rc=1
      continue
    fi
    # not a plain token → the only admitted shape is the MCP-family regex.
    if [[ "${alt}" == "${MCP_MATCHER_PREFIX}"* ]]; then
      continue
    fi
    echo "regex-shaped alternative outside the MCP family: ${alt}"
    rc=1
  done < <(all_matcher_alternatives "${file}")
  return "${rc}"
}

# seed one extra binding row into a copy of the SoT, matcher column = $3.
seed_binding_matcher() {
  local src="$1" dest="$2" row
  row="$(printf '  "PreToolUse\tseeded-guard.sh\t%s"' "$3")"
  awk -v row="${row}" '
    { print }
    /^[[:space:]]*EXPECTED_HOOK_BINDINGS=\(/ { print row }
  ' "${src}" >"${dest}"
}

@test "S1 anti-vacuity: wired-matcher extraction covers every recorded tool and keeps regex shapes whole" {
  local extracted tool
  extracted=()
  while read -r tool; do
    extracted+=("${tool}")
  done < <(all_matcher_alternatives "${GA_ENV}" | sort -u)
  for tool in "${RECORDED_HOST_TOOLS[@]}"; do
    set_contains "${tool}" "${extracted[@]:-}" || {
      echo "recorded host tool absent from the wired matchers: ${tool} — extraction is empty or drifted"
      echo "extracted: ${extracted[*]:-<none>}"
      return 1
    }
  done
  # A regex-family alternative whose own body carries a `|` proves the split ran at
  # paren depth zero: a naive token split would have shredded it into fragments.
  printf '%s\n' "${extracted[@]:-}" | grep -q "^${MCP_MATCHER_PREFIX}.*|" || {
    echo "no intact regex-shaped alternative survived extraction — matcher shape was token-split"
    echo "extracted: ${extracted[*]:-<none>}"
    return 1
  }
}

@test "S1: every wired matcher alternative is a recorded token or a well-formed MCP-family regex" {
  run validate_matcher_alternatives "${GA_ENV}"
  if [[ "${status}" -ne 0 ]]; then
    echo "${output}"
    return 1
  fi
}

@test "S2: a matcher alternative in neither literal fails the invariant" {
  local seeded="${FIXTURE}/seeded-new-dead-token.sh"
  seed_binding_matcher "${GA_ENV}" "${seeded}" 'Write|NotebookEdit'
  run validate_matcher_alternatives "${seeded}"
  if [[ "${status}" -eq 0 ]]; then
    echo "seeded NotebookEdit alternative was accepted — the row has lost its discriminating power"
    return 1
  fi
  echo "${output}" | grep -q 'NotebookEdit' || {
    echo "offender not named in the failure output: ${output}"
    return 1
  }
}

@test "S2: substring-shaped and non-MCP regex alternatives fail the invariant" {
  # Edi / EditFile catch a substring-matching membership test in either direction;
  # Web.* catches a regex shape admitted outside the declared MCP family.
  local seeded tok
  for tok in Edi EditFile 'Web.*'; do
    seeded="${FIXTURE}/seeded-shape.sh"
    seed_binding_matcher "${GA_ENV}" "${seeded}" "${tok}"
    run validate_matcher_alternatives "${seeded}"
    if [[ "${status}" -eq 0 ]]; then
      echo "alternative ${tok} was accepted — membership is not exact, or the regex family is unbounded"
      return 1
    fi
  done
}
