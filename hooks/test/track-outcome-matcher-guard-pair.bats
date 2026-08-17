#!/usr/bin/env bats
# track-outcome-matcher-guard-pair.bats — characterizes the THREE [COMPLETION] matchers in
#   track-outcome.sh and the guard pair that keeps their ordering non-load-bearing.
#
# WHY THIS EXISTS: the matchers were twice argued to be mutually exclusive, and they are not — the
#   overlap row below matches all three. What actually makes the ordering safe is a PAIR of guards:
#   the zero-tier gate (`if parse_tier == 0:`), which lets a later matcher run only when no earlier
#   one claimed the tier, and the core-field guard (`>=1 of _INLINE_CORE_FIELDS`), which rejects the
#   degenerate body the overlap hands the inline matcher. Each guard alone is insufficient: without
#   the gate the inline matcher would overwrite a complete multi-line parse, and without the guard
#   the inline matcher run first would claim tier 1 on a body carrying no field at all.
#
# HARNESS (why a separate file from track-outcome-schema-mode-completion.bats): that suite drives
#   the hook as a black box and pins the two things it can see from outside — the core-field guard
#   rejecting a PROSE no-field body, and multi-line beating inline. Neither can say WHICH matchers
#   fired. This suite extracts the hook's own parser region and its prerequisite definitions and
#   executes them verbatim, so a row reports the matchers rather than an emit. Extraction reads the
#   hook at its real path → a copied regex could drift; these cannot.
#
# FROZEN OBSERVATION (produced by RUNNING the extracted matchers over these exact fixtures, not
# derived from regex shape). GUARD = what the core-field guard does with the inline match when the
# inline tier is run FIRST — the ordering-independence column; n/a when the inline matcher misses.
#   closed block, clean tag line       ->  T1=hit  T2=hit  INLINE=miss  GUARD=n/a     tier=1
#   closed block, TWO trailing spaces  ->  T1=hit  T2=hit  INLINE=hit   GUARD=reject  tier=1
#   unclosed block (no sentinel)       ->  T1=miss T2=hit  INLINE=miss  GUARD=n/a     tier=2
#   inline single line                 ->  T1=miss T2=miss INLINE=hit   GUARD=pass    tier=1
#
# Row 2 is the overlap. Its inline body is a single SPACE — `[ \t]+` eats the first trailing space
# and `(.+)` takes the second — so the core-field guard rejects it, and the multi-line parse the
# writer actually emitted survives whichever matcher runs first. TWO is the minimum: one trailing
# space leaves `(.+)` nothing to take, which the boundary row below pins from the other side.
#
# bats-1.13 LAST-COMMAND SEMANTICS (load-bearing, mirrors the sibling suites): a test fails ONLY on
#   its final command exit, so every table test ends on one gate over an accumulated failure list.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"

  PROBE_PY="${BATS_TEST_TMPDIR}/matcher_probe.py"
  cat >"${PROBE_PY}" <<'PYX'
"""Report which of track-outcome.sh's three [COMPLETION] matchers claim one fixture.

argv[1] = hook path; the fixture arrives on stdin so no shell quoting reshapes it.
Prints: T1=<hit|miss> T2=<hit|miss> INLINE=<hit|miss> GUARD=<pass|reject|n/a> tier=<n>
"""
import ast
import re
import sys

hook = sys.argv[1]
src = open(hook, encoding="utf-8").read()


def need(pattern, what, flags=re.M):
    m = re.search(pattern, src, flags)
    if m is None:
        sys.exit("extraction lost %s from %s" % (what, hook))
    return m


# Prerequisites of the parser region, taken verbatim as whole lines / whole block.
prereq = "\n".join(
    need(r"^%s = .*$" % name, name).group(0)
    for name in ("KNOWN_FIELDS", "_INLINE_CORE_FIELDS", "_INLINE_DELIM_CLASS")
)
parse_fn = need(
    r"^def parse_completion_body\(text\):\n(?:[ \t].*\n|\n)*", "parse_completion_body"
).group(0)
# The whole 3-tier region: matcher definitions, the multi-line if/else, the zero-tier-gated
# inline tier, the tier-3 fallback.
region = need(
    r"^parse_tier = 0\n(?:.*\n)*?^    parse_tier = 3.*$", "the 3-tier parser region"
).group(0)
# The inline tier alone, so it can be run with the tier unclaimed (order flipped).
inline_block = need(
    r"^if parse_tier == 0:\n    m_inline = re\.search\(.*\n"
    r"(?:[ \t].*\n)*?^            completion = inline_fields$",
    "the inline tier block",
).group(0)
inline_pat = ast.literal_eval(
    need(r"m_inline = re\.search\((r'.*?'), msg, re\.MULTILINE\)", "the inline pattern", 0).group(1)
)

base = {"re": re}
exec(compile(prereq + "\n" + parse_fn, "<hook-defs>", "exec"), base)

msg = sys.stdin.read()

ns = dict(base)
ns["msg"] = msg
exec(compile(region, "<hook-region>", "exec"), ns)

t1_hit = bool(re.search(ns["_T1"], msg, re.DOTALL | re.M))
t2_hit = bool(re.search(ns["_T2"], msg, re.DOTALL | re.M))
inline_hit = bool(re.search(inline_pat, msg, re.M))

guard = "n/a"
if inline_hit:
    gns = dict(base)
    gns["msg"] = msg
    gns["parse_tier"] = 0
    exec(compile(inline_block, "<hook-inline>", "exec"), gns)
    guard = "pass" if gns["parse_tier"] == 1 else "reject"


