#!/usr/bin/env bats
# enforce-foreground-harness.bats — Bats suite for the PreToolUse(Agent) gate
#   enforcing Harness Path Protection Rule 2 (foreground MANDATORY for harness
#   writes when run_in_background=true).
#
# Focus (Thread C / T10-T11): the runtime-DATA false-positive fix. The hook is a
# pure TEXT scan of the delegation prompt — it cannot tell a READ reference from
# a WRITE target, so a read-only prompt that merely MENTIONS a runtime-data path
# (~/.claude/data/, ~/.claude/projects/, ~/.claude/logs/, …) was falsely forcing
# foreground. T11 excludes the runtime-DATA subdirs from the match while keeping
# CONFIG paths (agents/, hooks/, skills/, settings*.json) AND the memory dir
# (nested under projects/) fully protected.
#
# Decision channel = exit code: 0 PASS (not blocked) / 2 BLOCK (Rule-2 violation).
# 격리: 합성 JSON 을 stdin 으로 주입, 라이브 hook input 미의존.
#
# TDD note: the "runtime-DATA exemption (NEW behavior)" group is RED against the
# pre-fix hook; every "preserved protection" case is GREEN before AND after.

bats_require_minimum_version 1.5.0

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-foreground-harness.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-foreground-harness.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  # Capture gate isolation: a live flag file or exported env var must never record test calls.
  export GA_DATA_ROOT="${BATS_TEST_TMPDIR}/isolated-data-root"
  unset GA_HPP_AGENT_CAPTURE
}

# Drive the hook as an Agent PreToolUse call. jq -n builds the payload so the
# prompt (which carries backticks, ~ and $ path chars) is safely encoded.
# Args: $1 = prompt body, $2 = run_in_background boolean literal (true/false).
run_agent() {
  local prompt="$1" bg="$2" payload
  payload="$(jq -n --arg p "${prompt}" --argjson bg "${bg}" \
    '{tool_name:"Agent", tool_input:{prompt:$p, run_in_background:$bg}}')"
  run bash -c 'printf "%s" "$1" | bash "$2"' _ "${payload}" "${HOOK_SH}"
}

# Runtime-DATA exemption (NEW behavior — RED before T11, GREEN after)
# A read-only reference to a runtime-data subdir must NOT force foreground.

@test "tilde ~/.claude/data/ reference + bg=true → NOT blocked (case a)" {
  run_agent 'For context, read ~/.claude/data/outcomes/2026-07-07.md then summarize.' true
  [[ "${status}" -eq 0 ]]
}

@test "tilde ~/.claude/projects/ (session transcript) + bg=true → NOT blocked" {
  run_agent 'Analyze the transcript at ~/.claude/projects/-Users-x/session.jsonl (read-only).' true
  [[ "${status}" -eq 0 ]]
}

@test "tilde ~/.claude/logs/ reference + bg=true → NOT blocked" {
  run_agent 'Tail ~/.claude/logs/daemon.log and report the last error.' true
  [[ "${status}" -eq 0 ]]
}

@test "absolute-\$HOME /.claude/data/ reference + bg=true → NOT blocked (arm-invariant)" {
  run_agent "Read ${HOME}/.claude/data/learning-log.md for prior lessons." true
  [[ "${status}" -eq 0 ]]
}

@test "CWD-relative .claude/data/ reference + bg=true → NOT blocked (arm-invariant)" {
  run_agent 'From the repo root, read .claude/data/session-spawns/latest.json.' true
  [[ "${status}" -eq 0 ]]
}

# Preserved CONFIG-write protection (GREEN before AND after)

@test "tilde ~/.claude/hooks/x.sh + bg=true → STILL blocked (case b)" {
  run_agent 'Write the new hook to ~/.claude/hooks/x.sh and register it.' true
  [[ "${status}" -eq 2 ]]
}

@test "tilde ~/.claude-personal/<config> + bg=true → STILL blocked (case c)" {
  run_agent 'Update ~/.claude-personal/agents/reviewer.md with the new domains.' true
  [[ "${status}" -eq 2 ]]
}

@test "tilde ~/.claude/settings.json + bg=true → STILL blocked (settings*.json protected)" {
  run_agent 'Add the hook entry to ~/.claude/settings.json.' true
  [[ "${status}" -eq 2 ]]
}

@test "tilde ~/.claude/skills/x/SKILL.md + bg=true → STILL blocked (skills config)" {
  run_agent 'Edit ~/.claude/skills/foo/SKILL.md description field.' true
  [[ "${status}" -eq 2 ]]
}

