#!/usr/bin/env bats
# enforce-foreground-harness-branch.bats — Bats suite for the profile-branch COVERAGE of the
#   PreToolUse(Agent) Rule-2 gate (staged lane MANDATORY): a full profile branch on disk
#   (`~/.claude-work-dev/`) — settings.json, agents/, its own daemon — is a harness root like
#   `~/.claude/`. Coverage derives from the single-sited root grammar in lib/claude-config-dirs.sh,
#   and a non-exempt path blocks whatever run_in_background holds or omits.
#
# Decision channel = exit code: 0 PASS (not blocked) / 2 BLOCK (Rule-2 violation).
# 격리: 합성 JSON 을 stdin 으로 주입, 라이브 hook input 미의존.

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-foreground-harness.sh"
BACKUP_DIR=".claude-pre-glass-atrium-backup-20260603T043853Z"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-foreground-harness.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
}

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

# A config path on a profile branch root blocks like one on ~/.claude/

@test "~/.claude-work-dev/hooks/x.sh → BLOCKED" {
  run_agent 'Write the new hook to ~/.claude-work-dev/hooks/x.sh.' true
  [[ "${status}" -eq 2 ]]
}

@test "absolute-\$HOME .claude-work-dev/agents/ → BLOCKED (arm-invariant)" {
  run_agent "Edit ${HOME}/.claude-work-dev/agents/custom.md frontmatter." true
  [[ "${status}" -eq 2 ]]
}

@test "CWD-relative .claude-work-dev/skills/ → BLOCKED (arm-invariant)" {
  run_agent 'From the home dir, edit .claude-work-dev/skills/foo/SKILL.md.' true
  [[ "${status}" -eq 2 ]]
}

@test "a branch config path blocks whatever run_in_background holds or omits" {
  local row name bg
  for row in "field absent|omit" "string-valued field|string:false" "explicit false|false" "explicit true|true"; do
    IFS='|' read -r name bg <<<"${row}"
    run_agent 'Add the hook entry to ~/.claude-work-dev/settings.json.' "${bg}"
    [[ "${status}" -eq 2 ]] || {
      echo "row: ${name} · status ${status}: ${output}"
      return 1
    }
  done
}

@test "a literal-home branch config path blocks under every available bash" {
  local interp row name prompt
  while IFS= read -r interp; do
    for row in \
      'dollar HOME|Edit $HOME/.claude-work-dev/settings.json now.' \
      'braced HOME|Edit ${HOME}/.claude-work-dev/settings.json now.' \
      'quoted dollar HOME|Edit "$HOME"/.claude-work-dev/settings.json now.' \
      'quoted braced HOME|Edit "${HOME}"/.claude-work-dev/settings.json now.'; do
      IFS='|' read -r name prompt <<<"${row}"
      HOOK_BASH="${interp}" run_agent "${prompt}" omit
      [[ "${status}" -eq 2 ]] || {
        echo "row: ${name} under ${interp} · status ${status}: ${output}"
        return 1
      }
    done
  done < <(list_bashes)
}

# Dormant backup dir: intentional fail-safe over-coverage

@test "dormant backup dir config path → BLOCKED" {
  run_agent "Restore ~/${BACKUP_DIR}/hooks/old.sh into place." true
  [[ "${status}" -eq 2 ]]
}

# BASENAME exception holds on every branch × root form; runtime-DATA exclusions keep their CURRENT
#   membership on branch roots.

@test "BASENAME and runtime-DATA references on a branch root are not blocked in any root form" {
  local row name prompt
  for row in \
    'CLAUDE.md, tilde|Append the project note to ~/.claude-work-dev/CLAUDE.md then stop.' \
    "MEMORY.md, absolute home|Add the index line to ${HOME}/.claude-personal/MEMORY.md then exit." \
    'GLASS_ATRIUM_GLOBAL_RULES.md, bare|From the home dir, update .claude-work-dev/GLASS_ATRIUM_GLOBAL_RULES.md now.' \
    "CLAUDE.md on the backup dir|Read ~/${BACKUP_DIR}/CLAUDE.md for the old wording." \
    'data/|For context, read ~/.claude-work-dev/data/outcomes/2026-08-14.md.' \
    'logs/|Tail ~/.claude-personal/logs/daemon.log and report the last error.' \
    'shell-snapshots/|List ~/.claude-work-dev/shell-snapshots/latest.sh.'; do
    IFS='|' read -r name prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq 0 ]] || {
      echo "row: ${name} · status ${status}: ${output}"
      return 1
    }
  done
}

