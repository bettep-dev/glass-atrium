#!/usr/bin/env bats
# inject-scope-rules.bats — Bats suite for the SubagentStart inject-scope-rules.sh runtime path.
#   This covers the HOOK's runtime injection (test_inject_sync.py covers only the reconcile tooling
#   that maintains the 3 auto-synced arrays — it does NOT exercise the hook). Focus = the 4th
#   injected block (AGENT-INJECT:NAMING) wired in for DEV(12, excluding dev-swift) + qa-code-reviewer.
#
# Input is the real SubagentStart envelope parsed by the hook: {"agent_type":"<type>"} (read via
#   hook_get_field). Built with jq so the field is escaped safely.
# Env sandbox: AGENTS_DIR → /nonexistent (no maxTurns lookup) and SUBAGENT_BUDGET_METER_OFF=1 so the
#   universal budget-meter block is suppressed — this isolates the scope-block assertions (the meter
#   is agent-agnostic and would otherwise add noise to every run). The 3 OTHER scope sources
#   (comment-logging / style_ref / minimalism) are pointed at /nonexistent by DEFAULT so a "naming
#   present" assertion proves the naming block specifically, not an accidental match in a sibling
#   block. The naming source defaults to a HERMETIC in-sandbox fixture built in setup() (NOT the
#   HOME-anchored real SKILL.md, which is absent under a CI checkout) unless a test overrides it.
#
# BATS GATING NOTE: this bats version runs @test bodies WITHOUT `set -e`, so only the LAST command
#   gates pass/fail — a non-final failing `[[ ]]` is silently ignored. Every assertion below is
#   guarded with a helper that `return 1`s on mismatch, so EACH one independently fails the test.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/inject-scope-rules.sh"

# The marker string the naming block is uniquely identified by (its first line in the SKILL.md core).
NAMING_NEEDLE="Naming delta-core"

# The NAMING block markers the hermetic fixture must carry (mirror hooks/inject-scope-rules.sh anchors).
NAMING_MARKER_START='<!-- AGENT-INJECT:NAMING:START -->'
NAMING_MARKER_END='<!-- AGENT-INJECT:NAMING:END -->'

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "inject-scope-rules.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"

  # Hermetic NAMING source fixture — the hook's default naming source is the HOME-anchored real
  # SKILL.md (${HOME}/.claude/skills/...), absent in a CI checkout → the naming block would be
  # empty and the positive-injection assertions would falsely fail. Build a self-contained fixture
  # carrying the NAMING markers + the NAMING_NEEDLE first line, and point run_hook at it by DEFAULT.
  # Tests that deliberately pass their own naming_src (fail-open cases) still override this.
  NAMING_FIXTURE="${BATS_TEST_TMPDIR}/naming-skill.md"
  printf '%s\n' \
    'skill preamble (must not reach the child)' \
    "${NAMING_MARKER_START}" \
    "**${NAMING_NEEDLE} (auto-injected for DEV + qa-code-reviewer)**" \
    'NAMING-CORE-BODY' \
    "${NAMING_MARKER_END}" \
    'skill trailer (must not reach the child)' >"${NAMING_FIXTURE}"
}

# Drive the hook with a SubagentStart envelope wrapping $1 (agent_type). The 3 non-naming scope
# sources + AGENTS_DIR are sandboxed to /nonexistent and the meter is off, isolating the naming
# block. The naming source defaults to the hermetic fixture built in setup() (so the positive
# assertions do not depend on the HOME-anchored real SKILL.md, absent in CI); $2 (optional)
# overrides INJECT_SCOPE_RULES_NAMING_SRC for the fail-open / absent-marker tests.
run_hook() {
  local agent="${1}" naming_src="${2:-${NAMING_FIXTURE}}"
  run bash -c '
    agent="$1"; hook="$2"; naming_src="$3"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    env_naming=()
    if [[ -n "${naming_src}" ]]; then
      env_naming=(INJECT_SCOPE_RULES_NAMING_SRC="${naming_src}")
    fi
    printf "%s" "${payload}" | env \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_SRC=/nonexistent \
      INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
      "${env_naming[@]}" \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${naming_src}"
}

# Extract the additionalContext string from the hook's JSON stdout (empty if no JSON emitted).
# Operates on $output (bats merges stdout+stderr, but the only JSON line is the hook's stdout).
ctx_of() {
  printf '%s' "${output}" | python3 -c '
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        d = json.loads(line)
    except ValueError:
        continue
    print(d.get("hookSpecificOutput", {}).get("additionalContext", ""))
    break
' 2>/dev/null
}