# BASENAME exemption preserved (case d — GREEN before AND after)

@test "CLAUDE.md basename at harness root + bg=true → NOT blocked" {
  run_agent 'Append the project note to ~/.claude/CLAUDE.md then stop.' true
  [[ "${status}" -eq 0 ]]
}

@test "MEMORY.md basename at harness root + bg=true → NOT blocked" {
  run_agent 'Add the index line to ~/.claude/MEMORY.md and exit.' true
  [[ "${status}" -eq 0 ]]
}

@test "GLASS_ATRIUM_GLOBAL_RULES.md basename at harness root + bg=true → NOT blocked" {
  run_agent 'Update ~/.claude/GLASS_ATRIUM_GLOBAL_RULES.md thinking-budget section.' true
  [[ "${status}" -eq 0 ]]
}

# Path-form arms still classify CONFIG correctly (case e — GREEN both)

@test "absolute-\$HOME /.claude/hooks/ config + bg=true → STILL blocked (arm intact)" {
  run_agent "Write ${HOME}/.claude/hooks/new.sh and wire it." true
  [[ "${status}" -eq 2 ]]
}

@test "CWD-relative .claude/agents/ config + bg=true → STILL blocked (arm intact)" {
  run_agent 'From the home dir, edit .claude/agents/custom.md frontmatter.' true
  [[ "${status}" -eq 2 ]]
}

# Memory-dir protection under projects/ (Open Q #6 — GREEN before AND after)
# The memory dir is nested at projects/<proj>/memory/. projects/ is on the
# runtime-DATA denylist, so the fix MUST NOT let a memory write slip through:
# a /memory/ path segment keeps the match protected.

@test "~/.claude/projects/<proj>/memory/ write + bg=true → STILL blocked (memory guard)" {
  run_agent 'Persist ~/.claude/projects/-Users-x/memory/progress-foo.md in the background.' true
  [[ "${status}" -eq 2 ]]
}

@test "~/.claude-work/projects/<proj>/memory/feedback + bg=true → STILL blocked (memory guard)" {
  run_agent 'Write ~/.claude-work/projects/-Users-x/memory/feedback_x.md now.' true
  [[ "${status}" -eq 2 ]]
}

# Mixed prompt: any non-exempt match still blocks (GREEN before AND after)

@test "data/ (exempt) + hooks/ (config) in one prompt + bg=true → BLOCKED" {
  run_agent 'Read ~/.claude/data/outcomes/x.md, then write ~/.claude/hooks/y.sh.' true
  [[ "${status}" -eq 2 ]]
}

# Orthogonal guards intact (GREEN before AND after)

@test "foreground (bg=false) with a config path → NOT blocked (Rule-2 only on bg)" {
  run_agent 'Write ~/.claude/hooks/x.sh.' false
  [[ "${status}" -eq 0 ]]
}

@test "prompt with no harness path + bg=true → NOT blocked (out of scope)" {
  run_agent 'Refactor src/util/date.ts to use date-fns.' true
  [[ "${status}" -eq 0 ]]
}

@test "non-Agent tool → NOT blocked (out of scope)" {
  local payload
  payload="$(jq -n '{tool_name:"Write", tool_input:{file_path:"~/.claude/hooks/x.sh"}}')"
  run bash -c 'printf "%s" "$1" | bash "$2"' _ "${payload}" "${HOOK_SH}"
  [[ "${status}" -eq 0 ]]
}

# Envelope capture (measurement): off unless GA_HPP_AGENT_CAPTURE=1 or the data-root flag file exists,
#   and it never leaks a value.

@test "the envelope capture writes nothing and keeps every verdict when neither gate is set" {
  local root="${BATS_TEST_TMPDIR}/capture-off" row name want prompt payload written
  mkdir -p "${root}/home"
  for row in 'harness path|2|Edit ~/.claude/agents/x.md' 'no harness path|0|Refactor src/a.ts'; do
    IFS='|' read -r name want prompt <<<"${row}"
    payload="$(jq -n --arg p "${prompt}" '{tool_name:"Agent", tool_input:{prompt:$p, run_in_background:true}}')"
    run env -u GA_HPP_AGENT_CAPTURE "HOME=${root}/home" "GA_DATA_ROOT=${root}/data-root" \
      bash -c 'printf "%s" "$1" | bash "$2"' _ "${payload}" "${HOOK_SH}"
    written="$(find "${root}" -type f)"
    [[ "${status}" -eq "${want}" && -z "${written}" ]] || {
      echo "row: ${name} · want ${want} · status ${status} · written: ${written} · ${output}"
      return 1
    }
  done
}

