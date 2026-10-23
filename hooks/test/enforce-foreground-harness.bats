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

@test "tilde ~/.claude-personal/<config> → STILL blocked" {
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
    'traversal that ends on a progress name|2|Write ~/.claude/projects/../memory/progress-x.md now.' \
    'progress file one dir deeper|2|Write ~/.claude/projects/-Users-x/memory/sub/progress-x.md now.' \
    'progress file under a memory dir nested deeper in projects|2|Write ~/.claude/projects/-Users-x/memory/sub/memory/progress-x.md now.' \
    'file inside a progress-named dir|2|Write ~/.claude/projects/-Users-x/memory/progress-x/MEMORY.md now.' \
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

@test "a .. ahead of the root blocks exactly when the path it resolves to is a harness root" {
  local home="${BATS_TEST_TMPDIR}/home/u"
  mkdir -p "${home}"
  HOME="${home}" assert_rows 2 \
    'tilde, a dir, then ..|Edit ~/x/../.claude/agents/a.md now.' \
    'home variable, a dir, then ..|Edit $HOME/x/../.claude/agents/a.md now.' \
    "literal home, a dir, then ..|Edit ${home}/x/../.claude/agents/a.md now." \
    'climb out of the home and back in|Edit ~/../u/.claude/agents/a.md now.' \
    'lookalike dir, then ..|Edit ~/.claudex/../.claude/agents/a.md now.' \
    'lookalike dotted dir, then ..|Edit ~/.claude.d/../.claude/agents/a.md now.' \
    'relative from home, then ..|From the home dir, edit x/../.claude/agents/a.md now.' \
    'traversal onto a progress name|Write ~/x/../.claude/projects/p/memory/progress-a.md now.'
  HOME="${home}" assert_rows 0 \
    'resolves to a repo dot dir|Edit ~/x/../y/.claude/agents/a.md now.' \
    'lookalike dir climbed out of|Edit ~/.claudex/../notes/a.md now.' \
    'resolves to the global config file|Read ~/x/../.claude.json now.' \
    'climbs to another home|Edit ~/../v/.claude/agents/a.md now.'
}

# Spellings that name a harness path in plain text: each resolves to the live harness, so each blocks.

# Args: $1 = want (exit code) · $2.. = `name|prompt` rows. HOME may be set by the caller.
assert_rows() {
  local want="$1" row name prompt
  shift
  for row in "$@"; do
    IFS='|' read -r name prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq "${want}" ]] || {
      echo "row: ${name} · want ${want} · status ${status}: ${output}"
      return 1
    }
  done
}

@test "an angle-bracket placeholder segment does not cut the path short" {
  assert_rows 2 \
    'MEMORY.md behind a placeholder|Edit ~/.claude/projects/<home-encoded>/memory/MEMORY.md now.' \
    'feedback file behind a placeholder|Write ~/.claude-personal/projects/<home-encoded>/memory/feedback_x.md now.' \
    'traversal behind a placeholder|Edit ~/.claude/projects/<p>/../../agents/x.md now.'
  assert_rows 0 \
    'the charter progress spelling|Persist ~/.claude/projects/<home-encoded>/memory/progress-{task-name}.md now.'
}

@test "a protected path joined onto an exempt path by a separator is still classified" {
  assert_rows 2 \
    'comma|Edit ~/.claude/data/a.json,~/.claude/settings.json now.' \
    'scope line|[SCOPE] files=~/.claude/data/report.json,~/.claude/agents/x.md · deliverable=edit · out=none' \
    'semicolon onto a branch|Edit ~/.claude/logs/a;~/.claude-work/settings.json now.' \
    'colon|Edit ~/.claude/projects/p/notes.md:~/.claude/hooks/x.sh now.' \
    'pipe|Edit ~/.claude/todos/a|~/.claude/settings.json now.' \
    'ampersands|Edit ~/.claude/data/a&&~/.claude/settings.json now.' \
    'relative after a comma|Edit ~/.claude/data/a,.claude/settings.json now.'
  assert_rows 0 \
    'two exempt paths in one list|[SCOPE] files=~/.claude/data/a.json,~/.claude/projects/-Users-x/memory/progress-x.md · deliverable=edit · out=none'
}

@test "a harness root named without a trailing slash still blocks" {
  assert_rows 2 \
    'cd into the root|cd ~/.claude && edit settings.json' \
    'root as a directory word|Rewrite the hooks in the ~/.claude directory.' \
    'bare root|Edit ~/.claude' \
    'bare branch root|Edit ~/.claude-work' \
    'quoted root|Edit "~/.claude"/settings.json now.' \
    'glob root|Edit ~/.claude*/settings.json now.' \
    'brace list of roots|Edit ~/{.claude,.claude-work}/settings.json now.' \
    'brace branch suffix|Edit ~/.claude-{work,personal}/settings.json now.'
  assert_rows 0 \
    'the global config file is no config dir|Read ~/.claude.json for the MCP server list.'
}

