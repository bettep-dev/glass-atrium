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
  # Skip 3 assertion-IRRELEVANT heavy doctor sections via the existing test-mode seams.
  # This suite asserts ONLY §6 hook-binding lines — never §8 manifest / auth self-test / §reports.
  mkdir -p "${TARGET}/bin" "${TARGET}/empty-reports"
  cat >"${TARGET}/bin/claude" <<'SH'
#!/bin/bash
echo OK
exit 0
SH
  chmod +x "${TARGET}/bin/claude"
  export GA_GENERATE_MANIFEST="${TARGET}/no-such-manifest-gen" # nonexistent → §8 SHA hashing skipped
  export GA_AUTH_CLAUDE_BIN="${TARGET}/bin/claude"             # echo-OK stub → no live claude -p network call
  export DOCTOR_AUTH_REPORTS_DIR="${TARGET}/empty-reports"     # empty dir → trivial daemon-reports scan
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
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-context-budget.sh" } ] },
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-spawn-budget.sh" } ] },
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-spawn-cost.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-subagent-budget.sh" } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "~/.claude/hooks/block-dangerous-commands.sh" } ] },
      { "matcher": "Write", "hooks": [ { "type": "command", "command": "~/.claude/hooks/block-doc-routing-leak.sh" } ] },
      { "matcher": "Write", "hooks": [ { "type": "command", "command": "~/.claude/hooks/block-md-creation.sh" } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "~/.claude/hooks/block-no-verify.sh" } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "~/.claude/hooks/enforce-commit-guard.sh" } ] },
      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "~/.claude/hooks/enforce-config-protection.sh" } ] },
      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "~/.claude/hooks/enforce-delegation.sh" } ] },
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/enforce-foreground-harness.sh" } ] },
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/enforce-verification-gate.sh" } ] },
      { "matcher": "Workflow", "hooks": [ { "type": "command", "command": "~/.claude/hooks/enforce-workflow-verify-stage.sh" } ] },
      { "matcher": "Workflow", "hooks": [ { "type": "command", "command": "~/.claude/hooks/lint-workflow-template-literal.sh" } ] },
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/telemetry-activation.sh" } ] },
      { "matcher": "Write", "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-pre-write-raw.sh" } ] },
      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-prompt.sh" } ] },
      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-scope-drift.sh" } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-secret-scan.sh" } ] },
      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-secret-scan.sh" } ] }
    ],
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "~/.claude/hooks/detect-secret-file-write.sh" } ] },
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/enforce-verification-gate.sh" } ] },
      { "matcher": "Edit|Write", "hooks": [ { "type": "command", "command": "~/.claude/hooks/post-edit-format.sh" } ] },
      { "matcher": "Write", "hooks": [ { "type": "command", "command": "~/.claude/hooks/post-edit-outcome-sync.sh" } ] },
      { "matcher": "Edit|Write", "hooks": [ { "type": "command", "command": "~/.claude/hooks/post-edit-typecheck.sh" } ] },
      { "matcher": "Edit|Write", "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-large-diff.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-output.sh" } ] },
      { "matcher": "WebFetch|WebSearch|mcp__.*(fetch|get|read|search).*", "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-tool-response.sh" } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/inject-session-context.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/prune-security-warnings-state.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/prune-session-spawns.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-compliance-matrix.sh" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-preedit-facts.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/cost-tracker.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/post-edit-typecheck.sh" } ] }
    ],
    "SubagentStart": [
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/agent-tracker.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/inject-scope-rules.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/telemetry-activation.sh" } ] }
    ],
    "SubagentStop": [
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/agent-tracker.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/post-edit-typecheck.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/track-outcome.sh" } ] }
    ],
    "PreCompact": [
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/pre-compact.sh" } ] }
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

@test "Workflow-matcher binding -> reported bound (lint-workflow-template-literal)" {
  # lint-workflow-template-literal.sh is the SECOND hook under the Workflow matcher —
  # its bound status must be reported independently of enforce-workflow-verify-stage
  # (neither Workflow-matcher hook masks the other), no dormant.
  write_full_settings
  run_doctor_sandbox
  [[ "${output}" == *"ok   : hook bound — PreToolUse -> lint-workflow-template-literal.sh (matcher=Workflow)"* ]]
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
  # EXPECTED_HOOK_BINDINGS enumerates the COMPLETE 43-binding set across all 7 events
  # (PreToolUse 21 / PostToolUse 8 / SessionStart 4 / Stop 3 / SubagentStart 3 /
  # SubagentStop 3 / PreCompact 1). The total is counted per FLATTENED matcher-leaf,
  # NOT per unique hook basename: validate-secret-scan.sh binds under TWO matchers
  # (Write|Edit AND Bash), two hooks share the Workflow matcher (enforce-workflow-
  # verify-stage.sh AND lint-workflow-template-literal.sh), enforce-verification-gate.sh
  # binds under BOTH PreToolUse and PostToolUse (Agent matcher), and several hooks recur
  # across events (agent-tracker.sh, post-edit-typecheck.sh, telemetry-activation.sh) —
  # each occurrence is a distinct leaf. advisory-preedit-facts.sh binds on Stop ONLY
  # (SubagentStop sees a parent transcript that predates the subagent's edits). With
  # settings.json absent, every leaf is unwired, so all 43 report dormant.
  [[ "${output}" == *"43 dormant hook binding(s)"* ]]
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