@test "a progress file directly in a branch memory dir is the only memory file not blocked" {
  local row name want prompt
  for row in \
    'progress file|0|Persist ~/.claude-work-dev/projects/-Users-x/memory/progress-foo.md now.' \
    'MEMORY.md in the memory dir|2|Update ~/.claude-work-dev/projects/-Users-x/memory/MEMORY.md now.' \
    'feedback file|2|Write ~/.claude-work-dev/projects/-Users-x/memory/feedback_x.md now.' \
    'traversal that ends on a progress name|2|Write ~/.claude-work-dev/projects/../memory/progress-x.md now.'; do
    IFS='|' read -r name want prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq "${want}" ]] || {
      echo "row: ${name} · want ${want} · status ${status}: ${output}"
      return 1
    }
  done
}

@test "a .. segment voids every exemption on a branch root" {
  local row name prompt
  for row in \
    'projects traversal|Write ~/.claude-work-dev/projects/../agents/x.md now.' \
    'data traversal|Write ~/.claude-work-dev/data/../settings.json now.'; do
    IFS='|' read -r name prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq 2 ]] || {
      echo "row: ${name} · status ${status}: ${output}"
      return 1
    }
  done
}

@test "a .. ahead of a branch root blocks like the branch root itself" {
  local row name prompt
  for row in \
    'a dir, then ..|Edit ~/x/../.claude-work-dev/agents/a.md now.' \
    'lookalike dir, then ..|Edit ~/.claudex/../.claude-work-dev/settings.json now.' \
    'climb out of the home and back in|Edit ~/../'"${HOME##*/}"'/.claude-work-dev/hooks/x.sh now.'; do
    IFS='|' read -r name prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq 2 ]] || {
      echo "row: ${name} · status ${status}: ${output}"
      return 1
    }
  done
}

@test "a profile jobs/ path outside a job's tmp/ scratch → BLOCKED" {
  local row name prompt
  for row in \
    'file directly in jobs/|Queue the run via ~/.claude-work-dev/jobs/pending.json.' \
    'job pins file|Edit ~/.claude-work-dev/jobs/pins.json now.' \
    'job state file|Write ~/.claude-work-dev/jobs/25a65a54/state.json now.' \
    'traversal out of a job tmp/|Write ~/.claude-work-dev/jobs/25a65a54/tmp/../../../hooks/x.sh now.'; do
    IFS='|' read -r name prompt <<<"${row}"
    run_agent "${prompt}" true
    [[ "${status}" -eq 2 ]] || {
      echo "row: ${name} · status ${status}: ${output}"
      return 1
    }
  done
}

# Root-grammar negatives: a lookalike name is not a config root

@test "~/.claudex/ lookalike → NOT blocked (suffix must open with '-')" {
  run_agent 'Read ~/.claudex/settings.json for the third-party tool config.' true
  [[ "${status}" -eq 0 ]]
}

@test "~/.claude-/ empty suffix → NOT blocked (suffix must open with an alnum)" {
  run_agent 'Inspect ~/.claude-/settings.json leftovers.' true
  [[ "${status}" -eq 0 ]]
}

@test "dot-less claude-work/ → NOT blocked (leading-dot discipline)" {
  run_agent 'Open claude-work/settings.json in the repo checkout.' true
  [[ "${status}" -eq 0 ]]
}

@test "git checkout hooks path → NOT blocked" {
  run_agent 'Edit /Users/x/git/glass-atrium/hooks/enforce-foreground-harness.sh.' true
  [[ "${status}" -eq 0 ]]
}

# A case-insensitive filesystem (macOS APFS default) resolves a case variant to the live branch dir.
@test "a case-varied branch root blocks like the branch root itself" {
  run_agent 'Write ~/.Claude-Work/hooks/x.sh.' omit
  [[ "${status}" -eq 2 ]] || {
    echo "${output}"
    return 1
  }
}

# Block-message generalization (D4) — the Rule-2 pin in the base suite still holds alongside this

@test "block reason names the profile-branch generalization" {
  run_agent 'Write ~/.claude-work-dev/hooks/x.sh.' omit
  [[ "${status}" -eq 2 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *'Rule 2'* ]] && [[ "${output}" == *'profile branch'* ]]
}
