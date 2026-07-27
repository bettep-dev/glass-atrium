#!/usr/bin/env bats
# Recurrence guard for the two silently-inert-binding classes: a settings matcher
# token that names no host tool, and a hook dispatch arm that guards a tool the
# host never emits. The host emits NO warning for a dead plain matcher token, so
# such a token is otherwise invisible; the exact-set-membership rows also pin the
# matcher semantics so the unanchored-substring assumption cannot recur.
#
# Oracle: two spec-maintained literals below, read from the SPEC and the REPO —
# never from the host binary at test time (a host-derived set is an undefined
# oracle). Both in-repo artifacts (settings.template.json, the hook's TOOL_NAME
# dispatch case) are parsed LIVE: hardcoding the dispatched names would be a
# self-agreeing oracle that can never fail.
#
# Run via: bats test/hook-matcher-shape-invariant.bats
# Requires: bats (brew install bats-core), jq, awk, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
TEMPLATE="${GA}/settings.template.json"
HOOK="${GA}/hooks/enforce-harness-critical.sh"

# Tool names established as live-registered on the recorded host among the tokens
# this repo's matchers and dispatch reference. Deliberately NOT a full host
# inventory — its scope is exactly those tokens.
RECORDED_HOST_TOOLS=(Bash Edit Write)

# LEGACY_FORWARD_COMPAT_ALLOWLIST justification: MultiEdit guards NOTHING on the
#   recorded host (zero registrations, strict Edit schema, absent from the
#   file-pattern tool list); it is kept as forward-compatibility insurance and its
#   urgency as a security action is NIL.
# LEGACY_FORWARD_COMPAT_ALLOWLIST rewire-pointer: the live matcher rewire that
#   would drop the token is DEFERRED and OPTIONAL, gated behind the stale-matcher
#   reconcile landing, and is forward-compat housekeeping rather than a security
#   action.
# One token, no wildcard: keeping it OUT of RECORDED_HOST_TOOLS is what preserves
# the row's power to fail on a genuinely NEW dead token. The same literal serves
# the dispatch rows as the declared defensive-only name.
LEGACY_FORWARD_COMPAT_ALLOWLIST=(MultiEdit)

# Census at the recorded HEAD — anti-vacuity anchors for both live extractions.
EXPECTED_MATCHER_GROUPS=5
EXPECTED_MATCHER_TOKENS=4
EXPECTED_DISPATCH_TOOLS=4

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${TEMPLATE}" ]] || skip "settings.template.json not found: ${TEMPLATE}"
  [[ -f "${HOOK}" ]] || skip "hook not found: ${HOOK}"
  FIXTURE="$(mktemp -d -t ga-matcher-shape.XXXXXX)"
}

