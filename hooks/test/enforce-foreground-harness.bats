#!/usr/bin/env bats
# enforce-foreground-harness.bats — Bats suite for the PreToolUse(Agent) gate enforcing Harness Path
#   Protection Rule 2 (staged lane MANDATORY): an Agent prompt naming a non-exempt harness path is
#   blocked whatever run_in_background holds or omits.
#
# The hook is a pure TEXT scan of the delegation prompt — it cannot tell a READ reference from a
# WRITE target. Exempt: the BASENAME files at a harness root, the runtime-DATA subdirs (data/,
# projects/, logs/, …), and a progress-*.md directly in a projects/<p>/memory/ dir. Every other memory
# file and every CONFIG path (agents/, hooks/, skills/, settings*.json) stays protected, and a `..`
# segment voids every exemption.
#
# Decision channel = exit code: 0 PASS (not blocked) / 2 BLOCK (Rule-2 violation).
# 격리: 합성 JSON 을 stdin 으로 주입, 라이브 hook input 미의존.

bats_require_minimum_version 1.5.0

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-foreground-harness.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-foreground-harness.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
}

# Drive the hook as an Agent PreToolUse call. jq -n builds the payload so the
# prompt (which carries backticks, ~ and $ path chars) is safely encoded.
# Args: $1 = prompt body · $2 = run_in_background: a JSON literal (true/false), `omit` (field absent)
#   or `string:<v>` (string-valued field). HOOK_BASH = interpreter running the hook (default: PATH bash).
run_agent() {
  local prompt="$1" bg="$2" payload
  case "${bg}" in
    omit)
      payload="$(jq -n --arg p "${prompt}" '{tool_name:"Agent", tool_input:{prompt:$p}}')"
      ;;
    string:*)
      payload="$(jq -n --arg p "${prompt}" --arg bg "${bg#string:}" \
        '{tool_name:"Agent", tool_input:{prompt:$p, run_in_background:$bg}}')"
      ;;
    *)
      payload="$(jq -n --arg p "${prompt}" --argjson bg "${bg}" \
        '{tool_name:"Agent", tool_input:{prompt:$p, run_in_background:$bg}}')"
      ;;
  esac
  run bash -c 'printf "%s" "$1" | "$3" "$2"' _ "${payload}" "${HOOK_SH}" "${HOOK_BASH:-bash}"
}

# Every distinct bash on this host — /bin/bash is 3.2 on macOS, the PATH bash is 5 in CI.
list_bashes() {
  local path_bash
  path_bash="$(command -v bash)"
  printf '%s\n' /bin/bash
  [[ "${path_bash}" == /bin/bash ]] || printf '%s\n' "${path_bash}"
}

# The field never decides: model-sent, so its presence and value prove nothing about the launch.

@test "a config path blocks whatever run_in_background holds or omits" {
  local row name bg
  for row in "field absent|omit" "string-valued field|string:false" "explicit false|false" "explicit true|true"; do
    IFS='|' read -r name bg <<<"${row}"
    run_agent 'Write ~/.claude/hooks/x.sh.' "${bg}"
    [[ "${status}" -eq 2 ]] || {
      echo "row: ${name} · status ${status}: ${output}"
      return 1
    }
  done
}

@test "a literal-home config path blocks under every available bash" {
  local interp row name prompt
  while IFS= read -r interp; do
    for row in \
      'dollar HOME|Edit $HOME/.claude/agents/x.md now.' \
      'braced HOME|Edit ${HOME}/.claude/agents/x.md now.' \
      'quoted dollar HOME|Edit "$HOME"/.claude/agents/x.md now.' \
      'quoted braced HOME|Edit "${HOME}"/.claude/agents/x.md now.'; do
      IFS='|' read -r name prompt <<<"${row}"
      HOOK_BASH="${interp}" run_agent "${prompt}" omit
      [[ "${status}" -eq 2 ]] || {
        echo "row: ${name} under ${interp} · status ${status}: ${output}"
        return 1
      }
    done
  done < <(list_bashes)
}

@test "a home holding regex metacharacters matches as a fixed string" {
  local row name want prompt home='/tmp/a.b+c'
  for row in \
    "the home itself|2|Write ${home}/.claude/hooks/x.sh now." \
    'a path the home pattern would match as a regex|0|Write /tmp/aXbbc/.claude/hooks/x.sh now.'; do
    IFS='|' read -r name want prompt <<<"${row}"
    HOME="${home}" run_agent "${prompt}" omit
    [[ "${status}" -eq "${want}" ]] || {
      echo "row: ${name} · want ${want} · status ${status}: ${output}"
      return 1
    }
  done
}

# BASENAME and runtime-DATA exemptions: a root-level allowlisted file, or a read-only reference to a
#   runtime-data subdir, is not blocked in any root form.

@test "BASENAME and runtime-DATA references are not blocked in any root form" {
  local row name prompt
  for row in \
    'CLAUDE.md|Append the project note to ~/.claude/CLAUDE.md then stop.' \
    'MEMORY.md|Add the index line to ~/.claude/MEMORY.md and exit.' \
    'GLASS_ATRIUM_GLOBAL_RULES.md|Update ~/.claude/GLASS_ATRIUM_GLOBAL_RULES.md now.' \
    'data/|For context, read ~/.claude/data/outcomes/2026-07-07.md.' \
    'projects/ transcript|Analyze ~/.claude/projects/-Users-x/session.jsonl (read-only).' \
    'logs/|Tail ~/.claude/logs/daemon.log.' \
    "absolute-home data/|Read ${HOME}/.claude/data/learning-log.md for prior lessons." \
    'CWD-relative data/|From the repo root, read .claude/data/session-spawns/latest.json.'; do
    IFS='|' read -r name prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq 0 ]] || {
      echo "row: ${name} · status ${status}: ${output}"
      return 1
    }
  done
}