# --- Per-assertion gate helpers (the bats body is NOT under set -e — see header note). ---
assert_status() {
  [[ "${status}" -eq "${1}" ]] || {
    echo "expected status ${1}, got ${status} (output: ${output})" >&2
    return 1
  }
}
assert_ctx_contains() {
  local ctx; ctx="$(ctx_of)"
  [[ "${ctx}" == *"${1}"* ]] || {
    echo "expected additionalContext to contain [${1}], got: [${ctx}]" >&2
    return 1
  }
}
assert_ctx_not_contains() {
  local ctx; ctx="$(ctx_of)"
  [[ "${ctx}" != *"${1}"* ]] || {
    echo "expected additionalContext to NOT contain [${1}], got: [${ctx}]" >&2
    return 1
  }
}
assert_no_json_emitted() {
  printf '%s' "${output}" | grep -q '"hookSpecificOutput"' && {
    echo "expected NO injection JSON, got: ${output}" >&2
    return 1
  }
  return 0
}

# --- (a) a NAMING_AGENTS DEV member (dev-react) receives the naming block ---

@test "dev-react (NAMING_AGENTS member) → naming block injected, exit 0" {
  run_hook "glass-atrium-dev-react"
  assert_status 0
  assert_ctx_contains "${NAMING_NEEDLE}"
}

@test "dev-shell (NAMING_AGENTS member) → naming block injected, exit 0" {
  run_hook "glass-atrium-dev-shell"
  assert_status 0
  assert_ctx_contains "${NAMING_NEEDLE}"
}

# --- (b) qa-code-reviewer (the QA enforcement surface) receives the naming block ---

@test "qa-code-reviewer (NAMING_AGENTS member) → naming block injected, exit 0" {
  run_hook "glass-atrium-qa-code-reviewer"
  assert_status 0
  assert_ctx_contains "${NAMING_NEEDLE}"
}

# --- (c) qa-debugger AND dev-swift do NOT receive it (deliberately absent from NAMING_AGENTS) ---

@test "qa-debugger (NOT in NAMING_AGENTS) → no naming block, exit 0" {
  run_hook "glass-atrium-qa-debugger"
  assert_status 0
  assert_ctx_not_contains "${NAMING_NEEDLE}"
}

@test "dev-swift (NOT in NAMING_AGENTS) → no naming block, exit 0" {
  run_hook "glass-atrium-dev-swift"
  assert_status 0
  assert_ctx_not_contains "${NAMING_NEEDLE}"
}

# With every other source sandboxed to /nonexistent and the meter off, a non-naming agent has NO
# injectable block at all → the hook fail-opens with no JSON emitted (exit 0).
@test "qa-debugger with all other sources absent → no JSON emitted (fail-open, exit 0)" {
  run_hook "glass-atrium-qa-debugger"
  assert_status 0
  assert_no_json_emitted
}

# --- (d) fail-open: naming markers absent → no hard error, naming block omitted, OTHER blocks emit ---

@test "naming markers absent → fail-open exit 0, naming omitted, comment-logging block still emits" {
  # A naming source WITHOUT the NAMING markers + a comment-logging source WITH its block.
  naming_src="${BATS_TEST_TMPDIR}/naming-no-markers.md"
  printf 'no naming markers here\n' >"${naming_src}"
  comment_src="${BATS_TEST_TMPDIR}/comment.md"
  printf '%s\n' \
    'intro' \
    '<!-- AGENT-INJECT:START -->' \
    'COMMENT-LOGGING-CORE-BODY' \
    '<!-- AGENT-INJECT:END -->' \
    'outro' >"${comment_src}"

  run bash -c '
    agent="$1"; hook="$2"; naming_src="$3"; comment_src="$4"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_SRC="${comment_src}" \
      INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
      INJECT_SCOPE_RULES_NAMING_SRC="${naming_src}" \
      bash "${hook}"
  ' _ "glass-atrium-dev-react" "${HOOK_SH}" "${naming_src}" "${comment_src}"

  assert_status 0
  assert_ctx_contains "COMMENT-LOGGING-CORE-BODY"
  assert_ctx_not_contains "${NAMING_NEEDLE}"
  # The fail-open path emits a single stderr diagnostic naming the empty source (bats merges it).
  [[ "${output}" == *"naming block empty or markers absent"* ]] || {
    echo "expected naming fail-open stderr diagnostic, got: ${output}" >&2
    return 1
  }
}

@test "naming source file absent entirely → fail-open exit 0, naming omitted, no hard error" {
  run_hook "glass-atrium-dev-react" "/nonexistent/naming.md"
  assert_status 0
  assert_ctx_not_contains "${NAMING_NEEDLE}"
}