@test "a noisy spelling of the home dir still blocks" {
  local home="${BATS_TEST_TMPDIR}/home/u"
  mkdir -p "${home}"
  HOME="${home}" assert_rows 2 \
    'doubled slash after tilde|Edit ~//.claude/agents/x.md now.' \
    'dot segment after tilde|Edit ~/./.claude/agents/x.md now.' \
    "doubled slash after the home|Edit ${home}//.claude/agents/x.md now." \
    "dot segment after the home|Edit ${home}/./.claude/agents/x.md now." \
    "doubled slash inside the home|Edit ${BATS_TEST_TMPDIR}/home//u/.claude/agents/x.md now." \
    'tilde with a user name|Edit ~u/.claude/agents/x.md now.' \
    'dot-slash relative|cd ~ && edit ./.claude/agents/x.md' \
    'relative after an equals sign|Edit --file=.claude/agents/x.md now.' \
    'quote inside the path|Edit $HOME"/.claude/agents/x.md" now.' \
    "single quotes splitting the root|Edit ~/.cl'aude'/agents/x.md now." \
    'backslash before the root|Edit ~/\.claude/agents/x.md now.'
}

@test "trailing punctuation after a path does not change its class" {
  assert_rows 0 \
    'progress file ending a sentence|Checkpoint to ~/.claude/projects/-Users-x/memory/progress-foo.md.' \
    'progress file in bold|Checkpoint to **~/.claude/projects/-Users-x/memory/progress-foo.md**' \
    'progress file before an exclamation|Checkpoint to ~/.claude/projects/-Users-x/memory/progress-foo.md!' \
    'BASENAME file ending a sentence|Append the note to ~/.claude/CLAUDE.md.'
  assert_rows 2 \
    'traversal before punctuation|Read ~/.claude/data/..!'
}

@test "an empty home still blocks a harness path instead of rewriting every separator" {
  HOME='' assert_rows 2 \
    'tilde config path|Write ~/.claude/hooks/x.sh now.' \
    'home variable config path|Edit $HOME/.claude/agents/x.md now.' \
    'tilde traversal ahead of the root|Edit ~/x/../.claude/agents/x.md now.'
}

@test "a case variant of a harness root blocks, since the host filesystem folds case" {
  local upper_home
  upper_home="$(printf '%s' "${HOME}" | tr '[:lower:]' '[:upper:]')"
  assert_rows 2 \
    'capitalized root|Edit ~/.Claude/agents/x.md now.' \
    'upper-case branch root|Edit ~/.CLAUDE-work/settings.json now.' \
    'upper-case home|Edit '"${upper_home}"'/.claude/hooks/x.sh now.' \
    'capitalized relative root|From the home dir, edit .Claude/agents/x.md now.'
}

# CWD-relative arm: a relative token names the harness only when, read from $HOME, it reaches an entry
#   the harness root holds or one Claude Code loads as config.

@test "a CWD-relative .claude path blocks only where it would name a harness entry from home" {
  local home="${BATS_TEST_TMPDIR}/home"
  mkdir -p "${home}/.claude"
  : >"${home}/.claude/statusline-command.sh"
  HOME="${home}" assert_rows 0 \
    'repo worktree dir|Repo /x/glass-atrium, worktree .claude/worktrees/wt-pa-hpp, branch fix/x.' \
    'repo audit dir|Records: `.claude/prompt-audit/pa-s3/impl77/` and the plan.'
  HOME="${home}" assert_rows 2 \
    'an entry the harness root holds|From the home dir, edit .claude/statusline-command.sh now.' \
    'a config entry not yet created|From the home dir, edit .claude/agents/x.md now.' \
    'a settings file not yet created|From the home dir, edit .claude/settings.local.json now.' \
    'traversal out of a repo dir|Edit .claude/worktrees/../agents/x.md now.' \
    'a tilde path to the same dir|Edit ~/.claude/worktrees/wt/hooks/x.sh now.'
}

@test "a failed normalization still scans the raw prompt and says so only when it allows" {
  mkdir -p "${BATS_TEST_TMPDIR}/noawk"
  printf '#!/bin/sh\nexit 1\n' >"${BATS_TEST_TMPDIR}/noawk/awk"
  chmod +x "${BATS_TEST_TMPDIR}/noawk/awk"
  PATH="${BATS_TEST_TMPDIR}/noawk:${PATH}" run --separate-stderr \
    bash -c 'printf "%s" "$1" | bash "$2"' _ \
    "$(jq -n '{tool_name:"Agent",tool_input:{prompt:"Edit ~/.claude/agents/x.md now."}}')" "${HOOK_SH}"
  [[ "${status}" -eq 2 && -z "${output}" && "${#stderr_lines[@]}" -eq 1 ]] || {
    echo "block row · status ${status} · stdout ${output} · stderr ${stderr}"
    return 1
  }
  PATH="${BATS_TEST_TMPDIR}/noawk:${PATH}" run --separate-stderr \
    bash -c 'printf "%s" "$1" | bash "$2"' _ \
    "$(jq -n '{tool_name:"Agent",tool_input:{prompt:"Read ~/.claude/data/x.md now."}}')" "${HOOK_SH}"
  [[ "${status}" -eq 0 && "${stderr}" == *'only the raw prompt was scanned'* ]] || {
    echo "allow row · status ${status} · stderr ${stderr}"
    return 1
  }
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
