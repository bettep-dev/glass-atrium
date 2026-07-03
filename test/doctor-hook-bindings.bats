#!/usr/bin/env bats
# D-5 doctor hook event-binding check (glass-atrium run_doctor §6).
#
# The installer deploys hook FILES but the event->hook WIRING lives only in the
# user-owned settings.json (NOT in manifest.json). A clean/partial install leaves
# deployed hooks DORMANT. run_doctor §6 reads settings.json READ-ONLY and WARNs
# per missing binding — it must NEVER write settings.json (mutation-free).
#
# Run via: bats test/doctor-hook-bindings.bats
# Requires: bats (brew install bats-core), jq, bash 3.2+
#
# Hermetic strategy: GA_TARGET_HOME points the target (and thus SETTINGS_JSON =
# <target>/settings.json) at a throwaway temp dir, so the test drives the REAL
# run_doctor against a synthetic settings.json without touching ~/.claude. We
# assert ONLY on the §6 binding lines; §1-5 verdicts are out of scope here.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA}/glass-atrium"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium not found: ${REAL_GA}"
  TARGET="$(mktemp -d -t ga-doctor-bats.XXXXXX)"
  SETTINGS="${TARGET}/settings.json"
}

teardown() {
  [[ -n "${TARGET:-}" && -d "${TARGET}" ]] && rm -rf -- "${TARGET}" || true
}

# settings.json with every EXPECTED_HOOK_BINDINGS entry wired under its event.
# Mirrors the live shape: .hooks.<event>[].hooks[].command (~/.claude/hooks/...).
write_full_settings() {
  cat >"${SETTINGS}" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "~/.claude/hooks/enforce-delegation.sh" } ] },
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/enforce-verification-gate.sh" } ] },
      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-secret-scan.sh" } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-secret-scan.sh" } ] },
      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-prompt.sh" } ] },
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-spawn-cost.sh" } ] },
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-spawn-budget.sh" } ] },
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-context-budget.sh" } ] },
      { "matcher": "Workflow", "hooks": [ { "type": "command", "command": "~/.claude/hooks/enforce-workflow-verify-stage.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-subagent-budget.sh" } ] }
    ],
    "PostToolUse": [
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-output.sh" } ] },
      { "matcher": "WebFetch|WebSearch|mcp__.*(fetch|get|read|search).*", "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-tool-response.sh" } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "~/.claude/hooks/detect-secret-file-write.sh" } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-compliance-matrix.sh" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/cost-tracker.sh" } ] }
    ]
  }
}
JSON
}

# Run the real doctor against the sandboxed target. Doctor returns 0 (PASS) even
# with dormant-binding warnings, so `run` (which records exit in $status) tolerates
# a §1-5 FAIL too — we assert on stdout lines, not the exit code.
run_doctor_sandbox() {
  GA_TARGET_HOME="${TARGET}" run "${REAL_GA}" doctor
}

@test "present binding -> ok line (advisory-spawn-budget wired)" {
  write_full_settings
  run_doctor_sandbox
  # the three newly-registered P1 hooks now report bound
  [[ "${output}" == *"ok   : hook bound — PreToolUse -> advisory-spawn-budget.sh"* ]]
  [[ "${output}" == *"ok   : hook bound — PreToolUse -> advisory-context-budget.sh"* ]]
  [[ "${output}" == *"ok   : hook bound — PostToolUse -> validate-tool-response.sh"* ]]
  # no dormant-binding summary line when everything is wired
  [[ "${output}" != *"dormant hook binding(s)"* ]]
}

@test "two-matcher one-hook -> BOTH matchers reported bound (validate-secret-scan)" {
  # validate-secret-scan.sh binds under TWO matchers under one event; the doctor
  # must report each (matcher-scoped) tuple as bound independently — neither row
  # masks the other.
  write_full_settings
  run_doctor_sandbox
  [[ "${output}" == *"ok   : hook bound — PreToolUse -> validate-secret-scan.sh (matcher=Write|Edit)"* ]]
  [[ "${output}" == *"ok   : hook bound — PreToolUse -> validate-secret-scan.sh (matcher=Bash)"* ]]
  [[ "${output}" != *"dormant hook binding(s)"* ]]
}

@test "Workflow-matcher binding -> reported bound (enforce-workflow-verify-stage)" {
  # enforce-workflow-verify-stage.sh binds under the NEW Workflow matcher/event
  # combo — the matcher-generic doctor check must report it bound, no dormant.
  write_full_settings
  run_doctor_sandbox
  [[ "${output}" == *"ok   : hook bound — PreToolUse -> enforce-workflow-verify-stage.sh (matcher=Workflow)"* ]]
  [[ "${output}" != *"dormant hook binding(s)"* ]]
}