@test "either gate records key names and the field's type, never prompt text or other values" {
  local row name gate version_src want_version root payload record
  local -a gate_env
  for row in 'env var|env|transcript|9.9.9' 'flag file|flag|envelope|8.8.8'; do
    IFS='|' read -r name gate version_src want_version <<<"${row}"
    root="${BATS_TEST_TMPDIR}/capture-${gate}"
    mkdir -p "${root}/home" "${root}/data-root/data"
    printf '%s\n' '{"type":"user"}' '{"type":"assistant","version":"9.9.9"}' >"${root}/transcript.jsonl"
    payload="$(jq -n --arg t "${root}/transcript.jsonl" '{tool_name:"Agent", transcript_path:$t,
      tool_input:{prompt:"SECRET-PROMPT edit ~/.claude/agents/x.md", description:"SECRET-DESC", run_in_background:true}}')"
    if [[ "${version_src}" == "envelope" ]]; then
      payload="$(jq -c '. + {version: "8.8.8"}' <<<"${payload}")"
    fi
    gate_env=("HOME=${root}/home" "GA_DATA_ROOT=${root}/data-root")
    if [[ "${gate}" == "env" ]]; then
      gate_env+=("GA_HPP_AGENT_CAPTURE=1")
    else
      : >"${root}/data-root/data/hpp-agent-capture.on"
    fi
    run env -u GA_HPP_AGENT_CAPTURE "${gate_env[@]}" \
      bash -c 'printf "%s" "$1" | bash "$2"' _ "${payload}" "${HOOK_SH}"
    record="$(cat -- "${root}/data-root/data/hpp-agent-capture.jsonl" 2>/dev/null)" || record=""
    [[ "${status}" -eq 2 && -n "${record}" && "${record}" != *SECRET* ]] || {
      echo "row: ${name} · status ${status} · record: ${record}"
      return 1
    }
    jq -e --arg v "${want_version}" '.cli_version == $v
      and (.envelope_keys - ["version"]) == ["tool_input", "tool_name", "transcript_path"]
      and .tool_input_keys == ["description", "prompt", "run_in_background"]
      and .run_in_background == {type: "boolean", value: true}' <<<"${record}" >/dev/null || {
      echo "row: ${name} · record: ${record}"
      return 1
    }
  done
}

@test "a failed capture write keeps the block verdict" {
  local root="${BATS_TEST_TMPDIR}/capture-unwritable" payload
  mkdir -p "${root}/data-root/data/hpp-agent-capture.jsonl"
  payload="$(jq -n '{tool_name:"Agent", tool_input:{prompt:"Edit ~/.claude/agents/x.md", run_in_background:true}}')"
  run env "GA_HPP_AGENT_CAPTURE=1" "GA_DATA_ROOT=${root}/data-root" \
    bash -c 'printf "%s" "$1" | bash "$2"' _ "${payload}" "${HOOK_SH}"
  [[ "${status}" -eq 2 && "${output}" == *"Harness Path Protection Rule 2"* ]] || {
    echo "status ${status} · ${output}"
    return 1
  }
}

# shellcheck source-path=SCRIPTDIR source=lib/forced-write.bash
source "${BATS_TEST_DIRNAME}/lib/forced-write.bash"

# Degraded row: a hook copy with no lib/ beside it → the fail-closed branch.
@test "every block path exits 2 with its reason once on stderr and nothing on stdout, even when the write is interrupted" {
  local row name hook needle
  mkdir -p "${BATS_TEST_TMPDIR}/nolib"
  cp -- "${HOOK_SH}" "${BATS_TEST_TMPDIR}/nolib/enforce-foreground-harness.sh"
  jq -n '{tool_name:"Agent",tool_input:{prompt:"Edit ~/.claude/agents/x.md",run_in_background:true}}' \
    >"${BATS_TEST_TMPDIR}/envelope"
  for row in \
    "config path|${HOOK_SH}|Harness Path Protection Rule 2: foreground MANDATORY" \
    "degraded lib|${BATS_TEST_TMPDIR}/nolib/enforce-foreground-harness.sh|repair the hook install"; do
    IFS='|' read -r name hook needle <<<"${row}"
    run_forced_hook "${hook}" "${BATS_TEST_TMPDIR}/envelope"
    assert_forced_block "${needle}" || {
      echo "row: ${name}"
      return 1
    }
  done
}