def hm(flag):
    return "hit" if flag else "miss"


print(
    "T1=%s T2=%s INLINE=%s GUARD=%s tier=%d"
    % (hm(t1_hit), hm(t2_hit), hm(inline_hit), guard, ns["parse_tier"])
)
PYX

  # Two trailing spaces, built rather than typed, so whitespace-trimming tooling cannot silently
  # retire the overlap fixture into a clean tag line that no longer overlaps.
  SP2='  '
  SP1=' '
}

# probe FIXTURE — the observed matcher verdicts for one fixture text.
probe() {
  printf '%s' "${1}" | python3 "${PROBE_PY}" "${HOOK_SH}" 2>&1
}

# check EXPECTED LABEL FIXTURE — non-zero on mismatch, with the observed value named.
check() {
  local expected="${1}" label="${2}" observed
  observed="$(probe "${3}")"
  [[ "${observed}" == "${expected}" ]] || {
    echo "row [${label}]: expected ${expected}, observed ${observed}" >&2
    return 1
  }
}

# A closed multi-line block whose tag line carries $1 (empty, one space, or two).
closed_block() {
  printf '[COMPLETION]%s\nresult: done\ntask_type: diagnosis\nmetric_pass: true\nconfidence: high\nsummary: guard-pair fixture\n[/COMPLETION]' "${1}"
}

@test "matcher-table(extract): the hook's parser region and its three matchers stay extractable" {
  run probe "no completion tag anywhere in this text"
  [[ "${output}" == "T1=miss T2=miss INLINE=miss GUARD=n/a tier=3" ]] || {
    echo "probe harness broken or extraction drifted: ${output}" >&2
    return 1
  }
}

@test "matcher-table(rows): the four fixtures, as observed matcher output" {
  local fails=""
  check "T1=hit T2=hit INLINE=miss GUARD=n/a tier=1" "closed-clean" \
    "$(closed_block '')" || fails="${fails} closed-clean"
  # THE OVERLAP: all three matchers claim it, which is why exclusivity was the wrong account.
  check "T1=hit T2=hit INLINE=hit GUARD=reject tier=1" "closed-two-trailing-space" \
    "$(closed_block "${SP2}")" || fails="${fails} closed-two-trailing-space"
  check "T1=miss T2=hit INLINE=miss GUARD=n/a tier=2" "unclosed" \
    "$(printf '[COMPLETION]\nresult: done\ntask_type: diagnosis\nsummary: truncated mid-emit')" ||
    fails="${fails} unclosed"
  check "T1=miss T2=miss INLINE=hit GUARD=pass tier=1" "inline-single-line" \
    "$(printf '[COMPLETION] result: done | task_type: diagnosis | confidence: high')" ||
    fails="${fails} inline-single-line"
  [[ -z "${fails}" ]] || {
    echo "matcher-table rows failed:${fails}" >&2
    return 1
  }
}

@test "guard-pair(minimality): ONE trailing space does not reach the inline matcher" {
  # The other side of the overlap boundary: `[ \t]+(.+)$` needs a character AFTER the whitespace it
  # eats, so a single trailing space is not an overlap and two is the smallest one. Without this row
  # the overlap fixture reads as an arbitrary spelling rather than the boundary it is.
  check "T1=hit T2=hit INLINE=miss GUARD=n/a tier=1" "closed-one-trailing-space" \
    "$(closed_block "${SP1}")"
}

@test "guard-pair(end-to-end): the overlap parses tier-1 through the hook, writer fields intact" {
  # Matcher-level rows say which matchers fire; this says the writer signal survives the overlap in
  # the real hook. DB-free: PG is fail-opened and the decision is read off the stderr channel,
  # mirroring the [inline] cases in track-outcome-schema-mode-completion.bats.
  command -v jq >/dev/null 2>&1 || skip "jq required"
  local sandbox="${BATS_TEST_TMPDIR}/home" payload="${BATS_TEST_TMPDIR}/payload.json"
  mkdir -p "${sandbox}"
  jq -nc --arg m "$(closed_block "${SP2}")" '{
    hook_event_name: "SubagentStop",
    agent_type: "glass-atrium-qa-debugger",
    agent_id: "gp-overlap",
    session_id: "gp-session",
    last_assistant_message: $m,
    messages: [
      {role: "user", content: "run the work"},
      {role: "assistant", content: [{type: "tool_use", name: "Edit", input: {}}]}
    ]
  }' >"${payload}"

  run env \
    HOME="${sandbox}" \
    PGHOST="/nonexistent-socket-xyzzy" \
    CLAUDE_GATE_INFLIGHT="" \
    SUBAGENT_TOOL_BUDGET_DIR="${BATS_TEST_TMPDIR}/budget" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${payload}"
  [[ "${status}" -eq 0 ]] || {
    echo "hook exited ${status}: ${output}" >&2
    return 1
  }
  local fails=""
  [[ "${output}" == *"parse_tier=1"* ]] || fails="${fails} tier"
  [[ "${output}" == *'"result":"done"'* ]] || fails="${fails} result"
  [[ "${output}" != *"attribution=completion-synthesized"* ]] || fails="${fails} synthesized"
  [[ -z "${fails}" ]] || {
    echo "overlap end-to-end failed:${fails} — output: ${output}" >&2
    return 1
  }
}