# CONFIG-write protection

@test "tilde ~/.claude-personal/<config> → STILL blocked (case c)" {
  run_agent 'Update ~/.claude-personal/agents/reviewer.md with the new domains.' true
  [[ "${status}" -eq 2 ]]
}

@test "tilde ~/.claude/settings.json → STILL blocked (settings*.json protected)" {
  run_agent 'Add the hook entry to ~/.claude/settings.json.' true
  [[ "${status}" -eq 2 ]]
}

@test "tilde ~/.claude/skills/x/SKILL.md → STILL blocked (skills config)" {
  run_agent 'Edit ~/.claude/skills/foo/SKILL.md description field.' true
  [[ "${status}" -eq 2 ]]
}

# Path-form arms classify CONFIG correctly (case e)

@test "absolute-\$HOME /.claude/hooks/ config → STILL blocked (arm intact)" {
  run_agent "Write ${HOME}/.claude/hooks/new.sh and wire it." true
  [[ "${status}" -eq 2 ]]
}

@test "CWD-relative .claude/agents/ config → STILL blocked (arm intact)" {
  run_agent 'From the home dir, edit .claude/agents/custom.md frontmatter.' true
  [[ "${status}" -eq 2 ]]
}

# Memory dir under projects/: only a progress checkpoint the charter mandates is exempt.

@test "a progress file directly in a memory dir is the only memory file not blocked" {
  local row name want prompt
  for row in \
    'progress file|0|Persist ~/.claude/projects/-Users-x/memory/progress-foo.md now.' \
    'progress file on a profile branch|0|Persist ~/.claude-personal/projects/-Users-x/memory/progress-foo.md now.' \
    'MEMORY.md in the memory dir|2|Update ~/.claude/projects/-Users-x/memory/MEMORY.md now.' \
    'feedback file|2|Write ~/.claude-work/projects/-Users-x/memory/feedback_x.md now.' \
    'traversal out of a progress file|2|Write ~/.claude/projects/-Users-x/memory/progress-x.md/../MEMORY.md now.' \
    'progress file one dir deeper|2|Write ~/.claude/projects/-Users-x/memory/sub/progress-x.md now.' \
    'non-md progress file|2|Write ~/.claude/projects/-Users-x/memory/progress-x.txt now.'; do
    IFS='|' read -r name want prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq "${want}" ]] || {
      echo "row: ${name} · want ${want} · status ${status}: ${output}"
      return 1
    }
  done
}

@test "a .. segment voids every exemption" {
  local row name prompt
  for row in \
    'projects traversal|Write ~/.claude/projects/../agents/x.md now.' \
    'data traversal|Write ~/.claude/data/../settings.json now.' \
    'BASENAME traversal|Write ~/.claude/CLAUDE.md/../hooks/x.sh now.'; do
    IFS='|' read -r name prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq 2 ]] || {
      echo "row: ${name} · status ${status}: ${output}"
      return 1
    }
  done
}

# Mixed prompt: any non-exempt match blocks

@test "data/ (exempt) + hooks/ (config) in one prompt → BLOCKED" {
  run_agent 'Read ~/.claude/data/outcomes/x.md, then write ~/.claude/hooks/y.sh.' true
  [[ "${status}" -eq 2 ]]
}

# Orthogonal guards

@test "prompt with no harness path → NOT blocked (out of scope)" {
  run_agent 'Refactor src/util/date.ts to use date-fns.' true
  [[ "${status}" -eq 0 ]]
}

@test "a prompt with no .claude substring passes without sourcing the lib" {
  mkdir -p "${BATS_TEST_TMPDIR}/nolib"
  cp -- "${HOOK_SH}" "${BATS_TEST_TMPDIR}/nolib/enforce-foreground-harness.sh"
  HOOK_SH="${BATS_TEST_TMPDIR}/nolib/enforce-foreground-harness.sh" run_agent 'Refactor src/util/date.ts.' true
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
}

@test "non-Agent tool → NOT blocked (out of scope)" {
  local payload
  payload="$(jq -n '{tool_name:"Write", tool_input:{file_path:"~/.claude/hooks/x.sh"}}')"
  run bash -c 'printf "%s" "$1" | bash "$2"' _ "${payload}" "${HOOK_SH}"
  [[ "${status}" -eq 0 ]]
}

# shellcheck source-path=SCRIPTDIR source=lib/forced-write.bash
source "${BATS_TEST_DIRNAME}/lib/forced-write.bash"

# Degraded row: a hook copy with no lib/ beside it → the fail-closed branch.
@test "every block path exits 2 with its reason once on stderr and nothing on stdout, even when the write is interrupted" {
  local row name hook needle
  mkdir -p "${BATS_TEST_TMPDIR}/nolib"
  cp -- "${HOOK_SH}" "${BATS_TEST_TMPDIR}/nolib/enforce-foreground-harness.sh"
  jq -n '{tool_name:"Agent",tool_input:{prompt:"Edit ~/.claude/agents/x.md"}}' \
    >"${BATS_TEST_TMPDIR}/envelope"
  for row in \
    "config path|${HOOK_SH}|Harness Path Protection Rule 2: staged lane MANDATORY" \
    "degraded lib|${BATS_TEST_TMPDIR}/nolib/enforce-foreground-harness.sh|repair the hook install"; do
    IFS='|' read -r name hook needle <<<"${row}"
    run_forced_hook "${hook}" "${BATS_TEST_TMPDIR}/envelope"
    assert_forced_block "${needle}" || {
      echo "row: ${name}"
      return 1
    }
  done
}