teardown() {
  [[ -n "${FIXTURE:-}" && -d "${FIXTURE}" ]] && rm -rf -- "${FIXTURE}"
  return 0
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

matcher_groups() {
  jq -r '.hooks[]? | .[]? | .matcher // empty' "$1"
}

# every alternative of every plain-token matcher, one per line (separator: |).
matcher_tokens() {
  matcher_groups "$1" | tr '|' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$'
}

# exact-membership check over RECORDED_HOST_TOOLS + the one-token legacy escape.
# Prints each offender; non-zero when a token is a member of neither literal.
validate_matcher_tokens() {
  local file="$1" tok rc=0
  while read -r tok; do
    set_contains "${tok}" "${RECORDED_HOST_TOOLS[@]}" && continue
    set_contains "${tok}" "${LEGACY_FORWARD_COMPAT_ALLOWLIST[@]}" && continue
    echo "unrecorded matcher alternative: ${tok}"
    rc=1
  done < <(matcher_tokens "${file}")
  return "${rc}"
}

# tool names the hook's TOOL_NAME dispatch branches on, extracted from the LIVE
# artifact. Anchored on the case header naming the variable (function-relative, so
# an inserted comment or shopt line does not move it) and comment lines are
# skipped, because the hook is edited in parallel with this guard.
dispatch_tool_names() {
  awk '
    /^[[:space:]]*case[[:space:]].*TOOL_NAME.*[[:space:]]in[[:space:]]*$/ { f = 1; next }
    !f                                                                   { next }
    /^[[:space:]]*esac/                                                  { f = 0; next }
    /^[[:space:]]*#/                                                     { next }
    /\)/ {
      arm = $0
      sub(/\).*/, "", arm)
      gsub(/[ \t"]/, "", arm)
      gsub(/\047/, "", arm)
      n = split(arm, part, "|")
      for (i = 1; i <= n; i++)
        if (part[i] != "" && part[i] != "*") print part[i]
    }
  ' "$1" | sort -u
}

validate_dispatch_tools() {
  local file="$1" name rc=0
  while read -r name; do
    set_contains "${name}" "${RECORDED_HOST_TOOLS[@]}" && continue
    set_contains "${name}" "${LEGACY_FORWARD_COMPAT_ALLOWLIST[@]}" && continue
    echo "dispatched tool name is recorded nowhere: ${name}"
    rc=1
  done < <(dispatch_tool_names "${file}")
  return "${rc}"
}

@test "S1 census: template matcher extraction is non-empty and matches the recorded census" {
  local groups distinct
  groups="$(matcher_groups "${TEMPLATE}" | wc -l | tr -d ' ')"
  distinct="$(matcher_tokens "${TEMPLATE}" | sort -u | wc -l | tr -d ' ')"
  if [[ "${groups}" != "${EXPECTED_MATCHER_GROUPS}" ]]; then
    echo "matcher groups=${groups}, expected ${EXPECTED_MATCHER_GROUPS} — census drift or empty extraction"
    return 1
  fi
  if [[ "${distinct}" != "${EXPECTED_MATCHER_TOKENS}" ]]; then
    echo "distinct matcher alternatives=${distinct}, expected ${EXPECTED_MATCHER_TOKENS}"
    return 1
  fi
}

@test "S1: every template matcher alternative is an exact member of a recorded literal" {
  run validate_matcher_tokens "${TEMPLATE}"
  if [[ "${status}" -ne 0 ]]; then
    echo "${output}"
    return 1
  fi
}

@test "S1 escape hygiene: the legacy allowlist is one token carrying justification and rewire pointer" {
  if [[ "${#LEGACY_FORWARD_COMPAT_ALLOWLIST[@]}" -ne 1 ]]; then
    echo "legacy allowlist size=${#LEGACY_FORWARD_COMPAT_ALLOWLIST[@]}, expected exactly 1 (no wildcard, no widening)"
    return 1
  fi
  if [[ "${LEGACY_FORWARD_COMPAT_ALLOWLIST[0]}" != "MultiEdit" ]]; then
    echo "legacy allowlist member=${LEGACY_FORWARD_COMPAT_ALLOWLIST[0]}, expected MultiEdit"
    return 1
  fi
  grep -q 'LEGACY_FORWARD_COMPAT_ALLOWLIST justification:' "${BATS_TEST_FILENAME}" || {
    echo "legacy escape carries no justification"
    return 1
  }
  grep -q 'LEGACY_FORWARD_COMPAT_ALLOWLIST rewire-pointer:' "${BATS_TEST_FILENAME}" || {
    echo "legacy escape carries no rewire pointer"
    return 1
  }
}

@test "S2: a matcher alternative in neither literal fails the invariant" {
  local seeded="${FIXTURE}/seeded-new-dead-token.json"
  jq '.hooks.PreToolUse[0].matcher = "Write|Edit|NotebookEdit"' "${TEMPLATE}" >"${seeded}"
  run validate_matcher_tokens "${seeded}"
  if [[ "${status}" -eq 0 ]]; then
    echo "seeded NotebookEdit alternative was accepted — the row has lost its discriminating power"
    return 1
  fi
  echo "${output}" | grep -q 'NotebookEdit' || {
    echo "offender not named in the failure output: ${output}"
    return 1
  }
}

@test "S2: substring-shaped alternatives fail the invariant (exact membership, not substring)" {
  local seeded tok
  for tok in Edi EditFile; do
    seeded="${FIXTURE}/seeded-substring-${tok}.json"
    jq --arg m "${tok}" '.hooks.PreToolUse[0].matcher = $m' "${TEMPLATE}" >"${seeded}"
    run validate_matcher_tokens "${seeded}"
    if [[ "${status}" -eq 0 ]]; then
      echo "substring-shaped alternative ${tok} was accepted — matcher semantics are not exact set membership"
      return 1
    fi
  done
}

@test "S3 anti-vacuity: live dispatch extraction is non-empty and of the expected cardinality" {
  local count
  count="$(dispatch_tool_names "${HOOK}" | wc -l | tr -d ' ')"
  if [[ "${count}" != "${EXPECTED_DISPATCH_TOOLS}" ]]; then
    echo "extracted dispatch tool names=${count}, expected ${EXPECTED_DISPATCH_TOOLS}"
    echo "extracted: $(dispatch_tool_names "${HOOK}" | tr '\n' ' ')"
    return 1
  fi
}

@test "S3: every dispatched tool name is recorded or the declared defensive-only name" {
  run validate_dispatch_tools "${HOOK}"
  if [[ "${status}" -ne 0 ]]; then
    echo "${output}"
    return 1
  fi
}

@test "S3 polarity: an unrecorded dispatch arm token fails the invariant" {
  local seeded="${FIXTURE}/seeded-dispatch.sh"
  awk '
    { print }
    /^[[:space:]]*Bash\)/ { print "  NotebookEdit) bash_arm ;;" }
  ' "${HOOK}" >"${seeded}"
  dispatch_tool_names "${seeded}" | grep -q 'NotebookEdit' || {
    echo "seed did not land in the dispatch block — extractor anchor drifted"
    return 1
  }
  run validate_dispatch_tools "${seeded}"
  if [[ "${status}" -eq 0 ]]; then
    echo "seeded dispatch arm was accepted — the oracle is not reading the live artifact"
    return 1
  fi
}

@test "S3 tolerance: extraction survives comment and shopt lines inserted in the dispatch block" {
  local seeded="${FIXTURE}/tolerant-dispatch.sh"
  awk '
    /^[[:space:]]*case[[:space:]].*TOOL_NAME.*[[:space:]]in[[:space:]]*$/ {
      print "  # soundness note: two enumerations, one dispatch"
      print "  shopt -s nocasematch"
      print
      print "  # arm order is immaterial (exact tokens)"
      next
    }
    { print }
  ' "${HOOK}" >"${seeded}"
  local before after
  before="$(dispatch_tool_names "${HOOK}" | tr '\n' ' ')"
  after="$(dispatch_tool_names "${seeded}" | tr '\n' ' ')"
  if [[ "${before}" != "${after}" ]]; then
    echo "extraction drifted on inserted lines: before='${before}' after='${after}'"
    return 1
  fi
}