@test "Workflow-matcher binding -> missing one reported dormant" {
  # drop ONLY the Workflow enforce-workflow-verify-stage group; every other
  # binding stays. The new event/matcher tuple must surface as DORMANT.
  write_full_settings
  jq 'del(.hooks.PreToolUse[]
        | select((.matcher == "Workflow")
                 and (.hooks[].command | endswith("enforce-workflow-verify-stage.sh"))))' \
    "${SETTINGS}" >"${SETTINGS}.new"
  mv -f "${SETTINGS}.new" "${SETTINGS}"
  run_doctor_sandbox
  [[ "${output}" == *"warn : hook NOT bound — PreToolUse -> enforce-workflow-verify-stage.sh (matcher=Workflow) (DORMANT"* ]]
  [[ "${output}" == *"dormant hook binding(s)"* ]]
}

@test "two-matcher one-hook -> missing Bash matcher reported dormant, Write|Edit still ok" {
  # drop ONLY the Bash validate-secret-scan group; the Write|Edit one stays. The
  # matcher-scoped check must flag the missing Bash channel as DORMANT while the
  # surviving Write|Edit binding still reports ok (no masking either way).
  write_full_settings
  jq 'del(.hooks.PreToolUse[]
        | select((.matcher == "Bash")
                 and (.hooks[].command | endswith("validate-secret-scan.sh"))))' \
    "${SETTINGS}" >"${SETTINGS}.new"
  mv -f "${SETTINGS}.new" "${SETTINGS}"
  run_doctor_sandbox
  [[ "${output}" == *"warn : hook NOT bound — PreToolUse -> validate-secret-scan.sh (matcher=Bash) (DORMANT"* ]]
  [[ "${output}" == *"ok   : hook bound — PreToolUse -> validate-secret-scan.sh (matcher=Write|Edit)"* ]]
  [[ "${output}" == *"dormant hook binding(s)"* ]]
}

@test "missing binding -> warn line (advisory-spawn-budget dropped)" {
  # full settings minus the advisory-spawn-budget PreToolUse entry
  write_full_settings
  jq 'del(.hooks.PreToolUse[] | select(.hooks[].command | endswith("advisory-spawn-budget.sh")))' \
    "${SETTINGS}" >"${SETTINGS}.new"
  mv -f "${SETTINGS}.new" "${SETTINGS}"
  run_doctor_sandbox
  [[ "${output}" == *"warn : hook NOT bound — PreToolUse -> advisory-spawn-budget.sh (matcher=Agent) (DORMANT"* ]]
  [[ "${output}" == *"dormant hook binding(s)"* ]]
  # a still-wired hook continues to report ok (no false-positive warn)
  [[ "${output}" == *"ok   : hook bound — PreToolUse -> enforce-delegation.sh"* ]]
}

@test "absent settings.json -> all bindings reported dormant" {
  # no settings.json at all in the sandbox target
  [[ ! -f "${SETTINGS}" ]]
  run_doctor_sandbox
  [[ "${output}" == *"settings.json absent"* ]]
  [[ "${output}" == *"ALL hook event-bindings are unwired"* ]]
  # 15 expected bindings (validate-secret-scan binds under BOTH Write|Edit AND
  # Bash; enforce-workflow-verify-stage binds under Workflow; detect-secret-file-write
  # binds under PostToolUse Bash; advisory-subagent-budget binds matcher-less
  # under PreToolUse) → 15 dormant
  [[ "${output}" == *"15 dormant hook binding(s)"* ]]
}

@test "doctor is mutation-free: settings.json byte-identical after run" {
  write_full_settings
  local before_sum after_sum
  before_sum="$(shasum "${SETTINGS}" | cut -d' ' -f1)"
  run_doctor_sandbox
  after_sum="$(shasum "${SETTINGS}" | cut -d' ' -f1)"
  [[ "${before_sum}" == "${after_sum}" ]]
}

@test "doctor never CREATES settings.json when absent (mutation-free)" {
  [[ ! -f "${SETTINGS}" ]]
  run_doctor_sandbox
  # the read-only check must not have written a settings.json into the target
  [[ ! -f "${SETTINGS}" ]]
}

@test "output names the unsafe-to-auto-write rationale (loud-fail framing)" {
  write_full_settings
  jq 'del(.hooks.Stop[] | select(.hooks[].command | endswith("cost-tracker.sh")))' \
    "${SETTINGS}" >"${SETTINGS}.new"
  mv -f "${SETTINGS}.new" "${SETTINGS}"
  run_doctor_sandbox
  [[ "${output}" == *"never writes settings.json"* ]]
  [[ "${output}" == *"warn : hook NOT bound — Stop -> cost-tracker.sh"* ]]
}
